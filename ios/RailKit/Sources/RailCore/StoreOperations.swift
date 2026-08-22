import Foundation

// =========================================================================
//  StoreOperations.swift — the train store's WRITE side.
//
//  Ported from app-store-ops.js §17–§20: the CRUD handlers, the canonical
//  export as a byte format, the import append path, and the blank-train
//  factory. `Train.swift` already carries §18/§19's *shapes* — the canonical
//  stop/style/policy/section builders and the two front doors. This file is
//  what puts them to work: what an operation DOES to a store, and what the
//  result looks like as bytes.
//
//  ## Three things here are contracts rather than conveniences
//
//  **1. The canonical export is an archive format, not a screenful.**
//  `exportTrainStore` is `JSON.stringify(store, null, 2)`, and its output is
//  literally what `app/data/train-store.json` holds. So key ORDER,
//  indentation and string escaping are part of the answer.
//  ``TrainValidationParityTests`` already checks the export's *values*
//  through a sorted-key canonicalisation, because `JSONEncoder` emits keys in
//  no defined order; that is why ``stringify(_:indent:)`` exists rather than
//  a `JSONEncoder` configuration. There is no configuration that produces
//  insertion order.
//
//  **2. Key order here is declaration order, everywhere, once.** Every shape
//  §17–§20 builds — `normalizeExportTrain`'s 13 fields, `canonicalStopShape`'s
//  6, `canonicalRoutePolicy`'s 8, `leanExportSection`'s conditional `from`/
//  `to`, `normalizeImportedRouteSection`, and all six blank-train scaffolds —
//  spells its keys in the same relative order. That is what lets ``json(_:)``
//  below be a single projection per type instead of one per call site, and it
//  is checked rather than assumed: `port-fixtures/store-ops.json` records the
//  bytes of the blank trains, the import normalisation and the export, and
//  all three come out of the same projection.
//
//  **3. The CRUD handlers have a pure core and a view-shaped shell.** Each
//  does a small transition on (trains, selectedTrainId, focusedTrainId) and
//  then hands a NAMED mutation result to the renderer. The transition is
//  here; the renderer is not. What is preserved is that every handler returns
//  EARLY, with no mutation result at all, when its target is missing or its
//  move would leave the list — "this was a no-op" and "this changed the
//  collection and nothing was different" are different answers, and the shell
//  has to be able to tell them apart. Hence `MutationResult?` rather than
//  `Void`.
//
//  ## What is deliberately NOT here
//
//  `importBusy()`, `applyMutationResult`, `MutationResults`,
//  `waitForImportPaint()` and the debounced autosave are shell: they read
//  `importInProgress` / `countrySwitchInFlight`, write a status element,
//  re-render four views and schedule a PUT. None of them feeds back into the
//  store's state. The guard in particular is a REAL rule and the shell must
//  keep it — every mutating handler in the web app refuses to run while a
//  progressive import or a country switch owns the store — but it is a rule
//  about the shell's own concurrency, not about what an operation computes.
// =========================================================================

public enum StoreOperations {

    // MARK: - the workspace §17 mutates

    /// The three globals §17 reads and writes, as one value.
    ///
    /// The JavaScript's `trainStore`, `selectedTrainId` and `focusedTrainId`
    /// are separate module-scope bindings that every handler touches together;
    /// making them one value is what turns a handler into a function instead
    /// of a side effect. `country` is here for the same reason: the canonical
    /// export and the blank-train factory both branch on `activeCountry`, and
    /// a store belongs to exactly one country (jsonspec §2.3 rule 4 —
    /// `country` is deliberately NOT a field of the file).
    public struct Workspace: Equatable, Sendable {
        public var store: TrainStore
        /// `selectedTrainId` — which train the editor is showing.
        public var selectedTrainID: String?
        /// `focusedTrainId` — which train the map is centred on. Cleared only
        /// when the train it names is deleted, never when the selection moves.
        public var focusedTrainID: String?
        /// `activeCountry`.
        public var country: String

        public init(
            store: TrainStore = TrainStore(),
            selectedTrainID: String? = nil,
            focusedTrainID: String? = nil,
            country: String = "jp"
        ) {
            self.store = store
            self.selectedTrainID = selectedTrainID
            self.focusedTrainID = focusedTrainID
            self.country = country
        }

        public var trains: [Train] {
            get { store.trains }
            set { store.trains = newValue }
        }
    }

