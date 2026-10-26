import { test } from "node:test";
import assert from "node:assert/strict";
import { FreshQError } from "../src/errors.js";
import {
  createDefaultTransport,
  createFetchTransport,
  createGhTransport,
  unwrapGraphql,
  type ExecError,
  type ExecFn,
} from "../src/transport.js";

const OK_BODY = JSON.stringify({ data: { search: { discussionCount: 0 } } });
const SECRET = "ghp_" + "s".repeat(36);

function execError(over: Partial<ExecError>): ExecError {
  return Object.assign(new Error("Command failed"), over);
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FreshQError) return e.kind;
    return `non-freshq:${String(e)}`;
  }
  return "no-error";
}

// ------------------------------------------------------------------------------- gh transport

test("gh transport: passes the query as discrete args (no shell) and types numbers", async () => {
  let seen: readonly string[] = [];
  const exec: ExecFn = async (file, args) => {
    assert.equal(file, "gh");
    seen = args;
    return { stdout: OK_BODY, stderr: "" };
  };
  const data = await createGhTransport(exec).graphql("query { x }", { q: 'a; rm -rf / "$(whoami)"', first: 100, after: null });
  assert.deepEqual(data, { search: { discussionCount: 0 } });
  assert.deepEqual(seen, ["api", "graphql", "-f", "query=query { x }", "-f", 'q=a; rm -rf / "$(whoami)"', "-F", "first=100"]);
});

test("gh transport: gh missing -> distinct internal signal handled by default transport", async () => {
  const exec: ExecFn = async () => {
    throw execError({ code: "ENOENT" });
  };
  const err = await createGhTransport(exec).graphql("q", {}).then(() => null, (e: unknown) => e);
  assert.equal((err as Error).name, "GhNotFoundError");
});

test("gh transport: not logged in -> auth error", async () => {
  const exec: ExecFn = async () => {
    throw execError({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login\n" });
  };
  assert.equal(await kindOf(createGhTransport(exec).graphql("q", {})), "auth");
});

test("gh transport: HTTP 401 -> auth, HTTP 403 rate limit -> rate_limit, 403 other -> permission", async () => {
  const mk = (stderr: string): ExecFn => async () => {
    throw execError({ code: 1, stdout: "", stderr });
  };
  assert.equal(await kindOf(createGhTransport(mk("gh: Bad credentials (HTTP 401)")).graphql("q", {})), "auth");
  assert.equal(await kindOf(createGhTransport(mk("gh: API rate limit exceeded for user ID 1. (HTTP 403)")).graphql("q", {})), "rate_limit");
  assert.equal(await kindOf(createGhTransport(mk("gh: Resource not accessible by integration (HTTP 403)")).graphql("q", {})), "permission");
  assert.equal(await kindOf(createGhTransport(mk("gh: Service Unavailable (HTTP 503)")).graphql("q", {})), "network");
});

test("gh transport: REAL gh shape for a rejected token (HTTP-level JSON on stdout) -> auth, not malformed", async () => {
  // Captured from the real gh 2.x with an invalid GH_TOKEN: stdout is a REST-style error body, stderr has the HTTP status.
  const exec: ExecFn = async () => {
    throw execError({
      code: 1,
      stdout: '{"message":"Bad credentials","documentation_url":"https://docs.github.com/graphql","status":"401"}',
      stderr: "gh: Bad credentials (HTTP 401)",
    });
  };
  const err = await createGhTransport(exec).graphql("q", {}).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof FreshQError);
  assert.equal(err.kind, "auth");
  assert.equal(err.exitCode, 3);

  // Same body with no stderr at all: the status inside the body is enough.
  const bodyOnly: ExecFn = async () => {
    throw execError({ code: 1, stdout: '{"message":"Bad credentials","status":"401"}', stderr: "" });
  };
  assert.equal(await kindOf(createGhTransport(bodyOnly).graphql("q", {})), "auth");
  const limited: ExecFn = async () => {
    throw execError({ code: 1, stdout: '{"message":"API rate limit exceeded for user ID 1.","status":"403"}', stderr: "gh: API rate limit exceeded (HTTP 403)" });
  };
  assert.equal(await kindOf(createGhTransport(limited).graphql("q", {})), "rate_limit");
});

test("gh transport: GraphQL errors on stdout with non-zero exit are classified from the JSON", async () => {
  const body = JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] });
  const exec: ExecFn = async () => {
    throw execError({ code: 1, stdout: body, stderr: "gh: API rate limit exceeded" });
  };
  assert.equal(await kindOf(createGhTransport(exec).graphql("q", {})), "rate_limit");
});

