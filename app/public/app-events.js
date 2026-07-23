// =========================================================================
//  app-events.js — §22: event binding (all sidebar / editor / map UI event handlers)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §22.  Event binding (all sidebar / editor / map UI event handlers)
// =========================================================================

// =========================================================================
//  Workspace tabs — the sidebar nav pills switch EXCLUSIVE panels (railprint
//  TabBar behavior) instead of scrolling one long column. Every card stays in
//  the DOM (display:none only), so all JS bindings keep working while hidden.
// =========================================================================
const SIDEBAR_VISIBILITY_KEY = "n02-train-manager-sidebar-visible-v1";
let sidebarVisible = true;
let sidebarToggleReady = false;
let sidebarMapPaddingRaf = null;
let sidebarPendingMapSize = null;
let sidebarWindowResizeTimer = null;
let sidebarDragState = null;
let suppressSidebarClick = false;

function sidebarUsesVerticalDrag() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function sidebarFullSize() {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) {
    const rect = sidebar.getBoundingClientRect();
    const measured = sidebarUsesVerticalDrag() ? rect.height : rect.width;
    if (measured > 0) return measured;
  }
  return sidebarUsesVerticalDrag()
    ? Math.max(1, window.innerHeight * 0.58)
    : 480;
}

function sidebarViewportPadding(size = sidebarVisible ? sidebarFullSize() : 0) {
  const safeSize = Math.max(0, Number(size) || 0);
  return sidebarUsesVerticalDrag()
    ? { top: 0, right: 0, bottom: safeSize, left: 0 }
    : { top: 0, right: 0, bottom: 0, left: safeSize };
}

// Returns the EFFECTIVE animation duration (0 when the padding was applied
// instantly) so callers know whether to defer padding-dependent work — the
// Japan zoom/bounds constraints read the resting padding and must recompute
// only after it lands (see setSidebarVisible).
function applySidebarMapPadding(size, durationMs = 0) {
  if (!map) return 0;
  const padding = sidebarViewportPadding(size);
  const duration =
    REDUCED_MOTION_MEDIA.matches ? 0 : Math.max(0, Number(durationMs) || 0);
  if (duration && typeof map.easeTo === "function") {
    map.easeTo({
      padding,
      duration,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      essential: true,
    });
    return duration;
  }
  if (typeof map.setPadding === "function") {
    map.setPadding(padding);
  } else if (typeof map.jumpTo === "function") {
    map.jumpTo({ padding });
  }
  return 0;
}

function scheduleSidebarMapPadding(size) {
  sidebarPendingMapSize = size;
  if (sidebarMapPaddingRaf) return;
  sidebarMapPaddingRaf = requestAnimationFrame(() => {
    sidebarMapPaddingRaf = null;
    const nextSize = sidebarPendingMapSize;
    sidebarPendingMapSize = null;
    applySidebarMapPadding(nextSize, 0);
  });
}

function cancelScheduledSidebarMapPadding() {
  if (sidebarMapPaddingRaf) {
    cancelAnimationFrame(sidebarMapPaddingRaf);
    sidebarMapPaddingRaf = null;
  }
  sidebarPendingMapSize = null;
}

function updateSidebarToggleLabel() {
  const tab = document.getElementById("sidebar-edge-tab");
  if (!tab) return;
  const label = I18N.t(sidebarVisible ? "menu.hide" : "menu.show");
  tab.setAttribute("aria-expanded", sidebarVisible ? "true" : "false");
  tab.setAttribute("aria-label", label);
  tab.title = label;
}

