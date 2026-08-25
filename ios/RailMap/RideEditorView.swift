import RailCore
import SwiftUI

/// Native form editing for one canonical train record. The editor owns a
/// draft and commits once; cancelling never leaves a half-edited store.
///
/// ## What changed in this slice
///
/// §5.4's information grouping, and its two hard interaction rules.
///
/// **The technical id is no longer the first question.** It used to be the
/// first field of the first section, which §8.2 forbids outright ("技术 ID 不
/// 应成为新建流程的第一个问题") — it now sits in a Record details section at
/// the bottom, where §5.4 puts it.
///
/// **Validation stands next to the field.** There was one sentence under the
/// whole form, showing the first problem only, and it disagreed with the rules
/// it was standing in for: it accepted a one-stop journey the exporter and the
/// web importer both reject. Every rule is now reported against the field that
/// causes it, the save button says why it is off, and "查看错误" moves focus
/// into the first offending field.
struct RideEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppLocalization.self) private var localization
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft: Train
    /// Editor-session identity for stops. `Stop` is a canonical value without
    /// an id, but these rows can be inserted, deleted and moved; tying SwiftUI
    /// identity to their array offsets moves navigation/focus state to a
    /// different stop whenever the order changes.
    @State private var stopIDs: [UUID]
    @State private var showsDiscardConfirmation = false
    /// The stops removed by the last delete, with the rows they came from.
    ///
    /// §8.6 asks for an undo before a confirmation, and here undo is exactly
    /// reliable: the draft is a value held in this view and nothing has been
    /// committed, so putting the rows back is arithmetic rather than a
    /// recovery. A confirmation would be asking permission to do something
    /// that costs nothing to reverse.
    @State private var undoableDeletion: [Deletion] = []
    /// Recomputed once per draft change rather than once per field.
    ///
    /// The authoritative half of the validation encodes the draft and runs
    /// `TrainValidation.validateTrain` over it; a `body` that called it from
    /// every field's inline message would run that a dozen times per
    /// keystroke, on a form whose stop list can be forty rows long.
    @State private var issues: [RideDraftIssue] = []
    @FocusState private var focused: RideDraftIssue.Field?

    let original: Train
    let title: String
    let onSave: (Train) -> Void
    /// Ids already in the store, so an id collision is visible while it is
    /// being typed rather than after the save quietly keeps the old one.
    /// Defaults to whatever the workspace has published (see
    /// ``RideStatusCenter``).
    var existingIDs: Set<String>?

    private struct Deletion: Equatable {
        var offset: Int
        var stop: Stop
        var id: UUID
    }

    init(
        train: Train,
        title: String = "Edit journey",
        existingIDs: Set<String>? = nil,
        onSave: @escaping (Train) -> Void
    ) {
        original = train
        self.title = title
        self.existingIDs = existingIDs
        _draft = State(initialValue: train)
        _stopIDs = State(initialValue: train.stops.map { _ in UUID() })
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    // Always on screen while the draft cannot be saved: a
                    // disabled toolbar button cannot answer a tap (§5.4).
                    if !blocking.isEmpty { problemSummary(proxy) }

                    basicsSection
                    stationsSection
                    stopsSection
                    routingSection
                    styleSection
                    recordSection
                }
                // Inline, and short. §14.5 forbids a fixed English-width
                // assumption, and the large title fought both toolbar buttons
                // for the same row and lost — 「乗車記録を編集」 came back as
                // 「乗車記録…」, a heading truncated to a stub. The specific
                // verb the spec asks for is on the SAVE button, which is where
                // it does work; this row only has to say which surface this is.
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .navigationBarTitleDisplayMode(.inline)
                .environment(\.editMode, .constant(.active))
                .onChange(of: draft, initial: true) { _, _ in revalidate() }
#if DEBUG
                // Scroll straight to a named section, for the same reason the
                // other `RAILMAP_UI_TEST_*` hooks exist: a screenshot harness
                // cannot scroll a form, so anything below the first screen —
                // the region row, the route sections and their messages —
                // would never be reviewed outside a hand session.
                .task {
                    guard let wanted = ProcessInfo.processInfo
                        .environment["RAILMAP_UI_TEST_EDITOR_SECTION"] else { return }
                    try? await Task.sleep(for: .milliseconds(700))
                    switch wanted {
                    case "record": proxy.scrollTo(RideDraftIssue.Field.id, anchor: .center)
                    case "routing":
                        proxy.scrollTo(RideDraftIssue.Field.routePolicy, anchor: .center)
                    default: break
                    }
                }
