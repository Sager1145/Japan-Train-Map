import RailCore
import SwiftUI
import UniformTypeIdentifiers

/// The 資料管理 workspace: where the rides come from, and how they leave.
struct DataManagerView: View {
    @Environment(AppLocalization.self) private var localization
    @Bindable var itineraries: ItineraryStore
    @Bindable var library: RideLibrary
    let country: String
    @State private var confirmDelete = false
    @State private var confirmDeleteAll = false
    @State private var confirmResetSample = false
    @State private var importsFile = false
    @State private var exportsFile = false
    @State private var showsPasteImporter = false
    @State private var exportDocument = TrainStoreDocument()
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Image(systemName: library.source.isMine ? "person.crop.circle.fill" : "doc.text.fill")
                        .font(.title2)
                        .foregroundStyle(.tint)
                        .frame(width: 44, height: 44)
                        .background(Color.accentColor.opacity(0.1), in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(currentSourceTitle).font(.headline)
                        Text(currentStoreSummary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 6)
                .accessibilityElement(children: .combine)
            }

            Section(localization.text("chip.sample", fallback: "Samples")) {
                ForEach(RideLibrary.Sample.forCountry(country)) { sample in
                    Button {
                        library.use(.sample(sample.resource))
                        itineraries.load(country: country, from: library)
                    } label: {
                        Label(sample.title, systemImage: "doc.text")
                    }
                }
            }

            Section {
                Button {
                    guard let store = itineraries.store else { return }
                    library.save(store, country: country)
                } label: {
                        Label(localization.text("btn.saveAsMine", fallback: "Save current rides"), systemImage: "square.and.arrow.down")
                }
                .disabled(itineraries.store == nil)

                Button {
                    library.use(.mine)
                    itineraries.load(country: country, from: library)
                } label: {
                        Label(localization.text("btn.restoreMine", fallback: "Restore saved rides"), systemImage: "arrow.uturn.backward")
                }
                .disabled(!library.hasSavedStore)

                Button(role: .destructive) { confirmDelete = true } label: {
                    Label(localization.text("btn.clearStorage", fallback: "Delete saved rides"), systemImage: "trash")
                }
                .disabled(!library.hasSavedStore)
            } header: {
                Text(localization.text("ios.myRides", fallback: "My rides"))
            } footer: {
                Text("Editing a sample creates a private saved copy; bundled samples are never overwritten.")
            }

            Section {
                Button { importsFile = true } label: {
                    Label(localization.text("btn.openLocal", fallback: "Open JSON"), systemImage: "folder")
                }
                Button { showsPasteImporter = true } label: {
                    Label(localization.text("sec.importPaste", fallback: "Paste and validate JSON"), systemImage: "doc.on.clipboard")
                }
                Button {
                    guard let text = itineraries.exportJSON(country: country) else { return }
                    exportDocument = TrainStoreDocument(text: text)
                    exportsFile = true
                } label: {
                    Label(localization.text("btn.exportJson", fallback: "Export JSON"), systemImage: "square.and.arrow.up")
                }
                .disabled(itineraries.store == nil)
            } header: {
                Text(localization.text("ios.files", fallback: "Files"))
            } footer: {
                Text("Imports are validated against schema 1.3 before replacing the current store.")
            }

            Section(localization.text("grp.danger", fallback: "Danger zone")) {
                Button(role: .destructive) { confirmDeleteAll = true } label: {
                    Label(localization.text("btn.deleteAll", fallback: "Delete all journeys"), systemImage: "trash.slash")
                }
                .disabled(itineraries.loaded?.trains.isEmpty != false)
                Button(role: .destructive) { confirmResetSample = true } label: {
                    Label(localization.text("btn.resetDefaults", fallback: "Reset to bundled sample"), systemImage: "arrow.counterclockwise")
                }
            }
        }
        .navigationTitle(localization.text("nav.data", fallback: "Data"))
        .confirmationDialog(
            "Delete the saved rides for this region?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete saved rides", role: .destructive) {
                library.deleteSavedStore(country: country)
                itineraries.load(country: country, from: library)
            }
        }
        .confirmationDialog(
            "Delete every journey in the current store?",
            isPresented: $confirmDeleteAll,
            titleVisibility: .visible
        ) {
            Button("Delete all journeys", role: .destructive) {
                itineraries.deleteAll(country: country)
                if let store = itineraries.store {
                    library.save(store, country: country)
                }
            }
        }
        .confirmationDialog(
            localization.text("confirm.resetDefaults", fallback: "Replace the current journeys with the bundled sample?"),
            isPresented: $confirmResetSample,
            titleVisibility: .visible
        ) {
            Button(localization.text("btn.resetDefaults", fallback: "Reset sample"), role: .destructive) {
                guard let sample = RideLibrary.Sample.forCountry(country).first else { return }
                library.use(.sample(sample.resource))
                itineraries.load(country: country, from: library)
            }
        }
        .fileImporter(isPresented: $importsFile, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                try importText(String(decoding: Data(contentsOf: url), as: UTF8.self))
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        .fileExporter(
            isPresented: $exportsFile,
            document: exportDocument,
            contentType: .json,
            defaultFilename: "train-store-\(country)"
        ) { result in
            if case .failure(let error) = result { errorMessage = error.localizedDescription }
        }
        .sheet(isPresented: $showsPasteImporter) {
            JSONImportView { try importText($0) }
        }
        .alert(
            "Data operation failed",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Unknown error")
        }
    }

    private func importText(_ text: String) throws {
        try itineraries.importJSON(text, country: country)
        library.use(.mine)
        if let store = itineraries.store { library.save(store, country: country) }
    }

    private var currentSourceTitle: String {
        switch library.source {
        case .mine:
            localization.text("ios.myRides", fallback: "My rides")
        case .sample(let resource):
            RideLibrary.Sample.all.first(where: { $0.resource == resource })?.title
                ?? localization.text("chip.sample", fallback: "Sample")
        }
    }

    private var currentStoreSummary: String {
        guard let loaded = itineraries.loaded else { return String(localized: "Reading journeys…") }
        return String(localized: "\(loaded.trains.count) journeys · \(loaded.days.count) days")
    }
}
