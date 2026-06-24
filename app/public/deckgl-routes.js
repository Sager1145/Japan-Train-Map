/*
 * deckgl-routes.js — GPU route rendering overlay for the N02 Train Manager.
 *
 * WHY THIS EXISTS
 * ---------------
 * The train routes are the one map layer that cannot be baked into static
 * raster tiles (they are user-editable), so they stayed as live Leaflet SVG
 * paths. At country zoom that means re-projecting ~176k points and re-recording
 * the SVG paint list on every zoom — the last remaining gesture stall.
 *
 * This module renders those same routes in a single deck.gl PathLayer on the
 * GPU. Re-projection happens in a vertex shader, so zoom/pan stay at 60fps
 * regardless of point count. It is a drop-in: the existing data pipeline,
 * train store, overlap logic, and stop/pass-through markers are untouched.
 *
 * It depends only on two globals already loaded by index.html:
 *   - L     (Leaflet 1.9)
 *   - deck  (deck.gl 9 standalone UMD bundle: Deck, PathLayer, PathStyleExtension)
 *
 * No bundler required. The Leaflet<->deck bridge below is a self-contained
 * reimplementation of the deck.gl-leaflet LeafletLayer (which ships ESM-only).
 */
(function (global) {
  "use strict";
  const L = global.L;
  const deck = global.deck;
  if (!L || !deck || !deck.Deck) {
    console.warn(
      "[deckgl-routes] Leaflet or deck.gl not present; GPU route overlay disabled.",
    );
    global.DeckRoutes = {
      available: false,
      attach() {},
      setData() {},
      setVisible() {},
    };
    return;
  }

  // --- Leaflet <-> deck.gl bridge -------------------------------------------
  // A deck.Deck rendered into a div inside a Leaflet pane, with its viewState
  // kept in lockstep with the Leaflet map (pan = container offset, zoom = CSS
  // transform during the animation, exact reproject on settle).
  const DeckLeafletLayer = L.Layer.extend({
    initialize: function (props, paneName) {
      this.props = props || {};
      this._paneName = paneName || "overlayPane";
      this._deck = null;
      this._container = null;
    },
    getPane: function () {
      return (
        (this._map && this._map.getPane(this._paneName)) ||
        (this._map && this._map.getPane("overlayPane"))
      );
    },
    _viewState: function () {
      const c = this._map.getCenter();
      // Leaflet zoom is 256px-tile based; deck's web-mercator view is the same
      // convention shifted by one (its "zoom 0" shows the whole world in 512px).
      return {
        longitude: c.lng,
        latitude: c.lat,
        zoom: this._map.getZoom() - 1,
        pitch: 0,
        bearing: 0,
      };
    },
    onAdd: function () {
      const pane = this.getPane();
      if (!pane) return this;
      this._zoomAnimated = this._map._zoomAnimated && L.Browser.any3d;
      this._container = L.DomUtil.create("div");
      this._container.className = "leaflet-layer";
      if (this._zoomAnimated)
        L.DomUtil.addClass(this._container, "leaflet-zoom-animated");
      pane.appendChild(this._container);
      this._deck = new deck.Deck(
        Object.assign({}, this.props, {
          parent: this._container,
          controller: false, // Leaflet owns navigation; deck only draws + picks
          style: { zIndex: "auto" },
          viewState: this._viewState(),
        }),
      );
      this._update();
      return this;
    },
    onRemove: function () {
      if (this._container) {
        L.DomUtil.remove(this._container);
        this._container = null;
      }
      if (this._deck) {
        this._deck.finalize();
        this._deck = null;
      }
      return this;
    },
    getEvents: function () {
      const ev = {
        viewreset: this._reset,
        movestart: this._noop,
        moveend: this._update,
        zoom: this._onZoom,
        zoomend: this._update,
      };
      if (this._zoomAnimated) ev.zoomanim = this._onAnimZoom;
      return ev;
    },
    setProps: function (props) {
      Object.assign(this.props, props);
      if (this._deck) this._deck.setProps(props);
    },
    _noop: function () {},
    _update: function () {
      if (!this._container || !this._deck) return;
      if (this._map._animatingZoom) return;
      const size = this._map.getSize();
      this._container.style.width = size.x + "px";
      this._container.style.height = size.y + "px";
      const offset = this._map._getMapPanePos().multiplyBy(-1);
      L.DomUtil.setPosition(this._container, offset);
      this._deck.setProps({ viewState: this._viewState() });
      this._deck.redraw();
    },
    _reset: function () {
      this._updateTransform(this._map.getCenter(), this._map.getZoom());
      this._update();
    },
    _onZoom: function () {
      this._updateTransform(this._map.getCenter(), this._map.getZoom());
    },
    _onAnimZoom: function (e) {
      this._updateTransform(e.center, e.zoom);
    },
    // Reproduce Leaflet's own zoom-animation transform on the deck container so
    // the GPU layer scales/translates in sync with the tiles during the zoom
    // tween, then _update() snaps it to the exact projection on zoomend.
    _updateTransform: function (center, zoom) {
      if (!this._container) return;
      const map = this._map;
      const scale = map.getZoomScale(zoom, map.getZoom());
      const position = L.DomUtil.getPosition(this._container);
      const viewHalf = map.getSize().multiplyBy(0.5);
      const currentCenterPoint = map.project(map.getCenter(), zoom);
      const destCenterPoint = map.project(center, zoom);
      const centerOffset = destCenterPoint.subtract(currentCenterPoint);
      const topLeftOffset = viewHalf
        .multiplyBy(-scale)
        .add(position)
        .add(viewHalf)
        .subtract(centerOffset);
      if (L.Browser.any3d)
        L.DomUtil.setTransform(this._container, topLeftOffset, scale);
      else L.DomUtil.setPosition(this._container, topLeftOffset);
    },
    pickObject: function (opts) {
      return this._deck ? this._deck.pickObject(opts) : null;
    },
  });

  // --- Route overlay manager -------------------------------------------------
  const PANE = "deckRoutes";
  const hasDashExt = typeof deck.PathStyleExtension === "function";

  const DeckRoutes = {
    available: true,
    layer: null,
    _map: null,
    _records: [],
    _markers: [],
    _visible: true,
    _markerVis: { stop: true, pass: true },
    _handlers: {},
    _hoverTrainId: null,
    _selectedTrainId: null,
    // Cached DATA arrays with stable references. deck.gl only recomputes a
    // layer's GPU attributes when its `data` reference changes, so keeping these
    // arrays stable means a hover (which only changes _highlightData) leaves the
    // big route + marker layers' attributes untouched — no re-upload. Fresh
    // layer instances are still created each compose (the idiomatic deck pattern).
    _routeData: [],
    _markerData: [],
    _highlightData: [],
    _selectedData: [],
    // Markers split by selection: the selected train's circles sit ON TOP of its
    // own (raised) route, while every other train's circles sit UNDER it — so the
    // selected line cleanly covers other lines' station circles.
    _baseMarkerData: [],
    _selMarkerData: [],

    attach: function (map, handlers) {
      this._map = map;
      this._handlers = handlers || {};
      // Custom pane below overlayPane (z 400) so Leaflet popups/controls layer
      // correctly above the GPU canvas.
      if (!map.getPane(PANE)) {
        const p = map.createPane(PANE);
        p.style.zIndex = 350;
      }
      const self = this;
      this.layer = new DeckLeafletLayer(
        {
          layers: [],
          useDevicePixels: true,
          getCursor: function (s) {
            return s.isHovering ? "pointer" : "inherit";
          },
          onClick: function (info) {
            self._onClick(info);
          },
          onHover: function (info) {
            self._onHover(info);
          },
        },
        PANE,
      );
      this.layer.addTo(map);
      return this;
    },

    setVisible: function (v) {
      this._visible = !!v;
      this._recomputeRouteData();
      this._recomputeHighlightData();
      this._compose();
    },

    setData: function (records) {
      this._records = records || [];
      this._recomputeRouteData();
      this._recomputeHighlightData();
      this._recomputeSelectedData();
      this._compose();
    },

    setSelected: function (id) {
      if (id === this._selectedTrainId) return;
      this._selectedTrainId = id || null;
      this._recomputeSelectedData();
      this._recomputeMarkerSplit();
      this._compose();
    },

    setMarkers: function (records) {
      this._markers = records || [];
      this._recomputeMarkerData();
      this._compose();
    },

    setMarkerVisibility: function (category, v) {
      this._markerVis[category] = !!v;
      this._recomputeMarkerData();
      this._compose();
    },

    _recomputeRouteData: function () {
      this._routeData = this._visible ? this._records : [];
    },

    _recomputeMarkerData: function () {
      const self = this;
      this._markerData = this._markers.filter(function (m) {
        return self._markerVis[m.category] !== false;
      });
      this._recomputeMarkerSplit();
    },

    _recomputeMarkerSplit: function () {
      const sel = this._selectedTrainId;
      if (!sel) {
        this._baseMarkerData = this._markerData;
        this._selMarkerData = [];
        return;
      }
      this._baseMarkerData = this._markerData.filter(function (m) {
        return !m.train || m.train.id !== sel;
      });
      this._selMarkerData = this._markerData.filter(function (m) {
        return m.train && m.train.id === sel;
      });
    },

    _recomputeHighlightData: function () {
      const id = this._hoverTrainId;
      this._highlightData =
        id && this._visible
          ? this._records.filter(function (r) {
              return r.train && r.train.id === id;
            })
          : [];
    },

    _recomputeSelectedData: function () {
      const id = this._selectedTrainId;
      this._selectedData =
        id && this._visible
          ? this._records.filter(function (r) {
              return r.train && r.train.id === id;
            })
          : [];
    },

    // Picked object carries `.category` for markers; route segments don't.
    _onClick: function (info) {
      if (!info || !info.object) return;
      if (info.object.category) {
        if (this._handlers.onMarkerClick) this._handlers.onMarkerClick(info);
      } else if (this._handlers.onClick) {
        this._handlers.onClick(info);
      }
    },

    // Hovering anywhere on a route OR a marker highlights that train's WHOLE
    // route. Early-return when the hovered train is unchanged, so moving along a
    // line does no work.
    _onHover: function (info) {
      const id =
        info && info.object && info.object.train ? info.object.train.id : null;
      if (id === this._hoverTrainId) return;
      this._hoverTrainId = id;
      this._recomputeHighlightData();
      this._compose();
    },

    _compose: function () {
      if (!this.layer) return;
      const self = this;
      const routeLayer = new deck.PathLayer({
        id: "train-routes",
        data: this._routeData,
        pickable: true,
        widthUnits: "pixels",
        widthMinPixels: 1.2,
        capRounded: true,
        jointRounded: true,
        getPath: function (d) {
          return d.path;
        },
        getColor: function (d) {
          return d.color;
        },
        getWidth: function (d) {
          return d.width;
        },
        parameters: { depthTest: false },
        // Dashed styling for non-ridden segments, matching the SVG "4 6" dash.
        extensions: hasDashExt
          ? [new deck.PathStyleExtension({ dash: true })]
          : [],
        getDashArray: hasDashExt
          ? function (d) {
              return d.dashed ? [4, 6] : [0, 0];
            }
          : undefined,
        dashJustified: false,
      });

      // The whole hovered route, drawn over the base routes: same geometry, full
      // opacity, wider, in the train's colour — so the entire line lights up.
      const highlightLayer = this._highlightData.length
        ? new deck.PathLayer({
            id: "train-routes-highlight",
            data: this._highlightData,
            pickable: false,
            widthUnits: "pixels",
            widthMinPixels: 3,
            capRounded: true,
            jointRounded: true,
            getPath: function (d) {
              return d.path;
            },
            getColor: function (d) {
              return [d.color[0], d.color[1], d.color[2], 255];
            },
            getWidth: function (d) {
              return d.width + 4;
            },
            parameters: { depthTest: false },
          })
        : null;

      // Selected route, raised above ALL other routes. A white casing + the
      // train's colour on top (transit-map style) makes the clicked line read
      // as floating above the rest, regardless of intra-layer draw order.
      const selCasingLayer = this._selectedData.length
        ? new deck.PathLayer({
            id: "train-routes-selected-casing",
            data: this._selectedData,
            pickable: false,
            widthUnits: "pixels",
            widthMinPixels: 5,
            capRounded: true,
            jointRounded: true,
            getPath: function (d) {
              return d.path;
            },
            getColor: function () {
              return [255, 255, 255, 235];
            },
            getWidth: function (d) {
              return d.width + 8;
            },
            parameters: { depthTest: false },
          })
        : null;
      const selLayer = this._selectedData.length
        ? new deck.PathLayer({
            id: "train-routes-selected",
            data: this._selectedData,
            pickable: false,
            widthUnits: "pixels",
            widthMinPixels: 3,
            capRounded: true,
            jointRounded: true,
            getPath: function (d) {
              return d.path;
            },
            getColor: function (d) {
              return [d.color[0], d.color[1], d.color[2], 255];
            },
            getWidth: function (d) {
              return d.width + 3;
            },
            parameters: { depthTest: false },
          })
        : null;

      // Stop + pass-through markers. radius/lineWidth in screen pixels, so they
      // stay constant size across zoom exactly like the Leaflet circles they
      // replace. Split into two layers so the selected route can sit BETWEEN
      // them: other trains' circles below it, the selected train's own circles
      // above it.
      function makeMarkerLayer(id, data) {
        return new deck.ScatterplotLayer({
          id: id,
          data: data,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: "pixels",
          lineWidthUnits: "pixels",
          radiusMinPixels: 1,
          getPosition: function (d) {
            return d.position;
          },
          getRadius: function (d) {
            return d.radius;
          },
          getFillColor: function (d) {
            return d.fillColor;
          },
          getLineColor: function (d) {
            return d.lineColor;
          },
          getLineWidth: function (d) {
            return d.lineWidth;
          },
          parameters: { depthTest: false },
        });
      }
      const baseMarkerLayer = makeMarkerLayer(
        "train-markers",
        this._baseMarkerData,
      );
      const selMarkerLayer = this._selMarkerData.length
        ? makeMarkerLayer("train-markers-selected", this._selMarkerData)
        : null;

      // Order (bottom -> top): all routes, hover highlight, other trains'
      // station circles, selected casing, selected line, then the selected
      // train's own circles on top. => the selected line covers other lines'
      // circles, but its own stops stay visible.
      const layers = [routeLayer];
      if (highlightLayer) layers.push(highlightLayer);
      layers.push(baseMarkerLayer);
      if (selCasingLayer) layers.push(selCasingLayer);
      if (selLayer) layers.push(selLayer);
      if (selMarkerLayer) layers.push(selMarkerLayer);
      this.layer.setProps({ layers: layers });
    },
  };

  global.DeckRoutes = DeckRoutes;
})(window);
