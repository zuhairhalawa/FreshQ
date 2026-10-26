#!/usr/bin/env node
import { run } from "./cli.js";

const code = await run(process.argv.slice(2), {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  now: () => Date.now(),
});
process.exitCode = code;