    /// Which `MutationResults` member a handler signalled, or nil for a
    /// handler that returned before signalling anything.
    ///
    /// The real members (app-render.js §22) are frozen option sets naming
    /// which views to refresh and whether to schedule a save. Only their
    /// identity crosses this boundary: the store decides *what happened*, the
    /// shell decides what to redraw. The three names below are the three §17
    /// ever uses.
    public enum MutationResult: String, Sendable, Equatable {
        /// The train list gained or lost a member.
        case trainCollectionChanged
        /// The same members in a different order.
        case trainOrderChanged
        /// One train's `visible` flipped. Notably still triggers a FULL map
        /// re-render, because overlapping parallel routes share global offset
        /// slots that have to be recomputed when the visible set changes.
        case visibilityChanged
    }

    // MARK: - §17: train CRUD

    /// `addTrain` — append a train, and select and focus it.
    ///
    /// Passing nil is the only thing the app itself ever does: the "add"
    /// button calls `addTrain()` with no argument, so the blank-train
    /// scaffold is the sole real caller. The parameter exists because the
    /// JavaScript has it.
    ///
    /// Note that what lands in the store is NOT validated and NOT
    /// canonicalised — the raw train, with a unique id. In the web app that
    /// means the store can hold a shape `validateTrain` would reject until
    /// the next export; here the type system narrows it to a well-formed
    /// ``Train``, which is stricter than the original and is the one place
    /// this port cannot reproduce the JavaScript's looseness.
    @discardableResult
    public static func addTrain(_ train: Train? = nil, in workspace: inout Workspace)
        -> MutationResult?
    {
        // `clone(base)` is `JSON.parse(JSON.stringify(base))`, a deep copy so
        // that the caller's object and the stored one stop sharing arrays. A
        // Swift value type is already that copy.
        var candidate = train ?? createBlankTrain(country: workspace.country)
        // `candidate.id || "LE"` — an empty id falls back to the Japanese
        // scaffold's id even in Taiwan, which is what the JavaScript does.
        candidate.id = uniqueID(candidate.id.isEmpty ? "LE" : candidate.id, in: workspace)
        workspace.store.trains.append(candidate)
        workspace.selectedTrainID = candidate.id
        workspace.focusedTrainID = candidate.id
        return .trainCollectionChanged
    }

    /// `duplicateTrain` — a deep copy under a fresh id, appended and selected.
    @discardableResult
    public static func duplicateTrain(_ trainID: String?, in workspace: inout Workspace)
        -> MutationResult?
    {
        guard let train = train(withID: trainID, in: workspace) else { return nil }
        var copy = train
        // Against the store as it stands, BEFORE the copy is appended — so a
        // second duplicate of the same train becomes `-copy-2`, not `-copy`.
        copy.id = uniqueID("\(train.id)-copy", in: workspace)
        // `${train.number || "Train"} Copy` — an empty number produces the
        // literal "Train Copy".
        copy.number = "\(train.number.isEmpty ? "Train" : train.number) Copy"
        workspace.store.trains.append(copy)
        workspace.selectedTrainID = copy.id
        workspace.focusedTrainID = copy.id
        return .trainCollectionChanged
    }

    /// `deleteTrain` — remove one train and move the selection to whatever
    /// now occupies its place.
    ///
    /// Two behaviours worth naming, both reproduced:
    ///
    ///   - The selection is reassigned **unconditionally**, not only when the
    ///     deleted train was the selected one. Deleting the first train of a
    ///     201-train store while the editor is showing the last one moves the
    ///     editor to the new first train.
    ///   - The focus is cleared only when it named the deleted train, so
    ///     after that same delete the map is still centred on the last train
    ///     while the editor has jumped elsewhere.
    @discardableResult
    public static func deleteTrain(_ trainID: String?, in workspace: inout Workspace)
        -> MutationResult?
    {
        guard let index = indexOfTrain(withID: trainID, in: workspace) else { return nil }
        workspace.store.trains.remove(at: index)
        // `trains[Math.min(index, trains.length - 1)]?.id || null` — the
        // train that slid into the gap, or the new last one when the gap was
        // at the end, or null when the store is now empty. The `|| null` also
        // turns an EMPTY id into no selection, which is why this is not just
        // an optional chain.
        let next = min(index, workspace.store.trains.count - 1)
        let successor = next >= 0 ? workspace.store.trains[next].id : nil
        workspace.selectedTrainID = (successor?.isEmpty ?? true) ? nil : successor
        if let trainID, let focused = workspace.focusedTrainID,
            TrainValidation.jsStringEquals(focused, trainID)
        {
            workspace.focusedTrainID = nil
        }
        return .trainCollectionChanged
    }

