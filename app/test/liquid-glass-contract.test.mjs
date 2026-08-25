// JRM_FLIGHTY_UI_REFACTOR_SPEC.md §1.1, §4.2, §6.5 and §10.5 — the material
// policy, as a regression guard.
//
// This exists because of a specific past decision that has to stay reversed.
// `styles/solid-surfaces.css` used to open with
//
//     backdrop-filter: none !important;
//
// applied to every floating surface in the app. §1.1 requires the opposite —
// "iOS 26/27 使用系统 Liquid Glass 的默认取色、折射与交互表现" — and the web
// side is asked for the same behaviour in the same materials. A global
// `!important` off-switch is the one edit that silently undoes the whole
// §6.5 surface system while every other rule still reads as if it worked, so
// it is checked rather than remembered.
//
// The test does NOT assert that any particular element is glass. It asserts
// the three properties that make the policy honest: no global kill switch,
// a real fallback where the browser cannot blur, and the accessibility
// preferences honoured.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const STYLE_DIR = new URL("../public/styles/", import.meta.url);

function readStyle(name) {
  return fs.readFileSync(new URL(name, STYLE_DIR), "utf8");
}

// Declarations only. A comment that QUOTES the forbidden rule — as
// solid-surfaces.css now does, to say what it must never do again — is
// documentation, not a declaration, and matching it would make the file
// unable to explain itself.
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const surfaces = readStyle("solid-surfaces.css");
const STYLESHEETS = [
  "railprint-base.css",
  "ios-presentation.css",
  "solid-surfaces.css",
  "device-layout.css",
];
const allDeclarations = STYLESHEETS.map((name) =>
  withoutComments(readStyle(name)),
).join("\n");

test("no stylesheet disables material globally", () => {
  // The exact edit this file exists to prevent.
  assert.doesNotMatch(
    allDeclarations,
    /backdrop-filter:\s*none\s*!important/,
    "a global `backdrop-filter: none !important` is back",
  );
  assert.doesNotMatch(
    allDeclarations,
    /-webkit-backdrop-filter:\s*none\s*!important/,
    "a global `-webkit-backdrop-filter: none !important` is back",
  );
});

test("the floating functional layer is given a material", () => {
  // §4.2: the panel, the navigation and the map's corner controls are the
  // floating functional layer, and it is what carries the material.
  const glassBlock = surfaces.slice(
    surfaces.indexOf("#sidebar,"),
    surfaces.indexOf("/* Chrome the map library creates"),
  );
  for (const selector of ["#sidebar", ".workspace-nav", ".sidebar-edge-tab"]) {
    assert.ok(
      glassBlock.includes(selector),
      `${selector} is not in the material layer`,
    );
  }
  assert.match(glassBlock, /backdrop-filter: var\(--jrm-glass-blur\)/);
});

test("material is defined as tokens, not as a colour repeated per rule", () => {
  assert.match(surfaces, /--jrm-glass-background:/);
  assert.match(surfaces, /--jrm-glass-background-strong:/);
  assert.match(surfaces, /--jrm-glass-blur:/);
  assert.match(surfaces, /--jrm-glass-border:/);
});

test("where the browser cannot blur, the surface goes opaque", () => {
  // A translucent panel with no blur behind it is a map showing through text.
  assert.match(
    surfaces,
    /@supports not \(\s*\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\s*\)/,
  );
});

test("§10.5: Reduced Transparency removes the material rather than dimming it", () => {
  assert.match(surfaces, /@media \(prefers-reduced-transparency: reduce\)/);
  const block = surfaces.slice(
    surfaces.indexOf("@media (prefers-reduced-transparency: reduce)"),
    surfaces.indexOf("@media (prefers-contrast: more)"),
  );
  assert.match(block, /backdrop-filter: none/);
  assert.match(block, /background: var\(--ios-material-strong\)/);
});

