import RailCore
import RailPresentation
import SwiftUI

/// §5.2 / §7.2 — the selected journey, as the ride panel draws it.
///
/// This is the same journey the sidebar pushes into a navigation stack, but it
/// is not a pushed screen: it is the panel's single surface showing something
/// else. So it has to be legible at every height the panel can rest at, and
/// the way it gets there is the point.
///
/// **The header is one container at all three stages.** Compact and expanded do
/// not swap two different headers — the same `HStack`, holding the same
/// `VStack`, holding the same `Text(train.number)`, changes its alignment, its
/// spacing, its fonts and which of its children exist. That is what lets the
/// train number *travel* from the small line at the top of a collapsed card to
/// the title of an open one instead of cross-fading into a different view at a
/// different place (§4.4, §9.1). Replace the header per stage and the reader
/// loses the thread of what they tapped.
///
/// **The identity is the title in every state, and the state is a block below
/// it.** The resolver's `title` becomes "路线需要检查" or "已从地图隐藏" when
/// something has happened to the journey, and rendering that *as the card's
/// heading* would mean the reader who selected 踊り子1号 is looking at a card
/// whose biggest text is not 踊り子1号. §5.2's 状态放大 wants the state
/// amplified, not the identity replaced — so the title stays the train number
/// and `JourneyStateBlock` carries what the resolver decided.
///
/// **Nothing here decides which action is primary.** The single filled button,
/// the quiet verbs and the More menu all come from one `JourneyPresentation`
/// (§3.3, §11.2). A card that re-derived "is it hidden, is it playing, did the
/// route fail" from the train would be the fifth place in the app answering a
/// question that has one answer.
struct RideCard: View {
    let train: Train
    /// The resolved surface — see `JourneyPresentationResolver.selected`.
    var presentation: JourneyPresentation
    var stage: SheetStage
    /// Where the sheet is between its compact and half stops, 0…1.
    ///
    /// The same number `PanelHeader` interpolates against, and it is here for
    /// the same reason: §9.5.5 point 6 — the bound `PresentationDetent` only
    /// changes once the sheet has SETTLED, so a header keyed off `stage` alone
    /// changes a beat after the finger and does it in one step. This card used
    /// to do exactly that, which meant one drag moved two headers on two
    /// different clocks: the panel's title tracked the finger while the
    /// journey's did not.
    var expansionProgress: CGFloat = 1
    var dateChipTitle: String?
    var onClose: () -> Void
    var onOpenDate: (String) -> Void
    var onPrimary: (JourneyPresentation.PrimaryAction) -> Void
    var onSecondary: (SecondaryAction) -> Void

    @Environment(AppLocalization.self) private var localization
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    /// The train number's two sizes, as `.subheadline` and `.title2` measure
    /// at the reader's text size. Named metrics rather than the two text
    /// styles, because a size that is INTERPOLATED cannot be a style.
    @ScaledMetric(relativeTo: .subheadline) private var compactNumberSize: CGFloat = 15
    @ScaledMetric(relativeTo: .title2) private var expandedNumberSize: CGFloat = 22
    /// The collapsed height of the two rows that belong to one stop only.
    @ScaledMetric(relativeTo: .caption) private var dateChipHeight: CGFloat = 27
    @ScaledMetric(relativeTo: .caption) private var identityLineHeight: CGFloat = 17
    @ScaledMetric(relativeTo: .caption2) private var badgeHeight: CGFloat = 20

    private var isCompact: Bool { stage == .compact }