    /// `deleteAllTrains` — `AppActions.resetTrainStore()` plus the selection.
    ///
    /// The store is REPLACED rather than emptied, so its `schema_version` is
    /// reset to the version this app writes. A store loaded from an older
    /// accepted file comes back as 1.3.
    @discardableResult
    public static func deleteAllTrains(in workspace: inout Workspace) -> MutationResult? {
        workspace.store = TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: [])
        workspace.selectedTrainID = nil
        workspace.focusedTrainID = nil
        return .trainCollectionChanged
    }

    /// `toggleTrainVisibility` — `train.visible = train.visible === false`.
    ///
    /// Written as an equality rather than a negation on purpose, and the
    /// difference is visible on real data: `visible` is optional in the
    /// schema, and an ABSENT `visible` means shown. `!undefined` would be
    /// `true`, so a naive negation leaves an implicitly-visible train
    /// visible; `undefined === false` is `false`, so the first click hides it,
    /// which is what a reader clicking "hide" expects.
    @discardableResult
    public static func toggleTrainVisibility(_ trainID: String?, in workspace: inout Workspace)
        -> MutationResult?
    {
        guard let index = indexOfTrain(withID: trainID, in: workspace) else { return nil }
        workspace.store.trains[index].visible = workspace.store.trains[index].visible == false
        return .visibilityChanged
    }

    /// `moveTrain` — shift one train by `direction` places.
    ///
    /// The bound check runs against the list length BEFORE the removal, which
    /// is what makes `+1` on the last train a no-op rather than a re-insert
    /// at the end. `direction` is any integer, not just ±1: the JavaScript
    /// takes a number and the two buttons happen to pass ±1.
    @discardableResult
    public static func moveTrain(_ trainID: String?, by direction: Int, in workspace: inout Workspace)
        -> MutationResult?
    {
        guard let index = indexOfTrain(withID: trainID, in: workspace) else { return nil }
        let next = index + direction
        guard next >= 0, next < workspace.store.trains.count else { return nil }
        let train = workspace.store.trains.remove(at: index)
        workspace.store.trains.insert(train, at: next)
        return .trainOrderChanged
    }

    /// `getTrain(id)` — the first train with this id, or nil.
    ///
    /// A nil id matches nothing, which is what the JavaScript does when it is
    /// passed an explicit `null`: a default parameter only fires for
    /// `undefined`, so `getTrain(null)` searches for a train whose id is null
    /// and finds none. ``selectedTrain(in:)`` is the no-argument call.
    public static func train(withID id: String?, in workspace: Workspace) -> Train? {
        guard let index = indexOfTrain(withID: id, in: workspace) else { return nil }
        return workspace.store.trains[index]
    }

    /// `getTrain()` with no argument — the train the editor is showing.
    public static func selectedTrain(in workspace: Workspace) -> Train? {
        train(withID: workspace.selectedTrainID, in: workspace)
    }

    private static func indexOfTrain(withID id: String?, in workspace: Workspace) -> Int? {
        guard let id else { return nil }
        // `t.id === trainId` — UTF-16 code units, not canonical equivalence.
        // Train ids are `^[a-zA-Z0-9_-]+$` in the schema and so cannot differ
        // by normalisation, but `addTrain` stores whatever it is handed, so
        // the rule is stated rather than assumed to be unreachable.
        return workspace.store.trains.firstIndex { TrainValidation.jsStringEquals($0.id, id) }
    }

    // MARK: - §20: id helpers

    /// `uniqueId` — an INTERACTIVE seed, cleaned, then made unique.
    ///
    /// Not the same function as ``TrainValidation/makeUniqueTrainId(_:existingIDs:)``,
    /// which it delegates to. The extra step is the reason it exists: a seed
    /// here comes from a name a person typed or pasted (`"東京 発"`,
    /// `"はるか38号-copy"`), so every run of whitespace collapses to a single
    /// `-` before the uniqueness loop, keeping the result inside the
    /// `^[a-zA-Z0-9_-]+$` id charset for the whitespace at least.
    ///
    /// The whitespace class is ECMAScript's `\s`, which is not
    /// `CharacterSet.whitespacesAndNewlines`: `\s` includes U+FEFF and
    /// excludes U+0085, and Foundation's set is the other way round on both.
    /// Rather than spell that set a third time (``TrainValidation`` and
    /// ``Dates`` each already carry one privately), membership is asked of
    /// the one definition that is reachable: a single-scalar string trims to
    /// empty exactly when that scalar is JavaScript whitespace.
    public static func uniqueID(_ seed: String?, in workspace: Workspace) -> String {
        // `String(seed || "train")` — null, undefined and "" all become "train".
        let raw = (seed?.isEmpty == false) ? seed! : "train"
        let collapsed = collapsingJSWhitespace(TrainValidation.jsTrim(raw))
        // `|| "train"` again, for a seed that was nothing but whitespace: it
        // trims to "", and "" collapses to "".
        let clean = collapsed.isEmpty ? "train" : collapsed
        return TrainValidation.makeUniqueTrainId(
            clean, existingIDs: Set(workspace.store.trains.map(\.id)))
    }

    /// `.replace(/\s+/g, "-")` — every maximal run of JavaScript whitespace
    /// becomes one hyphen.
    private static func collapsingJSWhitespace(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        var inRun = false
        for scalar in text.unicodeScalars {
            if isJSWhitespace(scalar) {
                if !inRun {
                    out.append("-")
                    inRun = true
                }
            } else {
                out.append(scalar)
                inRun = false
            }
        }
        return String(out)
    }

    /// Membership in ECMAScript's `\s`, asked of ``TrainValidation``'s own
    /// definition rather than restated. See ``uniqueID(_:in:)``.
    private static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        TrainValidation.jsTrim(String(scalar)).isEmpty
    }

    // MARK: - §18: the canonical export as bytes

    /// `exportTrainStore` — `JSON.stringify(buildCanonicalTrainStore(), null, 2)`.
    ///
    /// The single definition of the saved schema. Note that it is NOT a fixed
    /// point over the committed Japanese archive: 87 of that file's 201 trains
    /// come back with a differently spelled `route_policy` (41 by key order,
    /// 46 because `preferred_line_names` / `preferred_operator_names` did not
    /// exist when they were written), so the first save rewrites them. The
    /// fixture records that, because a port that "fixed" it would stop
    /// reproducing what the app does to the archive.
    ///
    /// Nor does its output match `train-store-tw.json`, which is committed
    /// MINIFIED — same values, no gap, no trailing newline. Both files are
    /// reproducible from ``stringify(_:indent:)``; only one of them is
    /// reproducible from this function.
    public static func exportTrainStore(
        _ workspace: Workspace, stations: TrainValidation.StationTable = .empty
    ) -> String {
        stringify(
            json(
                TrainValidation.buildCanonicalTrainStore(
                    workspace.store.trains, country: workspace.country, stations: stations)),
            indent: 2)
    }

    /// `getRideRouteSectionsForTrain` — one section per adjacent stop pair.
    ///
    /// The seam `RouteGraph.solveContext` names: `buildTrainRouteSolveContext`
    /// takes its sections from here, so the cache key of every route solve is
    /// downstream of this function. It is exposed from the train store rather
    /// than from the graph because the rule is about a train's stops, not
    /// about the network — the section list is *recomputed* from the stops on
    /// every read, and a written section is reused only when it matches the
    /// pair, which is what keeps a hand-edited stop list and its sections
    /// from drifting apart (jsonspec §6.3).
    ///
    /// Note this is the un-leaned form: the endpoint names are kept, because
    /// live routing, the §6.4 branch checks and the tooltips all match on
    /// them. Dropping a derivable name happens only on the way to disk.
    public static func rideRouteSections(
        for train: Train, stations: TrainValidation.StationTable = .empty
    ) -> [RouteSection] {
        TrainValidation.rideRouteSections(for: train, stations: stations)
    }

    // MARK: - §19: the import append path

    /// `appendImportedTrain` — normalise, rename on collision, validate,
    /// append; returns the id the train was stored under.
    ///
    /// What lands in the store is the IMPORT normalisation, not the export
    /// one: its sections keep the empty `line_names` / `operator_names`
    /// arrays that `leanExportSection` would drop on the way out. Only the
    /// *validation* sees the export shape.
    ///
    /// The validation covers the incoming train ONLY. It used to rebuild the
    /// whole canonical store and re-validate every already-appended train on
    /// every append, an O(N²) pass that dominated large imports; id
    /// uniqueness against the existing store is already guaranteed by
    /// `makeUniqueTrainId`, and one authoritative whole-store
    /// `validateTrainStore` still runs at the end of the load.
    @discardableResult
    public static func appendImportedTrain(
        _ rawTrain: TrainValidation.JSON,
        fallbackDate: String? = nil,
        in workspace: inout Workspace,
        stations: TrainValidation.StationTable = .empty
    ) throws -> String {
        var train = try TrainValidation.normalizeImportedTrain(
            rawTrain, fallbackDate: fallbackDate, country: workspace.country, stations: stations)
        let existingIDs = Set(workspace.store.trains.map(\.id))
        train.id = TrainValidation.makeUniqueTrainId(train.id, existingIDs: existingIDs)

        // `validateTrain` adds the id to the set it is given; the JavaScript
        // passes the same set it built above and then discards it, so the
        // mutation is invisible and the copy here is what reproduces that.
        var ids = existingIDs
        try TrainValidation.validateTrain(
            json(
                TrainValidation.normalizeExportTrain(
                    train, country: workspace.country, stations: stations)),
            index: workspace.store.trains.count,
            ids: &ids)

        workspace.store.trains.append(train)
        return train.id
    }

    /// `ALL_DATES` — the date-bar's "全部" bucket. Not a date.
    public static let allDates = "__all__"

    /// `currentImportFallbackDate` — the date an undated imported train is
    /// assigned to.
    ///
    /// A concrete selected date when one is active, otherwise nil, which lets
    /// `normalizeTrainDate` fall through to inferring a date from the id and
    /// then to `undated`. "全部" is not a date, so it yields nil.
    public static func currentImportFallbackDate(selectedDate: String?) -> String? {
        guard let selectedDate, !selectedDate.isEmpty,
            !TrainValidation.jsStringEquals(selectedDate, allDates)
        else { return nil }
        return selectedDate
    }

    // MARK: - §20: the blank-train factory

    /// `createBlankTrain` — the country's starter itinerary.
    ///
    /// COUNTRY-SPECIFIC DATA, not a template with a parameter: Japan keeps its
    /// 東京→熱海 starter (whose N02 codes the solver can route immediately),
    /// Taiwan starts from the airport-MRT corridor with TDX StationUIDs, and
    /// Hong Kong, Korea and Macao each get their own regional scaffold. The
    /// point is that a new Taiwanese train never carries Japanese stops into
    /// the Taiwanese store.
    ///
    /// An unrecognised country falls through to Japan, which is the
    /// JavaScript's `if`-chain with no `else`.
    public static func createBlankTrain(country: String) -> Train {
        switch country {
        case "tw": createBlankTrainTw()
        case "hk":
            createBlankRegionalTrain(
                id: "HK-MTR", trainType: "港鐵", company: "香港鐵路有限公司",
                origin: "香港", destination: "機場",
                originCode: "AEL-MTR-HOK", destinationCode: "AEL-MTR-AIR",
                lineName: "機場快綫", color: "#1C7670")
        case "kr":
            createBlankRegionalTrain(
                id: "KR-KORAIL", trainType: "무궁화호", company: "한국철도공사",
                origin: "서울", destination: "영등포",
                originCode: "KR-GYEONGBUSEON-SEOUL",
                destinationCode: "KR-GYEONGBUSEON-YEONGDEUNGPO",
                lineName: "경부선", color: "#0067A3", institutionCode: "2")
        case "mo":
            createBlankRegionalTrain(
                id: "MO-LRT", trainType: "輕軌", company: "澳門輕軌股份有限公司",
                origin: "媽閣", destination: "海洋",
                originCode: "MLM-TAIPA-MLM-BARRA", destinationCode: "MLM-TAIPA-MLM-OCEAN",
                lineName: "氹仔線", color: "#72BF44")
        default: createBlankTrainJp()
        }
    }

    /// `createBlankRegionalTrain` — the shared scaffold behind hk / kr / mo.
    ///
    /// Its route policy is `hard`, unlike Japan's and Taiwan's: these networks
    /// are small and their lines run beside each other, so the solver is told
    /// the line and operator as a constraint rather than a preference.
    /// `institutionCode` defaults to `"4"` (民営鉄道) because that is what the
    /// two SAR packages carry; Korea passes `"2"` (JR 在来線's slot, which
    /// KORAIL occupies in the shared N02_002 vocabulary).
    static func createBlankRegionalTrain(
        id: String, trainType: String, company: String,
        origin: String, destination: String,
        originCode: String, destinationCode: String,
        lineName: String, color: String, institutionCode: String? = nil
    ) -> Train {
        Train(
            id: id,
            number: "",
            trainType: trainType,
            company: company,
            origin: origin,
            destination: destination,
            direction: "down",
            visible: true,
            style: TrainStyle(color: color),
            routePolicy: RoutePolicy(
                mode: "single_primary_route",
                jrOnly: false,
                allowAlternatives: false,
                allowBrowserStraightLineFallback: false,
                allowedInstitutionTypeCodes: [institutionCode ?? "4"],
                preferredLineNames: [lineName],
                preferredOperatorNames: [company],
                institutionFilterMode: "hard"),
            routeSections: [
                RouteSection(
                    fromN02StationCode: originCode,
                    toN02StationCode: destinationCode,
                    lineNames: [lineName],
                    operatorNames: [company])
            ],
            stops: [
                Stop(
                    name: origin, n02StationCode: originCode,
                    stopType: "origin", rideSegment: true),
                Stop(
                    name: destination, n02StationCode: destinationCode,
                    stopType: "destination", rideSegment: true),
            ])
    }

    /// `createBlankTrainTw` — 台北車站 → 機場第二航廈站 on the airport MRT.
    ///
    /// No `route_sections` scaffold, and that is deliberate: Taiwanese
    /// geometry comes from the curated matched-routes channel keyed by
    /// train_id, not from the N02 solver, so a section list here would be a
    /// constraint on a solver that never runs.
    static func createBlankTrainTw() -> Train {
        Train(
            id: "TW-LE",
            number: "",
            trainType: "直達車",
            company: "桃園捷運",
            origin: "台北車站",
            destination: "機場第二航廈站",
            direction: "down",
            visible: true,
            style: TrainStyle(color: "#8246af"),
            routePolicy: RoutePolicy(
                mode: "single_primary_route",
                jrOnly: false,
                allowAlternatives: false,
                allowBrowserStraightLineFallback: false,
                allowedInstitutionTypeCodes: TrainValidation.defaultAllowedInstitutionTypeCodes,
                preferredLineNames: ["桃園機場捷運"],
                preferredOperatorNames: ["桃園大眾捷運股份有限公司"]),
            routeSections: [],
            stops: [
                Stop(
                    name: "台北車站", n02StationCode: "TYMC-A1",
                    stopType: "origin", rideSegment: true),
                Stop(
                    name: "機場第二航廈站", n02StationCode: "TYMC-A13",
                    stopType: "destination", rideSegment: true),
            ])
    }

    /// `createBlankTrainJp` — 東京 → 熱海, with the four Tōkaidō sections
    /// already written so the solver can draw it on the first render.
    static func createBlankTrainJp() -> Train {
        Train(
            id: "LE",
            number: "",
            trainType: "特急",
            company: "",
            origin: "東京",
            destination: "熱海",
            direction: "down",
            visible: true,
            style: TrainStyle(color: "#1d7f8c"),
            routePolicy: RoutePolicy(
                mode: "single_primary_route",
                jrOnly: false,
                allowAlternatives: false,
                allowBrowserStraightLineFallback: false,
                allowedInstitutionTypeCodes: TrainValidation.defaultAllowedInstitutionTypeCodes),
            routeSections: [
                RouteSection(
                    from: "東京", to: "品川",
                    fromN02StationCode: "003770", toN02StationCode: "004095"),
                RouteSection(
                    from: "品川", to: "横浜",
                    fromN02StationCode: "004095", toN02StationCode: "004634"),
                RouteSection(
                    from: "横浜", to: "小田原",
                    fromN02StationCode: "004634", toN02StationCode: "005218"),
                RouteSection(
                    from: "小田原", to: "熱海",
                    fromN02StationCode: "005218", toN02StationCode: "005685"),
            ],
            stops: [
                Stop(
                    name: "東京", n02StationCode: "003770",
                    stopType: "origin", rideSegment: true),
                Stop(
                    name: "熱海", n02StationCode: "005685",
                    stopType: "destination", rideSegment: true),
            ])
    }
}

