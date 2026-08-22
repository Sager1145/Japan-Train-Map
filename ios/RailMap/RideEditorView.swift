import RailCore
import SwiftUI

/// Native form editing for one canonical train record. The editor owns a
/// draft and commits once; cancelling never leaves a half-edited store.
struct RideEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppLocalization.self) private var localization
    @State private var draft: Train
    @State private var showsDiscardConfirmation = false

    let original: Train
    let title: String
    let onSave: (Train) -> Void

    init(
        train: Train,
        title: String = "Edit journey",
        onSave: @escaping (Train) -> Void
    ) {
        original = train
        self.title = title
        _draft = State(initialValue: train)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(localization.text("ios.journey", fallback: "Journey")) {
                    TextField(localization.text("field.id", fallback: "Identifier"), text: $draft.id)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Date", text: optionalText(\.date), prompt: Text("YYYY-MM-DD"))
                        .keyboardType(.numbersAndPunctuation)
                    TextField(localization.text("field.number", fallback: "Train number"), text: $draft.number)
                    TextField(localization.text("field.trainType", fallback: "Train type"), text: optionalText(\.trainType))
                    TextField(localization.text("field.company", fallback: "Operator"), text: optionalText(\.company))
                    TextField(localization.text("field.direction", fallback: "Direction"), text: optionalText(\.direction))
                    Toggle(localization.text("ios.showOnMap", fallback: "Show on map"), isOn: visibleBinding)
                }

                Section(localization.text("ios.stations", fallback: "Stations")) {
                    TextField(localization.text("field.origin", fallback: "Origin"), text: $draft.origin)
                    TextField(localization.text("field.destination", fallback: "Destination"), text: $draft.destination)
                }

                Section(localization.text("sec.stops", fallback: "Stops")) {
                    ForEach(draft.stops.indices, id: \.self) { index in
                        NavigationLink {
                            StopEditorView(stop: $draft.stops[index])
                        } label: {
                            StopEditorLabel(stop: draft.stops[index], index: index + 1)
                        }
                    }
                    .onDelete { draft.stops.remove(atOffsets: $0) }
                    .onMove { draft.stops.move(fromOffsets: $0, toOffset: $1) }

                    Button {
                        draft.stops.append(
                            Stop(name: "", stopType: "passenger_stop", rideSegment: true))
                    } label: {
                        Label(localization.text("ios.addStop", fallback: "Add stop"), systemImage: "plus")
                    }
                }

                Section(localization.text("ios.routing", fallback: "Routing")) {
                    NavigationLink {
                        RoutePolicyEditorView(policy: routePolicy)
                    } label: {
                        LabeledContent(
                            localization.text("ios.routePolicy", fallback: "Route policy"),
                            value: draft.routePolicy?.institutionFilterMode?.capitalized ?? "Automatic"
                        )
                    }

                    ForEach(routeSectionIndices, id: \.self) { index in
                        NavigationLink {
                            RouteSectionEditorView(section: routeSection(at: index))
                        } label: {
                            RouteSectionLabel(section: draft.routeSections?[index], index: index + 1)
                        }
                    }
                    .onDelete(perform: deleteRouteSections)
                    .onMove(perform: moveRouteSections)

                    Button(action: addRouteSection) {
                        Label(localization.text("ios.addRouteSection", fallback: "Add route section"), systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                    }
                }

                Section(localization.text("ios.style", fallback: "Style")) {
                    HStack {
                        TextField("Route colour", text: styleColor, prompt: Text("#RRGGBB"))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Circle()
                            .fill(routeColor)
                            .frame(width: 22, height: 22)
                            .overlay(Circle().stroke(.separator, lineWidth: 0.5))
                            .accessibilityHidden(true)
                    }
                }

                if let validationMessage {
                    Section {
                        Label(validationMessage, systemImage: "exclamationmark.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .environment(\.editMode, .constant(.active))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localization.text("ios.cancel", fallback: "Cancel")) {
                        if draft == original { dismiss() } else { showsDiscardConfirmation = true }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(localization.text("ios.save", fallback: "Save")) { onSave(draft) }
                        .disabled(!canSave)
                }
            }
            .confirmationDialog(
                "Discard changes?",
                isPresented: $showsDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button(localization.text("ios.discardChanges", fallback: "Discard changes"), role: .destructive) { dismiss() }
            }
        }
        .interactiveDismissDisabled(draft != original)
    }

    private var canSave: Bool {
        TrainValidation.matchesTrainIDPattern(draft.id)
            && !draft.number.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.destination.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.stops.isEmpty
            && draft.stops.allSatisfy {
                !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && TrainValidation.stopTypes.contains($0.stopType)
            }
            && ((draft.style?.color ?? "").isEmpty
                || TrainValidation.isValidTrainColor(draft.style?.color))
    }

    private var validationMessage: String? {
        if !TrainValidation.matchesTrainIDPattern(draft.id) {
            return String(localized: "Identifier may contain only letters, numbers, underscores, and hyphens.")
        }
        if draft.number.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "Enter a train number.")
        }
        if draft.origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || draft.destination.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return String(localized: "Enter both origin and destination.")
        }
        if draft.stops.isEmpty
            || draft.stops.contains(where: {
                $0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            })
        {
            return String(localized: "Every journey needs at least one named stop.")
        }
        if let color = draft.style?.color, !color.isEmpty,
            !TrainValidation.isValidTrainColor(color)
        {
            return String(localized: "Route colour must use #RRGGBB format.")
        }
        return nil
    }

    private var visibleBinding: Binding<Bool> {
        Binding(get: { draft.visible != false }, set: { draft.visible = $0 })
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

    private var routePolicy: Binding<RoutePolicy> {
        Binding(
            get: {
                draft.routePolicy
                    ?? RoutePolicy(
                        mode: "single_primary_route",
                        jrOnly: false,
                        allowAlternatives: false,
                        allowBrowserStraightLineFallback: false,
                        allowedInstitutionTypeCodes: TrainValidation.defaultAllowedInstitutionTypeCodes,
                        institutionFilterMode: "soft"
                    )
            },
            set: { draft.routePolicy = $0 }
        )
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

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Section \(index)")
            Text("\(section?.from ?? "Start") → \(section?.to ?? "End")")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct RoutePolicyEditorView: View {
    @Binding var policy: RoutePolicy

    var body: some View {
        Form {
            Section("Solver") {
                Picker("Institution filter", selection: optionalText(\.institutionFilterMode)) {
                    Text("Automatic").tag("")
                    Text("Soft preference").tag("soft")
                    Text("Hard constraint").tag("hard")
                }
                Toggle("JR only hint", isOn: optionalBool(\.jrOnly))
                LabeledContent("Route alternatives", value: "Disabled")
                LabeledContent("Straight-line fallback", value: "Disabled")
            }

            Section {
                TextField(
                    "Institution type codes",
                    text: commaSeparated(\.allowedInstitutionTypeCodes),
                    prompt: Text("1, 2, 3")
                )
                TextField(
                    "Preferred lines",
                    text: commaSeparated(\.preferredLineNames),
                    prompt: Text("One per comma")
                )
                TextField(
                    "Preferred operators",
                    text: commaSeparated(\.preferredOperatorNames),
                    prompt: Text("One per comma")
                )
            } header: {
                Text("Preferences")
            } footer: {
                Text("Hard filters can prevent a route from resolving. Soft preferences only influence ranking.")
            }
        }
        .navigationTitle("Route policy")
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
    @Binding var section: RouteSection

    var body: some View {
        Form {
            Section("Endpoints") {
                TextField("From station", text: optionalText(\.from))
                TextField("From station code", text: optionalText(\.fromN02StationCode))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                TextField("To station", text: optionalText(\.to))
                TextField("To station code", text: optionalText(\.toN02StationCode))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
            }

            Section("Constraints") {
                TextField("Line names", text: commaSeparated(\.lineNames), prompt: Text("One per comma"))
                TextField(
                    "Operator names",
                    text: commaSeparated(\.operatorNames),
                    prompt: Text("One per comma")
                )
            }

            Section("Branch service") {
                TextField("Train number", text: optionalText(\.number))
                TextField("Display name", text: optionalText(\.name))
            }
        }
        .navigationTitle("Route section")
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
    let stop: Stop
    let index: Int

    var body: some View {
        HStack(spacing: 10) {
            Text(index, format: .number)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(stop.name.isEmpty ? "Untitled stop" : stop.name)
                HStack(spacing: 6) {
                    if let arrival = stop.arrival, !arrival.isEmpty { Text(arrival) }
                    if let departure = stop.departure, !departure.isEmpty { Text(departure) }
                    if stop.stopType == "pass_through" { Text("Pass") }
                }
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
            Spacer()
            if stop.rideSegment {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.tint)
                    .accessibilityLabel("Ridden")
            }
        }
        .frame(minHeight: 44)
    }
}

private struct StopEditorView: View {
    @Environment(RailNetworkStore.self) private var network
    @Binding var stop: Stop

    private let types = [
        ("Origin", "origin"),
        ("Passenger stop", "passenger_stop"),
        ("Pass through", "pass_through"),
        ("Destination", "destination"),
    ]

    var body: some View {
        Form {
            Section("Station") {
                TextField("Name", text: $stop.name)
                NavigationLink {
                    StationPickerView(stop: $stop, stations: network.stations)
                } label: {
                    Label("Choose from railway stations", systemImage: "tram.circle")
                }
                TextField("Station code", text: optionalText(\.n02StationCode))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                Picker("Type", selection: $stop.stopType) {
                    ForEach(types, id: \.1) { Text($0.0).tag($0.1) }
                }
                Toggle("Ridden segment", isOn: $stop.rideSegment)
            }
            Section("Time") {
                TextField("Arrival", text: optionalText(\.arrival), prompt: Text("HH:MM"))
                    .keyboardType(.numbersAndPunctuation)
                TextField("Departure", text: optionalText(\.departure), prompt: Text("HH:MM"))
                    .keyboardType(.numbersAndPunctuation)
            }
        }
        .navigationTitle(stop.name.isEmpty ? "Stop" : stop.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func optionalText(_ keyPath: WritableKeyPath<Stop, String?>) -> Binding<String> {
        Binding(
            get: { stop[keyPath: keyPath] ?? "" },
            set: { stop[keyPath: keyPath] = $0.isEmpty ? nil : $0 }
        )
    }
}

private struct StationPickerView: View {
    @Environment(\.dismiss) private var dismiss
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
            }
            .buttonStyle(.plain)
        }
        .navigationTitle("Choose station")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Station name or code")
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