    /// Whether the identity header scrolls WITH the card instead of standing
    /// above it.
    ///
    /// Normally it is fixed, and that is right: it is the answer to "which
    /// journey is this", and a reader who has scrolled to the stop list should
    /// not have lost the name of the service they are reading about.
    ///
    /// It stops being right in one window. A landscape phone is 402 points
    /// tall, and at an accessibility text size the panel column carries TWO
    /// fixed headers — `PanelHeader` above and this one — whose combined
    /// height exceeds it. `tabPage`'s `VStack` cannot shrink either of them, so
    /// it overflowed and was clipped at BOTH ends: the date's year row and the
    /// panel title went off the top while the actions went under the tab bar,
    /// and nothing the reader could do reached either.
    ///
    /// So in that one case the second fixed header becomes scrolling content.
    /// `PanelHeader` stays put — it answers "where am I" and carries the
    /// global entries (§16 wayfinding) — and everything about the JOURNEY
    /// joins the scroll it already had. One scroll container, not two: a
    /// wrapper around `tabPage` would have nested this card's own `ScrollView`
    /// inside another, which trades a clipped header for two competing
    /// scrolls.
    ///
    /// Deliberately keyed on `verticalSizeClass` rather than on a measured
    /// height: it is exactly the "short window" the trait exists to name, and
    /// it is `.regular` on an iPhone in portrait and on every iPad, which is
    /// why those keep the fixed header at every text size.
    private var scrollsHeader: Bool {
        dynamicTypeSize.isAccessibilitySize
            && verticalSizeClass == .compact
            && !isCompact
    }

    /// The morph's driver.
    ///
    /// Reduce Motion collapses the continuous value back to its two named
    /// ends, and the modifier at the bottom of `body` turns that step into
    /// §9.4's short in-place replacement. Identical to `PanelHeader`'s rule on
    /// purpose: two headers morphing on two clocks during one drag is worse
    /// than either rule applied consistently.
    private var progress: CGFloat {
        let live = min(max(expansionProgress, 0), 1)
        return reduceMotion ? (stage == .compact ? 0 : 1) : live
    }

    private func interpolated(_ compact: CGFloat, _ expanded: CGFloat) -> CGFloat {
        compact + (expanded - compact) * progress
    }

