import Observation
import QuartzCore
import RailCore
import UIKit

struct PlaybackMapSnapshot: Sendable {
    let path: Playback.Path
    let frame: Playback.Frame
    let autoFocus: Bool
    /// The journeys this run has already finished, still lit.
    ///
    /// `trailDone` in the web app: when a journey reaches its terminus its
    /// runs join a backlog, and the next journey's trail is drawn ON TOP of
    /// that rather than replacing it. Without it a five-journey day is five
    /// separate animations that each erase the one before, and what the run
    /// is actually about — the shape of a day, drawn one train at a time —
    /// never appears.
    var done: [DoneTrail] = []

    struct DoneTrail: Sendable {
        let coords: [Coordinate]
        let colorHex: String
    }
}

@MainActor
protocol PlaybackMapRendering: AnyObject {
    func renderPlayback(_ snapshot: PlaybackMapSnapshot?)
    /// Frame an extent while the transport owns the camera — the opening
    /// whole-scope overview, the ease onto the first journey, and the closing
    /// panorama.
    ///
    /// `maxZoom` is a MapLibre zoom, as everything ported from
    /// `Playback.Tuning` is: it is a floor on how far IN the move may go, so a
    /// single short journey does not open on a street corner.
    ///
    /// Duration is not a parameter, and cannot honestly be one: MapKit's
    /// camera takes `animated:` and nothing else (§9.4). The transport still
    /// waits the ported number of milliseconds before it starts the clock, so
    /// the CHOREOGRAPHY is the web app's even where the easing curve is
    /// Apple's.
    func framePlayback(coordinates: [Coordinate], maxZoom: Double, animated: Bool)
}

/// Native owner of the main fork's parity-tested playback clock. The pure
/// path, pacing, station and camera arithmetic remains in RailCore; this type
/// owns the queue, CADisplayLink lifecycle and player-bar state.
@MainActor
@Observable
final class PlaybackController {
    enum Phase: Equatable {
        case idle
        /// Queued and framed, waiting for the reader to press play.
        ///
        /// Pressing 播放行程 does not start a run; it shows the reader what
        /// they are about to watch. The map pulls back to the whole scope, the
        /// transport appears, and the run begins on the play button — which is
        /// the web app's own two-step (`start()` arms and fits, `begin()` runs)
        /// and the reason a queue of forty journeys does not open by flying to
        /// a station nobody recognises.
        case armed
        case playing
        case paused
        case transitioning
        case ended
    }

    private(set) var phase: Phase = .idle
    private(set) var queueIndex = 0
    private(set) var queueCount = 0
    private(set) var progress = 0.0
    private(set) var currentTrainID: String?
    private(set) var title = ""
    private(set) var stationName = ""
    private(set) var plan: Playback.Plan?
    private(set) var exportFrameSerial = 0
    var speed = 1.0 { didSet { speed = Playback.clampSpeed(speed) } }
    var autoFocus = true

    /// `restoreSelected` — the selection this run interrupted.
    ///
    /// Held here rather than at the entry points because there are four of
    /// them (the journeys transport, the keyboard shortcut, Passport's replay,
    /// the video export) and a run started from any of them moves the
    /// selection from journey to journey as it plays. One of the four
    /// remembering and the others not is how stopping puts the reader
    /// somewhere they never were.
    ///
    /// Read and cleared by whoever owns the selection — this type cannot see
    /// it, which is also why it is passed in rather than captured.
    @ObservationIgnored var restoreSelectedTrainID: String?

    @ObservationIgnored weak var mapRenderer: PlaybackMapRendering?
    @ObservationIgnored var onFrame: ((PlaybackMapSnapshot) -> Void)?
    @ObservationIgnored var onFinish: (() -> Void)?

    private struct Entry {
        let train: Train
        let path: Playback.Path
    }

