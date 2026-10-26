import { test } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_QUERY, parseDiscussionNode, parsePage, searchDiscussions } from "../src/client.js";
import { FreshQError } from "../src/errors.js";
import { FakeGitHub, HOUR, MIN, NOW, baseOptions, makeDiscussion, page, scripted, toNode } from "./fixtures.js";

/** Independent oracle ordering: newest first; discussions created in the same second ordered by id. */
const byNewest = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** GitHub reports createdAt at whole-second precision (verified on live data); fixtures must too. */
const wholeSecond = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString();

/** ~3500 discussions over 24h with mixed states, one burst of 1500 within 10 minutes. */
function bigDataset() {
  const data = [];
  let n = 1;
  for (let i = 0; i < 2000; i++) {
    const created = wholeSecond(NOW - 5 * MIN - Math.floor((i / 2000) * 23 * HOUR));
    data.push(
      makeDiscussion(n++, {
        createdAt: created,
        comments: i % 3 === 0 ? 0 : 2,
        isAnswerable: i % 4 !== 0,
        isAnswered: i % 4 === 0 ? null : i % 5 === 0,
        category: i % 4 === 0 ? "Ideas" : "Q&A",
      }),
    );
  }
  for (let i = 0; i < 1500; i++) {
    // burst: 1500 posts inside 10 minutes, 3 hours ago
    const created = wholeSecond(NOW - 3 * HOUR - Math.floor((i / 1500) * 10 * MIN));
    data.push(makeDiscussion(n++, { createdAt: created }));
  }
  return data;
}

test("returns discussions newest first even though the API order is arbitrary", async () => {
  const data = Array.from({ length: 40 }, (_, i) => makeDiscussion(i + 1));
  const result = await searchDiscussions(new FakeGitHub(data), baseOptions({ limit: 10 }), NOW);
  assert.equal(result.items.length, 10);
  const expected = [...data].sort(byNewest).slice(0, 10).map((d) => d.id);
  assert.deepEqual(result.items.map((d) => d.id), expected);
  assert.equal(result.complete, true);
});

test("matches a brute-force oracle across a >1000-result window and a 1500-post burst", async () => {
  const data = bigDataset();
  const gh = new FakeGitHub(data);
  for (const limit of [25, 400, 3600]) {
    const opts = baseOptions({ limit, zeroComments: true });
    const result = await searchDiscussions(gh, opts, NOW);
    const oracle = data.filter((d) => d.comments === 0 && Date.parse(d.createdAt) >= opts.sinceMs).sort(byNewest);
    assert.deepEqual(
      result.items.map((d) => d.id),
      oracle.slice(0, limit).map((d) => d.id),
      `limit ${limit}`,
    );
    assert.equal(result.complete, true);
  }
});

test("never requests more than 1000 results from one slice and stays within the request budget", async () => {
  const data = bigDataset();
  const gh = new FakeGitHub(data);
  const result = await searchDiscussions(gh, baseOptions({ limit: 3600 }), NOW);
  assert.equal(result.items.length, data.length);
  for (const c of gh.calls) {
    assert.ok(gh.matching(c.q).length <= 1000 || c.after === null, "slices > 1000 may only be probed on page 1");
  }
  assert.equal(result.requests, gh.calls.length);
});

test("stops early once enough newest results are collected (small limit = few requests)", async () => {
  const data = bigDataset();
  const gh = new FakeGitHub(data);
  const result = await searchDiscussions(gh, baseOptions({ limit: 5 }), NOW);
  assert.equal(result.items.length, 5);
  assert.ok(gh.calls.length <= 3, `expected <= 3 requests, got ${gh.calls.length}`);
});

test("--unanswered only returns answerable, not-yet-answered discussions", async () => {
  const data = [
    makeDiscussion(1, { isAnswered: false }),
    makeDiscussion(2, { isAnswered: true, answerChosenAt: new Date(NOW).toISOString() }),
    makeDiscussion(3, { isAnswerable: false, isAnswered: null, category: "Ideas" }),
    makeDiscussion(4, { isAnswered: false }),
  ];
  const result = await searchDiscussions(new FakeGitHub(data), baseOptions({ answer: "unanswered" }), NOW);
  assert.deepEqual(result.items.map((d) => d.number).sort(), [1, 4]);
});

