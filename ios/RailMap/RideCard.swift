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
    var dateChipTitle: String?
    var onClose: () -> Void
    var onOpenDate: (String) -> Void
    var onPrimary: (JourneyPresentation.PrimaryAction) -> Void
    var onSecondary: (SecondaryAction) -> Void

    @Environment(AppLocalization.self) private var localization

    private var isCompact: Bool { stage == .compact }

    var body: some View {
        VStack(spacing: 0) {
            header(compact: isCompact)
                .padding(.horizontal, 16)
                .padding(.bottom, isCompact ? 12 : 10)

            if !isCompact {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        RouteTimingView(
                            origin: train.origin,
                            destination: train.destination,
                            departure: departureTime,
                            arrival: arrivalTime
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
                            surface: AnyShapeStyle(Color.primary.opacity(0.05)),
                            scrolls: false
                        )
                    }
                    .padding(.top, 4)
                }
                // The panel reaches under the system tab bar — its surface has
                // to, or a translucent tab bar sits on a hard edge — so the
                // last card needs room to scroll clear of it. Content margin
                // rather than padding: padding would move the scroll
                // indicator too.
                .contentMargins(.bottom, 104, for: .scrollContent)
                .transition(.opacity)
            }
        }
        // The card's compact height, measured from a copy that is always in
        // its compact form. See `compactChromeProbe`.
        .compactChromeProbe(.ride) {
            header(compact: true)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
        }
    }

    // MARK: - the header, morphing

    private func header(compact: Bool) -> some View {
        HStack(alignment: compact ? .center : .top, spacing: 10) {
            VStack(alignment: .leading, spacing: compact ? 2 : 6) {
                // §3.2 puts the date above the number as an eyebrow; the
                // resolver supplies it, and it is a Button because §5.2 makes
                // the date chip the way back to that day's list rather than a
                // decoration.
                if !compact, let date = dateChipTitle {
                    dateChip(date)
                }

                Text(train.number)
                    .font(compact ? .subheadline.weight(.bold) : .title2.weight(.bold))
                    .lineLimit(compact ? 1 : 3)
                    .fixedSize(horizontal: false, vertical: !compact)

                if compact {
                    // Collapsed, the journey has to say what it is in one line:
                    // the pair of stations and the time it left. The reason the
                    // panel is collapsed is that the reader wants the map, not
                    // that they stopped caring which journey is on it.
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
            }

            Spacer(minLength: 4)

            // Compact offers the one action the resolver chose; open offers the
            // whole group below. The close button is in the same place in both.
            if compact, let primary = presentation.primaryAction {
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
                    localization.journeyText("ios.journey.backToList", fallback: "Back to the list")),
                action: onClose
            )
        }
        .accessibilityElement(children: .contain)
    }

    private func dateChip(_ date: String) -> some View {
        Button { onOpenDate(date) } label: {
            HStack(spacing: 5) {
                Image(systemName: "chevron.left")
                    .font(.caption2.weight(.bold))
                Text(date).monospacedDigit()
                if let type = train.trainType, !type.isEmpty {
                    Text("·")
                    Text(type)
                }
            }
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Color.accentColor.opacity(0.14), in: Capsule())
            .overlay { Capsule().stroke(Color.accentColor.opacity(0.35), lineWidth: 1) }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
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
