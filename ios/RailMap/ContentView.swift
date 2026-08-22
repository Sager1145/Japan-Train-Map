import CoreLocation
import MapKit
import RailCore
import SwiftUI

/// The railway over Apple Maps, in the two shapes iOS asks for.
///
/// The compact case is a persistent map workspace: the map and the ride panel
/// remain interactive members of the same hierarchy. It deliberately is not a
/// modal sheet. The panel snaps between three semantic sizes and reserves room
/// for the system tab bar, while the drag handle is the only surface that owns
/// the vertical resize gesture.
///
/// The layout is chosen by the window's shape, not the device. A phone in
/// landscape has almost no height for a sheet but plenty of width for a
/// sidebar, and it reports a *compact* horizontal size class on every model
/// but the largest — so size class alone would put a sheet there and leave the
/// map a letterbox.
///
///   tall windows   a resizable persistent panel over the map
///   wide windows   the ride list beside the map
///
/// The map's controls run down the right edge in both, and in the panel
/// layout they ride above it — at full height they are removed rather than
/// pushed off screen. A control the panel slides over is one that stops
/// working without ever looking broken.
struct RidesWorkspaceView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(AppLocalization.self) private var localization

    @Bindable var store: RailNetworkStore
    @Bindable var itineraries: ItineraryStore
    @Bindable var library: RideLibrary
    @Bindable var riddenRoutes: RiddenRouteStore
    @Bindable var controller: RailMapController
    @Binding var country: String
    @State private var render: RailMapView.RenderStats?
    @State private var query = ""
    @State private var selectedDate = Dates.allDates
    @State private var deleteCandidate: Train?
    @State private var newJourneyDraft: Train?
    @State private var compactPanelDetent = CompactPanelDetent.medium
    @State private var playback = PlaybackController()
    @State private var videoExporter = PlaybackVideoExporter()
    @State private var didRunDebugPlayback = false
    @State private var manualDates: [String] = []
    @State private var showsAddDate = false
    @State private var newManualDate = ""
    @AppStorage("map-follows-selected-date") private var mapFollowsSelectedDate = false
    @GestureState private var panelDrag: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private enum CompactPanelDetent: Int, CaseIterable {
        case compact
        case medium
        case expanded
    }

    var body: some View {
        GeometryReader { geometry in
            // Wider than tall, or a regular-width window: sidebar. Read from
            // the geometry so a rotation or an iPad window resize switches
            // layouts as it happens.
            if geometry.size.width > geometry.size.height || horizontalSizeClass == .regular {
                sidebarLayout
            } else {
                compactLayout(in: geometry)
            }
        }
        .onChange(of: playback.currentTrainID) { _, id in
            if let id { itineraries.selectedTrainID = id }
        }
        .task(id: country) { manualDates = loadManualDates() }
        .alert("Add date", isPresented: $showsAddDate) {
            TextField("YYYY-MM-DD", text: $newManualDate)
            Button(localization.text("ios.cancel", fallback: "Cancel"), role: .cancel) {}
            Button(localization.text("btn.add", fallback: "Add")) { addManualDate() }
                .disabled(Dates.normalizeDateString(newManualDate) == nil)
        } message: {
            Text("Create an empty date bucket for journeys you will add later.")
        }
        .onDisappear {
            videoExporter.cancel(clearPlayback: false)
            playback.stop()
        }
#if DEBUG
        .task(id: "\(riddenRoutes.rides.count)|\(controller.isMapReady)") {
            guard !didRunDebugPlayback,
                  ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_PLAYBACK"] == "1",
                  controller.isMapReady, !riddenRoutes.rides.isEmpty,
                  let train = itineraries.loaded?.trains.first(where: {
                      rideIDs.contains($0.id)
                  }) else { return }
            didRunDebugPlayback = true
            try? await Task.sleep(for: .milliseconds(500))
            _ = playback.start(
                trains: [train], rides: riddenRoutes.rides,
                reducedMotion: reduceMotion)
        }
#endif
    }

    // MARK: - tall windows: map plus a persistent, non-modal ride panel

    private func compactLayout(in geometry: GeometryProxy) -> some View {
        let panelHeight = compactPanelHeight(in: geometry)

        return ZStack(alignment: .bottomTrailing) {
            map
            playbackBar
                .padding(.horizontal, 12)
                .padding(.bottom, panelHeight + 12)
            controlStack
                .padding(.trailing, 12)
                .padding(.bottom, panelHeight + 12)
                .opacity(compactPanelDetent == .expanded ? 0 : 1)

            VStack(spacing: 0) {
                panelHandle
                ridesList
            }
            .frame(height: panelHeight)
            .background(Color(.systemBackground))
            .clipShape(.rect(topLeadingRadius: 24, topTrailingRadius: 24))
            .shadow(color: .black.opacity(0.14), radius: 18, y: -5)
        }
        .animation(panelAnimation, value: compactPanelDetent)
    }

    private func compactPanelHeight(in geometry: GeometryProxy) -> CGFloat {
        let available = geometry.size.height
        let target: CGFloat = switch compactPanelDetent {
        case .compact: min(380, available * (dynamicTypeSize.isAccessibilitySize ? 0.56 : 0.46))
        case .medium: available * (dynamicTypeSize.isAccessibilitySize ? 0.76 : 0.62)
        case .expanded: available - max(geometry.safeAreaInsets.top, 12)
        }
        return min(max(target - panelDrag, 280), available)
    }

    private var panelHandle: some View {
        Button {
            withAnimation(panelAnimation) {
                compactPanelDetent = compactPanelDetent == .expanded ? .medium : .expanded
            }
        } label: {
            Capsule()
                .fill(.tertiary)
                .frame(width: 36, height: 5)
                .frame(maxWidth: .infinity, minHeight: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Resize ride panel")
        .accessibilityValue(panelDetentAccessibilityValue)
        .accessibilityHint("Double tap to alternate between medium and expanded")
        .gesture(panelResizeGesture)
    }

    private var panelResizeGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .updating($panelDrag) { value, state, _ in
                state = value.translation.height
            }
            .onEnded { value in
                let projected = value.predictedEndTranslation.height
                let direction = projected < -36 ? -1 : projected > 36 ? 1 : 0
                guard direction != 0 else { return }
                let next = min(
                    max(compactPanelDetent.rawValue - direction, CompactPanelDetent.compact.rawValue),
                    CompactPanelDetent.expanded.rawValue
                )
                if let detent = CompactPanelDetent(rawValue: next) {
                    compactPanelDetent = detent
                }
            }
    }

    private var panelDetentAccessibilityValue: String {
        switch compactPanelDetent {
        case .compact: "Compact"
        case .medium: "Medium"
        case .expanded: "Expanded"
        }
    }

    private var panelAnimation: Animation? {
        reduceMotion ? nil : .interactiveSpring(response: 0.38, dampingFraction: 0.86)
    }

    // MARK: - wide windows: a sidebar, on iPad and on a phone in landscape

    private var sidebarLayout: some View {
        HStack(spacing: 0) {
            ridesList
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            // Narrower on a phone, where the map has little enough width as it
            // is; a fixed 320 would eat half of a landscape iPhone.
            .frame(width: horizontalSizeClass == .regular ? 320 : 260)
            .background(.regularMaterial)

            Divider()

            ZStack(alignment: .bottomTrailing) {
                map
                controlStack.padding(12)
                playbackBar.padding(12)
            }
        }
        .ignoresSafeArea(edges: .bottom)
    }

    // MARK: - shared parts

    /// Withheld until the map exists: `MKCompassButton` cannot be built
    /// without an `MKMapView`, and showing the stack without it would leave a
    /// gap that fills in a frame later.
    @ViewBuilder
    private var controlStack: some View {
        if controller.isMapReady, let mapView = controller.mapView {
            MapControlBar(mapView: mapView, controller: controller) {
                controller.fitToSelection()
            }
        }
    }

    /// The itineraries, grouped the way the web app's date bar groups them.
    private var ridesList: some View {
        NavigationStack {
            rideListState
                .navigationTitle(
                    library.source.isMine
                        ? localization.text("ios.myRides", fallback: "My rides")
                        : localization.text("chip.sample", fallback: "Sample")
                )
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: String.self) { id in
                    if let train = itineraries.loaded?.trains.first(where: { $0.id == id }) {
                        RideDetailView(
                            train: train,
                            onSave: { edited in
                                itineraries.replace(edited, replacing: train.id, country: country)
                                persistMine()
                            },
                            onRebuild: {
                                let count = itineraries.rebuildRouteSections(
                                    train.id, country: country)
                                persistMine()
                                return count
                            })
                    }
                }
                .toolbar {
                    if let loaded = itineraries.loaded, !loaded.days.isEmpty {
                        dateFilterMenu(loaded)
                    }
                    rideEditMenu
                    playbackToolbar
                    rideSourceMenu
                }
        }
        .confirmationDialog(
            "Delete \(deleteCandidate?.number ?? "this journey")?",
            isPresented: Binding(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
                Button(localization.text("btn.delete", fallback: "Delete journey"), role: .destructive) {
                guard let id = deleteCandidate?.id else { return }
                itineraries.delete(id, country: country)
                deleteCandidate = nil
                persistMine()
            }
        }
        .sheet(
            isPresented: Binding(
                get: { newJourneyDraft != nil },
                set: { if !$0 { newJourneyDraft = nil } }
            )
        ) {
            if let draft = newJourneyDraft {
                RideEditorView(
                    train: draft,
                    title: localization.text("ios.newJourney", fallback: "New journey")
                ) { added in
                    itineraries.add(added, country: country)
                    persistMine()
                    newJourneyDraft = nil
                }
            }
        }
    }

    @ViewBuilder
    private var rideListState: some View {
        switch itineraries.state {
        case .idle, .loading:
            ProgressView(localization.text("prog.loading", fallback: "Reading journeys…"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("Could not read the rides", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button(localization.text("map.retryFailed", fallback: "Try again")) {
                    itineraries.load(country: country, from: library)
                }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded(let loaded) where loaded.days.isEmpty:
            ContentUnavailableView {
                Label(localization.text("stats.empty", fallback: "No recorded rides"), systemImage: "tram")
            } description: {
                Text("This region has a railway package, but no recorded journeys yet.")
            } actions: {
                Button(localization.text("btn.addTrain", fallback: "Add journey"), systemImage: "plus") {
                    newJourneyDraft = StoreOperations.createBlankTrain(country: country)
                }
                .buttonStyle(.borderedProminent)
            }
        case .loaded(let loaded):
            List {
                ForEach(filteredDays(loaded)) { day in
                    Section(day.date) {
                        ForEach(day.trains, id: \.id) { train in
                            NavigationLink(value: train.id) { rideRow(train) }
                                .simultaneousGesture(TapGesture().onEnded {
                                    itineraries.selectedTrainID = train.id
                                })
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                .listRowInsets(
                                    EdgeInsets(top: 5, leading: 12, bottom: 5, trailing: 12)
                                )
                                .contextMenu { rideContextMenu(train) }
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) { deleteCandidate = train } label: {
                                            Label(localization.text("btn.delete", fallback: "Delete"), systemImage: "trash")
                                    }
                                    Button {
                                        itineraries.toggleVisibility(train.id, country: country)
                                        persistMine()
                                    } label: {
                                        Label(
                                            train.visible == false ? "Show" : "Hide",
                                            systemImage: train.visible == false ? "eye" : "eye.slash"
                                        )
                                    }
                                    .tint(.indigo)
                                }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .contentMargins(.bottom, 110, for: .scrollContent)
            .searchable(
                text: $query,
                placement: .toolbar,
                    prompt: Text(localization.text("ph.search", fallback: "Train, station, or identifier"))
            )
            .overlay {
                if filteredDays(loaded).isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
        }
    }

    private func filteredDays(_ loaded: ItineraryStore.Loaded) -> [ItineraryStore.Loaded.Day] {
        let source = selectedDate == Dates.allDates
            ? loaded.days
            : loaded.days.filter { $0.date == selectedDate }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return source }
        return source.compactMap { day in
            let trains = day.trains.filter { train in
                [
                    train.id,
                    train.number,
                    train.origin,
                    train.destination,
                    train.trainType ?? "",
                    train.company ?? "",
                ].contains { $0.localizedCaseInsensitiveContains(needle) }
                    || train.stops.contains { $0.name.localizedCaseInsensitiveContains(needle) }
            }
            return trains.isEmpty ? nil : .init(date: day.date, trains: trains)
        }
    }

    @ToolbarContentBuilder
    private func dateFilterMenu(_ loaded: ItineraryStore.Loaded) -> some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Button {
                    selectedDate = Dates.allDates
                } label: {
                    Label(localization.text("date.all", fallback: "All dates"), systemImage: selectedDate == Dates.allDates ? "checkmark" : "calendar")
                }
                ForEach(availableDates(loaded), id: \.self) { date in
                    Button {
                        selectedDate = date
                    } label: {
                        Label(date, systemImage: selectedDate == date ? "checkmark" : "calendar")
                    }
                }
                Divider()
                Button {
                    newManualDate = ""
                    showsAddDate = true
                } label: {
                    Label(localization.text("btn.addDate", fallback: "Add date"), systemImage: "calendar.badge.plus")
                }
                Button(role: .destructive) {
                    let used = Set(loaded.days.map(\.date))
                    manualDates.removeAll { !used.contains($0) }
                    persistManualDates()
                    if selectedDate != Dates.allDates,
                       !availableDates(loaded).contains(selectedDate) {
                        selectedDate = Dates.allDates
                    }
                } label: {
                    Label(localization.text("btn.removeEmptyDates", fallback: "Remove empty dates"), systemImage: "calendar.badge.minus")
                }
                .disabled(manualDates.isEmpty)
                Toggle(
                    localization.text("toggle.currentDate", fallback: "Map shows selected date only"),
                    isOn: $mapFollowsSelectedDate)
            } label: {
                Label(
                    selectedDate == Dates.allDates
                        ? localization.text("date.all", fallback: "All dates") : selectedDate,
                    systemImage: "calendar"
                )
            }
        }
    }

    private func availableDates(_ loaded: ItineraryStore.Loaded) -> [String] {
        Dates.availableDates(loaded.trains.map(\.forDates), manualDates: manualDates)
    }

    private func addManualDate() {
        guard let normalized = Dates.normalizeDateString(newManualDate) else { return }
        if !manualDates.contains(normalized) { manualDates.append(normalized) }
        persistManualDates()
        selectedDate = normalized
    }

    private func manualDatesKey() -> String { "manual-dates-\(country)" }

    private func loadManualDates() -> [String] {
        (UserDefaults.standard.array(forKey: manualDatesKey()) as? [String]) ?? []
    }

    private func persistManualDates() {
        UserDefaults.standard.set(manualDates, forKey: manualDatesKey())
    }

    /// The web app's 載入示例資料 / 保存為我的資料 / 恢復我的資料, as one menu.
    ///
    /// One menu rather than eleven buttons because on a phone they are eleven
    /// buttons the reader has to read every time; grouped, the destructive one
    /// is also somewhere it cannot be hit by accident.
    @ToolbarContentBuilder
    private var rideSourceMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if itineraries.selectedTrainID != nil {
                    Button {
                        itineraries.selectedTrainID = nil
                    } label: {
                        Label(localization.text("btn.clearSelection", fallback: "Clear selection"), systemImage: "xmark.circle")
                    }
                    Divider()
                }
                Section("Samples") {
                    ForEach(RideLibrary.Sample.forCountry(country)) { sample in
                        Button {
                            library.use(.sample(sample.resource))
                            itineraries.load(country: country, from: library)
                        } label: {
                            Label(
                                sample.title,
                                systemImage: library.source == .sample(sample.resource)
                                    ? "checkmark" : "doc.text"
                            )
                        }
                    }
                }

                Section("Mine") {
                    Button {
                        if let store = itineraries.store {
                            library.save(store, country: country)
                        }
                    } label: {
                        Label(localization.text("btn.saveAsMine", fallback: "Save as my rides"), systemImage: "square.and.arrow.down")
                    }
                    .disabled(itineraries.store == nil)

                    Button {
                        library.use(.mine)
                        itineraries.load(country: country, from: library)
                    } label: {
                        Label(localization.text("btn.restoreMine", fallback: "Restore my rides"), systemImage: "arrow.uturn.backward")
                    }
                    .disabled(!library.hasSavedStore)

                    Button(role: .destructive) {
                        library.deleteSavedStore(country: country)
                        itineraries.load(country: country, from: library)
                    } label: {
                        Label(localization.text("btn.clearStorage", fallback: "Delete my rides"), systemImage: "trash")
                    }
                    .disabled(!library.hasSavedStore)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    @ToolbarContentBuilder
    private var rideEditMenu: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                newJourneyDraft = StoreOperations.createBlankTrain(country: country)
            } label: {
                Label(localization.text("btn.addTrain", fallback: "Add journey"), systemImage: "plus")
            }
        }
    }

    @ToolbarContentBuilder
    private var playbackToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                if playback.isActive {
                    stopPlayback()
                } else {
                    _ = playback.start(
                        trains: playbackScope,
                        rides: riddenRoutes.rides,
                        reducedMotion: reduceMotion)
                }
            } label: {
                Label(
                    playback.isActive
                        ? localization.text("play.stop", fallback: "Stop playback")
                        : localization.text("play.start", fallback: "Play rides"),
                    systemImage: playback.isActive ? "stop.fill" : "play.fill")
            }
            .disabled(!playback.isActive && playbackScope.isEmpty)
        }
    }

    @ViewBuilder
    private func rideContextMenu(_ train: Train) -> some View {
        Button {
            _ = playback.start(
                trains: [train], rides: riddenRoutes.rides,
                reducedMotion: reduceMotion)
        } label: {
            Label(localization.text("play.start", fallback: "Play journey"), systemImage: "play.fill")
        }
        Button {
            itineraries.duplicate(train.id, country: country)
            persistMine()
        } label: {
            Label(localization.text("btn.duplicate", fallback: "Duplicate"), systemImage: "plus.square.on.square")
        }
        Button {
            itineraries.toggleVisibility(train.id, country: country)
            persistMine()
        } label: {
            Label(
                train.visible == false ? "Show on map" : "Hide from map",
                systemImage: train.visible == false ? "eye" : "eye.slash"
            )
        }
        Button {
            itineraries.move(train.id, by: -1, country: country)
            persistMine()
        } label: {
            Label(localization.text("btn.moveUp", fallback: "Move earlier"), systemImage: "arrow.up")
        }
        Button {
            itineraries.move(train.id, by: 1, country: country)
            persistMine()
        } label: {
            Label(localization.text("btn.moveDown", fallback: "Move later"), systemImage: "arrow.down")
        }
        Divider()
        Button(role: .destructive) { deleteCandidate = train } label: {
            Label(localization.text("btn.delete", fallback: "Delete"), systemImage: "trash")
        }
    }

    private func persistMine() {
        // Any edit forks a bundled sample into the reader's own store. A
        // sample remains immutable on disk and the user's change is durable.
        guard let store = itineraries.store else { return }
        library.save(store, country: country)
    }

    private func rideRow(_ train: Train) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    Text(train.number).font(.body.weight(.semibold))
                    Spacer()
                    departureTime(train)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(train.number).font(.body.weight(.semibold))
                    departureTime(train)
                }
            }
            HStack(spacing: 4) {
                Text(train.origin)
                Image(systemName: "arrow.right").imageScale(.small)
                Text(train.destination)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                if let type = train.trainType, !type.isEmpty { Text(type) }
                Text("\(train.stops.count) \(localization.text("unit.stops", fallback: "stops"))")
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(
            itineraries.selectedTrainID == train.id
                ? Color.accentColor.opacity(0.12)
                : Color(.secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func departureTime(_ train: Train) -> some View {
        if let time = train.stops.first?.departure ?? train.stops.first?.arrival,
            !time.isEmpty
        {
            Text(time)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private var statusRows: some View {
        switch store.state {
        case .idle:
            Text("Idle")
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Decoding package…")
            }
        case .loaded(let code, let lines, let elapsed):
            LabeledContent("Package", value: "\(code.uppercased()) · \(lines.count) lines")
            LabeledContent(
                "Decoded",
                value: "\(lines.reduce(0) { $0 + $1.intervals.count }) intervals · "
                    + "\(lines.reduce(0) { $0 + $1.vertexCount }) vertices · \(elapsed.milliseconds) ms"
            )
            // What the renderer actually submitted, at this zoom. These are
            // measurements, not estimates.
            if let render {
                LabeledContent(
                    "Zoom",
                    value: render.threshold < render.zoom - 0.01
                        ? String(format: "%.1f (drawing to %.1f)", render.zoom, render.threshold)
                        : String(format: "%.1f", render.zoom)
                )
                LabeledContent(
                    "Drawn",
                    value: "\(render.visibleLines) lines · \(render.overlays) overlays · "
                        + "\(render.vertices) vertices"
                )
                LabeledContent("Off screen", value: "\(render.culledOffScreen) lines culled")
                LabeledContent("Rebuild", value: "\(render.buildMilliseconds) ms")
            }
        case .failed(let message):
            Text(message).foregroundStyle(.red)
        }
        if let loaded = itineraries.loaded, !loaded.trains.isEmpty {
            LabeledContent(
                "Rides",
                value: "\(loaded.trains.count) over \(loaded.days.count) days · "
                    + "read in \(loaded.elapsed.milliseconds) ms"
            )
        }
    }

    private var map: some View {
        RailMapView(
            lines: lines,
            stations: store.stations,
            rides: mapRides,
            selectedTrainID: itineraries.selectedTrainID,
            showsNetwork: controller.showsNetwork,
            basemapOpacity: controller.basemapOpacity,
            controller: controller,
            playback: playback,
            onSelectRide: { itineraries.selectedTrainID = $0 }
        ) { render = $0 }
        .ignoresSafeArea()
    }

    private var mapRides: [RiddenRouteStore.DrawnRide] {
        let visible = riddenRoutes.rides.filter(\.visible)
        guard mapFollowsSelectedDate, selectedDate != Dates.allDates,
              let trains = itineraries.loaded?.trains else { return visible }
        let inScope = Set(trains.filter {
            Dates.trainSpans($0.forDates, date: selectedDate)
        }.map(\.id))
        return visible.filter { inScope.contains($0.id) }
    }

    private var playbackScope: [Train] {
        guard let loaded = itineraries.loaded else { return [] }
        if let selected = itineraries.selectedTrainID,
           let train = loaded.trains.first(where: { $0.id == selected }) {
            return [train]
        }
        return filteredDays(loaded).flatMap(\.trains)
    }

    private var rideIDs: Set<String> { Set(riddenRoutes.rides.map(\.id)) }

    @ViewBuilder
    private var playbackBar: some View {
        if playback.isActive || playback.phase == .ended {
            VStack(spacing: 9) {
                HStack(spacing: 10) {
                    Button { playback.previous() } label: {
                        Image(systemName: "backward.end.fill")
                    }
                    .disabled(!playback.canGoPrevious)

                    Button { playback.togglePause() } label: {
                        Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title3)
                            .frame(width: 28, height: 28)
                    }
                    .disabled(playback.phase == .ended)

                    Button { playback.next() } label: {
                        Image(systemName: "forward.end.fill")
                    }
                    .disabled(!playback.canGoNext)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(playback.title)
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                        if !playback.stationName.isEmpty {
                            Text(playback.stationName)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 4)
                    Button { stopPlayback() } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .accessibilityLabel(localization.text("play.stop", fallback: "Stop playback"))
                }

                ProgressView(value: playback.progress)
                    .tint(.accentColor)

                HStack(spacing: 10) {
                    Label("\(playback.queueIndex + 1)/\(max(playback.queueCount, 1))", systemImage: "tram")
                        .font(.caption2.monospacedDigit())
                    Toggle(isOn: $playback.autoFocus) {
                        Label(localization.text("play.focus", fallback: "Auto focus"), systemImage: "scope")
                    }
                    .font(.caption2)
                    .toggleStyle(.button)
                    Spacer()
                    Slider(
                        value: Binding(
                            get: { playback.speed },
                            set: { playback.setSpeed($0) }),
                        in: Playback.Tuning.speedMin...Playback.Tuning.speedMax,
                        step: Playback.Tuning.speedStep)
                        .frame(maxWidth: 120)
                        .accessibilityLabel(localization.text("play.speed", fallback: "Playback speed"))
                    Text("\(playback.speed.formatted(.number.precision(.fractionLength(2))))×")
                        .font(.caption2.monospacedDigit())
                        .frame(width: 34, alignment: .trailing)
                    videoControl
                }
            }
            .buttonStyle(.plain)
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
            .frame(maxWidth: 540)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
        }
    }

    @ViewBuilder
    private var videoControl: some View {
        switch videoExporter.state {
        case .recording:
            Button { videoExporter.cancel() } label: {
                Image(systemName: "record.circle.fill").foregroundStyle(.red)
            }
            .accessibilityLabel(localization.text("video.cancel", fallback: "Cancel video export"))
        case .finishing:
            ProgressView().controlSize(.small)
                .accessibilityLabel(localization.text("video.finishing", fallback: "Finishing video"))
        case .finished(let url):
            ShareLink(item: url) {
                Image(systemName: "square.and.arrow.up.fill")
            }
            .accessibilityLabel(localization.text("video.share", fallback: "Share video"))
        case .idle, .failed:
            Button { startVideoExport() } label: {
                Image(systemName: "video.badge.plus")
            }
            .accessibilityLabel(localization.text("video.export", fallback: "Export playback video"))
        }
    }

    private func startVideoExport() {
        guard let mapView = controller.mapView else { return }
        videoExporter.start(
            playback: playback, mapView: mapView,
            trains: playbackScope, rides: riddenRoutes.rides,
            reducedMotion: reduceMotion)
    }

    private func stopPlayback() {
        if videoExporter.isRecording { videoExporter.cancel(clearPlayback: false) }
        playback.stop()
    }

    private var lines: [RailNetworkStore.DrawnLine] {
        if case .loaded(_, let lines, _) = store.state { return lines }
        return []
    }
}

extension Coordinate {
    var clLocation: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}

extension Duration {
    var milliseconds: Int {
        Int(components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000)
    }
}

#Preview {
    RidesWorkspaceView(
        store: RailNetworkStore(),
        itineraries: ItineraryStore(),
        library: RideLibrary(),
        riddenRoutes: RiddenRouteStore(),
        controller: RailMapController(),
        country: .constant("jp")
    )
    .environment(AppLocalization())
}
