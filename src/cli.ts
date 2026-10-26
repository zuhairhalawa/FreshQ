import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HELP_TEXT, parseCli } from "./args.js";
import { searchDiscussions } from "./client.js";
import { ExitCode, FreshQError, redactSecrets } from "./errors.js";
import { formatHuman, formatJson, makeStyle } from "./format.js";
import { createDefaultTransport, type Transport } from "./transport.js";

export function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli.js -> ../package.json ; .test-build/src/cli.js -> ../../package.json
  for (const rel of [["..", "package.json"], ["..", "..", "package.json"]]) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, ...rel), "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "@zuhairhalawa/freshq" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // try next location
    }
  }
  return "0.0.0";
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  now: () => number;
  transport?: Transport;
}

/** Run the CLI. Returns the process exit code; never calls process.exit itself (testable). */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const nowMs = io.now();
    const cli = parseCli(argv, nowMs);

    if (cli.kind === "help") {
      io.stdout(HELP_TEXT);
      return ExitCode.Ok;
    }
    if (cli.kind === "version") {
      io.stdout(`${readVersion()}\n`);
      return ExitCode.Ok;
    }

    const version = readVersion();
    const transport = io.transport ?? createDefaultTransport({ env: io.env, userAgent: `freshq/${version}` });
    const result = await searchDiscussions(transport, cli.search, nowMs);

    if (cli.json) {
      io.stdout(formatJson(result, cli.search, { version, sinceLabel: cli.sinceLabel, nowMs }));
    } else {
      const colorOn = io.isTTY && cli.noColor === false && !("NO_COLOR" in io.env) && io.env["TERM"] !== "dumb";
      io.stdout(formatHuman(result, cli.search, cli.sinceLabel, nowMs, makeStyle(colorOn)));
    }

    for (const w of result.warnings) io.stderr(`freshq: warning: ${w}\n`);
    if (!result.complete && !cli.json) {
      io.stderr("freshq: warning: results are incomplete (see above).\n");
    }
    if (cli.verbose) {
      const rl = result.rateLimit;
      io.stderr(
        `freshq: ${result.requests} GraphQL request(s)` +
          (rl ? `; rate limit ${rl.remaining}/${rl.limit} remaining, resets ${rl.resetAt}` : "") +
          "\n",
      );
    }
    return ExitCode.Ok;
  } catch (err) {
    if (err instanceof FreshQError) {
      io.stderr(`freshq: error: ${err.message}\n`);
      if (err.hint) io.stderr(`        ${err.hint}\n`);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`freshq: unexpected error: ${redactSecrets(message)}\n`);
    return ExitCode.Internal;
  }
}

