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
const SIDEBAR_PANEL_STATE_KEY = "n02-train-manager-panel-state-v1";
// Mobile bottom-panel detents, in cycling order (tap on the handle).
const SIDEBAR_PANEL_STATES = ["peek", "half", "full"];
let sidebarVisible = true;
let sidebarPanelState = "half";
let sidebarToggleReady = false;
let sidebarMapPaddingRaf = null;
let sidebarPendingMapSize = null;
let sidebarWindowResizeTimer = null;
let sidebarDragState = null;
let suppressSidebarClick = false;

// The resolved terminal UI mode owns the interaction axis. Auto mode combines
// device/input detection with a compact-window fallback; users can explicitly
// force desktop UI on mobile hardware from Display settings.
function sidebarUsesVerticalDrag() {
  const mode =
    document.documentElement && document.documentElement.dataset
      ? document.documentElement.dataset.uiMode
      : "";
  if (mode === "mobile" || mode === "desktop") return mode === "mobile";
  return window.matchMedia("(max-width: 599px)").matches;
}

function sidebarFullSize() {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) {
    const rect = sidebar.getBoundingClientRect();
    const measured = sidebarUsesVerticalDrag() ? rect.height : rect.width;
    if (measured > 0) return measured;
  }
  return sidebarUsesVerticalDrag()
    ? Math.max(1, window.innerHeight * 0.92)
    : 480;
}

// env(safe-area-inset-bottom) is not readable from JS; measure it once via a
// probe element. Reset on resize — rotation changes the inset.
let sidebarSafeAreaBottom = null;
function safeAreaBottomPx() {
  if (sidebarSafeAreaBottom !== null) return sidebarSafeAreaBottom;
  if (!document.body || typeof document.createElement !== "function") return 0;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;bottom:0;left:0;width:1px;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  sidebarSafeAreaBottom = probe.getBoundingClientRect().height;
  probe.remove();
  return sidebarSafeAreaBottom;
}

// One mobile detent in px. Peek exposes only the independently fixed bottom
// navigation while the scrollable sheet parks behind it.
function sidebarPanelSizePx(state) {
  const full = sidebarFullSize();
  if (state === "full") return full;
  if (state === "half")
    return Math.min(full, Math.round(window.innerHeight * 0.5));
  const nav = document.querySelector(".workspace-nav");
  const navHeight = nav ? nav.getBoundingClientRect().height : 86;
  return Math.min(full, Math.ceil(navHeight + safeAreaBottomPx()));
}

// The footprint the map camera should currently compensate for.
function sidebarCurrentSize() {
  if (!sidebarVisible) return 0;
  return sidebarUsesVerticalDrag()
    ? sidebarPanelSizePx(sidebarPanelState)
    : sidebarFullSize();
}

function sidebarViewportPadding(size = sidebarCurrentSize()) {
  const safeSize = Math.max(0, Number(size) || 0);
  if (!sidebarUsesVerticalDrag())
    return { top: 0, right: 0, bottom: 0, left: safeSize };
  // The full detent covers the map entirely — padding beyond ~55% of the
  // viewport only degenerates the camera, so cap what it compensates for.
  return {
    top: 0,
    right: 0,
    bottom: Math.min(safeSize, Math.round(window.innerHeight * 0.55)),
    left: 0,
  };
}

