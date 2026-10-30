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
//  Workspace routing — §2.2. THREE content destinations (Journeys, Network,
//  Passport) and two Utility destinations (Data Library, Settings). Every
//  card stays in the DOM (hidden + inert only), so all JS bindings keep
//  working while a workspace is off screen.
// =========================================================================
const SIDEBAR_VISIBILITY_KEY = "n02-train-manager-sidebar-visible-v1";
const SIDEBAR_PANEL_STATE_KEY = "n02-train-manager-panel-state-v1";
// A docked mobile sheet still needs a visible/tappable grabber above the
// independently fixed bottom navigation. The navigation rect already includes
// its safe-area inset, so do not add that inset a second time here.
const SIDEBAR_HANDLE_ZONE_PX = 32;
// §4.3's three stops, in app-panel-motion.js's own order. There is no fourth,
// hidden detent on mobile any more: the panel is always AT LEAST docked, so
// there is always a grabber, an identity and one action within reach. Hiding
// the panel entirely is a desktop drawer behaviour (`sidebarVisible`), which
// is a different control with a different affordance.
const SIDEBAR_PANEL_STATES = PANEL_DETENTS;
// The detent name this replaced. A reader who parked the old panel at "peek"
// gets the stop that took its place rather than a silent reset to half.
const SIDEBAR_LEGACY_PANEL_STATE = "peek";
// §4.3: "Half（半屏）默认占可用高度的 50–58%". Of the WINDOW, not of a system
// sheet's inner height — the same quantity RideSheetMetrics measures against
// on iOS, so the two platforms open at the same fraction of the same thing.
const SIDEBAR_HALF_FRACTION = 0.55;
let sidebarVisible = true;
let sidebarPanelState = "half";
let sidebarToggleReady = false;
let sidebarMapPaddingRaf = null;
let sidebarPendingMapSize = null;
let sidebarWindowResizeTimer = null;
let sidebarDragState = null;
let suppressSidebarClick = false;
// The inline transition a velocity-seeded settle installs, and the timer that
// takes it back off again. Kept as module state rather than read off the
// element because a second release arriving mid-settle must cancel the first
// one's cleanup, not inherit its clock.
let panelSettleTimer = null;
let _panelSettleSupported = null;

// `linear()` easing is what lets a CSS transition follow a spring — including
// the part of a spring a cubic-bezier cannot express, where it passes the stop
// and comes back. Where it is missing, the stylesheet's own curve runs and the
// panel simply settles without the momentum handoff.
function panelSettleSupported() {
  if (_panelSettleSupported === null) {
    _panelSettleSupported =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("transition-timing-function", "linear(0, 1)");
  }
  return _panelSettleSupported;
}

function clearPanelSettleMotion() {
  if (panelSettleTimer) {
    clearTimeout(panelSettleTimer);
    panelSettleTimer = null;
  }
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  sidebar.style.removeProperty("transition-duration");
  sidebar.style.removeProperty("transition-timing-function");
}

// §9.3: "从手指速度交接给 spring，避免释放瞬间停顿".
//
// The stylesheet's fixed 320 ms curve always leaves from rest, so a release at
// 1,800 px/s visibly stalls for a frame before the panel starts moving again.
// This replaces that curve, for this one settle only, with a spring sampled
// from the speed the finger actually left — and then puts the stylesheet's
// curve back, so every non-gestural change (a tap on the grabber, an arrow
// key, a keyboard raise) keeps the app's ordinary rhythm.
//
// Only the sheet gets it. The bottom navigation sits at the same offset at all
// three stops, so between detents its transition is a no-op; it moves only on
// the way back from a rubber-band, where the spring's overshoot would lift it
// off the bottom edge and show a strip of map under the tab bar.
//
// Returns the settle duration in ms (0 when nothing was installed) so the
// map's padding ease can run on the same clock as the panel it compensates for.
function applyPanelSettleMotion(release, targetSize) {
  clearPanelSettleMotion();
  if (!release || !panelSettleSupported() || REDUCED_MOTION_MEDIA.matches)
    return 0;
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return 0;
  const { durationMs, easing } = panelSettleMotion(
    targetSize - release.fromSize,
    release.velocity,
  );
  if (!(durationMs > 0)) return 0;
  sidebar.style.transitionDuration = `${durationMs}ms`;
  sidebar.style.transitionTimingFunction = easing;
  // Generously past the end: a transitionend listener would miss the case
  // where the computed transform happens not to change at all.
  panelSettleTimer = setTimeout(clearPanelSettleMotion, durationMs + 80);
  return durationMs;
}

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

