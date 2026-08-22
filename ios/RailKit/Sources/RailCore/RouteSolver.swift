import Foundation

/// The deterministic routing kernel from `app-route-solver.js` §29.
///
/// This file deliberately stops at graph-node paths. Station resolution,
/// endpoint completion and whole-train section assembly are separate layers;
/// keeping this kernel pure lets the JavaScript and Swift implementations run
/// over exactly the same graph and compare every chosen node and cost.
public enum RouteSolver {
    public static let stationSnapCostFactor = 4.0
    public static let nonPreferredInstitutionLengthFactor = 180.0
    public static let nonPreferredInstitutionEdgePenalty = 5_000.0
    public static let nonPreferredOperatorLengthFactor = 6.0
    public static let nonPreferredLineLengthFactor = 8.0
    public static let stationSnapMaxDistanceMeters = 500.0
    public static let nonPreferredStationSnapPenalty = 20_000.0
    public static let nonPreferredOperatorStationSnapPenalty = 12_000.0
    public static let nonPreferredLineStationSnapPenalty = 15_000.0

    public struct TrainPolicy: Sendable, Equatable {
        public var institutionFilterMode: String

        public init(institutionFilterMode: String = "soft") {
            self.institutionFilterMode = institutionFilterMode
        }
    }

    public struct TrainContext: Sendable, Equatable {
        public var id: String
        public var number: String
        public var trainType: String
        public var company: String
        public var origin: String
        public var destination: String
        public var preferredLineNames: [String]
        public var preferredOperatorNames: [String]
        public var allowedInstitutionTypeCodes: [String]?
        public var institutionFilterMode: String

        public init(
            id: String = "", number: String = "", trainType: String = "",
            company: String = "", origin: String = "", destination: String = "",
            preferredLineNames: [String] = [], preferredOperatorNames: [String] = [],
            allowedInstitutionTypeCodes: [String]? = nil,
            institutionFilterMode: String = "soft"
        ) {
            self.id = id
            self.number = number
            self.trainType = trainType
            self.company = company
            self.origin = origin
            self.destination = destination
            self.preferredLineNames = preferredLineNames
            self.preferredOperatorNames = preferredOperatorNames
            self.allowedInstitutionTypeCodes = allowedInstitutionTypeCodes
            self.institutionFilterMode = institutionFilterMode
        }

        public var policy: TrainPolicy { .init(institutionFilterMode: institutionFilterMode) }
    }

    public struct SegmentHints: Sendable, Equatable {
        public var preferredLines: Set<String>
        public var preferredOperators: Set<String>
        public var requiredLines: Set<String>
        public var requiredOperators: Set<String>
        public var requirePreferredInstitution: Bool
        public var explicitRequiredLines: Set<String>
        public var explicitRequiredOperators: Set<String>
        public var commonLines: Set<String>
        public var commonOperators: Set<String>
        public var allCommonLines: Set<String>
        public var allCommonOperators: Set<String>
        public var preferredInstitutionCommonLines: Set<String>
        public var preferredInstitutionCommonOperators: Set<String>
        public var fromLines: Set<String>
        public var toLines: Set<String>
        public var fromOperators: Set<String>
        public var toOperators: Set<String>
        public var fromPreferredLines: Set<String>
        public var toPreferredLines: Set<String>
        public var fromPreferredOperators: Set<String>
        public var toPreferredOperators: Set<String>
        public var solveMode: String

        public init(
            preferredLines: Set<String> = [],
            preferredOperators: Set<String> = [],
            requiredLines: Set<String> = [],
            requiredOperators: Set<String> = [],
            requirePreferredInstitution: Bool = false,
            explicitRequiredLines: Set<String> = [],
            explicitRequiredOperators: Set<String> = [],
            commonLines: Set<String> = [], commonOperators: Set<String> = [],
            allCommonLines: Set<String> = [], allCommonOperators: Set<String> = [],
            preferredInstitutionCommonLines: Set<String> = [],
            preferredInstitutionCommonOperators: Set<String> = [],
            fromLines: Set<String> = [], toLines: Set<String> = [],
            fromOperators: Set<String> = [], toOperators: Set<String> = [],
            fromPreferredLines: Set<String> = [], toPreferredLines: Set<String> = [],
            fromPreferredOperators: Set<String> = [], toPreferredOperators: Set<String> = [],
            solveMode: String = "base"
        ) {
            self.preferredLines = preferredLines
            self.preferredOperators = preferredOperators
            self.requiredLines = requiredLines
            self.requiredOperators = requiredOperators
            self.requirePreferredInstitution = requirePreferredInstitution
            self.explicitRequiredLines = explicitRequiredLines
            self.explicitRequiredOperators = explicitRequiredOperators
            self.commonLines = commonLines
            self.commonOperators = commonOperators
            self.allCommonLines = allCommonLines
            self.allCommonOperators = allCommonOperators
            self.preferredInstitutionCommonLines = preferredInstitutionCommonLines
            self.preferredInstitutionCommonOperators = preferredInstitutionCommonOperators
            self.fromLines = fromLines
            self.toLines = toLines
            self.fromOperators = fromOperators
            self.toOperators = toOperators
            self.fromPreferredLines = fromPreferredLines
            self.toPreferredLines = toPreferredLines
            self.fromPreferredOperators = fromPreferredOperators
            self.toPreferredOperators = toPreferredOperators
            self.solveMode = solveMode
        }
    }

    public struct Candidate: Sendable, Equatable {
        public var key: String
        public var distance: Double

        public init(key: String, distance: Double) {
            self.key = key
            self.distance = distance
        }
    }

    /// One station geometry snapped to one routable graph node.
    public struct StationNodeCandidate: Sendable, Equatable {
        public var key: String
        public var distance: Double
        public var score: Double
        public var hasPreferredInstitution: Bool
        public var stationIndex: Int

        public init(
            key: String, distance: Double, score: Double,
            hasPreferredInstitution: Bool, stationIndex: Int
        ) {
            self.key = key
            self.distance = distance
            self.score = score
            self.hasPreferredInstitution = hasPreferredInstitution
            self.stationIndex = stationIndex
        }
    }

    public struct SolvedTarget: Sendable, Equatable {
        public var targetKey: String
        public var sourceKey: String
        public var cost: Double
        public var pathKeys: [String]

        public init(targetKey: String, sourceKey: String, cost: Double, pathKeys: [String]) {
            self.targetKey = targetKey
            self.sourceKey = sourceKey
            self.cost = cost
            self.pathKeys = pathKeys
        }
    }

    public static func edgeHasPreferredInstitution(
        _ edge: RouteGraph.Edge, allowedCodes: [String]
    ) -> Bool {
        let allowed = Set(allowedCodes.filter { !$0.isEmpty })
        if allowed.isEmpty { return true }
        if let connector = edge.connector {
            if connector.institutionTypeCodes.isEmpty { return true }
            return connector.institutionTypeCodes.allSatisfy {
                $0.isEmpty || allowed.contains($0)
            }
        }
        if edge.institutionTypeCode.isEmpty { return true }
        return allowed.contains(edge.institutionTypeCode)
    }

    public static func stationMatchesPreferredInstitution(
        _ feature: Stations.Feature, allowedCodes: [String]
    ) -> Bool {
        let preferred = Set(allowedCodes.filter { !$0.isEmpty })
        if preferred.isEmpty { return true }
        let code = Stations.stationInstitutionTypeCode(feature)
        return code.isEmpty || preferred.contains(code)
    }

    public static func filterStationsByPreferredInstitution(
        _ indices: [Int], in index: Stations.Index, allowedCodes: [String]
    ) -> [Int] {
        indices.filter {
            stationMatchesPreferredInstitution(index.features[$0], allowedCodes: allowedCodes)
        }
    }

