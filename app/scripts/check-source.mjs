import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".perf-backup"]);
const checked = { javascript: 0, json: 0, references: 0 };

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath));
    else files.push(entryPath);
  }
  return files;
}

function checkJavaScript(filePath) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    throw new Error(`JavaScript syntax check failed: ${filePath}`);
  }
  checked.javascript += 1;
}

function checkJson(filePath) {
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`JSON validation failed: ${filePath}\n${err.message}`);
  }
  checked.json += 1;
}

function checkHtmlReferences(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const reference = match[1];
    if (
      reference.startsWith("#") ||
      reference.startsWith("api/") ||
      /^[a-z]+:/i.test(reference) ||
      reference.startsWith("//")
    ) {
      continue;
    }
    const localPath = reference.split(/[?#]/, 1)[0];
    if (!fs.existsSync(path.resolve(path.dirname(filePath), localPath))) {
      throw new Error(
        `Missing local asset referenced by ${filePath}: ${reference}`,
      );
    }
    checked.references += 1;
  }
}

for (const filePath of walk(APP_DIR)) {
  if (filePath.endsWith(".gz")) continue;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".js" || extension === ".mjs") {
    checkJavaScript(filePath);
  } else if (extension === ".json") {
    checkJson(filePath);
  }
}

checkHtmlReferences(path.join(APP_DIR, "public", "index.html"));

console.log(
  `Source checks passed: ${checked.javascript} JavaScript files, ` +
    `${checked.json} JSON files, ${checked.references} local HTML references.`,
);
