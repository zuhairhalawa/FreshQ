import { parseArgs } from "node:util";
import { parseDuration } from "./duration.js";
import { FreshQError } from "./errors.js";
import { MAX_SCOPES, quoteTerm, validateOrg, validateRepo } from "./query.js";
import type { AnswerFilter, InScope, SearchOptions } from "./types.js";

export const DEFAULT_SINCE = "24h";
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 1000;
export const DEFAULT_MAX_REQUESTS = 60;

export const HELP_TEXT = `freshq - find newly posted, unanswered GitHub Discussions (read-only)

USAGE
  freshq [options]

TIME WINDOW
  --since <dur>        Only discussions CREATED within this window. Examples: 30m, 1h, 2h, 24h, 7d
                       (units m, h, d, w; max 30d). Default: ${DEFAULT_SINCE}

FILTERS
  --unanswered         Q&A-style discussions with no accepted answer yet
  --answerable         Only categories that support accepted answers (answered or not)
  --zero-comments      Only discussions with no comments at all
  --repo <owner/name>  Limit to a repository (repeatable)
  --org <login>        Limit to an organization or user (repeatable)
  -s, --search <text>  Free-text term (repeatable, ANDed). Text with spaces is an exact phrase
  --in <where>         Restrict --search to: title, body or comments (default: GitHub's own matching)

OUTPUT
  --limit <n>          Maximum results, newest first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})
  --json               Machine-readable JSON on stdout
  --no-color           Disable colors (also honors NO_COLOR)
  --verbose            Print request and rate-limit details to stderr
  --max-requests <n>   Cap GraphQL requests per run (default ${DEFAULT_MAX_REQUESTS})
  -h, --help           Show this help
  -v, --version        Show version

EXAMPLES
  freshq --since 2h --unanswered --zero-comments
  freshq --since 24h --repo vercel/next.js
  freshq --since 1h --answerable --json
  freshq --since 7d --org microsoft --search "type error" --unanswered

EXIT CODES
  0 ok (including "no matches")   2 usage error      3 auth / permission
  4 rate limited                  5 network error    6 unexpected API response
  1 internal error

FreshQ only reads from GitHub. It authenticates through the GitHub CLI (gh auth login)
or GH_TOKEN / GITHUB_TOKEN, and never writes, comments, votes or stores credentials.
`;

export type ParsedCli =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "run";
      search: SearchOptions;
      sinceLabel: string;
      json: boolean;
      noColor: boolean;
      verbose: boolean;
    };

function positiveInt(name: string, raw: string, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new FreshQError("usage", `${name} must be a whole number (got "${raw}").`);
  }
  const n = Number(raw);
  if (n < 1 || n > max) {
    throw new FreshQError("usage", `${name} must be between 1 and ${max} (got ${n}).`);
  }
  return n;
}

export function parseCli(argv: readonly string[], nowMs: number = Date.now()): ParsedCli {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        since: { type: "string" },
        unanswered: { type: "boolean" },
        answerable: { type: "boolean" },
        "zero-comments": { type: "boolean" },
        repo: { type: "string", multiple: true },
        org: { type: "string", multiple: true },
        search: { type: "string", short: "s", multiple: true },
        in: { type: "string" },
        limit: { type: "string" },
        "max-requests": { type: "string" },
        json: { type: "boolean" },
        "no-color": { type: "boolean" },
        verbose: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] ?? "invalid arguments" : "invalid arguments";
    throw new FreshQError("usage", message, "Run `freshq --help` for usage.");
  }

  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  const sinceLabel = values.since ?? DEFAULT_SINCE;
  const sinceDuration = parseDuration(sinceLabel);

  const repos = (values.repo ?? []).map(validateRepo);
  const orgs = (values.org ?? []).map(validateOrg);
  if (repos.length + orgs.length > MAX_SCOPES) {
    throw new FreshQError("usage", `Too many --repo/--org values (maximum ${MAX_SCOPES} combined).`);
  }
  const terms = (values.search ?? []).map((t) => {
    quoteTerm(t); // validates; the stored term stays raw and is quoted when the query is built
    return t.trim();
  });

  let inScope: InScope | undefined;
  if (values.in !== undefined) {
    if (values.in !== "title" && values.in !== "body" && values.in !== "comments") {
      throw new FreshQError("usage", `--in must be one of: title, body, comments (got "${values.in}").`);
    }
    if (terms.length === 0) throw new FreshQError("usage", "--in only makes sense together with --search.");
    inScope = values.in;
  }

  let answer: AnswerFilter = "any";
  if (values.answerable) answer = "answerable";
  if (values.unanswered) answer = "unanswered";

  return {
    kind: "run",
    sinceLabel,
    json: values.json === true,
    noColor: values["no-color"] === true,
    verbose: values.verbose === true,
    search: {
      sinceMs: nowMs - sinceDuration,
      limit: values.limit !== undefined ? positiveInt("--limit", values.limit, MAX_LIMIT) : DEFAULT_LIMIT,
      answer,
      zeroComments: values["zero-comments"] === true,
      repos,
      orgs,
      terms,
      inScope,
      maxRequests:
        values["max-requests"] !== undefined
          ? positiveInt("--max-requests", values["max-requests"], 1000)
          : DEFAULT_MAX_REQUESTS,
    },
  };
}
