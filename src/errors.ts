/** Process exit codes. Documented in the README. */
export const ExitCode = {
  Ok: 0,
  Internal: 1,
  Usage: 2,
  Auth: 3,
  RateLimit: 4,
  Network: 5,
  BadResponse: 6,
} as const;

export type ErrorKind =
  | "usage"
  | "auth"
  | "permission"
  | "rate_limit"
  | "network"
  | "api"
  | "malformed"
  | "no_credentials";

const KIND_EXIT: Record<ErrorKind, number> = {
  usage: ExitCode.Usage,
  auth: ExitCode.Auth,
  permission: ExitCode.Auth,
  no_credentials: ExitCode.Auth,
  rate_limit: ExitCode.RateLimit,
  network: ExitCode.Network,
  api: ExitCode.BadResponse,
  malformed: ExitCode.BadResponse,
};

export class FreshQError extends Error {
  readonly kind: ErrorKind;
  /** Optional user-facing advice on how to fix the problem. */
  readonly hint: string | undefined;
  /** True for transient server-side failures that are safe to retry (read-only requests). */
  readonly retryable: boolean;

  constructor(kind: ErrorKind, message: string, hint?: string, retryable = false) {
    super(message);
    this.name = "FreshQError";
    this.kind = kind;
    this.hint = hint;
    this.retryable = retryable;
  }

  get exitCode(): number {
    return KIND_EXIT[this.kind];
  }
}

/** Remove anything that looks like a GitHub token from text before it is shown or logged. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization:\s*(?:bearer|token)\s+)\S+/gi, "$1[REDACTED]");
}

export interface FailureInfo {
  /** HTTP status when known. */
  status?: number | undefined;
  /** Raw message text (from GraphQL errors, stderr or response body). */
  message: string;
  /** Lower-cased response headers when available. */
  headers?: Record<string, string> | undefined;
  /** GraphQL error `type` fields, when available. */
  graphqlTypes?: readonly string[] | undefined;
  /** Epoch ms at which `now` is considered, used for reset-time formatting. */
  now?: number | undefined;
}

function formatReset(headers: Record<string, string> | undefined, now: number): string {
  const reset = headers?.["x-ratelimit-reset"];
  if (reset !== undefined && /^\d+$/.test(reset)) {
    const at = new Date(Number(reset) * 1000);
    const mins = Math.max(1, Math.ceil((at.getTime() - now) / 60_000));
    return ` The limit resets at ${at.toISOString()} (in about ${mins} min).`;
  }
  const retry = headers?.["retry-after"];
  if (retry !== undefined && /^\d+$/.test(retry)) {
    return ` GitHub asks you to retry after ${retry} seconds.`;
  }
  return "";
}

/**
 * Map a transport-level failure onto a FreshQError with an actionable message.
 * Shared by the `gh` and `fetch` transports so both behave identically.
 */
export function classifyFailure(info: FailureInfo): FreshQError {
  const msg = redactSecrets(info.message.trim());
  const lower = msg.toLowerCase();
  const now = info.now ?? Date.now();
  const types = info.graphqlTypes ?? [];
  const remaining = info.headers?.["x-ratelimit-remaining"];

  const isRateLimit =
    types.includes("RATE_LIMITED") ||
    info.status === 429 ||
    lower.includes("rate limit") ||
    lower.includes("abuse detection") ||
    (info.status === 403 && remaining === "0") ||
    (info.status === 403 && info.headers?.["retry-after"] !== undefined);
  if (isRateLimit) {
    return new FreshQError(
      "rate_limit",
      `GitHub API rate limit reached.${formatReset(info.headers, now)}`,
      "Wait a few minutes and retry, narrow the search (--repo, --since, --limit), or use a token with a higher limit.",
    );
  }

  if (
    info.status === 401 ||
    lower.includes("bad credentials") ||
    lower.includes("requires authentication") ||
    lower.includes("gh auth login") ||
    lower.includes("not logged in") ||
    lower.includes("gh_token environment variable") ||
    lower.includes("authentication token") ||
    lower.includes("token has expired")
  ) {
    return new FreshQError(
      "auth",
      "GitHub rejected the credentials (authentication failed).",
      "Run `gh auth login` (or `gh auth status` to inspect), or set a valid GH_TOKEN / GITHUB_TOKEN.",
    );
  }

  if (
    info.status === 403 ||
    types.includes("FORBIDDEN") ||
    lower.includes("resource not accessible") ||
    lower.includes("saml") ||
    lower.includes("forbidden")
  ) {
    const saml = lower.includes("saml");
    return new FreshQError(
      "permission",
      saml
        ? "Access was blocked by an organization's SAML single sign-on requirement."
        : "GitHub denied access to this resource (insufficient permissions).",
      saml
        ? "Authorize your token for the organization: https://github.com/settings/tokens (Configure SSO)."
        : "Make sure the token can read the repositories you searched. Public discussions need no special scope; private ones need `repo`.",
    );
  }

  if (info.status !== undefined && info.status >= 500) {
    return new FreshQError(
      "network",
      `GitHub is temporarily unavailable (HTTP ${info.status}).`,
      "Retry in a minute. Check https://www.githubstatus.com/ if it persists.",
      true,
    );
  }

  return new FreshQError("api", `GitHub API error: ${msg.length > 0 ? msg : "unknown error"}`);
}
