// Shared Node-vm harness for replaying the frontend's classic-script family
// (the ordered app-*.js list in public/index.html) outside a browser.
// Consumers: scripts/precompute-train-parts.mjs (offline route export),
// test/app-family-smoke.test.mjs (runtime smoke tests) and
// scripts/check-undefined-globals.mjs (script-list extraction only).
//
// The stub surface below is the UNION of what all consumers need: an extra
// dummy-element property or I18N method is inert for a consumer that never
// touches it, so the union cannot change any consumer's behavior — while
// per-consumer copies of this harness had already drifted apart. Anything
// that MUST differ per consumer (indexedDB, an I18N recorder, identity
// strings) comes in through the makeSandbox options bag instead.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PUBLIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "public",
);

// The frontend is a family of ordered classic scripts sharing one global
// lexical scope. Replay EXACTLY the <script src> list from index.html — the
// single source of truth for load order — so every consumer stays in lockstep
// when app modules are added, removed, or reordered. The default filter keeps
// app-core.js and the app-*.js family and skips the browser-only libraries
// the sandbox stubs instead (vendor/maplibre, i18n*.js, rail-network.js,
// railmap*.js). A caller-supplied `filter` replaces both that selection and
// the app-family completeness guard (check-undefined-globals keeps EVERY root
// script that exists on disk, not just the app family).
export function readOrderedAppScripts({ filter } = {}) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) =>
    m[1].split(/[?#]/, 1)[0],
  );
  if (filter) return scripts.filter(filter);
  const appScripts = scripts.filter(
    (src) => !src.includes("/") && src.startsWith("app") && src.endsWith(".js"),
  );
  if (!appScripts.includes("app-core.js") || !appScripts.includes("app.js")) {
    throw new Error(
      "index.html's script list is missing app-core.js/app.js — cannot replay the app module family.",
    );
  }
  return appScripts;
}

// ---------------------------------------------------------------------------
// Browser stubs — the minimum surface the app family touches at module-eval
// time and on the replayed code paths. Dummy DOM elements swallow status
// writes.
// ---------------------------------------------------------------------------
export function makeDummyElement() {
  return {
    textContent: "",
    className: "",
    innerHTML: "",
    value: "",
    hidden: false,
    disabled: false,
    checked: false,
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    dataset: {},
    content: "",
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      return child;
    },
    removeChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    focus() {},
    click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
}

// Options:
//   userAgent  — navigator.userAgent, so sandbox errors identify their host.
//   fetchErrorMessage — thrown by the default fetch stub (tests replace fetch
//     per-case; the precompute driver must never reach the network).
//   indexedDB  — injected only when provided; the app family feature-detects
//     via `window.indexedDB` truthiness, so absence and undefined are
//     equivalent.
//   i18n       — merged over the base I18N stub (e.g. a recording onChange).
export function makeSandbox({
  userAgent = "node-vm",
  fetchErrorMessage = "fetch is not available in this sandbox",
  indexedDB,
  i18n,
} = {}) {
  const mediaStub = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    performance,
    URL,
    TextEncoder,
    TextDecoder,
    crypto: { randomUUID },
    navigator: { userAgent, maxTouchPoints: 0, language: "en" },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
      clear() {},
    },
    matchMedia: mediaStub,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    requestIdleCallback: (fn) => setTimeout(fn, 0),
    cancelIdleCallback() {},
    document: {
      hidden: false,
      documentElement: makeDummyElement(),
      body: makeDummyElement(),
      getElementById: () => makeDummyElement(),
      querySelector: () => makeDummyElement(),
      querySelectorAll: () => [],
      createElement: () => makeDummyElement(),
      createTextNode: () => makeDummyElement(),
      createDocumentFragment: () => makeDummyElement(),
      addEventListener() {},
      removeEventListener() {},
    },
    // Inert i18n surface; replayed code paths only pass strings through it.
    I18N: {
      t: (key) => String(key),
      placeName: (name) => String(name || ""),
      stationName: (name) => String(name || ""),
      trainName: (name) => String(name || ""),
      setStationReadings() {},
      setLang() {},
      applyStatic() {},
      lang: () => "zh-Hant",
      onChange() {},
    },
    RailMap: {},
    maplibregl: {},
    fetch: () => {
      throw new Error(fetchErrorMessage);
    },
  };
  if (indexedDB !== undefined) sandbox.indexedDB = indexedDB;
  if (i18n) Object.assign(sandbox.I18N, i18n);
  sandbox.location = { hash: "", href: "http://localhost/", pathname: "/" };
  sandbox.history = { replaceState() {}, pushState() {} };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.devicePixelRatio = 1;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

// Evaluate the (already ordered) scripts inside the context, sharing one
// global lexical scope exactly like sequential classic <script> tags.
export function evaluateAppScripts(context, scripts = readOrderedAppScripts()) {
  for (const name of scripts) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    vm.runInContext(source, context, { filename: name });
  }
}
