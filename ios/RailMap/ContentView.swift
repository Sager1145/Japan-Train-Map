import CoreLocation
import MapKit
import RailCore
import RailPresentation
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
///
/// ## The panel is one surface with two resident layers (§4.4)
///
/// Opening a journey does not push a screen and does not present a second
/// card: it changes which of two permanently-mounted layers is on top. The
/// list underneath keeps its search text, its date filter, its scroll offset
/// and its expanded sections because it was never torn down — which is exactly
/// what §4.4 requires of returning from a journey ("返回列表时应回到原旅程附
/// 近，而不是回到列表顶部"). See ``View/residentLayer(isTop:)``.
///
/// ## Nothing here decides which action is primary (§3.3, §11.2)
///
/// Every surface below renders a `JourneyPresentation` resolved by
/// `JourneyPresentationResolver`. This view does not ask "is it hidden", "is
/// it playing", "did the route fail" — those states can all be true at once,
/// and the one place that turns them into a single primary task is a module
/// with tests over 288 state combinations. What is left here is the wiring:
/// which store call each resolved action makes.
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
    @State private var sheet: RidesSheet?
    @State private var importFlow = ImportFlow()
    @State private var playback = PlaybackController()
    @State private var videoExporter = PlaybackVideoExporter()
    @State private var didRunDebugPlayback = false
    @State private var manualDates: [String] = []
    @State private var showsAddDate = false
    @State private var newManualDate = ""
    @AppStorage("map-follows-selected-date") private var mapFollowsSelectedDate = false
    /// One stage per route *kind*, not per journey: a reader who left the card
    /// half open expects the next journey half open too (see ``RideRoute.Kind``).
    @State private var panelStages: [RideRoute.Kind: SheetStage] = [:]

    /// The detent the panel opens at.
    ///
    /// `.medium` in the app. The environment override exists because the panel
    /// is resized by dragging and there is no way to drive a drag from a test
    /// harness — the same reason `RAILMAP_UI_TEST_PLAYBACK` exists a few lines
    /// down. It is read once, and only in a debug build.
    private static var launchStage: SheetStage {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_STAGE"] {
        case "compact": return .compact
        case "expanded": return .expanded
        default: return .medium
        }
        #else
        return .medium
        #endif
    }
    /// What the cards report they need at `.compact`. See `compactChromeProbe`.
    @State private var compactChrome: [RideRoute.Kind: CGFloat] = [:]
    @GestureState private var panelDrag: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Everything this workspace can present over itself.
    ///
    /// One enum rather than four `isPresented` bindings on one view: SwiftUI
    /// presents a single sheet per anchor, and four bindings racing for it is
    /// how a "Delete" dialog swallows the editor that was opening behind it.
    private enum RidesSheet: Identifiable {
        case newJourney(Train)
        case edit(Train)
        case detail(Train)
        case importData

        var id: String {
            switch self {
            case .newJourney(let train): "new:\(train.id)"
            case .edit(let train): "edit:\(train.id)"
            case .detail(let train): "detail:\(train.id)"
            case .importData: "import"
            }
        }
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
        .onPreferenceChange(SheetCompactHeightKey.self) { compactChrome = $0 }
        .onChange(of: playback.currentTrainID) { _, id in
            if let id { itineraries.selectedTrainID = id }
        }
        .task(id: country) { manualDates = loadManualDates() }
        .alert(
            localization.journeyText("ios.journey.addDateTitle", fallback: "Add a date"),
            isPresented: $showsAddDate
        ) {
            TextField("YYYY-MM-DD", text: $newManualDate)
            Button(localization.text("ios.cancel", fallback: "Cancel"), role: .cancel) {}
            Button(localization.journeyText("btn.add", fallback: "Add")) { addManualDate() }
                .disabled(Dates.normalizeDateString(newManualDate) == nil)
        } message: {
            Text(
                localization.journeyText(
                    "ios.journey.addDateDetail",
                    fallback: "Create an empty date to add journeys to later."))
        }
        .confirmationDialog(
            localization.journeyText(
                "ios.journey.deleteConfirm",
                ["train": .string(deleteCandidate?.number ?? "")],
                fallback: "Delete {train}?"),
            isPresented: Binding(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(
                localization.countryText("btn.delete", fallback: "Delete"), role: .destructive
            ) {
                guard let id = deleteCandidate?.id else { return }
                if itineraries.selectedTrainID == id { itineraries.selectedTrainID = nil }
                itineraries.delete(id, country: country)
                deleteCandidate = nil
                persistMine()
            }
        } message: {
            // §13.3: say what the action affects before it is taken.
            Text(
                localization.journeyText(
                    "ios.journey.deleteDetail",
                    fallback: "The journey is removed from the data on this device."))
        }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .newJourney(let draft):
                RideEditorView(
                    train: draft,
                    title: localization.text("ios.newJourney", fallback: "New journey")
                ) { added in
                    // §8.2: saving selects the new journey, so the route state
                    // that follows is reported in its own Hero.
                    if let id = itineraries.add(added, country: country) {
                        itineraries.selectedTrainID = id
                    }
                    persistMine()
                    sheet = nil
                }
            case .edit(let train):
                RideEditorView(
                    train: train,
                    title: localization.text("ios.editJourney", fallback: "Edit journey")
                ) { edited in
                    itineraries.replace(edited, replacing: train.id, country: country)
                    persistMine()
                    sheet = nil
                }
            case .detail(let train):
                // §3.1: L4 metadata lives on a second surface, not in the Hero.
                NavigationStack {
                    RideDetailView(
                        train: train,
                        onSave: { edited in
                            itineraries.replace(edited, replacing: train.id, country: country)
                            persistMine()
                        },
                        onRebuild: { rebuildRoute(train) })
                    .toolbar {
                        // §14.4: a modal must be closable without a swipe, or
                        // Switch Control and keyboard readers cannot leave it.
                        ToolbarItem(placement: .cancellationAction) {
                            Button(localization.text("ios.cancel", fallback: "Cancel")) {
                                sheet = nil
                            }
                        }
                    }
                }
            case .importData:
                DataImportView(
                    flow: importFlow, itineraries: itineraries,
                    library: library, country: country)
            }
        }
        .onDisappear {
            videoExporter.cancel(clearPlayback: false)
            playback.stop()
        }