    @ObservationIgnored private var queue: [Entry] = []
    /// See ``PlaybackMapSnapshot/done``.
    @ObservationIgnored private var doneTrails: [PlaybackMapSnapshot.DoneTrail] = []
    @ObservationIgnored private var playhead = Playback.Playhead()
    @ObservationIgnored private var displayLink: CADisplayLink?
    @ObservationIgnored private var clockTarget: ClockTarget?
    @ObservationIgnored private var reducedMotion = false
    @ObservationIgnored private var transitionTask: Task<Void, Never>?
    /// The camera moves the clock waits on: the opening overview, the intro
    /// ease and the closing panorama. Separate from `transitionTask`, which is
    /// the hold between two journeys, because a stop has to cancel both and a
    /// skip only the second.
    @ObservationIgnored private var cameraTask: Task<Void, Never>?

    var isActive: Bool { phase != .idle && phase != .ended }
    /// Whether the transport is waiting on the reader rather than running.
    var isArmed: Bool { phase == .armed }
    var isPlaying: Bool { phase == .playing }
    var canGoPrevious: Bool { queueIndex > 0 }
    var canGoNext: Bool { queueIndex + 1 < queueCount }

    func prepare(
        trains: [Train], rides: [RiddenRouteStore.DrawnRide], reducedMotion: Bool
    ) -> Playback.Plan {
        let ridesByID = Dictionary(uniqueKeysWithValues: rides.map { ($0.id, $0) })
        var compiled: [Playback.Path?] = []
        var entries: [Entry] = []
        for train in trains {
            let path = ridesByID[train.id].flatMap { ride in
                Playback.compile(train: train, features: playbackFeatures(train: train, ride: ride))
            }
            compiled.append(path)
            if let path { entries.append(Entry(train: train, path: path)) }
        }
        let result = Playback.plan(compiled: compiled, speed: speed)
        queue = entries
        queueCount = entries.count
        plan = result
        self.reducedMotion = reducedMotion
        return result
    }

    /// Arm a run: freeze the queue and open on the whole of it.
    ///
    /// `autoBegin` is for the video export, where nobody is going to press
    /// play — the overview still happens, and the run starts once that move
    /// has landed.
    @discardableResult
    func start(
        trains: [Train], rides: [RiddenRouteStore.DrawnRide], reducedMotion: Bool,
        restoringSelection: String? = nil, autoBegin: Bool = false
    ) -> Bool {
        stop(clearPlan: false)
        restoreSelectedTrainID = restoringSelection
        doneTrails = []
        let result = prepare(trains: trains, rides: rides, reducedMotion: reducedMotion)
        guard result.trains > 0 else {
            phase = .ended
            return false
        }
        queueIndex = 0
        progress = 0
        stationName = ""
        // Named before it runs: an armed transport showing a blank caption
        // would be a control that has not said what it is about to play.
        title = queue.first.map(Self.title(of:)) ?? ""
        currentTrainID = nil
        phase = .armed

        let overview = reducedMotion ? 0 : Playback.Tuning.overviewMilliseconds
        mapRenderer?.framePlayback(
            coordinates: Self.sampled(queue.flatMap { $0.path.runs.flatMap(\.coords) }),
            maxZoom: Playback.Tuning.overviewMaxZoom,
            animated: !reducedMotion)
        guard autoBegin else { return true }
        cameraTask?.cancel()
        cameraTask = Task { [weak self] in
            // The `+ 120` is the web app's: the move has to have LANDED, not
            // merely have been asked for, before the first frame is filmed.
            try? await Task.sleep(for: .milliseconds(Int(overview) + 120))
            guard !Task.isCancelled else { return }
            self?.begin()
        }
        return true
    }

    /// Pressing play on an armed run.
    func begin() {
        guard phase == .armed else { return }
        cameraTask?.cancel()
        cameraTask = nil
        beginCurrent(intro: true)
    }

