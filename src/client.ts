import { FreshQError } from "./errors.js";
import { answerVariants, buildSearchQuery } from "./query.js";
import type { Transport } from "./transport.js";
import type { Discussion, RateLimitInfo, SearchOptions, SearchResult } from "./types.js";

/** GitHub search never returns more than this many results for one query (10 pages x 100). */
export const SEARCH_RESULT_CAP = 1000;
export const PAGE_SIZE = 100;
const MAX_PAGES_PER_SLICE = SEARCH_RESULT_CAP / PAGE_SIZE;
/** Pad the upper bound of the first slice to tolerate local clock skew. */
const CLOCK_SKEW_PAD_MS = 60_000;
const INITIAL_SPAN_MS = 2 * 3_600_000;

export const SEARCH_QUERY = `query FreshQSearch($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining limit resetAt }
  search(query: $q, type: DISCUSSION, first: $first, after: $after) {
    discussionCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Discussion {
        id number title url createdAt updatedAt isAnswered answerChosenAt
        comments { totalCount }
        category { name isAnswerable }
        repository { nameWithOwner isPrivate }
        author { login }
      }
    }
  }
}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function malformed(detail: string): FreshQError {
  return new FreshQError("malformed", `Unexpected response shape from GitHub: ${detail}.`, "This may be a GitHub API change; please report it at https://github.com/zuhairhalawa/FreshQ/issues.");
}

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw malformed(`${where}.${key} is missing or not a string`);
  return v;
}

function rec(obj: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const v = obj[key];
  if (!isRecord(v)) throw malformed(`${where}.${key} is missing or not an object`);
  return v;
}

/**
 * Convert one element of `search.nodes` into a Discussion.
 * Returns null for empty/non-Discussion nodes (the API yields `{}` or null for those); throws for
 * nodes that claim to be discussions but are structurally invalid - we never guess missing data.
 */
export function parseDiscussionNode(raw: unknown): Discussion | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw malformed("a search node is not an object");
  if (Object.keys(raw).length === 0) return null;

  const createdAt = str(raw, "createdAt", "node");
  if (Number.isNaN(Date.parse(createdAt))) throw malformed("node.createdAt is not a valid date");
  const comments = rec(raw, "comments", "node")["totalCount"];
  if (typeof comments !== "number" || !Number.isInteger(comments) || comments < 0) {
    throw malformed("node.comments.totalCount is not a non-negative integer");
  }
  const category = rec(raw, "category", "node");
  const repository = rec(raw, "repository", "node");
  const number = raw["number"];
  if (typeof number !== "number" || !Number.isInteger(number)) throw malformed("node.number is not an integer");

  const isAnswerable = category["isAnswerable"];
  if (typeof isAnswerable !== "boolean") throw malformed("node.category.isAnswerable is not a boolean");
  const isAnswered = raw["isAnswered"];
  if (isAnswered !== null && isAnswered !== undefined && typeof isAnswered !== "boolean") {
    throw malformed("node.isAnswered is not a boolean or null");
  }
  const author = raw["author"];
  const answerChosenAt = raw["answerChosenAt"];

  return {
    id: str(raw, "id", "node"),
    number,
    title: str(raw, "title", "node"),
    url: str(raw, "url", "node"),
    repository: str(repository, "nameWithOwner", "node.repository"),
    isPrivate: repository["isPrivate"] === true,
    author: isRecord(author) && typeof author["login"] === "string" ? author["login"] : null,
    createdAt,
    updatedAt: typeof raw["updatedAt"] === "string" ? raw["updatedAt"] : createdAt,
    comments,
    category: str(category, "name", "node.category"),
    isAnswerable,
    isAnswered: typeof isAnswered === "boolean" ? isAnswered : null,
    answerChosenAt: typeof answerChosenAt === "string" ? answerChosenAt : null,
  };
}

interface Page {
  count: number;
  hasNext: boolean;
  cursor: string | null;
  items: Discussion[];
  rate: RateLimitInfo | null;
}

function parseRate(raw: unknown): RateLimitInfo | null {
  if (!isRecord(raw)) return null;
  const { cost, remaining, limit, resetAt } = raw;
  if (typeof cost === "number" && typeof remaining === "number" && typeof limit === "number" && typeof resetAt === "string") {
    return { cost, remaining, limit, resetAt };
  }
  return null;
}

export function parsePage(data: unknown): Page {
  if (!isRecord(data)) throw malformed("data is not an object");
  const search = rec(data, "search", "data");
  const count = search["discussionCount"];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw malformed("search.discussionCount is not a non-negative integer");
  const pageInfo = rec(search, "pageInfo", "search");
  const hasNext = pageInfo["hasNextPage"];
  if (typeof hasNext !== "boolean") throw malformed("search.pageInfo.hasNextPage is not a boolean");
  const cursor = pageInfo["endCursor"];
  if (cursor !== null && typeof cursor !== "string") throw malformed("search.pageInfo.endCursor is not a string or null");
  if (hasNext && cursor === null) throw malformed("hasNextPage is true but endCursor is null");
  const nodes = search["nodes"];
  if (!Array.isArray(nodes)) throw malformed("search.nodes is not an array");
  const items: Discussion[] = [];
  for (const n of nodes) {
    const d = parseDiscussionNode(n);
    if (d) items.push(d);
  }
  return { count, hasNext, cursor: cursor ?? null, items, rate: parseRate(data["rateLimit"]) };
}

/** Client-side re-check of every filter, so a stale or lenient search index can never leak wrong rows. */
export function matchesFilters(d: Discussion, opts: SearchOptions, sinceMs: number): boolean {
  if (Date.parse(d.createdAt) < sinceMs) return false; // created, never "updated"
  if (opts.zeroComments && d.comments !== 0) return false;
  if (opts.answer !== "any" && !d.isAnswerable) return false;
  if (opts.answer === "unanswered" && d.isAnswered !== false) return false;
  return true;
}

/** Newest first; ties broken by id so output is deterministic. */
export function compareNewestFirst(a: Discussion, b: Discussion): number {
  const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

class BudgetExhausted extends Error {}

interface VariantOutcome {
  items: Discussion[];
  complete: boolean;
  coveredFromMs: number;
}

class Searcher {
  requests = 0;
  rateLimit: RateLimitInfo | null = null;
  readonly warnings: string[] = [];

  constructor(
    private readonly transport: Transport,
    private readonly opts: SearchOptions,
    private readonly nowMs: number,
  ) {}

  private async fetchPage(q: string, after: string | null): Promise<Page> {
    if (this.requests >= this.opts.maxRequests) throw new BudgetExhausted();
    this.requests++;
    const data = await this.transport.graphql(SEARCH_QUERY, { q, first: PAGE_SIZE, after });
    const page = parsePage(data);
    if (page.rate) this.rateLimit = page.rate;
    return page;
  }

  /**
   * Search one answer-variant from the newest end of the window backwards.
   *
   * Why slice by time instead of just paginating: GitHub's discussion search ignores `sort:` and
   * stops after 1000 results, so a plain query over a busy window returns an arbitrary 1000 rows
   * that are NOT the newest. Slicing `created:A..B` into windows that each hold <= 1000 matches
   * and walking from newest to oldest makes every slice complete, so the top results are exact.
   */
  async searchVariant(variant: "is:answered" | "is:unanswered" | null): Promise<VariantOutcome> {
    const { opts, nowMs } = this;
    const sinceSec = Math.floor(opts.sinceMs / 1000) * 1000;
    let hi = Math.floor((nowMs + CLOCK_SKEW_PAD_MS) / 1000) * 1000;
    const windowMs = hi - sinceSec;
    let span = Math.min(windowMs, INITIAL_SPAN_MS);
    const collected: Discussion[] = [];
    const seen = new Set<string>();
    let coveredFrom = hi;
    let matched = 0;

    while (hi >= sinceSec && matched < opts.limit) {
      const lo = Math.max(sinceSec, hi - span);
      const q = buildSearchQuery({
        fromMs: lo,
        toMs: hi,
        variant,
        zeroComments: opts.zeroComments,
        repos: opts.repos,
        orgs: opts.orgs,
        terms: opts.terms,
        inScope: opts.inScope,
      });

      try {
        const page = await this.fetchPage(q, null);

        if (page.count > SEARCH_RESULT_CAP) {
          if (hi - lo >= 1000) {
            span = Math.floor((hi - lo) / 2000) * 1000; // halve (second precision) and retry this end
            continue;
          }
          // A single second holding > 1000 matches: cannot be sliced further.
          this.warnings.push(
            `More than ${SEARCH_RESULT_CAP} discussions were created within one second (${q}); only the first ${SEARCH_RESULT_CAP} could be read.`,
          );
          const items = await this.drain(q, page);
          for (const d of items) this.take(d, collected, seen);
          return { items: collected, complete: false, coveredFromMs: hi };
        }

        const sliceItems = await this.drain(q, page);
        for (const d of sliceItems) {
          if (this.take(d, collected, seen)) matched++;
        }
        coveredFrom = lo;
        // Adapt slice width to how dense this period is, to keep request counts low.
        if (page.count < PAGE_SIZE) span = Math.min(span * 4 + 1000, windowMs);
        else if (page.count > 5 * PAGE_SIZE) span = Math.floor(span / 2000) * 1000;
        hi = lo - 1000;
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          this.warnings.push(
            `Stopped after ${opts.maxRequests} API requests (--max-requests); older matches were not searched.`,
          );
          return { items: collected, complete: false, coveredFromMs: coveredFrom };
        }
        throw err;
      }
    }

    // Either the whole window was searched, or `limit` matches were found from the newest end.
    return { items: collected, complete: true, coveredFromMs: sinceSec };
  }

  /** Read the remaining pages of a slice whose first page is already loaded. */
  private async drain(q: string, first: Page): Promise<Discussion[]> {
    const all = [...first.items];
    let page = first;
    let pages = 1;
    while (page.hasNext && pages < MAX_PAGES_PER_SLICE) {
      page = await this.fetchPage(q, page.cursor);
      all.push(...page.items);
      pages++;
    }
    return all;
  }

  private take(d: Discussion, into: Discussion[], seen: Set<string>): boolean {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    if (!matchesFilters(d, this.opts, this.opts.sinceMs)) return false;
    into.push(d);
    return true;
  }
}

/**
 * Find discussions created within the window, newest first.
 * Read-only: only issues GraphQL `query` operations.
 */
export async function searchDiscussions(
  transport: Transport,
  opts: SearchOptions,
  nowMs: number = Date.now(),
): Promise<SearchResult> {
  if (opts.limit < 1) throw new FreshQError("usage", "--limit must be at least 1.");
  const searcher = new Searcher(transport, opts, nowMs);
  const outcomes: VariantOutcome[] = [];
  for (const variant of answerVariants(opts.answer)) {
    outcomes.push(await searcher.searchVariant(variant));
  }

  const incomplete = outcomes.filter((o) => !o.complete);
  // Results are only guaranteed to be the true newest matches down to the shallowest incomplete coverage.
  const cutoff = incomplete.length > 0 ? Math.max(...incomplete.map((o) => o.coveredFromMs)) : opts.sinceMs;
  const merged = new Map<string, Discussion>();
  for (const o of outcomes) {
    for (const d of o.items) {
      if (Date.parse(d.createdAt) >= cutoff) merged.set(d.id, d);
    }
  }
  const items = [...merged.values()].sort(compareNewestFirst).slice(0, opts.limit);

  return {
    items,
    complete: incomplete.length === 0,
    coveredFrom: new Date(incomplete.length === 0 ? opts.sinceMs : cutoff).toISOString(),
    requests: searcher.requests,
    rateLimit: searcher.rateLimit,
    warnings: searcher.warnings,
  };
}
