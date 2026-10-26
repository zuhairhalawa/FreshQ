import { formatAge } from "./duration.js";
import type { Discussion, SearchOptions, SearchResult } from "./types.js";

/**
 * Discussion titles are attacker-controlled. Strip control characters (including ANSI escape
 * sequences, which begin with ESC) and bidirectional overrides before writing to a terminal.
 */
export function sanitizeForTerminal(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "") // OSC sequences (e.g. hyperlinks, title changes)
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩​-‏]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

export function makeStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

export function describeFilters(opts: SearchOptions, sinceLabel: string): string {
  const parts: string[] = [];
  if (opts.answer === "unanswered") parts.push("unanswered Q&A");
  else if (opts.answer === "answerable") parts.push("answerable (Q&A-style)");
  if (opts.zeroComments) parts.push("zero-comment");
  const what = parts.length > 0 ? `${parts.join(", ")} discussions` : "discussions";
  const scope: string[] = [];
  if (opts.repos.length > 0) scope.push(`in ${opts.repos.join(", ")}`);
  if (opts.orgs.length > 0) scope.push(`in org ${opts.orgs.join(", ")}`);
  if (opts.terms.length > 0) scope.push(`matching ${opts.terms.map((t) => `"${t}"`).join(" + ")}${opts.inScope ? ` (${opts.inScope})` : ""}`);
  return `${what} created in the last ${sinceLabel}${scope.length > 0 ? " " + scope.join(" ") : ""}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function statusLabel(d: Discussion, s: Style): string {
  if (!d.isAnswerable) return s.dim("no accepted-answer feature");
  return d.isAnswered === true ? s.green("answered") : s.yellow("unanswered");
}

export function formatHuman(
  result: SearchResult,
  opts: SearchOptions,
  sinceLabel: string,
  nowMs: number,
  s: Style,
): string {
  const lines: string[] = [];
  lines.push(`${s.bold("FreshQ")} ${s.dim("·")} ${describeFilters(opts, sinceLabel)} ${s.dim("· newest first")}`);
  lines.push("");

  if (result.items.length === 0) {
    lines.push("No matching discussions found.");
    lines.push("");
    lines.push(s.dim("Notes:"));
    lines.push(s.dim("  - This is a real empty result; nothing was invented. Try a wider --since or fewer filters."));
    lines.push(s.dim("  - GitHub's search index can lag behind new posts, so the very newest ones may not appear yet."));
    if (opts.repos.length === 0 && opts.orgs.length === 0) {
      lines.push(s.dim("  - Only discussions in repositories you can access are searchable; private repos need a token with access."));
    }
  } else {
    const width = String(result.items.length).length;
    result.items.forEach((d, i) => {
      const num = String(i + 1).padStart(width, " ");
      const indent = " ".repeat(width + 2);
      const age = formatAge(Date.parse(d.createdAt), nowMs);
      lines.push(`${s.dim(num + ".")} ${s.bold(sanitizeForTerminal(d.title))}`);
      lines.push(
        `${indent}${s.cyan(sanitizeForTerminal(d.repository))} ${s.dim("#" + d.number)} ${s.dim("·")} ${sanitizeForTerminal(d.category)} ${s.dim("·")} ${statusLabel(d, s)} ${s.dim("·")} ${plural(d.comments, "comment", "comments")} ${s.dim("·")} ${age}`,
      );
      lines.push(`${indent}${s.dim(d.url)}`);
      lines.push("");
    });
    const reachedLimit = result.items.length >= opts.limit;
    lines.push(
      s.dim(
        `${plural(result.items.length, "discussion", "discussions")} shown${reachedLimit ? ` (limit ${opts.limit}; raise it with --limit)` : ""}.`,
      ),
    );
  }

  if (!result.complete) {
    lines.push("");
    lines.push(s.yellow(`Incomplete: only discussions created after ${result.coveredFrom} were fully searched.`));
  }
  return lines.join("\n") + "\n";
}

export interface JsonMeta {
  version: string;
  sinceLabel: string;
  nowMs: number;
}

export function formatJson(result: SearchResult, opts: SearchOptions, meta: JsonMeta): string {
  const out = {
    tool: "freshq",
    version: meta.version,
    generatedAt: new Date(meta.nowMs).toISOString(),
    query: {
      since: meta.sinceLabel,
      sinceAt: new Date(opts.sinceMs).toISOString(),
      answer: opts.answer,
      zeroComments: opts.zeroComments,
      repos: opts.repos,
      orgs: opts.orgs,
      search: opts.terms,
      in: opts.inScope ?? null,
      limit: opts.limit,
    },
    complete: result.complete,
    coveredFrom: result.coveredFrom,
    count: result.items.length,
    items: result.items.map((d) => ({
      ...d,
      ageSeconds: Math.max(0, Math.floor((meta.nowMs - Date.parse(d.createdAt)) / 1000)),
    })),
    warnings: result.warnings,
    requests: result.requests,
    rateLimit: result.rateLimit,
  };
  return JSON.stringify(out, null, 2) + "\n";
}
