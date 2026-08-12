"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const EXPECTED_STYLES = [
  "styles/railprint-base.css",
  "styles/ios-presentation.css",
  "styles/solid-surfaces.css",
  "styles/device-layout.css",
];

test("stylesheet layers retain their behavior-defining cascade order", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)]
    .map((match) => match[1].split(/[?#]/, 1)[0])
    .filter((name) => name.startsWith("styles/"));

  assert.deepEqual(styles, EXPECTED_STYLES);
  assert.equal(fs.existsSync(path.join(PUBLIC_DIR, "styles.css")), false);
  for (const name of styles) {
    assert.equal(fs.existsSync(path.join(PUBLIC_DIR, name)), true, name);
  }
});

