// JRM_FLIGHTY_UI_REFACTOR_SPEC.md §2.2's navigation tree, asserted against the
// DOM that realises it.
//
// This is an ARCHITECTURE test, not a styling one. §2.2's rule — three content
// destinations, with Data Library and Settings reached as tasks — is the kind
// of decision that erodes one convenient exception at a time, and the erosion
// always looks locally reasonable ("Settings is only one more tab"). So the
// count is asserted rather than described.
//
// It reads the HTML as text rather than parsing it: the app ships no DOM
// implementation to the test runner, and the properties being checked are
// about which attributes EXIST, which is exactly what a text assertion can
// answer honestly.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const events = fs.readFileSync(
  new URL("../public/app-events.js", import.meta.url),
  "utf8",
);
const source = (name) =>
  fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const statsRender = source("app-stats-render.js");
const stats = source("app-stats.js");
const state = source("app-state.js");

// The body of a top-level function declaration, up to the next one.
function functionBody(code, name) {
  const start = code.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `no function ${name}`);
  const next = code.indexOf("\nfunction ", start + 1);
  return code.slice(start, next === -1 ? code.length : next);
}

function attributeValues(source, attribute) {
  return [
    ...source.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g")),
  ].map((match) => match[1]);
}

test("the web exposes exactly three primary workspaces, in §2.2's order", () => {
  assert.deepEqual(attributeValues(html, "data-workspace-target"), [
    "journeys",
    "network",
    "passport",
  ]);
});

test("Data Library and Settings are Utility destinations, never tabs", () => {
  const utilities = new Set(attributeValues(html, "data-utility-target"));
  assert.ok(utilities.has("data-manager"));
  assert.ok(utilities.has("display-settings"));
  // The failure this guards: adding a Utility back to the tab bar because it
  // is "used often enough".
  assert.doesNotMatch(html, /data-workspace-target="data-manager"/);
  assert.doesNotMatch(html, /data-workspace-target="display-settings"/);
});

test("every primary workspace owns at least one card", () => {
  const owned = attributeValues(html, "data-primary-workspace");
  for (const name of ["journeys", "network", "passport"]) {
    assert.ok(owned.includes(name), `no card claims the ${name} workspace`);
  }
});

test("both Utility cards mark themselves as such and can be closed", () => {
  for (const id of ["data-manager", "display-settings"]) {
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*data-utility-workspace`),
      `${id} is not marked as a Utility workspace`,
    );
  }
  // §4.1: closable without hunting for the navigation underneath.
  assert.ok(
    (html.match(/data-utility-close/g) || []).length >= 2,
    "each Utility needs its own way back",
  );
});

test("§16's event-binding ids survive the reorganisation", () => {
  // These ids are a contract between the DOM and app-events.js. §16 is
  // explicit that a visual change may not rename them, and this is the check
  // that makes "may not" enforceable.
  for (const id of [
    "train-browser",
    "train-editor",
    "mileage-stats",
    "data-manager",
    "display-settings",
    "search-input",
    "add-train",
    "save-fields",
    "stats-daily",
    "stats-headline",
    "stats-rows",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing id: ${id}`);
  }
});

