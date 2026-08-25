// Frame-level inspection of a `simctl io … recordVideo` capture.
//
// Motion cannot be reviewed from a still, and there is no ffmpeg on this
// machine — so this is the smallest thing that answers the two questions a
// motion review actually asks:
//
//   scan <mov> [fps]                 per-frame mean-absolute-difference
//                                    timeline, so a transition can be FOUND
//                                    rather than guessed at. Contiguous
//                                    entries at 1/fps spacing mean every frame
//                                    changed — i.e. nothing was dropped.
//   dump <mov> <t0> <t1> <n> <dir>   n PNGs evenly spaced across [t0, t1]
//
// Build:  swiftc -O frames.swift -o frames
// Record: xcrun simctl io <udid> recordVideo --codec h264 out.mov
//
// The difference metric is deliberately crude — a downsampled grey mean-abs
// diff. It is not measuring quality, only "did this frame move", which is all
// that is needed to locate the window worth looking at.

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(
        Data("usage: frames scan <mov> [fps] | frames dump <mov> <t0> <t1> <n> <dir>\n".utf8))
    exit(2)
}
let mode = args[1]
let asset = AVURLAsset(url: URL(fileURLWithPath: args[2]))

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
// Exact frames: the default tolerance snaps to keyframes, which for a 400 ms
// event means every request returns the same picture.
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

func duration() -> Double {
    let sem = DispatchSemaphore(value: 0)
    var seconds = 0.0
    Task {
        seconds = (try? await asset.load(.duration).seconds) ?? 0
        sem.signal()
    }
    sem.wait()
    return seconds
}

func image(at seconds: Double) -> CGImage? {
    try? generator.copyCGImage(
        at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
}

/// A small grey buffer — enough to tell movement from stillness.
func grey(_ image: CGImage, side: Int = 96) -> [UInt8] {
    var buffer = [UInt8](repeating: 0, count: side * side)
    let space = CGColorSpaceCreateDeviceGray()
    guard let context = CGContext(
        data: &buffer, width: side, height: side, bitsPerComponent: 8,
        bytesPerRow: side, space: space,
        bitmapInfo: CGImageAlphaInfo.none.rawValue)
    else { return buffer }
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    return buffer
}

func meanAbsDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return 0 }
    var total = 0
    for index in a.indices { total += abs(Int(a[index]) - Int(b[index])) }
    return Double(total) / Double(a.count)
}

switch mode {
case "scan":
    let fps = args.count > 3 ? Double(args[3]) ?? 30 : 30
    let total = duration()
    var previous: [UInt8]?
    var time = 0.0
    while time < total {
        guard let frame = image(at: time) else { time += 1 / fps; continue }
        let current = grey(frame)
        if let previous {
            let diff = meanAbsDiff(previous, current)
            if diff > 0.4 {  // still frames sit near zero
                print(String(format: "%.3f\t%.2f", time, diff))
            }
        }
        previous = current
        time += 1 / fps
    }

case "dump":
    guard args.count >= 7, let t0 = Double(args[3]), let t1 = Double(args[4]),
        let count = Int(args[5])
    else { exit(2) }
    let dir = args[6]
    try? FileManager.default.createDirectory(
        atPath: dir, withIntermediateDirectories: true)
    for index in 0..<count {
        let t = count == 1 ? t0 : t0 + (t1 - t0) * Double(index) / Double(count - 1)
        guard let frame = image(at: t) else { continue }
        let path = "\(dir)/f\(String(format: "%02d", index))-\(String(format: "%.3f", t)).png"
        guard let dest = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { continue }
        CGImageDestinationAddImage(dest, frame, nil)
        CGImageDestinationFinalize(dest)
        print(path)
    }

default:
    exit(2)
}
