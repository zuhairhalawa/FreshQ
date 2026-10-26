// Live, READ-ONLY integration checks against the real GitHub GraphQL API.
// Requires: `npm run build`, and an authenticated `gh` (or GH_TOKEN). Run: npm run test:integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createDefaultTransport, createFetchTransport, createGhTransport, searchDiscussions, FreshQError } from "../dist/index.js";
import { SEARCH_QUERY } from "../dist/client.js";

const HOUR = 3_600_000;
const MIN = 60_000;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

const transport = createDefaultTransport();
const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const base = (over = {}) => ({ sinceMs: 0, limit: 1000, answer: "any", zeroComments: false, repos: [], orgs: [], terms: [], maxRequests: 200, ...over });

/** Independent ground truth: fixed 10-minute slices, read fully, filtered with plain code. */
async function oracle(fromMs, toMs, extraQuery, keep) {
  const found = new Map();
  for (let lo = fromMs; lo <= toMs; lo += 10 * MIN) {
    const hi = Math.min(toMs, lo + 10 * MIN - 1000);
    let after = null;
    do {
      const data = await transport.graphql(SEARCH_QUERY, { q: `created:${iso(lo)}..${iso(hi)} ${extraQuery}`.trim(), first: 100, after });
      assert.ok(data.search.discussionCount <= 1000, "oracle slice must not exceed the 1000 cap");
      for (const n of data.search.nodes) if (n && n.id && keep(n)) found.set(n.id, n);
      after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null;
    } while (after);
  }
  return [...found.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : 1));
}

/**
 * Compare FreshQ against the oracle. The two runs happen minutes apart against a LIVE index that
 * changes under us (observed: ~10 discussions from one repo vanished from search results while still
 * fetchable by id). So a mismatch is retried; a genuine FreshQ bug would mismatch every attempt.
 */
async function agreesWithOracle(runFreshQ, runOracle, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    const got = await runFreshQ();
    const truth = await runOracle();
    try {
      assert.deepEqual(got.map((d) => d.id), truth.map((n) => n.id));
      if (i > 1) console.log(`       (agreed on attempt ${i}; earlier attempt(s) differed because GitHub's live index changed in between)`);
      return { got, truth };
    } catch (err) {
      lastError = err;
      console.log(`       attempt ${i}/${attempts}: FreshQ=${got.length} truth=${truth.length} differ - retrying in case the live index changed`);
    }
  }
  throw lastError;
}

// A fixed window ending a few minutes ago so the search index has settled and both runs see the same data.
const to = Math.floor((Date.now() - 5 * MIN) / 1000) * 1000;
const from = to - 90 * MIN;
// FreshQ pads the upper bound of its search by 60s to tolerate a slow/fast local clock; the oracle must too.
const toP = to + 60_000;

console.log("FreshQ live integration checks (read-only)");

await check("--unanswered --zero-comments matches independent ground truth for a 90-minute window", async () => {
  const opts = base({ sinceMs: from, answer: "unanswered", zeroComments: true });
  let result;
  const { truth } = await agreesWithOracle(
    async () => ((result = await searchDiscussions(transport, opts, to)), result.items),
    () => oracle(from, toP, "is:unanswered comments:0", (n) => n.category.isAnswerable && n.isAnswered === false && n.comments.totalCount === 0),
  );
  console.log(`       FreshQ=${result.items.length} truth=${truth.length} requests=${result.requests}`);
  assert.ok(truth.length > 0, "expected some unanswered, zero-comment discussions in 90 minutes");
  assert.equal(result.complete, true);
});

await check("results are newest-first, created inside the window, and satisfy every filter", async () => {
  const result = await searchDiscussions(transport, base({ sinceMs: from, answer: "unanswered", zeroComments: true, limit: 50 }), to);
  assert.ok(result.items.length > 0);
  for (let i = 0; i < result.items.length; i++) {
    const d = result.items[i];
    assert.ok(Date.parse(d.createdAt) >= from, "createdAt within window");
    assert.ok(d.isAnswerable && d.isAnswered === false, "unanswered Q&A");
    assert.equal(d.comments, 0);
    assert.match(d.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/discussions\/\d+$/);
    if (i > 0) assert.ok(Date.parse(result.items[i - 1].createdAt) >= Date.parse(d.createdAt), "descending createdAt");
  }
});

await check("--answerable returns only categories that support accepted answers (both states)", async () => {
  const { got } = await agreesWithOracle(
    async () => (await searchDiscussions(transport, base({ sinceMs: to - 30 * MIN, answer: "answerable", limit: 200 }), to)).items,
    () => oracle(to - 30 * MIN, toP, "", (n) => n.category.isAnswerable),
  );
  assert.ok(got.length > 0);
  assert.ok(got.every((d) => d.isAnswerable && typeof d.isAnswered === "boolean"));
});

