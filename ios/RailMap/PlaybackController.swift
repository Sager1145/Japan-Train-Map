import Observation
import QuartzCore
import RailCore
import UIKit

struct PlaybackMapSnapshot: Sendable {
    let path: Playback.Path
    let frame: Playback.Frame
    let autoFocus: Bool
}

@MainActor
protocol PlaybackMapRendering: AnyObject {
    func renderPlayback(_ snapshot: PlaybackMapSnapshot?)
}

/// Native owner of the main fork's parity-tested playback clock. The pure
/// path, pacing, station and camera arithmetic remains in RailCore; this type
/// owns the queue, CADisplayLink lifecycle and player-bar state.
@MainActor
@Observable
final class PlaybackController {
    enum Phase: Equatable {
        case idle
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

    @ObservationIgnored weak var mapRenderer: PlaybackMapRendering?
    @ObservationIgnored var onFrame: ((PlaybackMapSnapshot) -> Void)?
    @ObservationIgnored var onFinish: (() -> Void)?

    private struct Entry {
        let train: Train
        let path: Playback.Path
    }

    @ObservationIgnored private var queue: [Entry] = []
    @ObservationIgnored private var playhead = Playback.Playhead()
    @ObservationIgnored private var displayLink: CADisplayLink?
    @ObservationIgnored private var clockTarget: ClockTarget?
    @ObservationIgnored private var reducedMotion = false
    @ObservationIgnored private var transitionTask: Task<Void, Never>?

    var isActive: Bool { phase != .idle && phase != .ended }
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

    @discardableResult
    func start(
        trains: [Train], rides: [RiddenRouteStore.DrawnRide], reducedMotion: Bool
    ) -> Bool {
        stop(clearPlan: false)
        let result = prepare(trains: trains, rides: rides, reducedMotion: reducedMotion)
        guard result.trains > 0 else {
            phase = .ended
            return false
        }
        queueIndex = 0
        beginCurrent()
        return true
    }

    func togglePause() {
        switch phase {
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
        queueIndex -= 1
        beginCurrent()
    }

    func next() {
        guard canGoNext else {
            finishQueue()
            return
        }
        transitionTask?.cancel()
        queueIndex += 1
        beginCurrent()
    }

    func stop(clearPlan: Bool = true) {
        transitionTask?.cancel()
        invalidateClock()
        mapRenderer?.renderPlayback(nil)
        queue = []
        queueIndex = 0
        queueCount = 0
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

    private func beginCurrent() {
        guard queue.indices.contains(queueIndex) else { return }
        invalidateClock()
        let entry = queue[queueIndex]
        currentTrainID = entry.train.id
        title = "\(entry.train.number.isEmpty ? entry.train.id : entry.train.number)  \(entry.train.origin) → \(entry.train.destination)"
        stationName = ""
        progress = 0
        playhead = Playback.Playhead()
        playhead.startClock(atMilliseconds: CACurrentMediaTime() * 1000)
        phase = .playing
        startClock()
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
            path: entry.path, frame: frame, autoFocus: autoFocus)
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

    private func finishQueue() {
        invalidateClock()
        phase = .ended
        progress = 1
        onFinish?()
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