    func togglePause() {
        switch phase {
        case .armed:
            begin()
        case .playing:
            invalidateClock()
            phase = .paused
        case .paused:
            playhead.startClock(atMilliseconds: CACurrentMediaTime() * 1000)
            phase = .playing
            startClock()
        default:
            break
        }
    }

    func previous() {
        guard canGoPrevious else { return }
        transitionTask?.cancel()
        cameraTask?.cancel()
        queueIndex -= 1
        beginCurrent()
    }

    func next() {
        guard canGoNext else {
            finishQueue()
            return
        }
        transitionTask?.cancel()
        cameraTask?.cancel()
        queueIndex += 1
        beginCurrent()
    }

    func stop(clearPlan: Bool = true) {
        transitionTask?.cancel()
        cameraTask?.cancel()
        cameraTask = nil
        invalidateClock()
        mapRenderer?.renderPlayback(nil)
        queue = []
        queueIndex = 0
        queueCount = 0
        doneTrails = []
        progress = 0
        currentTrainID = nil
        title = ""
        stationName = ""
        phase = .idle
        if clearPlan { plan = nil }
    }

    func setSpeed(_ value: Double) {
        speed = Playback.clampSpeed(value)
    }

    /// Hand the camera to one journey.
    ///
    /// `intro` is the FIRST of a run: the camera closes in on the starting
    /// frame and the clock waits for it. Every hand-off after that does the
    /// opposite — starts immediately and lets the camera catch up — because
    /// mid-queue there is already a train on screen carrying the eye, and at
    /// the very start of a run there is not.
    private func beginCurrent(intro: Bool = false) {
        guard queue.indices.contains(queueIndex) else { return }
        invalidateClock()
        cameraTask?.cancel()
        let entry = queue[queueIndex]
        currentTrainID = entry.train.id
        title = Self.title(of: entry)
        stationName = ""
        progress = 0
        playhead = Playback.Playhead()

        guard intro, let start = entry.path.start, !reducedMotion else {
            runClock()
            return
        }
        mapRenderer?.framePlayback(
            coordinates: [start], maxZoom: entry.path.zoom, animated: true)
        cameraTask = Task { [weak self] in
            try? await Task.sleep(
                for: .milliseconds(Int(Playback.Tuning.introMilliseconds)))
            guard !Task.isCancelled else { return }
            self?.runClock()
        }
    }

    /// Start the clock on whatever `beginCurrent` set up.
    private func runClock() {
        guard queue.indices.contains(queueIndex) else { return }
        playhead.startClock(atMilliseconds: CACurrentMediaTime() * 1000)
        phase = .playing
        startClock()
    }

    private static func title(of entry: Entry) -> String {
        let number = entry.train.number.isEmpty ? entry.train.id : entry.train.number
        return "\(number)  \(entry.train.origin) → \(entry.train.destination)"
    }

    /// A bounding box needs every vertex; a bounding box of a national day
    /// does not need a hundred thousand of them.
    private static func sampled(_ coordinates: [Coordinate]) -> [Coordinate] {
        let limit = 2000
        guard coordinates.count > limit else { return coordinates }
        let step = coordinates.count / limit + 1
        var kept = Swift.stride(from: 0, to: coordinates.count, by: step).map { coordinates[$0] }
        if let last = coordinates.last, kept.last != last { kept.append(last) }
        return kept
    }

    private func tick(timestamp: CFTimeInterval) {
        guard phase == .playing, queue.indices.contains(queueIndex) else { return }
        let entry = queue[queueIndex]
        let shortSide = Double(min(
            mapRendererViewSize?.width ?? 390,
            mapRendererViewSize?.height ?? 844))
        let frame = playhead.advance(
            nowMilliseconds: timestamp * 1000,
            path: entry.path, speed: speed,
            shortSidePixels: max(shortSide, 1), reducedMotion: reducedMotion)
        progress = min(max(frame.progress, 0), 1)
        if frame.stations.index >= 0, frame.stations.index < entry.path.stations.count {
            stationName = entry.path.stations[frame.stations.index].name
        }
        let snapshot = PlaybackMapSnapshot(
            path: entry.path, frame: frame, autoFocus: autoFocus, done: doneTrails)
        mapRenderer?.renderPlayback(snapshot)
        exportFrameSerial &+= 1
        onFrame?(snapshot)
        if frame.finished { holdThenAdvance() }
    }

