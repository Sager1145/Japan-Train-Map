import fs from "node:fs";

const logPath = process.argv[2];
if (!logPath) {
  throw new Error("usage: node report-test-failure.mjs <test-output.log>");
}

const output = fs.readFileSync(logPath, "utf8");
const marker = "✖ failing tests:";
const markerIndex = output.lastIndexOf(marker);
const usefulOutput = markerIndex >= 0 ? output.slice(markerIndex) : output;
const lines = usefulOutput.split(/\r?\n/);
const failures = lines
  .filter((line) => line.startsWith("✖ "))
  .map((line) => line.slice(2).trim());
const counts = lines.filter((line) => /^ℹ (tests|pass|fail) \d+$/.test(line));
const details = [
  ...counts,
  ...(failures.length > 0 ? failures : ["Test command failed without named failures."]),
].join("\n");
const encoded = details
  .replaceAll("%", "%25")
  .replaceAll("\r", "%0D")
  .replaceAll("\n", "%0A");

console.log(`::error title=Node test failures::${encoded}`);