    public static func filterStationCandidatesNear(
        _ indices: [Int], referenceIndices: [Int], in index: Stations.Index,
        maxDistanceMeters: Double = 1_800
    ) -> [Int] {
        guard !indices.isEmpty, !referenceIndices.isEmpty else { return [] }
        return indices.filter { candidateIndex in
            guard let candidate = coordinate(Stations.displayCoordinate(
                index.features[candidateIndex])) else { return false }
            return referenceIndices.contains { referenceIndex in
                guard let reference = coordinate(Stations.displayCoordinate(
                    index.features[referenceIndex])) else { return false }
                return Geometry.distanceMeters(candidate, reference) <= maxDistanceMeters
            }
        }
    }

    /// Route-specific endpoint expansion. Source station codes identify one
    /// platform/line; a long-distance section may need a nearby same-name
    /// platform on the section's actual line, so that candidate is added while
    /// the exact-code station remains the fallback.
    public static func resolveRouteEndpointStationCandidates(
        _ endpoint: Stations.Query,
        in index: Stations.Index,
        allowedCodes: [String],
        sectionLineNames: [String]
    ) -> [Int] {
        let candidates = index.candidateIndices(for: endpoint)
        let name: String
        let code: String?
        switch endpoint {
        case .name(let value):
            name = value
            code = nil
        case .stop(let stop):
            name = Stations.stopName(stop)
            code = Stations.stopStationCode(stop)
        }
        guard !name.isEmpty, let code, !code.isEmpty, !candidates.isEmpty else {
            return candidates
        }

        let preferredCandidates = filterStationsByPreferredInstitution(
            candidates, in: index, allowedCodes: allowedCodes)
        let sameNameStop = Stations.Stop(name: name)
        let sameNameCandidates = index.candidateIndices(for: .stop(sameNameStop))
        let sameNamePreferred = filterStationsByPreferredInstitution(
            sameNameCandidates, in: index, allowedCodes: allowedCodes)
        let nearby = filterStationCandidatesNear(
            sameNamePreferred, referenceIndices: candidates, in: index)
        let sectionLines = Set(sectionLineNames)
        let additions = sectionLines.isEmpty ? nearby : nearby.filter {
            sectionLines.contains(Stations.stationLineName(index.features[$0]))
        }
        if !additions.isEmpty {
            return dedupeStationIndices(candidates + additions, in: index)
        }
        if !preferredCandidates.isEmpty { return candidates }
        if sameNamePreferred.isEmpty { return candidates }
        return dedupeStationIndices(candidates + sameNamePreferred, in: index)
    }

    /// Every graph-node candidate for one physical station record, scored by
    /// the exact station/line/operator/institution preference formula used by
    /// the browser solver.
    public static func stationCandidateGraphNodes(
        stationIndex: Int,
        stations: Stations.Index,
        graph: RouteGraph.Graph,
        hints: SegmentHints = SegmentHints(),
        allowedCodes: [String] = RouteGraph.defaultAllowedInstitutionTypeCodes
    ) -> [StationNodeCandidate] {
        let feature = stations.features[stationIndex]
        let sourceCoordinates = stationGeometryCoordinates(feature)
        let stationLine = Stations.stationLineName(feature)
        let stationOperator = Stations.stationOperator(feature)
        var byKey: [String: (candidate: StationNodeCandidate, order: Int)] = [:]
        var nextOrder = 0

        for source in sourceCoordinates {
            for nearest in RouteGraph.nearbyNodes(source, in: graph, radiusDeg: 0.006, limit: 160) {
                guard nearest.distance <= stationSnapMaxDistanceMeters,
                      let meta = graph.nodeMeta[nearest.key] else { continue }
                let preferredInstitution = graphNodeHasPreferredInstitution(
                    meta, allowedCodes: allowedCodes)
                if hints.requirePreferredInstitution && !preferredInstitution { continue }
                if !hints.requiredLines.isEmpty
                    && !RouteGraph.intersects(hints.requiredLines, meta.lineNames) { continue }
                if !hints.requiredOperators.isEmpty
                    && !RouteGraph.intersects(hints.requiredOperators, meta.operators) { continue }

                var score = nearest.distance
                if !stationLine.isEmpty && meta.lineNames.contains(stationLine) { score -= 40 }
                if !stationOperator.isEmpty && meta.operators.contains(stationOperator) { score -= 15 }
                if RouteGraph.intersects(hints.preferredLines, meta.lineNames) {
                    score -= 25
                } else if !hints.preferredLines.isEmpty {
                    score += nonPreferredLineStationSnapPenalty
                }
                if RouteGraph.intersects(hints.preferredOperators, meta.operators) {
                    score -= 10
                } else if !hints.preferredOperators.isEmpty {
                    score += nonPreferredOperatorStationSnapPenalty
                }
                if !preferredInstitution { score += nonPreferredStationSnapPenalty }

                let candidate = StationNodeCandidate(
                    key: nearest.key, distance: nearest.distance, score: score,
                    hasPreferredInstitution: preferredInstitution,
                    stationIndex: stationIndex)
                if let previous = byKey[nearest.key] {
                    if score < previous.candidate.score
                        || (score == previous.candidate.score
                            && nearest.distance < previous.candidate.distance)
                    {
                        byKey[nearest.key] = (candidate, previous.order)
                    }
                } else {
                    byKey[nearest.key] = (candidate, nextOrder)
                    nextOrder += 1
                }
            }
        }

        return byKey.values.sorted {
            if $0.candidate.score != $1.candidate.score {
                return $0.candidate.score < $1.candidate.score
            }
            if $0.candidate.distance != $1.candidate.distance {
                return $0.candidate.distance < $1.candidate.distance
            }
            return $0.order < $1.order
        }.prefix(16).map(\.candidate)
    }

    public static func collectStationCandidateGraphNodes(
        stationIndices: [Int],
        stations: Stations.Index,
        graph: RouteGraph.Graph,
        hints: SegmentHints,
        allowedCodes: [String]
    ) -> [StationNodeCandidate] {
        var byKey: [String: (candidate: StationNodeCandidate, order: Int)] = [:]
        var nextOrder = 0
        for stationIndex in stationIndices {
            for candidate in stationCandidateGraphNodes(
                stationIndex: stationIndex, stations: stations, graph: graph,
                hints: hints, allowedCodes: allowedCodes)
            {
                if let previous = byKey[candidate.key] {
                    if candidate.score < previous.candidate.score
                        || (candidate.score == previous.candidate.score
                            && candidate.distance < previous.candidate.distance)
                    {
                        byKey[candidate.key] = (candidate, previous.order)
                    }
                } else {
                    byKey[candidate.key] = (candidate, nextOrder)
                    nextOrder += 1
                }
            }
        }
        return byKey.values.sorted {
            if $0.candidate.score != $1.candidate.score {
                return $0.candidate.score < $1.candidate.score
            }
            if $0.candidate.distance != $1.candidate.distance {
                return $0.candidate.distance < $1.candidate.distance
            }
            return $0.order < $1.order
        }.map(\.candidate)
    }