// =========================================================================
//  The byte format
// =========================================================================

extension StoreOperations {

    /// `JSON.stringify(value, null, indent)`.
    ///
    /// Hand-written because no `JSONEncoder` configuration produces insertion
    /// order, and insertion order is the format. The rest of the rules are
    /// V8's, and each of the ones below is reachable from a hand-authored
    /// itinerary, since a station name is free text:
    ///
    ///   - `indent` is clamped to 0…10 and spelled as spaces. At 0 there is
    ///     no whitespace at all, not even after a colon.
    ///   - An empty array or object is `[]` / `{}` even with a gap.
    ///   - Only `"`, `\` and the C0 controls are escaped. `/` is NOT escaped
    ///     (Foundation's `JSONEncoder` escapes it), non-ASCII is emitted raw
    ///     (which is what makes a CJK station name one token rather than six
    ///     escapes), and U+2028/U+2029 are emitted raw despite being line
    ///     terminators in JavaScript source.
    ///   - The five short escapes are `\b \t \n \f \r`; every other C0
    ///     control is `\u00xx` in LOWER-case hex.
    ///   - A non-finite number is `null`, and a finite one is spelled by
    ///     ``JSNumber/string(_:)`` — `139`, not `139.0`.
    public static func stringify(_ value: TrainValidation.JSON, indent: Int = 0) -> String {
        var out = ""
        // Reserving is worth it: the Japanese archive is 1.18 MB and this is
        // called on every save.
        out.reserveCapacity(1 << 12)
        let gap = String(repeating: " ", count: max(0, min(10, indent)))
        write(value, gap: gap, currentIndent: "", into: &out)
        return out
    }