    var body: some View {
        VStack(spacing: 0) {
            if !scrollsHeader {
                header
                    .padding(.horizontal, 16)
                    .padding(.bottom, interpolated(12, 10))
            }

            Group {
                if !isCompact {
                    ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if scrollsHeader {
                            // No bottom padding of its own here: the stack's
                            // own 14-point spacing is what separates it from
                            // the route below, and adding both would open a
                            // gap this card does not have anywhere else.
                            header
                                .padding(.horizontal, 16)
                        }

                        RouteTimingView(
                            origin: train.origin,
                            destination: train.destination,
                            departure: departureTime,
                            arrival: arrivalTime,
                            originPlatform: train.stops.first?.platformNumber,
                            destinationPlatform: train.stops.last?.platformNumber
                        )
                        .padding(.horizontal, 16)

                        // §5.5: when the route needs a decision, the reason and
                        // the affected interval come BEFORE the actions.
                        if JourneyStateBlock.isPresent(presentation) {
                            JourneyStateBlock(presentation: presentation)
                                .padding(.horizontal, 16)
                        }

                        QuietActionGroup(
                            presentation: presentation,
                            arrangesJourneyControlsInOneRow: true,
                            perform: onPrimary,
                            performSecondary: onSecondary
                        )
                        .padding(.horizontal, 16)

                        // The stop timeline and the service metadata — L3 and
                        // L4 (§3.1), below the Hero that answers L1 and L2.
                        //
                        // `onRebuild` is deliberately NOT forwarded, and this
                        // is the one place it matters: `RideDetailContent`
                        // draws its own §5.5 route-state card, and handing it
                        // a rebuild action would put a second button for the
                        // same task on a surface whose Hero already carries it
                        // as the one filled action (§3.1: 同一表面最多出现一个
                        // 填充强调的主按钮). The card stays as the explanation
                        // it is; the Hero above owns the verb. The pushed
                        // detail screen still gets the action, because there
                        // the card IS the surface.
                        RideDetailContent(
                            train: train,
                            includesIdentity: false,
                            includesStationPair: false,
                            surface: AnyShapeStyle(Color.primary.opacity(0.05)),
                            scrolls: false
                        )
                    }
                    .padding(.top, 4)
                }
                // No bottom content margin here, and that is the fix rather
                // than an omission: the panel reaches under the system tab
                // bar, and SwiftUI already insets this scroll view's content
                // by that strip as bottom safe area. The `104` that used to be
                // on this line was a second copy of it — `.contentMargins`
                // composes with the safe area instead of replacing it — which
                // ended the card 200 points above the window rather than 83.
                // See `UtilityDestination.swift`'s note.
                    .transition(.opacity)
                }
            }
            // This animation belongs only to mounting the detail body. Keeping
            // it on this subgroup prevents the same transaction from animating
            // the header's font, padding and reserved heights under Reduce
            // Motion. The header remains 1:1 normally and changes immediately
            // between named states when motion is reduced.
            .animation(
                reduceMotion ? RailMotion.reduced : RailMotion.replace,
                value: isCompact)
        }
        // The one thing in this card that CANNOT be interpolated: the body is
        // mounted or it is not, and mounting the whole detail stack at the
        // collapsed stop to fade it would cost the map the frames the collapsed
        // stop exists to give it.
        //
        // So it is a threshold, and this is what makes its `.transition`
        // actually run — a transition is inert without an animated transaction
        // around the insertion. Keyed on `isCompact` rather than on the live
        // height, which is what keeps it from touching the header: the header's
        // interpolated values change on frames where `isCompact` did not, and
        // `animation(_:value:)` only animates the transaction that changed the
        // value it was given.
        .transaction { transaction in
            if reduceMotion {
                // Do not inherit the system sheet's movement transaction. The
                // body subgroup above still supplies its own opacity-only fade.
                transaction.animation = nil
            }
        }
    }

    // MARK: - the header, morphing

    /// One header at every stop, interpolated — never two headers swapped.
    ///
    /// Every number below is a function of ``progress``, so the train number
    /// GROWS from the collapsed line into the open card's title instead of
    /// cross-fading into a different view at a different place (§4.4, §9.1).
    /// The two rows that belong to one stop only — the date chip above and the
    /// station pair below — fade and collapse their height on the same clock,
    /// the way `PanelHeader` handles its subtitle.
    ///
    /// There is deliberately NO animation on any of this. The value is already
    /// tracking the reader's finger; putting a spring on it would add lag to a
    /// gesture that is already 1:1, which is the opposite of what §9.3 asks.
    private var header: some View {
        // `.top` at every stop rather than `.center` when collapsed. An
        // alignment cannot be interpolated, so it was the one thing in this
        // row that still jumped mid-drag; the buttons take a small
        // interpolated top inset instead, which reads as centred against the
        // short collapsed block and as top-aligned against the tall open one.
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: interpolated(2, 6)) {
                // §3.2 puts the date above the number as an eyebrow; the
                // resolver supplies it, and it is a Button because §5.2 makes
                // the date chip the way back to that day's list rather than a
                // decoration.
                if let date = dateChipTitle {
                    dateChip(date)
                        .opacity(progress)
                        // Reserved height only while the row is collapsing.
                        // Fully open it sizes itself, for exactly the reason
                        // `PanelHeader`'s subtitle does: `dateChipHeight` is a
                        // scaled estimate of ONE line, and at an accessibility
                        // size this chip holds two — clipping the second is the
                        // same loss the wrap was added to prevent.
                        .frame(
                            height: progress >= 1 ? nil : dateChipHeight * progress,
                            alignment: .top)
                        .clipped()
                        .allowsHitTesting(progress > 0.5)
                        .accessibilityHidden(progress < 0.5)
                }

                Text(train.number)
                    // Interpolated rather than swapped between two `Font`s, for
                    // the reason ``RailInterpolatedFont`` gives and for the one
                    // `expansionProgress` gives above: this number and the panel
                    // title move on ONE clock, and a plain `.font()` follows the
                    // drag but not the spring that settles it.
                    .railInterpolatedFont(
                        size: interpolated(compactNumberSize, expandedNumberSize),
                        weight: .bold)
                    // §14.4: no key content truncated at an accessibility text
                    // size. Three lines is a sensible ceiling for a名前 like
                    // 「はるか38号（Haruka 38）（1038M）」 at ordinary sizes; at
                    // an accessibility size the same name needs six, and
                    // cutting it is cutting the answer to "which journey is
                    // this". The collapsed header keeps its single line — that
                    // form exists to leave the map visible, and it is one tap
                    // from the full one.
                    // Three lines ordinarily, six at an accessibility size —
                    // which is what the note above always said and what the
                    // code did not do. It was harmless while the app clamped
                    // Dynamic Type at `xxxLarge`, because the sizes that need
                    // six lines could not be reached; with that ceiling gone
                    // (see `RailMapApp.swift`) a long service name at
                    // `accessibility5` is cut at the third line, and the
                    // sentence being cut is the answer to "which journey is
                    // this".
                    .lineLimit(progress > 0.5 ? (dynamicTypeSize.isAccessibilitySize ? 6 : 3) : 1)
                    .fixedSize(horizontal: false, vertical: progress > 0.5)

                // Collapsed, the journey has to say what it is in one line: the
                // pair of stations and the time it left. The reason the panel
                // is collapsed is that the reader wants the map, not that they
                // stopped caring which journey is on it. Open, `RouteTiming`
                // below says the same thing properly, so this one gives its
                // height back rather than repeating it.
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 5) {
                        Text(localization.stationName(train.origin))
                        Image(systemName: "arrow.right")
                            .imageScale(.small)
                            .accessibilityHidden(true)
                        Text(localization.stationName(train.destination))
                        if let time = departureTime {
                            Text("·")
                            Text(time).monospacedDigit()
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                    // Collapsed, the state still has to be visible: a journey
                    // whose route failed must not look identical to one that
                    // drew (§3.1 — colour second, text first).
                    if let badge = presentation.heroStatus {
                        JourneyStatusBadge(status: badge, compact: true)
                    }
                }
                .opacity(1 - progress)
                .frame(height: collapsedIdentityHeight * (1 - progress), alignment: .top)
                .clipped()
                .accessibilityHidden(progress > 0.5)
            }

            Spacer(minLength: 4)

            HStack(spacing: 2) {
                // Compact offers the one action the resolver chose; open offers
                // the whole group below. The close button is in the same place
                // in both.
                if isCompact, let primary = presentation.primaryAction {
                    let appearance = primary.appearance(localization)
                    SheetIconButton(
                        systemImage: appearance.systemImage,
                        accessibilityLabel: Text(appearance.label),
                        action: { onPrimary(primary) }
                    )
                }

                SheetIconButton(
                    systemImage: "xmark",
                    accessibilityLabel: Text(
                        localization.journeyText(
                            "ios.journey.backToList", fallback: "Back to the list")),
                    action: onClose
                )
            }
            .padding(.top, actionsTopInset)
        }
        .accessibilityElement(children: .contain)
    }

    /// The height the collapsed identity block gives back as the card opens.
    ///
    /// Derived from the two scaled metrics rather than measured from the live
    /// view: a height read back from a view this same number is scaling is a
    /// layout loop, and it would settle at zero.
    private var collapsedIdentityHeight: CGFloat {
        presentation.heroStatus == nil
            ? identityLineHeight
            : identityLineHeight + 4 + badgeHeight
    }

    /// Where the trailing buttons sit against the collapsed text block.
    ///
    /// An alignment cannot be interpolated, so the row is `.top` at every stop
    /// and this is what keeps the collapsed form READING as centred: half the
    /// difference between the text block and the 44-point button, going to
    /// zero as the card opens and the block grows past it.
    private var actionsTopInset: CGFloat {
        let block = compactNumberSize * 1.2 + 2 + collapsedIdentityHeight
        return max(0, (block - 44) / 2) * (1 - progress)
    }

    private func dateChip(_ date: String) -> some View {
        // The chip carries the date this journey is filed under, and the date
        // is how the reader gets back to that day's list (§5.2).
        //
        // A capsule at the standard sizes and a continuous rounded rectangle
        // at an accessibility one, because at those sizes it holds TWO lines:
        // a capsule's end caps are drawn for a single line of text and a
        // two-line one reads as a lozenge with the corners cut off.
        let shape = AnyShape(
            dynamicTypeSize.isAccessibilitySize
                ? AnyShape(RoundedRectangle(
                    cornerRadius: RailStyle.controlCornerRadius,
                    style: .continuous))
                : AnyShape(Capsule()))
        return Button { onOpenDate(date) } label: {
            chipContent
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 9)
                // At the standard text sizes this is the same 34-point visual
                // body as the close button beside it and the controls below.
                // The outer 44-point frame is the hit target, just like
                // `SheetIconButton`. AX keeps its intrinsic two-line height —
                // forcing that content back into 34 points would clip the date.
                .frame(
                    height: dynamicTypeSize.isAccessibilitySize
                        ? nil
                        : SheetIconButton<Image>.visualSide)
                .background(Color.accentColor.opacity(0.14), in: shape)
                .overlay { shape.stroke(Color.accentColor.opacity(0.35), lineWidth: 1) }
                .contentShape(shape)
                .frame(minHeight: 44)
        }
        .buttonStyle(RailPressStyle())
        // The whole date, spoken, whichever way it is drawn — a reader hearing
        // this control must not be given the wrapped halves as two fragments.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(date))
        .accessibilityHint(
            Text(localization.journeyText(
                "ios.journey.backToDate", fallback: "Back to this day's journeys")))
    }

    @ViewBuilder
    private var chipContent: some View {
        let date = dateChipTitle ?? ""
        // At an accessibility size the date WRAPS rather than losing anything.
        //
        // The year is part of the record's identity — 「12-31」 is ambiguous the
        // moment the reader has two years of journeys — so it is not the thing
        // that gives way. What gives way is the single line: the year goes
        // above, the month and day below, and the train type drops because it
        // is already the first word of the title directly underneath.
        let type = (train.trainType?.isEmpty == false) && !dynamicTypeSize.isAccessibilitySize
            ? train.trainType : nil
        HStack(spacing: 5) {
            Image(systemName: "chevron.left")
                .font(.caption2.weight(.bold))
            if dynamicTypeSize.isAccessibilitySize, let split = Self.splitDate(date) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(split.year).monospacedDigit()
                    Text(split.monthDay).monospacedDigit()
                }
                .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(date).monospacedDigit().lineLimit(1)
                if let type {
                    Text("·")
                    Text(type).lineLimit(1)
                }
            }
        }
    }

    /// `2025-12-31` as its year and the rest of it.
    ///
    /// `nil` for anything that is not a leading four-digit year followed by a
    /// separator — the two date sentinels, and any spelling a future package
    /// introduces — so an unrecognised string is drawn whole on one line
    /// rather than split at a guess.
    private static func splitDate(_ date: String) -> (year: String, monthDay: String)? {
        guard date.count > 5 else { return nil }
        let year = String(date.prefix(4))
        guard year.allSatisfy(\.isNumber) else { return nil }
        let rest = date.dropFirst(5)
        guard !rest.isEmpty else { return nil }
        return (year, String(rest))
    }

    // MARK: - times

    private var departureTime: String? {
        let time = train.stops.first?.departure ?? train.stops.first?.arrival
        guard let time, !time.isEmpty else { return nil }
        return time
    }

    /// The last call's arrival. `25:10` stays `25:10` — §7.3 keeps a 24+ hour
    /// business time as written rather than rolling it into the next date.
    private var arrivalTime: String? {
        let time = train.stops.last?.arrival ?? train.stops.last?.departure
        guard let time, !time.isEmpty else { return nil }
        return time
    }
}