test("gh transport: transient HTTP 502 is retried (seen on the real API), then succeeds", async () => {
  let n = 0;
  const exec: ExecFn = async () => {
    if (++n < 3) throw execError({ code: 1, stdout: "", stderr: "gh: Bad Gateway (HTTP 502)" });
    return { stdout: OK_BODY, stderr: "" };
  };
  const waits: number[] = [];
  await createGhTransport(exec, { sleep: async (ms) => void waits.push(ms) }).graphql("q", {});
  assert.equal(n, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test("gh transport: persistent 502 gives up after bounded retries; auth/rate-limit errors are never retried", async () => {
  let n = 0;
  const down: ExecFn = async () => {
    n++;
    throw execError({ code: 1, stdout: "", stderr: "gh: Bad Gateway (HTTP 502)" });
  };
  assert.equal(await kindOf(createGhTransport(down, { sleep: async () => {} }).graphql("q", {})), "network");
  assert.equal(n, 3);

  let m = 0;
  const unauth: ExecFn = async () => {
    m++;
    throw execError({ code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" });
  };
  assert.equal(await kindOf(createGhTransport(unauth, { sleep: async () => {} }).graphql("q", {})), "auth");
  assert.equal(m, 1);
});

test("gh transport: timeout -> network; garbage output -> malformed", async () => {
  const timeout: ExecFn = async () => {
    throw execError({ killed: true, code: null });
  };
  assert.equal(await kindOf(createGhTransport(timeout).graphql("q", {})), "network");
  const garbage: ExecFn = async () => ({ stdout: "<html>nope</html>", stderr: "" });
  assert.equal(await kindOf(createGhTransport(garbage).graphql("q", {})), "malformed");
});

test("unwrapGraphql: errors array, missing data and non-objects", () => {
  assert.throws(() => unwrapGraphql(null), (e: unknown) => e instanceof FreshQError && e.kind === "malformed");
  assert.throws(() => unwrapGraphql({}), (e: unknown) => e instanceof FreshQError && e.kind === "malformed");
  assert.throws(() => unwrapGraphql({ data: null }), (e: unknown) => e instanceof FreshQError && e.kind === "malformed");
  assert.throws(() => unwrapGraphql({ errors: [{ message: "boom" }] }), (e: unknown) => e instanceof FreshQError && e.kind === "api");
  assert.deepEqual(unwrapGraphql({ data: { a: 1 } }), { a: 1 });
});

// ------------------------------------------------------------------------------ fetch transport

function resp(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}
const noSleep = async () => {};

test("fetch transport: sends bearer token + JSON body, returns data", async () => {
  let init: RequestInit | undefined;
  const fetchImpl = (async (_url: string | URL | Request, i?: RequestInit) => {
    init = i;
    return resp(200, OK_BODY);
  }) as typeof fetch;
  const t = createFetchTransport({ token: SECRET, fetchImpl, sleep: noSleep, userAgent: "freshq/test" });
  const data = await t.graphql("query { x }", { q: "hello" });
  assert.deepEqual(data, { search: { discussionCount: 0 } });
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers["authorization"], `Bearer ${SECRET}`);
  assert.equal(init?.method, "POST");
  assert.deepEqual(JSON.parse(String(init?.body)), { query: "query { x }", variables: { q: "hello" } });
});

test("fetch transport: 401 -> auth, with no token in the message", async () => {
  const fetchImpl = (async () => resp(401, JSON.stringify({ message: `Bad credentials ${SECRET}` }))) as typeof fetch;
  const err = await createFetchTransport({ token: SECRET, fetchImpl, sleep: noSleep }).graphql("q", {}).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof FreshQError);
  assert.equal(err.kind, "auth");
  assert.ok(!err.message.includes(SECRET) && !(err.hint ?? "").includes(SECRET));
});

test("fetch transport: 403 with exhausted quota -> rate_limit including reset time", async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 300);
  const fetchImpl = (async () =>
    resp(403, JSON.stringify({ message: "API rate limit exceeded" }), { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset })) as typeof fetch;
  const err = await createFetchTransport({ token: "t", fetchImpl, sleep: noSleep }).graphql("q", {}).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof FreshQError);
  assert.equal(err.kind, "rate_limit");
  assert.match(err.message, /resets at/);
});

