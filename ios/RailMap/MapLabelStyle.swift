import CoreGraphics
import MapKit
import UIKit

/// How a name is drawn on the map — the typography half of the style tier.
///
/// Ported from `app/public/railmap-style.js` §"network label typography" and
/// the ridden-label floors beside it. It is separate from ``RailStyle`` because
/// it obeys the opposite rule: `RailStyle` carries **marks**, which all ride one
/// shared scale ramp, and this carries **text**, which deliberately does not.
///
/// > Apple's Transit view names two things and nothing else: the STATION, in
/// > the map's ordinary label ink beside its bead, and the LINE, written along
/// > the line in the line's own colour. Both are text, not marks — so neither
/// > rides railwayScale(): a label that shrank with the network would stop
/// > being readable exactly when the network needed naming.
///
/// So a name carries its own, much shallower ramp: its base size at the zoom it
/// first appears, two points more by z16, and flat thereafter.
///
/// ## Why a halo and not a plate
///
/// Every label here used to sit on `systemBackground` at 82% with a 4 pt corner
/// radius. That is a filled plate, and it is wrong twice over: in dark mode
/// `systemBackground` is black, so the map grew a field of black chips; and a
/// plate occupies its whole bounding box in the collision pass, so a two-word
/// station name evicts marks it never actually covers.
///
/// The reference draws text over the map with a **halo** — the surface colour
/// stroked around the glyphs themselves — which is what `text-halo-color` /
/// `text-halo-width` mean in the style this is ported from, and what
/// ``HaloLabel`` does here.
enum MapLabelStyle {

    // MARK: - the ink and the halo

    /// `networkLabelTextColor` — the map's ordinary label ink.
    ///
    /// Not `UIColor.label`: that is the *interface's* ink and it is pure white
    /// in dark mode, which is brighter than any railway on the map and makes
    /// the names shout over the network they are naming. These two are the
    /// values the web app draws, and they are pulled slightly off the extremes
    /// for exactly that reason.
    static func ink(dark: Bool) -> UIColor {
        dark
            ? UIColor(red: 236 / 255, green: 238 / 255, blue: 240 / 255, alpha: 1)
            : UIColor(red: 28 / 255, green: 30 / 255, blue: 32 / 255, alpha: 1)
    }

    /// `networkLabelHaloColor` — `MAP_SURFACE_COLORS[theme].background`, i.e.
    /// the basemap's own paper. A halo is the surface showing through around
    /// the glyph, so it has to BE the surface; anything else reads as an
    /// outline drawn on the text.
    static func halo(dark: Bool) -> UIColor {
        dark
            ? UIColor(red: 12 / 255, green: 12 / 255, blue: 12 / 255, alpha: 1)
            : UIColor(red: 242 / 255, green: 243 / 255, blue: 240 / 255, alpha: 1)
    }

    /// `--ink-muted` — the second rank of ink, for the parts of a card that
    /// qualify its name rather than being it: an endpoint card's departure or
    /// arrival time, and the reading lines under the name.
    ///
    /// A card on this map has no plate to sit on (see below), so the only
    /// thing separating a subline from the name is weight, size and this. The
    /// two values are `railprint-base.css`'s own light and dark tokens.
    static func mutedInk(dark: Bool) -> UIColor {
        dark
            ? UIColor(red: 174 / 255, green: 174 / 255, blue: 178 / 255, alpha: 1)
            : UIColor(red: 116 / 255, green: 106 / 255, blue: 102 / 255, alpha: 1)
    }

    /// `text-halo-width`. The web app also sets `text-halo-blur: 0.2`, which is
    /// not ported: Core Graphics strokes glyph outlines with a hard edge, and
    /// two tenths of a point of blur is below what a reader can see at these
    /// sizes. Recorded so the omission is a decision rather than an oversight.
    static let haloWidth: CGFloat = 1.2

    // MARK: - the network's own station names

    /// `STATION_LABEL_MIN_ZOOM`, in this app's zoom.
    ///
    /// 12 in `railmap-style.js`, which is a MapLibre number — see
    /// `RailStyle.fullWeightZoom` for why that becomes 13 here. It is a floor
    /// *in addition to* each station's own `minZoom`: the beads appear first
    /// and the names follow, because a name needs a district's worth of room
    /// and a bead does not.
    static let stationLabelMinZoom = RailStyle.zoom(fromMapLibre: 12)

    /// `["interpolate", ["linear"], ["zoom"], 12, 10, 16, 12]`, clamped outside
    /// its stops. `zoom` is this app's.
    static func stationLabelSize(atZoom zoom: Double) -> CGFloat {
        ramp(zoom: zoom, from: (stationLabelMinZoom, 10), to: (RailStyle.zoom(fromMapLibre: 16), 12))
    }