await check("a window above the 1000-result cap is fully covered via time slicing", async () => {
  // Widen until the window holds more than the 1000-result cap, so slicing is genuinely exercised.
  let wide = 4 * HOUR;
  let probe;
  for (;;) {
    probe = await transport.graphql(SEARCH_QUERY, { q: `created:${iso(to - wide)}..${iso(to)}`, first: 1, after: null });
    if (probe.search.discussionCount > 1200 || wide >= 48 * HOUR) break;
    wide *= 2;
  }
  console.log(`       ${wide / HOUR}h window reports ${probe.search.discussionCount} discussions (cap is 1000 per query)`);
  assert.ok(probe.search.discussionCount > 1000, "window should exceed the cap to exercise slicing");
  const unanswered = await agreesWithOracle(
    async () => (await searchDiscussions(transport, base({ sinceMs: to - wide, answer: "unanswered", limit: 1000 }), to)).items,
    () => oracle(to - wide, toP, "is:unanswered", (n) => n.category.isAnswerable && n.isAnswered === false),
  );
  console.log(`       --unanswered: FreshQ=${unanswered.got.length} truth=${unanswered.truth.length}`);

  // Unfiltered: the matching set itself exceeds the cap, so a naive single query would return an arbitrary 1000.
  const all = await agreesWithOracle(
    async () => (await searchDiscussions(transport, base({ sinceMs: to - wide, limit: 1000 }), to)).items,
    async () => (await oracle(to - wide, toP, "", () => true)).slice(0, 1000),
  );
  assert.equal(all.got.length, 1000, "the unfiltered window should fill the limit");
  console.log(`       unfiltered: FreshQ=${all.got.length} == independent truth (top 1000 of ${probe.search.discussionCount})`);
});

await check("--repo filter returns only that repository", async () => {
  const result = await searchDiscussions(transport, base({ sinceMs: Date.now() - 30 * 24 * HOUR, repos: ["vercel/next.js"], limit: 10 }), Date.now());
  assert.ok(result.items.length > 0);
  assert.ok(result.items.every((d) => d.repository.toLowerCase() === "vercel/next.js"));
});

await check("--search + --org filter works and never returns private repositories", async () => {
  const result = await searchDiscussions(transport, base({ sinceMs: Date.now() - 7 * 24 * HOUR, orgs: ["microsoft"], terms: ["error"], limit: 20 }), Date.now());
  assert.ok(result.items.every((d) => d.repository.toLowerCase().startsWith("microsoft/") && !d.isPrivate));
});

await check("a query matching nothing returns an honest empty result", async () => {
  const result = await searchDiscussions(transport, base({ sinceMs: Date.now() - HOUR, terms: ["zzqxjv-no-such-word-9f3a2"], limit: 10 }), Date.now());
  assert.deepEqual(result.items, []);
  assert.equal(result.complete, true);
});

await check("an invalid token over the direct HTTPS transport gives a clear auth error", async () => {
  const bad = createFetchTransport({ token: "ghp_" + "0".repeat(36), userAgent: "freshq-integration" });
  await assert.rejects(searchDiscussions(bad, base({ sinceMs: Date.now() - HOUR, limit: 1 })), (e) => e instanceof FreshQError && e.kind === "auth" && e.exitCode === 3);
});

await check("the built CLI with a rejected token (real gh) exits 3 with an auth message", async () => {
  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env, GH_TOKEN: "ghp_" + "0".repeat(36) }; // obviously fake; only ever sent to the child
  const r = spawnSync(process.execPath, ["dist/bin.js", "--since", "1h"], { encoding: "utf8", env });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /authentication failed/);
  assert.equal(r.stdout, "");
});

await check("the real gh transport and the token-over-HTTPS transport agree", async () => {
  let token = "";
  try {
    token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(); // kept in memory only, never printed
  } catch {
    console.log("       (skipped: no gh token available)");
    return;
  }
  const viaGh = await searchDiscussions(createGhTransport(), base({ sinceMs: to - 20 * MIN, limit: 100 }), to);
  const viaHttp = await searchDiscussions(createFetchTransport({ token, userAgent: "freshq-integration" }), base({ sinceMs: to - 20 * MIN, limit: 100 }), to);
  assert.deepEqual(viaGh.items.map((d) => d.id), viaHttp.items.map((d) => d.id));
});

console.log(`\n${passed} live check(s) passed${process.exitCode ? ", with failures" : ""}.`);
