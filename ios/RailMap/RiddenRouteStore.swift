import Foundation
import Observation
import RailCore

/// Precomputed ridden geometry shipped by the main fork's progressive sample
/// datasets. Each part contains one canonical train plus the exact route
/// features produced by the web solver; the native map consumes those
/// coordinates directly and never invents a straight-line fallback.
@MainActor
@Observable
final class RiddenRouteStore {
    struct DrawnSegment: Sendable {
        let segmentIndex: Int
        let from: String?
        let to: String?
        /// Canonical WGS84 geometry used by the solver, cache and statistics.
        /// It must remain in the same datum as the region's edge index.
        let sourceCoordinates: [Coordinate]
        /// Geometry presented to MapKit. This differs for Taiwan, Hong Kong,
        /// Macao and Korea, where Apple's basemap is displaced to GCJ-02.
        let coordinates: [Coordinate]

        init(
            segmentIndex: Int, from: String?, to: String?,
            coordinates: [Coordinate], country: String
        ) {
            self.segmentIndex = segmentIndex
            self.from = from
            self.to = to
            sourceCoordinates = coordinates
            self.coordinates = AppleMapDatum.display(coordinates, country: country)
        }
    }

    /// What became of one journey's route, per journey rather than per store.
    ///
    /// The store used to answer this with a single bit — a ride was in `rides`
    /// or it was not — and that bit could not tell "drew everything" from
    /// "drew four of six and dropped the rest". `solveMissing` appended a ride
    /// `if !segments.isEmpty` and discarded every section that solved to
    /// nothing, so a partly-solved journey was indistinguishable from a whole
    /// one and the interface had nothing to warn anybody with.
    ///
    /// Nothing here ever invents geometry: `partial` and `unavailable` mean a
    /// stretch of railway was **not drawn**, never that a straight line stood
    /// in for it.
    enum RouteOutcome: Sendable, Equatable {
        /// Every section the journey asked for came back with geometry.
        case resolved
        /// Some did not. `unsolved` names them the way the reader wrote them,
        /// so the interface can say which stretch is missing rather than that
        /// something, somewhere, failed.
        case partial(solved: Int, expected: Int, unsolved: [SectionGap])
        /// Not one section solved. The record is untouched and still exports.
        case unavailable(expected: Int)

        var isResolved: Bool { self == .resolved }
    }

    /// One stretch that has no drawn railway, named by its own endpoints.
    struct SectionGap: Sendable, Equatable {
        let segmentIndex: Int
        let from: String?
        let to: String?
    }

    struct DrawnRide: Identifiable, Sendable {
        let id: String
        /// The service description drives journey-station level of detail:
        /// sparse high-speed and limited services reveal their calls before a
        /// dense local service does.
        let trainType: String?
        /// The region this ride was solved against — `"jp"`, `"tw"`, `"hk"`,
        /// `"mo"` or `"kr"`.
        ///
        /// Carried on the ride rather than looked up from the train, because
        /// the map is handed rides and not journeys: the ridden-line category
        /// filter classifies a drawn segment against its own region's N02 edge
        /// index, and picking the wrong region's index would not fail — it
        /// would answer, wrongly.
        let country: String
        let colorHex: String
        let visible: Bool
        let segments: [DrawnSegment]
        /// What became of the route. See ``RouteOutcome``.
        let route: RouteOutcome
        /// The journey's stops, in order, carrying the two fields the map
        /// cannot otherwise know: which calls were ridden (`rideSegment`) and
        /// which stations are rolled through rather than called at
        /// (`stopType`). Without them every drawn segment has to be assumed
        /// ridden and every section boundary assumed a call, and a
        /// pass-through drawn as a stop is a claim about the journey that the
        /// reader did not make.
        let stops: [Stop]
        /// The calendar days this itinerary touches and where it crosses them,
        /// so an overnight ride can draw the half that runs on the other day
        /// differently — `Dates.segmentDate(_:segmentIndex:)` maps a segment to
        /// its day.
        let daySpan: Dates.DaySpan
        var strokes: [[Coordinate]] { segments.map(\.coordinates) }
        var vertexCount: Int { strokes.reduce(0) { $0 + $1.count } }
    }

