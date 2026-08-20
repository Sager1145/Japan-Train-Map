// =========================================================================
//  app-live-refresh.js — the Server-Sent Events live-refresh listener
//
//  Subscribing to the server's store-changed stream, deciding whether an
//  event is ours or somebody else's, deferring a reload that arrives mid-
//  import, and replaying the newest deferred event afterwards. This was
//  §10 of app.js, which meant app-import.js depended on the entry point
//  purely to drain a deferred reload — the whole of that dependency cycle.
//
//  It is a self-contained concern: nothing here is part of booting, and the
//  boot sequence's only remaining involvement is calling
//  subscribeToStoreEvents() once.
// =========================================================================


// ---------------------------------------------------------------------------
// Live refresh: subscribe to the server's SSE stream and, when the saved store
// changes from another source, reload it, re-solve every route and re-render —
// no manual reload. We skip events we caused ourselves (origin === CLIENT_ID).
// EventSource auto-reconnects, so a server restart simply resumes the stream.
// ---------------------------------------------------------------------------
let storeEventSource = null;
let liveReloadPending = false;
// Detail of the newest deferred SSE event (so the catch-up reconcile acts on
// the latest state — e.g. a `cleared` event — instead of a stale one).
let liveReloadPendingDetail = null;

// Re-run the deferred live reload once the blocking work has finished. Called
// from every `importInProgress = false` site; previously an event deferred
// during a progressive import was silently dropped (the early return in
// handleExternalStoreChange skipped its own finally-block retry).
function drainPendingLiveReload() {
  if (!liveReloadPending) return;
  liveReloadPending = false;
  const next = liveReloadPendingDetail;
  liveReloadPendingDetail = null;
  setTimeout(() => handleExternalStoreChange(next || {}), 0);
}

function subscribeToStoreEvents() {
  if (!HAS_BACKEND) return; // static deploy: no /api/events endpoint to subscribe to
  if (typeof EventSource === "undefined") return; // very old browser: no live refresh
  try {
    storeEventSource = new EventSource(apiEndpointUrl("events"));
  } catch (err) {
    console.warn("Live-refresh unavailable; could not open SSE stream.", err);
    return;
  }

  storeEventSource.addEventListener("store-changed", (evt) => {
    let detail = {};
    try {
      detail = JSON.parse(evt.data || "{}");
    } catch (err) {
      /* ignore malformed payload */
    }
    // Ignore the echo of our own write.
    if (detail.origin && detail.origin === CLIENT_ID) return;
    // Each country has its own store; ignore changes to one we're not showing.
    if (detail.store && detail.store !== TRAIN_STORE_API) return;
    handleExternalStoreChange(detail);
  });

  storeEventSource.onerror = () => {
    // EventSource reconnects on its own; nothing to do but note it once.
  };
}

async function handleExternalStoreChange(detail) {
  // Re-check the event's target store at USE time, not only at receive time:
  // an event deferred below can be drained AFTER a country switch re-pointed
  // TRAIN_STORE_API, and acting on the OLD country's event then (worst case a
  // `cleared` event) would wrongly replace the NEW country's view.
  if (detail && detail.store && detail.store !== TRAIN_STORE_API) return;
  // If a progressive import is mid-flight, defer; drainPendingLiveReload()
  // catches up as soon as the import's finally-block clears importInProgress.
  if (importInProgress) {
    liveReloadPending = true;
    liveReloadPendingDetail = detail; // newest event wins
    return;
  }
  try {
    if (detail && detail.cleared) {
      // Store was cleared on the server: fall back to built-in defaults. A
      // recovery-mode session has nothing left to protect once the broken
      // store is gone, so normal (writable) behavior resumes.
      lastKnownServerStoreText = null;
      lastKnownServerStoreExists = false;
      exitStoreRecoveryMode();
      await replaceTrainStoreFromStoreProgressive(
        countryFallbackStore(),
        I18N.t("src.serverCleared"),
        { persistEachStep: false, finalPersist: false },
      );
      setStatus(els.importStatus, I18N.t("status.serverClearedFallback"), "warn");
      return;
    }
    const savedStore = await loadTrainStoreFromServer();
    // A recovery sentinel means the store on disk is (still) unloadable —
    // keep showing what we have rather than reloading a broken view.
    if (!savedStore || savedStore.recovery) return;
    const sourceLabel =
      detail && detail.source === "agent"
        ? I18N.t("src.agentImport")
        : I18N.t("src.otherUpdate");
    await replaceTrainStoreFromStoreProgressive(savedStore, sourceLabel, {
      // The server is already the source of truth — don't re-save (that would
      // echo back through SSE), and keep the user's current date selection.
      persistEachStep: false,
      finalPersist: false,
    });
    // Another source produced a store that loads cleanly — if this tab was in
    // read-only recovery, the danger has passed.
    exitStoreRecoveryMode();
    setStatus(
      els.importStatus,
      I18N.t("status.autoLoaded", { label: sourceLabel, count: savedStore.trains.length }),
      "ok",
    );
  } catch (err) {
    console.warn("Live reload after external store change failed.", err);
  } finally {
    // A change may have arrived while we were busy; reconcile once more
    // (with the NEWEST deferred detail, not this call's).
    drainPendingLiveReload();
  }
}