function setSidebarVisible(visible, { persist = true, animate = true } = {}) {
  const app = document.getElementById("app");
  if (!app) return;
  sidebarVisible = Boolean(visible);
  app.classList.toggle("sidebar-collapsed", !sidebarVisible);
  document.documentElement.dataset.sidebar = sidebarVisible
    ? "expanded"
    : "collapsed";
  app.style.removeProperty("--sidebar-size");
  const sidebar = document.getElementById("sidebar");
  if (sidebar) {
    // pointer-events:none (CSS) only blocks the mouse — a collapsed drawer
    // must also leave the tab order and the accessibility tree. `inert`
    // covers both; aria-hidden is kept in sync for engines without inert
    // support. Rescue focus first so it is never trapped inside an inert
    // subtree (the edge tab is a SIBLING of #sidebar, so it stays usable).
    if (!sidebarVisible && sidebar.contains(document.activeElement)) {
      const tab = document.getElementById("sidebar-edge-tab");
      if (tab && typeof tab.focus === "function") tab.focus();
      else if (
        document.activeElement &&
        typeof document.activeElement.blur === "function"
      )
        document.activeElement.blur();
    }
    sidebar.inert = !sidebarVisible;
    if (sidebarVisible) sidebar.removeAttribute("aria-hidden");
    else sidebar.setAttribute("aria-hidden", "true");
  }
  updateSidebarToggleLabel();
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_VISIBILITY_KEY, sidebarVisible ? "1" : "0");
    } catch (_) {}
  }
  cancelScheduledSidebarMapPadding();
  const easedMs = applySidebarMapPadding(
    sidebarVisible ? sidebarFullSize() : 0,
    animate ? 320 : 0,
  );
  // The resting padding (the uncovered viewport) just changed, so the Japan
  // minZoom/maxBounds envelope is stale — e.g. booting collapsed and then
  // expanding left minZoom too high to frame Japan beside the sidebar.
  // Recompute after the padding ease lands (its easeTo ends in a moveend;
  // an interrupted ease also fires moveend, and the recompute is idempotent).
  if (map) {
    if (easedMs > 0 && typeof map.once === "function")
      map.once("moveend", () => applyJapanMapConstraints());
    else applyJapanMapConstraints();
  }
}