    /// The shallow linear ramp both label families use, clamped at both ends.
    static func ramp(
        zoom: Double, from low: (zoom: Double, size: CGFloat), to high: (zoom: Double, size: CGFloat)
    ) -> CGFloat {
        guard zoom > low.zoom else { return low.size }
        guard zoom < high.zoom else { return high.size }
        let t = (zoom - low.zoom) / (high.zoom - low.zoom)
        return low.size + (high.size - low.size) * CGFloat(t)
    }

    /// The typeface.
    ///
    /// The web app asks for Noto Sans Regular. There is no Noto here and there
    /// is no reason to bundle one — the point of drawing over Apple Maps is to
    /// sit in its own idiom — but SF at Regular reads distinctly lighter than
    /// Noto at the same size over a busy map, so the weight steps up one to
    /// land at the same *apparent* weight. That is a deliberate deviation, and
    /// it is the only one in this file.
    static func font(ofSize size: CGFloat) -> UIFont {
        .systemFont(ofSize: size, weight: .medium)
    }

    /// `--ink` — the text colour on a filled label card.
    ///
    /// Warmer than `UIColor.label` at both ends (#241b18 / #f5eee9), which is
    /// what the web app's own cards use. Distinct from ``ink(dark:)``: that is
    /// ink laid straight onto the MAP, this is ink on a card sitting over it.
    static let cardInk = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 245 / 255, green: 238 / 255, blue: 233 / 255, alpha: 1)
            : UIColor(red: 36 / 255, green: 27 / 255, blue: 24 / 255, alpha: 1)
    }

    /// `text-radial-offset: 0.75` — how far the name sits off its bead, in ems,
    /// so the gap grows with the text rather than staying a fixed pixel count
    /// while the label around it changes size.
    static let radialOffsetEm: CGFloat = 0.75

    /// `symbol-sort-key`: interchanges first, then terminals, then ordinary
    /// stops. When a dense district cannot show every name, the names that
    /// survive are the ones a reader navigates by.
    ///
    /// This is ordering *within* the elected names — it never revives a
    /// platform `StationDisplay.stationLabelWinners` passed over.
    /// A NAMED station is `.required`, for the reason recorded on the ride
    /// captions: an annotation view competes with the basemap's own labels, and
    /// anything below `.required` loses to them over a city — which is the whole
    /// of a city. A station drawn as a bare bead keeps a modest priority and may
    /// still be dropped, which is the right way round: losing a bead costs a
    /// dot on a line that is drawn anyway, losing a name costs the name.
    static func stationDisplayPriority(
        interchange: Bool, isTerminal: Bool, named: Bool
    ) -> MKFeatureDisplayPriority {
        guard named else {
            return MKFeatureDisplayPriority(
                rawValue: MKFeatureDisplayPriority.defaultLow.rawValue
                    + (isTerminal ? 100 : 0))
        }
        // `symbol-sort-key` orders interchanges before terminals before
        // ordinary stops, so that where a dense district cannot show every
        // name the survivors are the ones a reader navigates by. Once every
        // named station is `.required` nothing is suppressed and that ordering
        // has nothing left to decide — the parameters are kept because the
        // question comes back the moment a thinning pass exists to answer it.
        _ = (interchange, isTerminal)
        return .required
    }
}

/// A label whose text is stroked with the map surface before it is filled.
///
/// Two passes rather than one `NSAttributedString` with a negative
/// `.strokeWidth`: that variant strokes *over* the fill, centred on the glyph
/// path, so half the halo eats into the letterform and a light halo on dark ink
/// hollows the glyphs out. Stroke-then-fill puts the whole halo outside the
/// ink, which is what a halo is.
final class HaloLabel: UILabel {
    var haloColor: UIColor = .clear
    var haloWidth: CGFloat = MapLabelStyle.haloWidth

    override func drawText(in rect: CGRect) {
        guard haloWidth > 0, haloColor != .clear else {
            super.drawText(in: rect)
            return
        }
        let context = UIGraphicsGetCurrentContext()
        let ink = textColor
        context?.saveGState()
        // Doubled because a stroke is centred on the path: half of it lands
        // inside the glyph and is painted over by the fill pass, so the width
        // that SURVIVES is half of what is asked for.
        context?.setLineWidth(haloWidth * 2)
        context?.setLineJoin(.round)
        context?.setTextDrawingMode(.stroke)
        textColor = haloColor
        super.drawText(in: rect)
        context?.restoreGState()

        context?.setTextDrawingMode(.fill)
        textColor = ink
        super.drawText(in: rect)
    }
}