test("the router knows three primary workspaces and two utilities", () => {
  assert.match(events, /const PRIMARY_WORKSPACES = \{/);
  const primary = events.slice(
    events.indexOf("const PRIMARY_WORKSPACES = {"),
    events.indexOf("const PRIMARY_WORKSPACE_NAMES"),
  );
  for (const name of ["journeys", "network", "passport"]) {
    assert.match(primary, new RegExp(`\\b${name}:`), `router lost ${name}`);
  }
  assert.match(
    events,
    /const UTILITY_WORKSPACES = \[\s*"data-manager",\s*"display-settings",?\s*\]/,
  );
});

test("the five-tab hashes still resolve, so old links do not dead-end", () => {
  const legacy = events.slice(
    events.indexOf("const LEGACY_WORKSPACE_HASHES"),
    events.indexOf("let activePrimaryWorkspace"),
  );
  assert.match(legacy, /"train-browser": "journeys"/);
  assert.match(legacy, /"train-editor": "journeys"/);
  assert.match(legacy, /"mileage-stats": "passport"/);
});

test("a hidden workspace leaves the accessibility tree, not just the screen", () => {
  // `hidden` alone only stops the mouse; without `inert` a keyboard reader
  // tabs into the Danger Zone of a Data Library nobody opened.
  const fn = events.slice(
    events.indexOf("function setWorkspaceCardVisible"),
    events.indexOf("function releaseFocusFrom"),
  );
  assert.match(fn, /card\.hidden = !visible/);
  assert.match(fn, /card\.inert = !visible/);
  assert.match(fn, /aria-hidden/);
});

test("Network and Passport carry the sections §5.2 and §5.3 require", () => {
  // Network: what region, what state the package is in, and a way to frame it.
  for (const id of [
    "network-workspace",
    "network-region-summary",
    "network-package-summary",
    "fit-complete-network",
    "network-show-all",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `Network is missing ${id}`);
  }
  // Passport: scope, coverage, statistics, journey log, replay/export.
  for (const id of [
    "passport-scope",
    "passport-coverage-map",
    "passport-journey-log",
    "passport-replay",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `Passport is missing ${id}`);
  }
});

test("§4.1: locating a selection and framing the network are two controls", () => {
  // One button that means either depending on the selection is a button whose
  // accessibility label is wrong half the time.
  assert.match(html, /id="fit-selected"/);
  assert.match(html, /id="fit-complete-network"/);
  assert.notEqual("fit-selected", "fit-complete-network");
});

test("§4.3's docked stop shows an identity and one action, not just the bar", () => {
  assert.match(html, /id="panel-docked-summary"/);
  assert.match(html, /id="panel-docked-title"/);
  assert.match(html, /id="panel-docked-action"/);
});

test("every new interface string is in the catalog, in all four languages", () => {
  const strings = fs.readFileSync(
    new URL("../public/i18n-strings.js", import.meta.url),
    "utf8",
  );
  const [shared, japanese] = (() => {
    // The header comment names JA_STRINGS too, so split on its DECLARATION.
    const split = strings.indexOf("const JA_STRINGS");
    assert.ok(split > 0, "i18n-strings.js no longer declares JA_STRINGS");
    return [strings.slice(0, split), strings.slice(split)];
  })();
  // zh-Hans is derived from zh at runtime by i18n.js, so a { zh, en } entry
  // plus a Japanese overlay entry IS all four languages.
  for (const key of [
    "nav.journeys",
    "nav.network",
    "nav.passport",
    "nav.dataLibrary",
    "nav.settings",
    "panel.docked",
    "panel.half",
    "panel.full",
    "btn.fitNetwork",
    "btn.showNetwork",
    "grp.journeyLog",
    "passport.scope",
  ]) {
    assert.match(shared, new RegExp(`"${key}":`), `no zh/en copy for ${key}`);
    assert.match(japanese, new RegExp(`"${key}":`), `no ja copy for ${key}`);
  }
});

// ── §5.3.4: the log opens the detail, it does not merely highlight a row ───

test("a Journey Log row opens the Journey Detail, not just a selection", () => {
  // The defect: the handler called selectTrain and stopped. `train-editor`
  // belongs to Journeys, so while Passport was on screen the detail it
  // "opened" stayed hidden and inert, and the reader was left looking at a log
  // where one row had changed colour.
  const handler = events.slice(
    events.indexOf('getElementById("passport-journey-log")'),
    events.indexOf('getElementById("passport-scope")'),
  );
  assert.match(handler, /openJourneyDetail\(/);
  assert.doesNotMatch(handler, /selectTrain\(/);

  const open = functionBody(events, "openJourneyDetail");
  assert.match(open, /selectTrain\(id/);
  // The destination that OWNS the detail — §5.3.4 forbids a Passport-only copy.
  assert.match(open, /setActivePrimaryWorkspace\("journeys"/);
  assert.match(open, /train-editor/);
});

// ── §5.3.1: Passport reports on its own scope ─────────────────────────────

test("Passport's date scope is a value of its own, not the journeys filter", () => {
  // "Passport 的日期 Scope 独立于 Journeys 筛选，切换后不扰动旅程列表."
  // Sharing `selectedDate` meant opening a journey from the log re-scoped the
  // statistics above it on the way past, because selecting a record jumps the
  // journeys filter to that record's own date.
  assert.match(state, /let passportScopeDate = ALL_DATES;/);

  // The statistics job's day aggregate.
  const daily = stats.slice(
    stats.indexOf("let daily = null;"),
    stats.indexOf("return { overall, daily"),
  );
  assert.match(daily, /passportScopeDate !== ALL_DATES/);
  assert.doesNotMatch(daily, /selectedDate/);

  // The log below it, over the same scope.
  const log = functionBody(statsRender, "renderPassportJourneyLog");
  assert.match(log, /passportScopeDate === ALL_DATES/);
  assert.doesNotMatch(log, /selectedDate/);
});

test("the Passport scope is a control, not a read-only label", () => {
  // §5.3.1 draws it as [ALL-TIME] [date] [date] …, and a scope that can be
  // read but not changed is not a scope.
  const scope = functionBody(statsRender, "renderPassportScope");
  assert.match(scope, /data-passport-scope=/);
  assert.match(scope, /ALL_DATES/);
  assert.match(events, /\[data-passport-scope\]/);
  assert.match(events, /setPassportScopeDate\(/);
  // Changing it must not touch the journeys list, the map or the editor.
  const setter = functionBody(statsRender, "setPassportScopeDate");
  for (const forbidden of [
    "renderTrainList",
    "renderDateButtons",
    "renderTrainLayers",
    "renderEditor",
    "selectedDate",
  ])
    assert.ok(!setter.includes(forbidden), `the scope switch calls ${forbidden}`);
});

// ── §4.1: a Utility hands back everything it took ─────────────────────────

test("closing a Utility restores the detent and the scroll offset", () => {
  // "Data/Settings 被关闭后必须返回原 Tab、原导航路径与原滚动位置." Opening one
  // raises the panel to full and resets the offset to zero, so "nothing to
  // restore" was only ever true of the tab.
  const open = functionBody(events, "openUtilityWorkspace");
  assert.match(open, /utilityReturnState = \{/);
  assert.match(open, /panelState: sidebarPanelState/);
  assert.match(open, /rememberWorkspaceScroll\(\)/);

  const close = functionBody(events, "closeUtilityWorkspace");
  assert.match(close, /setSidebarPanelState\(returning\.panelState\)/);

  // And the workspace switch itself no longer discards every offset.
  const activate = functionBody(events, "setActivePrimaryWorkspace");
  assert.match(activate, /restoreWorkspaceScroll\(name\)/);
  assert.doesNotMatch(activate, /if \(sidebar\) sidebar\.scrollTop = 0;\n  resetWorkspaceDocumentScroll/);
});

test("§4.1: each destination keeps its own scroll offset across a tab switch", () => {
  assert.match(events, /const workspaceScrollOffsets = new Map\(\)/);
  const remember = functionBody(events, "rememberWorkspaceScroll");
  assert.match(remember, /workspaceScrollOffsets\.set\(currentPrimaryWorkspace\(\)/);
});

// ── §4.3 and §9.3: the panel's three stops, and how it reaches them ───────

test("§4.3: a narrow screen has no fourth, hidden panel state", () => {
  // The stored flag belongs to the DESKTOP drawer and is shared storage: a
  // reader who closed the drawer on a laptop was opening the phone onto an
  // invisible detent with no grabber left to bring anything back.
  const visible = functionBody(events, "setSidebarVisible");
  assert.match(visible, /if \(sidebarUsesVerticalDrag\(\)\) visible = true;/);
  // And mobile must not write that key either, or it overwrites the desktop
  // preference the next time the same profile opens the app on a phone.
  assert.match(visible, /persist && !sidebarUsesVerticalDrag\(\)/);
  const boot = events.slice(
    events.indexOf("function setupSidebarToggle"),
    events.indexOf('tab.addEventListener("click"'),
  );
  assert.match(
    boot,
    /sidebarVisible =\s*sidebarUsesVerticalDrag\(\) \|\|/,
  );
});

test("§9.3: the release hands its velocity to the settle", () => {
  // Two halves. The velocity has to be MEASURABLE — a flick short enough to
  // produce one pointermove used to have a single sample and report zero — and
  // it then has to reach the animation instead of being thrown away for a
  // fixed curve that always starts from rest.
  assert.match(events, /samples: \[\{ size: startSize, time: performance\.now\(\) \}\]/);
  assert.match(
    events,
    /drag\.samples\.push\(\{ size: drag\.currentSize, time: performance\.now\(\) \}\)/,
  );
  assert.match(events, /release: \{\s*fromSize: drag\.currentSize,\s*velocity: panelReleaseVelocity\(drag\.samples\),/);
  const settle = functionBody(events, "applyPanelSettleMotion");
  assert.match(settle, /panelSettleMotion\(/);
  assert.match(settle, /transitionTimingFunction = easing/);
  // Not while the reader has asked for less motion.
  assert.match(settle, /REDUCED_MOTION_MEDIA\.matches/);
});
