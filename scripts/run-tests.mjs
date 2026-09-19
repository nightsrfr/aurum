#!/usr/bin/env node
// Real recursive filesystem walk of every *.test.ts under src/ — not a
// hardcoded list — so a new test file needs zero registration anywhere.
// Same convention as concierge-platform's own scripts/run-tests.mjs, for
// the same reason: a maintained file list silently drifts and stops
// running files nobody notices dropped out.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

const files = fs
  .readdirSync(SRC, { recursive: true })
  .filter((f) => typeof f === "string" && f.endsWith(".test.ts"))
  .map((f) => path.join(SRC, f));

if (files.length === 0) {
  console.error("No *.test.ts files found under src/");
  process.exit(1);
}

console.log(`Running ${files.length} test file(s)...`);
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
});
process.exit(result.status ?? 1);