// One mobile detent in px.
//
// Docked is MEASURED, not a constant: §4.3 requires it to show the grabber,
// what is currently selected and one action, and that strip is a different
// height in Japanese, at a large browser font size, and on a phone with a home
// indicator. The same reasoning — and the same defect it avoids — as the iOS
// panel's `compactChromeProbe`.
function sidebarPanelSizePx(state) {
  const full = sidebarFullSize();
  if (state === "full") return full;
  if (state === "half")
    return Math.min(full, Math.round(window.innerHeight * SIDEBAR_HALF_FRACTION));
  const nav = document.querySelector(".workspace-nav");
  const navHeight = nav ? nav.getBoundingClientRect().height : 64;
  const summary = document.getElementById("panel-docked-summary");
  const summaryHeight =
    summary && !summary.hidden ? summary.getBoundingClientRect().height : 0;
  return Math.min(
    full,
    Math.ceil(navHeight + SIDEBAR_HANDLE_ZONE_PX + summaryHeight),
  );
}

// Every stop the panel may rest at, as app-panel-motion.js wants them.
function sidebarPanelDetents() {
  return SIDEBAR_PANEL_STATES.map((state) => ({
    state,
    size: sidebarPanelSizePx(state),
  }));
}

// Where the panel actually IS on screen, rather than where its stored detent
// says it should be. A drag has to track from the presented size or the panel
// jumps under the finger on the first move.
function presentedSidebarPanelSize() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return sidebarPanelSizePx(sidebarPanelState);
  const rect = sidebar.getBoundingClientRect();
  const measured = window.innerHeight - rect.top;
  return measured > 0 ? measured : sidebarPanelSizePx(sidebarPanelState);
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

// §14.4: the grabber must SAY which of the three stops the panel is at, not
// only what tapping it would do next. A control whose only feedback is its own
// next action leaves a screen-reader user unable to answer "where am I".
function panelDetentName(state) {
  return I18N.t(`panel.${state}`);
}

function updateSidebarToggleLabel() {
  const tab = document.getElementById("sidebar-edge-tab");
  if (!tab) return;
  const vertical = sidebarUsesVerticalDrag();
  if (vertical) {
    // Three stops, so the grabber is a stepper over a value rather than a
    // two-state disclosure — `aria-expanded` would claim a binary this is
    // not, and `aria-valuetext` on a plain button is not exposed at all.
    //
    // `role="slider"` is what makes the three stops reachable without a
    // drag: §10.3 requires the panel to be operable from the keyboard, and
    // §14.4 requires every detent to be reachable by assistive technology.
    // A resize handle that can only be dragged is unreachable by Switch
    // Control, Voice Control and every keyboard user — the same defect the
    // iOS panel's accessibilityAdjustableAction fixes.
    const label = I18N.t("menu.resizePanel");
    const index = SIDEBAR_PANEL_STATES.indexOf(sidebarPanelState);
    tab.removeAttribute("aria-expanded");
    tab.setAttribute("role", "slider");
    tab.setAttribute("aria-label", label);
    tab.setAttribute("aria-valuemin", "0");
    tab.setAttribute("aria-valuemax", String(SIDEBAR_PANEL_STATES.length - 1));
    tab.setAttribute("aria-valuenow", String(Math.max(index, 0)));
    tab.setAttribute("aria-valuetext", panelDetentName(sidebarPanelState));
    tab.dataset.panelState = sidebarPanelState;
    tab.title = `${label} · ${panelDetentName(sidebarPanelState)}`;
    return;
  }
  const label = I18N.t(sidebarVisible ? "menu.hide" : "menu.show");
  for (const attribute of [
    "role",
    "aria-valuetext",
    "aria-valuemin",
    "aria-valuemax",
    "aria-valuenow",
  ])
    tab.removeAttribute(attribute);
  delete tab.dataset.panelState;
  tab.setAttribute("aria-expanded", sidebarVisible ? "true" : "false");
  tab.setAttribute("aria-label", label);
  tab.title = label;
}