    /// Adds the short, penalised platform-transfer edges that join physical
    /// platforms belonging to one station group. These are graph edges, not
    /// drawable railway geometry, and the institution list on each connector
    /// is what prevents a hard-filtered JR route from hopping onto a nearby
    /// subway/private platform.
    public static func addStationTransferConnectorEdges(
        graph: RouteGraph.Graph, stations: [Stations.Feature]
    ) {
        struct Info {
            var key: String
            var distance: Double
            var stationName: String
            var groupCode: String
            var institutionTypeCode: String
            var order: Int
        }
        struct GroupKey: Hashable { var units: [UInt16] }
        var groups: [GroupKey: [String: Info]] = [:]
        var groupOrder: [GroupKey] = []

        func key(for feature: Stations.Feature) -> GroupKey {
            if let code = Stations.stationGroupCode(feature), !code.isEmpty {
                return GroupKey(units: Array("group:\(code)".utf16))
            }
            let display = coordinate(Stations.displayCoordinate(feature))
                ?? Coordinate(lon: 0, lat: 0)
            let lon = JSNumber.round(display.lon * 10) / 10
            let lat = JSNumber.round(display.lat * 10) / 10
            let text = "name:\(Stations.stationName(feature) ?? "")@"
                + "\(JSNumber.string(lon)),\(JSNumber.string(lat))"
            return GroupKey(units: Array(text.utf16))
        }

        for feature in stations {
            let groupKey = key(for: feature)
            if groups[groupKey] == nil {
                groups[groupKey] = [:]
                groupOrder.append(groupKey)
            }
            let sources = stationGeometryCoordinates(feature)
            for source in sources {
                for nearest in RouteGraph.nearbyNodes(
                    source, in: graph, radiusDeg: 0.0035, limit: 30)
                where nearest.distance <= 520 {
                    let nextOrder = groups[groupKey]!.count
                    let info = Info(
                        key: nearest.key, distance: nearest.distance,
                        stationName: Stations.stationName(feature) ?? "",
                        groupCode: Stations.stationGroupCode(feature) ?? "",
                        institutionTypeCode: Stations.stationInstitutionTypeCode(feature),
                        order: nextOrder)
                    if let existing = groups[groupKey]![nearest.key] {
                        if nearest.distance < existing.distance {
                            var replacement = info
                            replacement.order = existing.order
                            groups[groupKey]![nearest.key] = replacement
                        }
                    } else {
                        groups[groupKey]![nearest.key] = info
                    }
                }
            }
        }

        var edgeKeys = Set<String>()
        for groupKey in groupOrder {
            let nodes = (groups[groupKey]?.values ?? Dictionary<String, Info>().values)
                .sorted {
                    $0.distance == $1.distance ? $0.order < $1.order : $0.distance < $1.distance
                }.prefix(24)
            guard nodes.count >= 2 else { continue }
            let values = Array(nodes)
            for i in 0..<(values.count - 1) {
                for j in (i + 1)..<values.count {
                    let a = values[i]
                    let b = values[j]
                    if a.key == b.key { continue }
                    let pairKey = jsSorted([a.key, b.key]).joined(separator: "|")
                    if edgeKeys.contains(pairKey) { continue }
                    guard let aCoordinate = graph.nodes[a.key],
                          let bCoordinate = graph.nodes[b.key] else { continue }
                    let gap = Geometry.distanceMeters(aCoordinate, bCoordinate)
                    if gap > 900 { continue }
                    edgeKeys.insert(pairKey)
                    var codes: [String] = []
                    for code in [a.institutionTypeCode, b.institutionTypeCode]
                    where !code.isEmpty && !codes.contains(code) { codes.append(code) }
                    let connector = RouteGraph.StationConnector(
                        institutionTypeCodes: codes,
                        stationName: a.stationName,
                        groupCode: a.groupCode)
                    let edge = RouteGraph.Edge(
                        to: b.key, length: max(gap + 180, 0.01),
                        institutionTypeCode: "", railwayClassCode: "",
                        lineName: "", operator: "", connector: connector)
                    graph.adjacency[a.key, default: []].append(edge)
                    var reverse = edge
                    reverse.to = a.key
                    graph.adjacency[b.key, default: []].append(reverse)
                }
            }
        }
    }

    public static func inferSectionRouteConstraints(
        section: RouteSection, train: TrainContext
    ) -> (lineNames: Set<String>, operatorNames: Set<String>) {
        let text = [
            train.id, train.number, train.trainType, train.company,
            train.origin, train.destination,
        ].map(normalizeRouteHintText).joined(separator: " ")
        var lines = Set<String>()
        var operators = Set<String>()

        if (text.contains("ソニック") || asciiCaseInsensitiveContains(text, "sonic"))
            && sectionHasAnyEndpoint(section, names: ["大分", "別府", "中津", "小倉"])
        {
            lines.insert("日豊線")
            operators.insert("九州旅客鉄道")
        }
        if text.contains("はるか") || asciiCaseInsensitiveContains(text, "haruka") {
            operators.insert("西日本旅客鉄道")
            if sectionHasEndpointPair(section, ["関西空港"], ["日根野"]) {
                lines.insert("関西空港線")
            } else if sectionHasEndpointPair(section, ["日根野"], ["天王寺"]) {
                lines.insert("阪和線")
            } else if sectionHasEndpointPair(section, ["天王寺"], ["大阪"]) {
                lines.insert("大阪環状線")
            } else if sectionHasEndpointPair(section, ["大阪"], ["新大阪"]) {
                lines.insert("東海道線")
            }
        }
        return (lines, operators)
    }

    public static func buildSegmentRouteHints(
        section: RouteSection,
        fromStationIndices: [Int],
        toStationIndices: [Int],
        stations: Stations.Index,
        train: TrainContext,
        country: String
    ) -> SegmentHints {
        let cacheTrain = RouteGraph.CacheKeyTrain(
            trainType: train.trainType,
            company: train.company,
            preferredLineNames: train.preferredLineNames,
            preferredOperatorNames: train.preferredOperatorNames,
            allowedInstitutionTypeCodes: train.allowedInstitutionTypeCodes,
            institutionFilterMode: train.institutionFilterMode)
        let allowedCodes = RouteGraph.allowedInstitutionTypeCodes(cacheTrain, country: country)
        var preferredLines = Set(train.preferredLineNames.filter { !$0.isEmpty })
        var preferredOperators = Set(train.preferredOperatorNames.filter { !$0.isEmpty })
        preferredOperators.formUnion(RouteGraph.derivedPreferredOperatorNames(
            company: train.company, country: country))

        let inferred = inferSectionRouteConstraints(section: section, train: train)
        var explicitLines = Set((section.lineNames ?? []).filter { !$0.isEmpty })
        explicitLines.formUnion(inferred.lineNames)
        var explicitOperators = Set((section.operatorNames ?? []).filter { !$0.isEmpty })
        explicitOperators.formUnion(inferred.operatorNames)
        preferredLines.formUnion(explicitLines)
        preferredOperators.formUnion(explicitOperators)

        let fromPreferred = preferredStationPool(
            fromStationIndices, stations: stations, allowedCodes: allowedCodes)
        let toPreferred = preferredStationPool(
            toStationIndices, stations: stations, allowedCodes: allowedCodes)
        let fromLines = stationSet(fromStationIndices, stations: stations, getter: Stations.stationLineName)
        let toLines = stationSet(toStationIndices, stations: stations, getter: Stations.stationLineName)
        let fromOperators = stationSet(fromStationIndices, stations: stations, getter: Stations.stationOperator)
        let toOperators = stationSet(toStationIndices, stations: stations, getter: Stations.stationOperator)
        let fromPreferredLines = stationSet(fromPreferred, stations: stations, getter: Stations.stationLineName)
        let toPreferredLines = stationSet(toPreferred, stations: stations, getter: Stations.stationLineName)
        let fromPreferredOperators = stationSet(fromPreferred, stations: stations, getter: Stations.stationOperator)
        let toPreferredOperators = stationSet(toPreferred, stations: stations, getter: Stations.stationOperator)

        let allCommonLines = fromLines.intersection(toLines)
        let allCommonOperators = fromOperators.intersection(toOperators)
        let preferredCommonLines = fromPreferredLines.intersection(toPreferredLines)
        let preferredCommonOperators = fromPreferredOperators.intersection(toPreferredOperators)
        let commonLines = preferredCommonLines.isEmpty ? allCommonLines : preferredCommonLines
        let commonOperators = preferredCommonOperators.isEmpty
            ? allCommonOperators : preferredCommonOperators
        preferredLines.formUnion(commonLines)
        preferredOperators.formUnion(commonOperators)
        if preferredLines.isEmpty, fromPreferredLines.count == 1 {
            preferredLines.formUnion(fromPreferredLines)
        }
        if preferredLines.isEmpty, toPreferredLines.count == 1 {
            preferredLines.formUnion(toPreferredLines)
        }
        if preferredOperators.isEmpty,
           fromPreferredOperators.count == 1, toPreferredOperators.count == 1,
           fromPreferredOperators.first == toPreferredOperators.first,
           let common = fromPreferredOperators.first
        {
            preferredOperators.insert(common)
        }

        return SegmentHints(
            preferredLines: preferredLines,
            preferredOperators: preferredOperators,
            requiredLines: explicitLines,
            requiredOperators: explicitOperators,
            explicitRequiredLines: explicitLines,
            explicitRequiredOperators: explicitOperators,
            commonLines: commonLines,
            commonOperators: commonOperators,
            allCommonLines: allCommonLines,
            allCommonOperators: allCommonOperators,
            preferredInstitutionCommonLines: preferredCommonLines,
            preferredInstitutionCommonOperators: preferredCommonOperators,
            fromLines: fromLines, toLines: toLines,
            fromOperators: fromOperators, toOperators: toOperators,
            fromPreferredLines: fromPreferredLines, toPreferredLines: toPreferredLines,
            fromPreferredOperators: fromPreferredOperators,
            toPreferredOperators: toPreferredOperators)
    }

