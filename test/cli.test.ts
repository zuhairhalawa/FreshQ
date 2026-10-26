import { test } from "node:test";
import assert from "node:assert/strict";
import { run, type CliIo } from "../src/cli.js";
import { FreshQError } from "../src/errors.js";
import { formatHuman, formatJson, makeStyle, sanitizeForTerminal } from "../src/format.js";
import type { Transport } from "../src/transport.js";
import { FakeGitHub, HOUR, MIN, NOW, baseOptions, makeDiscussion } from "./fixtures.js";

function harness(transport: Transport, over: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env: {},
    isTTY: false,
    now: () => NOW,
    transport,
    ...over,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

const failing = (e: Error): Transport => ({
  async graphql() {
    throw e;
  },
});

// ------------------------------------------------------------------------------- end-to-end runs

test("human output: title, repo, age, comment count, status and direct link", async () => {
  const gh = new FakeGitHub([
    makeDiscussion(1, { title: "How do I deploy?", repository: "acme/widgets", comments: 0, createdAt: new Date(NOW - 12 * MIN).toISOString() }),
    makeDiscussion(2, { title: "Reply-heavy", comments: 3, isAnswered: true, createdAt: new Date(NOW - 90 * MIN).toISOString() }),
  ]);
  const h = harness(gh);
  const code = await run(["--since", "2h"], h.io);
  assert.equal(code, 0);
  const text = h.out();
  assert.match(text, /How do I deploy\?/);
  assert.match(text, /acme\/widgets #1/);
  assert.match(text, /12m ago/);
  assert.match(text, /0 comments/);
  assert.match(text, /3 comments/);
  assert.match(text, /unanswered/);
  assert.match(text, /answered/);
  assert.match(text, /https:\/\/github\.com\/acme\/widgets\/discussions\/1/);
  assert.ok(text.indexOf("#1") < text.indexOf("#2"), "newest first");
  assert.doesNotMatch(text, /\u001b\[/, "no color when not a TTY");
});

test("--json: valid, stable machine-readable output with no human text", async () => {
  const gh = new FakeGitHub([makeDiscussion(1), makeDiscussion(2)]);
  const h = harness(gh);
  const code = await run(["--since", "1h", "--answerable", "--json"], h.io);
  assert.equal(code, 0);
  const parsed = JSON.parse(h.out()) as Record<string, any>;
  assert.equal(parsed.tool, "freshq");
  assert.equal(parsed.count, 2);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.query.answer, "answerable");
  assert.equal(parsed.items[0].number, 1);
  assert.equal(parsed.items[0].ageSeconds, 60);
  assert.equal(parsed.items[0].url, "https://github.com/acme/widgets/discussions/1");
  assert.equal(typeof parsed.items[0].isAnswerable, "boolean");
});

test("empty result: exit 0, honest message, explains indexing delay, no fabricated rows", async () => {
  const h = harness(new FakeGitHub([]));
  assert.equal(await run(["--since", "1h"], h.io), 0);
  assert.match(h.out(), /No matching discussions found/);
  assert.match(h.out(), /index can lag/);
  assert.doesNotMatch(h.out(), /https:\/\//);

  const j = harness(new FakeGitHub([]));
  assert.equal(await run(["--json"], j.io), 0);
  const parsed = JSON.parse(j.out()) as { count: number; items: unknown[] };
  assert.equal(parsed.count, 0);
  assert.deepEqual(parsed.items, []);
});

test("limit is honoured and announced", async () => {
  const gh = new FakeGitHub(Array.from({ length: 12 }, (_, i) => makeDiscussion(i + 1)));
  const h = harness(gh);
  assert.equal(await run(["--limit", "5"], h.io), 0);
  assert.match(h.out(), /5 discussions shown \(limit 5/);
  assert.equal((h.out().match(/discussions\/\d+/g) ?? []).length, 5);
});

test("--help and --version go to stdout with exit 0", async () => {
  const h = harness(new FakeGitHub([]));
  assert.equal(await run(["--help"], h.io), 0);
  assert.match(h.out(), /freshq --since 2h --unanswered --zero-comments/);
  const v = harness(new FakeGitHub([]));
  assert.equal(await run(["--version"], v.io), 0);
  assert.match(v.out(), /^\d+\.\d+\.\d+/);
});

test("--verbose prints rate-limit details to stderr only", async () => {
  const h = harness(new FakeGitHub([makeDiscussion(1)]));
  await run(["--verbose"], h.io);
  assert.match(h.err(), /4000\/5000 remaining/);
  assert.doesNotMatch(h.out(), /remaining/);
});

// ---------------------------------------------------------------------------------- exit codes

test("exit codes: usage=2, auth=3, permission=3, no-credentials=3, rate limit=4, network=5, malformed=6, internal=1", async () => {
  const cases: Array<[string[], Transport, number, RegExp]> = [
    [["--since", "zzz"], new FakeGitHub([]), 2, /Invalid --since/],
    [[], failing(new FreshQError("auth", "GitHub rejected the credentials.", "Run `gh auth login`")), 3, /gh auth login/],
    [[], failing(new FreshQError("permission", "denied")), 3, /denied/],
    [[], failing(new FreshQError("no_credentials", "none")), 3, /none/],
    [[], failing(new FreshQError("rate_limit", "GitHub API rate limit reached.")), 4, /rate limit/],
    [[], failing(new FreshQError("network", "offline")), 5, /offline/],
    [[], failing(new FreshQError("malformed", "bad shape")), 6, /bad shape/],
    [[], failing(new Error("kaboom")), 1, /unexpected error: kaboom/],
  ];
  for (const [argv, transport, expected, pattern] of cases) {
    const h = harness(transport);
    assert.equal(await run(argv, h.io), expected, argv.join(" ") || "(no args)");
    assert.match(h.err(), pattern);
    assert.equal(h.out(), "", "errors never write to stdout (keeps --json pipelines clean)");
  }
});

test("unexpected errors never echo a token", async () => {
  const token = "ghp_" + "q".repeat(36);
  const h = harness(failing(new Error(`request failed for ${token}`)));
  assert.equal(await run([], h.io), 1);
  assert.ok(!h.err().includes(token));
});

// ---------------------------------------------------------------------------------- formatting

test("terminal-injection: ANSI/OSC escapes and control characters in titles are neutralised", () => {
  const evil = "Hello\u001b[2J\u001b[31mred\u001b]0;pwned\u0007‮evil\r\nline2\u0000";
  const clean = sanitizeForTerminal(evil);
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f‮]/);
  assert.ok(clean.startsWith("Hello"));
  assert.ok(!clean.includes("pwned"), "OSC payload removed");
});

test("human output sanitizes titles and repo names", () => {
  const d = makeDiscussion(1, { title: "\u001b[2JClear\u001b[0m me", repository: "a/\u001b[31mb" });
  const text = formatHuman({ items: [d], complete: true, coveredFrom: "x", requests: 1, rateLimit: null, warnings: [] }, baseOptions(), "24h", NOW, makeStyle(false));
  assert.doesNotMatch(text, /\u001b/);
});

test("colors only when enabled", () => {
  const d = makeDiscussion(1);
  const result = { items: [d], complete: true, coveredFrom: "x", requests: 1, rateLimit: null, warnings: [] };
  assert.match(formatHuman(result, baseOptions(), "24h", NOW, makeStyle(true)), /\u001b\[/);
  assert.doesNotMatch(formatHuman(result, baseOptions(), "24h", NOW, makeStyle(false)), /\u001b\[/);
});

test("color is on for a TTY, off with --no-color or NO_COLOR", async () => {
  const gh = new FakeGitHub([makeDiscussion(1)]);
  const on = harness(gh, { isTTY: true, env: { TERM: "xterm" } });
  await run([], on.io);
  assert.match(on.out(), /\u001b\[/);
  const flag = harness(gh, { isTTY: true });
  await run(["--no-color"], flag.io);
  assert.doesNotMatch(flag.out(), /\u001b\[/);
  const env = harness(gh, { isTTY: true, env: { NO_COLOR: "1" } });
  await run([], env.io);
  assert.doesNotMatch(env.out(), /\u001b\[/);
});

test("non-answerable categories are labelled, not called 'unanswered'", () => {
  const d = makeDiscussion(1, { isAnswerable: false, isAnswered: null, category: "Ideas" });
  const text = formatHuman({ items: [d], complete: true, coveredFrom: "x", requests: 1, rateLimit: null, warnings: [] }, baseOptions(), "24h", NOW, makeStyle(false));
  assert.match(text, /Ideas/);
  assert.match(text, /no accepted-answer feature/);
  assert.doesNotMatch(text, /· unanswered/);
});

test("incomplete results are flagged in both formats", () => {
  const result = { items: [], complete: false, coveredFrom: "2026-10-27T11:00:00.000Z", requests: 9, rateLimit: null, warnings: ["w"] };
  assert.match(formatHuman(result, baseOptions(), "24h", NOW, makeStyle(false)), /Incomplete/);
  const j = JSON.parse(formatJson(result, baseOptions(), { version: "1", sinceLabel: "24h", nowMs: NOW })) as { complete: boolean; warnings: string[] };
  assert.equal(j.complete, false);
  assert.deepEqual(j.warnings, ["w"]);
});

test("window labels describe the actual filters", () => {
  const d = makeDiscussion(1);
  const result = { items: [d], complete: true, coveredFrom: "x", requests: 1, rateLimit: null, warnings: [] };
  const text = formatHuman(result, baseOptions({ answer: "unanswered", zeroComments: true, repos: ["a/b"], terms: ["docker"] }), "2h", NOW, makeStyle(false));
  assert.match(text, /unanswered Q&A, zero-comment discussions created in the last 2h in a\/b matching "docker"/);
  assert.ok(HOUR > 0);
});
