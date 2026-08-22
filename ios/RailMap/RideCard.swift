import RailCore
import SwiftUI

/// One recorded journey, as the ride panel draws it.
///
/// This is the same journey the sidebar pushes into a navigation stack, but it
/// is not a pushed screen: it is the panel's single surface showing something
/// else. So it has to be legible at every height the panel can rest at, and
/// the way it gets there is the point.
///
/// **The header is one container at all three stages.** Compact and expanded do
/// not swap two different headers — the same `HStack`, holding the same
/// `VStack`, holding the same two `Text`s, changes its alignment, its spacing,
/// its fonts and which of its children exist. That is what lets the train
/// number *travel* from the small line at the top of a collapsed card to the
/// title of an open one instead of cross-fading into a different view at a
/// different place. Replace the header per stage and the reader loses the
/// thread of what they tapped.
///
/// **The compact stage is the card's identity, and nothing else.** A journey
/// collapsed to a bar still says which train it is, where it runs and when it
/// left, because the reason it is collapsed is that the reader wants the map —
/// not that they have stopped caring which journey is drawn on it.
struct RideCard: View {
    let train: Train
    var stage: SheetStage
    var dateChipTitle: String?
    var isPlaying: Bool
    var onClose: () -> Void
    var onPlay: () -> Void
    var onFit: () -> Void
    var onOpenDate: (String) -> Void
    var onSave: (Train) -> Void
    var onRebuild: () -> Int?
    var onToggleVisibility: () -> Void
    var onDuplicate: () -> Void
    var onDelete: () -> Void

    @Environment(AppLocalization.self) private var localization
    @State private var showsEditor = false

    private var isCompact: Bool { stage == .compact }

    var body: some View {
        VStack(spacing: 0) {
            header(compact: isCompact)
                .padding(.horizontal, 16)
                .padding(.bottom, isCompact ? 12 : 10)

            if !isCompact {
                ScrollView {
                    VStack(spacing: 0) {
                        actionRow
                            .padding(.horizontal, 16)
                            .padding(.top, 2)
                        RideDetailContent(
                            train: train,
                            onRebuild: onRebuild,
                            includesIdentity: false,
                            surface: AnyShapeStyle(Color.primary.opacity(0.05)),
                            scrolls: false
                        )
                    }
                    .padding(.bottom, 28)
                }
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
        .sheet(isPresented: $showsEditor) {
            RideEditorView(
                train: train,
                title: localization.text("ios.editJourney", fallback: "Edit journey")
            ) { edited in
                onSave(edited)
                showsEditor = false
            }
        }
    }

    // MARK: - the header, morphing

    private func header(compact: Bool) -> some View {
        HStack(alignment: compact ? .center : .top, spacing: 10) {
            VStack(alignment: .leading, spacing: compact ? 2 : 6) {
                Text(train.number)
                    .font(compact ? .subheadline.weight(.bold) : .title2.weight(.bold))
                    .lineLimit(compact ? 1 : 2)
                    .minimumScaleFactor(0.85)

                if compact {
                    // Collapsed, the journey has to say what it is in one line:
                    // the pair of stations and the time it left.
                    HStack(spacing: 5) {
                        Text(train.origin)
                        Image(systemName: "arrow.right").imageScale(.small)
                        Text(train.destination)
                        if let time = departureTime {
                            Text("·")
                            Text(time).monospacedDigit()
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                } else if let date = dateChipTitle {
                    // Open, the same slot carries the way back. Tapping the
                    // date returns to the list *with that date selected*, so
                    // the journey the reader closes is the one they land next
                    // to rather than one of two hundred.
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
            }

            Spacer(minLength: 4)

            // Compact offers the one action the map is for; open offers the
            // rest. The close button is in the same place in both.
            if compact {
                SheetIconButton(
                    systemImage: isPlaying ? "stop.fill" : "play.fill",
                    accessibilityLabel: Text(
                        isPlaying
                            ? localization.text("play.stop", fallback: "Stop playback")
                            : localization.text("play.start", fallback: "Play journey")
                    ),
                    action: onPlay
                )
            } else {
                Menu {
                    journeyMenu
                } label: {
                    SheetIconLabel(systemImage: "ellipsis")
                }
                .accessibilityLabel(Text(localization.text("ios.journeyInfo", fallback: "Journey actions")))
            }

            SheetIconButton(
                systemImage: "xmark",
                accessibilityLabel: Text(localization.text("btn.clearSelection", fallback: "Back to the list")),
                action: onClose
            )
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - the action row

    /// Three verbs, because they are the three things a journey on a map is
    /// for: watch it, find it, correct it.
    private var actionRow: some View {
        HStack(spacing: 8) {
            action(
                localization.text("play.start", fallback: "Play"),
                systemImage: isPlaying ? "stop.fill" : "play.fill",
                prominent: true,
                action: onPlay
            )
            action(
                localization.text("btn.fit", fallback: "Locate"),
                systemImage: "scope",
                prominent: false,
                action: onFit
            )
            action(
                localization.text("ios.edit", fallback: "Edit"),
                systemImage: "pencil",
                prominent: false
            ) {
                showsEditor = true
            }
        }
    }

    private func action(
        _ title: String,
        systemImage: String,
        prominent: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 56)
            .foregroundStyle(prominent ? AnyShapeStyle(Color.white) : AnyShapeStyle(Color.primary))
            .background(
                prominent ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color.primary.opacity(0.07)),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var journeyMenu: some View {
        Button(action: onToggleVisibility) {
            Label(
                train.visible == false
                    ? localization.text("state.shown", fallback: "Show on map")
                    : localization.text("state.hidden", fallback: "Hide from map"),
                systemImage: train.visible == false ? "eye" : "eye.slash"
            )
        }
        Button(action: onDuplicate) {
            Label(localization.text("btn.duplicate", fallback: "Duplicate"), systemImage: "plus.square.on.square")
        }
        Divider()
        Button(role: .destructive, action: onDelete) {
            Label(localization.text("btn.delete", fallback: "Delete"), systemImage: "trash")
        }
    }

    private var departureTime: String? {
        let time = train.stops.first?.departure ?? train.stops.first?.arrival
        guard let time, !time.isEmpty else { return nil }
        return time
    }
}
