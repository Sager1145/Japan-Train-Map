import Foundation
import RailPresentation
import Testing

/// JRM_FLIGHTY_UI_REFACTOR_SPEC.md §4.3 and §9.3, as numbers.
///
/// §9.3 says a release lands where the flick was *going*, and §4.3 says there
/// are exactly three places it can land. Both are claims about arithmetic, and
/// both are reimplemented in `app/public/app-panel-motion.js` — so the same
/// cases are asserted there, over the same figures, and the two files are only
/// known to agree because both are checked rather than because both were
/// written from the same paragraph.
///
/// The positions below are a 900-point window's detents, near enough: docked
/// clears the tab bar, half is a little over the middle, full is the window
/// less its top margin.
struct PanelDetentResolverTests {

    static let positions: [PanelDetent: Double] = [
        .docked: 100,
        .half: 450,
        .full: 800,
    ]

    // MARK: - §4.3 three stops, and only three

    @Test
    func exactlyThreeDetentsExist() {
        #expect(PanelDetent.allCases == [.docked, .half, .full])
    }

    @Test
    func detentsAreOrderedSmallestFirst() {
        #expect(PanelDetent.docked < PanelDetent.half)
        #expect(PanelDetent.half < PanelDetent.full)
    }

    @Test
    func eachDetentNamesItselfInTheCatalogRatherThanInEnglish() {
        for detent in PanelDetent.allCases {
            // The SHARED catalog's keys — the ones i18n-strings.js spells and
            // Localizable.xcstrings is generated from — so both platforms say
            // the same word for the same stop.
            #expect(detent.localizationKey.hasPrefix("panel."))
            #expect(!detent.fallbackName.isEmpty)
        }
        // The user-facing vocabulary is §4.3's, not the layout type's older
        // Compact/Medium/Expanded spelling.
        #expect(PanelDetent.docked.fallbackName == "Docked")
        #expect(PanelDetent.half.fallbackName == "Half")
        #expect(PanelDetent.full.fallbackName == "Full")
    }

    @Test
    func steppingStopsAtTheEndsButTappingWraps() {
        #expect(PanelDetent.docked.lower == .docked)
        #expect(PanelDetent.full.higher == .full)
        #expect(PanelDetent.docked.higher == .half)
        #expect(PanelDetent.full.lower == .half)
        // A tap on the grabber cycles, so the control never becomes inert.
        #expect(PanelDetent.full.next == .docked)
    }

    // MARK: - §9.3 the stop is chosen from where the flick was going

