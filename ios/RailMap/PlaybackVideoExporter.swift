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
        case finished(URL)
        case failed(String)
    }

    private(set) var state: State = .idle
    private(set) var progress = 0.0

    @ObservationIgnored private var writer: AVAssetWriter?
    @ObservationIgnored private var input: AVAssetWriterInput?
    @ObservationIgnored private var adapter: AVAssetWriterInputPixelBufferAdaptor?
    @ObservationIgnored private weak var mapView: UIView?
    @ObservationIgnored private weak var playback: PlaybackController?
    @ObservationIgnored private var outputURL: URL?
    @ObservationIgnored private var startedAt: CFTimeInterval = 0
    @ObservationIgnored private var lastFrameAt: CFTimeInterval = -.infinity
    @ObservationIgnored private var outputSize = CGSize.zero

    var isRecording: Bool { state == .recording || state == .finishing }

    func start(
        playback: PlaybackController,
        mapView: UIView,
        trains: [Train],
        rides: [RiddenRouteStore.DrawnRide],
        reducedMotion: Bool
    ) {
        cancel(clearPlayback: false)
        do {
            let size = Self.videoSize(for: mapView.bounds.size)
            let url = FileManager.default.temporaryDirectory
                .appending(path: "RailMap-\(UUID().uuidString).mp4")
            let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(size.width),
                AVVideoHeightKey: Int(size.height),
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 6_000_000,
                    AVVideoExpectedSourceFrameRateKey: 30,
                    AVVideoMaxKeyFrameIntervalKey: 60,
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
            self.progress = 0
            self.state = .recording

            playback.onFrame = { [weak self] snapshot in
                self?.append(snapshot)
            }
            playback.onFinish = { [weak self] in self?.finish() }
            guard playback.start(
                trains: trains, rides: rides, reducedMotion: reducedMotion)
            else { throw ExportError.noPlayableGeometry }
        } catch {
            fail(error)
        }
    }

    func cancel(clearPlayback: Bool = true) {
        playback?.onFrame = nil
        playback?.onFinish = nil
        if clearPlayback { playback?.stop() }
        writer?.cancelWriting()
        if let outputURL { try? FileManager.default.removeItem(at: outputURL) }
        resetWriter()
        state = .idle
        progress = 0
    }

    private func append(_ snapshot: PlaybackMapSnapshot) {
        guard state == .recording, let input, input.isReadyForMoreMediaData,
              let adapter, let pool = adapter.pixelBufferPool,
              let mapView else { return }
        let now = CACurrentMediaTime()
        guard now - lastFrameAt >= 1.0 / 30.0 else { return }
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

        let sourceSize = mapView.bounds.size
        let scale = min(outputSize.width / max(sourceSize.width, 1),
                        outputSize.height / max(sourceSize.height, 1))
        let dx = (outputSize.width - sourceSize.width * scale) / 2
        let dy = (outputSize.height - sourceSize.height * scale) / 2
        context.setFillColor(UIColor.black.cgColor)
        context.fill(CGRect(origin: .zero, size: outputSize))
        context.saveGState()
        context.translateBy(x: dx, y: outputSize.height - dy)
        context.scaleBy(x: scale, y: -scale)
        mapView.layer.render(in: context)
        drawCaption(snapshot, in: context, viewSize: sourceSize)
        context.restoreGState()

        let elapsed = max(0, now - startedAt)
        adapter.append(buffer, withPresentationTime: CMTime(seconds: elapsed, preferredTimescale: 600))
        progress = snapshot.frame.progress
    }

    private func drawCaption(
        _ snapshot: PlaybackMapSnapshot, in context: CGContext, viewSize: CGSize
    ) {
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        let margin: CGFloat = 18
        let height: CGFloat = 84
        let box = CGRect(
            x: margin, y: viewSize.height - height - margin,
            width: max(viewSize.width - margin * 2, 1), height: height)
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

    private func completeFinish(outputURL: URL) {
        guard let writer else { return }
        if writer.status == .completed {
            resetWriter()
            progress = 1
            state = .finished(outputURL)
        } else {
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

    private static func videoSize(for source: CGSize) -> CGSize {
        let landscape = source.width > source.height
        return landscape ? CGSize(width: 1280, height: 720) : CGSize(width: 720, height: 1280)
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