#endif
                .onChange(of: publishedIDs, initial: true) { _, _ in revalidate() }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(localization.text("ios.cancel", fallback: "Cancel")) {
                            if draft == original {
                                dismiss()
                            } else {
                                showsDiscardConfirmation = true
                            }
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        // §5.4 uses the specific verb: 保存旅程, not 完成.
                        Button(localization.editorText("ios.editor.saveJourney")) {
                            onSave(draft)
                        }
                        // §7.6: the primary action takes the one filled
                        // emphasis on the screen. Cancel and Save were the
                        // same glass capsule with the same white label at the
                        // same weight, so the row said nothing about which of
                        // the two commits the reader's work — and the two sit
                        // a thumb's width apart.
                        .buttonStyle(.borderedProminent)
                        .disabled(!blocking.isEmpty)
                        // §10.3's ⌘S. On the button rather than on the form,
                        // so it is disabled by exactly the same condition —
                        // a shortcut that commits a draft the button refuses
                        // would be a second, looser save path.
                        .keyboardShortcut("s", modifiers: .command)
                    }
                }
            }
            // §5.4: leaving a dirty draft asks; a clean one just closes.
            .confirmationDialog(
                localization.editorText("ios.editor.discardTitle"),
                isPresented: $showsDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button(
                    localization.editorText("ios.editor.discardChanges"),
                    role: .destructive
                ) { dismiss() }
                Button(localization.editorText("ios.editor.keepEditing"), role: .cancel) {}
            } message: {
                Text(localization.editorText("ios.editor.discardDetail"))
            }
        }
        .interactiveDismissDisabled(draft != original)
    }

    // MARK: - Why the save is off (§5.4)

    /// Always on screen while the draft is invalid, because a disabled button
    /// cannot answer a tap. §5.4: "保存禁用时必须让用户知道原因；点击不可用的
    /// 视觉区域不应无反馈."
    @ViewBuilder
    private func problemSummary(_ proxy: ScrollViewProxy) -> some View {
        Section {
            ForEach(blocking) { issue in
                Label(message(issue), systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(localization.editorText("ios.editor.showErrors")) {
                focusFirstProblem(proxy)
            }
            .frame(minHeight: 44)
        } header: {
            Text(localization.editorText("ios.editor.cannotSaveYet"))
        } footer: {
            Text(
                localization.editorText(
                    "ios.editor.blockedCount",
                    ["count": .number(Double(blocking.count))]))
        }
    }

    /// §5.4: "第一个错误字段应可被『查看错误』动作聚焦."
    private func focusFirstProblem(_ proxy: ScrollViewProxy) {
        guard let issue = blocking.first else { return }
        let target = scrollTarget(for: issue.field)
        if reduceMotion {
            proxy.scrollTo(target, anchor: .center)
        } else {
            withAnimation(RailMotion.spring) {
                proxy.scrollTo(target, anchor: .center)
            }
        }
        if issue.field.isTextField { focused = issue.field }
    }

    /// Validation identifies stop problems by their current ordinal; scrolling
    /// identifies the mutable row by its stable editor-session id.
    private func scrollTarget(for field: RideDraftIssue.Field) -> AnyHashable {
        if case .stop(let index) = field, stopIDs.indices.contains(index) {
            return AnyHashable(stopIDs[index])
        }
        return AnyHashable(field)
    }

    // MARK: - 1. Basics

    private var basicsSection: some View {
        Section {
            EditorTextField(
                title: localization.editorText("ios.editor.date"),
                text: optionalText(\.date),
                prompt: "YYYY-MM-DD",
                focus: $focused,
                field: .date
            )
            .keyboardType(.numbersAndPunctuation)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .id(RideDraftIssue.Field.date)
            fieldIssues(.date)

            EditorTextField(
                title: localization.countryText("field.number", fallback: "Train number"),
                text: $draft.number,
                focus: $focused,
                field: .number
            )
            .id(RideDraftIssue.Field.number)
            fieldIssues(.number)

            EditorTextField(
                title: localization.countryText("field.trainType", fallback: "Train type"),
                text: optionalText(\.trainType))
            EditorTextField(
                title: localization.countryText("field.company", fallback: "Operator"),
                text: optionalText(\.company))
            EditorTextField(
                title: localization.countryText("field.direction", fallback: "Direction"),
                text: optionalText(\.direction))

            Toggle(localization.text("ios.showOnMap", fallback: "Show on map"), isOn: visibleBinding)
        } header: {
            Text(localization.editorText("ios.editor.basics"))
        } footer: {
            // §8.5: hiding changes the map, not the record or the export.
            Text(localization.editorText("ios.editor.visibilityNote"))
        }
    }

    // MARK: - 2. Origin and destination

    private var stationsSection: some View {
        Section {
            EditorTextField(
                title: localization.countryText("field.origin", fallback: "Origin"),
                text: $draft.origin,
                focus: $focused,
                field: .origin
            )
            .id(RideDraftIssue.Field.origin)
            fieldIssues(.origin)

            EditorTextField(
                title: localization.countryText("field.destination", fallback: "Destination"),
                text: $draft.destination,
                focus: $focused,
                field: .destination
            )
            .id(RideDraftIssue.Field.destination)
            fieldIssues(.destination)
        } header: {
            Text(localization.text("ios.stations", fallback: "Stations"))
        } footer: {
            Text(localization.editorText("ios.editor.stationsNote"))
        }
    }

    // MARK: - 3. Stops

    private var stopsSection: some View {
        Section {
            ForEach(stopIDs, id: \.self) { stopID in
                if let index = stopIDs.firstIndex(of: stopID) {
                    VStack(alignment: .leading, spacing: 4) {
                        NavigationLink {
                            StopEditorView(
                                stop: $draft.stops[index], index: index,
                                region: Region.resolved(draft))
                        } label: {
                            StopEditorLabel(stop: draft.stops[index], index: index + 1)
                        }
                        fieldIssues(.stop(index))
                    }
                    .id(stopID)
                }
            }
            .onDelete(perform: deleteStops)
            .onMove(perform: moveStops)

            if !undoableDeletion.isEmpty { undoBanner }

            Button {
                undoableDeletion = []
                draft.stops.append(
                    Stop(name: "", stopType: "passenger_stop", rideSegment: true))
                stopIDs.append(UUID())
            } label: {
                Label(
                    localization.countryText("btn.addStop", fallback: "Add stop"),
                    systemImage: "plus")
            }
            fieldIssues(.stops)
        } header: {
            Text(localization.countryText("sec.stops", fallback: "Stops"))
                .id(RideDraftIssue.Field.stops)
        } footer: {
            Text(localization.editorText("ios.editor.stopsNote"))
        }
    }

    /// §8.6: a short undo rather than a confirmation, because the draft has
    /// not been committed and putting the rows back is exact.
    private var undoBanner: some View {
        HStack {
            Text(
                localization.editorText(
                    "ios.editor.deletedStops",
                    ["count": .number(Double(undoableDeletion.count))])
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            Spacer()
            Button(localization.editorText("ios.editor.undoDelete")) {
                for deletion in undoableDeletion.sorted(by: { $0.offset < $1.offset }) {
                    let at = min(deletion.offset, draft.stops.count)
                    draft.stops.insert(deletion.stop, at: at)
                    stopIDs.insert(deletion.id, at: at)
                }
                undoableDeletion = []
            }
        }
        .frame(minHeight: 44)
    }

    private func deleteStops(at offsets: IndexSet) {
        undoableDeletion = offsets.sorted().map {
            Deletion(offset: $0, stop: draft.stops[$0], id: stopIDs[$0])
        }
        draft.stops.remove(atOffsets: offsets)
        stopIDs.remove(atOffsets: offsets)
    }

    private func moveStops(from offsets: IndexSet, to destination: Int) {
        undoableDeletion = []
        draft.stops.move(fromOffsets: offsets, toOffset: destination)
        stopIDs.move(fromOffsets: offsets, toOffset: destination)
    }

    // MARK: - 4. Routing (advanced)

    private var routingSection: some View {
        Section {
            NavigationLink {
                RoutePolicyEditorView(policy: routePolicy)
                    .environment(localization)
            } label: {
                LabeledContent(
                    localization.text("ios.routePolicy", fallback: "Route policy"),
                    value: routePolicySummary)
            }
            .id(RideDraftIssue.Field.routePolicy)
            fieldIssues(.routePolicy)

            if issues.first(for: .routePolicy) != nil {
                Button(localization.editorText("ios.editor.policyReset")) {
                    draft.routePolicy = Self.canonicalPolicy
                }
                .frame(minHeight: 44)
            }

            ForEach(routeSectionIndices, id: \.self) { index in
                NavigationLink {
                    RouteSectionEditorView(section: routeSection(at: index))
                        .environment(localization)
                } label: {
                    RouteSectionLabel(
                        section: draft.routeSections?[index], index: index + 1,
                        localization: localization)
                }
            }
            .onDelete(perform: deleteRouteSections)
            .onMove(perform: moveRouteSections)

            // Below the list rather than inside it: a `ForEach` that carries
            // `onDelete` and `onMove` addresses its OWN elements, and a second
            // view per element makes a swipe ambiguous about which row it is
            // acting on. Each message names its section number, which is what
            // it would have said standing next to it.
            ForEach(routeSectionIndices, id: \.self) { index in
                fieldIssues(.routeSection(index))
                    .id(RideDraftIssue.Field.routeSection(index))
            }

            Button(action: addRouteSection) {
                Label(
                    localization.text("ios.addRouteSection", fallback: "Add route section"),
                    systemImage: "point.topleft.down.to.point.bottomright.curvepath")
            }
        } header: {
            Text(localization.text("ios.routing", fallback: "Routing"))
        } footer: {
            // §5.4: the rebuild happens after the stops are saved, and where
            // it happens is stated rather than left to be discovered.
            Text(localization.editorText("ios.editor.rebuildAfterSave"))
        }
    }

    // MARK: - 5. Style

    private var styleSection: some View {
        Section {
            HStack {
                EditorTextField(
                    title: localization.editorText("ios.editor.routeColor"),
                    text: styleColor,
                    prompt: "#RRGGBB",
                    focus: $focused,
                    field: .color
                )
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                Circle()
                    .fill(routeColor)
                    .frame(width: 22, height: 22)
                    .overlay(Circle().stroke(.separator, lineWidth: 0.5))
                    .accessibilityHidden(true)
            }
            .id(RideDraftIssue.Field.color)
            fieldIssues(.color)
        } header: {
            Text(localization.text("ios.style", fallback: "Style"))
        }
    }

    // MARK: - 6. Record details (advanced — §5.4, §8.2)

    private var recordSection: some View {
        Section {
            // Which region this ride is measured against: its solver, its
            // statistics, its station picker. Offered rather than derived
            // because a hand-written ride may carry no station codes at all,
            // and then nothing else in the record can say.
            Picker(
                localization.countryText("country.label", fallback: "Region"),
                selection: regionSelection
            ) {
                ForEach(Region.ordered) { region in
                    Text(localization.text(region.localizationKey, fallback: region.fallbackName))
                        .tag(region)
                }
            }
            Text(localization.editorText("ios.editor.regionNote"))
                .font(.footnote)
                .foregroundStyle(.secondary)

            EditorTextField(
                title: localization.countryText("field.id", fallback: "Identifier"),
                text: $draft.id,
                focus: $focused,
                field: .id
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .id(RideDraftIssue.Field.id)
            fieldIssues(.id)
            fieldIssues(.record)
                .id(RideDraftIssue.Field.record)
        } header: {
            Text(localization.editorText("ios.editor.record"))
        } footer: {
            Text(localization.editorText("ios.editor.recordNote"))
        }
    }

    // MARK: - Inline messages

    /// Every message for one field, in the field's own row.
    @ViewBuilder
    private func fieldIssues(_ field: RideDraftIssue.Field) -> some View {
        ForEach(issues.all(for: field)) { issue in
            Label(message(issue), systemImage: symbol(issue))
                .font(.footnote)
                .foregroundStyle(issue.severity == .error ? Color.red : Color.orange)
                .fixedSize(horizontal: false, vertical: true)
                // §10.2: the message belongs to the control above it, not to a
                // separate thing the reader has to find.
                .accessibilityElement(children: .combine)
        }
    }

    private func symbol(_ issue: RideDraftIssue) -> String {
        issue.severity == .error ? "exclamationmark.circle.fill" : "exclamationmark.triangle"
    }

    private func message(_ issue: RideDraftIssue) -> String {
        if let literal = issue.literal { return literal }
        return localization.editorText(issue.key, issue.params)
    }

    // MARK: - Validation

    private var publishedIDs: Set<String> {
        existingIDs ?? RideStatusCenter.shared.trainIDs
    }

    private func revalidate() {
        issues = RideDraftValidation.issues(
            for: draft, originalID: original.id, existingIDs: publishedIDs)
    }

    private var blocking: [RideDraftIssue] { issues.blocking }

    // MARK: - Bindings

    private var visibleBinding: Binding<Bool> {
        Binding(get: { draft.visible != false }, set: { draft.visible = $0 })
    }

    /// The region row.
    ///
    /// Reading falls back to what the stops say — an untagged ride shows the
    /// region it would be treated as, not a blank — and writing states it,
    /// because a reader who picked a region meant it even where the stops
    /// would have said something else.
    private var regionSelection: Binding<Region> {
        Binding(
            get: { Region.resolved(draft) },
            set: { draft.region = $0.code }
        )
    }

    private var styleColor: Binding<String> {
        Binding(
            get: { draft.style?.color ?? "" },
            set: { draft.style = TrainStyle(color: $0.isEmpty ? nil : $0) }
        )
    }

    private var routeColor: Color {
        Color(hex: draft.style?.color) ?? .accentColor
    }

    /// The policy every canonical writer produces. Also the repair offered
    /// when a decoded policy fails the schema: the four invariants below are
    /// constants, not choices, so resetting them cannot lose a decision the
    /// reader made.
    private static let canonicalPolicy = RoutePolicy(
        mode: "single_primary_route",
        jrOnly: false,
        allowAlternatives: false,
        allowBrowserStraightLineFallback: false,
        allowedInstitutionTypeCodes: TrainValidation.defaultAllowedInstitutionTypeCodes,
        institutionFilterMode: "soft")

    private var routePolicy: Binding<RoutePolicy> {
        Binding(
            get: { draft.routePolicy ?? Self.canonicalPolicy },
            set: { draft.routePolicy = $0 }
        )
    }

    private var routePolicySummary: String {
        switch draft.routePolicy?.institutionFilterMode {
        case "hard": localization.editorText("ios.editor.hardConstraint")
        case "soft": localization.editorText("ios.editor.softPreference")
        default: localization.editorText("ios.editor.automatic")
        }
    }

    private var routeSectionIndices: Range<Int> {
        (draft.routeSections ?? []).indices
    }

    private func routeSection(at index: Int) -> Binding<RouteSection> {
        Binding(
            get: { draft.routeSections?[index] ?? RouteSection() },
            set: { value in
                guard draft.routeSections?.indices.contains(index) == true else { return }
                draft.routeSections?[index] = value
            }
        )
    }

    private func addRouteSection() {
        var sections = draft.routeSections ?? []
        let previous = sections.last?.to ?? draft.stops.first?.name
        sections.append(
            RouteSection(
                from: previous,
                to: draft.stops.last?.name,
                fromN02StationCode: sections.last?.toN02StationCode
                    ?? draft.stops.first?.n02StationCode,
                toN02StationCode: draft.stops.last?.n02StationCode
            )
        )
        draft.routeSections = sections
    }

    private func deleteRouteSections(at offsets: IndexSet) {
        var sections = draft.routeSections ?? []
        sections.remove(atOffsets: offsets)
        draft.routeSections = sections
    }

    private func moveRouteSections(from offsets: IndexSet, to destination: Int) {
        var sections = draft.routeSections ?? []
        sections.move(fromOffsets: offsets, toOffset: destination)
        draft.routeSections = sections
    }

    private func optionalText(_ keyPath: WritableKeyPath<Train, String?>) -> Binding<String> {
        Binding(
            get: { draft[keyPath: keyPath] ?? "" },
            set: { draft[keyPath: keyPath] = $0.isEmpty ? nil : $0 }
        )
    }
}

private struct RouteSectionLabel: View {
    let section: RouteSection?
    let index: Int
    let localization: AppLocalization

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(localization.editorText("ios.editor.sectionIndex", ["index": .number(Double(index))]))
            // A section whose endpoint NAME was dropped on the way to disk
            // still knows its station code: `leanExportSection` omits a name
            // the stop list can re-derive, so 「駅名未設定 → 駅名未設定」 is
            // what an ordinary, perfectly valid section reads as unless the
            // code is allowed to stand in for it.
            Text("\(endpoint(section?.from, section?.fromN02StationCode)) → "
                + "\(endpoint(section?.to, section?.toN02StationCode))")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }

    private func endpoint(_ name: String?, _ code: String?) -> String {
        if let name, !name.isEmpty { return localization.stationName(name, code: code) }
        if let code, !code.isEmpty { return code }
        return localization.editorText("ios.route.unnamedStation")
    }
}

private struct RoutePolicyEditorView: View {
    @Environment(AppLocalization.self) private var localization
    @Binding var policy: RoutePolicy

    var body: some View {
        Form {
            Section(localization.editorText("ios.editor.solver")) {
                Picker(
                    localization.editorText("ios.editor.institutionFilter"),
                    selection: optionalText(\.institutionFilterMode)
                ) {
                    Text(localization.editorText("ios.editor.automatic")).tag("")
                    Text(localization.editorText("ios.editor.softPreference")).tag("soft")
                    Text(localization.editorText("ios.editor.hardConstraint")).tag("hard")
                }
                Toggle(
                    localization.editorText("ios.editor.jrOnlyHint"), isOn: optionalBool(\.jrOnly))
                // Schema constants, shown so the reader can see they are off
                // rather than wonder. jsonspec §13.5: a straight line between
                // two stations is forbidden under all circumstances.
                LabeledContent(
                    localization.editorText("ios.editor.routeAlternatives"),
                    value: localization.editorText("ios.editor.disabled"))
                LabeledContent(
                    localization.editorText("ios.editor.straightLineFallback"),
                    value: localization.editorText("ios.editor.disabled"))
            }

            Section {
                EditorTextField(
                    title: localization.editorText("ios.editor.institutionCodes"),
                    text: commaSeparated(\.allowedInstitutionTypeCodes),
                    prompt: "1, 2, 3"
                )
                EditorTextField(
                    title: localization.editorText("ios.editor.preferredLines"),
                    text: commaSeparated(\.preferredLineNames),
                    prompt: localization.editorText("ios.editor.onePerComma")
                )
                EditorTextField(
                    title: localization.editorText("ios.editor.preferredOperators"),
                    text: commaSeparated(\.preferredOperatorNames),
                    prompt: localization.editorText("ios.editor.onePerComma")
                )
            } header: {
                Text(localization.editorText("ios.editor.preferences"))
            } footer: {
                Text(localization.editorText("ios.editor.policyFooter"))
            }
        }
        .navigationTitle(localization.text("ios.routePolicy", fallback: "Route policy"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func optionalText(_ keyPath: WritableKeyPath<RoutePolicy, String?>) -> Binding<String> {
        Binding(
            get: { policy[keyPath: keyPath] ?? "" },
            set: { policy[keyPath: keyPath] = $0.isEmpty ? nil : $0 }
        )
    }

    private func optionalBool(_ keyPath: WritableKeyPath<RoutePolicy, Bool?>) -> Binding<Bool> {
        Binding(
            get: { policy[keyPath: keyPath] ?? false },
            set: { policy[keyPath: keyPath] = $0 }
        )
    }

    private func commaSeparated(
        _ keyPath: WritableKeyPath<RoutePolicy, [String]?>
    ) -> Binding<String> {
        Binding(
            get: { (policy[keyPath: keyPath] ?? []).joined(separator: ", ") },
            set: { policy[keyPath: keyPath] = Self.values(from: $0) }
        )
    }

    private static func values(from text: String) -> [String]? {
        let values = text.split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
        return values.isEmpty ? nil : values
    }
}

private struct RouteSectionEditorView: View {
    @Environment(AppLocalization.self) private var localization
    @Binding var section: RouteSection

    var body: some View {
        Form {
            Section(localization.editorText("ios.editor.endpoints")) {
                EditorTextField(
                    title: localization.editorText("ios.editor.fromStation"),
                    text: optionalText(\.from))
                EditorTextField(
                    title: localization.editorText("ios.editor.stationCode"),
                    text: optionalText(\.fromN02StationCode)
                )
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                EditorTextField(
                    title: localization.editorText("ios.editor.toStation"),
                    text: optionalText(\.to))
                EditorTextField(
                    title: localization.editorText("ios.editor.stationCode"),
                    text: optionalText(\.toN02StationCode)
                )
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            }

            Section(localization.editorText("ios.editor.constraints")) {
                EditorTextField(
                    title: localization.editorText("ios.editor.lineNames"),
                    text: commaSeparated(\.lineNames),
                    prompt: localization.editorText("ios.editor.onePerComma"))
                EditorTextField(
                    title: localization.editorText("ios.editor.operatorNames"),
                    text: commaSeparated(\.operatorNames),
                    prompt: localization.editorText("ios.editor.onePerComma"))
            }

            Section(localization.editorText("ios.editor.branchService")) {
                EditorTextField(
                    title: localization.countryText("field.number", fallback: "Train number"),
                    text: optionalText(\.number))
                EditorTextField(
                    title: localization.editorText("ios.editor.displayName"),
                    text: optionalText(\.name))
            }
        }
        .navigationTitle(localization.text("ios.routeSection", fallback: "Route section"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func optionalText(_ keyPath: WritableKeyPath<RouteSection, String?>) -> Binding<String> {
        Binding(
            get: { section[keyPath: keyPath] ?? "" },
            set: { section[keyPath: keyPath] = $0.isEmpty ? nil : $0 }
        )
    }

    private func commaSeparated(
        _ keyPath: WritableKeyPath<RouteSection, [String]?>
    ) -> Binding<String> {
        Binding(
            get: { (section[keyPath: keyPath] ?? []).joined(separator: ", ") },
            set: {
                let values = $0.split(separator: ",").map {
                    $0.trimmingCharacters(in: .whitespacesAndNewlines)
                }.filter { !$0.isEmpty }
                section[keyPath: keyPath] = values.isEmpty ? nil : values
            }
        )
    }
}

private struct StopEditorLabel: View {
    @Environment(AppLocalization.self) private var localization
    let stop: Stop
    let index: Int

    var body: some View {
        HStack(spacing: 10) {
            Text(index, format: .number)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(stop.name.isEmpty ? localization.editorText("ios.editor.untitledStop") : stop.name)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if let arrival = stop.arrival, !arrival.isEmpty { Text(arrival) }
                    if let departure = stop.departure, !departure.isEmpty { Text(departure) }
                    if let platform = stop.platformNumber {
                        Text(
                            localization.editorText(
                                "ios.detail.platformValue",
                                ["number": .number(Double(platform))]))
                    }
                    if stop.stopType != "passenger_stop" {
                        Text(localization.countryText("stoptype.\(stop.stopType)", fallback: stop.stopType))
                    }
                    if !stop.rideSegment {
                        Text(localization.editorText("ios.detail.notRidden"))
                    }
                }
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
            Spacer()
            if stop.rideSegment {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.tint)
                    .accessibilityLabel(localization.editorText("ios.detail.ridden"))
            }
        }
        .frame(minHeight: 44)
    }
}

private struct StopEditorView: View {
    @Environment(RailNetworkStore.self) private var network
    @Environment(AppLocalization.self) private var localization
    @Binding var stop: Stop
    let index: Int
    /// The ride's region, so the picker offers that network's stations rather
    /// than all 14,000 across five countries — where 中央駅 and 中央站 would
    /// sit next to each other and picking the wrong one is a route that will
    /// never solve.
    let region: Region

    /// `TrainValidation.stopTypes`, not a copy of it: the order is the web
    /// editor's `<select>` order and is quoted into the rejection message, so
    /// a second list here would be a second answer.
    private var types: [String] { TrainValidation.stopTypes }

    var body: some View {
        Form {
            Section(localization.editorText("ios.editor.station")) {
                EditorTextField(
                    title: localization.editorText("ios.editor.stationName"), text: $stop.name)
                if stop.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Label(
                        localization.editorText("ios.editor.stopNameRequired"),
                        systemImage: "exclamationmark.circle.fill"
                    )
                    .font(.footnote)
                    .foregroundStyle(.red)
                }
                NavigationLink {
                    StationPickerView(stop: $stop, stations: network.stations(in: region))
                        .environment(localization)
                } label: {
                    Label(
                        localization.editorText("ios.editor.chooseStation"),
                        systemImage: "tram.circle")
                }
                EditorTextField(
                    title: localization.editorText("ios.editor.stationCode"),
                    text: optionalText(\.n02StationCode)
                )
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                if let code = stop.n02StationCode, !code.isEmpty,
                    TrainValidation.stationCodeSystem(code) == nil
                {
                    Label(
                        localization.editorText("ios.editor.stationCodeRule"),
                        systemImage: "exclamationmark.circle.fill"
                    )
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                }
                EditorTextField(
                    title: localization.editorText("ios.editor.platformNumber"),
                    text: platformText,
                    prompt: localization.editorText("ios.editor.platformOptional")
                )
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                if let platform = stop.platformNumber, platform < 0 {
                    Label(
                        localization.editorText("ios.editor.platformRule"),
                        systemImage: "exclamationmark.circle.fill"
                    )
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section {
                Picker(
                    localization.countryText("popup.stopType", fallback: "Stop type"),
                    selection: $stop.stopType
                ) {
                    ForEach(types, id: \.self) {
                        Text(localization.countryText("stoptype.\($0)", fallback: $0)).tag($0)
                    }
                }
                Toggle(
                    localization.countryText("popup.rideSegment", fallback: "Ridden segment"),
                    isOn: $stop.rideSegment)
            } footer: {
                Text(localization.editorText("ios.editor.rideSegmentNote"))
            }

            Section {
                EditorTextField(
                    title: localization.countryText("popup.arrival", fallback: "Arrival"),
                    text: optionalText(\.arrival),
                    prompt: "HH:MM"
                )
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                EditorTextField(
                    title: localization.countryText("popup.departure", fallback: "Departure"),
                    text: optionalText(\.departure),
                    prompt: "HH:MM"
                )
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            } header: {
                Text(localization.editorText("ios.editor.times"))
            } footer: {
                // §7.3 / §10.4: an overnight time is written past 24:00 and
                // kept that way. Nothing here reformats it into a date.
                Text(localization.editorText("ios.editor.crossDayHint"))
            }
        }
        .navigationTitle(
            stop.name.isEmpty
                ? localization.editorText("ios.editor.stopIndex", ["index": .number(Double(index + 1))])
                : stop.name
        )
        .navigationBarTitleDisplayMode(.inline)
    }

    private func optionalText(_ keyPath: WritableKeyPath<Stop, String?>) -> Binding<String> {
        Binding(
            get: { stop[keyPath: keyPath] ?? "" },
            set: { stop[keyPath: keyPath] = $0.isEmpty ? nil : $0 }
        )
    }

    private var platformText: Binding<String> {
        Binding(
            get: { stop.platformNumber.map(String.init) ?? "" },
            set: {
                let value = $0.trimmingCharacters(in: .whitespacesAndNewlines)
                stop.platformNumber = value.isEmpty ? nil : Int(value)
            }
        )
    }
}

private struct StationPickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppLocalization.self) private var localization
    @Binding var stop: Stop
    let stations: [RailNetworkStore.DrawnStation]
    @State private var query = ""

    var body: some View {
        List(filteredStations, id: \.stationCode) { station in
            Button {
                stop.name = station.name
                stop.n02StationCode = station.stationCode
                dismiss()
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(station.name)
                    if !station.nameRoma.isEmpty {
                        Text(station.nameRoma).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(.rect)
            }
            // §14.3, on a row whose whole purpose is to be tapped. `.plain`
            // inside a `List` suppresses the system's own row highlight and
            // puts nothing in its place, so choosing a station gave no answer
            // until the sheet dismissed. Square corners because this is a
            // plain list row rather than one of the panel's rounded cards.
            .buttonStyle(RailRowPressStyle(cornerRadius: 0))
        }
        .navigationTitle(localization.editorText("ios.editor.chooseStation"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $query, prompt: Text(localization.editorText("ios.editor.stationSearch")))
    }

    private var filteredStations: [RailNetworkStore.DrawnStation] {
        var seen = Set<String>()
        let unique = stations.filter { seen.insert($0.stationCode).inserted }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return unique }
        return unique.filter {
            $0.name.localizedCaseInsensitiveContains(needle)
                || $0.nameRoma.localizedCaseInsensitiveContains(needle)
                || $0.stationCode.localizedCaseInsensitiveContains(needle)
        }
    }
}

/// A form field that keeps its label visible once it has a value.
///
/// A bare `TextField("車次", text:)` in a `Form` shows its title *only while
/// the field is empty* — the moment a value arrives, the one word saying what
/// the value means disappears. On a form of ten fields that leaves a column of
/// unlabelled strings, and it is worse in the three CJK interface languages,
/// where a station name and an operator name are the same shape.
///
/// So the label is a caption above the value, which also keeps a long label
/// and a long value from competing for one line (§10.1, §14.5).
private struct EditorField<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            content
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// `EditorField` around a plain text field, which is nearly all of them.
///
/// `focus`/`field` are threaded in rather than left to the caller's
/// `.focused(...)` on the wrapper: the focus binding has to land on the
/// focusable element itself for "查看错误" to be able to put the cursor in the
/// first bad field, and a modifier on the enclosing `VStack` is not a
/// guarantee that it does.
private struct EditorTextField: View {
    let title: String
    @Binding var text: String
    var prompt: String?
    var focus: FocusState<RideDraftIssue.Field?>.Binding?
    var field: RideDraftIssue.Field?

    var body: some View {
        EditorField(title: title) {
            if let focus, let field {
                textField.focused(focus, equals: field)
            } else {
                textField
            }
        }
    }

    private var textField: some View {
        TextField(title, text: $text, prompt: Text(prompt ?? title))
            .labelsHidden()
    }
}
