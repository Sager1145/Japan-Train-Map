import RailCore
import SwiftUI

/// The import screen: choose, check, confirm, watch, and be told what happened.
///
/// The web app's paste box has two buttons — 驗證匯入 JSON and 開始載入／逐條匯入
/// — and the second one commits without ever showing what it is about to do.
/// The order here is the spec's (§8.7): parse and validate first, always;
/// show the scope and the mode; commit only from a screen that has already
/// said what will be added, replaced and kept.
struct DataImportView: View {
    @Environment(AppLocalization.self) private var localization
    @Environment(\.dismiss) private var dismiss
    @Bindable var flow: ImportFlow
    @Bindable var itineraries: ItineraryStore
    @Bindable var library: RideLibrary
    let country: String

    var body: some View {
        NavigationStack {
            Form {
                sourceSection
                if !flow.isRunning { modeSection }
                phaseSection
            }
            .navigationTitle(localization.text("sec.import", fallback: "Import"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localization.text("ios.cancel", fallback: "Cancel")) {
                        flow.cancel()
                        dismiss()
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { actionBar }
            .task {
                // A file the reader has just chosen needs no typing, so the
                // check starts by itself. Pasted text does not: checking on
                // every keystroke would report errors about a half-typed
                // document.
                if case .editing = flow.phase, flow.origin != .pasted, !flow.text.isEmpty {
                    flow.check(itineraries: itineraries, country: country)
                }
            }
        }
    }

    // MARK: - source

    @ViewBuilder
    private var sourceSection: some View {
        Section {
            switch flow.origin {
            case .file(let name):
                LabeledContent(localization.text("btn.openLocal", fallback: "Open JSON")) {
                    Text(name).lineLimit(2).multilineTextAlignment(.trailing)
                }
                DisclosureGroup(localization.text("sec.rawPreview", fallback: "Raw JSON preview")) {
                    Text(flow.text.prefix(4000))
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                    if flow.text.count > 4000 {
                        Text(localization.dataText("data.previewTruncated"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            case .pasted:
                TextEditor(text: $flow.text)
                    .font(.system(.footnote, design: .monospaced))
                    .frame(minHeight: 140)
                    .disabled(flow.isRunning)
                    .overlay(alignment: .topLeading) {
                        if flow.text.isEmpty {
                            Text(localization.dataText("data.pasteHint"))
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                                .padding(.top, 8)
                                .allowsHitTesting(false)
                        }
                    }
            }
        } header: {
            Text(localization.text("sec.importPaste", fallback: "JSON"))
        }
    }

    // MARK: - mode

    @ViewBuilder
    private var modeSection: some View {
        Section {
            Picker(localization.dataText("data.importMode"), selection: $flow.mode) {
                ForEach(ImportPreflight.Mode.allCases) { mode in
                    Text(localization.dataText(mode.titleKey)).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: flow.mode) {
                // A report is an answer about one mode. Changing the mode
                // makes it an answer to a question nobody asked any more.
                if flow.report != nil {
                    flow.check(itineraries: itineraries, country: country)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(
                    localization.dataText(
                        flow.mode.detailKey,
                        [
                            "kept": .number(Double(currentCount)),
                            "count": .number(Double(flow.report?.documentCount ?? 0)),
                        ])
                )
                if flow.mode == .append {
                    Text(
                        localization.dataText(
                            "data.appendIdRule", ["example": .string(renameExample)])
                    )
                    .foregroundStyle(.secondary)
                }
            }
            .font(.footnote)
            .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text(localization.dataText("data.importMode"))
        }
    }

    // MARK: - phases

    @ViewBuilder
    private var phaseSection: some View {
        switch flow.phase {
        case .editing:
            EmptyView()
        case .checking(let summary), .importing(let summary):
            Section {
                DataProgressSummaryView(summary: summary, visibility: flow.visibility) {
                    flow.cancel()
                }
                if case .importing = flow.phase {
                    Text(localization.dataText("data.stageInteractive"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        case .checked(let report):
            preflightSections(report)
        case .finished(let outcome):
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(
                            localization.dataText(
                                "data.importDone", ["count": .number(Double(outcome.imported))])
                        )
                        if outcome.renamed > 0 {
                            Text(
                                localization.dataText(
                                    "data.importDoneRenamed",
                                    ["count": .number(Double(outcome.renamed))])
                            )
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        }
                        Text(localization.dataText("data.routesLater"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
                if let saveError = outcome.saveError {
                    DataErrorCard(
                        title: localization.dataText("data.saveFailedTitle"),
                        detail: saveError,
                        kept: localization.dataText("data.saveFailedKept"))
                }
            }
        case .failed(let failure):
            Section {
                if failure.neutral {
                    Label(
                        localization.dataText("data.importCancelled"),
                        systemImage: "xmark.circle"
                    )
                    .foregroundStyle(.secondary)
                } else {
                    DataErrorCard(
                        title: localization.dataText("data.errorImportTitle"),
                        detail: failure.title,
                        kept: localization.dataText(
                            "data.errorKept", ["count": .number(Double(failure.keptCount))]))
                }
            }
        }
    }

    @ViewBuilder
    private func preflightSections(_ report: ImportPreflight.Report) -> some View {
        Section {
            LabeledContent(localization.dataText("data.preflightTarget")) {
                Text(regionName)
            }
            LabeledContent(localization.dataText("data.journeysInFile")) {
                Text(count(report.documentCount)).monospacedDigit()
            }
            if let schema = report.schemaVersion {
                LabeledContent(localization.dataText("data.schemaVersion")) {
                    Text(schema).monospacedDigit()
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(localization.dataText("data.preflightRegionNote", ["region": .string(regionName)]))
                Text(localization.dataText("data.preflightDateNote"))
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text(localization.dataText("data.preflight"))
        }

        Section {
            scopeRow("data.willAdd", report.added, emphasis: true)
            scopeRow("data.willReplace", report.replaced, emphasis: report.replaced > 0)
            scopeRow("data.willKeep", report.kept, emphasis: false)
            if !report.renames.isEmpty {
                DisclosureGroup {
                    ForEach(report.renames) { rename in
                        Text(
                            localization.dataText(
                                "data.renameList",
                                ["from": .string(rename.from), "to": .string(rename.to)])
                        )
                        .font(.system(.footnote, design: .monospaced))
                    }
                } label: {
                    scopeLabel("data.willRename", report.renames.count)
                }
            }
        }

        if !report.issues.isEmpty {
            Section {
                DataErrorCard(
                    title: localization.dataText("data.errorImportTitle"),
                    detail: localization.dataText(
                        "data.importBlocked", ["count": .number(Double(report.issues.count))]),
                    kept: localization.dataText(
                        "data.errorKept", ["count": .number(Double(currentCount))]))
                ForEach(report.issues.prefix(12)) { issue in
                    DataIssueRow(issue: issue)
                }
                if report.issues.count > 12 {
                    Text(
                        localization.dataText(
                            "data.moreIssues",
                            ["count": .number(Double(report.issues.count - 12))])
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            } header: {
                Text(localization.dataText("data.problems"))
            }
        }
    }

    @ViewBuilder
    private func scopeRow(_ key: String, _ value: Int, emphasis: Bool) -> some View {
        LabeledContent {
            Text(count(value))
                .monospacedDigit()
                .fontWeight(emphasis ? .semibold : .regular)
        } label: {
            Text(localization.dataText(key))
        }
    }

    private func scopeLabel(_ key: String, _ value: Int) -> some View {
        LabeledContent {
            Text(count(value)).monospacedDigit()
        } label: {
            Text(localization.dataText(key))
        }
    }

    // MARK: - the one prominent action

    @ViewBuilder
    private var actionBar: some View {
        VStack(spacing: 8) {
            switch flow.phase {
            case .editing:
                Button {
                    flow.check(itineraries: itineraries, country: country)
                } label: {
                    Text(localization.text("btn.validate", fallback: "Validate JSON"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(flow.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            case .checking, .importing:
                Button(role: .cancel) { flow.cancel() } label: {
                    Text(localization.text("ios.cancel", fallback: "Cancel"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            case .checked(let report):
                if report.isCommittable {
                    Button {
                        flow.commit(
                            itineraries: itineraries, library: library, country: country)
                    } label: {
                        Text(
                            localization.dataText(
                                "data.startImport", ["count": .number(Double(report.added))])
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    // §3.3: an import that failed its preflight gets no
                    // prominent button. Fixing the input is the action.
                    Button {
                        flow.check(itineraries: itineraries, country: country)
                    } label: {
                        Text(localization.dataText("data.recheck")).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            case .finished:
                Button { dismiss() } label: {
                    Text(localization.dataText("data.done"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            case .failed:
                Button {
                    flow.reset()
                } label: {
                    Text(localization.dataText("data.recheck")).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding()
        .background(.bar)
    }

    // MARK: - helpers

    private var currentCount: Int { itineraries.store?.trains.count ?? 0 }

    private var regionName: String {
        localization.text("country.\(country)", fallback: country.uppercased())
    }

    /// What a renamed id looks like, taken from the rule rather than invented:
    /// `makeUniqueTrainId` appends `-2`, `-3`, … to the base.
    private var renameExample: String {
        (itineraries.store?.trains.first?.id).map { "\($0)-2" } ?? "odr_001-2"
    }

    private func count(_ value: Int) -> String {
        value.formatted(.number.grouping(.never))
    }
}

/// §7.8 rendered: stage first, count second, cancel where it is safe.
struct DataProgressSummaryView: View {
    @Environment(AppLocalization.self) private var localization
    let summary: ProgressSummary
    let visibility: ProgressVisibility
    var onCancel: (() -> Void)?

    var body: some View {
        if case .quiet = visibility {
            // Under ~400 ms nothing is shown at all (§13.2). The row still
            // exists so the section does not resize when it appears.
            Color.clear.frame(height: 0)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(stageText)
                        .font(.subheadline.weight(.medium))
                        .monospacedDigit()
                    Spacer()
                    if summary.canCancel, let onCancel {
                        Button(localization.text("ios.cancel", fallback: "Cancel"), action: onCancel)
                            .font(.subheadline)
                    }
                }
                if showsQuantitative, let fraction = summary.fraction {
                    ProgressView(value: fraction)
                } else {
                    ProgressView().progressViewStyle(.linear)
                }
                if !summary.canInteract {
                    Text(localization.dataText("data.stageSaving"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(stageText)
        }
    }

    private var showsQuantitative: Bool {
        if case .quantitative = visibility { return summary.total != nil }
        return false
    }

    private var stageText: String {
        guard showsQuantitative, let completed = summary.completed, let total = summary.total
        else {
            return localization.dataText(summary.stage.plainKey)
        }
        return localization.dataText(
            summary.stage.countedKey,
            ["count": .number(Double(completed)), "total": .number(Double(total))])
    }
}

/// One problem, with the position §8.7 requires: a JSON path, a journey id, or
/// a stop number — whichever the document actually gives.
struct DataIssueRow: View {
    @Environment(AppLocalization.self) private var localization
    let issue: ImportPreflight.Issue

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(issue.detail)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Text(location)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var location: String {
        var parts: [String] = []
        if let path = issue.path {
            parts.append(localization.dataText("data.issueAt", ["path": .string(path)]))
        } else {
            parts.append(
                localization.dataText(
                    "data.issueAt",
                    ["path": .string(localization.dataText("data.issueDocumentRoot"))]))
        }
        if let id = issue.trainID, !id.isEmpty {
            parts.append(localization.dataText("data.issueTrainID", ["id": .string(id)]))
        }
        return parts.joined(separator: " · ")
    }
}

/// The §13.3 shape: what happened, what it affected, what was kept. The fourth
/// part — what to do next — is the surrounding screen's action bar, because
/// the actions belong to the state and not to the sentence.
struct DataErrorCard: View {
    let title: String
    let detail: String
    let kept: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            Text(detail)
                .font(.footnote)
            Text(kept)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
