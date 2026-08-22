import RailCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The 資料管理 workspace, answering §5.8's question first: **where does the
/// data on screen come from, and is it safely saved?**
///
/// The previous version of this screen opened with a list of buttons, and the
/// answer to that question was somewhere in the middle of it. The order here
/// is the spec's: source, then anything blocking, then the ordinary task
/// groups, then — separated by real space and folded shut — the operations
/// that destroy things.
struct DataManagerView: View {
    @Environment(AppLocalization.self) private var localization
    /// Optional so this view can be previewed and hosted outside the shell
    /// that publishes the network store; the availability section simply has
    /// nothing to report when it is absent.
    @Environment(RailNetworkStore.self) private var network: RailNetworkStore?
    @Bindable var itineraries: ItineraryStore
    @Bindable var library: RideLibrary
    let country: String

    @State private var flow = ImportFlow()
    @State private var showsImporter = false
    @State private var showsImportChoice = false
    @State private var importsFile = false
    @State private var exportsFile = false
    @State private var exportDocument = TrainStoreDocument()
    @State private var rawPreviewExpanded = false
    @State private var rawPreview = ""
    @State private var copied = false

    @State private var confirmDeleteSaved = false
    @State private var confirmDeleteAll = false
    @State private var confirmResetSample = false
    @State private var confirmRestore = false

    /// An error that blocks a task stays on the screen next to the thing it
    /// blocked, and is dismissed by the reader — not by a timer (§3.1).
    @State private var operationError: OperationError?

    struct OperationError: Identifiable {
        var id = UUID()
        var titleKey: String
        var detail: String
        var keptKey: String
    }

