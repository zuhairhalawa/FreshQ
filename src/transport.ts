import { execFile } from "node:child_process";
import { FreshQError, classifyFailure, redactSecrets } from "./errors.js";

export type Variables = Record<string, string | number | null>;

/** Executes one GraphQL request and returns the parsed `data` payload. */
export interface Transport {
  graphql(query: string, variables: Variables): Promise<unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a GraphQL response envelope. Throws a classified FreshQError for `errors`,
 * and a `malformed` error when there is no usable `data`.
 */
export function unwrapGraphql(body: unknown, status?: number, headers?: Record<string, string>): unknown {
  if (!isRecord(body)) {
    throw new FreshQError("malformed", "GitHub returned a response that is not a JSON object.");
  }
  const errors = body["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const messages: string[] = [];
    const types: string[] = [];
    for (const e of errors) {
      if (isRecord(e)) {
        if (typeof e["message"] === "string") messages.push(e["message"]);
        if (typeof e["type"] === "string") types.push(e["type"]);
      }
    }
    throw classifyFailure({ status, headers, message: messages.join("; "), graphqlTypes: types });
  }
  const data = body["data"];
  if (!isRecord(data)) {
    throw new FreshQError("malformed", "GitHub's response contained no `data` object.");
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// GitHub CLI transport (preferred: re-uses the user's existing `gh auth login`; FreshQ never sees the token)
// ---------------------------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
}
export interface ExecError extends Error {
  code?: string | number | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}
export type ExecFn = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

export const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // execFile (no shell): arguments are never interpreted by a shell, so user input cannot inject commands.
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as ExecError;
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });

export class GhNotFoundError extends Error {
  constructor() {
    super("GitHub CLI (`gh`) was not found on PATH.");
    this.name = "GhNotFoundError";
  }
}

export interface GhTransportOptions {
  timeoutMs?: number;
  /** Retries for transient 5xx failures (default 2). All requests are read-only, so retrying is safe. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createGhTransport(exec: ExecFn = defaultExec, options: GhTransportOptions = {}): Transport {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const once = async (query: string, variables: Variables): Promise<unknown> => {
    {
      const args = ["api", "graphql", "-f", `query=${query}`];
      for (const [name, value] of Object.entries(variables)) {
        if (value === null) continue;
        // -F sends a typed value (number); -f sends a raw string with no magic conversion.
        args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
      }

      let result: ExecResult;
      try {
        result = await exec("gh", args, timeoutMs);
      } catch (err) {
        const e = err as ExecError;
        if (e.code === "ENOENT") throw new GhNotFoundError();
        if (e.killed === true) {
          throw new FreshQError("network", `The \`gh\` command timed out after ${timeoutMs / 1000}s.`, "Check your network connection and retry.");
        }
        const stdout = e.stdout ?? "";
        const stderr = e.stderr ?? "";
        // gh exits non-zero on API errors but still prints the JSON body on stdout. Two real shapes exist:
        //   GraphQL-level:  {"errors":[{"type":"RATE_LIMITED","message":"..."}]}
        //   HTTP-level:     {"message":"Bad credentials","documentation_url":"...","status":"401"}
        let body: unknown;
        try {
          body = JSON.parse(stdout) as unknown;
        } catch {
          body = undefined;
        }
        if (isRecord(body) && Array.isArray(body["errors"]) && body["errors"].length > 0) {
          unwrapGraphql(body); // always throws a classified FreshQError here
        }
        const bodyMessage = isRecord(body) && typeof body["message"] === "string" ? body["message"] : "";
        const bodyStatus = isRecord(body) ? Number(body["status"]) : Number.NaN;
        const statusMatch = /HTTP (\d{3})/.exec(`${stderr}\n${stdout}`);
        const status = statusMatch?.[1] !== undefined ? Number(statusMatch[1]) : Number.isInteger(bodyStatus) ? bodyStatus : undefined;
        throw classifyFailure({
          status,
          message: [stderr.trim(), bodyMessage].filter((s) => s.length > 0).join(" | ") || stdout.trim() || e.message,
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new FreshQError("malformed", "`gh api graphql` produced output that is not valid JSON.");
      }
      return unwrapGraphql(parsed);
    }
  };

  return {
    async graphql(query, variables) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once(query, variables);
        } catch (err) {
          if (err instanceof FreshQError && err.retryable && attempt < retries) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw err;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Direct HTTPS transport (for environments without `gh`, e.g. CI): uses GH_TOKEN / GITHUB_TOKEN
// ---------------------------------------------------------------------------------------------

export interface FetchTransportOptions {
  token: string;
  endpoint?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export function createFetchTransport(opts: FetchTransportOptions): Transport {
  const endpoint = opts.endpoint ?? "https://api.github.com/graphql";
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    async graphql(query, variables) {
      const payload = JSON.stringify({ query, variables });
      let lastError: FreshQError | undefined;

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
        let response: Response;
        try {
          response = await doFetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${opts.token}`,
              "content-type": "application/json",
              "user-agent": opts.userAgent ?? "freshq",
              accept: "application/json",
            },
            body: payload,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          const reason = err instanceof Error ? err.name : "error";
          lastError = new FreshQError(
            "network",
            `Could not reach GitHub (${redactSecrets(reason)}).`,
            "Check your internet connection or proxy settings.",
          );
          continue;
        }

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        const text = await response.text();

        if (response.status >= 500) {
          lastError = classifyFailure({ status: response.status, headers, message: text.slice(0, 300) });
          continue; // retry transient server errors
        }
        if (!response.ok) {
          let message = text.slice(0, 500);
          try {
            const j = JSON.parse(text) as unknown;
            if (isRecord(j) && typeof j["message"] === "string") message = j["message"];
          } catch {
            // keep raw text
          }
          throw classifyFailure({ status: response.status, headers, message });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new FreshQError("malformed", "GitHub returned a response that is not valid JSON.");
        }
        return unwrapGraphql(parsed, response.status, headers);
      }
      throw lastError ?? new FreshQError("network", "Request to GitHub failed.");
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Default transport selection
// ---------------------------------------------------------------------------------------------

export interface DefaultTransportDeps {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

/**
 * Prefer the authenticated GitHub CLI. If `gh` is not installed, fall back to a token from
 * GH_TOKEN / GITHUB_TOKEN. With neither, fail with setup instructions.
 */
export function createDefaultTransport(deps: DefaultTransportDeps = {}): Transport {
  const env = deps.env ?? process.env;
  const gh = createGhTransport(deps.exec);
  const token = (env["GH_TOKEN"] || env["GITHUB_TOKEN"] || "").trim();
  let fallback: Transport | undefined;

  return {
    async graphql(query, variables) {
      if (fallback) return fallback.graphql(query, variables);
      try {
        return await gh.graphql(query, variables);
      } catch (err) {
        if (!(err instanceof GhNotFoundError)) throw err;
        if (token.length === 0) {
          throw new FreshQError(
            "no_credentials",
            "No GitHub credentials available: the GitHub CLI (`gh`) is not installed and GH_TOKEN / GITHUB_TOKEN is not set.",
            "Install https://cli.github.com/ and run `gh auth login`, or export GH_TOKEN with a token that can read public repositories.",
          );
        }
        fallback = createFetchTransport({
          token,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
        });
        return fallback.graphql(query, variables);
      }
    },
  };
}