    public static func buildSegmentRouteSolveAttempts(
        _ base: SegmentHints
    ) -> [SegmentHints] {
        var attempts: [SegmentHints] = []
        var keys = Set<String>()

        func push(
            lines: Set<String>? = nil, operators: Set<String>? = nil,
            preferredLines: Set<String>? = nil,
            preferredOperators: Set<String>? = nil,
            home: Bool, mode: String
        ) {
            var attempt = base
            if let lines { attempt.requiredLines = lines }
            if let operators { attempt.requiredOperators = operators }
            if let preferredLines { attempt.preferredLines = preferredLines }
            if let preferredOperators { attempt.preferredOperators = preferredOperators }
            attempt.requirePreferredInstitution = home
            attempt.solveMode = mode
            let key = [
                mode, home ? "home" : "soft",
                jsSorted(attempt.requiredLines).joined(separator: ","),
                jsSorted(attempt.requiredOperators).joined(separator: ","),
            ].joined(separator: "|")
            if keys.insert(key).inserted { attempts.append(attempt) }
        }

        let explicitLines = base.explicitRequiredLines
        let explicitOperators = base.explicitRequiredOperators
        if !explicitLines.isEmpty {
            push(lines: explicitLines, operators: explicitOperators, home: true,
                 mode: "explicit_section_route_required_home_institution")
            push(lines: explicitLines, operators: explicitOperators, home: false,
                 mode: "explicit_section_route_required_soft_institution")
            return attempts
        }
        if !explicitOperators.isEmpty {
            if !base.commonLines.isEmpty {
                push(lines: base.commonLines, operators: explicitOperators, home: true,
                     mode: "operator_pinned_common_line_required_home_institution")
                push(lines: base.commonLines, operators: explicitOperators, home: false,
                     mode: "operator_pinned_common_line_required_soft_institution")
            }
            push(lines: [], operators: explicitOperators, home: true,
                 mode: "explicit_operator_required_home_institution")
            push(lines: [], operators: explicitOperators, home: false,
                 mode: "explicit_operator_required_soft_institution")
            return attempts
        }
        if !base.commonLines.isEmpty, !base.commonOperators.isEmpty {
            push(lines: base.commonLines, operators: base.commonOperators, home: true,
                 mode: "common_line_and_operator_required_home_institution")
        }
        if !base.commonLines.isEmpty {
            push(lines: base.commonLines, operators: [], home: true,
                 mode: "common_line_required_home_institution")
        }
        if !base.commonOperators.isEmpty {
            push(lines: [], operators: base.commonOperators, home: true,
                 mode: "common_operator_required_home_institution")
        }
        push(home: true, mode: "home_institution_soft_line_operator_hints")
        if !base.commonLines.isEmpty {
            push(lines: base.commonLines, operators: [], home: false,
                 mode: "common_line_required_other_operator_fallback")
        }
        push(home: false, mode: (base.commonLines.isEmpty && base.commonOperators.isEmpty)
             ? "no_common_line_soft_fallback" : "soft_fallback_after_home_attempts")
        push(lines: [], operators: [], preferredLines: [], preferredOperators: [], home: true,
             mode: "institution_only_unbiased_fallback")
        return attempts
    }

    public struct SolvedSection: Sendable, Equatable {
        public var segmentIndex: Int
        public var fromStationIndex: Int
        public var toStationIndex: Int
        public var coordinates: [Coordinate]
        public var rawPathKeys: [String]
        public var hints: SegmentHints
        public var allowedInstitutionTypeCodes: [String]
        public var usedInstitutionTypeCodes: [String]
        public var snapFrom: Double
        public var snapTo: Double
        public var physicalLength: Double
        public var rawPhysicalLength: Double
        public var cost: Double
    }

    public struct OfficialIntervalIndex: Sendable {
        struct Record: Sendable {
            let featureIndex: Int
            let coordinates: [Coordinate]
            let lineName: String
            let operatorName: String
            let institutionTypeCode: String
            let reversed: Bool
        }
        let records: [String: [Record]]

        public init(sections: [RouteGraph.SectionFeature]) {
            var records: [String: [Record]] = [:]
            for (index, feature) in sections.enumerated() {
                guard feature.geometryType == "LineString", feature.lines.count == 1,
                      let coordinates = feature.lines.first, coordinates.count >= 2 else { continue }
                let line = normalizeRouteHintText(feature.properties.lineName)
                let operatorName = normalizeRouteHintText(feature.properties.operator)
                guard let first = coordinates.first, let last = coordinates.last else { continue }
                let forward = officialIntervalKey(
                    line: line, operatorName: operatorName, from: first, to: last)
                let reverse = officialIntervalKey(
                    line: line, operatorName: operatorName, from: last, to: first)
                if !forward.isEmpty {
                    records[forward, default: []].append(Record(
                        featureIndex: index, coordinates: coordinates, lineName: line,
                        operatorName: operatorName,
                        institutionTypeCode: feature.properties.institutionTypeCode,
                        reversed: false))
                }
                if !reverse.isEmpty {
                    records[reverse, default: []].append(Record(
                        featureIndex: index, coordinates: coordinates, lineName: line,
                        operatorName: operatorName,
                        institutionTypeCode: feature.properties.institutionTypeCode,
                        reversed: true))
                }
            }
            self.records = records
        }
    }

