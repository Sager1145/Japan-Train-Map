import Foundation
import RailCore
import RailPresentation
import Testing

/// JRM_FLIGHTY_UI_REFACTOR_SPEC.md §15 Slice 1's acceptance:
///
/// > 相同输入状态只产生一个主操作；失败/隐藏/回放优先级有单元测试。
///
/// Both halves are checked exhaustively rather than by example, because the
/// thing that breaks a priority resolver is not the case someone wrote a test
/// for — it is the fourth simultaneous state nobody pictured. So the matrix
/// below is the full cross product of route state × sub-phase × visibility,
/// and the invariants are asserted on all of it.
struct JourneyPresentationResolverTests {

    // MARK: - Inputs

    static func train(
        number: String = "踊り子1号",
        date: String? = "2026-07-26",
        origin: String = "横浜",
        destination: String = "大船",
        visible: Bool? = nil
    ) -> Train {
        Train(
            id: "t-\(number)",
            date: date,
            number: number,
            trainType: "特急",
            company: "JR東日本",
            origin: origin,
            destination: destination,
            visible: visible,
            stops: [
                Stop(name: origin, departure: "10:00", rideSegment: true),
                Stop(name: destination, arrival: "10:18", rideSegment: false),
            ])
    }

    static let routeStates: [JourneyRouteState] = [
        .unknown,
        .resolving(completed: nil, total: nil),
        .resolving(completed: 1, total: 3),
        .resolved,
        .needsReview(reason: "大船 → 藤沢"),
        .unavailable(reason: "大船 → 藤沢"),
    ]

    static let subPhases: [JourneyWorkspacePhase?] = [
        nil,
        .playing(progress: 0.32, isPaused: false),
        .playing(progress: 0.32, isPaused: true),
        .editing(isDirty: true, isValid: true),
        .editing(isDirty: true, isValid: false),
        .editing(isDirty: false, isValid: true),
        .failed(.load("store.json is unreadable")),
        .failed(.importData("trains[3].stops[1].name is empty")),
        .failed(.route(trainID: "t-1", section: "大船 → 藤沢", message: "no path")),
        .failed(.save("id collision")),
        // Workspace phases handed to `selected` must be inert, not crash it.
        .browsing,
        .selected,
        .loading,
        .resolving(completed: 2, total: 5),
        .importing(completed: 1, total: 4),
        .empty,
    ]

    static let visibilities: [Bool?] = [nil, true, false]

    /// Every combination the selected surface can be in.
    static var matrix: [(route: JourneyRouteState, phase: JourneyWorkspacePhase?, visible: Bool?)] {
        var rows: [(JourneyRouteState, JourneyWorkspacePhase?, Bool?)] = []
        for route in routeStates {
            for phase in subPhases {
                for visible in visibilities { rows.append((route, phase, visible)) }
            }
        }
        return rows
    }

    /// A presentation that is trying to be the playback surface.
    static func looksLikePlayback(_ p: JourneyPresentation) -> Bool {
        p.primaryAction == .pause || p.primaryAction == .resume
            || p.secondaryActions.contains(.stop)
    }

    // MARK: - §3.1 / §14.1 one prominent action

