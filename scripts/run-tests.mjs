// Cross-platform test runner: finds compiled *.test.js files and runs them with node --test.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

const files = collect(join(".test-build", "test"));
if (files.length === 0) {
  console.error("No compiled test files found. Did the TypeScript build fail?");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
