import CoreGraphics
import Foundation

/// The railway's screen-space weight contract, as renderer parameters.
///
/// Ported from `app/public/railmap-style.js` §tokens and §"the map-scale
/// weight ramp". It lives in `RailMap` rather than `RailCore` on purpose:
/// `ios/README.md` records that the style tier is the one part of the web app
/// that does **not** port as data — MapLibre style JSON is read by both
/// renderers, MapKit has no style spec, so the design tokens have to become
/// renderer parameters instead.
///
/// ## Why there is a ramp at all
///
/// Every railway weight — network stroke, station dot, ridden route, recorded
/// call marker, selection casing — is ONE token below times ONE shared factor,
/// ``scale(atZoom:)``. Nothing computes a ramp of its own and nothing opts out.
///
/// The tokens are the weights at FULL scale, and full scale is a property of
/// the MAP SCALE rather than of the zoom number: the railway draws at its token
/// weight wherever a point is worth about 500 m of ground or less, and thins as
/// the view pulls back past that. One fixed stroke for every scale was the
/// alternative, and what it produced (in the web app, and in this app until
/// now) is a Japan whose nationwide view — four times the ground of Taiwan's,
/// six hundred lines and every station of them — reads as a single fused mass
/// of railway rather than as a network.
///
/// Thinning with scale and keeping a bundle legible are not in conflict so long
/// as ONE factor drives every weight: a ramp on one half of a sum would fan a
/// bundle into a ladder or weld it into one stroke.
public enum RailStyle {

    // MARK: - tokens (full-scale weights, in points)

    /// Diameter of an ordinary network station dot.
    static let stationDiameter: CGFloat = 6
    static let stationRadius: CGFloat = stationDiameter / 2
    /// Ring around that dot so it stays legible over its own line — an eighth
    /// of the dot, the proportion Apple's bead/keyline pair reads at. A ring
    /// that kept its absolute width while the dot shrank would swallow the
    /// colour it is meant to separate.
    static let stationRing: CGFloat = stationDiameter / 8
    /// Rail stroke = a quarter of the dot. Derived, never set independently.
    static let railWidthToStationDiameter: CGFloat = 0.25
    static let railWidth: CGFloat = stationDiameter * railWidthToStationDiameter

    /// How far the RIDDEN layer stands above the field it is drawn over — one
    /// third again, applied to the two marks that carry the ride: its stroke,
    /// and the dot on the station where the reader boarded or alighted.
    static let riddenEmphasisRatio: CGFloat = 4.0 / 3.0
    static let riddenWidth: CGFloat = railWidth * riddenEmphasisRatio
    /// `app-config.js`'s `DEFAULT_TRAIN_WEIGHT` seed, after `RIDDEN_WIDTH_SCALE`.
    static let riddenWidthScale: CGFloat = 1.18

    /// The black centre inside an intermediate stop's dot: two thirds of the
    /// dot it sits in, which leaves a ring of white wide enough that a stop
    /// still reads as a different mark from the solid endpoint dot.
    static let stopCentreToStationRadius: CGFloat = 2.0 / 3.0
    /// The one dot on a ride deliberately bigger than the station dot the
    /// network already drew there, by the same step the ride's stroke takes.
    static let stationTerminalRadius: CGFloat = stationRadius * riddenEmphasisRatio
    static let stationStopCentreRadius: CGFloat = stationRadius * stopCentreToStationRadius

    /// A quiet edge either side of the coloured core, so railways separate from
    /// roads and from one another without becoming glowing selection strokes.
    static let networkCasingEdge: CGFloat = 0.3
    static let selectionCasingEdge: CGFloat = 0.7

    /// The clear map a reader needs between two DISTINCT railways sharing one
    /// corridor, edge to edge.
    ///
    /// Carried for the corner-radius and topology relationships that quote it.
    /// It is **not** a lane offset: commit `38cf0a8` (2026-08-19) removed
    /// screen-space lanes end to end and rule R14 is withdrawn — every line
    /// draws on its own surveyed geometry, and this app must not reintroduce
    /// what the web app deliberately dropped.
    static let parallelGap: CGFloat = 1.2

    /// The smallest radius a corner may PRESENT on screen: one stroke width,
    /// because the pen decides the floor. `line-join: round` already rounds the
    /// outer edge to half the width about the vertex, so under W/2 there is
    /// nothing a radius could add that the ink has not already drawn.
    static let minCornerRadius: CGFloat = railWidth

    // MARK: - the map-scale weight ramp

    /// The scale at which the railway draws at full token weight, in metres of
    /// ground per point. Taiwan's whole-island view sits here, and it is the
    /// reference the rest of the map is calibrated against.
    static let fullWeightMetresPerPoint: Double = 500

