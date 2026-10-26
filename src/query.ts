import { FreshQError } from "./errors.js";
import type { AnswerFilter, InScope } from "./types.js";

/*
 * Search-qualifier facts, verified against the live GitHub GraphQL API
 * (`search(type: DISCUSSION)`), not assumed:
 *   - created:A..B / created:>=A   work (ISO-8601, second precision)
 *   - comments:0                   works
 *   - is:answered / is:unanswered  work, and ONLY match categories that support answers
 *   - repo:, org:                  work; several of each are OR-ed together
 *   - in:title | in:body | in:comments  work
 *   - answered:, category:, is:answerable are silently ignored or match nothing -> never used
 *   - sort: is ignored for discussions -> ordering is done client-side
 */

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const MAX_SCOPES = 30;

export function validateRepo(value: string): string {
  const v = value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
  if (!REPO_RE.test(v)) {
    throw new FreshQError("usage", `Invalid --repo "${value}".`, "Use the form owner/name, e.g. vercel/next.js.");
  }
  return v;
}

export function validateOrg(value: string): string {
  const v = value.trim().replace(/^@/, "");
  if (!ORG_RE.test(v)) {
    throw new FreshQError("usage", `Invalid --org "${value}".`, "Use an organization or user login, e.g. microsoft.");
  }
  return v;
}

/** Quote a free-text term so it can never be interpreted as a qualifier or operator. */
export function quoteTerm(term: string): string {
  const cleaned = term.replace(/["\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) {
    throw new FreshQError("usage", "Empty --search term.");
  }
  if (cleaned.length > 100) {
    throw new FreshQError("usage", "A --search term may be at most 100 characters.");
  }
  const needsQuotes = /[\s:()\-]/.test(cleaned) || /^(AND|OR|NOT)$/.test(cleaned);
  return needsQuotes ? `"${cleaned}"` : cleaned;
}

/** GitHub search timestamps: second precision, UTC, no milliseconds. */
export function formatSearchTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The accepted-answer qualifier variants that must be searched and merged for a filter.
 * `null` means "no answer qualifier".
 * There is no single qualifier for "category supports answers", so --answerable is the union of
 * is:answered and is:unanswered, which are disjoint.
 */
export function answerVariants(answer: AnswerFilter): Array<"is:answered" | "is:unanswered" | null> {
  switch (answer) {
    case "any":
      return [null];
    case "unanswered":
      return ["is:unanswered"];
    case "answerable":
      return ["is:unanswered", "is:answered"];
  }
}

export interface QueryParts {
  fromMs: number;
  toMs: number;
  variant: "is:answered" | "is:unanswered" | null;
  zeroComments: boolean;
  repos: readonly string[];
  orgs: readonly string[];
  terms: readonly string[];
  inScope?: InScope | undefined;
}

export function buildSearchQuery(parts: QueryParts): string {
  if (parts.repos.length + parts.orgs.length > MAX_SCOPES) {
    throw new FreshQError("usage", `Too many --repo/--org values (maximum ${MAX_SCOPES} combined).`);
  }
  const q: string[] = [`created:${formatSearchTime(parts.fromMs)}..${formatSearchTime(parts.toMs)}`];
  if (parts.variant !== null) q.push(parts.variant);
  if (parts.zeroComments) q.push("comments:0");
  for (const r of parts.repos) q.push(`repo:${validateRepo(r)}`);
  for (const o of parts.orgs) q.push(`org:${validateOrg(o)}`);
  for (const t of parts.terms) q.push(quoteTerm(t));
  if (parts.inScope !== undefined && parts.terms.length > 0) q.push(`in:${parts.inScope}`);
  return q.join(" ");
}
