import RailCore
import RailPresentation
import SwiftUI

/// §5.3 — the recollection surface.
///
/// One question: **how much have I ridden, and which railways does that
/// cover?** Everything on it answers that, in the order §5.3 lists:
///
///   Scope → Coverage map → Statistics → Journey Log → Replay / Export
///
/// It is a container, not a screen of its own: every part below already exists
/// and is composed rather than reimplemented. §5.3.4 is explicit that opening a
/// journey from the log must open the SAME `RideDetailView` the list opens,
/// over the same record id — a Passport-only copy of the detail view would be
/// a second place for one record to be rendered wrong.
///
/// ## Where the scope is chosen (§5.1)
///
/// In exactly one place each. The REGION is picked here, because a statistic
/// cannot span networks — its categories differ (捷運 / 地下鐵, 高鐵 / 新幹線)
/// and coverage is a fraction of one network's own length. The DATE is picked
/// inside the statistics section's own 當日統計 card, where it already was and
/// where it sits next to the numbers it scopes. Two controls, two values, one
/// owner each — which is what §5.1 asks for and what a second date menu up here
/// would have broken.
struct PassportWorkspaceView: View {
    @Environment(AppLocalization.self) private var localization
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Bindable var itineraries: ItineraryStore
    /// Where an edit made here actually lands.
    ///
    /// §5.3.4 opens the SAME journey detail the journeys list opens, and a
    /// detail that saves is only half of saving: `ItineraryStore` holds the
    /// store in memory, and `RideLibrary` is what writes it to disk. Passport
    /// used to have the first half and not the second, so an edit committed
    /// from the log survived until the next launch and no further — while the
    /// identical edit made two taps away in Journeys was durable.
    @Bindable var library: RideLibrary
    @Bindable var statistics: MileageStatisticsStore
    @Bindable var riddenRoutes: RiddenRouteStore
    @Bindable var network: RailNetworkStore
    @Bindable var controller: RailMapController
    @Bindable var playback: PlaybackController
    /// `nil` is 全部 — see `StatisticsView.region`.
    @Binding var region: Region?
    var openData: () -> Void
    var openSettings: () -> Void

    /// The journey whose full record is open. §5.3.4's "必须打开现有
    /// RideDetailView".
    ///
    /// Wrapped rather than held as a bare `Train` because `.sheet(item:)`
    /// wants `Identifiable` and `Train` deliberately is not: its `id` is a
    /// record field the reader edits, and conforming a document type to
    /// `Identifiable` would let SwiftUI treat a renamed record as a different
    /// one mid-presentation. The same reason `RidesSheet` exists in the
    /// journeys workspace.
    @State private var detail: OpenJourney?

    private struct OpenJourney: Identifiable {
        var train: Train
        var id: String { train.id }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                // §5.3.2's coverage map is the ROOT map, and there is no card
                // here that says so.
                //
                // There were two, and both were furniture. The region picker
                // moved to the panel header (§9.5.6's one row per
                // destination); the note that replaced the old 280 pt inline
                // map was left explaining a picture the reader can already see
                // through the glass, above the numbers they opened this screen
                // for. §2.1 keeps "Shared Map Coverage Mode" as a mode of the
                // shared basemap, not as a card — the map draws this region's
                // network with the scoped rides on top, and the statistics
                // below name the region in every percentage they state.

                // The statistics themselves, unchanged — the same cards the
                // dashboard rendered, composed here rather than copied.
                StatisticsDashboardContent(
                    itineraries: itineraries,
                    statistics: statistics,
                    region: $region)

                PassportJourneyLogView(
                    days: logDays,
                    selectedTrainID: itineraries.selectedTrainID,
                    presentation: presentation(for:),
                    onSelect: { train in
                        itineraries.selectedTrainID = train.id
                        detail = OpenJourney(train: train)
                    },
                    onReplay: { replay([$0]) })