    private static func write(
        _ value: TrainValidation.JSON, gap: String, currentIndent: String, into out: inout String
    ) {
        switch value {
        case .null: out += "null"
        case .bool(let flag): out += flag ? "true" : "false"
        // `JSON.stringify(NaN)` and `JSON.stringify(Infinity)` are both "null":
        // JSON has no spelling for either, so the value is dropped rather than
        // the call failing.
        case .number(let number): out += number.isFinite ? JSNumber.string(number) : "null"
        case .string(let text): quote(text, into: &out)
        case .array(let items):
            guard !items.isEmpty else {
                out += "[]"
                return
            }
            let inner = currentIndent + gap
            out += gap.isEmpty ? "[" : "[\n\(inner)"
            for (index, item) in items.enumerated() {
                if index > 0 { out += gap.isEmpty ? "," : ",\n\(inner)" }
                write(item, gap: gap, currentIndent: inner, into: &out)
            }
            out += gap.isEmpty ? "]" : "\n\(currentIndent)]"
        case .object(let object):
            guard !object.keys.isEmpty else {
                out += "{}"
                return
            }
            let inner = currentIndent + gap
            out += gap.isEmpty ? "{" : "{\n\(inner)"
            for (index, key) in object.keys.enumerated() {
                if index > 0 { out += gap.isEmpty ? "," : ",\n\(inner)" }
                quote(key, into: &out)
                out += gap.isEmpty ? ":" : ": "
                write(object[key] ?? .null, gap: gap, currentIndent: inner, into: &out)
            }
            out += gap.isEmpty ? "}" : "\n\(currentIndent)}"
        }
    }