    /// The anchor expressed as a zoom, in **this app's** convention.
    ///
    /// `railmap-style.js` names the anchor zoom 7, and that number is in
    /// MapLibre's convention, whose tiles are 512 px:
    ///
    ///     metresPerPixel = 78271.52 × cos(latitude) / 2^zoom
    ///
    /// `RailMapView.Coordinator.zoomLevel(of:)` derives zoom from 256-point
    /// tiles (`360 × width / 256 / longitudeDelta`), the Google/Leaflet
    /// convention, which reports the same ground scale **one level higher** —
    /// 500 m/pt is MapLibre z7 and z8 here. Measured, not assumed:
    /// 78271.52·cos35°/2⁷ = 500.9 and 156543.03·cos35°/2⁸ = 500.9.
    ///
    /// So the anchor is 8 in this file. Anyone comparing these numbers against
    /// `railmap-style.js` has to add one, and anyone feeding a MapLibre-derived
    /// zoom in here has to add one first.
    static let fullWeightZoom: Double = 8

    /// Below the anchor the weight halves every TWO zoom levels. The ground
    /// area on screen quadruples per level, so a weight that tracked it would
    /// be a quarter of a point by the time a country fits; the square root
    /// thins the network visibly while every line on it stays a line.
    static let weightZoomBase: Double = 2.0.squareRoot()

    /// …and it stops thinning at a third of token weight. Past that the marks
    /// stop being marks, and what a wider view needs from there is the LOD
    /// gates dropping lines and stations, not finer ones.
    static let minWeightScale: Double = 1.0 / 3.0

    /// The zoom at which the floor is reached: anchor + log₍√2₎(1/3).
    static let minWeightZoom: Double =
        fullWeightZoom + log2(minWeightScale) / log2(weightZoomBase)

    /// The shared factor every weight and every offset is multiplied by.
    ///
    /// The web app expresses this as a two-stop MapLibre `interpolate` with
    /// `["exponential", √2]`, which reproduces `√2^(zoom − anchor)` exactly
    /// between the stops and clamps outside them. Written directly here,
    /// because Swift has no expression language to work around:
    ///
    ///     scale(z) = clamp(2^((z − anchor) / 2), 1/3, 1)
    ///
    /// `zoom` is this app's own zoom (see ``fullWeightZoom`` for the one-level
    /// difference from `railmap-style.js`).
    static func scale(atZoom zoom: Double) -> CGFloat {
        guard zoom.isFinite else { return 1 }
        let raw = pow(2, (zoom - fullWeightZoom) / 2)
        return CGFloat(min(max(raw, minWeightScale), 1))
    }

    /// A weight in points at full scale, brought to the weight it draws at.
    static func weight(_ token: CGFloat, atZoom zoom: Double) -> CGFloat {
        token * scale(atZoom: zoom)
    }

    // MARK: - the one dash rhythm on the map

    /// A dash pair is measured in LINE WIDTHS, so the same pair on two strokes
    /// of different weight draws two different rhythms. The rhythm is fixed in
    /// points here and every dashed layer divides by its own width to reach it;
    /// two dashes that differed would read as two meanings.
    static let dashRatio: (on: CGFloat, off: CGFloat) = (1.6, 1.4)
    static let dashReferenceWidth: CGFloat = 2 * riddenWidthScale
    /// ≈ 3.78 pt on, 3.30 pt off.
    static let dash: (on: CGFloat, off: CGFloat) = (
        dashRatio.on * dashReferenceWidth, dashRatio.off * dashReferenceWidth
    )

    /// The dash pair for a stroke of `width` at full scale. It needs no zoom
    /// ramp of its own and must not have one: every railway width is one token
    /// times ``scale(atZoom:)``, so a dash expressed as a multiple of the width
    /// is carried down by the same factor and the on:off:width proportion holds
    /// at every zoom.
    static func dashPattern(forWidth width: CGFloat) -> [NSNumber] {
        guard width > 0 else { return [] }
        return [NSNumber(value: Double(dash.on / width)), NSNumber(value: Double(dash.off / width))]
    }

    // MARK: - playback marks

    /// How far the playback trail stands proud of the ride on each side, and
    /// how far its casing stands proud of that. A covered stretch has to read
    /// as lit against the SAME hue it is drawn in — the train's colour is
    /// already on the map under it — so the signal is weight plus an outline.
    static let playbackTrailEdge: CGFloat = 0.9
    static let playbackTrailCasing: CGFloat = 0.9
    /// Playback station beads, as multiples of an ordinary station's radius.
    static let playbackStationScale: CGFloat = 1.5
    static let playbackStationDoneScale: CGFloat = 1.9
    static let playbackStationCurrentScale: CGFloat = 2.9
    static let playbackHeadScale: CGFloat = 2.6
    static let playbackHeadHaloScale: CGFloat = 4.4
}
