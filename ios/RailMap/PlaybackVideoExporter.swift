import AVFoundation
import Observation
import RailCore
import UIKit

/// Records the native MapKit playback into an H.264 movie. Unlike the web
/// captureStream path, every frame is rendered directly into an AVAssetWriter
/// pixel buffer, with the journey caption and progress burned into the image.
@MainActor
@Observable
final class PlaybackVideoExporter {
    enum State: Equatable {
        case idle
        case recording
        case finishing
        /// `partial` is the run that was cancelled part-way. The file is
        /// still written and still offered — `video.readyPartial` in the web
        /// app, whose cancel "stop[s] the recorder — the partial file is still
        /// written rather than thrown away". Minutes of rendering deleted
        /// because the reader stopped a few seconds early is a worse answer
        /// than a shorter film.
        case finished(URL, partial: Bool = false)
        case failed(String)
    }

    private(set) var state: State = .idle
    private(set) var progress = 0.0

    /// Frames actually written. A cancel with none of them has no film to
    /// keep, only a zero-length file that no player will open.
    @ObservationIgnored private var appendedFrames = 0

    @ObservationIgnored private var writer: AVAssetWriter?
    @ObservationIgnored private var input: AVAssetWriterInput?
    @ObservationIgnored private var adapter: AVAssetWriterInputPixelBufferAdaptor?
    @ObservationIgnored private weak var mapView: UIView?
    @ObservationIgnored private weak var playback: PlaybackController?
    @ObservationIgnored private var outputURL: URL?
    @ObservationIgnored private var startedAt: CFTimeInterval = 0
    @ObservationIgnored private var lastFrameAt: CFTimeInterval = -.infinity
    @ObservationIgnored private var outputSize = CGSize.zero
    /// The rectangle of the map being filmed, in the map view's own points.
    /// The whole view until a shape narrows it — see `VideoExportSettings`.
    @ObservationIgnored private var crop = CGRect.zero
    @ObservationIgnored private var frameInterval = 1.0 / 60.0

    var isRecording: Bool { state == .recording || state == .finishing }

    func start(
        playback: PlaybackController,
        mapView: UIView,
        trains: [Train],
        rides: [RiddenRouteStore.DrawnRide],
        reducedMotion: Bool,
        settings: VideoExportSettings
    ) {
        cancel(clearPlayback: false)
        do {
            // The WHOLE map view, where the web app films only the map the
            // menu is not covering (`uncoveredRect`).
            //
            // That is not an oversight and it is not a shortcut: the web app
            // crops there because its playback camera PADS for the menu and
            // therefore centres the train in the uncovered part. This one does
            // not — `mapRendererViewSize` is the full view — so filming a
            // smaller rectangle would take the train off centre in the file.
            // The crop and the camera have to agree about where the middle is;
            // the day the camera learns about the panel, this should follow it.
            let plan = settings.plan(
                sourceSize: mapView.bounds.size,
                displayScale: mapView.window?.screen.scale ?? UIScreen.main.scale)
            let size = plan.size
            crop = plan.crop
            frameInterval = 1.0 / Double(VideoExportSettings.framesPerSecond)
            let url = FileManager.default.temporaryDirectory
                .appending(path: "RailMap-\(UUID().uuidString).mp4")
            let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(size.width),
                AVVideoHeightKey: Int(size.height),
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: Int(plan.bitsPerSecond),
                    AVVideoExpectedSourceFrameRateKey: VideoExportSettings.framesPerSecond,
                    AVVideoMaxKeyFrameIntervalKey: VideoExportSettings.framesPerSecond * 2,
                ],
            ]
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            input.expectsMediaDataInRealTime = true
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: Int(size.width),
                kCVPixelBufferHeightKey as String: Int(size.height),
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
            let adapter = AVAssetWriterInputPixelBufferAdaptor(
                assetWriterInput: input, sourcePixelBufferAttributes: attributes)
            guard writer.canAdd(input) else { throw ExportError.cannotAddInput }
            writer.add(input)
            guard writer.startWriting() else {
                throw writer.error ?? ExportError.cannotStartWriter
            }
            writer.startSession(atSourceTime: .zero)

