// Verifies the DISTRIBUTED package: npm pack -> inspect tarball -> install into a fresh temp
// project -> run the installed binary from a directory outside this repository.
// Usage: node scripts/verify-package.mjs [--live]   (--live also runs one real read-only query)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// On Windows, npm and bin shims are .cmd files that need a shell. All arguments below are fixed strings
// (never user input), so Node's DEP0190 warning about unescaped shell args is not applicable here.
process.noDeprecation = true;

// The package is published under a scope (npm rejected the unscoped name as too similar to "fresh");
// the installed folder is node_modules/@zuhairhalawa/freshq, while the executable stays `freshq`.
const PACKAGE_NAME = "@zuhairhalawa/freshq";
const BIN_NAME = "freshq";

const live = process.argv.includes("--live");
const repo = resolve(import.meta.dirname, "..");
const isWin = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "freshq-verify-"));
let step = 0;
const log = (m) => console.log(`[${++step}] ${m}`);

function sh(cmd, args, opts = {}) {
  // shell only on Windows, where npm is a .cmd shim; arguments here are fixed strings, never user input.
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: isWin, ...opts });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

try {
  log("npm pack (runs the build via prepack)");
  const packed = sh("npm", ["pack", "--json", "--pack-destination", work], { cwd: repo });
  assert.equal(packed.code, 0, `npm pack failed:\n${packed.err}`);
  const info = JSON.parse(packed.out.slice(packed.out.indexOf("[")))[0];
  const tarball = join(work, info.filename);
  const files = info.files.map((f) => f.path.replace(/\\/g, "/"));
  console.log(`    ${info.filename}: ${files.length} files, ${info.size} bytes packed`);

  log("tarball contents");
  for (const required of ["package.json", "README.md", "LICENSE", "dist/bin.js", "dist/cli.js", "dist/index.js", "dist/index.d.ts"]) {
    assert.ok(files.includes(required), `missing from package: ${required}`);
  }
  const forbidden = files.filter((f) => /^(src|test|scripts|\.github|\.test-build)\//.test(f) || /(^|\/)\.(env|git|npmrc)/.test(f) || /\.map$/.test(f) || /tsconfig/.test(f));
  assert.deepEqual(forbidden, [], `unexpected files shipped: ${forbidden.join(", ")}`);
  const binSource = readFileSync(join(repo, "dist", "bin.js"), "utf8");
  assert.ok(binSource.startsWith("#!/usr/bin/env node\n"), "bin must start with an LF-terminated shebang (a CRLF shebang breaks Linux/macOS)");

  log("install tarball into a fresh temp project (outside the repo)");
  const proj = join(work, "consumer");
  mkdirSync(proj);
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", private: true }));
  const inst = sh("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: proj });
  assert.equal(inst.code, 0, `npm install failed:\n${inst.err}`);
  const installed = join(proj, "node_modules", ...PACKAGE_NAME.split("/"));
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const source = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(pkg.name, PACKAGE_NAME, "installed package name");
  assert.equal(pkg.version, source.version, "installed package version matches package.json");
  assert.equal(pkg.bin?.[BIN_NAME], "dist/bin.js", `bin "${BIN_NAME}" maps to dist/bin.js`);
  assert.deepEqual(Object.keys(pkg.bin ?? {}), [BIN_NAME], "only the freshq executable is exposed");
  assert.deepEqual(pkg.dependencies ?? {}, {}, "no runtime dependencies");
  console.log(`    installed ${pkg.name}@${pkg.version} with 0 runtime dependencies`);

  log("scan the installed files for credential-shaped strings");
  const secretRe = /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/;
  for (const f of files) {
    if (/\.(js|json|md|ts)$/.test(f) || f === "LICENSE") {
      assert.doesNotMatch(readFileSync(join(installed, f), "utf8"), secretRe, `credential-like string in ${f}`);
    }
  }

  const bin = join(proj, "node_modules", ".bin", isWin ? `${BIN_NAME}.cmd` : BIN_NAME);
  assert.ok(existsSync(bin), "bin shim exists");
  const freshq = (args) => sh(isWin ? `"${bin}"` : bin, args, { cwd: proj });

  log("run installed binary: --version");
  const v = freshq(["--version"]);
  assert.equal(v.code, 0, v.err);
  assert.equal(v.out.trim(), pkg.version);

  log("run installed binary: --help");
  const h = freshq(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /--since <dur>/);
  assert.match(h.out, /freshq --since 2h --unanswered --zero-comments/);

  log("run installed binary: bad usage exits with code 2 and a clear message");
  const bad = freshq(["--since", "banana"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Invalid --since/);
  assert.equal(bad.out, "");

  if (live) {
    log("run installed binary against the real GitHub API: --since 1h --limit 3 --json");
    const r = freshq(["--since", "1h", "--limit", "3", "--json"]);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.tool, "freshq");
    assert.ok(Array.isArray(parsed.items));
    console.log(`    got ${parsed.count} item(s), ${parsed.requests} request(s)`);
    log("run installed binary against the real GitHub API: human output");
    const hr = freshq(["--since", "2h", "--unanswered", "--zero-comments", "--limit", "2", "--no-color"]);
    assert.equal(hr.code, 0, hr.err);
    assert.match(hr.out, /FreshQ/);
  } else {
    console.log("    (skipping live GitHub query; pass --live to include it)");
  }

  console.log("\nPackage verification PASSED.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