test("§10.5: More Contrast gives an opaque surface and a real border", () => {
  assert.match(surfaces, /@media \(prefers-contrast: more\)/);
  const start = surfaces.indexOf("@media (prefers-contrast: more)");
  const block = surfaces.slice(start, start + 900);
  assert.match(block, /background: var\(--ios-system-background\)/);
  assert.match(block, /border: 2px solid var\(--ios-label\)/);
});

test("§4.2: content cards are NOT given a material of their own", () => {
  // "Liquid Glass 或 Web translucent material 用于系统导航、悬浮功能层与菜单
  // 外壳，不逐张铺满内部内容卡片." Two stacked translucent surfaces is the one
  // thing §4.2 forbids outright, and a blurred card inside a blurred panel is
  // exactly that stack.
  for (const rule of [
    /\.card[^{]*\{[^}]*backdrop-filter:\s*(?!none)/,
    /\.train-card[^{]*\{[^}]*backdrop-filter:\s*(?!none)/,
    /\.stat-row[^{]*\{[^}]*backdrop-filter:\s*(?!none)/,
  ]) {
    assert.doesNotMatch(allDeclarations, rule);
  }
});

test("§1.1: no fixed pure black underneath the material", () => {
  // "不得把 Color.black、#000000、#0B0B0F 等固定纯黑值作为 App 主背景或
  // Flighty 风格捷径." The glass is mixed FROM --ios-system-background (see
  // --jrm-glass-background), so a pure black there is not merely a background
  // token — it is the colour of every floating surface in the dark appearance.
  const base = withoutComments(readStyle("railprint-base.css"));
  const dark = base.slice(base.indexOf('html[data-theme="dark"]'));
  assert.ok(dark.length > 0, "the dark appearance block is gone");
  for (const token of [
    "--ios-system-background",
    "--ios-grouped-background",
    "--ios-secondary-background",
    "--ios-secondary-grouped-background",
  ]) {
    const value = new RegExp(`${token}:\\s*([^;]+);`).exec(dark);
    assert.ok(value, `${token} is not defined for the dark appearance`);
    assert.doesNotMatch(
      value[1].trim(),
      /^(#000|#000000|black|#0b0b0f)$/i,
      `${token} is a fixed pure black`,
    );
  }
});

test("§1.1: the browser chrome matches the page, and is not black either", () => {
  // Two files write this meta tag — the boot script, before the stylesheet
  // exists, and the display settings module afterwards — so they are checked
  // together. They disagreed with the page itself as well as with §1.1: a
  // #000000 chrome framed a #1c1c1e app.
  const html = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  const settings = fs.readFileSync(
    new URL("../public/app-display-settings.js", import.meta.url),
    "utf8",
  );
  const base = withoutComments(readStyle("railprint-base.css"));
  const dark = base.slice(base.indexOf('html[data-theme="dark"]'));
  const grouped = /--ios-grouped-background:\s*([^;]+);/.exec(dark)[1].trim();
  for (const [name, source] of [
    ["index.html", html],
    ["app-display-settings.js", settings],
  ]) {
    const written = [...source.matchAll(/theme-color[\s\S]{0,400}?"(#[0-9a-fA-F]{3,8})"/g)]
      .map((match) => match[1].toLowerCase());
    assert.ok(written.length > 0, `${name} no longer writes theme-color`);
    assert.ok(
      written.includes(grouped.toLowerCase()),
      `${name} does not paint the chrome the page's own colour`,
    );
    for (const colour of written)
      assert.notEqual(colour, "#000000", `${name} still writes a pure black`);
  }
});

test("the cascade order this policy depends on is unchanged", () => {
  // solid-surfaces.css owns the material and must still load after the two
  // layers it overrides, and before the layout layer that owns geometry.
  const html = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  const order = [...html.matchAll(/href="(styles\/[^"?]+)/g)].map((m) => m[1]);
  assert.deepEqual(order, [
    "styles/railprint-base.css",
    "styles/ios-presentation.css",
    "styles/solid-surfaces.css",
    "styles/device-layout.css",
  ]);
});