    @Test
    func aFastUpwardReleaseCanSkipHalfAndLandOnFull() {
        let projected = PanelDetentResolver.projectedPosition(
            position: 180, velocity: 1_500)
        // 180 + 1.5 × 499 = 928.5 — past full, so it snaps back to full.
        #expect(abs(projected - 928.5) < 0.001)
        #expect(
            PanelDetentResolver.nearest(
                projectedPosition: projected, positions: Self.positions) == .full)
    }

    @Test
    func aFastDownwardReleaseCanSkipHalfAndLandOnDocked() {
        let detent = PanelDetentResolver.detent(
            releasedAt: 700, velocity: -1_500, positions: Self.positions)
        #expect(detent == .docked)
    }

    @Test
    func zeroVelocityChoosesTheNearestStop() {
        #expect(
            PanelDetentResolver.detent(
                releasedAt: 120, velocity: 0, positions: Self.positions) == .docked)
        #expect(
            PanelDetentResolver.detent(
                releasedAt: 430, velocity: 0, positions: Self.positions) == .half)
        #expect(
            PanelDetentResolver.detent(
                releasedAt: 780, velocity: 0, positions: Self.positions) == .full)
    }

    /// The case the projection exists for: the finger has barely moved, but it
    /// was moving fast when it left the glass.
    @Test
    func aSlowDragOfTheSameDistanceStaysWhereItWasLetGo() {
        let flicked = PanelDetentResolver.detent(
            releasedAt: 200, velocity: 900, positions: Self.positions)
        let placed = PanelDetentResolver.detent(
            releasedAt: 200, velocity: 0, positions: Self.positions)
        #expect(flicked == .full)
        #expect(placed == .docked)
    }

    @Test
    func anExactTieSettlesDownwardsSoTheMapStaysVisible() {
        // Halfway between docked (100) and half (450).
        #expect(
            PanelDetentResolver.detent(
                releasedAt: 275, velocity: 0, positions: Self.positions) == .docked)
    }

    @Test
    func aDetentTheCallerDoesNotOfferIsNeverChosen() {
        let twoStops: [PanelDetent: Double] = [.docked: 100, .half: 450]
        #expect(
            PanelDetentResolver.detent(
                releasedAt: 900, velocity: 3_000, positions: twoStops) == .half)
    }

    @Test
    func anEmptyDetentSetFallsBackToHalfRatherThanTrapping() {
        #expect(
            PanelDetentResolver.nearest(projectedPosition: 500, positions: [:]) == .half)
    }

    @Test
    func aDegenerateDecelerationRateProjectsNowhereRatherThanToInfinity() {
        for rate in [0.0, 1.0, -0.5, 2.0] {
            let projected = PanelDetentResolver.projectedPosition(
                position: 300, velocity: 5_000, decelerationRate: rate)
            #expect(projected == 300)
        }
    }

    @Test
    func projectionIsSymmetricAboutTheReleasePoint() {
        let up = PanelDetentResolver.projectedPosition(position: 400, velocity: 800)
        let down = PanelDetentResolver.projectedPosition(position: 400, velocity: -800)
        #expect(abs((up - 400) + (down - 400)) < 0.000_001)
    }

    // MARK: - §9.3 resisted past the ends, never clamped

    /// The curve starts at `constant` and only gets stiffer — which is what
    /// "resisted rather than stopped" means to the hand. It is deliberately
    /// NOT free at the start: Apple's curve leaves at slope `c`, so the very
    /// first point of overshoot already moves at 55% of the finger, and the
    /// rate falls away from there.
    @Test
    func resistanceStartsAtTheConstantAndOnlyGetsStiffer() {
        let constant = 0.55
        let dimension = 900.0
        let firstPoint = PanelDetentResolver.rubberBand(
            overshoot: 0.001, dimension: dimension, constant: constant)
        #expect(abs(firstPoint / 0.001 - constant) < 0.001)

        // Each further 20 points of finger travel buys strictly less panel
        // than the 20 before it.
        var previousGain = Double.greatestFiniteMagnitude
        var previous = 0.0
        for overshoot in stride(from: 20.0, through: 400.0, by: 20.0) {
            let moved = PanelDetentResolver.rubberBand(
                overshoot: overshoot, dimension: dimension, constant: constant)
            let gain = moved - previous
            #expect(gain < previousGain)
            previousGain = gain
            previous = moved
        }
    }

    @Test
    func resistanceGrowsMonotonicallyAndNeverHardClamps() {
        var previous = 0.0
        for overshoot in stride(from: 5.0, through: 600.0, by: 5.0) {
            let moved = PanelDetentResolver.rubberBand(overshoot: overshoot, dimension: 900)
            // Still moving — a clamp would repeat the previous value.
            #expect(moved > previous)
            // But always less than the raw finger travel, which is what makes
            // it read as resistance rather than as tracking.
            #expect(moved < overshoot)
            previous = moved
        }
    }

    @Test
    func resistanceAsymptotesToTheDimensionItIsScaledAgainst() {
        let huge = PanelDetentResolver.rubberBand(overshoot: 1_000_000, dimension: 900)
        #expect(huge < 900)
        #expect(huge > 890)
    }

    @Test
    func aNegativeOrZeroOvershootMovesNothing() {
        #expect(PanelDetentResolver.rubberBand(overshoot: 0, dimension: 900) == 0)
        #expect(PanelDetentResolver.rubberBand(overshoot: -30, dimension: 900) == 0)
        #expect(PanelDetentResolver.rubberBand(overshoot: 30, dimension: 0) == 0)
    }

    /// The app's panel scales resistance against a fixed 110-point ceiling
    /// rather than against the window. `constant: 1` is the spelling that
    /// reduces Apple's curve to `o·L/(o+L)`, which is the curve the panel has
    /// always used — this asserts the two are the same function so the app can
    /// call this one instead of keeping a second copy.
    @Test
    func aFixedCeilingIsTheSameCurveWithConstantOne() {
        let limit = 110.0
        for overshoot in [1.0, 10.0, 55.0, 110.0, 400.0] {
            let shared = PanelDetentResolver.rubberBand(
                overshoot: overshoot, dimension: limit, constant: 1)
            let original = limit * (1 - 1 / (overshoot / limit + 1))
            #expect(abs(shared - original) < 0.000_001)
        }
    }
}
