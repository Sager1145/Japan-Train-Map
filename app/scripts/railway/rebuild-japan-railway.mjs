#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (command, args) =>
  execFileSync(command, args, { cwd: APP_DIR, stdio: "inherit" });

run("node", ["scripts/railway/split-interleaved-branches.mjs"]);
run("node", ["scripts/railway/repair-doubling-back-intervals.mjs"]);
run("python3", ["scripts/migrations/restore-n02-loop-line-geometry.py"]);
run("node", ["scripts/railway/build-parallel-corridors.mjs", "--country", "jp"]);
run("node", ["scripts/railway/finalize-japan-package.mjs"]);
run("python3", ["scripts/railway/apply-display-colours.py", "--country", "jp"]);
run("node", ["scripts/validation/validate-railway-topology.mjs", "--country", "jp", "--strict"]);
run("node", [
  "scripts/validation/validate-station-render-anchoring.mjs",
  "--country",
  "jp",
  "--strict",
]);
