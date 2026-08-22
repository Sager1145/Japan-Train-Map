import CoreGraphics
import Foundation
import Observation

/// What shape, how tall and how heavily the playback film is encoded.
///
/// Ported from `app/public/app-playback-video.js`'s `SHAPES` / `QUALITIES` /
/// `BITRATES` and the three functions that turn a choice into an encode
/// (`cropFor`, `outputSize`, `bitrateFor`). The web app's three `<select>`s are
/// `#playback-shape`, `#playback-quality` and `#playback-bitrate`; until now
/// this app exported at one fixed setting — 1280×720 or 720×1280, 6 Mbps,
/// 30 fps — with nothing a reader could say about it.
///
/// The numbers are the web app's, not new ones, and the reasoning is worth
/// keeping with them because none of it is obvious from the values.
@MainActor
@Observable
final class VideoExportSettings {

    /// The SHAPE of the exported frame. The recorder takes the largest
    /// rectangle of this shape centred on the map, which loses nothing that
    /// matters: the playback camera keeps the train in that exact centre.
    enum Shape: String, CaseIterable, Identifiable {
        case square, wide, tall, native
        var id: String { rawValue }

        /// `0` means "whatever shape the map happens to be" — honest, and on a
        /// phone in portrait that is already a tall frame, so it is offered
        /// rather than assumed.
        var aspect: CGFloat {
            switch self {
            case .square: 1
            case .wide: 16.0 / 9.0
            case .tall: 9.0 / 16.0
            case .native: 0
            }
        }
    }

    /// A HEIGHT CEILING, never a target.
    ///
    /// The source is the map at its own device pixels, and upscaling a map —
    /// thin strokes and small type — buys a bigger file and a softer picture
    /// and nothing else. So `max` is "as tall as the source allows", bounded
    /// only so a 3× phone cannot ask for a 4K encode nobody wanted.
    enum Quality: String, CaseIterable, Identifiable {
        case q1080, q720, q540, qmax
        var id: String { rawValue }
        var cap: CGFloat {
            switch self {
            case .q1080: 1080
            case .q720: 720
            case .q540: 540
            case .qmax: 2160
            }
        }
    }

    /// Bits per pixel per second. Flat colour and hard edges need far less
    /// than live footage: 0.11 is already clean on this map, so `high` is
    /// headroom for re-encoding downstream and `small` is for sending over a
    /// messenger.
    enum Bitrate: String, CaseIterable, Identifiable {
        case high, standard, small
        var id: String { rawValue }
        var bitsPerPixel: Double {
            switch self {
            case .high: 0.2
            case .standard: 0.11
            case .small: 0.055
            }
        }
    }

    /// Every preset is 60 fps: the camera pans continuously for the whole run,
    /// and a continuous pan is the one thing 30 fps cannot carry — it judders
    /// in a way a cut-heavy video never would. The old exporter throttled
    /// itself to 30 and told the encoder 30.
    static let framesPerSecond = 60

    static let maxBitrate = 60_000_000.0
    static let minBitrate = 2_000_000.0

    var shape: Shape = .square
    var quality: Quality = .q1080
    var bitrate: Bitrate = .standard

    // MARK: - persistence

    /// Remembered between exports: choosing a shape and a bitrate once should
    /// be enough. Nothing here is part of the train store, so it lives beside
    /// the other presentation preferences.
    private static let storageKey = "playback-video-v1"

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        guard let saved = userDefaults.dictionary(forKey: Self.storageKey) else { return }
        shape = (saved["shape"] as? String).flatMap(Shape.init(rawValue:)) ?? shape
        quality = (saved["quality"] as? String).flatMap(Quality.init(rawValue:)) ?? quality
        bitrate = (saved["bitrate"] as? String).flatMap(Bitrate.init(rawValue:)) ?? bitrate
    }

    func persist() {
        userDefaults.set(
            ["shape": shape.rawValue, "quality": quality.rawValue, "bitrate": bitrate.rawValue],
            forKey: Self.storageKey)
    }

    // MARK: - turning a choice into an encode

    /// What the recorder will actually produce.
    struct Plan: Equatable {
        /// The rectangle of the map that is filmed, in the map view's own
        /// points.
        var crop: CGRect
        /// The encoded frame size, in pixels.
        var size: CGSize
        var bitsPerSecond: Double

        var pixelDescription: String { "\(Int(size.width))×\(Int(size.height))" }
        var megabitsPerSecond: Double { bitsPerSecond / 1_000_000 }
        /// Bytes for a film of `seconds`, which is what a reader actually wants
        /// to know before committing to a run that takes minutes.
        func bytes(forSeconds seconds: Double) -> Double {
            bitsPerSecond / 8 * max(0, seconds)
        }
    }

    /// `cropFor` + `outputSize` + `bitrateFor`, for a map of `sourceSize`
    /// points at `displayScale` pixels per point.
    func plan(sourceSize: CGSize, displayScale: CGFloat) -> Plan {
        let crop = Self.crop(in: sourceSize, aspect: shape.aspect)
        let size = Self.outputSize(
            crop: crop, displayScale: displayScale, cap: quality.cap)
        let raw = Double(size.width * size.height)
            * Double(Self.framesPerSecond) * bitrate.bitsPerPixel
        return Plan(
            crop: crop, size: size,
            bitsPerSecond: min(Self.maxBitrate, max(Self.minBitrate, raw)))
    }

    /// The largest rectangle of the requested shape that still fits INSIDE the
    /// map. Going outside it would pull in whatever is behind the panel, which
    /// is precisely what nobody wants in the file.
    static func crop(in source: CGSize, aspect: CGFloat) -> CGRect {
        let whole = CGRect(origin: .zero, size: source)
        guard aspect > 0, source.width > 0, source.height > 0 else { return whole }
        let have = source.width / source.height
        var width = source.width
        var height = source.height
        if aspect > have {
            height = source.width / aspect
        } else {
            width = source.height * aspect
        }
        return CGRect(
            x: ((source.width - width) / 2).rounded(),
            y: ((source.height - height) / 2).rounded(),
            width: width.rounded(),
            height: height.rounded())
    }

    /// Never upscale. The cap is a ceiling on the height and the source's own
    /// pixel height is the other one; the width follows from the crop's shape.
    static func outputSize(crop: CGRect, displayScale: CGFloat, cap: CGFloat) -> CGSize {
        let sourcePixels = crop.height * max(displayScale, 1)
        let height = min(cap, sourcePixels)
        guard crop.height > 0 else { return CGSize(width: 2, height: 2) }
        return CGSize(
            width: even(crop.width * height / crop.height),
            height: even(height))
    }

    /// H.264 requires even dimensions; an odd one is silently rounded by some
    /// encoders and rejected by others.
    static func even(_ value: CGFloat) -> CGFloat {
        max(2, (value / 2).rounded() * 2)
    }
}