            self.writer = writer
            self.input = input
            self.adapter = adapter
            self.mapView = mapView
            self.playback = playback
            self.outputURL = url
            self.outputSize = size
            self.startedAt = CACurrentMediaTime()
            self.lastFrameAt = -.infinity
            self.appendedFrames = 0
            self.progress = 0
            self.state = .recording

            playback.onFrame = { [weak self] snapshot in
                self?.append(snapshot)
            }
            playback.onFinish = { [weak self] in self?.finish() }
            // `autoBegin`: nobody is going to press play on a recording, so
            // the run begins once the opening overview has landed.
            guard playback.start(
                trains: trains, rides: rides, reducedMotion: reducedMotion,
                autoBegin: true)
            else { throw ExportError.noPlayableGeometry }
        } catch {
            fail(error)
        }
    }

    /// Stop early and keep what was filmed.
    ///
    /// The writer is FINISHED rather than cancelled: `cancelWriting` leaves no
    /// readable file, so a reader who stopped a five-minute export at four
    /// minutes was left with nothing at all. What has been appended so far is
    /// a valid film of the part that ran, and it is offered as one — marked
    /// partial so the offer does not claim to be the whole run.
    ///
    /// A cancel before the first frame lands has nothing to finish, and that
    /// path still discards the empty file rather than offering an unplayable
    /// one.
    func cancel(clearPlayback: Bool = true) {
        playback?.onFrame = nil
        playback?.onFinish = nil
        if clearPlayback { playback?.stop() }

        guard state == .recording, let writer, let input, let outputURL,
            writer.status == .writing, appendedFrames > 0
        else {
            writer?.cancelWriting()
            if let outputURL { try? FileManager.default.removeItem(at: outputURL) }
            resetWriter()
            state = .idle
            progress = 0
            return
        }
        state = .finishing
        input.markAsFinished()
        writer.finishWriting { [weak self] in
            Task { @MainActor [weak self] in
                self?.completeFinish(outputURL: outputURL, partial: true)
            }
        }
    }

    private func append(_ snapshot: PlaybackMapSnapshot) {
        guard state == .recording, let input, input.isReadyForMoreMediaData,
              let adapter, let pool = adapter.pixelBufferPool,
              let mapView else { return }
        let now = CACurrentMediaTime()
        guard now - lastFrameAt >= frameInterval else { return }
        lastFrameAt = now
        var optionalBuffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &optionalBuffer) == kCVReturnSuccess,
              let buffer = optionalBuffer else { return }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        guard let context = CGContext(
            data: base, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return }

        // The crop FILLS the frame rather than being letterboxed into it: it
        // was chosen to have the frame's shape precisely so there are no bars.
        // A `native` shape makes the crop the whole view and this is a plain
        // scale, which is what the old code did for every shape.
        let filmed = crop.isEmpty ? CGRect(origin: .zero, size: mapView.bounds.size) : crop
        let scale = outputSize.width / max(filmed.width, 1)
        context.setFillColor(UIColor.black.cgColor)
        context.fill(CGRect(origin: .zero, size: outputSize))
        context.saveGState()
        // Flip into UIKit's orientation, then shift so the crop's top-left
        // corner — not the view's — lands on the frame's.
        context.translateBy(x: -filmed.minX * scale, y: outputSize.height + filmed.minY * scale)
        context.scaleBy(x: scale, y: -scale)
        mapView.layer.render(in: context)
        drawCaption(snapshot, in: context, filmed: filmed)
        context.restoreGState()

        let elapsed = max(0, now - startedAt)
        adapter.append(buffer, withPresentationTime: CMTime(seconds: elapsed, preferredTimescale: 600))
        appendedFrames += 1
        progress = snapshot.frame.progress
    }

    private func drawCaption(
        _ snapshot: PlaybackMapSnapshot, in context: CGContext, filmed: CGRect
    ) {
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        // Placed against the FILMED rectangle, not the whole view: a square
        // crop of a phone in portrait discards a third of the height at the
        // bottom, and a caption laid out against the view would be cropped
        // straight out of the picture it is captioning.
        let margin: CGFloat = 18
        let height: CGFloat = 84
        let box = CGRect(
            x: filmed.minX + margin, y: filmed.maxY - height - margin,
            width: max(filmed.width - margin * 2, 1), height: height)
        UIColor.black.withAlphaComponent(0.72).setFill()
        UIBezierPath(roundedRect: box, cornerRadius: 16).fill()

        let title = playback?.title ?? ""
        let station = playback?.stationName ?? ""
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        (title as NSString).draw(
            in: box.insetBy(dx: 14, dy: 11),
            withAttributes: [
                .font: UIFont.systemFont(ofSize: 15, weight: .semibold),
                .foregroundColor: UIColor.white,
                .paragraphStyle: paragraph,
            ])
        if !station.isEmpty {
            (station as NSString).draw(
                at: CGPoint(x: box.minX + 14, y: box.minY + 36),
                withAttributes: [
                    .font: UIFont.systemFont(ofSize: 12, weight: .medium),
                    .foregroundColor: UIColor.white.withAlphaComponent(0.8),
                ])
        }
        let track = CGRect(x: box.minX + 14, y: box.maxY - 13, width: box.width - 28, height: 4)
        UIColor.white.withAlphaComponent(0.2).setFill()
        UIBezierPath(roundedRect: track, cornerRadius: 2).fill()
        let fill = CGRect(
            x: track.minX, y: track.minY,
            width: track.width * CGFloat(min(max(snapshot.frame.progress, 0), 1)),
            height: track.height)
        (Self.color(hex: snapshot.path.color) ?? .systemBlue).setFill()
        UIBezierPath(roundedRect: fill, cornerRadius: 2).fill()
    }

    private func finish() {
        guard state == .recording, let writer, let input, let outputURL else { return }
        state = .finishing
        playback?.onFrame = nil
        playback?.onFinish = nil
        input.markAsFinished()
        writer.finishWriting { [weak self] in
            Task { @MainActor [weak self] in self?.completeFinish(outputURL: outputURL) }
        }
    }

    private func completeFinish(outputURL: URL, partial: Bool = false) {
        guard let writer else { return }
        if writer.status == .completed {
            resetWriter()
            progress = 1
            state = .finished(outputURL, partial: partial)
        } else {
            // A partial film that will not close is not a failure the reader
            // caused — they asked to stop — but the file is unusable either
            // way, so it goes rather than being offered.
            try? FileManager.default.removeItem(at: outputURL)
            fail(writer.error ?? ExportError.cannotFinishWriter)
        }
    }

    private func fail(_ error: Error) {
        writer?.cancelWriting()
        playback?.onFrame = nil
        playback?.onFinish = nil
        resetWriter()
        state = .failed(error.localizedDescription)
    }

    private func resetWriter() {
        writer = nil
        input = nil
        adapter = nil
        mapView = nil
        playback = nil
        outputURL = nil
    }

    private static func color(hex: String) -> UIColor? {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6, let number = UInt32(value, radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((number >> 16) & 0xff) / 255,
            green: CGFloat((number >> 8) & 0xff) / 255,
            blue: CGFloat(number & 0xff) / 255, alpha: 1)
    }

    private enum ExportError: LocalizedError {
        case cannotAddInput
        case cannotStartWriter
        case cannotFinishWriter
        case noPlayableGeometry
        var errorDescription: String? {
            switch self {
            case .cannotAddInput: "The video encoder could not accept its input."
            case .cannotStartWriter: "The video encoder could not start."
            case .cannotFinishWriter: "The video encoder could not finish the movie."
            case .noPlayableGeometry: "No routed journey is available to record."
            }
        }
    }
}