    /// `QuoteJSONString`.
    ///
    /// Walks UTF-16 code units rather than scalars: a character outside the
    /// BMP is a surrogate PAIR, and handling each half on its own turns one
    /// emoji into two replacement characters. Restated here rather than
    /// shared with `TrainValidation.JSON.canonicalText`'s private copy — this
    /// file may not edit that one — so the parity test asserts the two agree
    /// on a string, which is the check that keeps them from drifting.
    private static func quote(_ text: String, into out: inout String) {
        out += "\""
        var units: [UInt16] = []
        // Runs of ordinary code units are flushed in one go: escaping is rare
        // and per-unit `String(decoding:)` on a 1.18 MB archive is not free.
        func flush() {
            guard !units.isEmpty else { return }
            out += String(decoding: units, as: UTF16.self)
            units.removeAll(keepingCapacity: true)
        }
        for unit in text.utf16 {
            switch unit {
            case 0x22: flush(); out += "\\\""
            case 0x5C: flush(); out += "\\\\"
            case 0x08: flush(); out += "\\b"
            case 0x09: flush(); out += "\\t"
            case 0x0A: flush(); out += "\\n"
            case 0x0C: flush(); out += "\\f"
            case 0x0D: flush(); out += "\\r"
            case 0..<0x20:
                flush()
                out += "\\u00"
                let hex = "0123456789abcdef"
                out.append(hex[hex.index(hex.startIndex, offsetBy: Int(unit >> 4))])
                out.append(hex[hex.index(hex.startIndex, offsetBy: Int(unit & 0xF))])
            default: units.append(unit)
            }
        }
        flush()
        out += "\""
    }
}