    /// Exact station-cut interval path for Taiwan, Hong Kong and Macao. It
    /// preserves ordered reversals and the six-decimal display geometry rather
    /// than allowing a shortest-path graph to jump across a switchback.
    public static func solveOfficialInterval(
        _ rawSection: RouteSection,
        segmentIndex: Int,
        train: TrainContext,
        country: String,
        allowedCodes: [String],
        intervalIndex: OfficialIntervalIndex,
        stations: Stations.Index,
        continuityAnchor: Coordinate? = nil
    ) -> SolvedSection? {
        guard ["tw", "hk", "mo"].contains(country) else { return nil }
        let requiredLines = normalizedHintValues(rawSection.lineNames ?? [])
        let requiredOperators = normalizedHintValues(rawSection.operatorNames ?? [])
        guard !requiredLines.isEmpty else { return nil }
        var section = rawSection
        if section.from?.isEmpty != false {
            section.from = stations.name(forCode: section.fromN02StationCode)
        }
        if section.to?.isEmpty != false {
            section.to = stations.name(forCode: section.toN02StationCode)
        }
        let fromStations = stations.candidateIndices(for: .stop(.init(
            name: section.from, n02StationCode: section.fromN02StationCode)))
        let toStations = stations.candidateIndices(for: .stop(.init(
            name: section.to, n02StationCode: section.toN02StationCode)))
        guard !fromStations.isEmpty, !toStations.isEmpty else { return nil }

        struct Identity: Hashable { let featureIndex: Int; let reversed: Bool }
        var identities = Set<Identity>()
        var matches: [OfficialIntervalIndex.Record] = []
        for line in requiredLines {
            let fromOnLine = fromStations.filter {
                let feature = stations.features[$0]
                return Stations.stationLineName(feature) == line
                    && (requiredOperators.isEmpty
                        || requiredOperators.contains(Stations.stationOperator(feature)))
            }
            let toOnLine = toStations.filter {
                let feature = stations.features[$0]
                return Stations.stationLineName(feature) == line
                    && (requiredOperators.isEmpty
                        || requiredOperators.contains(Stations.stationOperator(feature)))
            }
            for from in fromOnLine {
                for to in toOnLine {
                    let fromOperator = Stations.stationOperator(stations.features[from])
                    let toOperator = Stations.stationOperator(stations.features[to])
                    guard !fromOperator.isEmpty, fromOperator == toOperator,
                          requiredOperators.isEmpty || requiredOperators.contains(fromOperator),
                          let fromCoordinate = coordinate(Stations.displayCoordinate(stations.features[from])),
                          let toCoordinate = coordinate(Stations.displayCoordinate(stations.features[to]))
                    else { continue }
                    let key = officialIntervalKey(
                        line: line, operatorName: fromOperator,
                        from: fromCoordinate, to: toCoordinate)
                    for record in intervalIndex.records[key] ?? [] {
                        if identities.insert(.init(
                            featureIndex: record.featureIndex, reversed: record.reversed)).inserted
                        {
                            matches.append(record)
                        }
                    }
                }
            }
        }
        guard matches.count == 1 else { return nil }
        let match = matches[0]
        if train.institutionFilterMode == "hard", !allowedCodes.isEmpty,
           !match.institutionTypeCode.isEmpty,
           !allowedCodes.contains(match.institutionTypeCode) { return nil }
        let coordinates = match.reversed ? Array(match.coordinates.reversed()) : match.coordinates
        guard let first = coordinates.first else { return nil }
        if let continuityAnchor,
           Geometry.distanceMeters(continuityAnchor, first) > 60 { return nil }
        let length = pathLength(for: coordinates)
        var preferredLines = Set(normalizedHintValues(train.preferredLineNames + requiredLines))
        preferredLines.formUnion(requiredLines)
        var preferredOperators = Set(normalizedHintValues(
            train.preferredOperatorNames
                + RouteGraph.derivedPreferredOperatorNames(
                    company: train.company, country: country)
                + [match.operatorName]))
        preferredOperators.formUnion(requiredOperators)
        let hints = SegmentHints(
            preferredLines: preferredLines, preferredOperators: preferredOperators,
            requiredLines: Set(requiredLines), requiredOperators: Set(requiredOperators),
            solveMode: "official_interval_exact")
        return SolvedSection(
            segmentIndex: segmentIndex,
            fromStationIndex: fromStations[0], toStationIndex: toStations[0],
            coordinates: coordinates, rawPathKeys: coordinates.map(Grid.coordKey),
            hints: hints, allowedInstitutionTypeCodes: allowedCodes,
            usedInstitutionTypeCodes: match.institutionTypeCode.isEmpty
                ? [] : [match.institutionTypeCode],
            snapFrom: 0, snapTo: 0, physicalLength: length,
            rawPhysicalLength: length, cost: length)
    }

    /// Solve one itinerary section, including station expansion, candidate
    /// snapping, ordered hint fallbacks, detour rejection and endpoint
    /// completion. A nil result means no real rail geometry connected the two
    /// endpoints; it never manufactures a straight-line fallback.
    public static func solveSection(
        _ rawSection: RouteSection,
        segmentIndex: Int,
        train: TrainContext,
        country: String,
        graph: RouteGraph.Graph,
        stations: Stations.Index,
        continuityAnchor: Coordinate? = nil
    ) -> SolvedSection? {
        var section = rawSection
        if section.from?.isEmpty != false {
            section.from = stations.name(forCode: section.fromN02StationCode)
        }
        if section.to?.isEmpty != false {
            section.to = stations.name(forCode: section.toN02StationCode)
        }
        let cacheTrain = RouteGraph.CacheKeyTrain(
            trainType: train.trainType, company: train.company,
            preferredLineNames: train.preferredLineNames,
            preferredOperatorNames: train.preferredOperatorNames,
            allowedInstitutionTypeCodes: train.allowedInstitutionTypeCodes,
            institutionFilterMode: train.institutionFilterMode)
        let allowedCodes = RouteGraph.allowedInstitutionTypeCodes(cacheTrain, country: country)
        let lineNames = (section.lineNames ?? []).filter { !$0.isEmpty }
        let fromStop = Stations.Stop(
            name: section.from, n02StationCode: section.fromN02StationCode)
        let toStop = Stations.Stop(
            name: section.to, n02StationCode: section.toN02StationCode)
        let fromStations = resolveRouteEndpointStationCandidates(
            .stop(fromStop), in: stations, allowedCodes: allowedCodes,
            sectionLineNames: lineNames)
        let toStations = resolveRouteEndpointStationCandidates(
            .stop(toStop), in: stations, allowedCodes: allowedCodes,
            sectionLineNames: lineNames)
        guard !fromStations.isEmpty, !toStations.isEmpty else { return nil }

        let baseHints = buildSegmentRouteHints(
            section: section,
            fromStationIndices: fromStations,
            toStationIndices: toStations,
            stations: stations, train: train, country: country)

        struct Best {
            var pathKeys: [String]
            var scoredCost: Double
            var totalCost: Double
            var physicalLength: Double
            var from: StationNodeCandidate
            var to: StationNodeCandidate
            var hints: SegmentHints
        }
        var best: Best?
        for hints in buildSegmentRouteSolveAttempts(baseHints) {
            var fromCandidates = Array(collectStationCandidateGraphNodes(
                stationIndices: fromStations, stations: stations, graph: graph,
                hints: hints, allowedCodes: allowedCodes).prefix(12))
            if let continuityAnchor {
                let continuous = fromCandidates.filter {
                    guard let stationCoordinate = coordinate(Stations.displayCoordinate(
                        stations.features[$0.stationIndex])) else { return false }
                    return Geometry.distanceMeters(stationCoordinate, continuityAnchor) <= 60
                }
                if !continuous.isEmpty { fromCandidates = continuous }
            }
            let toCandidates = Array(collectStationCandidateGraphNodes(
                stationIndices: toStations, stations: stations, graph: graph,
                hints: hints, allowedCodes: allowedCodes).prefix(12))
            guard !fromCandidates.isEmpty, !toCandidates.isEmpty else { continue }
            let fromByKey = Dictionary(uniqueKeysWithValues: fromCandidates.map { ($0.key, $0) })
            let toByKey = Dictionary(uniqueKeysWithValues: toCandidates.map { ($0.key, $0) })
            let solved = dijkstra(
                graph: graph,
                sourceCandidates: fromCandidates.map { .init(key: $0.key, distance: $0.distance) },
                targetKeys: Set(toByKey.keys), train: train.policy,
                allowedCodes: allowedCodes, hints: hints)
            var attemptBest: Best?
            for result in solved where result.pathKeys.count >= 2 {
                guard let from = fromByKey[result.sourceKey],
                      let to = toByKey[result.targetKey],
                      let fromCoord = graph.nodes[from.key], let toCoord = graph.nodes[to.key]
                else { continue }
                let straight = Geometry.distanceMeters(fromCoord, toCoord)
                let physicalLength = pathLengthMeters(graph: graph, pathKeys: result.pathKeys)
                let detourLimit = max(straight * 3.8 + 6_000, 12_000)
                if straight > 1_500 && physicalLength > detourLimit { continue }
                let snapPenalty = (from.distance + to.distance) * stationSnapCostFactor
                let totalCost = result.cost + snapPenalty
                let scoredCost = totalCost + routeLineMismatchPenalty(
                    graph: graph, pathKeys: result.pathKeys, hints: hints)
                if attemptBest == nil || scoredCost < attemptBest!.scoredCost {
                    attemptBest = Best(
                        pathKeys: result.pathKeys, scoredCost: scoredCost,
                        totalCost: totalCost, physicalLength: physicalLength,
                        from: from, to: to, hints: hints)
                }
            }
            if let attemptBest {
                best = attemptBest
                break
            }
        }
        guard let best else { return nil }
        let rawCoordinates = best.pathKeys.compactMap { graph.nodes[$0] }
        guard rawCoordinates.count == best.pathKeys.count else { return nil }
        var coordinates = completeRouteEndpointCoordinates(
            rawCoordinates,
            fromStation: stations.features[best.from.stationIndex],
            toStation: stations.features[best.to.stationIndex])
        if let continuityAnchor, let first = coordinates.first,
           Geometry.distanceMeters(continuityAnchor, first) <= 60
        {
            if coordinatesClose(continuityAnchor, first, toleranceMeters: 0.25) {
                coordinates = [continuityAnchor] + coordinates.dropFirst()
            } else {
                coordinates.insert(continuityAnchor, at: 0)
            }
        }
        return SolvedSection(
            segmentIndex: segmentIndex,
            fromStationIndex: best.from.stationIndex,
            toStationIndex: best.to.stationIndex,
            coordinates: coordinates,
            rawPathKeys: best.pathKeys,
            hints: best.hints,
            allowedInstitutionTypeCodes: allowedCodes,
            usedInstitutionTypeCodes: usedInstitutionTypeCodes(
                graph: graph, pathKeys: best.pathKeys),
            snapFrom: best.from.distance, snapTo: best.to.distance,
            physicalLength: pathLength(for: coordinates),
            rawPhysicalLength: best.physicalLength,
            cost: best.totalCost)
    }

