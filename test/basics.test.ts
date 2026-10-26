import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAge, parseDuration } from "../src/duration.js";
import { FreshQError, classifyFailure, redactSecrets } from "../src/errors.js";
import { buildSearchQuery, formatSearchTime, quoteTerm, validateOrg, validateRepo } from "../src/query.js";
import { parseCli } from "../src/args.js";
import { HOUR, MIN, NOW } from "./fixtures.js";

// ------------------------------------------------------------------------------------ duration

test("parseDuration accepts the documented windows", () => {
  assert.equal(parseDuration("1h"), HOUR);
  assert.equal(parseDuration("2h"), 2 * HOUR);
  assert.equal(parseDuration("24h"), 24 * HOUR);
  assert.equal(parseDuration("7d"), 7 * 24 * HOUR);
  assert.equal(parseDuration("30m"), 30 * MIN);
  assert.equal(parseDuration(" 2H "), 2 * HOUR);
  assert.equal(parseDuration("2w"), 14 * 24 * HOUR);
});

test("parseDuration rejects bad input with a usage error", () => {
  for (const bad of ["", "h", "2", "2x", "-1h", "1.5h", "0h", "0m", "31d", "5w", "2 h 3m"]) {
    assert.throws(() => parseDuration(bad), (e: unknown) => e instanceof FreshQError && e.kind === "usage", bad);
  }
});

test("formatAge", () => {
  assert.equal(formatAge(NOW - 5_000, NOW), "just now");
  assert.equal(formatAge(NOW - 5 * MIN, NOW), "5m ago");
  assert.equal(formatAge(NOW - HOUR, NOW), "1h ago");
  assert.equal(formatAge(NOW - (3 * HOUR + 12 * MIN), NOW), "3h 12m ago");
  assert.equal(formatAge(NOW - 50 * HOUR, NOW), "2d 2h ago");
  assert.equal(formatAge(NOW + HOUR, NOW), "just now", "future timestamps (clock skew) clamp to now");
});

// ------------------------------------------------------------------------------------ query

test("formatSearchTime uses second-precision UTC", () => {
  assert.equal(formatSearchTime(Date.UTC(2026, 9, 27, 12, 0, 0, 999)), "2026-10-27T12:00:00Z");
});

test("buildSearchQuery composes only verified qualifiers", () => {
  const q = buildSearchQuery({
    fromMs: NOW - HOUR,
    toMs: NOW,
    variant: "is:unanswered",
    zeroComments: true,
    repos: ["vercel/next.js"],
    orgs: ["microsoft"],
    terms: ["docker", "type error"],
    inScope: "title",
  });
  assert.equal(
    q,
    'created:2026-10-27T11:00:00Z..2026-10-27T12:00:00Z is:unanswered comments:0 repo:vercel/next.js org:microsoft docker "type error" in:title',
  );
  assert.ok(!/sort:|answered:|category:|is:answerable/.test(q));
});

test("buildSearchQuery without optional filters is just a created range", () => {
  const q = buildSearchQuery({ fromMs: NOW - HOUR, toMs: NOW, variant: null, zeroComments: false, repos: [], orgs: [], terms: [] });
  assert.equal(q, "created:2026-10-27T11:00:00Z..2026-10-27T12:00:00Z");
});

test("search terms cannot smuggle qualifiers or operators", () => {
  assert.equal(quoteTerm("is:answered"), '"is:answered"');
  assert.equal(quoteTerm("repo:evil/x"), '"repo:evil/x"');
  assert.equal(quoteTerm("OR"), '"OR"');
  assert.equal(quoteTerm("-secret"), '"-secret"');
  assert.equal(quoteTerm('say "hi" now'), '"say hi now"');
  assert.equal(quoteTerm("plain"), "plain");
  assert.throws(() => quoteTerm("   "), FreshQError);
  assert.throws(() => quoteTerm("x".repeat(101)), FreshQError);
});

test("repo and org validation", () => {
  assert.equal(validateRepo("vercel/next.js"), "vercel/next.js");
  assert.equal(validateRepo("https://github.com/vercel/next.js/"), "vercel/next.js");
  assert.equal(validateOrg("@microsoft"), "microsoft");
  for (const bad of ["vercel", "a/b/c", "a b/c", "a/b c", "/x", "x/", "a/b;rm -rf", "a/b\nrepo:z/z"]) {
    assert.throws(() => validateRepo(bad), (e: unknown) => e instanceof FreshQError && e.kind === "usage", bad);
  }
  for (const bad of ["", "-bad", "bad org", "a/b", "x".repeat(41)]) {
    assert.throws(() => validateOrg(bad), (e: unknown) => e instanceof FreshQError && e.kind === "usage", bad);
  }
});

test("too many scopes is a usage error", () => {
  const repos = Array.from({ length: 31 }, (_, i) => `o/r${i}`);
  assert.throws(() => buildSearchQuery({ fromMs: NOW - HOUR, toMs: NOW, variant: null, zeroComments: false, repos, orgs: [], terms: [] }), FreshQError);
});

// ------------------------------------------------------------------------------------ args

function run(argv: string[]) {
  const r = parseCli(argv, NOW);
  assert.equal(r.kind, "run");
  if (r.kind !== "run") throw new Error("unreachable");
  return r;
}