// Reflect the current mobile detent on #app: inline --sidebar-size drives the
// CSS transform, data-panel is a styling hook. Desktop clears both so the
// stylesheet's binary expanded/collapsed sizing rules.
function syncSidebarPanelStyle(app = document.getElementById("app")) {
  if (!app) return;
  if (sidebarUsesVerticalDrag() && sidebarVisible) {
    app.dataset.panel = sidebarPanelState;
    app.style.setProperty(
      "--sidebar-size",
      `${sidebarPanelSizePx(sidebarPanelState)}px`,
    );
  } else {
    delete app.dataset.panel;
    app.style.removeProperty("--sidebar-size");
  }
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
  syncSidebarPanelStyle(app);
  const sidebar = document.getElementById("sidebar");
  const workspaceNav = document.querySelector(".workspace-nav");
  const retractingRegions = [sidebar, workspaceNav].filter(Boolean);
  if (retractingRegions.length) {
    // pointer-events:none (CSS) only blocks the mouse — a collapsed drawer
    // and its sibling bottom bar must also leave the tab order and the
    // accessibility tree. The edge tab remains outside both regions so it
    // stays available to reopen the menu.
    if (
      !sidebarVisible &&
      retractingRegions.some((region) =>
        region.contains(document.activeElement),
      )
    ) {
      const tab = document.getElementById("sidebar-edge-tab");
      if (tab && typeof tab.focus === "function") tab.focus();
      else if (
        document.activeElement &&
        typeof document.activeElement.blur === "function"
      )
        document.activeElement.blur();
    }
    for (const region of retractingRegions) {
      region.inert = !sidebarVisible;
      if (sidebarVisible) region.removeAttribute("aria-hidden");
      else region.setAttribute("aria-hidden", "true");
    }
  }
  updateSidebarToggleLabel();
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_VISIBILITY_KEY, sidebarVisible ? "1" : "0");
    } catch (_) {}
  }
  cancelScheduledSidebarMapPadding();
  const easedMs = applySidebarMapPadding(
    sidebarCurrentSize(),
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

// Switch the mobile panel to a detent (peek / half / full). From hidden it
// re-opens straight onto the requested detent. On desktop only the stored
// preference changes — the drawer there stays binary.
function setSidebarPanelState(state, { persist = true, animate = true } = {}) {
  if (!SIDEBAR_PANEL_STATES.includes(state)) state = "half";
  sidebarPanelState = state;
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_PANEL_STATE_KEY, state);
    } catch (_) {}
  }
  if (!sidebarUsesVerticalDrag()) return;
  if (!sidebarVisible) {
    setSidebarVisible(true, { animate });
    return;
  }
  const app = document.getElementById("app");
  if (!app) return;
  syncSidebarPanelStyle(app);
  cancelScheduledSidebarMapPadding();
  const easedMs = applySidebarMapPadding(
    sidebarCurrentSize(),
    animate ? 320 : 0,
  );
  // Same staleness rule as setSidebarVisible: the resting padding changed,
  // so recompute the Japan zoom/bounds envelope once it lands.
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
  try {
    const savedPanel = localStorage.getItem(SIDEBAR_PANEL_STATE_KEY);
    if (SIDEBAR_PANEL_STATES.includes(savedPanel))
      sidebarPanelState = savedPanel;
  } catch (_) {}
  setSidebarVisible(sidebarVisible, { persist: false, animate: false });

  tab.addEventListener("click", (event) => {
    if (suppressSidebarClick) {
      suppressSidebarClick = false;
      event.preventDefault();
      return;
    }
    if (sidebarUsesVerticalDrag()) {
      // Tap cycles the detents; from hidden it restores the last one.
      if (!sidebarVisible) setSidebarVisible(true);
      else
        setSidebarPanelState(
          SIDEBAR_PANEL_STATES[
            (SIDEBAR_PANEL_STATES.indexOf(sidebarPanelState) + 1) %
              SIDEBAR_PANEL_STATES.length
          ],
        );
      return;
    }
    setSidebarVisible(!sidebarVisible);
  });

  tab.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const vertical = sidebarUsesVerticalDrag();
    const fullSize = sidebarFullSize();
    // The drag tracks from where the panel actually IS: the current detent on
    // mobile (starting from fullSize would snap the panel to full under the
    // finger), the binary open size on desktop.
    const startSize = !sidebarVisible
      ? 0
      : vertical
        ? sidebarPanelSizePx(sidebarPanelState)
        : fullSize;
    sidebarDragState = {
      pointerId: event.pointerId,
      vertical,
      fullSize,
      startX: event.clientX,
      startY: event.clientY,
      startSize,
      currentSize: startSize,
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
      suppressSidebarClick = true;
      setTimeout(() => {
        suppressSidebarClick = false;
      }, 0);
      if (drag.vertical) {
        // Snap to the nearest detent; releasing below half of peek hides the
        // panel entirely (full-screen map).
        const detents = SIDEBAR_PANEL_STATES.map((state) => [
          state,
          sidebarPanelSizePx(state),
        ]);
        if (drag.currentSize < detents[0][1] * 0.5) {
          setSidebarVisible(false);
        } else {
          let best = detents[0];
          for (const candidate of detents)
            if (
              Math.abs(candidate[1] - drag.currentSize) <
              Math.abs(best[1] - drag.currentSize)
            )
              best = candidate;
          setSidebarPanelState(best[0]);
        }
      } else {
        // Desktop keeps the binary drawer: a little under halfway feels
        // deliberate while still making it easy to pull a hidden menu back.
        setSidebarVisible(drag.currentSize >= drag.fullSize * 0.42);
      }
    } else {
      syncSidebarPanelStyle(app);
      cancelScheduledSidebarMapPadding();
      applySidebarMapPadding(sidebarCurrentSize(), 0);
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
      // Rotation / breakpoint crossings change the safe-area inset and every
      // detent's px value — refresh both before the padding is re-applied.
      sidebarSafeAreaBottom = null;
      syncSidebarPanelStyle(app);
      // Crossing INTO the desktop layout re-opens the mobile-collapsed
      // sections (raw JSON areas, advanced display knobs) so the flat
      // desktop panels come back complete. Never auto-closes the other way.
      if (!sidebarUsesVerticalDrag())
        document
          .querySelectorAll("details.collapse-desktop-open")
          .forEach((d) => {
            d.open = true;
          });
      // Padding BEFORE resize: crossing the 900px breakpoint flips the drawer
      // axis (left ↔ bottom padding), and map.resize() fires the 'resize'
      // handler that recomputes the Japan constraints — it must read the new
      // footprint, not the stale one.
      applySidebarMapPadding(sidebarCurrentSize(), 0);
      if (map && typeof map.resize === "function") map.resize();
    }, 80);
  });

  // A manual mobile/desktop override changes both geometry and gestures even
  // when the viewport itself did not resize. Reset any in-flight drag, then
  // recompute the sheet/drawer footprint before MapLibre refreshes.
  window.addEventListener("n02-ui-mode-change", () => {
    if (sidebarDragState) {
      const drag = sidebarDragState;
      sidebarDragState = null;
      if (drag.detachWindowFallback) drag.detachWindowFallback();
      app.classList.remove("sidebar-dragging");
    }
    app.style.removeProperty("--kb-inset");
    app.style.removeProperty("--sidebar-size");
    sidebarSafeAreaBottom = null;
    syncSidebarPanelStyle(app);
    if (!sidebarUsesVerticalDrag())
      document
        .querySelectorAll("details.collapse-desktop-open")
        .forEach((details) => {
          details.open = true;
        });
    cancelScheduledSidebarMapPadding();
    applySidebarMapPadding(sidebarCurrentSize(), 0);
    if (map && typeof map.resize === "function") map.resize();
  });

  // ---- Soft keyboard (mobile) ----
  // Focusing a text field raises the panel to the full detent — the keyboard
  // halves the visible viewport, and peek/half leave no room to edit. The
  // --kb-inset custom property tracks the keyboard height for bottom-anchored
  // chrome (consumed by the editor's action bars).
  const sidebarEl = document.getElementById("sidebar");
  if (sidebarEl)
    sidebarEl.addEventListener("focusin", (event) => {
      if (!sidebarUsesVerticalDrag() || !sidebarVisible) return;
      const target = event.target;
      if (!target || typeof target.matches !== "function") return;
      if (!target.matches("input, textarea, select")) return;
      if (
        target.matches(
          '[type="checkbox"], [type="radio"], [type="color"], [type="file"]',
        )
      )
        return;
      if (sidebarPanelState !== "full") setSidebarPanelState("full");
    });
  if (window.visualViewport) {
    const viewport = window.visualViewport;
    const updateKeyboardInset = () => {
      if (!sidebarUsesVerticalDrag()) {
        app.style.removeProperty("--kb-inset");
        return;
      }
      const inset = Math.max(
        0,
        Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
      );
      // Below ~80px it is browser chrome collapsing, not a keyboard.
      if (inset > 80) app.style.setProperty("--kb-inset", `${inset}px`);
      else app.style.removeProperty("--kb-inset");
    };
    viewport.addEventListener("resize", updateKeyboardInset);
    viewport.addEventListener("scroll", updateKeyboardInset);
  }
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
    if (!sidebarVisible) {
      setSidebarVisible(true);
      return;
    }
    // A tab TAPPED from the peek detent means "open that workspace" — raise
    // the panel so its content is actually visible. Only here, not in
    // setActiveWorkspaceTab: boot/hashchange restoration must not overwrite
    // a deliberately parked peek panel.
    if (
      sidebarUsesVerticalDrag() &&
      sidebarVisible &&
      sidebarPanelState === "peek"
    )
      setSidebarPanelState("half");
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
  // Big secondary blocks (raw JSON areas, advanced display knobs) ship
  // collapsed; wide screens open them to keep the flat desktop layout.
  document.querySelectorAll("details.collapse-desktop-open").forEach((d) => {
    if (!sidebarUsesVerticalDrag()) d.open = true;
  });
  // Re-render every dynamically-built UI string when the language changes.
  // (Static [data-i18n] DOM is handled by I18N.applyStatic; this covers the
  // JS-generated bits: display-panel labels, the focus button, the date bar,
  // train list/cards, editor, import target and the on-map labels.)
  if (window.I18N && typeof I18N.onChange === "function") {
    I18N.onChange((lang) => {
      updateThemeSelect();
      updateUiModeUi();
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
      // Reading toggles the user never customized keep following the UI
      // language (and their checkboxes update to match).
      syncNameReadingDefaultsToLang(lang);
      persistDisplaySettings();
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
    if (!selectedTrainId) return;
    // Name the victim in the confirm: on a phone the selected card may be
    // scrolled out of view, so "delete selected train?" alone invites
    // deleting the wrong one.
    const train = getTrain(selectedTrainId);
    const message = train
      ? I18N.t("confirm.deleteTrainDetail", {
          date: dateLabel(getTrainDate(train)),
          number: listPrimaryName(train.number || train.id),
          stops: String(train.stops?.length || 0),
        })
      : I18N.t("confirm.deleteTrain");
    if (await uiConfirm(message, { danger: true }))
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
        fitActiveCountryOverview();
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
      const jsonText = exportTrainStore();
      // Touch devices go through the system share sheet first (存到「檔案」/
      // AirDrop / …) — the anonymous-download fallback on iOS Safari buries
      // the file in a hard-to-find list. Desktop keeps the save picker.
      if (
        window.matchMedia("(pointer: coarse)").matches &&
        typeof navigator.canShare === "function" &&
        typeof navigator.share === "function" &&
        typeof File === "function"
      ) {
        const file = new File([jsonText], LOCAL_JSON_FILENAME, {
          type: "application/json",
        });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file] });
            setStatus(els.jsonStatus, I18N.t("status.shared"), "ok");
            return;
          } catch (error) {
            if (error && error.name === "AbortError") return; // user cancelled
            // Share engine refused the payload — fall back to save/download.
          }
        }
      }
      await writeLocalJsonFile(jsonText, true);
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
        fitActiveCountryOverview();
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
        // Clear the paste only on success — after a failure the user needs
        // the original text back to fix the reported problem.
        els.importJson.value = "";
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      } finally {
        applyButton.disabled = false;
      }
    });
  document.getElementById("export-json").addEventListener("click", () => {
    els.json.value = exportTrainStore();
    // The preview lives in a details block that ships collapsed on mobile —
    // exporting INTO a hidden textarea would look like a no-op.
    const exportDetails = document.getElementById("export-json-details");
    if (exportDetails) exportDetails.open = true;
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
  // One shared handler per dataset-replacing button (sample / curated loops).
  // Loading a dataset never touches the user's saved data, but it DOES replace
  // what is on screen — confirm before doing so. The finally-side
  // updateDataSourceUi() re-enables the button (or keeps the active mode's
  // button disabled), exactly like the three hand-written handlers it replaces.
  CURATED_DATASET_BUTTONS.forEach(({ buttonId, confirmKey, load }) => {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (importInProgress) return;
      if (!(await uiConfirm(I18N.t(confirmKey)))) return;
      btn.disabled = true;
      try {
        fitActiveCountryOverview();
        await load();
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      } finally {
        updateDataSourceUi();
      }
    });
  });
  const restoreUserStoreBtn = document.getElementById("restore-user-store");
  if (restoreUserStoreBtn)
    restoreUserStoreBtn.addEventListener("click", async () => {
      if (importInProgress) return;
      if (!(await uiConfirm(I18N.t("confirm.restoreMine")))) return;
      try {
        fitActiveCountryOverview();
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
        clearTimeout(storeSaveRetryTimer);
        clearTimeout(pendingServerStoreJournalTimer);
        pendingServerStoreJournalTimer = null;
        storeSaveRetryTimer = null;
        pendingServerStoreText = null;
        storeSaveDirty = false;
        // A write already in flight could land AFTER our delete and resurrect
        // the just-cleared data. Wait for it to settle first.
        if (serverStoreSaveInFlight) await serverStoreSavePromise;
        if (userStoreSaveInFlight) await userStoreSavePromise;
        await pendingServerStoreJournalQueue;
        pendingServerStoreText = null;
        storeSaveDirty = false;
        if (HAS_BACKEND) {
          const res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, {
            method: "DELETE",
            headers: { "X-Client-Id": CLIENT_ID },
          });
          if (!res.ok && res.status !== 404)
            throw new Error(`${res.status} ${res.statusText}`);
          lastKnownServerStoreText = null;
          lastKnownServerStoreExists = false;
          try {
            await clearPendingServerStoreSaves();
          } catch (pendingError) {
            // The server delete succeeded. A browser-storage cleanup failure
            // must not leave the UI claiming that the server clear failed.
            console.warn(
              "Could not clear pending server-store recovery copies.",
              pendingError,
            );
          }
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
