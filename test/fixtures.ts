import type { Transport, Variables } from "../src/transport.js";
import type { Discussion, SearchOptions } from "../src/types.js";

/** Fixed "now" used across tests: 2026-10-27T12:00:00Z */
export const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
export const HOUR = 3_600_000;
export const MIN = 60_000;

export function makeDiscussion(n: number, over: Partial<Discussion> = {}): Discussion {
  const createdAt = over.createdAt ?? new Date(NOW - n * MIN).toISOString();
  return {
    id: `D_${n}`,
    number: n,
    title: `Question ${n}`,
    url: `https://github.com/acme/widgets/discussions/${n}`,
    repository: "acme/widgets",
    isPrivate: false,
    author: "alice",
    createdAt,
    updatedAt: createdAt,
    comments: 0,
    category: "Q&A",
    isAnswerable: true,
    isAnswered: false,
    answerChosenAt: null,
    ...over,
  };
}

export function toNode(d: Discussion): Record<string, unknown> {
  return {
    id: d.id,
    number: d.number,
    title: d.title,
    url: d.url,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    isAnswered: d.isAnswered,
    answerChosenAt: d.answerChosenAt,
    comments: { totalCount: d.comments },
    category: { name: d.category, isAnswerable: d.isAnswerable },
    repository: { nameWithOwner: d.repository, isPrivate: d.isPrivate },
    author: d.author === null ? null : { login: d.author },
  };
}

export function baseOptions(over: Partial<SearchOptions> = {}): SearchOptions {
  return {
    sinceMs: NOW - 24 * HOUR,
    limit: 30,
    answer: "any",
    zeroComments: false,
    repos: [],
    orgs: [],
    terms: [],
    maxRequests: 200,
    ...over,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * An in-memory stand-in for GitHub's discussion search that reproduces the behaviours measured
 * against the live API: `sort:` is ignored (arbitrary order), at most 1000 results are
 * reachable, and `discussionCount` reports the uncapped total.
 */
export class FakeGitHub implements Transport {
  readonly calls: Array<{ q: string; after: string | null }> = [];

  constructor(readonly data: readonly Discussion[]) {}

  matching(q: string): Discussion[] {
    const created = /created:(\S+?)\.\.(\S+)/.exec(q);
    const from = created ? Date.parse(created[1] as string) : -Infinity;
    const to = created ? Date.parse(created[2] as string) : Infinity;
    const repos = [...q.matchAll(/\brepo:(\S+)/g)].map((m) => m[1]);
    const orgs = [...q.matchAll(/\borg:(\S+)/g)].map((m) => m[1]);
    const answered = /\bis:answered\b/.test(q);
    const unanswered = /\bis:unanswered\b/.test(q);
    const zero = /\bcomments:0\b/.test(q);
    const rest = q
      .replace(/created:\S+/g, "")
      .replace(/\b(is:answered|is:unanswered|comments:0|in:\w+)\b/g, "")
      .replace(/\b(repo|org):\S+/g, "");
    const terms = [...rest.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? "").toLowerCase());

    return this.data.filter((d) => {
      const t = Date.parse(d.createdAt);
      if (t < from || t > to) return false;
      if (answered && !(d.isAnswerable && d.isAnswered === true)) return false;
      if (unanswered && !(d.isAnswerable && d.isAnswered === false)) return false;
      if (zero && d.comments !== 0) return false;
      if (repos.length + orgs.length > 0) {
        const ok = repos.includes(d.repository) || orgs.includes(d.repository.split("/")[0]);
        if (!ok) return false;
      }
      return terms.every((term) => term === "" || d.title.toLowerCase().includes(term));
    });
  }

  async graphql(_query: string, variables: Variables): Promise<unknown> {
    const q = String(variables["q"]);
    const after = variables["after"] === undefined || variables["after"] === null ? null : String(variables["after"]);
    this.calls.push({ q, after });

    const all = this.matching(q).sort((a, b) => hash(a.id) - hash(b.id)); // deliberately NOT by date
    const reachable = all.slice(0, 1000);
    const offset = after === null ? 0 : Number(Buffer.from(after, "base64").toString("utf8"));
    const first = Number(variables["first"] ?? 100);
    const slice = reachable.slice(offset, offset + first);
    const next = offset + slice.length;
    const hasNextPage = next < reachable.length;
    return {
      rateLimit: { cost: 1, remaining: 4000, limit: 5000, resetAt: "2026-10-27T13:00:00Z" },
      search: {
        discussionCount: all.length,
        pageInfo: { hasNextPage, endCursor: slice.length > 0 ? Buffer.from(String(next)).toString("base64") : null },
        nodes: slice.map(toNode),
      },
    };
  }
}

/** A transport that returns canned responses in order, for malformed/error-path tests. */
export function scripted(...responses: Array<unknown | Error>): Transport & { calls: number } {
  let i = 0;
  const t = {
    calls: 0,
    async graphql(): Promise<unknown> {
      t.calls++;
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return t;
}

export function page(nodes: unknown[], over: Record<string, unknown> = {}): unknown {
  return {
    search: {
      discussionCount: nodes.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes,
      ...over,
    },
  };
}