    @Test("Every input combination resolves to at most one prominent action")
    func singleProminentAction() {
        for row in Self.matrix {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: row.visible), route: row.route, phase: row.phase)
            #expect(
                presentation.prominentActions.count <= 1,
                "\(row) produced \(presentation.prominentActions)")
        }
    }

    @Test("No secondary action contradicts or duplicates the primary")
    func noConflictingSecondaries() {
        for row in Self.matrix {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: row.visible), route: row.route, phase: row.phase)
            #expect(
                presentation.conflictingSecondaryActions.isEmpty,
                "\(row) produced \(presentation.conflictingSecondaryActions)")
        }
    }

    @Test("Workspace surfaces also carry at most one prominent action")
    func workspaceSingleProminentAction() {
        let phases: [JourneyWorkspacePhase] = [
            .loading, .empty, .browsing, .selected,
            .editing(isDirty: true, isValid: true),
            .resolving(completed: nil, total: nil),
            .resolving(completed: 2, total: 5),
            .playing(progress: 0.1, isPaused: false),
            .importing(completed: nil, total: nil),
            .importing(completed: 1, total: 4),
            .failed(.load("boom")), .failed(.importData("boom")),
            .failed(.save("boom")),
            .failed(.route(trainID: "t-1", section: nil, message: "boom")),
        ]
        for phase in phases {
            for search in [false, true] {
                for date in [false, true] {
                    let presentation = JourneyPresentationResolver.workspace(
                        phase: phase, hasSearchQuery: search, hasDateFilter: date)
                    #expect(presentation.prominentActions.count <= 1, "\(phase)")
                    #expect(presentation.conflictingSecondaryActions.isEmpty, "\(phase)")
                }
            }
        }
    }

    // MARK: - §2.1 / §8.4 playback may not pretend to be available

    @Test("An unresolved route always blocks playback")
    func unresolvedRouteBlocksPlayback() {
        for row in Self.matrix where row.route != .resolved {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: row.visible), route: row.route, phase: row.phase)
            #expect(presentation.blocksPlayback, "\(row) did not block playback")
        }
    }

    @Test("Starting playback while the route is unresolved never yields a playback surface")
    func playbackNeverFakedOverAnUnresolvedRoute() {
        let playing: [JourneyWorkspacePhase] = [
            .playing(progress: 0.32, isPaused: false),
            .playing(progress: 0.32, isPaused: true),
        ]
        for route in Self.routeStates where route != .resolved {
            for phase in playing {
                let presentation = JourneyPresentationResolver.selected(
                    train: Self.train(), route: route, phase: phase)
                #expect(
                    !Self.looksLikePlayback(presentation),
                    "\(route) + \(phase) produced a playback surface")
                // §2.1: the blocking reason must become the main state.
                #expect(presentation.status != nil, "\(route) lost its blocking reason")
            }
        }
    }

    @Test("A blocked surface never offers pause or resume")
    func blockedSurfacesOfferNoTransport() {
        for row in Self.matrix {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: row.visible), route: row.route, phase: row.phase)
            guard presentation.blocksPlayback else { continue }
            #expect(presentation.primaryAction != .pause, "\(row)")
            #expect(presentation.primaryAction != .resume, "\(row)")
            #expect(!presentation.secondaryActions.contains(.play), "\(row)")
        }
    }

    @Test("A resolved route under active playback is the only playback surface")
    func resolvedRoutePlaybackSurface() {
        let playing = JourneyPresentationResolver.selected(
            train: Self.train(), route: .resolved,
            phase: .playing(progress: 0.32, isPaused: false))
        #expect(playing.primaryAction == .pause)
        #expect(playing.secondaryActions.contains(.stop))
        #expect(!playing.blocksPlayback)

        let paused = JourneyPresentationResolver.selected(
            train: Self.train(), route: .resolved,
            phase: .playing(progress: 0.32, isPaused: true))
        #expect(paused.primaryAction == .resume)
        #expect(!paused.blocksPlayback)
    }

    // MARK: - Priority order

    @Test("Failure outranks editing, hiding, playback and route state")
    func failureOutranksEverything() {
        for route in Self.routeStates {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: false), route: route,
                phase: .failed(.save("id collision")))
            #expect(presentation.primaryAction == .save, "\(route)")
            #expect(presentation.status?.tone == .critical, "\(route)")
            #expect(presentation.blocksPlayback, "\(route)")
        }
    }

    @Test("Editing outranks hiding, playback and route state")
    func editingOutranksHiddenAndPlayback() {
        for route in Self.routeStates {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: false), route: route,
                phase: .editing(isDirty: true, isValid: true))
            #expect(presentation.primaryAction == .save, "\(route)")
            #expect(presentation.secondaryActions == [.cancel], "\(route)")
        }
    }

    @Test("Hiding outranks playback and route state")
    func hiddenOutranksPlaybackAndRoute() {
        for route in Self.routeStates {
            for phase in [
                nil, JourneyWorkspacePhase.playing(progress: 0.5, isPaused: false),
            ] {
                let presentation = JourneyPresentationResolver.selected(
                    train: Self.train(visible: false), route: route, phase: phase)
                #expect(presentation.primaryAction == .showOnMap, "\(route) \(String(describing: phase))")
                #expect(presentation.blocksPlayback)
                // §8.5: hiding is a map-only change and the copy has to say so.
                #expect(presentation.status?.title.key == "ios.journey.stillSaved")
                #expect(presentation.status?.detail?.key == "ios.journey.hiddenDetail")
            }
        }
    }

    @Test("Playback outranks the ordinary journey actions")
    func playbackOutranksNormal() {
        let normal = JourneyPresentationResolver.selected(
            train: Self.train(), route: .resolved, phase: nil)
        #expect(normal.primaryAction == .locate)
        let playing = JourneyPresentationResolver.selected(
            train: Self.train(), route: .resolved,
            phase: .playing(progress: 0.1, isPaused: false))
        #expect(playing.primaryAction == .pause)
        #expect(!playing.secondaryActions.contains(.duplicate))
    }

    @Test("visible == nil and visible == true are both shown")
    func visibilityDefault() {
        for visible in [nil, true] {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: visible), route: .resolved, phase: nil)
            #expect(presentation.primaryAction == .locate)
        }
    }

    // MARK: - §3.3 dynamic primary action table

    @Test("§3.3's primary action table")
    func primaryActionTable() {
        func primary(
            _ route: JourneyRouteState, _ phase: JourneyWorkspacePhase?, visible: Bool? = nil
        ) -> JourneyPresentation.PrimaryAction? {
            JourneyPresentationResolver.selected(
                train: Self.train(visible: visible), route: route, phase: phase
            ).primaryAction
        }
        #expect(primary(.resolved, nil) == .locate)
        #expect(primary(.resolved, .playing(progress: 0, isPaused: false)) == .pause)
        #expect(primary(.resolved, .playing(progress: 0, isPaused: true)) == .resume)
        #expect(primary(.resolved, nil, visible: false) == .showOnMap)
        #expect(primary(.needsReview(reason: "x"), nil) == .rebuildRoute)
        #expect(primary(.unavailable(reason: "x"), nil) == .rebuildRoute)
        #expect(primary(.resolved, .editing(isDirty: true, isValid: true)) == .save)
        // "编辑草稿无效 → 无 Prominent 按钮；保存禁用"
        #expect(primary(.resolved, .editing(isDirty: true, isValid: false)) == nil)
        // Nothing has changed yet, so there is nothing to save.
        #expect(primary(.resolved, .editing(isDirty: false, isValid: true)) == nil)
        // A solve already in flight has no button: §13.2, and pressing
        // "rebuild" against it would be a second answer to one question.
        #expect(primary(.resolving(completed: 1, total: 3), nil) == nil)
        #expect(primary(.unknown, nil) == nil)
    }

    // MARK: - §7.5 / §11.2 no permanent success badge

    @Test("A resolved route produces no status badge")
    func resolvedHasNoSuccessBadge() {
        let presentation = JourneyPresentationResolver.selected(
            train: Self.train(), route: .resolved, phase: nil)
        #expect(presentation.status == nil)
        #expect(!presentation.blocksPlayback)
        // §3.2's scan order: date is the eyebrow, the train number is the title.
        #expect(presentation.eyebrow == .value("2026-07-26"))
        #expect(presentation.title == .value("踊り子1号"))
    }

    @Test("No presentation ever emits a positive tone")
    func noPositiveTone() {
        for row in Self.matrix {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: row.visible), route: row.route, phase: row.phase)
            #expect(presentation.status?.tone != .positive, "\(row)")
        }
    }

    // MARK: - §1.1 the record survives and no straight line was drawn

    @Test("needsReview and unavailable both keep the record and disclaim a fake line")
    func failedRoutesPreserveTheRecord() {
        for route: JourneyRouteState in [
            .needsReview(reason: "大船 → 藤沢"), .unavailable(reason: "大船 → 藤沢"),
        ] {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(), route: route, phase: nil)
            #expect(presentation.status?.title.key == "ios.journey.recordUnchanged", "\(route)")
            #expect(presentation.status?.detail != nil, "\(route) said nothing about the geometry")
            #expect(presentation.subtitle == .value("大船 → 藤沢"), "\(route)")
            #expect(presentation.primaryAction == .rebuildRoute, "\(route)")
            // §8.4: editing the stops leads the quiet group, ahead of a retry loop.
            #expect(presentation.secondaryActions.first == .edit, "\(route)")
        }

        let unavailable = JourneyPresentationResolver.selected(
            train: Self.train(), route: .unavailable(reason: ""), phase: nil)
        // The shipped catalog already says "No fake straight line was drawn"
        // in all four languages; reusing it keeps one wording for one promise.
        #expect(unavailable.status?.detail?.key == "status.routeNoPath")
        #expect(unavailable.status?.tone == .critical)

        let review = JourneyPresentationResolver.selected(
            train: Self.train(), route: .needsReview(reason: ""), phase: nil)
        #expect(review.status?.tone == .caution)
        #expect(review.status?.detail?.key == "ios.journey.routePartial")
    }

    @Test("A route failure phase names the affected section")
    func routeFailureNamesTheSection() {
        let presentation = JourneyPresentationResolver.selected(
            train: Self.train(), route: .resolved,
            phase: .failed(.route(trainID: "t-1", section: "大船 → 藤沢", message: "no path")))
        #expect(presentation.subtitle?.key == "ios.journey.routeAffectedSection")
        #expect(presentation.subtitle?.params["section"] == .string("大船 → 藤沢"))
        #expect(presentation.status?.detail?.key == "status.routeNoPath")
        #expect(presentation.blocksPlayback)
    }

    // MARK: - §11.2 localization keys, not English

    @Test("Localizable text is returned as catalog keys; record values are not translated")
    func textIsReturnedAsKeys() {
        for row in Self.matrix {
            let presentation = JourneyPresentationResolver.selected(
                train: Self.train(visible: row.visible), route: row.route, phase: row.phase)
            for text in [
                presentation.eyebrow, presentation.subtitle,
                presentation.status?.title, presentation.status?.detail,
            ].compactMap({ $0 }) + [presentation.title] {
                // Either it is a catalog key, or it is a record value carrying
                // no key at all. What it must never be is finished English with
                // a key that does not exist.
                #expect(!text.fallback.isEmpty, "\(row) emitted empty text")
                if let key = text.key { #expect(!key.isEmpty, "\(row)") }
            }
            // Every action label resolves through the catalog too.
            if let primary = presentation.primaryAction {
                #expect(primary.label.key != nil)
            }
            for secondary in presentation.secondaryActions {
                #expect(secondary.label.key != nil)
            }
        }
    }

    @Test("Origin and destination travel as parameters, not as a baked string")
    func endpointsAreParameterised() {
        let presentation = JourneyPresentationResolver.selected(
            train: Self.train(origin: "東京", destination: "熱海"), route: .resolved, phase: nil)
        #expect(presentation.subtitle?.key == "ios.journey.endpoints")
        #expect(presentation.subtitle?.params["from"] == .string("東京"))
        #expect(presentation.subtitle?.params["to"] == .string("熱海"))
    }

    @Test("The resolving status names the train it is solving")
    func resolvingStatusNamesTheTrain() {
        let presentation = JourneyPresentationResolver.selected(
            train: Self.train(), route: .resolving(completed: 1, total: 3), phase: nil)
        #expect(presentation.status?.title.key == "status.routeGenerating")
        #expect(presentation.status?.title.params["train"] == .string("踊り子1号"))
        #expect(presentation.title.key == "ios.journey.routeBuilding")
        // unknown has not started anything, so it must not claim it has.
        let unknown = JourneyPresentationResolver.selected(
            train: Self.train(), route: .unknown, phase: nil)
        #expect(unknown.title.key == "ios.journey.routePreparing")
        #expect(unknown.status?.title.key == "ios.journey.routeNotReady")
    }

    @Test("The keys the resolver claims are already shipped really are keys it emits")
    func existingKeysAreTheOnesReused() {
        // Guards against the reverse mistake: a key listed as shipped that is
        // actually invented, which would ship as a raw identifier on screen.
        #expect(
            JourneyPresentationResolver.Keys.existing == [
                "status.routeGenerating", "status.routeNoPath", "status.importBusy",
                "ios.myRides", "ios.editJourney",
            ])
    }

    // MARK: - §13.1 / §13.2 workspace states

    @Test("Empty states each get one primary action, and it differs per cause")
    func emptyStates() {
        let none = JourneyPresentationResolver.workspace(phase: .empty)
        #expect(none.primaryAction == .add)
        let day = JourneyPresentationResolver.workspace(phase: .empty, hasDateFilter: true)
        #expect(day.primaryAction == .add)
        #expect(day.title.key == "ios.journey.emptyDateTitle")
        let search = JourneyPresentationResolver.workspace(
            phase: .empty, hasSearchQuery: true, hasDateFilter: true)
        #expect(search.primaryAction == .clearSearch)
        #expect(search.title.key == "ios.journey.emptySearchTitle")
    }

    @Test("Quantitative progress appears only when the total is known")
    func progressOnlyWhenKnown() {
        let unknown = JourneyPresentationResolver.workspace(
            phase: .importing(completed: nil, total: nil))
        #expect(unknown.subtitle == nil)
        let known = JourneyPresentationResolver.workspace(
            phase: .importing(completed: 1, total: 4))
        #expect(known.subtitle?.key == "ios.journey.progress")
        #expect(known.subtitle?.params["total"] == .number(4))
        #expect(known.blocksPlayback)
    }

    @Test("An import failure says nothing was imported")
    func importFailureKeepsExistingData() {
        let presentation = JourneyPresentationResolver.workspace(
            phase: .failed(.importData("trains[3].stops[1].name is empty")))
        #expect(presentation.primaryAction == .importData)
        #expect(presentation.status?.title.key == "ios.journey.importFailedKept")
        #expect(presentation.subtitle == .value("trains[3].stops[1].name is empty"))
    }

    // MARK: - Route state derived from what the store can observe

    @Test("Route state derived from RiddenRouteStore's observable signals")
    func routeStateDerivation() {
        #expect(
            JourneyRouteState.resolve(loadPhase: .idle, drawnSegmentCount: nil) == .unknown)
        #expect(
            JourneyRouteState.resolve(loadPhase: .loading, drawnSegmentCount: nil)
                == .resolving(completed: nil, total: nil))
        // Already drawn: a reload of the rest of the store does not un-draw it.
        #expect(
            JourneyRouteState.resolve(loadPhase: .loading, drawnSegmentCount: 4) == .resolved)
        #expect(
            JourneyRouteState.resolve(loadPhase: .loaded, drawnSegmentCount: 4) == .resolved)
        #expect(
            JourneyRouteState.resolve(loadPhase: .loaded, drawnSegmentCount: 0, reason: "r")
                == .unavailable(reason: "r"))
        #expect(
            JourneyRouteState.resolve(loadPhase: .loaded, drawnSegmentCount: nil, reason: "r")
                == .unavailable(reason: "r"))
        #expect(
            JourneyRouteState.resolve(loadPhase: .failed("bundle missing"), drawnSegmentCount: nil)
                == .unavailable(reason: "bundle missing"))
    }

    /// The honest half of the model.
    ///
    /// `RiddenRouteStore` today keeps one store-wide `LoadState` and a
    /// `[DrawnRide]`; a journey that failed to solve is simply absent from the
    /// array, and a journey that solved 4 of its 6 sections is present with 4
    /// segments and no record that 2 are missing. So with the data the app can
    /// actually supply at Slice 1 — `expectedSectionCount == nil` — the
    /// derivation can never reach `needsReview`, and this test pins that rather
    /// than papering over it. Slice 3 gives the store the section count; this
    /// assertion is what should change then.
    @Test("needsReview is unreachable until the store reports the expected section count")
    func needsReviewNeedsDataTheStoreDoesNotHaveYet() {
        for drawn in 1...8 {
            let state = JourneyRouteState.resolve(
                loadPhase: .loaded, drawnSegmentCount: drawn, expectedSectionCount: nil)
            #expect(state == .resolved)
        }
        // With the count, the partial case resolves correctly.
        #expect(
            JourneyRouteState.resolve(
                loadPhase: .loaded, drawnSegmentCount: 4, expectedSectionCount: 6,
                reason: "大船 → 藤沢") == .needsReview(reason: "大船 → 藤沢"))
        #expect(
            JourneyRouteState.resolve(
                loadPhase: .loaded, drawnSegmentCount: 6, expectedSectionCount: 6) == .resolved)
        #expect(
            JourneyRouteState.resolve(
                loadPhase: .loaded, drawnSegmentCount: 0, expectedSectionCount: 6, reason: "x")
                == .unavailable(reason: "x"))
    }

    @Test("A derived state feeds the resolver without ever unblocking playback wrongly")
    func derivationAndResolverAgree() {
        let phases: [RouteLoadPhase] = [.idle, .loading, .loaded, .failed("bundle missing")]
        for phase in phases {
            for drawn in [nil, 0, 3] as [Int?] {
                for expected in [nil, 3, 6] as [Int?] {
                    let route = JourneyRouteState.resolve(
                        loadPhase: phase, drawnSegmentCount: drawn, expectedSectionCount: expected)
                    let presentation = JourneyPresentationResolver.selected(
                        train: Self.train(), route: route, phase: nil)
                    #expect(presentation.blocksPlayback == (route != .resolved))
                    #expect(presentation.prominentActions.count <= 1)
                }
            }
        }
    }
}
