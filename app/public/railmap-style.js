/*
 * railmap-style.js — the visual style layer of the RailMap core.
 *
 * railprint's design tokens (tokens.ts), the shared MapLibre source/layer
 * ids, the hover/selection spotlight constants, the marker circle paint
 * builders, and buildBaseStyle (style.ts): the full map style with the N02
 * network in official line colors, the ridden-train and selection layers,
 * and the fit-curve / hover-region debug layers, optionally over a
 * namespaced basemap.
 *
 * Publishes the RailMapStyle global (consumed by railmap-geometry.js,
 * railmap.js and railmap-interactions.js).
 */
(function (global) {
  "use strict";

  const { MAP_SURFACE_COLORS, namespaceBasemap } = global.RailMapBasemap;

  const DEFAULT_LINE_COLOR = global.RailNetwork.DEFAULT_LINE_COLOR;

  // ─────────────────────── railway style tokens (screen space) ───────────────────────
  // ONE place decides how heavy the railway reads. Every number here is CSS
  // pixels ON SCREEN, at EVERY zoom — not a size at some reference zoom that
  // something else scales. Widths expressed in map units (metres or mercator
  // units) are not an option: they make the network read as hairlines
  // nationwide and as ribbons in a city.
  //
  // The rail stroke is pinned to a FIXED FRACTION of the station circle it
  // threads, so the dots always read as beads on a wire rather than as blobs
  // on a thread — and because none of these is scaled by zoom on its way to
  // the paint properties, that ratio, and every other proportion here, holds
  // at every zoom by construction rather than by a ramp keeping them in step.
  // Apple Maps desktop Transit reference, measured 2026-08-12 against macOS
  // 「地圖」→ 大眾運輸 at 東京駅, city view (scale bar: 500 m across ~98 screenshot
  // px, i.e. ≈5.1 m per point, z≈13.7): an ordinary transit line reads at
  // about 2.8 pt and its station bead at about 6.2 pt, a ratio of ≈2.2, and
  // this file drew 3 px / 6 px against it until 2026-08-20.
  //
  // 2026-08-20 retune, by request: HALF that weight — for the STROKE ONLY.
  // Japan's network is four to six railways deep through every city Apple's
  // reference view never has to draw at once, and at 3 px the bundles welded
  // shut into bands of colour long before the lanes could separate them. The
  // stroke is now 1.5 px, deliberately BELOW Apple's measured band, while the
  // bead STAYS at the measured 6 px: the dot is how a reader finds a station,
  // and it was the line that was too heavy, not the station. That puts the
  // bead at four strokes rather than two — the one proportion in this file the
  // retune deliberately broke. Everything else here is a proportion of the
  // stroke, so halving it halved the drawn railway everywhere: keyline,
  // suspended dash, lane offsets and the rides above them.
  const STATION_DIAMETER_PX = 6;
  const RAIL_WIDTH_TO_STATION_DIAMETER = 0.25;
  const RAILWAY_STYLE = Object.freeze({
    // Diameter of an ordinary network station dot.
    stationDiameterPx: STATION_DIAMETER_PX,
    stationRadiusPx: STATION_DIAMETER_PX / 2,
    // Ring drawn around that dot so it stays legible over its own line. Held
    // at an eighth of the dot, the proportion Apple's bead/keyline pair reads
    // at — a ring that kept its absolute width while the dot shrank would
    // swallow the colour it is supposed to separate.
    stationRingPx: STATION_DIAMETER_PX / 8,
    // Rail stroke = a quarter of that. Derived, never set independently.
    railWidthToStationDiameter: RAIL_WIDTH_TO_STATION_DIAMETER,
    railWidthPx: STATION_DIAMETER_PX * RAIL_WIDTH_TO_STATION_DIAMETER,
    // The smallest radius a corner is allowed to PRESENT on screen, and so
    // the promise the source tolerance below is set to keep: where the
    // surveyed alignment turns on a curve at least this wide, the drawn line
    // still turns on a curve there rather than on one vertex.
    //
    // One stroke width, because the pen decides the floor. Every railway here
    // is drawn `line-join: round`, which rounds the OUTER edge of the stroke
    // to half its width about the vertex — so under W/2 there is nothing a
    // radius could add that the ink has not already drawn. At R = W the INNER
    // edge has radius W/2 too, both boundaries of the ink are arcs of the same
    // order, and a right angle's inner edge stands 0.414 × W/2 ≈ 0.62 px clear
    // of where the mitred apex would be — about 1.2 device pixels on a 2×
    // display, the first radius that is visible at all.
    //
    // A screen-space token like the rest, not an absolute pixel count: it
    // rides railwayScale() with the stroke it is a multiple of, so the
    // proportion a reader actually judges — how round the corner is against
    // how wide the line is — is the same at z6 as at z18.
    // scripts/validation/validate-corner-radius.mjs measures the drawn
    // corners against this number, the way validate-railway-topology.mjs
    // measures real corridors against parallelGapPx.
    minCornerRadiusPx: STATION_DIAMETER_PX * RAIL_WIDTH_TO_STATION_DIAMETER,
    // The clear map a reader sees between two DISTINCT railways that share one
    // corridor, edge to edge. Half of the lane contract — centre-to-centre is
    // railWidthPx + this (parallelLaneCentreDistancePx) — and the number
    // scripts/validation/validate-railway-topology.mjs measures the real corridors
    // against. Screen-space like everything else here: this many pixels at z6
    // and the same many at z18. Deliberately NOT halved with the stroke in the
    // 2026-08-20 retune: this is the clear map the eye needs to read two
    // railways as two, and a finer line needs no less of it than a fat one.
    parallelGapPx: 1.2,
    // A quiet edge on either side of the coloured core separates railways
    // from roads and from one another without turning them into glowing
    // selection strokes. This is the full-scale edge width on ONE side, held
    // at a fifth of the core so the halved stroke halves ink and all.
    networkCasingEdgePx: 0.3,
    // Selected rides use the same restrained edge rhythm. The previous halo
    // was more than twice the coloured line's total width.
    selectionCasingEdgePx: 0.7,
    // How near a junction the geometry pipeline must stop grooming.
    junctionProtectionPx: 6,
  });

  // ───────────────── how far off the surveyed line the map may draw ─────────────────
  // MapLibre runs every GeoJSON source through geojson-vt, which scores each
  // vertex once and then, per zoom, keeps only those whose score clears
  // `tolerance` CSS PIXELS. The number is therefore not a quality dial: it is
  // literally how far the drawn line is allowed off the track it stands for,
  // and — because Douglas–Peucker keeps the point that deviates MOST and drops
  // the transition points either side of it — how much CURVE the map is
  // allowed to spend on a single vertex. Generalisation does not roughen an
  // arc, it replaces the arc with its extremal polyline; pull far enough back
  // and a surveyed 400 m curve is drawn as one kink.
  //
  // So the setting follows from minCornerRadiusPx above. An arc of radius R
  // turning Θ, reduced to the two chords that meet at its apex, still stands
  //
  //     R × (1 − cos(Θ/4))
  //
  // off the arc, and the simplifier keeps a vertex only when it stands off by
  // more than the tolerance. At the shape a reader calls a corner — Θ = 90° —
  // and at the tightest radius the map promises to show — R = one stroke,
  // 1.5 px since the 2026-08-20 retune halved it — that is
  // 1.5 × 0.0761 = 0.114 px. Any tolerance at or above it lets a right angle
  // of the smallest promised radius be drawn as a bare kink. The promise
  // travels with the pen: derive this from railWidthPx, never from a
  // remembered pixel count, or a later retune quietly breaks it.
  //
  // geojson-vt is not quite Douglas–Peucker, either: a vertex's score is its
  // distance to the chord of the sub-range that its own recursion split, not
  // to the coarser chord that actually survives, so scores UNDER-state and
  // vertices a true DP would keep get dropped. Measured across all five
  // packages by scripts/validation/validate-corner-radius.mjs, the drawn line
  // runs up to 1.6× the nominal tolerance off the surveyed one, which puts the
  // usable ceiling at 0.114 / 1.6 = 0.071 px. A sixteenth of a pixel is the
  // clean binary fraction under it, and measurement agrees with the algebra:
  // at half a pixel the five packages hand thousands of visible curves to a
  // single vertex, at 0.125 px 612, and at 0.0625 px twelve — every one of
  // them a 30–36° bend on z6 or z8 where the alignment itself turns 23–37°,
  // so the drawn line is not inventing a corner sharper than the ground, only
  // spending a wide bend on one vertex. The drawn line's worst offset from the
  // surveyed one falls with it, 0.80 px → 0.11 px.
  //
  // Going one step finer clears those twelve, and is still rejected: 0.03125
  // buys them with 16% more vertices everywhere while sitting BELOW what the
  // promise asks for. The tolerance is set by the radius the map promises,
  // not by driving a residue count to zero.
  // 姨捨's switchback, whose out-and-back is 174 m, is drawn as a switchback
  // from z10 rather than from z12; below that the excursion is thinner than
  // the stroke and no setting can show it.
  //
  // The floor is a rendering limit, not a taste: at tolerance 0 geojson-vt
  // fed one z6 tile 155,574 vertices and MapLibre dropped it, which is the
  // blank square over Kanto that f0b845e was fixing when it reached for half
  // a pixel. A sixteenth leaves that tile at 9,720 — 3.4× today's 2,818 and
  // 16× clear of the count that broke.
  const SEGMENT_SIMPLIFY_TOLERANCE_PX = 0.0625;
  // The network under the map is a per-COUNTRY package (jp-2025 / tw-2025), so
  // the credit carried on its source is per-country too — crediting N02 for
  // Taiwanese geometry would be a false licence declaration. Japan's station
  // romanizations come from OSM and are credited with the network; Taiwan's
  // names ship inside the official TDX record, so no OSM credit applies there.
  // Keep each string in sync with the package's own .sources.md.
  const RAIL_ATTRIBUTIONS = {
    jp:
      "出典「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成 (CC BY 4.0)" +
      "｜Romanizations © OpenStreetMap contributors, ODbL",
    tw:
      "資料來源：交通部運輸資料流通服務（TDX/PTX）、內政部國土測繪中心、" +
      "農業部阿里山林業鐵路及文化資產管理處、臺北市政府捷運工程局，經加工製作" +
      "（政府資料開放授權條款第1版）",
    hk:
      "資料來源：香港鐵路有限公司官方行程指南及開放數據、" +
      "香港電車有限公司官方電車站開放數據，經加工製作" +
      "｜軌道幾何 © OpenStreetMap contributors, ODbL",
    mo:
      "資料來源：澳門輕軌股份有限公司官方路線及車站資料，經加工製作",
    kr:
      "자료: 국토교통부·국가철도공단·한국철도공사·서울교통공사 공공데이터" +
      "（이용허락범위 제한 없음）를 가공하여 제작" +
      "｜선로 기하 © OpenStreetMap contributors, ODbL",
  };
  function railAttributionForCountry(country) {
    return RAIL_ATTRIBUTIONS[country] || RAIL_ATTRIBUTIONS.jp;
  }

  // ───────────────────── ridden/unridden paint constants (style.ts) ──────────────────────
  // The "all railway lines" field draws at FULL opacity in the theme-specific
  // colour carried by the active country's rail package. The package keeps the
  // sourced hue and adjusts only lightness where the original would disappear
  // into this app's light or dark surface. Never blend again at paint time: the
  // audited HEX must remain the HEX MapLibre draws.
  const UNRIDDEN_OPACITY = 1;
  const RIDDEN_WIDTH_SCALE = 1.18;

  function featureLineColor(theme) {
    if (theme !== "dark")
      return ["coalesce", ["get", "color"], DEFAULT_LINE_COLOR];
    return [
      "coalesce",
      ["get", "colorDark"],
      ["get", "color"],
      DEFAULT_LINE_COLOR,
    ];
  }

  function networkLineColor(theme) {
    return featureLineColor(theme);
  }

  // Apple Maps uses a fine surface-coloured keyline around transit strokes.
  // Light gets a white separator; dark gets a near-black one. It is deliberately
  // opaque and narrow rather than blurred: crisp edges preserve parallel-lane
  // identity and avoid a neon/glow effect.
  function networkCasingColor(theme) {
    return theme === "dark" ? "rgb(7,8,10)" : "rgb(255,255,255)";
  }

  function networkCasingWidth() {
    return railwayScale(
      RAILWAY_STYLE.railWidthPx + RAILWAY_STYLE.networkCasingEdgePx * 2,
    );
  }

  // ─────────────────────── the one dash rhythm on the map ───────────────────────
  // MapLibre measures `line-dasharray` in LINE WIDTHS, not pixels, so the same
  // pair of numbers on two strokes of different weight draws two different
  // rhythms. This map already has one dash — the cross-day continuation of an
  // overnight train, [1.6, 1.4] on a DEFAULT_TRAIN_WEIGHT × 1.18 px stroke —
  // so the rhythm is fixed in PIXELS here and every dashed layer divides by
  // its own width to reach it. Two dashes that differed would read as two
  // meanings. The reference weight follows app-config.js's
  // DEFAULT_TRAIN_WEIGHT (2 since the 2026-08-20 half-weight retune): pinning
  // the rhythm in pixels keeps the two dashed layers in step with EACH OTHER,
  // but the mark:width proportion is what makes a dash read as a dash, and
  // that only holds if the reference moves when the strokes do.
  const DASH_RATIO = Object.freeze([1.6, 1.4]);
  const DASH_REFERENCE_WIDTH_PX = 2 * RIDDEN_WIDTH_SCALE;
  // ≈ 3.78 px on, 3.30 px off.
  const DASH_PX = Object.freeze(
    DASH_RATIO.map((ratio) => ratio * DASH_REFERENCE_WIDTH_PX),
  );

  // The dash pair for a stroke of `widthPx` at full scale. It needs no zoom
  // ramp of its own and must not have one: every railway width here is one
  // token times railwayScale(), so a dash expressed as a multiple of the width
  // is carried down by the same factor and the on:off:width proportion is the
  // same at z4 as at z18. The narrowest these lines are ever drawn is z4
  // (railwayScale 0.354, core 0.53 px), where the dash is still 1.34 px long —
  // and below that minZoomForLength has already taken them off the map.
  function dashArrayForWidth(widthPx) {
    return DASH_PX.map((px) => Number((px / widthPx).toFixed(4)));
  }
  // A casing is 1.4× the core, so an uncorrected pair would draw its dashes
  // 40% longer than the ink they surround and leave a grey tail hanging off
  // both ends of every dash. Dividing each layer by its OWN width locks the
  // two in phase.
  function networkSuspendedDash() {
    return dashArrayForWidth(RAILWAY_STYLE.railWidthPx);
  }
  function networkSuspendedCasingDash() {
    return dashArrayForWidth(
      RAILWAY_STYLE.railWidthPx + RAILWAY_STYLE.networkCasingEdgePx * 2,
    );
  }

  // ─────────────────── the railway's screen-space weight contract ───────────────────
  // Every railway weight — network stroke, network station dot, ridden route,
  // recorded-call marker, selection casing, and the lane a bundled railway
  // steps into — is ONE token above times ONE shared factor, railwayScale().
  // Nothing computes a ramp of its own, and nothing opts out.
  //
  // The tokens are the weights at FULL scale, and full scale is a property of
  // the MAP SCALE rather than of the zoom number: the railway draws at its
  // token weight wherever a CSS pixel is worth about
  // RAILWAY_FULL_WEIGHT_METERS_PER_PIXEL metres of ground or less, and thins
  // as the view pulls back past that. Taiwan's whole-island default view sits
  // exactly at that scale, and is the reference the rest of the map is
  // calibrated against. One fixed stroke for every scale was the alternative,
  // and what it produced was a Japan whose nationwide view — four times the
  // ground of Taiwan's, six hundred lines and every station of them — read as
  // a single fused mass of railway rather than as a network.
  //
  // Thinning with scale and keeping a parallel bundle legible are not in
  // conflict, so long as ONE factor drives every weight. A lane is
  //
  //     centreSpacingPx = (railWidthPx + parallelGapPx) × railwayScale(zoom)
  //
  // so the clear map a reader sees between two bundled railways is
  // parallelGapPx times the very factor that set the two strokes either side
  // of it: the proportion a reader actually judges — gap against stroke, rail
  // against station circle — never moves, at any zoom. What must never happen
  // is a ramp on ONE half of that sum: a width that thinned while the offset
  // held would fan the bundle into a ladder, an offset that shrank while the
  // width held would weld it into one stroke. So every weight and every offset
  // goes through railwayScale(). The contract tests evaluate the built style
  // across a spread of zooms to keep the proportions fixed.
  //
  // MapLibre hands the screen-space part over for free: line-width,
  // line-offset, circle-radius and line-translate are all in CSS pixels, so a
  // pixel number already IS a measurement the projection never touches. The
  // surveyed geometry stays in world coordinates and only the sideways step is
  // stated in pixels — the renderer re-derives it from the projected tangent
  // every frame, which is precisely why a lane cannot be pre-baked as a
  // geographic distance.
  //
  // Two things are deliberately NOT on the ramp, because neither is a mark:
  // the hit targets (the pick layers' line-width) and the hover fan's lane
  // spacing. A target that shrank with the map would make a line at a
  // nationwide view unclickable exactly when it is hardest to hit.
  //
  // Zoom also decides WHETHER something draws: minz gates whole lines with
  // their stations (lineLengthVisibilityOpacity) and the stop-dot LOD gates
  // intermediate calls (stopMarkerZoomGate). Choosing what to show at a scale
  // is still a different question from how heavily to draw it.

  // ───────────────────────── the map-scale weight ramp ─────────────────────────
  // MapLibre's 512 px tiles put the scale of a view at
  //
  //     metresPerPixel = 78271.52 × cos(latitude) / 2^zoom
  //
  // so a scale anchor IS a zoom, once a latitude is chosen. The anchor is
  // ≈500 m per CSS pixel — Taiwan's whole island beside the sidebar on a
  // desktop map, the view this calibration was read off — which at
  // mid-latitude (35°) is zoom 7. Every country here is mapped between 22°N
  // and 45°N, and across that whole span the same 500 m/px stays within a
  // quarter of a zoom level of 7: a 9% difference in stroke width, well under
  // what a reader could see. So ONE constant anchor serves all five countries
  // honestly, and it keeps the ramp a pure function of zoom that the built
  // style carries on its own — no re-anchoring on resize, on country switch,
  // or on anything else.
  const RAILWAY_FULL_WEIGHT_METERS_PER_PIXEL = 500;
  const RAILWAY_FULL_WEIGHT_ZOOM = 7;
  // Below the anchor the weight halves every TWO zoom levels. The ground area
  // on screen quadruples per level, so a weight that tracked it would be a
  // quarter of a pixel by the time a country fits; the square root thins the
  // network visibly while every line on it stays a line.
  const RAILWAY_WEIGHT_ZOOM_BASE = Math.SQRT2;
  // …and it stops thinning at a third of token weight. Past that the marks
  // stop being marks, and what a wider view needs from there on is the LOD
  // gates dropping lines and stations, not finer ones.
  const RAILWAY_MIN_WEIGHT_SCALE = 1 / 3;
  const RAILWAY_MIN_WEIGHT_ZOOM =
    RAILWAY_FULL_WEIGHT_ZOOM +
    Math.log2(RAILWAY_MIN_WEIGHT_SCALE) / Math.log2(RAILWAY_WEIGHT_ZOOM_BASE);

  // `value` is a weight in CSS px at full scale: a number, or a data-driven
  // expression yielding one. MapLibre accepts ["zoom"] only as the input of a
  // TOP-LEVEL step/interpolate, so the ramp has to wrap the data-driven part
  // rather than multiply it from inside. Two stops are the entire ramp: an
  // exponential interpolation with the ramp's own base reproduces
  // base^(zoom − anchor) EXACTLY between them, and MapLibre clamps to the end
  // values outside them — which is the floor at one end and, at the other,
  // the promise that zooming in past the anchor changes nothing at all.
  function railwayScale(value) {
    const at = (scale) =>
      typeof value === "number" ? value * scale : ["*", value, scale];
    return [
      "interpolate",
      ["exponential", RAILWAY_WEIGHT_ZOOM_BASE],
      ["zoom"],
      RAILWAY_MIN_WEIGHT_ZOOM,
      at(RAILWAY_MIN_WEIGHT_SCALE),
      RAILWAY_FULL_WEIGHT_ZOOM,
      at(1),
    ];
  }

  // A platform where ONE railway calls is a solid dot; a platform where two
  // meet is drawn open, its middle taking the ring colour so the circle reads
  // as a hole rather than a mark. Interchange-ness is counted in RAILWAYS, so
  // several services of one railway calling at a stop leave it solid.
  //
  // Both layers that draw platforms — the circle for a station on its own
  // alignment, the round-capped stub for one in a parallel lane — read the
  // same flag through these two, so the two can never disagree.
  function stationFill(theme) {
    const colors = MAP_SURFACE_COLORS[theme === "dark" ? "dark" : "light"];
    return [
      "case",
      ["==", ["get", "interchange"], 1],
      colors.stationRing,
      featureLineColor(theme),
    ];
  }

  function stationStroke(theme) {
    return [
      "case",
      ["==", ["get", "interchange"], 1],
      featureLineColor(theme),
      networkCasingColor(theme),
    ];
  }

  // ─────────────────────────── network label typography ───────────────────────────
  // Apple's Transit view names two things and nothing else: the STATION, in
  // the map's ordinary label ink beside its bead, and the LINE, written along
  // the line in the line's own colour. Both are text, not marks — so neither
  // rides railwayScale() (see the screen-space contract below: the ramp is for
  // marks; a label that shrank with the network would stop being readable
  // exactly when the network needed naming). They carry their own, much
  // shallower zoom ramp, the way every other label on the map does.
  const NETWORK_LABEL_FONT = ["Noto Sans Regular"];
  // Station names appear a little after the beads themselves; line names
  // later still, because a name written ALONG a line needs a run of line long
  // enough to hold it. Both are floors in addition to each feature's own minz.
  const STATION_LABEL_MIN_ZOOM = 12;
  const LINE_LABEL_MIN_ZOOM = 12;

  function networkLabelTextColor(theme) {
    return theme === "dark" ? "rgb(236,238,240)" : "rgb(28,30,32)";
  }
  function networkLabelHaloColor(theme) {
    return MAP_SURFACE_COLORS[theme === "dark" ? "dark" : "light"].background;
  }

  // A line's name in the line's own hue, pulled toward the label ink until it
  // is readable as TEXT rather than as a coloured smear: the pale end of an
  // operator palette (yellow, light green) is a fine 1.5 px stroke and an
  // illegible 10 px word. Same composite shape as networkLineColor, different
  // anchor — text needs contrast against the surface, a stroke needs identity.
  const LINE_LABEL_INK_STRENGTH = 0.55;
  function networkLineLabelColor(theme) {
    const ink = networkLabelTextColor(theme);
    const channel = (index) => [
      "+",
      ["*", ["at", index, ["var", "line"]], LINE_LABEL_INK_STRENGTH],
      ["*", ["at", index, ["var", "ink"]], 1 - LINE_LABEL_INK_STRENGTH],
    ];
    return [
      "let",
      "line",
      ["to-rgba", ["to-color", featureLineColor(theme)]],
      "ink",
      ["to-rgba", ["to-color", ink]],
      ["rgb", channel(0), channel(1), channel(2)],
    ];
  }

  // The two ridden weights. Every consumer — the layers below, the pooled fan
  // lanes railmap.js adds on demand, and the screen-weight table — builds from
  // these, so no two of them can drift apart. A ride is drawn INSIDE a lane,
  // so it rides the scale ramp for the same reason the lane does: a stroke
  // that held its width while the lane around it narrowed would spill over
  // the railway beside it.
  //
  // The per-record `width` is the 線路粗細 control's doing (app-style.js), so
  // what the ramp scales here is the reader's own chosen weight.
  function riddenLineWidth() {
    return railwayScale(["*", ["get", "width"], RIDDEN_WIDTH_SCALE]);
  }
  function riddenHoverLineWidth() {
    return railwayScale([
      "+",
      ["*", ["get", "width"], RIDDEN_WIDTH_SCALE],
      2,
    ]);
  }
  // …and the selected route's, which adds the focus boost at draw time rather
  // than baking it into every record (railmap.js setFocusBoost).
  function riddenFocusLineWidth(focusBoost) {
    const boost = Number(focusBoost) || 0;
    if (!boost) return riddenLineWidth();
    return railwayScale([
      "*",
      ["+", ["get", "width"], boost],
      RIDDEN_WIDTH_SCALE,
    ]);
  }
  function riddenSelectionCasingWidth() {
    return railwayScale([
      "+",
      ["*", ["get", "width"], RIDDEN_WIDTH_SCALE],
      RAILWAY_STYLE.selectionCasingEdgePx * 2,
    ]);
  }

  // The ramp's value at ONE zoom, for the sizes JS computes itself instead of
  // handing MapLibre an expression.
  function railwayScaleAt(zoom) {
    const z = Number(zoom);
    if (!isFinite(z)) return 1;
    return Math.min(
      1,
      Math.max(
        RAILWAY_MIN_WEIGHT_SCALE,
        Math.pow(RAILWAY_WEIGHT_ZOOM_BASE, z - RAILWAY_FULL_WEIGHT_ZOOM),
      ),
    );
  }

  // MapLibre permits the camera expression ["zoom"] only as the input of a
  // top-level step/interpolate expression. Each step then applies the line's
  // data-driven minz property at paint time, avoiding tile-parse filters while
  // keeping the entire line/station group on one integer zoom threshold.
  function lineLengthVisibilityOpacity(visibleOpacity) {
    const gate = (zoom) => [
      "case",
      ["<=", ["coalesce", ["get", "minz"], 0], zoom],
      visibleOpacity,
      0,
    ];
    const expression = ["step", ["zoom"], gate(0)];
    // Complete lines top out at z7, while dense intermediate stations can be
    // deferred as far as z14. Keep evaluating the per-feature threshold all
    // the way through that range; an unconditional z7 value would make every
    // dense station appear at once and defeat station decluttering.
    for (let zoom = 1; zoom <= 14; zoom += 1)
      expression.push(zoom, gate(zoom));
    return expression;
  }

  // The same per-feature minz gate, with a hard floor under it: a label has a
  // second condition its mark does not, which is that there be room to read
  // it. Below `floorZoom` the text is off outright; above it the feature's own
  // minz decides, exactly as it does for the dot the label belongs to — so a
  // name can never appear for a station that is itself still hidden.
  function labelVisibilityOpacity(floorZoom, visibleOpacity) {
    const floor = Math.max(0, Math.floor(Number(floorZoom) || 0));
    const gate = (zoom) => [
      "case",
      ["<=", ["coalesce", ["get", "minz"], 0], zoom],
      visibleOpacity,
      0,
    ];
    const expression = ["step", ["zoom"], 0];
    for (let zoom = floor; zoom <= 14; zoom += 1)
      expression.push(zoom, gate(zoom));
    return expression;
  }

  // ───────────────────────────── source / layer ids ─────────────────────────────
  const SEGMENTS_SOURCE = "rn-segments";
  const STATIONS_SOURCE = "rn-stations";
  // The elected station names — the same platform features `rn-stations`
  // carries, minus the ones whose complex is already named. A source of its
  // own rather than a filter, so the render model that feeds the DOTS is
  // untouched by anything the labels decide.
  const STATION_LABELS_SOURCE = "rn-station-labels";
  const SEGMENTS_LAYER = "rn-segments-line";
  const SEGMENTS_CASING_LAYER = "rn-segments-casing";
  // The same field, for the stretches of it that no longer carry passenger
  // trains — 肥薩線 八代—吉松, 美祢線, the BRT-ed 日田彦山線, 津軽線 蟹田—三厩,
  // 米坂線 今泉—坂町 …. Their own layer pair rather than a dasharray on the
  // field, for two reasons that both matter: `line-dasharray` has no value
  // meaning "solid", so one layer cannot mix the two; and putting a dash on
  // the field would push all 650-odd features onto the dashed-texture path
  // for the sake of six. The features they draw are cut to the ledger's own
  // station spans in rail-network.js — the condition the whole-line shortcut
  // in test/apple-maps-railway-contract.test.js was waiting on.
  const SEGMENTS_SUSPENDED_LAYER = "rn-segments-suspended-line";
  const SEGMENTS_SUSPENDED_CASING_LAYER = "rn-segments-suspended-casing";
  // Drawn only on the features rail-network.js flagged, and correspondingly
  // kept OFF the field's own three layers, so the two can never both claim a
  // metre of track.
  const IN_SERVICE_FILTER = ["!=", ["get", "suspended"], 1];
  const SUSPENDED_FILTER = ["==", ["get", "suspended"], 1];
  // One name per railway. rail-network.js marks the closed stroke of a line
  // that still has an open one; a wholly closed railway carries its own name.
  const SEGMENT_LABEL_FILTER = ["!=", ["get", "labelSuppressed"], 1];
  const STATIONS_LAYER = "rn-stations-dot";
  // The same dot for a platform whose line runs in a parallel lane. It cannot
  // be a circle — MapLibre has no per-feature circle offset — so it is an ICON
  // rotated to the bearing of the track under it and pushed sideways by
  // icon-offset. Because icon-offset is applied in the icon's own rotated
  // frame, "+x" is right of travel, which is the side line-offset calls
  // positive: the platform and its railway take the same lane by construction.
  //
  // It was a round-capped 30 cm line stub until it wasn't. A stub's WIDTH is a
  // screen constant but its LENGTH is metres of geometry, so it grew with the
  // zoom — 0.3 px long at z16, 20 px at z22 — and a platform that read as a
  // dot when the country was on screen read as a capsule once you were down at
  // a single station. An icon has no length to grow.
  // Names. Both are text-only symbol layers with no icon of any kind: a
  // station is named beside its bead, never replaced by one (see the station
  // glyph contract — no logo, no badge, at any zoom).
  const STATIONS_LABEL_LAYER = "rn-stations-label";
  const SEGMENTS_LABEL_LAYER = "rn-segments-label";
  const FADE_LAYER = "rp-fade";
  const TRAIN_ROUTES_SOURCE = "train-routes";
  const TRAIN_PICK_SOURCE = "train-routes-pick";
  const TRAIN_PICK_FAN_SOURCE = "train-routes-pick-fan";
  const TRAIN_EXPAND_SOURCE = "train-routes-expand-src";
  const TRAIN_MARKERS_SOURCE = "train-markers-base";
  const FIT_CURVES_SOURCE = "train-fit-curves-src";
  const HOVER_REGIONS_SOURCE = "train-hover-regions-src";
  const TRAIN_ROUTES_LAYER = "train-routes-line";
  // Cross-day continuation: the half of an overnight train that belongs to the
  // OTHER calendar day draws dashed instead of solid (same source, same
  // colour/width — only the stroke pattern says "not this day").
  const TRAIN_XDAY_LAYER = "train-routes-xday";
  const TRAIN_XDAY_STOP_LAYER = "train-xday-stop";
  const XDAY_ICON_ID = "railmap-xday-diamond";
  // A laned platform's marker, rasterized once per theme by railmap.js from
  // these same RAILWAY_STYLE constants — the fill diameter drawn at
  // STATION_ICON_BASE_PX and the ring outside it in the same proportion the
  // circle layer uses. `icon-size` scales that base to the real diameter, so
  // the drawn size stays readable from the built style instead of hiding in
  // the bitmap.
  const STATION_ICON_BASE_PX = 24;

  function stationIconId(theme, interchange, colorKey) {
    const key = /^[0-9a-f]{6}$/i.test(String(colorKey || ""))
      ? String(colorKey).toLowerCase()
      : DEFAULT_LINE_COLOR.slice(1).toLowerCase();
    return `rn-station-${theme === "dark" ? "dark" : "light"}-${key}${
      interchange ? "-interchange" : ""
    }`;
  }

  // Solid where one railway calls, open where two do — the same rule as the
  // circle layer's colour pair, expressed as a choice of bitmap because an
  // ordinary image carries its own colours.
  function stationIconImage(theme) {
    return [
      "concat",
      `rn-station-${theme === "dark" ? "dark" : "light"}-`,
      ["coalesce", ["get", "colorKey"], DEFAULT_LINE_COLOR.slice(1).toLowerCase()],
      ["case", ["==", ["get", "interchange"], 1], "-interchange", ""],
    ];
  }

  function stationIconSize() {
    return RAILWAY_STYLE.stationDiameterPx / STATION_ICON_BASE_PX;
  }
  const TRAIN_PICK_LAYER = "train-routes-pick-line";
  const TRAIN_PICK_FAN_LAYER = "train-routes-pick-fan-line";
  const TRAIN_EXPAND_LAYER = "train-routes-expand";
  const TRAIN_EXPAND_HOVER_LAYER = "train-routes-expand-hover";
  const TRAIN_HOVER_LAYER = "train-routes-hover";
  const TRAIN_SEL_CASING_LAYER = "train-routes-sel-casing";
  const TRAIN_SEL_LAYER = "train-routes-sel";
  const TRAIN_PASS_LAYER = "train-pass-dot";
  const TRAIN_STOPS_LAYER = "train-stops-dot";
  const TRAIN_SEL_PASS_LAYER = "train-sel-pass-dot";
  const TRAIN_SEL_STOPS_LAYER = "train-sel-stops-dot";
  const FIT_CURVES_CASING_LAYER = "train-fit-curves-casing";
  const FIT_CURVES_LAYER = "train-fit-curves-line";
  const HOVER_REGIONS_FILL_LAYER = "train-hover-regions-fill";
  const HOVER_REGIONS_LINE_LAYER = "train-hover-regions-line";

  // Every railway weight and every lane offset, in one table: buildBaseStyle
  // paints them from it and RailMap re-asserts them from it on attach. The two
  // invisible pick layers are deliberately absent from the WIDTHS — a hit
  // target is not a mark, and must not thin with the map — but the pick
  // layer's OFFSET is here, because a target left behind on the centre-line
  // while the line it targets steps into a lane is a target on empty map.
  //
  // Every value here goes through railwayScale(), and the ONE table is what
  // makes that checkable from the built style. It keeps every layer that draws
  // a bundled railway — the field, its station stubs, the rides over it, the
  // selection casing, the hover highlight and the hit target — carrying the
  // identical offset expression.
  const RAILWAY_SCREEN_PAINT = [
    // the "all railway lines" field
    [SEGMENTS_CASING_LAYER, "line-width", networkCasingWidth],
    [SEGMENTS_LAYER, "line-width", () => railwayScale(RAILWAY_STYLE.railWidthPx)],
    // …and the same field where it is no longer in service. Identical widths
    // on purpose: the dash is the whole difference.
    [SEGMENTS_SUSPENDED_CASING_LAYER, "line-width", networkCasingWidth],
    [
      SEGMENTS_SUSPENDED_LAYER,
      "line-width",
      () => railwayScale(RAILWAY_STYLE.railWidthPx),
    ],
    [
      STATIONS_LAYER,
      "circle-radius",
      () => railwayScale(RAILWAY_STYLE.stationRadiusPx),
    ],
    [
      STATIONS_LAYER,
      "circle-stroke-width",
      () => railwayScale(RAILWAY_STYLE.stationRingPx),
    ],
    // the ridden routes
    [TRAIN_ROUTES_LAYER, "line-width", riddenLineWidth],
    [TRAIN_XDAY_LAYER, "line-width", riddenLineWidth],
    [TRAIN_SEL_LAYER, "line-width", riddenLineWidth],
    [TRAIN_EXPAND_LAYER, "line-width", riddenLineWidth],
    [TRAIN_HOVER_LAYER, "line-width", riddenHoverLineWidth],
    [TRAIN_EXPAND_HOVER_LAYER, "line-width", riddenHoverLineWidth],
    [
      TRAIN_SEL_CASING_LAYER,
      "line-width",
      riddenSelectionCasingWidth,
    ],
    // …and their station dots. The two SEL dot layers are absent on purpose:
    // their radius carries the selection's focus boost, so RailMap re-applies
    // them through setFocusBoost instead.
    [TRAIN_PASS_LAYER, "circle-radius", () => markerRadiusExpr(0)],
    [TRAIN_STOPS_LAYER, "circle-radius", () => markerRadiusExpr(0)],
    [TRAIN_PASS_LAYER, "circle-stroke-width", () => markerStrokeWidth()],
    [TRAIN_STOPS_LAYER, "circle-stroke-width", () => markerStrokeWidth()],
    [TRAIN_SEL_PASS_LAYER, "circle-stroke-width", () => markerStrokeWidth(1)],
    [
      TRAIN_SEL_STOPS_LAYER,
      "circle-stroke-width",
      () => markerStrokeWidth(SELECTED_STOP_STROKE_SCALE),
    ],
    // The cross-day diamond is the one LAYOUT property here (icon-size), and
    // it has to shrink with the dots it sits among or it reads oversized.
    [TRAIN_XDAY_STOP_LAYER, "icon-size", () => xdayIconSizeExpr(), "layout"],
  ];

  // Every one of those values, for the anchors in force now. `kind` tells the
  // caller which MapLibre setter to use.
  function railwayScreenPaintEntries() {
    return RAILWAY_SCREEN_PAINT.map(([layer, property, build, kind]) => ({
      layer,
      property,
      value: build(),
      kind: kind || "paint",
    }));
  }

  const EMPTY_FC = { type: "FeatureCollection", features: [] };
  const NO_TRAIN = "__none__";
  // A filter that can never match (empty tid whitelist).
  const MATCH_NONE = ["in", ["get", "tid"], ["literal", []]];
  // HOVER SPOTLIGHT: while a route (or an expanded parallel group) is
  // hovered, every OTHER train's lines and station dots fade to this opacity
  // multiplier. Applied purely via paint expressions (no source updates).
  const HOVER_DIM = 0.15;
  // Hover hit geometry in SCREEN pixels. Fresh entry gets a moderate 8px pad;
  // active hover adds only 5px so it stays stable without becoming magnetic.
  const HOVER_PICK_PAD_PX = 8;
  const HOVER_STICKY_PAD_PX = 5;
  const HOVER_FAN_HOLD_PX = 10;
  const HOVER_GROUP_SWITCH_PX = 7;
  // SELECTION SPOTLIGHT: while a single train is SELECTED, every other train
  // still drawn (its same-day siblings — other dates are removed upstream)
  // fades to this multiplier, station dots included. Softer than the hover
  // dim so a hover can still deepen the spotlight on top of a selection.
  const SELECT_DIM = 0.25;
  // (Opacity fades are rAF-driven — see the animated dim engine
  // `_applyDimPaint`; per-mode durations live in `_dimSpeedMs`.)

  // Marker circle paint shared by the four dot layers: per-feature fill/stroke
  // (rgb strings; alpha rides circle-opacity so the SEL layers can override
  // it) + the scale ramp. `radiusBoost` widens the SEL layers' dots (focus
  // emphasis without any record rebuild); `sel` layers also force full opacity
  // so a selected off-date train's dots un-dim.
  //
  // These are one dot per stop of every ridden train — measured at 201 trains,
  // 384 of them on one screen at z5 — so they are the family that most needs
  // the ramp, and the family that most needs to ride the SAME one: radii, ring
  // widths and the cross-day diamond thin TOGETHER, or the diamond reads over-
  // or under-sized beside the dots it stands among.
  function markerRadiusExpr(radiusBoost) {
    const r = radiusBoost
      ? ["+", ["get", "radius"], radiusBoost]
      : ["get", "radius"];
    return railwayScale(r);
  }

  // A dot's outline, on the ramp with the dot it outlines.
  function markerStrokeWidth(strokeScale) {
    const w = ["get", "lineWidth"];
    return railwayScale(
      strokeScale && strokeScale !== 1 ? ["*", w, strokeScale] : w,
    );
  }

  // Selected marker growth stays role-aware: a terminal keeps the full focus
  // boost, while an intermediate stop grows by exactly the same amount as a
  // pass-through marker. The small black center dot scales proportionally but
  // never expands to cover its white outer circle.
  function selectedStopRadiusExpr(focusBoost) {
    const boost = Math.max(0, Number(focusBoost) || 0);
    return markerRadiusExpr([
      "*",
      boost,
      ["coalesce", ["get", "focusScale"], 0.5],
    ]);
  }

  // The cross-day diamond is rasterized at XDAY_ICON_BASE_RADIUS CSS px (see
  // RailMap._ensureXDayIcon), so icon-size only has to scale it to the record's
  // own radius — on the same scale ramp as every circle marker.
  const XDAY_ICON_BASE_RADIUS = 10;
  function xdayIconSizeExpr() {
    return railwayScale(["/", ["get", "radius"], XDAY_ICON_BASE_RADIUS]);
  }

  const SELECTED_STOP_STROKE_SCALE = [
    "case",
    ["==", ["get", "role"], "terminal"],
    2,
    1,
  ];

  function markerCirclePaint(opts) {
    const sel = !!(opts && opts.sel);
    return {
      "circle-color": ["get", "fill"],
      "circle-opacity": sel ? 1 : ["get", "alpha"],
      "circle-radius": markerRadiusExpr(0),
      "circle-stroke-color": ["get", "stroke"],
      "circle-stroke-opacity": sel ? 1 : ["get", "alpha"],
      "circle-stroke-width": markerStrokeWidth(sel ? opts.strokeScale || 1 : 1),
      "circle-pitch-alignment": "map",
    };
  }

  // Stop-dot LOD: below `stopMarkerMinzoom` the intermediate stop dots (every
  // role except "terminal" — the black stop-centers included) don't draw. The
  // gate can't be a layer `minzoom`, because the stops layers also carry the
  // terminal markers, which must stay visible at every zoom — and it can't be
  // a ["zoom"] filter expression either: the vendored MapLibre build only
  // evaluates filter zoom when a tile is parsed, which for this geojson
  // circle source empirically never re-gates on zoom (verified: a bare
  // [">=",["zoom"],7] filter still rendered every dot at zoom 6). So the gate
  // is a plain role filter that RailMap re-applies whenever the view crosses
  // the threshold (see the zoom watcher in attach()). Configured once by
  // buildBaseStyle (opts.stopMinzoom, 0 = no LOD); shared with
  // _applyMarkerSelectionFilters so both filter builders agree.
  let stopMarkerMinzoom = 0;
  function stopMarkerZoomGate(zoom) {
    if (!(stopMarkerMinzoom > 0)) return null;
    if (Number(zoom) >= stopMarkerMinzoom) return null;
    return ["==", ["get", "role"], "terminal"];
  }

  // ───────────────────────────── the base style (style.ts buildBaseStyle) ────────────────
  //
  // A DECLARATIVE LAYER STACK, not an algorithm: `layers` is pushed in PAINT
  // ORDER and that order IS the visual contract. Splitting it into per-tier
  // builders would replace one readable top-to-bottom list with a call graph
  // whose only content is the same order, so it stays one function. The
  // §-banners below are its table of contents — the map's z-order, read down:
  //
  //   §1  sources        one geojson source per record kind
  //   §2  ground         plain background + the optional basemap tint
  //   §3  network        the whole national field: casing, line, suspended
  //   §4  network dots   unridden station circles
  //   §5  names          line labels, then station labels
  //   §6  trains         ridden routes, cross-day dashes, pick + fan lanes
  //   §7  train dots     pass-through, stop and cross-day markers
  //   §8  selection      dark casing + the selected line and its dots
  //   §9  hover expand   the fanned copies of a hovered group's courses
  //   §10 debug          fitted curves, then hover regions (always last)
  //   §11 assembly       glyphs/sprite + the non-enumerable basemap metadata
  function buildBaseStyle(opts) {
    const basemap = opts.basemap || null;
    const network = opts.network || null;
    const theme = opts.theme === "dark" ? "dark" : "light";
    const themeColors = MAP_SURFACE_COLORS[theme];
    const fadeOpacity = Math.max(0, Math.min(1, Number(opts.fadeOpacity || 0)));

    // ONE basemap stack serves both themes. Light and dark are the same
    // positron layers differing only in paint colors (railmap-basemap.js), so
    // theme switching recolors this stack in place with paint transitions.
    // Never stage a second stack: two identical symbol stacks fight in
    // MapLibre's global label collision pass, and the staged (invisible) copy
    // wins placement — the visible theme's labels all vanish.
    const primaryStack = basemap
      ? namespaceBasemap(basemap, "", false)
      : null;
    // ── §1 sources ──
    const sources = Object.assign({}, primaryStack ? primaryStack.sources : {});
    sources[SEGMENTS_SOURCE] = {
      type: "geojson",
      data: network ? network.segments : EMPTY_FC,
      attribution: railAttributionForCountry(opts.country),
      tolerance: SEGMENT_SIMPLIFY_TOLERANCE_PX,
    };
    sources[STATIONS_SOURCE] = {
      type: "geojson",
      data: network ? network.stations : EMPTY_FC,
    };
    sources[STATION_LABELS_SOURCE] = {
      type: "geojson",
      data: network ? network.stationLabels || EMPTY_FC : EMPTY_FC,
    };
    // Ridden routes use exact slices of the same complete network lines, so
    // they must be generalised by the SAME number: two tolerances would let
    // the ridden stroke and the line under it part company at every corner,
    // which is the one thing a ride overlay may never do.
    sources[TRAIN_ROUTES_SOURCE] = {
      type: "geojson",
      data: EMPTY_FC,
      tolerance: SEGMENT_SIMPLIFY_TOLERANCE_PX,
    };
    sources[TRAIN_PICK_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_PICK_FAN_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_EXPAND_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_MARKERS_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[FIT_CURVES_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[HOVER_REGIONS_SOURCE] = { type: "geojson", data: EMPTY_FC };
    // Pass-through dot LOD: below this zoom the (numerous) white dots simply
    // don't draw — a layer property, so crossing it re-renders nothing.
    const passMinzoom = Math.max(0, Number(opts.passMinzoom || 0));
    // Stop-dot LOD (see stopMarkerZoomGate): the intermediate stop dots follow
    // at a LOWER threshold, so zooming out sheds pass-throughs first and stops
    // later, while terminals never disappear.
    stopMarkerMinzoom = Math.max(0, Number(opts.stopMinzoom || 0));
    // Stops-layer filter shared by the base and SEL variants: category, tid
    // ownership, and the stop-dot LOD gate. The map always boots at the
    // nationwide overview (zoom 4, below any sensible threshold), so build
    // the boot filters gated; attach() re-derives them from the live zoom
    // right away, correcting any boot path that starts zoomed in.
    const stopsLayerFilter = (mine) => {
      const filter = [
        "all",
        ["==", ["get", "category"], "stop"],
        [mine ? "==" : "!=", ["get", "tid"], NO_TRAIN],
      ];
      const zoomGate = stopMarkerZoomGate(0);
      if (zoomGate) filter.push(zoomGate);
      return filter;
    };

    const layers = [];
    // ── §2 ground: plain background + the optional basemap tint ──
    // Plain background used for the explicit no-basemap mode and graceful
    // degradation when the online style is unavailable.
    layers.push({
      id: "rp-bg",
      type: "background",
      paint: { "background-color": themeColors.background },
    });
    // Keep the complete basemap stack below the fade and every railway layer.
    // This guarantees that roads, labels and theme masks can never cover the
    // ordinary network or any ridden route.
    if (primaryStack) layers.push(...primaryStack.layers);

    // Optional map-opacity tint affects only the basemap. Theme switching
    // recolors the basemap stack in place; this layer stays unchanged.
    layers.push({
      id: FADE_LAYER,
      type: "background",
      paint: {
        "background-color": themeColors.fade,
        "background-opacity": fadeOpacity,
        "background-opacity-transition": { duration: 0, delay: 0 },
      },
    });

    // ── §3 network — the full national field, railprint's "unridden field" ──
    // Hidden by default: the network is opt-in via the layers-control switch.
    // A narrow surface-coloured casing mirrors Apple Maps' Transit treatment:
    // it separates coloured railway ink from roads and adjacent railways while
    // keeping the edge crisp (no glow or blur).
    layers.push({
      id: SEGMENTS_CASING_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE,
      // A feature-property filter, not a zoom one: it is constant for the life
      // of the feature, so the tile-parse hazard the note on SEGMENTS_LAYER
      // warns about — neighbouring tiles parsed at different zooms hiding
      // different halves of a line — cannot arise here.
      filter: IN_SERVICE_FILTER,
      layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
      paint: {
        "line-color": networkCasingColor(theme),
        "line-opacity": lineLengthVisibilityOpacity(0.88),
        "line-width": networkCasingWidth(),
      },
    });
    layers.push({
      id: SEGMENTS_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE,
      filter: IN_SERVICE_FILTER,
      layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
      paint: {
        // Theme-specific: both values are audited package colours, not runtime
        // blends, so the displayed HEX remains deterministic.
        "line-color": networkLineColor(theme),
        // Do not put this zoom gate in a layer FILTER. GeoJSON filters are
        // evaluated while individual source tiles are parsed, so neighbouring
        // tiles can temporarily use different zoom levels and hide only part
        // of one line. Paint expressions are evaluated uniformly every frame.
        "line-opacity": lineLengthVisibilityOpacity(UNRIDDEN_OPACITY),
        // Screen-space: half a station circle, at every zoom — the scale ramp
        // moves the two of them together, never one without the other.
        "line-width": railwayScale(RAILWAY_STYLE.railWidthPx),
      },
    });
    // The same railway, over the stretches where the trains have stopped. Same
    // hue, same weight, same casing, same LOD — only the continuity differs,
    // because that is the only thing that differs on the ground. Drawn
    // immediately above the field so a closed stretch never disappears under
    // the open railway beside it, and below the station dots so the platforms
    // of a suspended line still read as platforms.
    layers.push({
      id: SEGMENTS_SUSPENDED_CASING_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE,
      filter: SUSPENDED_FILTER,
      // Butt caps, for the reason TRAIN_XDAY_LAYER gives: a round cap adds
      // half a line width of ink at each end of every dash, which lengthens
      // the mark and shortens the gap until the line reads solid again.
      layout: { "line-cap": "butt", "line-join": "round", visibility: "none" },
      paint: {
        "line-color": networkCasingColor(theme),
        "line-opacity": lineLengthVisibilityOpacity(0.88),
        "line-width": networkCasingWidth(),
        "line-dasharray": networkSuspendedCasingDash(),
      },
    });
    layers.push({
      id: SEGMENTS_SUSPENDED_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE,
      filter: SUSPENDED_FILTER,
      layout: { "line-cap": "butt", "line-join": "round", visibility: "none" },
      paint: {
        "line-color": networkLineColor(theme),
        "line-opacity": lineLengthVisibilityOpacity(UNRIDDEN_OPACITY),
        "line-width": railwayScale(RAILWAY_STYLE.railWidthPx),
        "line-dasharray": networkSuspendedDash(),
      },
    });
    // ── §4 network dots — unridden station circles ──
    layers.push({
      id: STATIONS_LAYER,
      type: "circle",
      source: STATIONS_SOURCE,
      layout: { visibility: "none" },
      paint: {
        // Theme-dependent: _applyThemePaint rewrites both colors on switch,
        // and buildBaseStyle stamps the BOOT theme here. It used to hardcode
        // "light": a map that started in dark mode drew every platform in the
        // light palette until the first manual theme switch repainted it.
        // Solid where one railway calls, open where two do — the convention
        // that says "you can change trains here" without a word of text.
        "circle-color": stationFill(theme),
        "circle-opacity": lineLengthVisibilityOpacity(1),
        // The other half of the rail-width contract: this diameter times
        // RAILWAY_STYLE.railWidthToStationDiameter IS the stroke above — one
        // ramp over both, so the ratio survives every zoom.
        "circle-radius": railwayScale(RAILWAY_STYLE.stationRadiusPx),
        "circle-stroke-color": stationStroke(theme),
        "circle-stroke-opacity": lineLengthVisibilityOpacity(1),
        "circle-stroke-width": railwayScale(RAILWAY_STYLE.stationRingPx),
      },
    });

    // ── §5 names — line labels, then station labels ──
    // Text needs glyphs, and the glyph endpoint arrives WITH the basemap. A
    // basemap-less map (offline, or "no map" by choice) therefore draws the
    // network unlabelled rather than logging a styleglyphsmissing error per
    // frame; the marks are the contract, the names are the enrichment.
    if (basemap && basemap.glyphs) {
      // The line's own name, written ALONG the line, in the line's own hue —
      // placed BEFORE the station names. MapLibre runs its collision pass in
      // REVERSE draw order — the layer drawn last is placed first and keeps
      // its space — so "last" is "wins", and a name a reader navigates by
      // outranks a name that merely identifies the colour it is written on.
      // the one place this project follows Apple's Transit view into text.
      // symbol-placement "line" is what makes it a name written on a railway
      // rather than a badge dropped on one; text-max-angle keeps it off the
      // curves too tight to read a word around.
      layers.push({
        id: SEGMENTS_LABEL_LAYER,
        type: "symbol",
        source: SEGMENTS_SOURCE,
        // A railway split into an open and a closed stroke is still ONE
        // railway with ONE name; rail-network.js says which stroke carries it.
        filter: SEGMENT_LABEL_FILTER,
        layout: {
          visibility: "none",
          "text-field": ["coalesce", ["get", "name"], ""],
          "text-font": NETWORK_LABEL_FONT,
          "text-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            LINE_LABEL_MIN_ZOOM,
            9.5,
            16,
            11,
          ],
          "symbol-placement": "line",
          // Long enough that one name is not repeated three times inside a
          // single station spacing, short enough that a long line is named
          // more than once across a city view.
          "symbol-spacing": 260,
          "text-max-angle": 32,
          "text-letter-spacing": 0.01,
          "text-padding": 3,
          // A name is the one thing on this overlay that MAY be dropped when
          // it does not fit: two names stacked on a shared corridor is worse
          // than one name and a colour.
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": networkLineLabelColor(theme),
          "text-halo-color": networkLabelHaloColor(theme),
          "text-halo-width": 1.1,
          "text-halo-blur": 0.2,
          "text-opacity": labelVisibilityOpacity(LINE_LABEL_MIN_ZOOM, 1),
        },
      });
      // The station's name beside its bead, once per interchange group. The
      // DOTS keep overlap allowed and are never merged, deleted or moved by
      // any of this: dedupe happens on the NAMES, one layer above the marks.
      layers.push({
        id: STATIONS_LABEL_LAYER,
        type: "symbol",
        // One name per station complex. rail-network.js elects it into a
        // collection of its own; every platform keeps its own dot on its own
        // line at its own lane in rn-stations, which no part of this layer
        // touches.
        source: STATION_LABELS_SOURCE,
        layout: {
          visibility: "none",
          "text-field": ["coalesce", ["get", "name"], ""],
          "text-font": NETWORK_LABEL_FONT,
          "text-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            STATION_LABEL_MIN_ZOOM,
            10,
            16,
            12,
          ],
          // Let the renderer choose which side of the bead has room, the way
          // every other point label on the map is placed.
          "text-variable-anchor": ["left", "right", "top", "bottom"],
          "text-radial-offset": 0.75,
          "text-justify": "auto",
          "text-padding": 2,
          "text-allow-overlap": false,
          "text-ignore-placement": false,
          // Interchanges first, then terminals, then ordinary stops: when a
          // dense district cannot show every name, the names that survive are
          // the ones a reader navigates by. (Lower sorts earlier.) This is
          // ordering WITHIN the elected names — it never revives a platform
          // the election passed over.
          "symbol-sort-key": [
            "-",
            0,
            [
              "+",
              ["*", 2, ["coalesce", ["get", "interchange"], 0]],
              ["coalesce", ["get", "isTerminal"], 0],
            ],
          ],
        },
        paint: {
          "text-color": networkLabelTextColor(theme),
          "text-halo-color": networkLabelHaloColor(theme),
          "text-halo-width": 1.2,
          "text-halo-blur": 0.2,
          "text-opacity": labelVisibilityOpacity(STATION_LABEL_MIN_ZOOM, 1),
        },
      });
    }

    // ── §6 trains ("ridden") — full-color line (glow removed by request) ──
    // line-sort-key (higher = on top) carries the static painter's order:
    // dimmed off-date tier under the active tier, then shorter total ride
    // over longer, then earlier date over later (see buildDeckRouteRecords).
    layers.push({
      id: TRAIN_ROUTES_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      layout: {
        "line-cap": "round",
        "line-join": "round",
        "line-sort-key": ["get", "sortKey"],
      },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": ["get", "alpha"],
        "line-width": riddenLineWidth(),
      },
    });
    // Cross-day continuation of an overnight train, dashed. Filter-driven and
    // empty by default: RailMap.setDateScope decides, per selected day, which
    // records move here from the solid layer above (and the toggle
    // "顯示完整跨天行程" empties it again). Butt caps keep the dashes crisp —
    // round caps at this width read as a dotted line.
    layers.push({
      id: TRAIN_XDAY_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: MATCH_NONE,
      layout: {
        "line-cap": "butt",
        "line-join": "round",
        "line-sort-key": ["get", "sortKey"],
      },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": ["get", "alpha"],
        "line-width": riddenLineWidth(),
        "line-dasharray": [1.6, 1.4],
      },
    });
    // Invisible true-track PICK layer used while the fan is collapsed. Zero
    // opacity — queryRenderedFeatures still hit-tests against line-width.
    layers.push({
      id: TRAIN_PICK_LAYER,
      type: "line",
      source: TRAIN_PICK_SOURCE,
      // nopick records (off-date trains while a concrete day is active) are
      // excluded from hit-testing entirely: no hover, no tooltip, no click.
      filter: ["!=", ["get", "nopick"], 1],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#000",
        "line-opacity": 0,
        "line-width": ["get", "pickWidth"],
      },
    });
    // FAN-SCOPED pick lanes: while a hover fan is open, only the open group's
    // per-lane hit areas live here. A pooled one-tid layer translates this
    // true geometry on the GPU together with its visible lane.
    layers.push({
      id: TRAIN_PICK_FAN_LAYER,
      type: "line",
      source: TRAIN_PICK_FAN_SOURCE,
      filter: ["!=", ["get", "nopick"], 1],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#000",
        "line-opacity": 0,
        "line-width": ["get", "pickWidth"],
        "line-translate": [0, 0],
        "line-translate-anchor": "map",
      },
    });
    // Whole hovered route lights up (full opacity, a touch wider).  The
    // opacity starts at zero because RailMap's rAF dim engine owns both the
    // hover enter/leave fade and the A -> B crossfade when the pointer moves
    // directly between routes.  Keeping the old/new tids in this layer while
    // their paint weights cross prevents a filter swap from snapping.
    layers.push({
      id: TRAIN_HOVER_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: ["==", ["get", "tid"], NO_TRAIN],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 0,
        "line-width": riddenHoverLineWidth(),
      },
    });
    // ── §7 train dots — pass-through, stop and cross-day markers ──
    // Other trains' station dots sit UNDER the selected route. ONE marker
    // source feeds all four dot layers; the selected train's dots move to the
    // SEL layers purely via tid filters (selection = 4 setFilter calls, zero
    // setData).
    layers.push({
      id: TRAIN_PASS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      minzoom: passMinzoom,
      filter: [
        "all",
        ["==", ["get", "category"], "pass"],
        ["!=", ["get", "tid"], NO_TRAIN],
      ],
      paint: markerCirclePaint(),
    });
    layers.push({
      id: TRAIN_STOPS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      filter: stopsLayerFilter(false),
      layout: {
        "circle-sort-key": [
          "case",
          ["==", ["get", "role"], "stop-center"],
          2,
          1,
        ],
      },
      paint: markerCirclePaint(),
    });
    // Cross-day break station: the last station of the outgoing day, drawn as
    // a diamond so it never reads as an ordinary stop. Symbol layers paint
    // above every line/circle layer, so the diamond always sits on top of the
    // route it interrupts. Overlap-allowed: this one must never be dropped by
    // label collision.
    layers.push({
      id: TRAIN_XDAY_STOP_LAYER,
      type: "symbol",
      source: TRAIN_MARKERS_SOURCE,
      filter: ["==", ["get", "category"], "xday"],
      layout: {
        "icon-image": XDAY_ICON_ID,
        "icon-size": xdayIconSizeExpr(),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-pitch-alignment": "map",
        "icon-rotation-alignment": "map",
      },
      paint: { "icon-opacity": ["get", "alpha"] },
    });
    // ── §8 selection — dark casing, the selected line and its dots ──
    // C3 — DARK selection casing UNDER the selected line, the line's own hue on
    // top; the dark halo peeking out reads as "selected" on the light basemap.
    layers.push({
      id: TRAIN_SEL_CASING_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: ["==", ["get", "tid"], NO_TRAIN],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": themeColors.casing,
        "line-opacity": 0.9,
        // On the ramp with every other rail weight: the halo has to keep
        // showing the same PROPORTION of dark either side of the line it
        // marks, or "selected" reads differently at every zoom. The casing
        // is only 0.7 px per side at full scale, matching Apple's restrained
        // selected-transit outline instead of the old oversized white ribbon.
        "line-width": riddenSelectionCasingWidth(),
      },
    });
    layers.push({
      id: TRAIN_SEL_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: ["==", ["get", "tid"], NO_TRAIN],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 1,
        "line-width": riddenLineWidth(),
      },
    });
    // ── §9 hover expand — the fanned copies of a hovered group's courses ──
    // HOVER-EXPAND: while the pointer is on an overlapped stretch, that
    // group's trains draw temporarily fanned into date-ordered parallel
    // lanes. Each expand feature is the member train's COMPLETE course,
    // RIGIDLY translated by the group's constant shift vector — corners,
    // radii and lengths untouched, one intact copy of the whole line, never
    // broken into pieces mid-route. The source is group-scoped (filled on
    // hover). Opacity is animated 0→1 in JS; per-record alpha is baked into
    // colorA so the layer-level line-opacity acts as a pure fade multiplier.
    layers.push({
      id: TRAIN_EXPAND_LAYER,
      type: "line",
      source: TRAIN_EXPAND_SOURCE,
      filter: MATCH_NONE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "colorA"],
        "line-opacity": 0,
        "line-width": riddenLineWidth(),
        "line-translate": [0, 0],
        "line-translate-anchor": "map",
      },
    });
    // The hovered train's own lane lights up a touch wider, mirroring the
    // whole-route hover layer.
    layers.push({
      id: TRAIN_EXPAND_HOVER_LAYER,
      type: "line",
      source: TRAIN_EXPAND_SOURCE,
      filter: MATCH_NONE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "colorA"],
        "line-opacity": 0,
        "line-width": riddenHoverLineWidth(),
        "line-translate": [0, 0],
        "line-translate-anchor": "map",
      },
    });
    // The selected train's own dots above its raised route (same source,
    // tid-filtered; full opacity + focus-boost radius via paint).
    layers.push({
      id: TRAIN_SEL_PASS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      minzoom: passMinzoom,
      filter: [
        "all",
        ["==", ["get", "category"], "pass"],
        ["==", ["get", "tid"], NO_TRAIN],
      ],
      paint: markerCirclePaint({ sel: true, strokeScale: 1 }),
    });
    layers.push({
      id: TRAIN_SEL_STOPS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      filter: stopsLayerFilter(true),
      layout: {
        "circle-sort-key": [
          "case",
          ["==", ["get", "role"], "stop-center"],
          2,
          1,
        ],
      },
      paint: markerCirclePaint({
        sel: true,
        strokeScale: SELECTED_STOP_STROKE_SCALE,
      }),
    });

    // ── §10 debug — fitted curves, then hover regions (always last) ──
    // Direction-fit debug overlay. These are intentionally the LAST style
    // layers so the exact curve used by hover direction remains visible above
    // routes, expanded lanes, markers and basemap labels. A black casing plus
    // white dashed core gives an inverse/high-contrast read on every colour.
    layers.push({
      id: FIT_CURVES_CASING_LAYER,
      type: "line",
      source: FIT_CURVES_SOURCE,
      layout: {
        visibility: "none",
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#000000",
        "line-opacity": 0.92,
        "line-width": 6,
        "line-dasharray": [2.2, 1.8],
      },
    });
    layers.push({
      id: FIT_CURVES_LAYER,
      type: "line",
      source: FIT_CURVES_SOURCE,
      layout: {
        visibility: "none",
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        // Rejected station joins ride the same debug source as short marker
        // segments; draw them red and wider so the exact boundary that stayed
        // discontinuous is visible among the white fitted curves.
        "line-color": [
          "case",
          ["==", ["get", "kind"], "station-join-failure"],
          "#ff3b30",
          "#ffffff",
        ],
        "line-opacity": 1,
        "line-width": [
          "case",
          ["==", ["get", "kind"], "station-join-failure"],
          5,
          2.5,
        ],
        "line-dasharray": [2.2, 1.8],
      },
    });

    // Screen-space hover diagnostics, converted to geographic polygons on
    // each pointer frame. Cyan = active route query box, orange = temporary
    // fan hold radius, magenta = overlap-group switch deadzone. These remain
    // last in the style so the real monitored area is never hidden by labels.
    const hoverRegionColor = [
      "match",
      ["get", "kind"],
      "pick",
      "#00d5ff",
      "hold",
      "#ff9800",
      "switch",
      "#ff2db2",
      "#ffffff",
    ];
    layers.push({
      id: HOVER_REGIONS_FILL_LAYER,
      type: "fill",
      source: HOVER_REGIONS_SOURCE,
      layout: { visibility: "none" },
      paint: {
        "fill-color": hoverRegionColor,
        "fill-opacity": 0.14,
      },
    });
    layers.push({
      id: HOVER_REGIONS_LINE_LAYER,
      type: "line",
      source: HOVER_REGIONS_SOURCE,
      layout: {
        visibility: "none",
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": hoverRegionColor,
        "line-opacity": 0.95,
        "line-width": 2.5,
        "line-dasharray": [2, 1.2],
      },
    });

    // ── §11 assembly ──
    const style = { version: 8, sources, layers };
    if (basemap && basemap.glyphs) style.glyphs = basemap.glyphs;
    if (basemap && basemap.sprite) style.sprite = basemap.sprite;
    const stacks = {};
    if (primaryStack) {
      stacks[theme] = {
        layerIds: primaryStack.layers.map((layer) => layer.id),
        sourceIds: Object.keys(primaryStack.sources),
        opacityTargets: primaryStack.opacityTargets,
      };
    }
    // Application-only metadata must not be passed through MapLibre's style
    // validator, so keep it non-enumerable and hand it directly to attach().
    Object.defineProperty(style, "__railMapBasemapStacks", {
      value: stacks,
      enumerable: false,
    });
    return style;
  }

  // Enough of the MapLibre expression language for contract tests to read a
  // screen-space size from the built style:
  // numbers, the arithmetic the style uses, per-feature lookups, and zoom
  // interpolation. ANYTHING else returns NaN on purpose — an unrecognised
  // expression must fail the check loudly rather than measure as a constant.
  function evaluateScreenValue(value, zoom, properties) {
    if (typeof value === "number") return value;
    // The LOD gates branch on booleans, so a literal one is a value here and
    // not an unreadable expression.
    if (typeof value === "boolean") return value;
    if (!Array.isArray(value)) return NaN;
    const rest = value.slice(1);
    const at = (item) => evaluateScreenValue(item, zoom, properties);
    switch (value[0]) {
      case "literal":
        return rest[0];
      case "zoom":
        return Number(zoom);
      case "get": {
        const got = properties ? properties[rest[0]] : undefined;
        return got === undefined ? null : got;
      }
      case "coalesce": {
        for (const item of rest) {
          const got = at(item);
          if (got !== null && got !== undefined && !Number.isNaN(got)) return got;
        }
        return null;
      }
      case "*":
        return rest.reduce((total, item) => total * at(item), 1);
      case "+":
        return rest.reduce((total, item) => total + at(item), 0);
      case "-":
        return rest.length === 1 ? -at(rest[0]) : at(rest[0]) - at(rest[1]);
      case "/":
        return at(rest[0]) / at(rest[1]);
      case "interpolate": {
        const curve = rest[0];
        // Linear and exponential only — an unknown curve must not be measured
        // as if it were a straight line.
        const base =
          Array.isArray(curve) && curve[0] === "exponential"
            ? Number(curve[1])
            : Array.isArray(curve) && curve[0] === "linear"
              ? 1
              : NaN;
        if (!isFinite(base) || base <= 0) return NaN;
        const input = at(rest[1]);
        const stops = [];
        for (let index = 2; index + 1 < rest.length; index += 2)
          stops.push([Number(rest[index]), at(rest[index + 1])]);
        if (!stops.length) return NaN;
        if (input <= stops[0][0]) return stops[0][1];
        for (let index = 1; index < stops.length; index += 1) {
          const [zoomB, valueB] = stops[index];
          const [zoomA, valueA] = stops[index - 1];
          if (input > zoomB) continue;
          // MapLibre's own exponential factor: base^t normalised over the
          // stop interval, which degenerates to the linear one at base 1.
          const span = zoomB - zoomA;
          const t = input - zoomA;
          const fraction =
            base === 1
              ? t / span
              : (Math.pow(base, t) - 1) / (Math.pow(base, span) - 1);
          return valueA + (valueB - valueA) * fraction;
        }
        return stops[stops.length - 1][1];
      }
      // The LOD gates are step/case/comparison expressions rather than
      // arithmetic ones, so measuring "is this drawn at this zoom, for a
      // feature with this minz?" needs them evaluated too — otherwise every
      // opacity in this style reads NaN and no test can hold it to anything.
      case "step": {
        const input = at(rest[0]);
        let result = at(rest[1]);
        for (let index = 2; index + 1 < rest.length; index += 2) {
          if (input < Number(rest[index])) break;
          result = at(rest[index + 1]);
        }
        return result;
      }
      case "case": {
        for (let index = 0; index + 1 < rest.length; index += 2)
          if (at(rest[index])) return at(rest[index + 1]);
        return rest.length % 2 ? at(rest[rest.length - 1]) : NaN;
      }
      case "==":
        return at(rest[0]) === at(rest[1]);
      case "!=":
        return at(rest[0]) !== at(rest[1]);
      case "<":
        return at(rest[0]) < at(rest[1]);
      case "<=":
        return at(rest[0]) <= at(rest[1]);
      case ">":
        return at(rest[0]) > at(rest[1]);
      case ">=":
        return at(rest[0]) >= at(rest[1]);
      default:
        return NaN;
    }
  }


  global.RailMapStyle = {
    buildBaseStyle,
    railAttributionForCountry,
    stopMarkerZoomGate,
    networkLineColor,
    networkCasingColor,
    networkCasingWidth,
    riddenLineWidth,
    riddenHoverLineWidth,
    riddenFocusLineWidth,
    railwayScale,
    railwayScaleAt,
    railwayScreenPaintEntries,
    RAILWAY_STYLE,
    SEGMENT_SIMPLIFY_TOLERANCE_PX,
    evaluateScreenValue,
    stationFill,
    stationStroke,
    RAILWAY_FULL_WEIGHT_METERS_PER_PIXEL,
    RAILWAY_FULL_WEIGHT_ZOOM,
    RAILWAY_MIN_WEIGHT_SCALE,
    RAILWAY_MIN_WEIGHT_ZOOM,
    RAILWAY_WEIGHT_ZOOM_BASE,
    RIDDEN_WIDTH_SCALE,
    markerRadiusExpr,
    selectedStopRadiusExpr,
    EMPTY_FC,
    NO_TRAIN,
    MATCH_NONE,
    HOVER_DIM,
    HOVER_PICK_PAD_PX,
    HOVER_STICKY_PAD_PX,
    HOVER_FAN_HOLD_PX,
    HOVER_GROUP_SWITCH_PX,
    SELECT_DIM,
    SEGMENTS_SOURCE,
    STATIONS_SOURCE,
    SEGMENTS_LAYER,
    SEGMENTS_CASING_LAYER,
    SEGMENTS_SUSPENDED_LAYER,
    SEGMENTS_SUSPENDED_CASING_LAYER,
    networkSuspendedDash,
    networkSuspendedCasingDash,
    STATIONS_LAYER,
    STATION_LABELS_SOURCE,
    STATIONS_LABEL_LAYER,
    SEGMENTS_LABEL_LAYER,
    networkLabelTextColor,
    networkLabelHaloColor,
    networkLineLabelColor,
    labelVisibilityOpacity,
    STATION_ICON_BASE_PX,
    stationIconId,
    stationIconImage,
    stationIconSize,
    FADE_LAYER,
    TRAIN_ROUTES_SOURCE,
    TRAIN_PICK_SOURCE,
    TRAIN_PICK_FAN_SOURCE,
    TRAIN_EXPAND_SOURCE,
    TRAIN_MARKERS_SOURCE,
    FIT_CURVES_SOURCE,
    HOVER_REGIONS_SOURCE,
    TRAIN_ROUTES_LAYER,
    TRAIN_XDAY_LAYER,
    TRAIN_XDAY_STOP_LAYER,
    XDAY_ICON_ID,
    XDAY_ICON_BASE_RADIUS,
    TRAIN_PICK_LAYER,
    TRAIN_PICK_FAN_LAYER,
    TRAIN_EXPAND_LAYER,
    TRAIN_EXPAND_HOVER_LAYER,
    TRAIN_HOVER_LAYER,
    TRAIN_SEL_CASING_LAYER,
    TRAIN_SEL_LAYER,
    TRAIN_PASS_LAYER,
    TRAIN_STOPS_LAYER,
    TRAIN_SEL_PASS_LAYER,
    TRAIN_SEL_STOPS_LAYER,
    FIT_CURVES_CASING_LAYER,
    FIT_CURVES_LAYER,
    HOVER_REGIONS_FILL_LAYER,
    HOVER_REGIONS_LINE_LAYER,
  };
})(window);