function setSidebarVisible(visible, { persist = true, animate = true } = {}) {
  const app = document.getElementById("app");
  if (!app) return;
  // §4.3: on a narrow screen docked IS the floor, so there is no hidden state
  // to enter — and, just as importantly, none to be restored INTO. This flag
  // is the desktop drawer's, and it is shared storage: a reader who closed the
  // drawer on their laptop was opening the phone onto a fourth, invisible
  // detent with no grabber to bring anything back.
  if (sidebarUsesVerticalDrag()) visible = true;
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
  // Only the desktop drawer writes this key. Mobile is always visible, so
  // storing "1" from here would quietly overwrite a deliberately closed
  // desktop drawer the next time the same profile opened the app on a phone.
  if (persist && !sidebarUsesVerticalDrag()) {
    try {
      localStorage.setItem(SIDEBAR_VISIBILITY_KEY, sidebarVisible ? "1" : "0");
    } catch {}
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

// Switch the mobile panel to a detent (docked / half / full). From hidden it
// re-opens straight onto the requested detent. On desktop only the stored
// preference changes — the drawer there stays binary.
function setSidebarPanelState(
  state,
  { persist = true, animate = true, release = null } = {},
) {
  if (state === SIDEBAR_LEGACY_PANEL_STATE) state = "docked";
  if (!SIDEBAR_PANEL_STATES.includes(state)) state = "half";
  sidebarPanelState = state;
  updateSidebarToggleLabel();
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_PANEL_STATE_KEY, state);
    } catch {}
  }
  if (!sidebarUsesVerticalDrag()) return;
  if (!sidebarVisible) {
    setSidebarVisible(true, { animate });
    return;
  }
  const app = document.getElementById("app");
  if (!app) return;
  // Before the transform changes, or the transition it is meant to govern has
  // already been computed with the stylesheet's curve.
  const settleMs = animate
    ? applyPanelSettleMotion(release, sidebarPanelSizePx(state))
    : (clearPanelSettleMotion(), 0);
  syncSidebarPanelStyle(app);
  cancelScheduledSidebarMapPadding();
  const easedMs = applySidebarMapPadding(
    sidebarCurrentSize(),
    animate ? settleMs || 320 : 0,
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
    // The stored flag is only consulted where it means something. See
    // setSidebarVisible: mobile's minimum is docked, not hidden.
    sidebarVisible =
      sidebarUsesVerticalDrag() ||
      localStorage.getItem(SIDEBAR_VISIBILITY_KEY) !== "0";
  } catch {
    sidebarVisible = true;
  }
  try {
    const savedPanel = localStorage.getItem(SIDEBAR_PANEL_STATE_KEY);
    if (savedPanel === SIDEBAR_LEGACY_PANEL_STATE) sidebarPanelState = "docked";
    else if (SIDEBAR_PANEL_STATES.includes(savedPanel))
      sidebarPanelState = savedPanel;
  } catch {}
  setSidebarVisible(sidebarVisible, { persist: false, animate: false });

  tab.addEventListener("click", (event) => {
    if (suppressSidebarClick) {
      suppressSidebarClick = false;
      event.preventDefault();
      return;
    }
    if (sidebarUsesVerticalDrag()) {
      // Tap cycles the three stops, and never hides the panel: §4.3's docked
      // state IS the minimum, so there is always a grabber to tap back. The
      // map is reached by dragging the panel down to docked, which leaves the
      // rest of the window to it.
      if (!sidebarVisible) setSidebarVisible(true);
      else setSidebarPanelState(nextPanelDetent(sidebarPanelState));
      return;
    }
    setSidebarVisible(!sidebarVisible);
  });

  // §10.3: the arrow keys step the panel, so the three stops are reachable
  // without a drag. Home and End jump to the ends, which is what a reader who
  // knows the control expects and what saves two presses on a phone keyboard.
  tab.addEventListener("keydown", (event) => {
    if (!sidebarUsesVerticalDrag()) return;
    const index = SIDEBAR_PANEL_STATES.indexOf(sidebarPanelState);
    const last = SIDEBAR_PANEL_STATES.length - 1;
    let next = null;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = Math.min(index + 1, last);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    setSidebarPanelState(SIDEBAR_PANEL_STATES[next]);
  });

  tab.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const vertical = sidebarUsesVerticalDrag();
    const fullSize = sidebarFullSize();
    // The drag tracks from where the panel actually IS — measured, not
    // remembered: starting from the stored detent snaps the panel under the
    // finger when a previous animation has not finished landing.
    const startSize = !sidebarVisible
      ? 0
      : vertical
        ? presentedSidebarPanelSize()
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
      // §9.3: the release stop comes from the flick's VELOCITY, which has to
      // be measured while the finger is down. Sampled rather than taken from
      // the last pointermove pair, because one dropped frame there reports a
      // velocity an order of magnitude off.
      //
      // Seeded with the touch-down itself, and closed with the lift (see
      // finishDrag), so the window spans the WHOLE gesture. Without the seed a
      // flick short enough to produce one pointermove had a single sample,
      // panelReleaseVelocity refused to divide by one point, and the fastest
      // gestures on the panel were the ones reported as motionless.
      samples: [{ size: startSize, time: performance.now() }],
      detents: vertical ? sidebarPanelDetents() : [],
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
    } catch {}
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
    // §9.3: a touch has to declare a direction before it counts as a drag, or
    // a tap on the grabber that wobbles two pixels becomes a resize.
    const slop = drag.vertical ? PANEL_DRAG_SLOP_PX : 3;
    if (Math.abs(rawDelta) >= slop) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    if (drag.vertical) {
      // Free between the stops, RESISTED past them — never clamped. A hard
      // stop at the extreme reads to the hand as the gesture having broken.
      const sizes = drag.detents.map((detent) => detent.size);
      drag.currentSize = constrainedPanelSize(
        drag.startSize + rawDelta,
        Math.min(...sizes),
        Math.max(...sizes),
        window.innerHeight,
      );
      drag.samples.push({ size: drag.currentSize, time: performance.now() });
      if (drag.samples.length > 8) drag.samples.shift();
    } else {
      drag.currentSize = Math.max(
        0,
        Math.min(drag.fullSize, drag.startSize + rawDelta),
      );
    }
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
    } catch {}
    app.classList.remove("sidebar-dragging");
    if (drag.moved && !cancelled) {
      suppressSidebarClick = true;
      setTimeout(() => {
        suppressSidebarClick = false;
      }, 0);
      if (drag.vertical) {
        // The lift is a sample too. A finger that came to rest before letting
        // go released at zero, and only a sample taken at the release itself
        // can say so — without it, a pause at the end of a fast drag still
        // flung the panel to the next stop.
        drag.samples.push({ size: drag.currentSize, time: performance.now() });
        // §9.3: snap to where the flick was GOING, not to where the finger
        // happened to leave the glass — so a fast flick from just above docked
        // reaches full without the finger travelling that far, and a slow drag
        // of the same distance stays put. The panel never hides: docked is the
        // floor, and it still carries a grabber, an identity and one action.
        const landing = panelDetentForRelease(
          drag.currentSize,
          drag.samples,
          drag.detents.length ? drag.detents : sidebarPanelDetents(),
        );
        // The same velocity that chose the stop also starts the travel to it.
        setSidebarPanelState(landing ? landing.state : sidebarPanelState, {
          release: {
            fromSize: drag.currentSize,
            velocity: panelReleaseVelocity(drag.samples),
          },
        });
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
      // Crossing INTO the mobile layout: docked is the floor there, so a
      // drawer closed on the desktop side must not survive the crossing as a
      // fourth, invisible detent.
      if (sidebarUsesVerticalDrag() && !sidebarVisible)
        setSidebarVisible(true, { persist: false, animate: false });
      // Rotation / breakpoint crossings change every detent's px value.
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
    // Same floor as the resize path: forcing mobile UI must never land on the
    // hidden state the desktop drawer is allowed to be in.
    if (sidebarUsesVerticalDrag() && !sidebarVisible)
      setSidebarVisible(true, { persist: false, animate: false });
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

// §2.2's navigation tree, as the DOM realises it.
//
// Three destinations, each owning one or more cards. `train-editor` is NOT a
// destination of its own any more: §2.2 folds Editor into Journey Detail, so
// it belongs to Journeys and is shown alongside the browser rather than
// instead of it.
const PRIMARY_WORKSPACES = {
  journeys: ["train-browser", "train-editor"],
  network: ["network-workspace"],
  passport: ["mileage-stats"],
};
const PRIMARY_WORKSPACE_NAMES = Object.keys(PRIMARY_WORKSPACES);
// §2.2: data ownership and global preferences are TASKS. They open over the
// current workspace and hand it back when closed — they are not places the
// reader browses, so they are not tabs.
const UTILITY_WORKSPACES = ["data-manager", "display-settings"];
// The five-tab hashes this replaced, so a bookmark or a restored session lands
// somewhere meaningful instead of silently falling back to Journeys.
const LEGACY_WORKSPACE_HASHES = {
  "train-browser": "journeys",
  "train-editor": "journeys",
  "mileage-stats": "passport",
  "data-manager": "data-manager",
  "display-settings": "display-settings",
};
let activePrimaryWorkspace = "journeys";
let activeUtilityWorkspace = null;
// §4.1: "切换 Tab 必须保留每个工作区的导航、滚动和筛选状态".
//
// One scroll offset per destination, remembered on the way out and re-applied
// on the way in. The panel is a single scrolling element shared by every card,
// so without this a reader who was forty rows down a journey list came back to
// the top of it every time they glanced at Passport.
const workspaceScrollOffsets = new Map();
// §4.1 again: "Data/Settings 被关闭后必须返回原 Tab、原导航路径与原滚动位置".
//
// A Utility takes the whole panel (§4.3 allows a task to), which means closing
// one has to give back more than the card underneath: the detent it displaced
// and the scroll offset it reset are both part of "原位置".
let utilityReturnState = null;

function panelScrollElement() {
  return document.getElementById("sidebar");
}

function rememberWorkspaceScroll() {
  const sidebar = panelScrollElement();
  if (!sidebar) return;
  workspaceScrollOffsets.set(currentPrimaryWorkspace(), sidebar.scrollTop);
}

function restoreWorkspaceScroll(name) {
  const sidebar = panelScrollElement();
  if (!sidebar) return;
  const top = workspaceScrollOffsets.get(name) || 0;
  sidebar.scrollTop = top;
  // A scroll offset assigned to an element that is still short is silently
  // clamped, and the incoming card can still grow by a frame — the Passport
  // log and the network summary both render into it on the way in. Retry once,
  // and only when the first assignment actually came up short.
  if (
    top > 0 &&
    sidebar.scrollTop < top &&
    typeof requestAnimationFrame === "function"
  )
    requestAnimationFrame(() => {
      if (currentPrimaryWorkspace() === name && sidebar.scrollTop < top)
        sidebar.scrollTop = top;
    });
}

// Which destination is showing. Read by §4.3's docked strip, which has to name
// what the panel is currently ABOUT — a strip that says "185 journeys" while
// the reader is looking at Network is answering a question nobody asked.
function currentPrimaryWorkspace() {
  return activeUtilityWorkspace || activePrimaryWorkspace;
}

// A restored #workspace hash can make browsers scroll the otherwise locked
// body to that card after first paint. The fixed-height app then starts above
// the viewport, and hiding the sheet exposes its off-screen contents. Reset
// both possible scrolling roots now and once more on the next frame.
function resetWorkspaceDocumentScroll() {
  const reset = () => {
    if (document.documentElement && document.documentElement.scrollTo)
      document.documentElement.scrollTo(0, 0);
    if (document.body && document.body.scrollTo) document.body.scrollTo(0, 0);
  };
  reset();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(reset);
}

// Hide or show one card, in every sense a card can be hidden.
//
// `hidden` alone only stops the mouse. A card that is off screen must also
// leave the tab order and the accessibility tree, or a keyboard reader tabs
// straight into the Danger Zone of a Data Library nobody opened.
function setWorkspaceCardVisible(card, visible) {
  if (!card) return;
  card.hidden = !visible;
  card.classList.toggle("tab-hidden", !visible);
  card.inert = !visible;
  if (visible) card.removeAttribute("aria-hidden");
  else card.setAttribute("aria-hidden", "true");
  // A collapsible card IS its whole workspace — open it when it is shown.
  if (visible && card.tagName === "DETAILS") card.open = true;
}

// Move focus out of a region before it becomes inert. Leaving it inside is how
// a page ends up with `document.activeElement` in a subtree nothing can reach.
function releaseFocusFrom(cards) {
  const active = document.activeElement;
  if (!active) return;
  if (!cards.some((card) => card && card.contains(active))) return;
  if (typeof active.blur === "function") active.blur();
}

function setActivePrimaryWorkspace(
  name,
  { updateHash = true, restoreScroll = true } = {},
) {
  if (!PRIMARY_WORKSPACES[name]) name = PRIMARY_WORKSPACE_NAMES[0];
  // Before anything is hidden: whatever is on screen owns the current offset.
  // Re-selecting the destination already on screen moves nothing, so it must
  // not overwrite what the reader is looking at with a remembered offset.
  const arriving = name !== currentPrimaryWorkspace();
  if (arriving) rememberWorkspaceScroll();
  // Leaving a Utility by pressing a tab is a decision, not a close — there is
  // no "back where it was opened from" left to honour.
  if (activeUtilityWorkspace) utilityReturnState = null;
  activePrimaryWorkspace = name;
  activeUtilityWorkspace = null;

  const utilityCards = UTILITY_WORKSPACES.map((id) =>
    document.getElementById(id),
  );
  releaseFocusFrom(utilityCards);
  utilityCards.forEach((card) => setWorkspaceCardVisible(card, false));
  document.querySelectorAll("[data-primary-workspace]").forEach((card) => {
    setWorkspaceCardVisible(card, card.dataset.primaryWorkspace === name);
  });

  document.querySelectorAll("[data-workspace-target]").forEach((button) => {
    const active = button.dataset.workspaceTarget === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const app = document.getElementById("app");
  if (app) {
    app.dataset.workspace = name;
    delete app.dataset.utility;
  }

  if (updateHash && location.hash !== "#" + name)
    history.replaceState(null, "", "#" + name);
  resetWorkspaceDocumentScroll();
  // Compute the mileage stats lazily, the first time (and only when) Passport
  // is actually opened — scheduleMileageStats() otherwise skips while the card
  // is hidden, so the 12 MB rail-sections parse it needs never lands on the
  // boot path. Guarded by typeof because this also runs at module-parse time,
  // before those functions are defined.
  if (name === "passport") {
    if (typeof scheduleMileageStats === "function") scheduleMileageStats();
    if (typeof renderPassportJourneyLog === "function")
      renderPassportJourneyLog();
  }
  if (name === "network" && typeof renderNetworkWorkspace === "function")
    renderNetworkWorkspace();
  // §4.3: the docked strip names what the panel is currently about.
  if (typeof renderPanelDockedSummary === "function")
    renderPanelDockedSummary();
  // After the incoming cards are visible and have rendered, or the offset is
  // applied to a panel that is still showing the previous destination.
  if (!arriving) return;
  if (restoreScroll) restoreWorkspaceScroll(name);
  else {
    const sidebar = panelScrollElement();
    if (sidebar) sidebar.scrollTop = 0;
  }
}

// §4.1: a Utility destination opens OVER the current workspace and hands it
// back on close — the primary selection is not disturbed while it is open, so
// closing needs no memory beyond `activePrimaryWorkspace`.
function openUtilityWorkspace(id) {
  if (!UTILITY_WORKSPACES.includes(id)) return;
  // Only the FIRST open records the way back: stepping from Data Library to
  // Settings must not overwrite the workspace both of them opened over.
  if (!activeUtilityWorkspace) {
    rememberWorkspaceScroll();
    utilityReturnState = {
      workspace: activePrimaryWorkspace,
      panelState: sidebarPanelState,
    };
  }
  activeUtilityWorkspace = id;
  document
    .querySelectorAll("[data-primary-workspace]")
    .forEach((card) => setWorkspaceCardVisible(card, false));
  UTILITY_WORKSPACES.forEach((candidate) => {
    setWorkspaceCardVisible(
      document.getElementById(candidate),
      candidate === id,
    );
  });
  const app = document.getElementById("app");
  if (app) app.dataset.utility = id;
  // A task wants the room a task needs: §4.3 allows a system task to take the
  // whole panel, and an import wizard read through a 40%-tall window is not a
  // wizard anybody can follow.
  //
  // Not persisted: this raise belongs to the task, not to the reader. Writing
  // it to storage would mean quitting with an import open reopens the app at
  // full, having silently replaced a detent nobody chose.
  if (sidebarUsesVerticalDrag()) {
    if (!sidebarVisible) setSidebarVisible(true);
    setSidebarPanelState("full", { persist: false });
  }
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.scrollTop = 0;
  if (typeof renderPanelDockedSummary === "function")
    renderPanelDockedSummary();
  const target = document.getElementById(id);
  if (target && typeof target.focus === "function")
    target.focus({ preventScroll: true });
}

function closeUtilityWorkspace() {
  if (!activeUtilityWorkspace) return;
  const returning = utilityReturnState;
  utilityReturnState = null;
  // Back to the workspace this was opened from, at ITS hash — the Utility
  // never wrote one, so nothing has to be restored there. Everything the task
  // DID displace is put back below.
  setActivePrimaryWorkspace(
    returning ? returning.workspace : activePrimaryWorkspace,
    { updateHash: false },
  );
  // The detent the task took for itself. Opening a Utility raises the panel to
  // full because an import wizard read through a 40%-tall window is not a
  // wizard anybody can follow — but the reader parked the panel where they
  // parked it, and a task is not entitled to keep that change after it ends.
  if (
    returning &&
    sidebarUsesVerticalDrag() &&
    returning.panelState !== sidebarPanelState
  )
    setSidebarPanelState(returning.panelState);
  const nav = document.querySelector(
    `[data-workspace-target="${activePrimaryWorkspace}"]`,
  );
  if (nav && typeof nav.focus === "function") nav.focus({ preventScroll: true });
}

// §5.3.4: "点击打开同一个 Journey Detail，不复制历史详情页面".
//
// Selecting the record was only ever half of that. `train-editor` belongs to
// Journeys (§2.2 folded the editor into Journey Detail), so while Passport was
// the destination on screen the detail this "opened" stayed hidden and inert,
// and the reader was left on a log where one row had changed colour. Passport
// and Journeys are two views of one set of records, not two record stores — so
// this goes to the view that owns the detail rather than growing a second copy
// of the detail here.
function openJourneyDetail(id) {
  if (!id) return;
  selectTrain(id, { fit: focusZoomEnabled });
  // Not restoreScroll: the reader asked for one specific record, so the
  // remembered offset of the journeys list is not where they want to be.
  setActivePrimaryWorkspace("journeys", { restoreScroll: false });
  // A detail read through the docked strip is not a detail.
  if (sidebarUsesVerticalDrag() && sidebarPanelState === "docked")
    setSidebarPanelState("half");
  const editor = document.getElementById("train-editor");
  if (editor && typeof editor.scrollIntoView === "function")
    editor.scrollIntoView({
      block: "start",
      behavior: REDUCED_MOTION_MEDIA.matches ? "auto" : "smooth",
    });
}

// One route resolver for a hash, a nav press and a restored session.
function routeToWorkspace(raw, { updateHash = true } = {}) {
  const name = String(raw || "").replace(/^#/, "");
  if (UTILITY_WORKSPACES.includes(name)) return openUtilityWorkspace(name);
  const legacy = LEGACY_WORKSPACE_HASHES[name];
  if (legacy) return routeToWorkspace(legacy, { updateHash });
  setActivePrimaryWorkspace(name, { updateHash });
}

let _workspaceTabsReady = false;
function setupWorkspaceTabs() {
  if (_workspaceTabsReady) return; // called eagerly at parse AND from bindEvents
  const nav = document.querySelector(".workspace-nav");
  if (!nav) return;
  _workspaceTabsReady = true;

  document.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!target || typeof target.closest !== "function") return;

    const primary = target.closest("[data-workspace-target]");
    if (primary) {
      ev.preventDefault();
      setActivePrimaryWorkspace(primary.dataset.workspaceTarget);
      if (!sidebarVisible) {
        setSidebarVisible(true);
        return;
      }
      // A destination CHOSEN from the docked stop means "open that workspace"
      // — raise the panel so its content is actually visible. Only here, not
      // in setActivePrimaryWorkspace: boot and hashchange restoration must not
      // overwrite a deliberately parked docked panel.
      if (
        sidebarUsesVerticalDrag() &&
        sidebarVisible &&
        sidebarPanelState === "docked"
      )
        setSidebarPanelState("half");
      return;
    }

    const utility = target.closest("[data-utility-target]");
    if (utility) {
      ev.preventDefault();
      openUtilityWorkspace(utility.dataset.utilityTarget);
      return;
    }

    if (target.closest("[data-utility-close]")) {
      ev.preventDefault();
      closeUtilityWorkspace();
    }
  });

  // Escape leaves a Utility the way it leaves any other task surface.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !activeUtilityWorkspace) return;
    const active = document.activeElement;
    // Not while a text field or an open disclosure is consuming the key.
    if (active && active.matches && active.matches("input, textarea, select"))
      return;
    closeUtilityWorkspace();
  });

  window.addEventListener("hashchange", () => {
    routeToWorkspace(location.hash.slice(1), { updateHash: false });
    resetWorkspaceDocumentScroll();
  });
  window.addEventListener("load", resetWorkspaceDocumentScroll);
  window.addEventListener("pageshow", resetWorkspaceDocumentScroll);
  routeToWorkspace(location.hash.slice(1) || PRIMARY_WORKSPACE_NAMES[0], {
    updateHash: false,
  });
}
// The tab chrome needs only the static DOM — activate it immediately so the
// panels behave as tabs during the (seconds-long) data load too. bindEvents()
// calls it again later, which the guard turns into a no-op.
setupSidebarToggle();
setupWorkspaceTabs();