test("fetch transport: GraphQL-level RATE_LIMITED error at HTTP 200", async () => {
  const body = JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] });
  const fetchImpl = (async () => resp(200, body)) as typeof fetch;
  assert.equal(await kindOf(createFetchTransport({ token: "t", fetchImpl, sleep: noSleep }).graphql("q", {})), "rate_limit");
});

test("fetch transport: retries transient 5xx then succeeds; gives up with network error", async () => {
  let n = 0;
  const flaky = (async () => (++n < 3 ? resp(502, "Bad Gateway") : resp(200, OK_BODY))) as typeof fetch;
  await createFetchTransport({ token: "t", fetchImpl: flaky, sleep: noSleep }).graphql("q", {});
  assert.equal(n, 3);

  let m = 0;
  const down = (async () => (m++, resp(503, "unavailable"))) as typeof fetch;
  assert.equal(await kindOf(createFetchTransport({ token: "t", fetchImpl: down, sleep: noSleep }).graphql("q", {})), "network");
  assert.equal(m, 3, "1 attempt + 2 retries");
});

test("fetch transport: network failure -> network error; does not retry client errors", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.equal(await kindOf(createFetchTransport({ token: "t", fetchImpl: offline, sleep: noSleep }).graphql("q", {})), "network");

  let n = 0;
  const bad = (async () => (n++, resp(404, JSON.stringify({ message: "Not Found" })))) as typeof fetch;
  await createFetchTransport({ token: "t", fetchImpl: bad, sleep: noSleep }).graphql("q", {}).catch(() => undefined);
  assert.equal(n, 1);
});

test("fetch transport: non-JSON 200 body -> malformed", async () => {
  const fetchImpl = (async () => resp(200, "<html>captive portal</html>")) as typeof fetch;
  assert.equal(await kindOf(createFetchTransport({ token: "t", fetchImpl, sleep: noSleep }).graphql("q", {})), "malformed");
});

// ------------------------------------------------------------------------------ default selection

test("default transport: prefers gh when present", async () => {
  let ghCalls = 0;
  const exec: ExecFn = async () => (ghCalls++, { stdout: OK_BODY, stderr: "" });
  const fetchImpl = (async () => {
    throw new Error("fetch must not be used when gh works");
  }) as typeof fetch;
  const t = createDefaultTransport({ env: { GH_TOKEN: SECRET }, exec, fetchImpl });
  await t.graphql("q", {});
  assert.equal(ghCalls, 1);
});

test("default transport: falls back to GH_TOKEN over HTTPS when gh is not installed", async () => {
  const exec: ExecFn = async () => {
    throw execError({ code: "ENOENT" });
  };
  let calls = 0;
  const fetchImpl = (async () => (calls++, resp(200, OK_BODY))) as typeof fetch;
  const t = createDefaultTransport({ env: { GITHUB_TOKEN: SECRET }, exec, fetchImpl });
  await t.graphql("q", {});
  await t.graphql("q", {});
  assert.equal(calls, 2);
});

test("default transport: no gh and no token -> no_credentials with setup hint", async () => {
  const exec: ExecFn = async () => {
    throw execError({ code: "ENOENT" });
  };
  const err = await createDefaultTransport({ env: {}, exec }).graphql("q", {}).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof FreshQError);
  assert.equal(err.kind, "no_credentials");
  assert.equal(err.exitCode, 3);
  assert.match(err.hint ?? "", /gh auth login/);
});

test("default transport: gh auth errors are not masked by the token fallback", async () => {
  const exec: ExecFn = async () => {
    throw execError({ code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" });
  };
  assert.equal(await kindOf(createDefaultTransport({ env: { GH_TOKEN: SECRET }, exec }).graphql("q", {})), "auth");
});
