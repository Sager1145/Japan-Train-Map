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
    /// The sample a long-press asked to replace EVERYTHING with, held while
    /// the confirmation is up so the dialog can name it.
    @State private var replaceCandidate: RideLibrary.Sample?
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
            sampleRegionSections
            availabilitySection
            recoverySection
            dangerSection
        }
        .navigationTitle(localization.text("nav.data", fallback: "Data"))
        .sheet(isPresented: $showsImporter) {
            DataImportView(
                flow: flow, itineraries: itineraries, library: library)
        }
        .confirmationDialog(
            localization.text("sec.import", fallback: "Import"),
            isPresented: $showsImportChoice,
            titleVisibility: .visible
        ) {
            Button(localization.text("btn.openLocal", fallback: "Open JSON")) {
                showsImportChoice = false
                afterPresentationDismisses { importsFile = true }
            }
            Button(localization.text("sec.importPaste", fallback: "Paste JSON")) {
                showsImportChoice = false
                afterPresentationDismisses {
                    flow.load("", origin: .pasted)
                    showsImporter = true
                }
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
            defaultFilename: "train-store"
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
            rawPreview = rawPreviewExpanded ? (itineraries.exportJSON() ?? "") : ""
        }
    }

    // MARK: - §5.8 source hero

    private var sourceSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 14) {
                    Image(systemName: "person.crop.circle.fill")
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

                // One filled button per surface (§3.1). There is only one
                // thing to do next here now: everything on this screen acts on
                // the reader's own rides, so importing more of them is it.
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
                    itineraries.load(from: library)
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
                    library.save(store)
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
                guard let text = itineraries.exportJSON() else { return }
                exportDocument = TrainStoreDocument(text: text)
                exportsFile = true
            } label: {
                Label(
                    localization.text("btn.exportJson", fallback: "Export JSON"),
                    systemImage: "square.and.arrow.up")
            }
            .disabled(itineraries.store == nil)

            Button {
                guard let text = itineraries.exportJSON() else { return }
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
                library.save(store)
            } label: {
                Label(
                    localization.text("btn.saveAsMine", fallback: "Save current rides"),
                    systemImage: "square.and.arrow.down")
            }
            .disabled(itineraries.store == nil)

            Button {
                itineraries.load(from: library)
            } label: {
                Label(
                    localization.text("btn.restoreMine", fallback: "Restore saved rides"),
                    systemImage: "arrow.uturn.backward")
            }
            .disabled(!library.hasSavedStore)
        } header: {
            Text(localization.text("ios.myRides", fallback: "My rides"))
        } footer: {
            Text(localization.dataText("data.storageFootnote"))
        }
        .disabled(itineraries.isImporting)
    }

    /// The seven samples, grouped by the region each belongs to.
    ///
    /// **Loading one adds its rides to the working set.** In the web app the
    /// button replaces the store, because the store is one region's and the
    /// sample is that region's; with one merged store, replacing everything to
    /// see the Macao sample would delete the reader's Japanese rides. So a
    /// sample is folded in, a recovery copy is written first, and loading the
    /// same one twice updates those rides rather than duplicating them.
    ///
    /// The web app's 重置示例 — "this sample IS the store" — survives as the
    /// long-press action, where it has an unambiguous subject.
    private var sampleRegionSections: some View {
        ForEach(Region.ordered) { region in
            let samples = RideLibrary.Sample.forRegion(region)
            if !samples.isEmpty {
                Section {
                    ForEach(samples) { sample in
                        Button {
                            loadSample(sample, replacingEverything: false)
                        } label: {
                            Label(
                                localization.text(sample.titleKey, fallback: sample.title),
                                systemImage: library.loadedSamples.contains(sample.resource)
                                    ? "checkmark.circle" : "doc.text")
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                // A context menu is itself a presentation on
                                // iOS. Let its controller leave before asking
                                // SwiftUI for the confirmation dialog.
                                afterPresentationDismisses {
                                    replaceCandidate = sample
                                }
                            } label: {
                                Label(
                                    localization.text(
                                        "btn.resetDefaults", fallback: "Replace all rides"),
                                    systemImage: "arrow.counterclockwise")
                            }
                        }
                    }
                } header: {
                    Text(localization.text(region.localizationKey, fallback: region.fallbackName))
                } footer: {
                    if region == Region.ordered.last {
                        Text(localization.dataText("data.sampleFootnote"))
                    }
                }
            }
        }
        .disabled(itineraries.isImporting)
    }

    /// Fold a sample in, or — from the long-press action — make it the whole
    /// working set. Either way a recovery copy is written first, because both
    /// can overwrite rides the reader edited.
    private func loadSample(_ sample: RideLibrary.Sample, replacingEverything: Bool) {
        // A `Task` because both doors now place the incoming rides in their
        // region before they are published, and that reads a shipped dataset
        // for the four whose station codes do not say which region they are.
        // The read is off the main actor and the button is disabled while an
        // import runs, so the only thing this changes for the reader is that
        // a Macanese sample arrives already Macanese instead of arriving
        // Japanese and failing to solve.
        Task {
            do {
                let incoming = try library.sample(sample.resource)
                if let store = itineraries.store, !store.trains.isEmpty {
                    library.snapshotBackup(
                        store, reason: replacingEverything ? .beforeReplace : .beforeImport)
                }
                if replacingEverything {
                    library.forgetLoadedSamples()
                    await itineraries.replaceAll(with: incoming, into: library)
                } else {
                    await itineraries.merge(incoming, into: library)
                }
                library.noteSampleLoaded(sample.resource)
            } catch {
                operationError = OperationError(
                    titleKey: "data.loadFailedTitle",
                    detail: error.localizedDescription,
                    keptKey: "data.loadFailedKept")
            }
        }
    }

    // MARK: - §8.8 degradation

    @ViewBuilder
    private var availabilitySection: some View {
        if let network {
            Section {
                switch network.state {
                case .idle:
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(
                            localization.dataText(
                                "data.packageLoading",
                                ["region": .string(
                                    Region.ordered.map(regionName).joined(separator: "・"))]))
                    }
                case .loading(let pending):
                    HStack(spacing: 10) {
                        ProgressView()
                        // Named, because the five packages differ by three
                        // orders of magnitude and "still loading" says nothing
                        // about which one is holding the map up.
                        Text(
                            localization.dataText(
                                "data.packageLoading",
                                ["region": .string(
                                    pending.map(regionName).joined(separator: "・"))]))
                    }
                case .loaded(let regions, let failures, _):
                    ForEach(regions) { load in
                        Label(
                            localization.dataText(
                                "data.packageReady",
                                [
                                    "region": .string(regionName(load.region)),
                                    "count": .number(Double(load.lineCount)),
                                ]),
                            systemImage: "checkmark.circle")
                    }
                    // One package missing blocks that region's MAP. It does
                    // not block the records, and it does not block the other
                    // four regions either — which is the difference between a
                    // degraded app and a broken one.
                    ForEach(failures) { failure in
                        DataErrorCard(
                            title: localization.dataText(
                                "data.packageMissingTitle",
                                ["region": .string(regionName(failure.region))]),
                            detail: [
                                localization.dataText("data.packageMissingImpact"),
                                failure.message,
                            ].joined(separator: "\n"),
                            kept: localization.dataText("data.packageMissingKept"))
                    }
                    if !failures.isEmpty {
                        Button(localization.dataText("data.packageRetry")) {
                            network.loadAll()
                        }
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
                                    backup.created.formatted(
                                        Date.FormatStyle(date: .abbreviated, time: .shortened)
                                            .locale(localization.locale))),
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
                    library.discardBackup()
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
                    confirmRestore = false
                    afterPresentationDismisses {
                        do {
                            _ = try library.restoreBackup()
                            itineraries.load(from: library)
                        } catch {
                            operationError = OperationError(
                                titleKey: "data.loadFailedTitle",
                                detail: error.localizedDescription,
                                keptKey: "data.errorNothingChanged")
                        }
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
                confirmDeleteSaved = false
                afterPresentationDismisses {
                    if let store = itineraries.store {
                        library.snapshotBackup(store, reason: .beforeDeleteAll)
                    }
                    library.deleteSavedStore()
                    itineraries.load(from: library)
                }
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
                confirmDeleteAll = false
                afterPresentationDismisses {
                    if let store = itineraries.store {
                        library.snapshotBackup(store, reason: .beforeDeleteAll)
                    }
                    itineraries.deleteAll(clearing: library)
                    if let store = itineraries.store {
                        library.save(store)
                    }
                }
            }
        } message: {
            Text(
                localization.dataText(
                    "data.deleteAllScope",
                    ["region": .string(regionName), "count": .number(Double(trainCount))])
                    + "\n" + localization.dataText("data.deleteAllRecovery"))
        }
        // 重置示例, which now names WHICH sample rather than "the one this
        // region ships": the reader long-pressed a specific one, so the
        // dialog can say what it is about to become.
        .confirmationDialog(
            localization.text(
                "confirm.resetDefaults",
                fallback: "Replace the current journeys with the bundled sample?"),
            isPresented: Binding(
                get: { replaceCandidate != nil },
                set: { if !$0 { replaceCandidate = nil } }),
            titleVisibility: .visible
        ) {
            Button(
                localization.text("btn.resetDefaults", fallback: "Reset sample"),
                role: .destructive
            ) {
                let sample = replaceCandidate
                replaceCandidate = nil
                afterPresentationDismisses {
                    if let sample {
                        loadSample(sample, replacingEverything: true)
                    }
                }
            }
        } message: {
            Text(
                (replaceCandidate.map { localization.text($0.titleKey, fallback: $0.title) }
                    ?? "") + "\n" + localization.dataText("data.deleteAllRecovery"))
        }
    }

    /// UIKit dismisses menus and alert controllers asynchronously. Starting a
    /// sheet, importer, or store-driven rebuild from the action callback races
    /// that dismissal and produces "already presenting" warnings. Keep the
    /// action declarative, but publish its next state after the old controller
    /// has completed its transition.
    private func afterPresentationDismisses(_ action: @escaping @MainActor () -> Void) {
        PresentationHost.afterTeardown(action)
    }

    // MARK: - the sentences the hero says

    private var trainCount: Int { itineraries.loaded?.trains.count ?? 0 }

    private func regionName(_ region: Region) -> String {
        localization.text(region.localizationKey, fallback: region.fallbackName)
    }

    /// Which regions the working set actually holds — the sentence that used
    /// to be "you are looking at Japan", now that no region is being looked at
    /// in particular.
    private var regionName: String {
        let regions = itineraries.loaded?.regions ?? []
        guard !regions.isEmpty else {
            return localization.text("date.all", fallback: "All")
        }
        return regions.map(regionName).joined(separator: "・")
    }

    private var sourceTitle: String {
        localization.text("ios.myRides", fallback: "My rides")
    }

    private var sourceSubtitle: String {
        guard itineraries.loaded != nil else {
            return localization.dataText("data.readingJourneys")
        }
        let count: [String: Localization.Param] = ["count": .number(Double(trainCount))]
        guard library.hasSavedStore else {
            return localization.dataText("data.notSavedOnDevice", count)
        }
        let saved = localization.dataText("data.savedOnDevice", count)
        guard let date = library.savedStoreDate else { return saved }
        return saved + " · "
            + date.formatted(
                Date.FormatStyle(date: .abbreviated, time: .shortened)
                    .locale(localization.locale))
    }
}