test("--answerable merges answered and unanswered Q&A, excludes non-answerable categories, newest first", async () => {
  const data = [
    makeDiscussion(1, { isAnswered: false }),
    makeDiscussion(2, { isAnswered: true }),
    makeDiscussion(3, { isAnswerable: false, isAnswered: null, category: "General" }),
    makeDiscussion(4, { isAnswered: false }),
    makeDiscussion(5, { isAnswered: true }),
  ];
  const gh = new FakeGitHub(data);
  const result = await searchDiscussions(gh, baseOptions({ answer: "answerable" }), NOW);
  assert.deepEqual(result.items.map((d) => d.number), [1, 2, 4, 5]); // newest = lowest minutes-ago
  assert.ok(gh.calls.some((c) => c.q.includes("is:answered")));
  assert.ok(gh.calls.some((c) => c.q.includes("is:unanswered")));
  assert.ok(!gh.calls.some((c) => c.q.includes("is:answerable")), "is:answerable is silently ignored by GitHub");
});

test("--zero-comments excludes discussions with replies", async () => {
  const data = [makeDiscussion(1, { comments: 0 }), makeDiscussion(2, { comments: 3 }), makeDiscussion(3, { comments: 0, isAnswerable: false, isAnswered: null })];
  const result = await searchDiscussions(new FakeGitHub(data), baseOptions({ zeroComments: true }), NOW);
  assert.deepEqual(result.items.map((d) => d.number).sort(), [1, 3]);
});

test("filters by repo, org and search terms", async () => {
  const data = [
    makeDiscussion(1, { repository: "a/one", title: "Docker compose fails" }),
    makeDiscussion(2, { repository: "a/two", title: "Docker build slow" }),
    makeDiscussion(3, { repository: "b/three", title: "Docker in b" }),
  ];
  const gh = new FakeGitHub(data);
  assert.deepEqual((await searchDiscussions(gh, baseOptions({ repos: ["a/two"] }), NOW)).items.map((d) => d.number), [2]);
  assert.deepEqual((await searchDiscussions(gh, baseOptions({ orgs: ["b"] }), NOW)).items.map((d) => d.number), [3]);
  assert.deepEqual((await searchDiscussions(gh, baseOptions({ terms: ["docker compose"] }), NOW)).items.map((d) => d.number), [1]);
});

test("empty results are reported honestly: no items, complete, no invented data", async () => {
  const result = await searchDiscussions(new FakeGitHub([]), baseOptions(), NOW);
  assert.deepEqual(result.items, []);
  assert.equal(result.complete, true);
  assert.deepEqual(result.warnings, []);
});

test("old discussions that merely leaked into results (e.g. recently updated) are dropped", async () => {
  const stale = makeDiscussion(99, { createdAt: new Date(NOW - 10 * 24 * HOUR).toISOString(), updatedAt: new Date(NOW - MIN).toISOString() });
  const fresh = makeDiscussion(1);
  const result = await searchDiscussions(scripted(page([toNode(stale), toNode(fresh)])), baseOptions(), NOW);
  assert.deepEqual(result.items.map((d) => d.number), [1]);
});

test("the client re-checks filters so a lenient index cannot return wrong rows", async () => {
  const leaked = makeDiscussion(7, { comments: 4 });
  const ok = makeDiscussion(8, { comments: 0 });
  const result = await searchDiscussions(scripted(page([toNode(leaked), toNode(ok)])), baseOptions({ zeroComments: true }), NOW);
  assert.deepEqual(result.items.map((d) => d.number), [8]);
});

test("following pages: collects every page of a slice via cursors", async () => {
  const data = Array.from({ length: 250 }, (_, i) => makeDiscussion(i + 1, { createdAt: new Date(NOW - 10 * MIN - i * 1000).toISOString() }));
  const gh = new FakeGitHub(data);
  const result = await searchDiscussions(gh, baseOptions({ limit: 250, sinceMs: NOW - HOUR }), NOW);
  assert.equal(result.items.length, 250);
  assert.ok(gh.calls.some((c) => c.after !== null), "cursor pagination was used");
  assert.equal(new Set(result.items.map((d) => d.id)).size, 250, "no duplicates");
});