// A DECLARATIVE WIRING LIST, not an algorithm: one entry per control, in the
// order the sidebar presents them. Its length is its natural form — cutting it
// into per-section functions would only hide the fact that this IS the app's
// complete input surface. The §-banners below are its table of contents:
//
//   §1  panel/tab bootstrap and collapse defaults
//   §2  language-change re-render subscription
//   §3  train CRUD (add / duplicate / delete / delete-all)
//   §4  selection, fit, visibility, ordering, stops, route rebuild
//   §5  local JSON: open / save / share sheet / file input
//   §6  paste-import: validate and apply
//   §7  export and download (JSON, portable HTML)
//   §8  資料來源: curated datasets, user store, reset, clear storage
//   §9  search debounce and the date bar
//   §10 lifecycle: flush the debounced save when the tab is hidden
//   §11 map date filter and focus zoom
function bindEvents() {
  // ── §1 panel/tab bootstrap and collapse defaults ──
  setupDisplaySettingsPanel();
  setupWorkspaceTabs();
  // Big secondary blocks (raw JSON areas, advanced display knobs) ship
  // collapsed; wide screens open them to keep the flat desktop layout.
  document.querySelectorAll("details.collapse-desktop-open").forEach((d) => {
    if (!sidebarUsesVerticalDrag()) d.open = true;
  });
  // ── §2 language-change re-render subscription ──
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
  // ── §2b itinerary playback ──
  Playback.bindUi();
  PlaybackVideo.bindUi();
  // ── §3 train CRUD ──
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
  // ── §4 selection, fit, visibility, ordering, stops, route rebuild ──
  document
    .getElementById("fit-selected")
    .addEventListener("click", () => fitTrainBounds(getTrain()));
  // §4.1 and §5.1: "定位所选路线" and "适配完整路网" are two controls with two
  // labels. One button that means either depending on the selection is a
  // button whose accessibility label is a lie half the time.
  const fitNetwork = document.getElementById("fit-complete-network");
  if (fitNetwork)
    fitNetwork.addEventListener("click", () =>
      fitActiveCountryOverview({ animate: true }),
    );
  // The complete-network switch drives the SAME state the map's own layer
  // control does (§5.1 forbids two surfaces owning one switch), so the two
  // can never disagree about whether the network is drawn.
  const showNetwork = document.getElementById("network-show-all");
  if (showNetwork)
    showNetwork.addEventListener("click", () => {
      setNetworkOverlayVisible(!isNetworkOverlayVisible());
    });
  if (typeof onNetworkOverlayChange === "function")
    onNetworkOverlayChange(() => renderNetworkWorkspace());
  // §4.3's docked action. One button whose verb the state chooses — which is
  // why it dispatches on `dockedAction` rather than being two buttons one of
  // which is always hidden.
  const dockedAction = document.getElementById("panel-docked-action");
  if (dockedAction)
    dockedAction.addEventListener("click", () => {
      if (dockedAction.dataset.dockedAction === "locate") {
        const train = getTrain(selectedTrainId);
        if (train) fitTrainBounds(train);
        return;
      }
      addTrain();
    });
  // §5.3.4: a Journey Log row opens the SAME Journey Detail the list opens,
  // over the same record id. Delegated because the log is rebuilt whenever the
  // scope changes, and a listener per row would leak one per rebuild.
  const journeyLog = document.getElementById("passport-journey-log");
  if (journeyLog)
    journeyLog.addEventListener("click", (event) => {
      const row = event.target.closest("[data-passport-train-id]");
      if (!row) return;
      openJourneyDetail(row.dataset.passportTrainId);
    });
  // §5.3.1's scope, which is Passport's own and nobody else's. Delegated for
  // the same reason as the log: the chips are rebuilt on every store change.
  const passportScope = document.getElementById("passport-scope");
  if (passportScope)
    passportScope.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-passport-scope]");
      if (!chip) return;
      setPassportScopeDate(chip.dataset.passportScope);
    });
  // Passport's replay is the same transport Journeys uses, over the same
  // scope. §5.3 lists it as an entry point, not as a second player.
  const passportReplay = document.getElementById("passport-replay");
  if (passportReplay)
    passportReplay.addEventListener("click", () => {
      if (Playback.isActive()) Playback.stop();
      else Playback.start();
    });
  document.getElementById("clear-selection").addEventListener("click", () => {
    selectedTrainId = null;
    focusedTrainId = null;
    // Mirror selectTrain's minimal path instead of a full renderAll: the
    // date bar and list CONTENT are untouched by a selection change, so only
    // the card highlight, the editor and the (cache-hit) layer pass matter.
    updateSelectionHighlight();
    renderEditor();
    renderTrainLayers();
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
  // ── §5 local JSON: open / save / share sheet / file input ──
  document
    .getElementById("open-local-json")
    .addEventListener("click", async () => {
      if (importBusy()) return;
      try {
        fitActiveCountryOverview();
        setImportProgress(0, 1, I18N.t("prog.openingLocal"));
        await ImportController.openLocalJson();
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
        const file = new File([jsonText], countryLocalJsonFilename(), {
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
      setStatus(
        els.jsonStatus,
        I18N.t("status.savedTo", { name: countryLocalJsonFilename() }),
        "ok",
      );
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
    if (importBusy()) return;
    try {
      // No trailing renderAll(): ImportController.replaceJson() already
      // repaints once via finalizeProgressiveLoad().
      await ImportController.replaceJson(
        await file.text(),
        I18N.t("src.localJson", { name: file.name }),
      );
    } catch (error) {
      setStatus(els.importStatus, error.message, "err");
    }
  });
  // ── §6 paste-import: validate and apply ──
  document
    .getElementById("validate-import-json")
    .addEventListener("click", validateTextareaJson);
  document
    .getElementById("apply-import-json")
    .addEventListener("click", async () => {
      // The progressive import owns the importInProgress lock; the handler only
      // pre-checks it (cheap reject, also busy during a country switch) and
      // disables the button against double-clicks.
      if (importBusy()) return;
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
  // ── §7 export and download ──
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
  // ── §8 資料來源 (static deploy: sample vs the user's own IndexedDB store) ──
  // One shared handler per dataset-replacing button (sample / curated loops).
  // Loading a dataset never touches the user's saved data, but it DOES replace
  // what is on screen — confirm before doing so. The finally-side
  // updateDataSourceUi() re-enables the button (or keeps the active mode's
  // button disabled), exactly like the three hand-written handlers it replaces.
  CURATED_DATASET_BUTTONS.forEach(({ buttonId, confirmKey, load }) => {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (importBusy()) return;
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
      if (importBusy()) return;
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
  resetDefaultsBtn.addEventListener("click", async () => {
    if (importBusy()) return;
    if (!(await uiConfirm(I18N.t("confirm.resetDefaults"), { danger: true })))
      return;
    // Explicit reset: the user is deliberately abandoning whatever failed to
    // load, so read-only recovery (if active) ends and the reset persists.
    exitStoreRecoveryMode();
    AppActions.replaceTrainStore(getDefaultTrainStore());
    selectedTrainId = null;
    focusedTrainId = null;
    applyMutationResult(MutationResults.trainCollectionChanged);
    setStatus(els.jsonStatus, I18N.t("status.resetDefaults"), "ok");
  });
  document
    .getElementById("clear-storage")
    .addEventListener("click", async () => {
      if (importBusy()) return;
      if (!(await uiConfirm(I18N.t("confirm.clearStorage"), { danger: true })))
        return;
      try {
        await PersistenceService.clear();
        if (!HAS_BACKEND) updateDataSourceUi();
        setStatus(
          els.jsonStatus,
          I18N.t("status.clearedAll"),
          "warn",
        );
      } catch (error) {
        setStatus(els.jsonStatus, I18N.t("status.clearFail", { msg: error.message }), "err");
      }
    });
  // ── §9 search debounce and the date bar ──
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

  // ── §10 lifecycle ──
  // When the tab is hidden, flush any pending (debounced) save immediately so
  // unsaved edits aren't lost if the page is backgrounded/closed. There are no
  // always-on animation/interval loops in this app to pause; the only deferred
  // work (route-graph prebuild) is a one-shot requestIdleCallback.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushServerStoreSave();
  });
  // ── §11 map date filter and focus zoom ──
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