    public static func solveSectionOnDemand(
        _ section: RouteSection,
        segmentIndex: Int,
        train: TrainContext,
        country: String,
        graphStore: RouteGraph.RouteGraphStore,
        stations: Stations.Index,
        continuityAnchor: Coordinate? = nil
    ) -> SolvedSection? {
        guard let bbox = sectionEndpointBBox(
            section, train: train, country: country, stations: stations)
        else {
            return solveSection(
                section, segmentIndex: segmentIndex, train: train, country: country,
                graph: graphStore.fullGraph(), stations: stations,
                continuityAnchor: continuityAnchor)
        }
        let straight = RouteGraph.bboxDiagonalMeters(bbox)
        let margins = [max(30_000, straight * 0.6), max(90_000, straight * 1.5)]
        var lastResult: SolvedSection?
        for margin in margins {
            let graph = graphStore.regionalGraph(
                for: RouteGraph.padBBoxMeters(bbox, meters: margin),
                routeSolveInProgress: true)
            if let result = solveSection(
                section, segmentIndex: segmentIndex, train: train, country: country,
                graph: graph, stations: stations, continuityAnchor: continuityAnchor)
            {
                lastResult = result
                if !RouteGraph.pathTouchesRegionEdge(
                    lines: [result.coordinates], regionBBox: graph.regionBBox, marginDeg: 0.02)
                {
                    return result
                }
            }
        }
        return solveSection(
            section, segmentIndex: segmentIndex, train: train, country: country,
            graph: graphStore.fullGraph(), stations: stations,
            continuityAnchor: continuityAnchor) ?? lastResult
    }

    public static func completeRouteEndpointCoordinates(
        _ coordinates: [Coordinate],
        fromStation: Stations.Feature,
        toStation: Stations.Feature
    ) -> [Coordinate] {
        guard coordinates.count >= 2 else { return coordinates }
        let startTrimmed = trimRouteEndpointToStationDisplay(
            coordinates, station: fromStation, isStart: true)
        return trimRouteEndpointToStationDisplay(
            startTrimmed, station: toStation, isStart: false)
    }

    public static func pathLength(for coordinates: [Coordinate]) -> Double {
        guard coordinates.count >= 2 else { return 0 }
        return zip(coordinates, coordinates.dropFirst()).reduce(0) {
            $0 + Geometry.distanceMeters($1.0, $1.1)
        }
    }

    public static func edgeMatchesAllowedCodes(
        _ edge: RouteGraph.Edge,
        allowedCodes: [String],
        train: TrainPolicy,
        hints: SegmentHints = SegmentHints()
    ) -> Bool {
        let hardFilter = train.institutionFilterMode == "hard"
            || hints.requirePreferredInstitution
        return !hardFilter || edgeHasPreferredInstitution(edge, allowedCodes: allowedCodes)
    }

    public static func institutionPreferencePenalty(
        for edge: RouteGraph.Edge, allowedCodes: [String], train: TrainPolicy
    ) -> Double {
        if train.institutionFilterMode == "hard" { return 0 }
        let preferred = Set(allowedCodes.filter { !$0.isEmpty })
        if preferred.isEmpty || edge.institutionTypeCode.isEmpty
            || preferred.contains(edge.institutionTypeCode)
        {
            return 0
        }
        return edge.length * nonPreferredInstitutionLengthFactor
            + nonPreferredInstitutionEdgePenalty
    }

    public static func edgeMatchesRequiredHints(
        _ edge: RouteGraph.Edge, hints: SegmentHints
    ) -> Bool {
        if edge.connector != nil { return true }
        if !hints.requiredLines.isEmpty && !hints.requiredLines.contains(edge.lineName) {
            return false
        }
        if !hints.requiredOperators.isEmpty
            && !hints.requiredOperators.contains(edge.operator)
        {
            return false
        }
        return true
    }

    public static func nonPreferredLineOperatorPenalty(
        for edge: RouteGraph.Edge,
        preferredLines: Set<String>,
        preferredOperators: Set<String>
    ) -> Double {
        var penalty = 0.0
        if !preferredLines.isEmpty && !edge.lineName.isEmpty
            && !preferredLines.contains(edge.lineName)
        {
            penalty += edge.length * nonPreferredLineLengthFactor
        }
        if !preferredOperators.isEmpty && !edge.operator.isEmpty
            && !preferredOperators.contains(edge.operator)
        {
            penalty += edge.length * nonPreferredOperatorLengthFactor
        }
        return penalty
    }

    public static func routeLineMismatchPenalty(
        graph: RouteGraph.Graph, pathKeys: [String], hints: SegmentHints
    ) -> Double {
        guard !hints.preferredLines.isEmpty || !hints.preferredOperators.isEmpty else {
            return 0
        }
        guard pathKeys.count >= 2 else { return 0 }
        var penalty = 0.0
        for index in 0..<(pathKeys.count - 1) {
            guard let edge = findEdge(graph: graph, from: pathKeys[index], to: pathKeys[index + 1]),
                  edge.connector == nil
            else { continue }
            penalty += nonPreferredLineOperatorPenalty(
                for: edge,
                preferredLines: hints.preferredLines,
                preferredOperators: hints.preferredOperators)
        }
        return penalty
    }

