// Remove build output directories. Usage: node scripts/clean.mjs [dir ...]  (default: dist)
import { rmSync } from "node:fs";

const targets = process.argv.slice(2);
for (const dir of targets.length > 0 ? targets : ["dist"]) {
  rmSync(dir, { recursive: true, force: true });
}
