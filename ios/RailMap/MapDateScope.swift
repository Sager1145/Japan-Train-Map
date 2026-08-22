import CoreGraphics
import Foundation
import RailCore

/// The date scope, as paint rather than as a filter.
///
/// Ported from `railmap.js` — `setDateScope`, `_xDaySelector` and the
/// `dateWrap` / `selWrap` halves of `_applyDimPaint`. Two separate questions
/// live here and the web app is emphatic that they are separate:
///
///   * **Off-date rides are DIMMED, not removed.** A reader scoped to one day
///     still wants the trip around it. `ContentView` hands the map every
///     visible ride and the map decides — which is why `DisplaySettings`
///     carries `dimOpacity` at all.
///   * **A cross-day ride is on-date on BOTH of its days.** It is never
///     dimmed on either; the half that runs on the *other* calendar day is
///     told apart by a DASH. `dspan` (`Dates.DaySpan.dates`) is what makes
///     that distinction possible, and `Dates.segmentDate(_:segmentIndex:)`
///     is what says which half a drawn segment belongs to.
enum MapDateScope {

    /// The reader's scope: a date, or the combined view.
    struct Scope: Equatable {
        /// `Dates.allDates` (or empty) means no scope — nothing dims and
        /// nothing dashes, because there is no "other day" to contrast with.
        var date: String
        /// `DisplaySettings.dimOpacity`, clamped as `setDateScope` clamps it.
        var dimOpacity: CGFloat
        /// `!DISPLAY.showFullCrossDay` — `setCrossDayDash`'s own argument.
        /// `true` dashes the stretch that runs on the other calendar day.
        var crossDayDash: Bool

        var isActive: Bool { !date.isEmpty && date != Dates.allDates }

        init(date: String, dimOpacity: Double, showFullCrossDay: Bool) {
            self.date = date
            self.dimOpacity = CGFloat(min(max(dimOpacity, 0), 1))
            crossDayDash = !showFullCrossDay
        }
    }

    /// Whether a ride runs on the scoped day at all — `["in", "|date|",
    /// ["get", "dspan"]]`, which is `trainSpansDate` by another spelling.
    static func inScope(_ span: Dates.DaySpan, _ scope: Scope) -> Bool {
        guard scope.isActive else { return true }
        return span.dates.contains(scope.date)
    }

    /// `_xDaySelector` — the parts of a cross-day ride that run on a day other
    /// than the selected one, while the ride itself is still in scope.
    ///
    /// With no day selected nothing is dashed: there is no other day to
    /// contrast against, and dashing an overnight ride's second half in the
    /// combined view would say something about a distinction the reader has
    /// not drawn.
    static func isCrossDayContinuation(
        _ span: Dates.DaySpan, segmentIndex: Int, scope: Scope
    ) -> Bool {
        guard scope.isActive, scope.crossDayDash, inScope(span, scope) else { return false }
        return Dates.segmentDate(span, segmentIndex: segmentIndex) != scope.date
    }

    /// `chain(["get", "alpha"])` for the two wraps this app has.
    ///
    /// The order is the web app's — `selWrap(dateWrap(own))` — and both wraps
    /// REPLACE the alpha rather than multiplying into it. That is spelled out
    /// in `_applyDimPaint` for the selection ("NOT multiplied into their
    /// alpha, or off-date trains would end up dimmer than same-day ones") and
    /// the date dim behaves the same way, so a ride that is both off-date and
    /// unselected lands on the selection's flat value rather than on the
    /// product of the two.
    ///
    /// - Parameter own: the mark's own alpha, before any scope is applied —
    ///   `DisplaySettings.riddenOpacity` for a ride's stroke, the record's own
    ///   alpha for a dot.
    static func alpha(
        own: CGFloat, span: Dates.DaySpan, scope: Scope,
        isSelected: Bool, hasSelection: Bool
    ) -> CGFloat {
        var value = own
        if scope.isActive, !inScope(span, scope) { value = scope.dimOpacity }
        guard hasSelection else { return value }
        return isSelected ? 1 : RailStyle.selectDim
    }
}