test("defaults: 24h, limit 30, any answer state", () => {
  const r = run([]);
  assert.equal(r.search.sinceMs, NOW - 24 * HOUR);
  assert.equal(r.search.limit, 30);
  assert.equal(r.search.answer, "any");
  assert.equal(r.json, false);
});

test("documented example: --since 2h --unanswered --zero-comments", () => {
  const r = run(["--since", "2h", "--unanswered", "--zero-comments"]);
  assert.equal(r.search.sinceMs, NOW - 2 * HOUR);
  assert.equal(r.search.answer, "unanswered");
  assert.equal(r.search.zeroComments, true);
});

test("documented example: --since 24h --repo owner/repo", () => {
  const r = run(["--since", "24h", "--repo", "owner/repo"]);
  assert.deepEqual(r.search.repos, ["owner/repo"]);
});

test("documented example: --since 1h --answerable --json", () => {
  const r = run(["--since", "1h", "--answerable", "--json"]);
  assert.equal(r.search.answer, "answerable");
  assert.equal(r.json, true);
});

test("--unanswered wins over --answerable; repeatable flags accumulate", () => {
  const r = run(["--answerable", "--unanswered", "--repo", "a/b", "--repo", "c/d", "--org", "x", "-s", "one", "--search", "two words"]);
  assert.equal(r.search.answer, "unanswered");
  assert.deepEqual(r.search.repos, ["a/b", "c/d"]);
  assert.deepEqual(r.search.orgs, ["x"]);
  assert.deepEqual(r.search.terms, ["one", "two words"]);
});

test("help and version short-circuit", () => {
  assert.equal(parseCli(["--help"], NOW).kind, "help");
  assert.equal(parseCli(["-h"], NOW).kind, "help");
  assert.equal(parseCli(["--version"], NOW).kind, "version");
  assert.equal(parseCli(["-v"], NOW).kind, "version");
});

test("invalid arguments produce usage errors (exit code 2)", () => {
  const cases = [
    ["--bogus"],
    ["positional"],
    ["--since"],
    ["--since", "banana"],
    ["--limit", "0"],
    ["--limit", "abc"],
    ["--limit", "1001"],
    ["--repo", "no-slash"],
    ["--in", "title"],
    ["--search", "x", "--in", "nowhere"],
    ["--max-requests", "0"],
    ["--search", "   "],
  ];
  for (const argv of cases) {
    assert.throws(
      () => parseCli(argv, NOW),
      (e: unknown) => e instanceof FreshQError && e.kind === "usage" && e.exitCode === 2,
      argv.join(" "),
    );
  }
});

// ------------------------------------------------------------------------------------ errors

test("redactSecrets removes token shapes", () => {
  const classic = "ghp_" + "a".repeat(36);
  const oauth = "gho_" + "B".repeat(36);
  const pat = "github_pat_" + "c".repeat(40);
  const text = `x ${classic} y ${oauth} z ${pat} Authorization: Bearer abc123def`;
  const out = redactSecrets(text);
  assert.ok(!out.includes(classic) && !out.includes(oauth) && !out.includes(pat) && !out.includes("abc123def"));
  assert.match(out, /\[REDACTED\]/);
});

test("classifyFailure: authentication failures", () => {
  for (const info of [
    { status: 401, message: "Bad credentials" },
    { message: "To get started with GitHub CLI, please run:  gh auth login" },
    { message: "To use GitHub CLI in automation, set the GH_TOKEN environment variable." },
  ]) {
    const e = classifyFailure(info);
    assert.equal(e.kind, "auth");
    assert.equal(e.exitCode, 3);
    assert.match(e.hint ?? "", /gh auth login/);
  }
});

test("classifyFailure: rate limits (primary, secondary, GraphQL type) with reset hint", () => {
  const reset = String(Math.floor(NOW / 1000) + 600);
  const primary = classifyFailure({ status: 403, message: "API rate limit exceeded", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, now: NOW });
  assert.equal(primary.kind, "rate_limit");
  assert.equal(primary.exitCode, 4);
  assert.match(primary.message, /about 10 min/);

  const secondary = classifyFailure({ status: 403, message: "You have exceeded a secondary rate limit", headers: { "retry-after": "60" } });
  assert.equal(secondary.kind, "rate_limit");
  assert.match(secondary.message, /retry after 60 seconds/);

  assert.equal(classifyFailure({ message: "x", graphqlTypes: ["RATE_LIMITED"] }).kind, "rate_limit");
  assert.equal(classifyFailure({ status: 429, message: "slow down" }).kind, "rate_limit");
});

test("classifyFailure: permissions, SAML, server errors, unknown", () => {
  assert.equal(classifyFailure({ status: 403, message: "Resource not accessible by personal access token" }).kind, "permission");
  const saml = classifyFailure({ status: 403, message: "Resource protected by organization SAML enforcement" });
  assert.equal(saml.kind, "permission");
  assert.match(saml.message, /SAML/);
  assert.equal(classifyFailure({ status: 502, message: "Bad Gateway" }).kind, "network");
  assert.equal(classifyFailure({ message: "weird" }).kind, "api");
});

test("classifyFailure never leaks tokens in messages", () => {
  const token = "ghp_" + "z".repeat(36);
  const e = classifyFailure({ message: `something broke with ${token}` });
  assert.ok(!e.message.includes(token));
});