    /// The renderer is normally the map coordinator. Its view size is exposed
    /// through the controller bridge so the parity camera law uses the actual
    /// short side, like the web implementation.
    @ObservationIgnored var mapRendererViewSize: CGSize?

    private func holdThenAdvance() {
        invalidateClock()
        phase = .transitioning
        // `finishTrain`: the whole journey is covered now, so it joins the lit
        // backlog before the queue moves on. Only a journey that RAN to its
        // terminus does — skipping past one with the transport's next button
        // leaves it unlit, because it was not watched.
        if queue.indices.contains(queueIndex) {
            let entry = queue[queueIndex]
            doneTrails += entry.path.runs.map {
                PlaybackMapSnapshot.DoneTrail(coords: $0.coords, colorHex: entry.path.color)
            }
        }
        transitionTask?.cancel()
        transitionTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(
                Int(Playback.Tuning.terminusHoldMilliseconds)))
            guard !Task.isCancelled, let self else { return }
            if self.canGoNext {
                self.queueIndex += 1
                self.beginCurrent()
            } else {
                self.finishQueue()
            }
        }
    }

    /// The run is over: hold the playhead where it stopped, pull back to the
    /// whole of what was watched, and only then tell anyone.
    ///
    /// The playhead STAYS at the terminus through the closing overview — it is
    /// where the journey ended. The announcement waits for the move plus its
    /// hold rather than firing the instant the last metre is covered, because
    /// a run that ends by cutting away is a run with no ending.
    private func finishQueue() {
        invalidateClock()
        phase = .ended
        progress = 1
        // Everything the run covered, which is the backlog plus the journey
        // that just finished joining it.
        mapRenderer?.framePlayback(
            coordinates: Self.sampled(doneTrails.flatMap(\.coords)),
            maxZoom: Playback.Tuning.finaleMaxZoom,
            animated: !reducedMotion)
        let hold = (reducedMotion ? 0 : Playback.Tuning.finaleMilliseconds)
            + Playback.Tuning.finaleHoldMilliseconds
        cameraTask?.cancel()
        cameraTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(hold)))
            guard !Task.isCancelled else { return }
            self?.onFinish?()
        }
    }

    private func startClock() {
        let target = ClockTarget { [weak self] link in self?.tick(timestamp: link.timestamp) }
        let link = CADisplayLink(target: target, selector: #selector(ClockTarget.fire(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        clockTarget = target
        displayLink = link
    }

    private func invalidateClock() {
        displayLink?.invalidate()
        displayLink = nil
        clockTarget = nil
    }

    private func playbackFeatures(
        train: Train, ride: RiddenRouteStore.DrawnRide
    ) -> [Playback.RiddenFeature] {
        let stops = train.stops.map {
            Statistics.Stop(
                arrival: $0.arrival, departure: $0.departure,
                stopType: $0.stopType, rideSegment: $0.rideSegment)
        }
        return ride.segments.sorted { $0.segmentIndex < $1.segmentIndex }.map { segment in
            Playback.RiddenFeature(
                geometry: .lineString(segment.coordinates),
                rideSegment: Statistics.isRideSegment(stops, segmentIndex: segment.segmentIndex),
                segmentIndex: Double(segment.segmentIndex))
        }
    }

    private final class ClockTarget: NSObject {
        let callback: (CADisplayLink) -> Void
        init(callback: @escaping (CADisplayLink) -> Void) { self.callback = callback }
        @objc func fire(_ link: CADisplayLink) { callback(link) }
    }
}