#if DEBUG
        // A headless way to put the workspace into its selected state.
        //
        // The Hero is reached by tapping a row, and a tap is the one thing a
        // screenshot harness driving `simctl` cannot perform — so every state
        // in §5.2, including the ones that only appear when a route fails,
        // would otherwise be unreviewable outside a human session. Same shape,
        // and the same DEBUG-only reach, as `RAILMAP_UI_TEST_PLAYBACK` above.
        .task(id: "\(itineraries.loaded?.trains.count ?? 0)") {
            guard let wanted = ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_SELECT"],
                  itineraries.selectedTrainID == nil,
                  let trains = itineraries.loaded?.trains, !trains.isEmpty else { return }
            if let index = Int(wanted) {
                itineraries.selectedTrainID = trains[min(max(index, 0), trains.count - 1)].id
            } else {
                itineraries.selectedTrainID = wanted
            }
        }
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
        let route = panelRoute
        let panelMetrics = metrics(in: geometry)
        let panelHeight = height(of: route, in: panelMetrics)

        // What the map controls have to clear, which is NOT the panel's height:
        // a control lifted by the full expanded height is a control pushed off
        // the top of the window, and because a ZStack takes the size of its
        // largest child, that padded control was what the ZStack sized itself
        // to. The panel — bottom-aligned inside a box taller than the window —
        // then had its top pushed down out of the layout it had asked for.
        // Capped at the medium detent, which is the tallest the panel gets
        // while these are still on screen at all.
        let controlLift = min(panelHeight, panelMetrics.height(of: .medium, for: route)) + 12

        return ZStack(alignment: .bottomTrailing) {
            map
            playbackBar
                .padding(.horizontal, 12)
                .padding(.bottom, controlLift)
            controlStack
                .padding(.trailing, 12)
                .padding(.bottom, controlLift)
                // §4.3: a control the panel is about to cover is removed, not
                // left looking pressable under an opaque surface.
                .opacity(stage(of: route) == .expanded ? 0 : 1)

            VStack(spacing: 0) {
                SheetHandle(
                    label: localization.journeyText(
                        "ios.journey.resizePanel", fallback: "Resize the journey panel"),
                    value: stageName(stage(of: route))
                ) {
                    withAnimation(panelAnimation) {
                        panelStages[route.kind] =
                            stage(of: route) == .expanded ? .medium : .expanded
                    }
                }
                .gesture(panelResizeGesture(metrics: panelMetrics, route: route))

                panelLayers(stage: stage(of: route))
            }
            .frame(maxWidth: .infinity)
            .frame(height: panelHeight)
            .railSheetSurface()
            .padding(.horizontal, RideSheetMetrics.horizontalMargin)
        }
        .ignoresSafeArea()
        .animation(panelAnimation, value: stage(of: route))
        .animation(panelAnimation, value: route)
    }

    /// The two permanently-mounted layers. Only the top one is visible,
    /// hit-testable and spoken; neither is ever rebuilt.
    private func panelLayers(stage: SheetStage) -> some View {
        ZStack(alignment: .top) {
            ridesList
                .residentLayer(isTop: panelRoute.isHome)
            rideHero(stage: stage)
                .residentLayer(isTop: !panelRoute.isHome)
        }
    }

    private func metrics(in geometry: GeometryProxy) -> RideSheetMetrics {
        RideSheetMetrics(
            containerHeight: geometry.size.height,
            safeAreaTop: geometry.safeAreaInsets.top,
            safeAreaBottom: geometry.safeAreaInsets.bottom,
            compactChrome: compactChrome[panelRoute.kind] ?? 0,
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize)
    }

    private func height(of route: RideRoute, in metrics: RideSheetMetrics) -> CGFloat {
        let resting = metrics.height(of: stage(of: route), for: route)
        guard panelDrag != 0 else { return resting }
        // 1:1 while the finger is down, resisted past the ends (§9.3).
        return metrics.dragging(from: resting, translation: panelDrag, for: route)
    }

    private func stage(of route: RideRoute) -> SheetStage {
        panelStages[route.kind] ?? Self.launchStage
    }

    private func panelResizeGesture(
        metrics: RideSheetMetrics, route: RideRoute
    ) -> some Gesture {
        // §9.3: about 8–10 pt of direction before a touch counts as a drag, so
        // a tap on the handle stays a tap.
        DragGesture(minimumDistance: 8)
            .updating($panelDrag) { value, state, _ in
                state = value.translation.height
            }
            .onEnded { value in
                let resting = metrics.height(of: stage(of: route), for: route)
                // §9.3: the stop is chosen from where the flick was GOING, not
                // from where the finger happened to leave the glass.
                let projected = resting - value.predictedEndTranslation.height
                withAnimation(panelAnimation) {
                    panelStages[route.kind] = metrics.stage(nearest: projected, for: route)
                }
            }
    }

    private func stageName(_ stage: SheetStage) -> String {
        switch stage {
        case .compact: localization.journeyText("ios.journey.panelCompact", fallback: "Compact")
        case .medium: localization.journeyText("ios.journey.panelMedium", fallback: "Medium")
        case .expanded: localization.journeyText("ios.journey.panelExpanded", fallback: "Expanded")
        }
    }

    private var panelAnimation: Animation? {
        // §9.2 gesture spring, and §9.4: Reduce Motion replaces the movement
        // rather than slowing it down.
        reduceMotion ? nil : .interactiveSpring(response: 0.34, dampingFraction: 0.86)
    }

    /// Which layer is on top. §4.4: closing a journey is returning to the list,
    /// and it does not clear the date filter.
    private var panelRoute: RideRoute {
        guard let id = itineraries.selectedTrainID, selectedTrain != nil else { return .home }
        return .ride(id)
    }

    private var selectedTrain: Train? {
        guard let id = itineraries.selectedTrainID else { return nil }
        return itineraries.loaded?.trains.first { $0.id == id }
    }

    // MARK: - wide windows: a sidebar, on iPad and on a phone in landscape

    private var sidebarLayout: some View {
        HStack(spacing: 0) {
            // The same two resident layers as the panel: §4.4 asks for one
            // header that morphs, not two navigation models that disagree.
            panelLayers(stage: .expanded)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                // Narrower on a phone, where the map has little enough width as
                // it is; a fixed 320 would eat half of a landscape iPhone.
                .frame(width: horizontalSizeClass == .regular ? 360 : 280)
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

    // MARK: - §5.2 the selected journey

    @ViewBuilder
    private func rideHero(stage: SheetStage) -> some View {
        if let train = selectedTrain {
            let presentation = presentation(for: train)
            RideCard(
                train: train,
                presentation: presentation,
                stage: stage,
                dateChipTitle: train.date,
                onClose: { itineraries.selectedTrainID = nil },
                onOpenDate: { date in
                    selectedDate = date
                    itineraries.selectedTrainID = nil
                },
                onPrimary: { perform($0, on: train) },
                onSecondary: { perform($0, on: train) }
            )
            .padding(.top, 4)
        }
    }

    /// §11.2's answer for one journey. The only caller of the resolver in the
    /// journey surfaces, so the priority order lives in one tested place.
    private func presentation(for train: Train) -> JourneyPresentation {
        JourneyPresentationResolver.selected(
            train: train,
            route: JourneyBridge.routeState(for: train.id, localization: localization),
            phase: playbackPhase(for: train))
    }

    /// The only sub-phase this workspace can be in for a *single* journey.
    ///
    /// Editing and saving belong to `RideEditorView`, which owns its own draft
    /// and its own atomic commit (§8.3); a failure to load is a workspace
    /// phase, not this journey's. So playback is what is left — and the
    /// resolver still refuses to report it while the route is not resolved.
    private func playbackPhase(for train: Train) -> JourneyWorkspacePhase? {
        guard playback.isActive, playback.currentTrainID == train.id else { return nil }
        return .playing(progress: playback.progress, isPaused: !playback.isPlaying)
    }

    // MARK: - §5.1 the journey list

    /// The itineraries, grouped the way the web app's date bar groups them.
    private var ridesList: some View {
        NavigationStack {
            rideListState
                .navigationTitle(
                    library.source.isMine
                        ? localization.text("ios.myRides", fallback: "My rides")
                        : localization.countryText("chip.sample", fallback: "Sample")
                )
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if let loaded = itineraries.loaded, !loaded.days.isEmpty {
                        dateFilterMenu(loaded)
                    }
                    rideEditMenu
                    playbackToolbar
                    rideSourceMenu
                }
        }
    }

    @ViewBuilder
    private var rideListState: some View {
        switch itineraries.state {
        case .idle, .loading:
            workspaceStatus(JourneyPresentationResolver.workspace(phase: .loading))
        case .failed(let message):
            workspaceUnavailable(
                JourneyPresentationResolver.workspace(phase: .failed(.load(message))),
                systemImage: "exclamationmark.triangle")
        case .loaded(let loaded) where loaded.days.isEmpty:
            workspaceUnavailable(
                JourneyPresentationResolver.workspace(phase: .empty),
                systemImage: "tram",
                description: localization.journeyText(
                    "ios.journey.noRegionRecords",
                    fallback: "This region has a railway package, but no recorded journeys yet."))
        case .loaded(let loaded):
            let days = filteredDays(loaded)
            List {
                if !days.isEmpty {
                    Section { listSummary(days) }
                }
                ForEach(days) { day in
                    Section(day.date) {
                        ForEach(day.trains, id: \.id) { train in
                            journeyRow(train)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .listSectionSpacing(.custom(2))
            .scrollContentBackground(.hidden)
            .contentMargins(.bottom, 110, for: .scrollContent)
            .searchable(
                text: $query,
                placement: .toolbar,
                prompt: Text(
                    localization.countryText(
                        "ph.search", fallback: "Train, station, or identifier"))
            )
            .overlay {
                if days.isEmpty {
                    // §13.1: three empty states, three different single primary
                    // actions — and the search text is kept, not cleared.
                    workspaceUnavailable(
                        JourneyPresentationResolver.workspace(
                            phase: .empty,
                            hasSearchQuery: !query.trimmingCharacters(
                                in: .whitespacesAndNewlines).isEmpty,
                            hasDateFilter: selectedDate != Dates.allDates),
                        systemImage: "magnifyingglass")
                }
            }
        }
    }

    /// §5.1's "201 journeys · 32 days". Only facts that are known — no distance
    /// placeholder standing in for a number that has not been computed.
    private func listSummary(_ days: [ItineraryStore.Loaded.Day]) -> some View {
        let journeys = days.reduce(0) { $0 + $1.trains.count }
        let text = selectedDate == Dates.allDates
            ? localization.journeyText(
                "ios.journey.listSummary",
                ["journeys": .number(Double(journeys)), "days": .number(Double(days.count))],
                fallback: "{journeys} journeys · {days} days")
            : localization.journeyText(
                "ios.journey.daySummary",
                ["journeys": .number(Double(journeys))],
                fallback: "{journeys} journeys")
        return Text(text)
            .font(.footnote.weight(.medium))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 14, bottom: 6, trailing: 12))
            .accessibilityAddTraits(.isHeader)
    }

    private func journeyRow(_ train: Train) -> some View {
        // A Button rather than a `NavigationLink`: selecting a journey changes
        // which resident layer is on top, and §8.1 wants that reflected in the
        // list AND on the map at once rather than pushing a screen over both.
        Button {
            itineraries.selectedTrainID = train.id
        } label: {
            JourneySummaryRow(
                train: train,
                presentation: presentation(for: train),
                isSelected: itineraries.selectedTrainID == train.id,
                showsDate: selectedDate == Dates.allDates)
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 5, leading: 12, bottom: 5, trailing: 12))
        // §5.1: the row does not expose every verb. Swipe and context menu do.
        .contextMenu { rideContextMenu(train) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { deleteCandidate = train } label: {
                Label(
                    localization.countryText("btn.delete", fallback: "Delete"),
                    systemImage: "trash")
            }
            Button {
                itineraries.toggleVisibility(train.id, country: country)
                persistMine()
            } label: {
                Label(
                    train.visible == false
                        ? localization.text("ios.showOnMap", fallback: "Show on map")
                        : localization.journeyText(
                            "ios.journey.hideFromMap", fallback: "Hide from map"),
                    systemImage: train.visible == false ? "eye" : "eye.slash"
                )
            }
            .tint(.indigo)
        }
    }

    // MARK: - workspace-level states (§13.1, §13.2, §13.3)

    private func workspaceStatus(_ presentation: JourneyPresentation) -> some View {
        VStack(spacing: 10) {
            ProgressView()
            Text(localization.journeyText(presentation.title))
                .font(.headline)
            if let status = presentation.status {
                Text(localization.journeyText(status.title))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func workspaceUnavailable(
        _ presentation: JourneyPresentation,
        systemImage: String,
        description: String? = nil
    ) -> some View {
        ContentUnavailableView {
            Label(localization.journeyText(presentation.title), systemImage: systemImage)
        } description: {
            VStack(spacing: 8) {
                if let subtitle = presentation.subtitle {
                    Text(localization.journeyText(subtitle))
                }
                if let description { Text(description) }
                if let status = presentation.status {
                    // §13.3: what was kept, next to what went wrong.
                    Text(localization.journeyText(status.title))
                        .foregroundStyle(status.tone.color)
                }
            }
        } actions: {
            QuietActionGroup(
                presentation: presentation,
                perform: { perform($0, on: nil) },
                performSecondary: { perform($0, on: nil) }
            )
            .frame(maxWidth: 320)
        }
    }

    // MARK: - what a resolved action actually does (§8)

    private func perform(_ action: JourneyPresentation.PrimaryAction, on train: Train?) {
        switch action {
        case .add:
            sheet = .newJourney(StoreOperations.createBlankTrain(country: country))
        case .importData:
            sheet = .importData
        case .locate:
            if let train { itineraries.selectedTrainID = train.id }
            controller.fitToSelection()
        case .showOnMap:
            guard let train else { return }
            itineraries.toggleVisibility(train.id, country: country)
            persistMine()
        case .rebuildRoute:
            guard let train else { return }
            _ = rebuildRoute(train)
        case .save:
            // §8.3: the draft and its atomic commit belong to the editor.
            if let train { sheet = .edit(train) }
        case .pause, .resume:
            playback.togglePause()
        case .retry:
            itineraries.load(country: country, from: library)
        case .clearSearch:
            query = ""
        }
    }

    private func perform(_ action: SecondaryAction, on train: Train?) {
        switch action {
        case .play:
            guard let train else { return }
            _ = playback.start(
                trains: [train], rides: riddenRoutes.rides, reducedMotion: reduceMotion)
        case .stop:
            stopPlayback()
        case .edit:
            if let train { sheet = .edit(train) }
        case .duplicate:
            guard let train else { return }
            itineraries.duplicate(train.id, country: country)
            persistMine()
        case .hide, .show:
            guard let train else { return }
            itineraries.toggleVisibility(train.id, country: country)
            persistMine()
        case .delete:
            deleteCandidate = train
        case .inspectDetails:
            if let train { sheet = .detail(train) }
        case .rebuildRoute:
            guard let train else { return }
            _ = rebuildRoute(train)
        case .cancel:
            itineraries.selectedTrainID = nil
        case .importData:
            sheet = .importData
        case .add:
            sheet = .newJourney(StoreOperations.createBlankTrain(country: country))
        }
    }

    /// §8.4: rebuilding regenerates route sections from the stops. It never
    /// deletes the journey, and a section that still cannot be solved stays
    /// undrawn rather than being straightened.
    @discardableResult
    private func rebuildRoute(_ train: Train) -> Int? {
        let count = itineraries.rebuildRouteSections(train.id, country: country)
        persistMine()
        return count
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
                    Label(localization.countryText("date.all", fallback: "All dates"), systemImage: selectedDate == Dates.allDates ? "checkmark" : "calendar")
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
                    Label(localization.countryText("btn.addDate", fallback: "Add date"), systemImage: "calendar.badge.plus")
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
                    Label(localization.journeyText("btn.removeEmptyDates", fallback: "Remove empty dates"), systemImage: "calendar.badge.minus")
                }
                .disabled(manualDates.isEmpty)
                Toggle(
                    localization.journeyText("toggle.currentDate", fallback: "Map shows the selected date only"),
                    isOn: $mapFollowsSelectedDate)
            } label: {
                Label(
                    selectedDate == Dates.allDates
                        ? localization.countryText("date.all", fallback: "All dates") : selectedDate,
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
                        Label(
                            localization.journeyText(
                                "ios.journey.clearSelection", fallback: "Clear selection"),
                            systemImage: "xmark.circle")
                    }
                    Divider()
                }
                Section(localization.countryText("chip.sample", fallback: "Sample data")) {
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

                Section(localization.text("ios.myRides", fallback: "My rides")) {
                    Button {
                        if let store = itineraries.store {
                            library.save(store, country: country)
                        }
                    } label: {
                        Label(localization.countryText("btn.saveAsMine", fallback: "Save as my rides"), systemImage: "square.and.arrow.down")
                    }
                    .disabled(itineraries.store == nil)

                    Button {
                        library.use(.mine)
                        itineraries.load(country: country, from: library)
                    } label: {
                        Label(localization.countryText("btn.restoreMine", fallback: "Restore my rides"), systemImage: "arrow.uturn.backward")
                    }
                    .disabled(!library.hasSavedStore)

                    Button(role: .destructive) {
                        library.deleteSavedStore(country: country)
                        itineraries.load(country: country, from: library)
                    } label: {
                        Label(localization.countryText("btn.clearStorage", fallback: "Delete my rides"), systemImage: "trash")
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
                sheet = .newJourney(StoreOperations.createBlankTrain(country: country))
            } label: {
                Label(localization.text("ios.newJourney", fallback: "New journey"), systemImage: "plus")
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
                        ? localization.countryText("play.stop", fallback: "Stop playback")
                        : localization.countryText("btn.play", fallback: "Play rides"),
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
            Label(localization.countryText("btn.play", fallback: "Play journey"), systemImage: "play.fill")
        }
        Button {
            sheet = .detail(train)
        } label: {
            Label(
                localization.text("ios.journeyInfo", fallback: "Journey information"),
                systemImage: "info.circle")
        }
        Button {
            itineraries.duplicate(train.id, country: country)
            persistMine()
        } label: {
            Label(localization.countryText("btn.duplicate", fallback: "Duplicate"), systemImage: "plus.square.on.square")
        }
        Button {
            itineraries.toggleVisibility(train.id, country: country)
            persistMine()
        } label: {
            Label(
                train.visible == false
                    ? localization.text("ios.showOnMap", fallback: "Show on map")
                    : localization.journeyText(
                        "ios.journey.hideFromMap", fallback: "Hide from map"),
                systemImage: train.visible == false ? "eye" : "eye.slash"
            )
        }
        Button {
            itineraries.move(train.id, by: -1, country: country)
            persistMine()
        } label: {
            Label(localization.countryText("btn.moveUp", fallback: "Move earlier"), systemImage: "arrow.up")
        }
        Button {
            itineraries.move(train.id, by: 1, country: country)
            persistMine()
        } label: {
            Label(localization.countryText("btn.moveDown", fallback: "Move later"), systemImage: "arrow.down")
        }
        Divider()
        Button(role: .destructive) { deleteCandidate = train } label: {
            Label(localization.countryText("btn.delete", fallback: "Delete"), systemImage: "trash")
        }
    }

    private func persistMine() {
        // Any edit forks a bundled sample into the reader's own store. A
        // sample remains immutable on disk and the user's change is durable.
        guard let store = itineraries.store else { return }
        library.save(store, country: country)
    }

    private var map: some View {
        RailMapView(
            lines: lines,
            stations: store.stations,
            rides: mapRides,
            selectedTrainID: itineraries.selectedTrainID,
            selectedDate: selectedDate,
            showsNetwork: controller.showsNetwork,
            basemapOpacity: controller.basemapOpacity,
            controller: controller,
            playback: playback,
            onSelectRide: { selectFromMap($0) }
        ) { render = $0 }
        .ignoresSafeArea()
    }

    /// §4.4: a tap on empty map steps back exactly one level — first the
    /// journey selection, then a single-day filter. Never both at once, and
    /// never a jump to a state the reader cannot predict.
    private func selectFromMap(_ id: String?) {
        if let id {
            itineraries.selectedTrainID = id
            return
        }
        if itineraries.selectedTrainID != nil {
            itineraries.selectedTrainID = nil
            return
        }
        if selectedDate != Dates.allDates {
            selectedDate = Dates.allDates
        }
    }

    /// Every visible ride, INCLUDING the ones outside the selected date.
    ///
    /// This used to drop off-date rides. That is not what the web app does and
    /// it is not what `DisplaySettings.dimOpacity` is for: an off-date ride is
    /// drawn faint so the reader can see the day in the context of the trip,
    /// and removing it makes the slider a control over nothing. The renderer
    /// is handed `selectedDate` and decides.
    ///
    /// `map-date-filter` (`mapFollowsSelectedDate`) is the reader asking for
    /// the harder version — only this date on the map — so that one still
    /// filters here.
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
                    .accessibilityLabel(localization.countryText("play.stop", fallback: "Stop playback"))
                }

                ProgressView(value: playback.progress)
                    .tint(.accentColor)

                HStack(spacing: 10) {
                    Label("\(playback.queueIndex + 1)/\(max(playback.queueCount, 1))", systemImage: "tram")
                        .font(.caption2.monospacedDigit())
                    Toggle(isOn: $playback.autoFocus) {
                        Label(localization.journeyText("play.focus", fallback: "Auto focus"), systemImage: "scope")
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
                        .accessibilityLabel(localization.countryText("play.speed", fallback: "Playback speed"))
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
            .accessibilityLabel(localization.journeyText("video.cancel", fallback: "Cancel video export"))
        case .finishing:
            ProgressView().controlSize(.small)
                .accessibilityLabel(localization.journeyText("video.finishing", fallback: "Finishing video"))
        case .finished(let url):
            ShareLink(item: url) {
                Image(systemName: "square.and.arrow.up.fill")
            }
            .accessibilityLabel(localization.journeyText("video.share", fallback: "Share video"))
        case .idle, .failed:
            Button { startVideoExport() } label: {
                Image(systemName: "video.badge.plus")
            }
            .accessibilityLabel(localization.countryText("video.export", fallback: "Export playback video"))
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