// =========================================================================
//  Typed model → ordered JSON
//
//  One projection per type, because every §17–§20 call site spells its keys
//  in the same relative order — see the file header. `encodeIfPresent`'s
//  present/absent decisions are mirrored exactly from each type's own
//  `encode(to:)` in Train.swift, because those decisions ARE the format: a
//  stop writes `n02_station_code: null` and a train omits an absent `date`,
//  and swapping the two rewrites the archive.
// =========================================================================

extension StoreOperations {

    public static func json(_ store: TrainStore) -> TrainValidation.JSON {
        .object(
            TrainValidation.JSON.Object([
                ("schema_version", .string(store.schemaVersion)),
                ("trains", .array(store.trains.map(json))),
            ]))
    }

    public static func json(_ train: Train) -> TrainValidation.JSON {
        var pairs: [(String, TrainValidation.JSON)] = [("id", .string(train.id))]
        // Absent and null are not the same thing for a date: jsonspec §3.3
        // lets it be inferred from the id, and `validateTrain` accepts an
        // absent date while rejecting an explicit null one.
        if let date = train.date { pairs.append(("date", .string(date))) }
        pairs.append(("number", .string(train.number)))
        if let trainType = train.trainType { pairs.append(("train_type", .string(trainType))) }
        if let company = train.company { pairs.append(("company", .string(company))) }
        pairs.append(("origin", .string(train.origin)))
        pairs.append(("destination", .string(train.destination)))
        if let direction = train.direction { pairs.append(("direction", .string(direction))) }
        if let visible = train.visible { pairs.append(("visible", .bool(visible))) }
        if let style = train.style { pairs.append(("style", json(style))) }
        if let policy = train.routePolicy { pairs.append(("route_policy", json(policy))) }
        if let sections = train.routeSections {
            pairs.append(("route_sections", .array(sections.map(json))))
        }
        pairs.append(("stops", .array(train.stops.map(json))))
        return .object(TrainValidation.JSON.Object(pairs))
    }