function setupSidebarToggle() {
  if (sidebarToggleReady) return;
  const app = document.getElementById("app");
  const tab = document.getElementById("sidebar-edge-tab");
  if (!app || !tab) return;
  sidebarToggleReady = true;
  try {
    sidebarVisible = localStorage.getItem(SIDEBAR_VISIBILITY_KEY) !== "0";
  } catch (_) {
    sidebarVisible = true;
  }
  setSidebarVisible(sidebarVisible, { persist: false, animate: false });

  tab.addEventListener("click", (event) => {
    if (suppressSidebarClick) {
      suppressSidebarClick = false;
      event.preventDefault();
      return;
    }
    setSidebarVisible(!sidebarVisible);
  });

  tab.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const vertical = sidebarUsesVerticalDrag();
    const fullSize = sidebarFullSize();
    sidebarDragState = {
      pointerId: event.pointerId,
      vertical,
      fullSize,
      startX: event.clientX,
      startY: event.clientY,
      startSize: sidebarVisible ? fullSize : 0,
      currentSize: sidebarVisible ? fullSize : 0,
      moved: false,
      detachWindowFallback: null,
    };
    app.classList.add("sidebar-dragging");
    app.style.setProperty("--sidebar-size", `${sidebarDragState.startSize}px`);
    let captured = false;
    try {
      tab.setPointerCapture(event.pointerId);
      captured =
        typeof tab.hasPointerCapture !== "function" ||
        tab.hasPointerCapture(event.pointerId);
    } catch (_) {}
    if (!captured) {
      // Without capture, a release outside the tab never reaches the tab's
      // own pointerup/pointermove listeners — the drag would keep the
      // sidebar-dragging class, the inline --sidebar-size and a partial map
      // padding forever. Drive this drag from window-level events instead.
      const drag = sidebarDragState;
      const onWindowMove = (moveEvent) => {
        if (sidebarDragState !== drag) return;
        if (moveEvent.pointerId !== drag.pointerId) return;
        // A mouse released OUTSIDE the window sends no pointerup at all;
        // the first move back inside arrives with no buttons pressed.
        if (moveEvent.buttons === 0) return finishDrag(moveEvent);
        handleDragMove(moveEvent);
      };
      const onWindowUp = (upEvent) => finishDrag(upEvent);
      const onWindowCancel = (cancelEvent) => finishDrag(cancelEvent, true);
      window.addEventListener("pointermove", onWindowMove);
      window.addEventListener("pointerup", onWindowUp);
      window.addEventListener("pointercancel", onWindowCancel);
      drag.detachWindowFallback = () => {
        window.removeEventListener("pointermove", onWindowMove);
        window.removeEventListener("pointerup", onWindowUp);
        window.removeEventListener("pointercancel", onWindowCancel);
      };
    }
  });

  const handleDragMove = (event) => {
    const drag = sidebarDragState;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rawDelta = drag.vertical
      ? drag.startY - event.clientY
      : event.clientX - drag.startX;
    if (Math.abs(rawDelta) > 3) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    drag.currentSize = Math.max(
      0,
      Math.min(drag.fullSize, drag.startSize + rawDelta),
    );
    app.style.setProperty("--sidebar-size", `${drag.currentSize}px`);
    scheduleSidebarMapPadding(drag.currentSize);
  };
  tab.addEventListener("pointermove", handleDragMove);

  const finishDrag = (event, cancelled = false) => {
    const drag = sidebarDragState;
    if (!drag || drag.pointerId !== event.pointerId) return;
    sidebarDragState = null;
    if (drag.detachWindowFallback) drag.detachWindowFallback();
    try {
      if (tab.hasPointerCapture(event.pointerId))
        tab.releasePointerCapture(event.pointerId);
    } catch (_) {}
    app.classList.remove("sidebar-dragging");
    if (drag.moved && !cancelled) {
      // A little under halfway feels deliberate while still making it easy to
      // pull a completely hidden menu back into view from the edge tab.
      const nextVisible = drag.currentSize >= drag.fullSize * 0.42;
      suppressSidebarClick = true;
      setTimeout(() => {
        suppressSidebarClick = false;
      }, 0);
      setSidebarVisible(nextVisible);
    } else {
      app.style.removeProperty("--sidebar-size");
      cancelScheduledSidebarMapPadding();
      applySidebarMapPadding(sidebarVisible ? sidebarFullSize() : 0, 0);
    }
  };
  tab.addEventListener("pointerup", (event) => finishDrag(event));
  tab.addEventListener("pointercancel", (event) => finishDrag(event, true));
  // Fires right after a normal pointerup too — by then finishDrag has already
  // consumed the state and this is a no-op. It only acts when the browser
  // takes the capture away mid-drag (element detached, OS gesture, …), where
  // it restores the pre-drag state instead of leaving the drag stuck.
  tab.addEventListener("lostpointercapture", (event) =>
    finishDrag(event, true),
  );

  window.addEventListener("resize", () => {
    if (sidebarDragState) {
      const drag = sidebarDragState;
      sidebarDragState = null;
      if (drag.detachWindowFallback) drag.detachWindowFallback();
      app.classList.remove("sidebar-dragging");
      app.style.removeProperty("--sidebar-size");
    }
    clearTimeout(sidebarWindowResizeTimer);
    sidebarWindowResizeTimer = setTimeout(() => {
      sidebarWindowResizeTimer = null;
      // Padding BEFORE resize: crossing the 900px breakpoint flips the drawer
      // axis (left ↔ bottom padding), and map.resize() fires the 'resize'
      // handler that recomputes the Japan constraints — it must read the new
      // footprint, not the stale one.
      applySidebarMapPadding(sidebarVisible ? sidebarFullSize() : 0, 0);
      if (map && typeof map.resize === "function") map.resize();
    }, 80);
  });
}

const WORKSPACE_TABS = [
  "train-browser",
  "train-editor",
  "mileage-stats",
  "data-manager",
  "display-settings",
];

