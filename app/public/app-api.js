// =========================================================================
//  app-api.js — the backend API client
//
//  URL construction, the HAS_BACKEND capability flag, the per-tab client id
//  and the two fetch helpers used to be declared in app.js. That made
//  app-events.js, app-import.js and app-persistence.js depend on the boot
//  spine purely to ask "is there a backend?" and "what is this URL?" —
//  questions that have nothing to do with booting.
//
//  This file is a leaf: it reads window.APP_RUNTIME_CONFIG (published by
//  runtime-config.js, the one artifact the static build rewrites) and
//  depends on no other app module. app-config.js, which loads next, may
//  call apiResourceUrl at runtime.
//
//  What did NOT move: loading the datasets themselves. app.js still owns
//  railSectionsGeoJson and friends, because owning the fetch verbs is a
//  different job from owning the data they return.
// =========================================================================

// Document-relative (not root-absolute) so every API call — including the
// train-store save/load — resolves next to index.html. This keeps the app
// working when it is served from a sub-path (e.g. behind a reverse proxy at
// /something/) instead of only from the domain root.
const API_BASE = "./api";
const APP_RUNTIME_CONFIG = window.APP_RUNTIME_CONFIG || {
  hasBackend: true,
  apiFileSuffix: "",
};
// True on the Node/Express deployment, whose backend answers the write/live
// endpoints — /api/events (SSE live-refresh) and PUT/DELETE /api/train-store
// (server autosave / clear). The GitHub Pages STATIC build has no backend, so
// the deploy workflow rewrites this line to `false`; the app then skips those
// backend-only calls instead of firing requests that 404 on a static host. The
// read-only dataset/seed GETs (fetchJson, loadTrainStoreFromServer) are served
// as plain files on Pages and stay enabled either way. Local-file save/load via
// the File System Access API is independent of this flag.
const HAS_BACKEND = APP_RUNTIME_CONFIG.hasBackend !== false;
function apiResourceUrl(path) {
  return `${API_BASE}/${path}${APP_RUNTIME_CONFIG.apiFileSuffix || ""}`;
}
function apiEndpointUrl(path) {
  return `${API_BASE}/${path}`;
}
// A per-tab id sent with every store write (X-Client-Id). The server echoes it
// in the SSE "store-changed" event so this tab can ignore the write it just
// made and only react to changes from *other* sources (another tab, or an AI
// agent calling /api/agent/import).
const CLIENT_ID =
  (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
  `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const fetchJson = async (path, options) => {
  // Use the browser's default HTTP cache. The server sends a weak ETag +
  // Cache-Control: max-age on every dataset, so reloads revalidate to a 304 (or
  // serve straight from cache within max-age) instead of re-downloading the full
  // multi-MB payload. The old `cache: "no-store"` defeated all of that.
  const res = await fetch(apiResourceUrl(path), options);
  if (!res.ok)
    throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
  return res.json();
};
// Same request semantics as fetchJson but returns the raw text WITHOUT the
// atomic native JSON.parse. Used for rail-sections so its ~1.1 s parse can be
// deferred and chunked (see parseFeatureCollectionChunked / ensureRailSectionsLoaded)
// instead of blocking the main thread the instant the 12 MB body arrives.
const fetchText = async (path) => {
  const res = await fetch(apiResourceUrl(path));
  if (!res.ok)
    throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
  return res.text();
};
