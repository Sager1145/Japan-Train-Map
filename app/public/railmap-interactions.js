/*
 * railmap-interactions.js — pointer interactions for the RailMap core.
 *
 * Extends the RailMap manager (railmap.js) with its interaction methods:
 * route/marker click-to-select, the hover spotlight with fan expansion and
 * hysteresis (pick / sticky / hold / switch zones), the train tooltip, and
 * railprint's C5 station hover popup.
 *
 * Classic-script load order: MUST come after railmap.js — it Object.assign()s
 * these methods onto the RailMap global before any map is attached.
 */
(function (global) {
  "use strict";

  const {
    STATIONS_LAYER,
    TRAIN_PICK_LAYER,
    TRAIN_PICK_FAN_LAYER,
    TRAIN_PASS_LAYER,
    TRAIN_STOPS_LAYER,
    TRAIN_XDAY_STOP_LAYER,
    TRAIN_SEL_PASS_LAYER,
    TRAIN_SEL_STOPS_LAYER,
    HOVER_PICK_PAD_PX,
    HOVER_STICKY_PAD_PX,
    HOVER_FAN_HOLD_PX,
    HOVER_GROUP_SWITCH_PX,
  } = global.RailMapStyle;
  const { buildPopupModel, stationPopupHtml } = global.RailMapPopup;

  Object.assign(global.RailMap, {
    // ── interactions: route/marker click + hover, station hover popup ──
    _wireInteractions() {
      const map = this._map;
      const self = this;

      // The hover-region debug geometry is source-backed and therefore still
      // follows zoom. Fan lanes themselves use pixel-valued line-translate,
      // so MapLibre keeps their spacing constant without any zoom-time work.
      map.on("zoom", () => {
        if (self._hoverRegionsVisible && self._hoverDebugState)
          self._pushHoverRegions(self._hoverDebugState);
      });

      // preferLanes (hover only): while a fan is expanded, the fanned trains'
      // own station dots must not steal the pointer from the lanes — sliding
      // along the fan would flicker hover/tooltip at every station. Clicks
      // keep marker precedence so a station dot still opens its stop popup.
      //
      // stickyTids (STICKY HOVER): the currently hovered line — or the open
      // fan's member set — has absolute pick priority. While the pointer is
      // still on ANY sticky geometry (its line or its station dots), other
      // lines crossing beneath it are invisible to picking; only once the
      // pointer actually LEAVES the sticky geometry does the normal
      // resolution (foreign lines / ground) apply again.
      // Touch has no hover stage to engage the sticky grab box, so taps get
      // fatter pads up front: routes reach ~22px from the finger (16px pad on
      // top of the pick lane's own half-width), station dots 12px — still
      // only winning close in so they don't grab from afar.
      // (matchMedia is absent in the headless harnesses that attach railmap —
      // fan smoke test, precompute replay — so fall back to the fine-pointer
      // pads there.)
      const coarsePointer =
        typeof window.matchMedia === "function"
          ? window.matchMedia("(pointer: coarse)")
          : { matches: false };
      const TOUCH_ROUTE_PAD_PX = 16;
      const TOUCH_MARKER_PAD_PX = 12;

      // queryRenderedFeatures returns the source geometry, so a merged outer
      // query still needs this cheap screen-space check to preserve the
      // deliberately smaller 5px sticky route pad. The pick line's own width
      // expands the box just as MapLibre's rendered-line query does.
      const segmentIntersectsBox = (a, b, radius) => {
        let t0 = 0;
        let t1 = 1;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const clip = (p, q) => {
          if (Math.abs(p) < 1e-12) return q >= 0;
          const r = q / p;
          if (p < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
          } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
          }
          return true;
        };
        return (
          clip(-dx, a.x + radius) &&
          clip(dx, radius - a.x) &&
          clip(-dy, a.y + radius) &&
          clip(dy, radius - a.y)
        );
      };
      const routeFeatureWithinPad = (feature, point, pad) => {
        if (!feature || !feature.geometry || typeof map.project !== "function")
          return true;
        const geometry = feature.geometry;
        const lines =
          geometry.type === "LineString"
            ? [geometry.coordinates]
            : geometry.type === "MultiLineString"
              ? geometry.coordinates
              : [];
        if (!lines.length) return true;
        const layerId = feature.layer && feature.layer.id;
        const translate =
          layerId && typeof map.getPaintProperty === "function"
            ? map.getPaintProperty(layerId, "line-translate")
            : null;
        const tx = Array.isArray(translate) ? Number(translate[0]) || 0 : 0;
        const ty = Array.isArray(translate) ? Number(translate[1]) || 0 : 0;
        const halfWidth = Math.max(
          0,
          (Number(feature.properties && feature.properties.pickWidth) || 0) / 2,
        );
        const radius = pad + halfWidth;
        for (const line of lines) {
          for (let i = 0; i < line.length - 1; i += 1) {
            const pa = map.project(line[i]);
            const pb = map.project(line[i + 1]);
            const a = { x: pa.x + tx - point.x, y: pa.y + ty - point.y };
            const b = { x: pb.x + tx - point.x, y: pb.y + ty - point.y };
            if (segmentIntersectsBox(a, b, radius)) return true;
          }
        }
        return false;
      };

      function queryAt(point, preferLanes, stickyTids) {
        const sticky = stickyTids && stickyTids.length ? stickyTids : null;
        const markerLayers = [
          TRAIN_SEL_STOPS_LAYER,
          TRAIN_SEL_PASS_LAYER,
          TRAIN_STOPS_LAYER,
          TRAIN_PASS_LAYER,
          // The cross-day diamond replaces its station's dot, so it has to
          // stay hoverable/clickable in that dot's place.
          TRAIN_XDAY_STOP_LAYER,
        ].filter((id) => map.getLayer(id));
        // Fan lanes first: while a fan is open its per-lane hit paths (small
        // dedicated source) take precedence over the static true-track areas.
        const pickLayers = self
          ._fanPickLayerIds()
          .concat(TRAIN_PICK_LAYER)
          .filter((id) => map.getLayer(id));
        const fanPickLayers = new Set(self._fanPickLayerIds());
        const markerPad = coarsePointer.matches
          ? TOUCH_MARKER_PAD_PX
          : HOVER_PICK_PAD_PX;
        const bbox = [
          [point.x - markerPad, point.y - markerPad],
          [point.x + markerPad, point.y + markerPad],
        ];
        // Engaged-hover ROUTE grab box (hover queries only — clicks and fresh
        // hovers keep their base pad). Markers keep the tighter bbox so
        // station dots don't grab from afar.
        const routePad =
          preferLanes && sticky
            ? HOVER_STICKY_PAD_PX
            : coarsePointer.matches
              ? TOUCH_ROUTE_PAD_PX
              : HOVER_PICK_PAD_PX;
        // Hover queries used to fan out to 3-4 queryRenderedFeatures per
        // frame (markers box + exact point + padded route fallback). Fine
        // pointers now query the 8px outer box ONCE, partition by layer, then
        // screen-filter sticky route candidates back to their intentional 5px
        // pad. The exact-point lane resolution runs only when that box proved
        // a route is nearby at all. Idle travel pays one query per frame and
        // an engaged fan pays at most two without becoming magnetic.
        const isPickFeat = (f) =>
          f.layer &&
          (fanPickLayers.has(f.layer.id) || f.layer.id === TRAIN_PICK_LAYER);
        let mk = [];
        let boxRouteFeats = null;
        if (routePad <= markerPad && pickLayers.length) {
          const all = map.queryRenderedFeatures(bbox, {
            layers: markerLayers.concat(pickLayers),
          });
          mk = all.filter((f) => !isPickFeat(f));
          boxRouteFeats = all.filter(isPickFeat);
          // Equal pads mean the outer box IS the route pad — MapLibre already
          // applied it. Only the tighter sticky pad needs the screen filter.
          if (routePad < markerPad)
            boxRouteFeats = boxRouteFeats.filter((f) =>
              routeFeatureWithinPad(f, point, routePad),
            );
        } else if (markerLayers.length) {
          mk = map.queryRenderedFeatures(bbox, { layers: markerLayers });
        }
        // Markers: prefer a sticky train's dot over foreign dots. nopick dots
        // (off-date trains while a day is active) are never interactive.
        let markerHit = null;
        if (mk.length) {
          const recOf = (f) => self._markers && self._markers[f.properties.idx];
          const usable = (rec) => rec && !rec.nopick;
          let rec = null;
          if (sticky) {
            const f = mk.find((f0) => {
              const r = recOf(f0);
              return usable(r) && r.train && sticky.includes(r.train.id);
            });
            rec = f ? recOf(f) : null;
          }
          if (!rec) {
            const f = mk.find((f0) => usable(recOf(f0)));
            rec = f ? recOf(f) : null;
          }
          if (rec)
            markerHit = {
              kind: "marker",
              record: rec,
              sticky: Boolean(
                sticky && rec.train && sticky.includes(rec.train.id),
              ),
            };
        }
        // Routes are picked against the invisible PICK lanes (which hug the
        // visible lines: true track while collapsed, per-lane paths for an
        // open fan). Query the EXACT cursor point first — that resolves to
        // the single lane under the pointer — and only fall back to the
        // padded box when the exact point misses (thin isolated lines stay
        // easy to grab). Sticky trains win within each candidate set.
        const routeFrom = (feats) => {
          if (!feats.length) return null;
          let f = null;
          if (sticky)
            f = feats.find((f0) => sticky.includes(f0.properties.tid));
          if (!f) f = feats[0];
          const rec = self._records[f.properties.idx];
          return rec
            ? {
                kind: "route",
                record: rec,
                sticky: Boolean(sticky && sticky.includes(f.properties.tid)),
              }
            : null;
        };
        let routeHit = null;
        if (boxRouteFeats !== null) {
          // Merged path: the shared box already answered "is any route
          // near?" — resolve the single lane under the pointer only then,
          // and reuse the box features as the padded fallback.
          if (boxRouteFeats.length) {
            routeHit = routeFrom(
              map.queryRenderedFeatures(point, { layers: pickLayers }),
            );
            if (!routeHit) routeHit = routeFrom(boxRouteFeats);
          }
        } else {
          const routeBbox = [
            [point.x - routePad, point.y - routePad],
            [point.x + routePad, point.y + routePad],
          ];
          routeHit = routeFrom(
            map.queryRenderedFeatures(point, { layers: pickLayers }),
          );
          if (!routeHit)
            routeHit = routeFrom(
              map.queryRenderedFeatures(routeBbox, { layers: pickLayers }),
            );
        }
        // STICKY RESOLUTION: while any sticky geometry is under the pointer,
        // foreign hits are discarded entirely.
        if (sticky && ((markerHit && markerHit.sticky) || (routeHit && routeHit.sticky))) {
          if (markerHit && !markerHit.sticky) markerHit = null;
          if (routeHit && !routeHit.sticky) routeHit = null;
        }
        const markerYieldsToFan =
          markerHit &&
          preferLanes &&
          self._expandedTids.length &&
          markerHit.record.train &&
          self._expandedTids.includes(markerHit.record.train.id);
        if (markerHit && !markerYieldsToFan) return markerHit;
        if (routeHit) return routeHit;
        return markerHit;
      }

      // The sticky set for the CURRENT hover state: the open fan's members,
      // else the single hovered train.
      function currentStickyTids() {
        if (self._expandedGroup && self._expandedTids.length)
          return self._expandedTids;
        if (self._hoverTrainId) return [self._hoverTrainId];
        return null;
      }

      map.on("click", (e) => {
        // Clicks resolve with the same sticky priority the hover shows: at a
        // crossing you select the line you are hovering, never the one
        // beneath it.
        const hit = queryAt(e.point, false, currentStickyTids());
        if (!hit) {
          // Blank ground (no route lane, no station dot): let the app react —
          // it switches the date filter back to "全部" so every date's routes
          // show. MapLibre suppresses click after a drag, so panning is safe.
          if (self._handlers.onBackgroundClick)
            self._handlers.onBackgroundClick({
              coordinate: [e.lngLat.lng, e.lngLat.lat],
            });
          return;
        }
        // AMBIGUOUS TOUCH TAP: coarse pointers have no hover stage to
        // disambiguate crossing lines, so a route tap that covers several
        // distinct trains hands the full candidate set to the app for an
        // explicit choice instead of silently taking the query's first line.
        // A sticky hit means the fan/hover already disambiguated; marker taps
        // are precise by nature.
        if (
          hit.kind === "route" &&
          !hit.sticky &&
          coarsePointer.matches &&
          self._handlers.onRouteChoices
        ) {
          const box = [
            [e.point.x - TOUCH_ROUTE_PAD_PX, e.point.y - TOUCH_ROUTE_PAD_PX],
            [e.point.x + TOUCH_ROUTE_PAD_PX, e.point.y + TOUCH_ROUTE_PAD_PX],
          ];
          const layers = self
            ._fanPickLayerIds()
            .concat(TRAIN_PICK_LAYER)
            .filter((id) => map.getLayer(id));
          const seenTids = new Set();
          const candidates = [];
          map.queryRenderedFeatures(box, { layers }).forEach((f) => {
            const rec = self._records[f.properties.idx];
            if (!rec || !rec.train || seenTids.has(rec.train.id)) return;
            seenTids.add(rec.train.id);
            candidates.push(rec);
          });
          if (candidates.length > 1) {
            self._handlers.onRouteChoices({
              records: candidates,
              coordinate: [e.lngLat.lng, e.lngLat.lat],
            });
            return;
          }
        }
        const info = {
          object: hit.record,
          coordinate: [e.lngLat.lng, e.lngLat.lat],
        };
        if (hit.kind === "marker") {
          if (self._handlers.onMarkerClick) self._handlers.onMarkerClick(info);
        } else if (self._handlers.onClick) {
          self._handlers.onClick(info);
        }
      });

      // Coalesce hover work to one pass per animation frame. mousemove can
      // fire at 120+ Hz on high-refresh pointing devices while each pass costs
      // rendered-feature queries + tooltip DOM writes — frame-scale
      // work. Only the latest pointer position matters, so intermediate events
      // are dropped instead of queued.
      const processHover = () => {
        self._hoverRafId = null;
        const point = self._pendingHoverPoint;
        if (!point) return;
        // STICKY HOVER: while the pointer is still on the hovered line (or
        // an open fan's lanes / their station dots), lines crossing beneath
        // it are unpickable — queryAt only surfaces them once the pointer
        // has actually left the sticky geometry.
        const stickyBefore = currentStickyTids();
        let hit = queryAt(point, true, stickyBefore);
        let id = hit && hit.record.train ? hit.record.train.id : null;
        // Snapshot the GENUINE geometric pick before the endpoint / fan
        // hysteresis below can replace `hit` with a synthesized tooltip
        // record. The hold anchor (_lastGroupPoint) must only advance on a
        // REAL corridor touch — see the anchor update further down. Advancing
        // it on a hysteresis HOLD made the fan-hold radius measure from the
        // CURRENT pointer every frame, so a slow drift (each step < the hold
        // radius) re-anchored forever and the fan trailed the pointer across
        // the screen, never releasing; a fast flick (one step past the radius)
        // collapsed normally. Gating on the raw hit restores a fixed release.
        const rawHit = hit;
        // Hover-expand: pointer on an overlapped run fans that group's lines
        // out into their date-ordered lanes; empty ground collapses. Marker
        // hits (station dots take pick precedence) keep the current state so
        // sweeping along an expanded fan doesn't flicker at every station.
        // Group under the pointer BEFORE hysteresis: an overlapped route run
        // gives its groupKey; a station dot keeps the current fan; a thin line
        // or blank ground gives none.
        const rawGroup =
          hit && hit.kind === "route"
            ? hit.record.overlapCount > 1
              ? hit.record.groupKey || null
              : null
            : hit && hit.kind === "marker"
              ? self._expandedGroup
              : null;
        let group = rawGroup;
        let endpointHeld = false;
        // ENDPOINT GROUP HYSTERESIS: do not switch on the first sample from an
        // adjacent group. Keep the current configuration until the pointer has
        // travelled clearly into the candidate interval; returning to the old
        // group cancels the candidate immediately.
        if (
          group &&
          self._expandedGroup &&
          group !== self._expandedGroup
        ) {
          if (self._groupSwitchCandidate !== group) {
            self._groupSwitchCandidate = group;
            self._groupSwitchAnchor = { x: point.x, y: point.y };
            group = self._expandedGroup;
            endpointHeld = true;
          } else if (self._groupSwitchAnchor) {
            const sx = point.x - self._groupSwitchAnchor.x;
            const sy = point.y - self._groupSwitchAnchor.y;
            if (
              sx * sx + sy * sy <
              HOVER_GROUP_SWITCH_PX * HOVER_GROUP_SWITCH_PX
            ) {
              group = self._expandedGroup;
              endpointHeld = true;
            } else {
              self._groupSwitchCandidate = null;
              self._groupSwitchAnchor = null;
            }
          }
        } else if (group === self._expandedGroup) {
          self._groupSwitchCandidate = null;
          self._groupSwitchAnchor = null;
        }
        // Keep the hovered lane/tooltip stable inside the same deadzone. The
        // raw feature may belong to the neighbouring group even though the
        // visible fan intentionally still represents the current one.
        if (
          endpointHeld &&
          self._tooltipRecord &&
          self._tooltipRecord.groupKey === group
        ) {
          hit = { kind: "route", record: self._tooltipRecord, sticky: true };
          id = self._tooltipRecord.train
            ? self._tooltipRecord.train.id
            : null;
        }
        // FAN HYSTERESIS: a hair-thin mismatched sliver inside a shared
        // corridor (or a pick seam between two runs) momentarily resolves to no
        // group. Don't collapse the open fan for it — hold the current group
        // while the pointer is still on a member train (or just barely off it)
        // AND within FAN_HOLD_PX of the last real group hit. Following a member
        // train genuinely OFF the corridor travels past that radius and
        // collapses as usual. The app-side bridge removes most such slivers;
        // this also covers pick seams and gaps longer than the bridge limit.
        if (!group && self._expandedGroup && self._lastGroupPoint) {
          const onMember =
            hit && hit.kind === "route" && id && self._expandedTids.includes(id);
          if (onMember || !hit) {
            const dx = point.x - self._lastGroupPoint.x;
            const dy = point.y - self._lastGroupPoint.y;
            if (
              dx * dx + dy * dy <=
              HOVER_FAN_HOLD_PX * HOVER_FAN_HOLD_PX
            ) {
              group = self._expandedGroup;
              if (
                self._tooltipRecord &&
                self._tooltipRecord.groupKey === group
              ) {
                hit = {
                  kind: "route",
                  record: self._tooltipRecord,
                  sticky: true,
                };
                id = self._tooltipRecord.train
                  ? self._tooltipRecord.train.id
                  : null;
              }
            }
          }
        }
        // Anchor the hold radius at the latest REAL overlapped-run hit for the
        // group that is (now) open; clear it once the fan is genuinely down so a
        // later re-entry starts fresh. Marker holds and hysteresis holds
        // deliberately leave it put (rawHit, not the possibly-rewritten hit, so
        // a synthesized hold record can't re-anchor), so the radius measures
        // travel since the pointer last truly touched the corridor.
        if (
          rawHit &&
          rawHit.kind === "route" &&
          rawHit.record.overlapCount > 1 &&
          group &&
          (rawHit.record.groupKey || null) === group
        )
          self._lastGroupPoint = { x: point.x, y: point.y };
        else if (!group) {
          self._lastGroupPoint = null;
          self._groupSwitchCandidate = null;
          self._groupSwitchAnchor = null;
        }
        // Dynamic fan direction: perpendicular of the corridor's smoothed
        // curve at the pointer position (eases while sliding along the
        // corridor). Must be set BEFORE _setExpandedGroup so a fresh fan
        // opens along the correct axis.
        if (group) self._setFanDirTarget(group, map.unproject(point));
        self._setExpandedGroup(group);
        if (id !== self._hoverTrainId) {
          self._hoverTrainId = id;
          self._applyHoverFilter();
          if (self._handlers.onHover) self._handlers.onHover(id);
        }
        map.getCanvas().style.cursor = hit ? "pointer" : "";
        self._pushHoverRegions({
          point: { x: point.x, y: point.y },
          routePadPx: stickyBefore
            ? HOVER_STICKY_PAD_PX
            : HOVER_PICK_PAD_PX,
          holdPoint:
            self._expandedGroup && self._lastGroupPoint
              ? { x: self._lastGroupPoint.x, y: self._lastGroupPoint.y }
              : null,
          switchPoint: self._groupSwitchAnchor
            ? { x: self._groupSwitchAnchor.x, y: self._groupSwitchAnchor.y }
            : null,
        });
        self._showTooltip(hit, point);
        self._maybeStationPopup(hit ? null : point);
      };
      map.on("mousemove", (e) => {
        self._pendingHoverPoint = e.point;
        if (self._hoverRafId === null || self._hoverRafId === undefined)
          self._hoverRafId = requestAnimationFrame(processHover);
      });
      map.getCanvas().addEventListener("mouseleave", () => {
        self._pendingHoverPoint = null;
        if (self._hoverRafId !== null && self._hoverRafId !== undefined) {
          cancelAnimationFrame(self._hoverRafId);
          self._hoverRafId = null;
        }
        self._setExpandedGroup(null);
        self._lastGroupPoint = null;
        self._groupSwitchCandidate = null;
        self._groupSwitchAnchor = null;
        self._fanCurve = null;
        self._fanCurveS = null;
        self._fanCurveSign = 1;
        self._pushHoverRegions(null);
        if (self._hoverTrainId !== null) {
          self._hoverTrainId = null;
          self._applyHoverFilter();
          if (self._handlers.onHover) self._handlers.onHover(null);
        }
        self._showTooltip(null);
        self._removeStationPopup();
      });
    },

    // Floating tooltip fed by the app's getTooltip handler (same contract as
    // the deck.gl getTooltip: {html, style} or null). A result that also
    // carries anchorLngLat ([lng, lat]) renders as a station-anchored
    // maplibre Popup — the same presentation as the C5 network-station
    // railprint popup (auto-flipping anchor, tip arrow, popup CSS) — instead
    // of the cursor-following div, which clips at viewport edges.
    _showTooltip(hit, point) {
      const map = this._map;
      if (!this._tooltipEl) {
        const el = document.createElement("div");
        el.className = "railmap-tooltip";
        el.style.cssText =
          "position:absolute;left:0;top:0;z-index:30;pointer-events:none;display:none;will-change:transform;";
        map.getContainer().appendChild(el);
        this._tooltipEl = el;
      }
      const el = this._tooltipEl;
      const record = hit ? hit.record : null;
      // Same hovered record as last time: the HTML can't have changed (it is
      // derived from the record alone), so just follow the pointer instead of
      // re-running getTooltip + innerHTML on every movement. An anchored
      // popup stays put — it is pinned to the station, not the pointer.
      if (record === this._tooltipRecord) {
        if (this._markerPopup) return;
        if (record && point && el.style.display !== "none")
          this._placeTooltip(point);
        return;
      }
      this._tooltipRecord = record;
      const tip =
        record && this._handlers.getTooltip
          ? this._handlers.getTooltip({ object: record })
          : null;
      if (!tip) {
        el.style.display = "none";
        this._removeMarkerPopup();
        return;
      }
      const gl = global.maplibregl;
      if (tip.anchorLngLat && gl) {
        el.style.display = "none";
        if (!this._markerPopup) {
          this._markerPopup = new gl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 10,
            maxWidth: "260px",
          });
        }
        this._markerPopup
          .setLngLat(tip.anchorLngLat)
          .setHTML(tip.html || "")
          .addTo(map);
        return;
      }
      this._removeMarkerPopup();
      el.innerHTML = tip.html || "";
      const st = tip.style || {};
      for (const k of Object.keys(st)) el.style[k] = st[k];
      el.style.display = "block";
      this._placeTooltip(point);
    },

    // Keep the cursor tooltip inside the map container: flip it to the other
    // side of the pointer when the default below-right placement would run
    // off the right/bottom edge (the clipping bug this replaces).
    _placeTooltip(point) {
      const el = this._tooltipEl;
      if (!el || !point) return;
      const c = this._map.getContainer();
      let x = point.x + 12;
      let y = point.y + 12;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (x + w > c.clientWidth - 4) x = Math.max(4, point.x - w - 12);
      if (y + h > c.clientHeight - 4) y = Math.max(4, point.y - h - 12);
      el.style.transform = "translate(" + x + "px," + y + "px)";
    },

    _removeMarkerPopup() {
      if (this._markerPopup) {
        this._markerPopup.remove();
        this._markerPopup = null;
      }
    },

    // C5 — bilingual hover popup on the NETWORK station dots (only when the
    // pointer isn't on a train route/marker, which take precedence).
    _maybeStationPopup(point) {
      const map = this._map;
      if (!point || !this._network || !map.getLayer(STATIONS_LAYER)) {
        this._removeStationPopup();
        return;
      }
      // The network stations layer is OFF by default; getLayer() still finds a
      // hidden layer, so without this guard every idle mousemove paid a
      // queryRenderedFeatures against a layer that can never be hovered.
      if (map.getLayoutProperty(STATIONS_LAYER, "visibility") === "none") {
        this._removeStationPopup();
        return;
      }
      const feats = map.queryRenderedFeatures(point, { layers: [STATIONS_LAYER] });
      if (!feats.length) {
        this._removeStationPopup();
        return;
      }
      const p = feats[0].properties;
      // Same station as the popup already showing: skip the model rebuild +
      // setHTML + addTo churn (this used to run on every mousemove pixel).
      const popupKey = p.stationId + "|" + (p.lineId || "");
      if (this._stationPopup && this._stationPopupKey === popupKey) {
        map.getCanvas().style.cursor = "default";
        return;
      }
      const model = buildPopupModel(this._network, p.stationId, p.lineId);
      if (!model) return;
      const gl = global.maplibregl;
      if (!gl) return;
      if (!this._stationPopup) {
        this._stationPopup = new gl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 10,
          maxWidth: "260px",
        });
      }
      map.getCanvas().style.cursor = "default";
      this._stationPopupKey = popupKey;
      this._stationPopup
        .setLngLat(feats[0].geometry.coordinates)
        .setHTML(stationPopupHtml(model))
        .addTo(map);
    },
    _removeStationPopup() {
      this._stationPopupKey = null;
      if (this._stationPopup) this._stationPopup.remove();
    },
  });
})(window);