function setActiveWorkspaceTab(tabId, { updateHash = true } = {}) {
  if (!WORKSPACE_TABS.includes(tabId)) tabId = WORKSPACE_TABS[0];
  document
    .querySelectorAll("#sidebar > .card, #sidebar > details.card")
    .forEach((card) => {
      card.classList.toggle("tab-hidden", card.id !== tabId);
    });
  document.querySelectorAll(".workspace-nav a").forEach((a) => {
    const target = (a.getAttribute("href") || "").slice(1);
    const active = target === tabId;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  // A collapsible card IS its whole tab — open it when its tab is shown.
  const panel = document.getElementById(tabId);
  if (panel && panel.tagName === "DETAILS") panel.open = true;
  if (updateHash && location.hash !== "#" + tabId)
    history.replaceState(null, "", "#" + tabId);
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.scrollTop = 0;
  // Compute the mileage stats lazily, the first time (and only when) the 統計
  // tab is actually opened — scheduleMileageStats() otherwise skips while the
  // panel is hidden, so the 12 MB rail-sections parse it needs never lands on
  // the boot path. Guarded by typeof because setActiveWorkspaceTab() also runs
  // at module-parse time, before scheduleMileageStats is defined.
  if (tabId === "mileage-stats" && typeof scheduleMileageStats === "function")
    scheduleMileageStats();
}

let _workspaceTabsReady = false;
function setupWorkspaceTabs() {
  if (_workspaceTabsReady) return; // called eagerly at parse AND from bindEvents
  const nav = document.querySelector(".workspace-nav");
  if (!nav) return;
  _workspaceTabsReady = true;
  nav.addEventListener("click", (ev) => {
    const link = ev.target.closest("a");
    if (!link) return;
    ev.preventDefault();
    setActiveWorkspaceTab((link.getAttribute("href") || "").slice(1));
  });
  window.addEventListener("hashchange", () =>
    setActiveWorkspaceTab(location.hash.slice(1), { updateHash: false }),
  );
  setActiveWorkspaceTab(location.hash.slice(1) || WORKSPACE_TABS[0], {
    updateHash: false,
  });
}
// The tab chrome needs only the static DOM — activate it immediately so the
// panels behave as tabs during the (seconds-long) data load too. bindEvents()
// calls it again later, which the guard turns into a no-op.
setupSidebarToggle();
setupWorkspaceTabs();

function bindEvents() {
  setupDisplaySettingsPanel();
  setupWorkspaceTabs();
  // Re-render every dynamically-built UI string when the language changes.
  // (Static [data-i18n] DOM is handled by I18N.applyStatic; this covers the
  // JS-generated bits: display-panel labels, the focus button, the date bar,
  // train list/cards, editor, import target and the on-map labels.)
  if (window.I18N && typeof I18N.onChange === "function") {
    I18N.onChange(() => {
      updateThemeSelect();
      updateSidebarToggleLabel();
      DISPLAY_CONTROLS.forEach((cfg) => {
        if (cfg._name) cfg._name.textContent = I18N.t(cfg.labelKey);
      });
      DISPLAY_TOGGLES.forEach((cfg) => {
        if (cfg._span) cfg._span.textContent = I18N.t(cfg.labelKey);
      });
      updateFitCurveRebuildButton();
      updateFocusZoomButton();
      updateDataSourceUi();
      // renderAll() -> renderTrainLayers -> renderTrainMarkers already re-runs
      // updateEndpointLabels(), so no separate call is needed here.
      renderAll();
    });
  }
  document
    .getElementById("add-train")
    .addEventListener("click", () => addTrain());
  document
    .getElementById("duplicate-train")
    .addEventListener("click", () => duplicateTrain(selectedTrainId));
  document.getElementById("delete-train").addEventListener("click", async () => {
    if (
      selectedTrainId &&
      (await uiConfirm(I18N.t("confirm.deleteTrain"), { danger: true }))
    )
      deleteTrain(selectedTrainId);
  });
  document
    .getElementById("delete-all-trains")
    .addEventListener("click", async () => {
      if (
        trainStore.trains.length &&
        (await uiConfirm(I18N.t("confirm.deleteAll"), { danger: true }))
      ) {
        deleteAllTrains();
        setStatus(els.jsonStatus, I18N.t("status.allDeleted"), "warn");
      }
    });
  document
    .getElementById("fit-selected")
    .addEventListener("click", () => fitTrainBounds(getTrain()));
  document.getElementById("clear-selection").addEventListener("click", () => {
    selectedTrainId = null;
    focusedTrainId = null;
    renderAll();
  });
  document
    .getElementById("save-fields")
    .addEventListener("click", saveSelectedFields);
  document
    .getElementById("toggle-visible")
    .addEventListener("click", () => toggleTrainVisibility(selectedTrainId));
  document
    .getElementById("move-up")
    .addEventListener("click", () => moveTrain(selectedTrainId, -1));
  document
    .getElementById("move-down")
    .addEventListener("click", () => moveTrain(selectedTrainId, 1));
  document
    .getElementById("add-stop")
    .addEventListener("click", addStopToSelected);
  document
    .getElementById("rebuild-route")
    .addEventListener("click", rebuildSelectedRoute);
  document
    .getElementById("open-local-json")
    .addEventListener("click", async () => {
      try {
        fitJapanMainIslands();
        setImportProgress(0, 1, I18N.t("prog.openingLocal"));
        await openLocalJsonFile();
        // Opening a local file replaces the store; persist it to the server now.
        await flushServerStoreSave();
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      }
    });
  // Shared by the "保存／另存 JSON" and "下載 JSON" buttons — the two handlers
  // were byte-for-byte identical, so they now literally share one function.
  const saveLocalJsonHandler = async () => {
    try {
      await writeLocalJsonFile(exportTrainStore(), true);
      setStatus(els.jsonStatus, I18N.t("status.savedTo", { name: LOCAL_JSON_FILENAME }), "ok");
    } catch (error) {
      setStatus(els.jsonStatus, error.message, "err");
    }
  };
  document
    .getElementById("save-local-json")
    .addEventListener("click", saveLocalJsonHandler);
  els.localJsonFileInput.addEventListener("change", async () => {
    const file = els.localJsonFileInput.files?.[0];
    if (!file) return;
    try {
      // No trailing renderAll(): replaceTrainStoreFromJsonText() already
      // repaints once via finalizeProgressiveLoad().
      await replaceTrainStoreFromJsonText(
        await file.text(),
        I18N.t("src.localJson", { name: file.name }),
      );
    } catch (error) {
      setStatus(els.importStatus, error.message, "err");
    }
  });
  document
    .getElementById("validate-import-json")
    .addEventListener("click", validateTextareaJson);
  document
    .getElementById("apply-import-json")
    .addEventListener("click", async () => {
      // The progressive import owns the importInProgress lock; the handler only
      // pre-checks it (cheap reject) and disables the button against double-clicks.
      if (importInProgress) return;
      const applyButton = document.getElementById("apply-import-json");
      applyButton.disabled = true;
      try {
        // The pasted JSON may be ONE BIG file (a full store); it is parsed
        // here once for validation, and persistence chunks it per day.
        // In sample mode, offer to make the imported content the user's own
        // data (replacing the ephemeral sample) — otherwise the import would
        // silently evaporate on reload. Validate BEFORE the confirm/reset so
        // a typo can't wipe the sample view.
        if (!HAS_BACKEND && isSampleMode()) {
          parseImportedCanonicalStore(els.importJson.value); // throws if invalid
          if (await uiConfirm(I18N.t("confirm.importInSample"))) {
            dataSourceMode = "user";
            sampleModeDate = null;
            resetTrainStoreForProgressiveLoad();
            updateDataSourceUi();
          }
        }
        fitJapanMainIslands();
        resetImportProgress();
        els.search.value = "";
        const result = await importCanonicalStoreAppendProgressive(
          els.importJson.value,
          ({ count, total, id }) => {
            // Live count shown only in the progress bar; importStatus gets the
            // final summary below so the two lines don't repeat each other.
            setImportProgress(
              count,
              total,
              I18N.t("prog.loadingShort", { count, total, id }),
            );
          },
        );
        setImportProgress(
          result.count,
          result.count,
          I18N.t("prog.done", { count: result.count }),
        );
        setStatus(
          els.importStatus,
          I18N.t("status.imported", { count: result.count, ids: result.ids.join(", ") }),
          "ok",
        );
        // Force-flush the debounced server autosave so the import is persisted now.
        await flushServerStoreSave();
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      } finally {
        els.importJson.value = "";
        applyButton.disabled = false;
      }
    });
  document.getElementById("export-json").addEventListener("click", () => {
    els.json.value = exportTrainStore();
    setStatus(
      els.jsonStatus,
      I18N.t("status.exported"),
      "ok",
    );
  });
  document
    .getElementById("download-json")
    .addEventListener("click", saveLocalJsonHandler);
  document
    .getElementById("download-html")
    .addEventListener("click", () =>
      downloadText("index.html", buildPortableHtml(), "text/html"),
    );
  // --- 資料來源 (static deploy: sample vs the user's own IndexedDB store) ---
  const loadSampleAllBtn = document.getElementById("load-sample-all");
  if (loadSampleAllBtn)
    loadSampleAllBtn.addEventListener("click", async () => {
      if (importInProgress) return;
      // Loading the sample never touches the user's saved data, but it DOES
      // replace what is on screen — confirm before doing so.
      if (!(await uiConfirm(I18N.t("confirm.loadSampleAll")))) return;
      loadSampleAllBtn.disabled = true;
      try {
        fitJapanMainIslands();
        await loadSampleData({ date: null });
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      } finally {
        updateDataSourceUi();
      }
    });
  const loadNewYearGrandLoopBtn = document.getElementById(
    "load-new-year-grand-loop",
  );
  if (loadNewYearGrandLoopBtn)
    loadNewYearGrandLoopBtn.addEventListener("click", async () => {
      if (importInProgress) return;
      if (!(await uiConfirm(I18N.t("confirm.loadNewYearGrandLoop")))) return;
      loadNewYearGrandLoopBtn.disabled = true;
      try {
        fitJapanMainIslands();
        await loadNewYearGrandLoopData();
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      } finally {
        updateDataSourceUi();
      }
    });
  const loadTokyoLimitedExpressLoopBtn = document.getElementById(
    "load-tokyo-limited-express-loop",
  );
  if (loadTokyoLimitedExpressLoopBtn)
    loadTokyoLimitedExpressLoopBtn.addEventListener("click", async () => {
      if (importInProgress) return;
      if (!(await uiConfirm(I18N.t("confirm.loadTokyoLimitedExpressLoop"))))
        return;
      loadTokyoLimitedExpressLoopBtn.disabled = true;
      try {
        fitJapanMainIslands();
        await loadTokyoLimitedExpressLoopData();
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      } finally {
        updateDataSourceUi();
      }
    });
  const restoreUserStoreBtn = document.getElementById("restore-user-store");
  if (restoreUserStoreBtn)
    restoreUserStoreBtn.addEventListener("click", async () => {
      if (importInProgress) return;
      if (!(await uiConfirm(I18N.t("confirm.restoreMine")))) return;
      try {
        fitJapanMainIslands();
        await restoreUserStore();
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      }
    });
  const saveAsUserStoreBtn = document.getElementById("save-as-user-store");
  if (saveAsUserStoreBtn)
    saveAsUserStoreBtn.addEventListener("click", async () => {
      if (importBusy()) return;
      // Saving the current (sample) view AS user data overwrites any existing
      // user store — that one deserves its own, explicit confirmation.
      const message = userStoreAvailable
        ? I18N.t("confirm.overwriteMine")
        : I18N.t("confirm.saveAsMine");
      if (!(await uiConfirm(message))) return;
      try {
        await saveCurrentAsUserStore();
      } catch (error) {
        setStatus(els.jsonStatus, error.message, "err");
      }
    });
  const resetDefaultsBtn = document.getElementById("reset-defaults");
  // The static deploy's sample workflow replaces the tiny built-in seed store;
  // hide the button there instead of offering two different "samples".
  if (!HAS_BACKEND) resetDefaultsBtn.hidden = true;
  resetDefaultsBtn.addEventListener("click", () => {
    if (importBusy()) return;
    // Explicit reset: the user is deliberately abandoning whatever failed to
    // load, so read-only recovery (if active) ends and the reset persists.
    exitStoreRecoveryMode();
    trainStore = getDefaultTrainStore();
    selectedTrainId = null;
    focusedTrainId = null;
    persistAndRender();
    setStatus(els.jsonStatus, I18N.t("status.resetDefaults"), "ok");
  });
  document
    .getElementById("clear-storage")
    .addEventListener("click", async () => {
      if (importBusy()) return;
      if (!(await uiConfirm(I18N.t("confirm.clearStorage"), { danger: true })))
        return;
      try {
        // Cancel any pending autosave so it can't immediately re-create the file.
        clearTimeout(serverStoreSaveTimer);
        pendingServerStoreText = null;
        storeSaveDirty = false;
        // A write already in flight could land AFTER our delete and resurrect
        // the just-cleared data. Wait for it to settle first.
        if (serverStoreSaveInFlight) await serverStoreSavePromise;
        if (userStoreSaveInFlight) await userStoreSavePromise;
        pendingServerStoreText = null;
        storeSaveDirty = false;
        if (HAS_BACKEND) {
          const res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, {
            method: "DELETE",
            headers: { "X-Client-Id": CLIENT_ID },
          });
          if (!res.ok && res.status !== 404)
            throw new Error(`${res.status} ${res.statusText}`);
        } else {
          await clearUserStore();
          updateDataSourceUi();
        }
        await deleteStoredFileHandle();
        // The stored data is gone by explicit request — nothing left for
        // read-only recovery to protect.
        exitStoreRecoveryMode();
        setStatus(
          els.jsonStatus,
          I18N.t("status.clearedAll"),
          "warn",
        );
      } catch (error) {
        setStatus(els.jsonStatus, I18N.t("status.clearFail", { msg: error.message }), "err");
      }
    });
  // Debounce search: re-rendering the list on every keystroke (and, before,
  // JSON.stringify-ing every train including its route geometry per keystroke)
  // made typing janky. Coalesce keystrokes into one render after a short pause.
  let searchDebounceTimer = null;
  els.search.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderTrainList, 120);
  });
  document.getElementById("add-date").addEventListener("click", addManualDate);
  document
    .getElementById("remove-empty-dates")
    .addEventListener("click", removeEmptyDates);

  // When the tab is hidden, flush any pending (debounced) save immediately so
  // unsaved edits aren't lost if the page is backgrounded/closed. There are no
  // always-on animation/interval loops in this app to pause; the only deferred
  // work (route-graph prebuild) is a one-shot requestIdleCallback.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushServerStoreSave();
  });
  if (els.mapDateFilter) {
    els.mapDateFilter.addEventListener("change", () => {
      mapFollowsSelectedDate = els.mapDateFilter.checked;
      persistUiDateState();
      renderTrainLayers();
    });
  }
  if (els.toggleFocusZoom) {
    els.toggleFocusZoom.addEventListener("click", () => {
      focusZoomEnabled = !focusZoomEnabled;
      persistUiDateState();
      updateFocusZoomButton();
    });
  }
  updateFocusZoomButton();
}