                PassportShareCard(
                    canReplay: !scopedTrains.isEmpty,
                    onReplay: { replay(scopedTrains) },
                    onExport: openData)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            // Ordinary tab content: SwiftUI already insets a ScrollView
            // inside a NavigationStack for the tab bar, so §4.3's clearance
            // is the system's here and adding it again would double it. The
            // journeys panel needs it applied by hand only because that panel
            // deliberately ignores the safe area.
            .padding(.bottom, 8)
        }
        // No navigation title and no toolbar: §9.5.6 put both in the bottom
        // chrome's own header, which is the same row on every destination.
        // A NavigationStack in here would have added a second one.
        .sheet(item: $detail) { open in
            NavigationStack {
                RideDetailView(
                    train: open.train,
                    onSave: { edited in
                        itineraries.replace(edited, replacing: open.train.id)
                        persistMine()
                    },
                    onRebuild: {
                        let sections = itineraries.rebuildRouteSections(open.train.id)
                        persistMine()
                        return sections
                    }
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(localization.text("ios.cancel", fallback: "Cancel")) {
                            detail = nil
                        }
                    }
                }
            }
        }
    }

    // MARK: - what is in scope

    /// The journeys this Passport is reporting on: one region, and either one
    /// day or all of them.
    ///
    /// The same two filters the statistics store applies, so the log below can
    /// never list a journey the numbers above it excluded.
    private var scopedTrains: [Train] {
        let trains = itineraries.loaded?.trains ?? []
        return trains.filter { train in
            if let region, Region.resolved(train) != region { return false }
            guard statistics.selectedDate != Dates.allDates else { return true }
            return Dates.trainSpans(train.forDates, date: statistics.selectedDate)
        }
    }

    /// The same journeys, grouped the way the log reads them.
    private var logDays: [ItineraryStore.Loaded.Day] {
        let byDate = Dictionary(grouping: scopedTrains) { $0.date ?? Dates.undated }
        return byDate.keys.sorted().map { date in
            .init(date: date, trains: byDate[date] ?? [])
        }
    }

    /// The same one-line rule the journeys workspace applies after every
    /// mutation: any edit forks a bundled sample into the reader's own store,
    /// so the sample stays immutable on disk and the change is durable.
    private func persistMine() {
        guard let store = itineraries.store else { return }
        library.save(store)
    }

    private func replay(_ trains: [Train]) {
        guard !trains.isEmpty else { return }
        _ = playback.start(
            trains: trains, rides: riddenRoutes.rides, reducedMotion: reduceMotion,
            restoringSelection: itineraries.selectedTrainID)
    }

    private func presentation(for train: Train) -> JourneyPresentation {
        JourneyPresentationResolver.selected(
            train: train,
            route: JourneyBridge.routeState(for: train.id, localization: localization),
            phase: playback.isActive && playback.currentTrainID == train.id
                ? .playing(progress: playback.progress, isPaused: !playback.isPlaying)
                : nil)
    }
}

/// §5.3.5 Replay & Share — two entry points into flows that already exist: the
/// transport Journeys uses, and the Data Library's export.
private struct PassportShareCard: View {
    @Environment(AppLocalization.self) private var localization
    var canReplay: Bool
    var onReplay: () -> Void
    var onExport: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(
                localization.text("grp.passportShare", fallback: "Replay and export"),
                systemImage: "square.and.arrow.up")
                .font(.headline)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { replayButton; exportButton }
                VStack(spacing: 10) { replayButton; exportButton }
            }

            // §2.3 / §2.4: the film is a recording, not a broadcast. Saying so
            // plainly is what keeps Flighty's "Live Share" from being implied
            // by a share button on a journey screen.
            Text(localization.journeyText(
                "ios.passport.shareNote",
                fallback: "Playback is exported as a video file. Nothing is shared live."))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .statisticsCard()
    }

    private var replayButton: some View {
        Button(action: onReplay) {
            Label(
                localization.countryText("btn.play", fallback: "Play"),
                systemImage: "play.fill")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!canReplay)
    }

    private var exportButton: some View {
        Button(action: onExport) {
            Label(
                localization.countryText("btn.exportJson", fallback: "Export JSON"),
                systemImage: "arrow.down.doc")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }
}