    public static func usedInstitutionTypeCodes(
        graph: RouteGraph.Graph, pathKeys: [String]
    ) -> [String] {
        guard pathKeys.count >= 2 else { return [] }
        var used = Set<String>()
        for index in 0..<(pathKeys.count - 1) {
            if let code = findEdge(
                graph: graph, from: pathKeys[index], to: pathKeys[index + 1]
            )?.institutionTypeCode, !code.isEmpty {
                used.insert(code)
            }
        }
        return used.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    }

    /// JavaScript's one-run multi-source → multi-target Dijkstra.
    ///
    /// Heap comparisons intentionally use only `priority`. Equal priorities
    /// retain the exact binary-heap behaviour of the frontend rather than
    /// acquiring a Swift-specific string tiebreaker that could choose another
    /// equally cheap railway at a junction.
    public static func dijkstra(
        graph: RouteGraph.Graph,
        sourceCandidates: [Candidate],
        targetKeys: Set<String>,
        train: TrainPolicy,
        allowedCodes: [String],
        hints: SegmentHints = SegmentHints()
    ) -> [SolvedTarget] {
        var distance: [String: Double] = [:]
        var previous: [String: String] = [:]
        var sourceOf: [String: String] = [:]
        var seedCost: [String: Double] = [:]
        var heap = MinHeap()

        for candidate in sourceCandidates {
            let initial = candidate.distance * stationSnapCostFactor
            if initial < (distance[candidate.key] ?? .infinity) {
                distance[candidate.key] = initial
                sourceOf[candidate.key] = candidate.key
                seedCost[candidate.key] = initial
                heap.push(Item(key: candidate.key, priority: initial))
            }
        }

        var visited = Set<String>()
        var remaining = targetKeys
        var settled: [(targetKey: String, settledCost: Double)] = []

        while !heap.isEmpty && !remaining.isEmpty {
            guard let current = heap.pop() else { break }
            guard visited.insert(current.key).inserted else { continue }
            if remaining.remove(current.key) != nil {
                settled.append((current.key, current.priority))
            }
            for edge in graph.adjacency[current.key] ?? [] {
                guard edgeMatchesAllowedCodes(
                    edge, allowedCodes: allowedCodes, train: train, hints: hints),
                    edgeMatchesRequiredHints(edge, hints: hints)
                else { continue }

                var weight = edge.length
                if edge.connector == nil {
                    weight += institutionPreferencePenalty(
                        for: edge, allowedCodes: allowedCodes, train: train)
                    weight += nonPreferredLineOperatorPenalty(
                        for: edge,
                        preferredLines: hints.preferredLines,
                        preferredOperators: hints.preferredOperators)
                }
                let nextCost = current.priority + weight
                if nextCost < (distance[edge.to] ?? .infinity) {
                    distance[edge.to] = nextCost
                    previous[edge.to] = current.key
                    sourceOf[edge.to] = sourceOf[current.key]
                    heap.push(Item(key: edge.to, priority: nextCost))
                }
            }
        }

        return settled.compactMap { entry in
            guard let sourceKey = sourceOf[entry.targetKey] else { return nil }
            return SolvedTarget(
                targetKey: entry.targetKey,
                sourceKey: sourceKey,
                cost: entry.settledCost - (seedCost[sourceKey] ?? 0),
                pathKeys: reconstructPath(
                    previous: previous, sourceKey: sourceKey, targetKey: entry.targetKey))
        }
    }

    public static func pathLengthMeters(
        graph: RouteGraph.Graph, pathKeys: [String]
    ) -> Double {
        guard pathKeys.count >= 2 else { return 0 }
        var length = 0.0
        for index in 0..<(pathKeys.count - 1) {
            guard let a = graph.nodes[pathKeys[index]],
                  let b = graph.nodes[pathKeys[index + 1]] else { continue }
            length += Geometry.distanceMeters(a, b)
        }
        return length
    }

    private static func findEdge(
        graph: RouteGraph.Graph, from: String, to: String
    ) -> RouteGraph.Edge? {
        graph.adjacency[from]?.first { $0.to == to }
    }

    private static func sectionEndpointBBox(
        _ rawSection: RouteSection,
        train: TrainContext,
        country: String,
        stations: Stations.Index
    ) -> RouteGraph.BBox? {
        var section = rawSection
        if section.from?.isEmpty != false {
            section.from = stations.name(forCode: section.fromN02StationCode)
        }
        if section.to?.isEmpty != false {
            section.to = stations.name(forCode: section.toN02StationCode)
        }
        let cacheTrain = RouteGraph.CacheKeyTrain(
            trainType: train.trainType, company: train.company,
            preferredLineNames: train.preferredLineNames,
            preferredOperatorNames: train.preferredOperatorNames,
            allowedInstitutionTypeCodes: train.allowedInstitutionTypeCodes,
            institutionFilterMode: train.institutionFilterMode)
        let allowed = RouteGraph.allowedInstitutionTypeCodes(cacheTrain, country: country)
        let lines = (section.lineNames ?? []).filter { !$0.isEmpty }
        let from = resolveRouteEndpointStationCandidates(
            .stop(.init(name: section.from, n02StationCode: section.fromN02StationCode)),
            in: stations, allowedCodes: allowed, sectionLineNames: lines)
        let to = resolveRouteEndpointStationCandidates(
            .stop(.init(name: section.to, n02StationCode: section.toN02StationCode)),
            in: stations, allowedCodes: allowed, sectionLineNames: lines)
        let coordinates = (from + to).compactMap {
            coordinate(Stations.displayCoordinate(stations.features[$0]))
        }
        guard let first = coordinates.first else { return nil }
        return coordinates.dropFirst().reduce(
            RouteGraph.BBox(minX: first.lon, minY: first.lat, maxX: first.lon, maxY: first.lat)
        ) { box, coordinate in
            RouteGraph.BBox(
                minX: min(box.minX, coordinate.lon), minY: min(box.minY, coordinate.lat),
                maxX: max(box.maxX, coordinate.lon), maxY: max(box.maxY, coordinate.lat))
        }
    }

    private static func trimRouteEndpointToStationDisplay(
        _ coordinates: [Coordinate], station: Stations.Feature, isStart: Bool
    ) -> [Coordinate] {
        guard coordinates.count >= 2,
              let display = coordinate(Stations.displayCoordinate(station)) else {
            return coordinates
        }
        let endpoint = isStart ? coordinates[0] : coordinates[coordinates.count - 1]
        if coordinatesClose(display, endpoint, toleranceMeters: 1.5) { return coordinates }

        let searchLimit = min(12, coordinates.count - 1)
        let firstSegment = isStart ? 0 : max(0, coordinates.count - 1 - searchLimit)
        let lastSegment = isStart ? searchLimit - 1 : coordinates.count - 2
        var best: (distance: Double, t: Double, index: Int)?
        if firstSegment <= lastSegment {
            for index in firstSegment...lastSegment {
                let projected = projectPointToSegmentMeters(
                    display, coordinates[index], coordinates[index + 1])
                if projected.t < -0.02 || projected.t > 1.02 { continue }
                if best == nil || projected.distance < best!.distance {
                    best = (projected.distance, projected.t, index)
                }
            }
        }
        if let best, best.distance <= 45 {
            if isStart {
                let tail = Array(coordinates[(best.index + 1)...])
                if let first = tail.first,
                   coordinatesClose(display, first, toleranceMeters: 1.5) { return tail }
                return [display] + tail
            }
            let head = Array(coordinates[...best.index])
            if let last = head.last,
               coordinatesClose(last, display, toleranceMeters: 1.5) { return head }
            return head + [display]
        }
        if Geometry.distanceMeters(display, endpoint) <= stationSnapMaxDistanceMeters {
            return isStart ? [display] + coordinates : coordinates + [display]
        }
        return coordinates
    }