test("request budget exhaustion yields an honest incomplete result, never partial-slice guesses", async () => {
  const data = bigDataset();
  const gh = new FakeGitHub(data);
  const opts = baseOptions({ limit: 3600, maxRequests: 6 });
  const result = await searchDiscussions(gh, opts, NOW);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((w) => w.includes("--max-requests")));
  assert.ok(gh.calls.length <= 6);
  const cutoff = Date.parse(result.coveredFrom);
  const oracle = data.filter((d) => Date.parse(d.createdAt) >= cutoff).sort(byNewest);
  assert.deepEqual(result.items.map((d) => d.id), oracle.slice(0, result.items.length).map((d) => d.id));
  for (const d of result.items) assert.ok(Date.parse(d.createdAt) >= cutoff);
});

test("more than 1000 posts in a single second is reported as incomplete", async () => {
  const stamp = new Date(NOW - 30 * MIN).toISOString();
  const data = Array.from({ length: 1100 }, (_, i) => makeDiscussion(i + 1, { createdAt: stamp }));
  const result = await searchDiscussions(new FakeGitHub(data), baseOptions({ limit: 2000, sinceMs: NOW - HOUR }), NOW);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((w) => w.includes("within one second")));
});

test("only read-only GraphQL is ever sent", () => {
  assert.match(SEARCH_QUERY.trimStart(), /^query\s/);
  assert.doesNotMatch(SEARCH_QUERY, /mutation/i);
});

// ----------------------------------------------------------------------------- malformed data

test("malformed: response without data.search throws a malformed error", async () => {
  await assert.rejects(searchDiscussions(scripted({}), baseOptions(), NOW), (e: unknown) => e instanceof FreshQError && e.kind === "malformed");
});

test("malformed: nodes not an array", () => {
  assert.throws(() => parsePage({ search: { discussionCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: "x" } }), /search.nodes/);
});

test("malformed: hasNextPage true with no cursor", () => {
  assert.throws(() => parsePage(page([], { pageInfo: { hasNextPage: true, endCursor: null } })), /endCursor/);
});

test("malformed: discussionCount missing", () => {
  assert.throws(() => parsePage({ search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }), /discussionCount/);
});

test("malformed: a discussion node missing createdAt is rejected, not guessed", () => {
  const node = toNode(makeDiscussion(1));
  delete node["createdAt"];
  assert.throws(() => parseDiscussionNode(node), /createdAt/);
});

test("malformed: invalid createdAt date and negative comment count", () => {
  assert.throws(() => parseDiscussionNode({ ...toNode(makeDiscussion(1)), createdAt: "not-a-date" }), /valid date/);
  assert.throws(() => parseDiscussionNode({ ...toNode(makeDiscussion(1)), comments: { totalCount: -1 } }), /comments/);
});

test("empty or null search nodes (non-Discussion results) are skipped, not errors", () => {
  const p = parsePage(page([{}, null, toNode(makeDiscussion(1))]));
  assert.equal(p.items.length, 1);
});

test("null author (deleted user) and null isAnswered (non-Q&A category) normalise cleanly", () => {
  const d = parseDiscussionNode({ ...toNode(makeDiscussion(1, { author: null, isAnswerable: false, isAnswered: null })) });
  assert.equal(d?.author, null);
  assert.equal(d?.isAnswered, null);
  assert.equal(d?.isAnswerable, false);
});

test("transport errors propagate unchanged", async () => {
  const boom = new FreshQError("rate_limit", "limited");
  await assert.rejects(searchDiscussions(scripted(boom), baseOptions(), NOW), (e: unknown) => e === boom);
});

test("rate-limit info from the API is surfaced", async () => {
  const result = await searchDiscussions(new FakeGitHub([makeDiscussion(1)]), baseOptions(), NOW);
  assert.equal(result.rateLimit?.remaining, 4000);
});