    var body: some View {
        List {
            sourceSection
            blockingSections
            importSection
            exportSection
            samplesSection
            availabilitySection
            recoverySection
            dangerSection
        }
        .navigationTitle(localization.text("nav.data", fallback: "Data"))
        .sheet(isPresented: $showsImporter) {
            DataImportView(
                flow: flow, itineraries: itineraries, library: library, country: country)
        }
        .confirmationDialog(
            localization.text("sec.import", fallback: "Import"),
            isPresented: $showsImportChoice,
            titleVisibility: .visible
        ) {
            Button(localization.text("btn.openLocal", fallback: "Open JSON")) {
                importsFile = true
            }
            Button(localization.text("sec.importPaste", fallback: "Paste JSON")) {
                flow.load("", origin: .pasted)
                showsImporter = true
            }
        }
        .fileImporter(isPresented: $importsFile, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                flow.load(
                    String(decoding: try Data(contentsOf: url), as: UTF8.self),
                    origin: .file(url.lastPathComponent))
                showsImporter = true
            } catch {
                operationError = OperationError(
                    titleKey: "data.errorImportTitle",
                    detail: error.localizedDescription,
                    keptKey: "data.errorNothingChanged")
            }
        }
        .fileExporter(
            isPresented: $exportsFile,
            document: exportDocument,
            contentType: .json,
            defaultFilename: "train-store-\(country)"
        ) { result in
            if case .failure(let error) = result {
                operationError = OperationError(
                    titleKey: "data.saveFailedTitle",
                    detail: error.localizedDescription,
                    keptKey: "data.errorNothingChanged")
            }
        }
        .onChange(of: rawPreviewExpanded) {
            // A national store is a megabyte of JSON. It is built when the
            // disclosure opens, and not before.
            rawPreview =
                rawPreviewExpanded ? (itineraries.exportJSON(country: country) ?? "") : ""
        }
    }

    // MARK: - §5.8 source hero

    private var sourceSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 14) {
                    Image(systemName: library.source.isMine ? "person.crop.circle.fill" : "eye")
                        .font(.title2)
                        .foregroundStyle(.tint)
                        .frame(width: 44, height: 44)
                        .background(Color.accentColor.opacity(0.1), in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(sourceTitle).font(.headline)
                        Text(sourceSubtitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)

                // One filled button per surface (§3.1): saving a sample as
                // your own is the thing to do next while previewing, and
                // importing is the thing to do next once it is yours.
                if library.source.isMine {
                    Button {
                        showsImportChoice = true
                    } label: {
                        Label(
                            localization.text("sec.import", fallback: "Import"),
                            systemImage: "square.and.arrow.down"
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(itineraries.isImporting)
                } else {
                    Button {
                        guard let store = itineraries.store else { return }
                        library.save(store, country: country)
                    } label: {
                        Label(
                            localization.text("btn.saveAsMine", fallback: "Save as my data"),
                            systemImage: "square.and.arrow.down"
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(itineraries.store == nil)
                }
            }
            .padding(.vertical, 6)
        } footer: {
            Text(localization.dataText("data.storageFootnote"))
        }
    }

    // MARK: - L0

    @ViewBuilder
    private var blockingSections: some View {
        // An import the reader has left running: the sheet can be dismissed
        // without cancelling it, and a store that is being replaced under you
        // has to say so on the screen you are actually looking at.
        if let summary = flow.committingSummary {
            Section {
                DataProgressSummaryView(summary: summary, visibility: flow.visibility) {
                    flow.cancel()
                }
            }
        }

        if case .failed(let message) = itineraries.state {
            Section {
                DataErrorCard(
                    title: localization.dataText("data.loadFailedTitle"),
                    detail: message,
                    kept: localization.dataText("data.loadFailedKept"))
                Button(localization.dataText("data.retryLoad")) {
                    itineraries.load(country: country, from: library)
                }
            }
        }

        if let saveError = library.lastSaveError {
            Section {
                DataErrorCard(
                    title: localization.dataText("data.saveFailedTitle"),
                    detail: saveError,
                    kept: localization.dataText("data.saveFailedKept"))
                Button(localization.dataText("data.saveRetry")) {
                    guard let store = itineraries.store else { return }
                    library.save(store, country: country)
                }
                .disabled(itineraries.store == nil)
            }
        }

        if let operationError {
            Section {
                DataErrorCard(
                    title: localization.dataText(operationError.titleKey),
                    detail: operationError.detail,
                    kept: localization.dataText(operationError.keptKey))
                Button(localization.dataText("data.dismiss")) {
                    self.operationError = nil
                }
            }
        }
    }

    // MARK: - import

    private var importSection: some View {
        Section {
            Button { importsFile = true } label: {
                Label(
                    localization.text("btn.openLocal", fallback: "Open JSON"),
                    systemImage: "folder")
            }
            Button {
                flow.load("", origin: .pasted)
                showsImporter = true
            } label: {
                Label(
                    localization.text("sec.importPaste", fallback: "Paste JSON text"),
                    systemImage: "doc.on.clipboard")
            }
        } header: {
            Text(localization.dataText("data.importGroup"))
        } footer: {
            Text(localization.dataText("data.preflightDateNote"))
        }
        .disabled(itineraries.isImporting)
    }

    // MARK: - export, in one task group with the raw preview

    private var exportSection: some View {
        Section {
            Button {
                guard let text = itineraries.exportJSON(country: country) else { return }
                exportDocument = TrainStoreDocument(text: text)
                exportsFile = true
            } label: {
                Label(
                    localization.text("btn.exportJson", fallback: "Export JSON"),
                    systemImage: "square.and.arrow.up")
            }
            .disabled(itineraries.store == nil)

            Button {
                guard let text = itineraries.exportJSON(country: country) else { return }
                UIPasteboard.general.string = text
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    copied = false
                }
            } label: {
                Label(
                    copied
                        ? localization.dataText("data.copied")
                        : localization.dataText("data.copyJSON"),
                    systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .disabled(itineraries.store == nil)

            // §5.8: the raw JSON preview is L4, and ships folded.
            DisclosureGroup(
                isExpanded: $rawPreviewExpanded,
                content: {
                    if rawPreview.isEmpty {
                        ProgressView()
                    } else {
                        Text(rawPreview.prefix(4000))
                            .font(.system(.caption2, design: .monospaced))
                            .textSelection(.enabled)
                        if rawPreview.count > 4000 {
                            Text(localization.dataText("data.previewTruncated"))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                },
                label: {
                    Text(localization.text("sec.rawPreview", fallback: "Raw JSON preview"))
                })
        } header: {
            Text(localization.dataText("data.exportGroup"))
        }
    }

    // MARK: - samples and the reader's own copy

    private var samplesSection: some View {
        Section {
            Button {
                guard let store = itineraries.store else { return }
                library.save(store, country: country)
            } label: {
                Label(
                    localization.text("btn.saveAsMine", fallback: "Save current rides"),
                    systemImage: "square.and.arrow.down")
            }
            .disabled(itineraries.store == nil)

            Button {
                library.use(.mine)
                itineraries.load(country: country, from: library)
            } label: {
                Label(
                    localization.text("btn.restoreMine", fallback: "Restore saved rides"),
                    systemImage: "arrow.uturn.backward")
            }
            .disabled(!library.hasSavedStore)

            ForEach(RideLibrary.Sample.forCountry(country)) { sample in
                Button {
                    library.use(.sample(sample.resource))
                    itineraries.load(country: country, from: library)
                } label: {
                    Label(
                        localization.text(sample.titleKey, fallback: sample.title),
                        systemImage: library.source == .sample(sample.resource)
                            ? "checkmark" : "doc.text")
                }
            }
        } header: {
            Text(localization.text("chip.sample", fallback: "Samples"))
        } footer: {
            Text(localization.dataText("data.sampleFootnote"))
        }
        .disabled(itineraries.isImporting)
    }

    // MARK: - §8.8 degradation

    @ViewBuilder
    private var availabilitySection: some View {
        if let network {
            Section {
                switch network.state {
                case .idle, .loading:
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(
                            localization.dataText(
                                "data.packageLoading", ["region": .string(regionName)]))
                    }
                case .loaded(_, let lines, _):
                    Label(
                        localization.dataText(
                            "data.packageReady",
                            [
                                "region": .string(regionName),
                                "count": .number(Double(lines.count)),
                            ]),
                        systemImage: "checkmark.circle")
                case .failed(let message):
                    // A missing network package blocks this region's MAP. It
                    // does not block the records, and saying so is the
                    // difference between a degraded app and a broken one.
                    DataErrorCard(
                        title: localization.dataText(
                            "data.packageMissingTitle", ["region": .string(regionName)]),
                        detail: [
                            localization.dataText("data.packageMissingImpact"), message,
                        ].joined(separator: "\n"),
                        kept: localization.dataText("data.packageMissingKept"))
                    Button(localization.dataText("data.packageRetry")) {
                        network.load(country: country)
                    }
                }
            } header: {
                Text(localization.dataText("data.availability"))
            }
        }
    }

    // MARK: - §8.6 recovery before confirmation

    /// Shown only when there is something to recover. §5.8 asks for the
    /// recovery path to be offered ahead of the destructive one, which it is:
    /// this sits directly above the danger zone, and every action in there
    /// writes the backup that puts this section on screen.
    @ViewBuilder
    private var recoverySection: some View {
        if let backup = library.backup {
            Section {
                VStack(alignment: .leading, spacing: 3) {
                    Text(
                        localization.dataText(
                            "data.backupAvailable",
                            [
                                "count": .number(Double(backup.trainCount)),
                                "time": .string(
                                    backup.created.formatted(date: .abbreviated, time: .shortened)),
                            ])
                    )
                    Text(localization.dataText(backup.reason.localizationKey))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                Button {
                    confirmRestore = true
                } label: {
                    Label(
                        localization.dataText("data.restoreBackup"),
                        systemImage: "clock.arrow.circlepath")
                }
                Button(role: .destructive) {
                    library.discardBackup(country: country)
                } label: {
                    Label(localization.dataText("data.discardBackup"), systemImage: "trash")
                }
            } header: {
                Text(localization.dataText("data.recovery"))
            }
            .disabled(itineraries.isImporting)
            .confirmationDialog(
                localization.dataText("data.restoreBackup"),
                isPresented: $confirmRestore,
                titleVisibility: .visible
            ) {
                Button(localization.dataText("data.restoreBackup")) {
                    do {
                        _ = try library.restoreBackup(country: country)
                        itineraries.load(country: country, from: library)
                    } catch {
                        operationError = OperationError(
                            titleKey: "data.loadFailedTitle",
                            detail: error.localizedDescription,
                            keptKey: "data.errorNothingChanged")
                    }
                }
            } message: {
                Text(
                    localization.dataText(
                        "data.restoreBackupDetail",
                        ["count": .number(Double(backup.trainCount))]))
            }
        }
    }

    // MARK: - §5.8 danger zone: folded, and set apart

    private var dangerSection: some View {
        Section {
            DisclosureGroup(localization.text("grp.danger", fallback: "Danger zone")) {
                Button(role: .destructive) { confirmDeleteSaved = true } label: {
                    Label(
                        localization.text("btn.clearStorage", fallback: "Delete saved rides"),
                        systemImage: "trash")
                }
                .disabled(!library.hasSavedStore)

                Button(role: .destructive) { confirmDeleteAll = true } label: {
                    Label(localization.dataText("data.deleteAllTitle"), systemImage: "trash.slash")
                }
                .disabled(trainCount == 0)

                Button(role: .destructive) { confirmResetSample = true } label: {
                    Label(
                        localization.text("btn.resetDefaults", fallback: "Reset to sample"),
                        systemImage: "arrow.counterclockwise")
                }
                .disabled(RideLibrary.Sample.forCountry(country).isEmpty)
            }
        }
        .listSectionSpacing(.custom(44))
        .disabled(itineraries.isImporting)
        .confirmationDialog(
            localization.text("btn.clearStorage", fallback: "Delete saved rides"),
            isPresented: $confirmDeleteSaved,
            titleVisibility: .visible
        ) {
            Button(
                localization.text("btn.clearStorage", fallback: "Delete saved rides"),
                role: .destructive
            ) {
                if let store = itineraries.store {
                    library.snapshotBackup(store, country: country, reason: .beforeDeleteAll)
                }
                library.deleteSavedStore(country: country)
                itineraries.load(country: country, from: library)
            }
        } message: {
            Text(
                localization.dataText(
                    "data.deleteSavedScope", ["region": .string(regionName)])
                    + "\n" + localization.dataText("data.deleteAllRecovery"))
        }
        .confirmationDialog(
            localization.dataText("data.deleteAllTitle"),
            isPresented: $confirmDeleteAll,
            titleVisibility: .visible
        ) {
            Button(localization.dataText("data.deleteAllTitle"), role: .destructive) {
                if let store = itineraries.store {
                    library.snapshotBackup(store, country: country, reason: .beforeDeleteAll)
                }
                itineraries.deleteAll(country: country)
                if let store = itineraries.store {
                    library.save(store, country: country)
                }
            }
        } message: {
            Text(
                localization.dataText(
                    "data.deleteAllScope",
                    ["region": .string(regionName), "count": .number(Double(trainCount))])
                    + "\n" + localization.dataText("data.deleteAllRecovery"))
        }
        .confirmationDialog(
            localization.text(
                "confirm.resetDefaults",
                fallback: "Replace the current journeys with the bundled sample?"),
            isPresented: $confirmResetSample,
            titleVisibility: .visible
        ) {
            Button(
                localization.text("btn.resetDefaults", fallback: "Reset sample"),
                role: .destructive
            ) {
                guard let sample = RideLibrary.Sample.forCountry(country).first else { return }
                if let store = itineraries.store {
                    library.snapshotBackup(store, country: country, reason: .beforeReplace)
                }
                library.use(.sample(sample.resource))
                itineraries.load(country: country, from: library)
            }
        } message: {
            Text(localization.dataText("data.deleteAllRecovery"))
        }
    }

    // MARK: - the sentences the hero says

    private var trainCount: Int { itineraries.loaded?.trains.count ?? 0 }

    private var regionName: String {
        localization.text("country.\(country)", fallback: country.uppercased())
    }

    private var sourceTitle: String {
        switch library.source {
        case .mine:
            localization.dataText("data.sourceMine", ["region": .string(regionName)])
        case .sample:
            localization.dataText("data.sourceSample")
        }
    }

    private var sourceSubtitle: String {
        guard itineraries.loaded != nil else {
            return localization.dataText("data.readingJourneys")
        }
        let count: [String: Localization.Param] = ["count": .number(Double(trainCount))]
        switch library.source {
        case .mine:
            guard library.hasSavedStore else {
                return localization.dataText("data.notSavedOnDevice", count)
            }
            let saved = localization.dataText("data.savedOnDevice", count)
            guard let date = library.savedStoreDate else { return saved }
            return saved + " · " + date.formatted(date: .abbreviated, time: .shortened)
        case .sample(let resource):
            let sample = RideLibrary.Sample.all.first { $0.resource == resource }
            let title =
                sample.map { localization.text($0.titleKey, fallback: $0.title) }
                ?? localization.text("chip.sample", fallback: "Sample")
            return title + " · " + localization.dataText("data.sampleSubtitle", count)
        }
    }
}