    private static func coordinatesClose(
        _ a: Coordinate, _ b: Coordinate, toleranceMeters: Double = 1.5
    ) -> Bool {
        Geometry.distanceMeters(a, b) <= toleranceMeters
    }

    private static func projectPointToSegmentMeters(
        _ point: Coordinate, _ a: Coordinate, _ b: Coordinate
    ) -> (distance: Double, t: Double) {
        let latitude = ((point.lat + a.lat + b.lat) / 3) * .pi / 180
        let metresPerLongitude = 111_320.0 * JSMath.cos(latitude)
        let metresPerLatitude = 110_540.0
        let px = point.lon * metresPerLongitude
        let py = point.lat * metresPerLatitude
        let ax = a.lon * metresPerLongitude
        let ay = a.lat * metresPerLatitude
        let bx = b.lon * metresPerLongitude
        let by = b.lat * metresPerLatitude
        let dx = bx - ax
        let dy = by - ay
        let denominator = dx * dx + dy * dy
        let t = denominator > 0 ? ((px - ax) * dx + (py - ay) * dy) / denominator : 0
        let clamped = max(0, min(1, t))
        let qx = ax + clamped * dx
        let qy = ay + clamped * dy
        return (JSMath.hypot(px - qx, py - qy), t)
    }

    private static func graphNodeHasPreferredInstitution(
        _ meta: RouteGraph.NodeMeta, allowedCodes: [String]
    ) -> Bool {
        let preferred = Set(allowedCodes.filter { !$0.isEmpty })
        if preferred.isEmpty { return true }
        return RouteGraph.intersects(meta.institutionTypeCodes, preferred)
    }

    private static func preferredStationPool(
        _ indices: [Int], stations: Stations.Index, allowedCodes: [String]
    ) -> [Int] {
        let preferred = filterStationsByPreferredInstitution(
            indices, in: stations, allowedCodes: allowedCodes)
        return preferred.isEmpty ? indices : preferred
    }

    private static func stationSet(
        _ indices: [Int], stations: Stations.Index,
        getter: (Stations.Feature) -> String
    ) -> Set<String> {
        Set(indices.map { getter(stations.features[$0]) }.filter { !$0.isEmpty && $0 != "-" })
    }

    private static func sectionEndpointNames(_ section: RouteSection) -> [String] {
        [normalizeRouteHintText(section.from ?? ""), normalizeRouteHintText(section.to ?? "")]
            .filter { !$0.isEmpty }
    }

    private static func sectionHasAnyEndpoint(_ section: RouteSection, names: Set<String>) -> Bool {
        sectionEndpointNames(section).contains { names.contains($0) }
    }

    private static func sectionHasEndpointPair(
        _ section: RouteSection, _ a: Set<String>, _ b: Set<String>
    ) -> Bool {
        let endpoints = sectionEndpointNames(section)
        return endpoints.contains { a.contains($0) } && endpoints.contains { b.contains($0) }
    }

    private static func asciiCaseInsensitiveContains(_ text: String, _ needle: String) -> Bool {
        text.lowercased().contains(needle.lowercased())
    }

    /// ECMAScript `String(value || "").trim()` for route hint fields.
    private static func normalizeRouteHintText(_ text: String) -> String {
        let units = Array(text.utf16)
        var start = 0
        var end = units.count
        while start < end, isJSTrimUnit(units[start]) { start += 1 }
        while end > start, isJSTrimUnit(units[end - 1]) { end -= 1 }
        return String(decoding: units[start..<end], as: UTF16.self)
    }

    private static func normalizedHintValues(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for value in values {
            let normalized = normalizeRouteHintText(value)
            if !normalized.isEmpty, seen.insert(normalized).inserted {
                result.append(normalized)
            }
        }
        return result
    }

    private static func officialIntervalKey(
        line: String, operatorName: String, from: Coordinate, to: Coordinate
    ) -> String {
        guard !line.isEmpty, !operatorName.isEmpty else { return "" }
        let locale = Locale(identifier: "en_US_POSIX")
        func fixed(_ coordinate: Coordinate) -> String {
            String(format: "%.6f,%.6f", locale: locale, coordinate.lon, coordinate.lat)
        }
        return "\(line)\u{001F}\(operatorName)\u{001F}\(fixed(from))\u{001F}\(fixed(to))"
    }

    private static func isJSTrimUnit(_ value: UInt16) -> Bool {
        switch value {
        case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A,
             0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    private static func jsSorted<S: Sequence>(_ values: S) -> [String]
    where S.Element == String {
        values.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    }

    private static func dedupeStationIndices(
        _ indices: [Int], in index: Stations.Index
    ) -> [Int] {
        let features = indices.map { index.features[$0] }
        return Stations.dedupeStationFeatureIndices(features).map { indices[$0] }
    }

    private static func coordinate(_ pair: [Double]?) -> Coordinate? {
        pair.flatMap(Coordinate.init(pair:))
    }

    /// `iterateGeometryLines(feature.geometry)`, falling back to the display
    /// point only when the station has no path geometry.
    private static func stationGeometryCoordinates(_ feature: Stations.Feature) -> [Coordinate] {
        var lines: [[Coordinate]] = []
        if let geometry = feature.geometry,
           case .array(let outer)? = geometry.coordinates
        {
            switch geometry.type {
            case "LineString":
                let line = outer.compactMap(position)
                if !line.isEmpty { lines.append(line) }
            case "MultiLineString":
                for value in outer {
                    guard case .array(let rawLine) = value else { continue }
                    let line = rawLine.compactMap(position)
                    if !line.isEmpty { lines.append(line) }
                }
            default:
                break
            }
        }
        if !lines.isEmpty { return lines.flatMap { $0 } }
        return coordinate(Stations.displayCoordinate(feature)).map { [$0] } ?? []
    }

    private static func position(_ value: Stations.Value) -> Coordinate? {
        guard case .array(let values) = value, values.count >= 2,
              case .number(let lon) = values[0], case .number(let lat) = values[1]
        else { return nil }
        return Coordinate(lon: lon, lat: lat)
    }

    private static func reconstructPath(
        previous: [String: String], sourceKey: String, targetKey: String
    ) -> [String] {
        var path = [targetKey]
        var current = targetKey
        while current != sourceKey {
            guard let prior = previous[current] else { return [] }
            current = prior
            path.append(current)
        }
        return path.reversed()
    }

    private struct Item {
        var key: String
        var priority: Double
    }

    private struct MinHeap {
        private var items: [Item] = []
        var isEmpty: Bool { items.isEmpty }

        mutating func push(_ item: Item) {
            items.append(item)
            bubbleUp(items.count - 1)
        }

        mutating func pop() -> Item? {
            guard !items.isEmpty else { return nil }
            if items.count == 1 { return items.removeLast() }
            let top = items[0]
            items[0] = items.removeLast()
            bubbleDown(0)
            return top
        }

        private mutating func bubbleUp(_ start: Int) {
            var index = start
            while index > 0 {
                let parent = (index - 1) / 2
                if items[parent].priority <= items[index].priority { break }
                items.swapAt(parent, index)
                index = parent
            }
        }

        private mutating func bubbleDown(_ start: Int) {
            var index = start
            while true {
                let left = index * 2 + 1
                let right = left + 1
                var smallest = index
                if left < items.count && items[left].priority < items[smallest].priority {
                    smallest = left
                }
                if right < items.count && items[right].priority < items[smallest].priority {
                    smallest = right
                }
                if smallest == index { break }
                items.swapAt(smallest, index)
                index = smallest
            }
        }
    }
}