    /// All six fields, `null` included — `canonicalStopShape` writes them
    /// every time, and both committed stores carry all six on all 2 980 stops.
    public static func json(_ stop: Stop) -> TrainValidation.JSON {
        .object(
            TrainValidation.JSON.Object([
                ("name", .string(stop.name)),
                ("n02_station_code", stop.n02StationCode.map(TrainValidation.JSON.string) ?? .null),
                ("arrival", stop.arrival.map(TrainValidation.JSON.string) ?? .null),
                ("departure", stop.departure.map(TrainValidation.JSON.string) ?? .null),
                ("stop_type", .string(stop.stopType)),
                ("ride_segment", .bool(stop.rideSegment)),
            ]))
    }

    /// The two codes every time, everything else only when present — which is
    /// exactly `leanExportSection`: the endpoint names are dropped when the
    /// station table can reconstruct them from the codes (§13.4).
    public static func json(_ section: RouteSection) -> TrainValidation.JSON {
        var pairs: [(String, TrainValidation.JSON)] = []
        if let from = section.from { pairs.append(("from", .string(from))) }
        if let to = section.to { pairs.append(("to", .string(to))) }
        pairs.append((
            "from_n02_station_code",
            section.fromN02StationCode.map(TrainValidation.JSON.string) ?? .null
        ))
        pairs.append((
            "to_n02_station_code",
            section.toN02StationCode.map(TrainValidation.JSON.string) ?? .null
        ))
        if let lines = section.lineNames {
            pairs.append(("line_names", .array(lines.map(TrainValidation.JSON.string))))
        }
        if let operators = section.operatorNames {
            pairs.append(("operator_names", .array(operators.map(TrainValidation.JSON.string))))
        }
        if let number = section.number { pairs.append(("number", .string(number))) }
        if let name = section.name { pairs.append(("name", .string(name))) }
        return .object(TrainValidation.JSON.Object(pairs))
    }

    public static func json(_ policy: RoutePolicy) -> TrainValidation.JSON {
        var pairs: [(String, TrainValidation.JSON)] = []
        if let mode = policy.mode { pairs.append(("mode", .string(mode))) }
        if let jrOnly = policy.jrOnly { pairs.append(("jr_only", .bool(jrOnly))) }
        if let value = policy.allowAlternatives {
            pairs.append(("allow_alternatives", .bool(value)))
        }
        if let value = policy.allowBrowserStraightLineFallback {
            pairs.append(("allow_browser_straight_line_fallback", .bool(value)))
        }
        if let codes = policy.allowedInstitutionTypeCodes {
            pairs.append((
                "allowed_institution_type_codes",
                .array(codes.map(TrainValidation.JSON.string))
            ))
        }
        if let names = policy.preferredLineNames {
            pairs.append(("preferred_line_names", .array(names.map(TrainValidation.JSON.string))))
        }
        if let names = policy.preferredOperatorNames {
            pairs.append((
                "preferred_operator_names", .array(names.map(TrainValidation.JSON.string))
            ))
        }
        if let mode = policy.institutionFilterMode {
            pairs.append(("institution_filter_mode", .string(mode)))
        }
        return .object(TrainValidation.JSON.Object(pairs))
    }

    public static func json(_ style: TrainStyle) -> TrainValidation.JSON {
        var pairs: [(String, TrainValidation.JSON)] = []
        if let color = style.color { pairs.append(("color", .string(color))) }
        return .object(TrainValidation.JSON.Object(pairs))
    }
}