    enum LoadState {
        case idle
        case loading
        case loaded(rides: [DrawnRide])
        case failed(String)
    }

    private(set) var state: LoadState = .idle
    private(set) var rides: [DrawnRide] = []
    private var loadTask: Task<Void, Never>?

    /// Solve and draw every ride, whatever region each belongs to.
    ///
    /// The web app is handed one dataset and one country because it has one
    /// region open. Here each ride names its own region (`Train.region`), the
    /// pipeline groups by it, and the per-region resources — the sections
    /// file, the station table, the package, the route cache — are loaded once
    /// per region that actually has rides rather than once per app.
    func load(trains: [Train]) {
        loadTask?.cancel()
        state = .loading
        // The status centre is how the journey detail and the editor — neither
        // of which is handed this store — learn what became of a route. See
        // `RideStatusCenter` for why that is a published projection rather
        // than an initialiser argument.
        RideStatusCenter.shared.routeStore = self
        RideStatusCenter.shared.publish(phase: .loading)
        // Duplicate ids cannot survive `StoreOperations`, but a store merged
        // out of five files once could carry one, and a trap here would be a
        // crash on a data fault rather than a drawing of it.
        let wanted = Dictionary(trains.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let wantedIDs = trains.map(\.id)
        loadTask = Task {
            do {
                let decoded = try await Self.decode(wanted: wanted)
                try Task.checkCancellation()
                rides = decoded
                state = .loaded(rides: decoded)
                RideStatusCenter.shared.publish(
                    entries: Self.statusEntries(for: decoded, wanted: wantedIDs),
                    phase: .loaded)
            } catch is CancellationError {
                return
            } catch {
                rides = []
                state = .failed(error.localizedDescription)
                RideStatusCenter.shared.publish(
                    entries: [:], phase: .failed(error.localizedDescription))
            }
        }
    }

    func clear() {
        loadTask?.cancel()
        rides = []
        state = .idle
        RideStatusCenter.shared.clear()
    }

    /// Solve one journey's route again, in place (§8.4).
    ///
    /// The failure this guards against: the drawn line stops being a picture
    /// of the record it claims to be — OLD geometry under a NEW section list,
    /// which is worse than showing nothing. The shell's route key now covers
    /// the whole record, so a full reload would eventually correct it; this
    /// corrects the one journey the reader just rebuilt without waiting for
    /// the other two hundred to be read back.
    ///
    /// Nothing is deleted from the itinerary store here, and nothing is
    /// straight-lined: a journey whose new sections solve to nothing keeps its
    /// record and loses its strokes, which is what "unavailable" means.
    func resolve(_ train: Train) {
        let country = Region.resolved(train).code
        let id = train.id
        RideStatusCenter.shared.beginResolving(id)
        Task {
            let solved = await Task.detached(priority: .userInitiated) { () -> DrawnRide? in
                try? Self.resolveOne(train, country: country)
            }.value

            if let solved {
                if let index = rides.firstIndex(where: { $0.id == id }) {
                    rides[index] = solved
                } else {
                    rides.append(solved)
                }
            } else {
                rides.removeAll { $0.id == id }
            }
            if case .loaded = state { state = .loaded(rides: rides) }
            RideStatusCenter.shared.finishResolving(
                id,
                entry: solved.map {
                    RideStatusCenter.Entry(outcome: $0.route, drawnSegments: $0.segments.count)
                } ?? RideStatusCenter.Entry(outcome: .unavailable(expected: 0), drawnSegments: 0))
        }
    }

    /// One journey through the same cache-then-solve path a full load uses.
    ///
    /// `nil` means the journey asked for no sections at all, which the caller
    /// records as `unavailable(expected: 0)` rather than as silence.
    private nonisolated static func resolveOne(
        _ train: Train, country: String
    ) throws -> DrawnRide? {
        let cached = loadCached([train], country: country)
        if let ride = cached.rides.first { return ride }
        return try solveMissing(cached.missing, country: country).first
    }

    /// What each journey the load was asked about ended up with.
    ///
    /// A train that produced no `DrawnRide` at all is recorded as
    /// `unavailable(expected: 0)`: `solveMissing` skips a train whose
    /// canonical section list is empty, and leaving those absent would make
    /// "this journey has nothing to draw" indistinguishable from "this journey
    /// was never looked at".
    private nonisolated static func statusEntries(
        for rides: [DrawnRide], wanted: [String]
    ) -> [String: RideStatusCenter.Entry] {
        var entries: [String: RideStatusCenter.Entry] = [:]
        for ride in rides {
            entries[ride.id] = RideStatusCenter.Entry(
                outcome: ride.route, drawnSegments: ride.segments.count)
        }
        for id in wanted where entries[id] == nil {
            entries[id] = RideStatusCenter.Entry(
                outcome: .unavailable(expected: 0), drawnSegments: 0)
        }
        return entries
    }

    /// Cache, then the precomputed datasets, then solve — per region.
    ///
    /// The order is the reverse of the web app's, and the reason is the merged
    /// store. The web app reads its one dataset first because that dataset IS
    /// its store; here a reader can hold the 201-journey Japanese sample, the
    /// New Year loop and their own rides at once, so "which dataset?" has no
    /// single answer and scanning every candidate on every reload would decode
    /// 11 MB of parts to answer a question the on-disk cache has already
    /// answered. Rides that come out of a dataset are written into that cache,
    /// so the scan happens once per journey rather than once per load.
    private nonisolated static func decode(wanted: [String: Train]) async throws -> [DrawnRide] {
        var result: [DrawnRide] = []
        var unresolved: [Region: [Train]] = [:]
        for (region, trains) in Dictionary(grouping: wanted.values, by: Region.resolved) {
            let cached = loadCached(trains, country: region.code)
            result += cached.rides
            if !cached.missing.isEmpty { unresolved[region] = cached.missing }
        }

        for (region, trains) in unresolved {
            var missing = Dictionary(
                trains.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            for dataset in RideLibrary.routeDatasets(for: region) {
                if missing.isEmpty { break }
                let found = try datasetRides(
                    dataset: dataset, country: region.code, wanted: missing)
                for ride in found { missing.removeValue(forKey: ride.id) }
                result += found
            }
            if !missing.isEmpty {
                result += try solveMissing(Array(missing.values), country: region.code)
            }
        }
        return result
    }

    /// The rides one precomputed dataset can answer for.
    ///
    /// A part is accepted only when its train's route-cache digest matches the
    /// one in the store, which is what makes searching several datasets safe:
    /// geometry solved for another itinerary is rejected rather than drawn.
    private nonisolated static func datasetRides(
        dataset: String,
        country: String,
        wanted: [String: Train]
    ) throws -> [DrawnRide] {
        guard let manifestURL = Bundle.main.url(
            forResource: "manifest",
            withExtension: "json",
            subdirectory: dataset
        ) else { throw LoadError.missingManifest(dataset) }

        let manifest = try JSONDecoder().decode(
            Manifest.self,
            from: Data(contentsOf: manifestURL)
        )
        var result: [DrawnRide] = []
        result.reserveCapacity(min(manifest.parts.count, wanted.count))

        for name in manifest.parts {
            try Task.checkCancellation()
            guard let partURL = Bundle.main.url(
                forResource: name,
                withExtension: "json",
                subdirectory: dataset
            ) else { throw LoadError.missingPart(dataset, name) }
            let part = try JSONDecoder().decode(Part.self, from: Data(contentsOf: partURL))
            guard let train = wanted[part.train.id] else { continue }
            guard routeCacheDigest(train, country: country)
                    == routeCacheDigest(part.train, country: country) else { continue }
            let expectedTemplate = routeTemplateDigest(train, country: country)
            let matchingFeatures = part.route.features.filter { feature in
                guard let expectedTemplate else { return true }
                return feature.properties?.routeTemplateKey == expectedTemplate
            }
            let indicesAreAuthoritative = matchingFeatures
                .allSatisfy { $0.properties?.segmentIndex != nil }
            let segments = matchingFeatures.flatMap { feature in
                feature.geometry.strokes.enumerated().compactMap { pair -> DrawnSegment? in
                    let (partIndex, coordinates) = pair
                    guard coordinates.count >= 2 else { return nil }
                    return DrawnSegment(
                        segmentIndex: feature.properties?.segmentIndex ?? partIndex,
                        from: feature.properties?.from,
                        to: feature.properties?.to,
                        coordinates: coordinates,
                        country: country)
                }
            }
            guard !segments.isEmpty else { continue }
            let ride = drawnRide(
                train,
                country: country,
                segments: segments,
                expectedSections: canonicalSections(train, country: country),
                indicesAreAuthoritative: indicesAreAuthoritative)
            // Written into the same cache a solve writes to, so the next load
            // finds this journey without opening a dataset at all. That is
            // what keeps the dataset search a first-load cost rather than a
            // per-load one.
            try? saveCache(ride, train: train, country: country)
            result.append(ride)
        }
        return result
    }

    /// Build one drawn ride, deciding its ``RouteOutcome`` from which of the
    /// journey's sections actually came back with geometry.
    ///
    /// The outcome is *derived* rather than stored, which is why the on-disk
    /// route cache needed no new field and no version bump: a cached ride
    /// carries its segments' indices, and the sections it was solved for are
    /// recomputed from the train beside it. A stored copy would be a second
    /// answer that could disagree with the first.
    private nonisolated static func drawnRide(
        _ train: Train,
        country: String,
        segments: [DrawnSegment],
        expectedSections: [RouteSection],
        indicesAreAuthoritative: Bool = true
    ) -> DrawnRide {
        let expected = expectedSections.count
        let solved = Set(segments.map(\.segmentIndex))
        let unsolved: [SectionGap] = expectedSections.enumerated()
            .compactMap { index, section in
                solved.contains(index)
                    ? nil
                    : SectionGap(segmentIndex: index, from: section.from, to: section.to)
            }
        let outcome: RouteOutcome
        if expected == 0 || unsolved.isEmpty || !indicesAreAuthoritative {
            // `indicesAreAuthoritative` is false for a precomputed part whose
            // features carry no `segment_index`: there the index is the
            // stroke's position, which says nothing about which SECTION it
            // came from, and comparing it against the canonical sections would
            // manufacture gaps that are not there.
            outcome = .resolved
        } else if solved.isEmpty {
            outcome = .unavailable(expected: expected)
        } else {
            outcome = .partial(solved: solved.count, expected: expected, unsolved: unsolved)
        }
        return DrawnRide(
            id: train.id,
            trainType: train.trainType,
            country: country,
            colorHex: train.style?.color ?? "#0a84ff",
            visible: train.visible != false,
            segments: segments,
            route: outcome,
            stops: train.stops,
            daySpan: Dates.daySpan(train.forDates))
    }

    /// The canonical route sections a journey asks for — the same normalisation
    /// the solver and the cache digest run, so "expected" means the same thing
    /// in all three.
    private nonisolated static func canonicalSections(
        _ train: Train, country: String
    ) -> [RouteSection] {
        TrainValidation.normalizeExportTrain(
            train, country: country, stations: TrainValidation.StationTable.empty
        ).routeSections ?? []
    }

    private nonisolated static func solveMissing(
        _ trains: [Train], country: String
    ) throws -> [DrawnRide] {
        let suffix = country == "jp" ? "" : "-\(country)"
        guard let sectionsURL = Bundle.main.url(
            forResource: "rail-sections\(suffix)", withExtension: "json"),
              let stationsURL = Bundle.main.url(
                forResource: "stations\(suffix)", withExtension: "json")
        else { throw LoadError.missingSolverResources(country) }
        let sections = try RouteGraph.SectionFeatureCollection.load(contentsOf: sectionsURL).features
        let stationCollection = try Stations.FeatureCollection.load(contentsOf: stationsURL)
        let stationIndex = Stations.Index(stationCollection)
        let officialIntervals = RouteSolver.OfficialIntervalIndex(sections: sections)
        let displayNetwork: RouteNetwork? = {
            guard let url = Bundle.main.url(
                forResource: "\(country)-2025", withExtension: "json"),
                  let package = try? CompactPackage.load(contentsOf: url),
                  let topologies = try? DisplayParts.LineTopology.byLineID(contentsOf: url)
            else { return nil }
            return RouteNetwork(lines: package.lines.map { line in
                RouteNetwork.Line(
                    lineId: line.id, name: line.name, operator: line.operator,
                    isLoop: false, alignmentDirection: nil,
                    parts: DisplayParts.parts(
                        for: line, topology: topologies[line.id] ?? .init()))
            })
        }()
        let graphStore = RouteGraph.RouteGraphStore(sections: sections)
        graphStore.augment = { graph, bbox in
            let features: [Stations.Feature]
            if let bbox {
                features = stationCollection.features.filter { feature in
                    guard let pair = Stations.displayCoordinate(feature),
                          let coordinate = Coordinate(pair: pair) else { return false }
                    return coordinate.lon >= bbox.minX && coordinate.lon <= bbox.maxX
                        && coordinate.lat >= bbox.minY && coordinate.lat <= bbox.maxY
                }
            } else {
                features = stationCollection.features
            }
            RouteSolver.addStationTransferConnectorEdges(graph: graph, stations: features)
        }

        var rides: [DrawnRide] = []
        for train in trains {
            try Task.checkCancellation()
            let canonical = TrainValidation.normalizeExportTrain(
                train, country: country, stations: TrainValidation.StationTable.empty)
            let sections = canonical.routeSections ?? []
            guard !sections.isEmpty else { continue }
            let context = routeContext(train)
            let cacheTrain = RouteGraph.CacheKeyTrain(
                trainType: context.trainType, company: context.company,
                preferredLineNames: context.preferredLineNames,
                preferredOperatorNames: context.preferredOperatorNames,
                allowedInstitutionTypeCodes: context.allowedInstitutionTypeCodes,
                institutionFilterMode: context.institutionFilterMode)
            let allowedCodes = RouteGraph.allowedInstitutionTypeCodes(
                cacheTrain, country: country)
            var segments: [DrawnSegment] = []
            var lastSolvedIndex: Int?
            var continuity: Coordinate?
            var displayContinuity: Coordinate?
            var projectionCache = RouteProjectionCache()
            for (index, section) in sections.enumerated() {
                try Task.checkCancellation()
                let sharesBoundary = index > 0
                    && lastSolvedIndex == index - 1
                    && routeSectionBoundarySharesExplicitStop(sections[index - 1], section)
                let anchor = sharesBoundary ? continuity : nil
                let solved = RouteSolver.solveOfficialInterval(
                    section, segmentIndex: index, train: context, country: country,
                    allowedCodes: allowedCodes, intervalIndex: officialIntervals,
                    stations: stationIndex, continuityAnchor: anchor)
                    ?? RouteSolver.solveSectionOnDemand(
                        section, segmentIndex: index, train: context, country: country,
                        graphStore: graphStore, stations: stationIndex,
                        continuityAnchor: anchor)
                if let solved, solved.coordinates.count >= 2 {
                    let hints = RouteHints(
                        requiredLineNames: (section.lineNames ?? []).map(Optional.some),
                        preferredLineNames: context.preferredLineNames.map(Optional.some),
                        requiredOperatorNames: (section.operatorNames ?? []).map(Optional.some),
                        preferredOperatorNames: context.preferredOperatorNames.map(Optional.some))
                    let canonical = displayNetwork?.canonicalizeRouteFeature(
                        RouteFeature(
                            geometry: .lineString(solved.coordinates), hints: hints),
                        continueFrom: sharesBoundary ? displayContinuity : nil,
                        cache: &projectionCache)
                    let drawnCoordinates = canonical?.geometry.lines.first
                        ?? solved.coordinates
                    segments.append(DrawnSegment(
                        segmentIndex: index,
                        from: section.from ?? stationIndex.name(forCode: section.fromN02StationCode),
                        to: section.to ?? stationIndex.name(forCode: section.toN02StationCode),
                        coordinates: drawnCoordinates,
                        country: country))
                    lastSolvedIndex = index
                    continuity = solved.coordinates.last
                    displayContinuity = drawnCoordinates.last
                }
            }
            graphStore.trimRegionalGraphCache(target: RouteGraph.regionalGraphNodeBudget)
            // Emitted even when NOTHING solved. The old code appended only
            // `if !segments.isEmpty`, which is how a journey with no drawable
            // route became a journey the interface had never heard of — and a
            // ride that is absent cannot be told from a ride that is still
            // being solved. It is reported as `unavailable` instead.
            let ride = drawnRide(
                train, country: country, segments: segments, expectedSections: sections)
            rides.append(ride)
            if !segments.isEmpty { try? saveCache(ride, train: train, country: country) }
        }
        return rides
    }

    private nonisolated static func routeContext(_ train: Train) -> RouteSolver.TrainContext {
        .init(
            id: train.id, number: train.number, trainType: train.trainType ?? "",
            company: train.company ?? "", origin: train.origin,
            destination: train.destination,
            preferredLineNames: train.routePolicy?.preferredLineNames ?? [],
            preferredOperatorNames: train.routePolicy?.preferredOperatorNames ?? [],
            allowedInstitutionTypeCodes: train.routePolicy?.allowedInstitutionTypeCodes,
            institutionFilterMode: train.routePolicy?.institutionFilterMode ?? "soft")
    }

    private nonisolated static func routeTemplateDigest(
        _ train: Train, country: String
    ) -> String? {
        let canonical = TrainValidation.normalizeExportTrain(
            train, country: country, stations: TrainValidation.StationTable.empty)
        let canonicalSections = canonical.routeSections ?? []
        let sections: [RouteGraph.RouteSection] = canonicalSections.map { section in
            RouteGraph.RouteSection(
                from: section.from, to: section.to,
                fromStationCode: section.fromN02StationCode,
                toStationCode: section.toN02StationCode,
                lineNames: section.lineNames ?? [],
                operatorNames: section.operatorNames ?? [])
        }
        guard !sections.isEmpty else { return nil }
        return RouteGraph.keyDigest(RouteGraph.templateKey(sections: sections))
    }

    private nonisolated static func routeCacheDigest(
        _ train: Train, country: String
    ) -> String? {
        let canonical = TrainValidation.normalizeExportTrain(
            train, country: country, stations: TrainValidation.StationTable.empty)
        let canonicalSections = canonical.routeSections ?? []
        let sections = canonicalSections.map { section in
            RouteGraph.RouteSection(
                from: section.from, to: section.to,
                fromStationCode: section.fromN02StationCode,
                toStationCode: section.toN02StationCode,
                lineNames: section.lineNames ?? [],
                operatorNames: section.operatorNames ?? [])
        }
        let policy = canonical.routePolicy
        let cacheTrain = RouteGraph.CacheKeyTrain(
            trainType: canonical.trainType ?? "", company: canonical.company ?? "",
            preferredLineNames: policy?.preferredLineNames ?? [],
            preferredOperatorNames: policy?.preferredOperatorNames ?? [],
            allowedInstitutionTypeCodes: policy?.allowedInstitutionTypeCodes,
            institutionFilterMode: policy?.institutionFilterMode)
        guard let context = RouteGraph.solveContext(
            train: cacheTrain, routeSections: sections, country: country) else { return nil }
        return RouteGraph.keyDigest(context.cacheKey)
    }

    private nonisolated static func loadCached(
        _ trains: [Train], country: String
    ) -> (rides: [DrawnRide], missing: [Train]) {
        var rides: [DrawnRide] = []
        var missing: [Train] = []
        for train in trains {
            guard let digest = routeCacheDigest(train, country: country),
                  let data = try? Data(contentsOf: cacheURL(country: country, digest: digest)),
                  let cache = try? JSONDecoder().decode(RuntimeCache.self, from: data),
                  cache.version == RouteGraph.routeSolverCacheVersion,
                  cache.digest == digest
            else {
                missing.append(train)
                continue
            }
            let segments = cache.segments.compactMap { cached -> DrawnSegment? in
                let coordinates = cached.coordinates.compactMap(Coordinate.init(pair:))
                guard coordinates.count >= 2 else { return nil }
                return DrawnSegment(
                    segmentIndex: cached.segmentIndex, from: cached.from,
                    to: cached.to, coordinates: coordinates,
                    country: country)
            }
            if segments.isEmpty {
                missing.append(train)
            } else {
                rides.append(drawnRide(
                    train,
                    country: country,
                    segments: segments,
                    expectedSections: canonicalSections(train, country: country)))
            }
        }
        return (rides, missing)
    }

    private nonisolated static func saveCache(
        _ ride: DrawnRide, train: Train, country: String
    ) throws {
        guard let digest = routeCacheDigest(train, country: country) else { return }
        let directory = cacheDirectory(country: country)
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true)
        let cache = RuntimeCache(
            version: RouteGraph.routeSolverCacheVersion, digest: digest,
            segments: ride.segments.map {
                CachedSegment(
                    segmentIndex: $0.segmentIndex, from: $0.from, to: $0.to,
                    coordinates: $0.sourceCoordinates.map(\.pair))
            })
        try JSONEncoder().encode(cache).write(
            to: cacheURL(country: country, digest: digest), options: .atomic)
    }

    private nonisolated static func cacheURL(country: String, digest: String) -> URL {
        cacheDirectory(country: country).appending(path: "\(digest).json")
    }

    private nonisolated static func cacheDirectory(country: String) -> URL {
        let base = FileManager.default.urls(
            for: .cachesDirectory, in: .userDomainMask).first ?? URL.temporaryDirectory
        return base.appending(path: "RailMap/Routes/\(country)", directoryHint: .isDirectory)
    }

    private nonisolated static func routeSectionBoundarySharesExplicitStop(
        _ previous: RouteSection, _ next: RouteSection
    ) -> Bool {
        let previousCode = previous.toN02StationCode?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let nextCode = next.fromN02StationCode?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !previousCode.isEmpty, !nextCode.isEmpty { return previousCode == nextCode }
        let previousName = Stations.normalizeStationName(previous.to ?? "")
        let nextName = Stations.normalizeStationName(next.from ?? "")
        return !previousName.isEmpty && previousName == nextName
    }

    private struct Manifest: Decodable {
        let parts: [String]
    }

    private struct Part: Decodable {
        let train: Train
        let route: CachedRoute
    }

    private struct CachedRoute: Decodable {
        let features: [Feature]
    }

    private struct Feature: Decodable {
        let properties: Properties?
        let geometry: Geometry
    }

    private struct Properties: Decodable {
        let routeTemplateKey: String?
        let segmentIndex: Int?
        let from: String?
        let to: String?
        private enum CodingKeys: String, CodingKey {
            case routeTemplateKey = "route_template_key"
            case segmentIndex = "segment_index"
            case from, to
        }
    }

    private struct RuntimeCache: Codable {
        let version: String
        let digest: String
        let segments: [CachedSegment]
    }

    private struct CachedSegment: Codable {
        let segmentIndex: Int
        let from: String?
        let to: String?
        let coordinates: [[Double]]
    }

    private struct Geometry: Decodable {
        let strokes: [[Coordinate]]

        private enum CodingKeys: String, CodingKey { case type, coordinates }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            switch try container.decode(String.self, forKey: .type) {
            case "LineString":
                let raw = try container.decode([[Double]].self, forKey: .coordinates)
                strokes = [Self.coordinates(raw)]
            case "MultiLineString":
                let raw = try container.decode([[[Double]]].self, forKey: .coordinates)
                strokes = raw.map(Self.coordinates)
            default:
                strokes = []
            }
        }

        private static func coordinates(_ raw: [[Double]]) -> [Coordinate] {
            raw.compactMap { pair in
                guard pair.count >= 2, pair[0].isFinite, pair[1].isFinite else { return nil }
                return Coordinate(lon: pair[0], lat: pair[1])
            }
        }
    }

    enum LoadError: LocalizedError {
        case missingManifest(String)
        case missingPart(String, String)
        case missingSolverResources(String)

        var errorDescription: String? {
            switch self {
            case .missingManifest(let dataset):
                "\(dataset)/manifest.json is missing from the app bundle."
            case .missingPart(let dataset, let name):
                "\(dataset)/\(name).json is missing from the app bundle."
            case .missingSolverResources(let country):
                "Runtime solver resources for \(country) are missing from the app bundle."
            }
        }
    }
}
