// Rasterize the badge SVGs the branding tables name, because iOS cannot.
//
// `OperatorBranding` returns web paths verbatim — the rule is ported from
// JavaScript that hands them to an `<img>` — and 95 of the files those paths
// name are SVG. ImageIO ships no SVG decoder on iOS, so `UIImage` returns nil
// for every one of them and the station popup silently falls back to a colour
// swatch for about a quarter of its rows.
//
// This writes a PNG companion beside each SVG, under the SVG's own name plus
// `.png` — `q498366.svg` becomes `q498366.svg.png`. That suffix is deliberate:
// the loader derives it from the table's own answer with one string operation,
// so there is no second naming scheme to keep in step with the table, and the
// table is the part that decides which badge a railway draws.
//
//   swift ios/tools/rasterize-badge-svgs.swift            # write into ios/Resources
//   swift ios/tools/rasterize-badge-svgs.swift --check    # fail if anything moved
//
// WebKit does the drawing. These are real-world logos — 595 `<path>`, plus
// clipPaths, gradients, `<style>` CSS, `<text>`, `<use>`, embedded raster
// `<image>` and one `<foreignObject>` — so the renderer has to be a browser
// engine. `qlmanage` is the same engine and needs no code, but it composites
// onto opaque white and pads to a square; both are fatal here, the first
// because a badge sits on a popup that is dark half the time, and the second
// because the popup sizes the badge from the image's own aspect ratio.
//
// macOS-only, and that is fine: it is run by hand when the artwork changes,
// and its output is committed. Nothing in the app or the build depends on it.

import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import WebKit

// MARK: - where the files are

let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // tools
    .deletingLastPathComponent()  // ios
    .deletingLastPathComponent()  // repo
let sourceRoot = repoRoot.appending(path: "app/public/rail")
let outputRoot = repoRoot.appending(path: "ios/Resources/rail-badge-raster")

/// The three directories `copy-rail-packages.sh` ships, and the only places a
/// path out of the branding tables can point.
let families = ["logos", "line-logos", "operator-logos"]

let checkOnly = CommandLine.arguments.contains("--check")

// MARK: - how big

/// Every badge is drawn 16 pt tall and at most 48 pt wide, so 48 × 144 device
/// pixels on a 3× screen is the largest any of this is ever seen at. Rendering
/// into 192 × 576 gives four times that in whichever dimension is the binding
/// one, which costs kilobytes and means a future larger badge does not send
/// anyone back to this file.
let fitBox = CGSize(width: 576, height: 192)

/// The intrinsic aspect, from the root `<svg>` element.
///
/// `viewBox` first because it is what actually scales; `width`/`height` are a
/// fallback for the 39 files that carry no viewBox. Every one of the 95 files
/// answers one of the two — asserted by the run, not assumed.
func intrinsicSize(ofSVG markup: String) -> CGSize? {
    guard let tagRange = markup.range(of: "<svg\\b[^>]*>", options: .regularExpression) else {
        return nil
    }
    let tag = String(markup[tagRange])

    func attribute(_ name: String) -> String? {
        guard let range = tag.range(of: "\\b\(name)\\s*=\\s*\"[^\"]*\"", options: .regularExpression)
        else { return nil }
        let pair = tag[range]
        guard let open = pair.firstIndex(of: "\""), let close = pair.lastIndex(of: "\""),
              open < close
        else { return nil }
        return String(pair[pair.index(after: open)..<close])
    }

    if let box = attribute("viewBox") {
        let parts = box.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "\n" || $0 == "\t" })
        if parts.count == 4, let w = Double(parts[2]), let h = Double(parts[3]), w > 0, h > 0 {
            return CGSize(width: w, height: h)
        }
    }
    // `40px` and `40pt` both appear; the unit does not matter because only the
    // ratio of the two is used.
    func length(_ raw: String?) -> Double? {
        guard let raw else { return nil }
        let digits = raw.prefix { $0.isNumber || $0 == "." }
        return Double(digits)
    }
    if let w = length(attribute("width")), let h = length(attribute("height")), w > 0, h > 0 {
        return CGSize(width: w, height: h)
    }
    return nil
}

/// The intrinsic size scaled to sit inside ``fitBox`` with its ratio intact.
func outputSize(for intrinsic: CGSize) -> CGSize {
    let scale = min(fitBox.width / intrinsic.width, fitBox.height / intrinsic.height)
    return CGSize(
        width: max(1, (intrinsic.width * scale).rounded()),
        height: max(1, (intrinsic.height * scale).rounded()))
}

/// The markup, wrapped so that CSS can size it and nothing paints a ground.
///
/// Two things are done to the SVG itself. The XML prolog and any DOCTYPE are
/// dropped, because inside an HTML document they are parse errors rather than
/// declarations. And a `viewBox` is injected when the file has none: without
/// one an SVG does not scale at all — CSS width and height would crop or pad it
/// instead of resizing it — and 39 of these files have none.
func page(forSVG markup: String, intrinsic: CGSize) -> String {
    var svg = markup
    while let prolog = svg.range(of: "<\\?xml[^>]*\\?>", options: .regularExpression) {
        svg.removeSubrange(prolog)
    }
    while let doctype = svg.range(of: "<!DOCTYPE[^>]*>", options: [.regularExpression, .caseInsensitive]) {
        svg.removeSubrange(doctype)
    }
    if let tagRange = svg.range(of: "<svg\\b[^>]*>", options: .regularExpression),
       !svg[tagRange].contains("viewBox") {
        let injected = svg[tagRange].replacingOccurrences(
            of: "<svg",
            with: "<svg viewBox=\"0 0 \(intrinsic.width) \(intrinsic.height)\"",
            options: [],
            range: svg[tagRange].startIndex..<svg[tagRange].index(svg[tagRange].startIndex, offsetBy: 4))
        svg.replaceSubrange(tagRange, with: injected)
    }
    return """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
        svg { display: block; width: 100vw; height: 100vh; }
        </style></head><body>\(svg)</body></html>
        """
}

// MARK: - the renderer

/// One offscreen WebKit view, reused for all 95 files.
///
/// It lives in a window because a `WKWebView` with no window does not
/// necessarily have a layer to snapshot; the window is parked off every screen
/// and the process runs as an accessory, so nothing appears and nothing steals
/// focus. The snapshot comes back at whatever backing scale the host happens to
/// have, which is why it is redrawn into a bitmap of exactly the wanted pixel
/// size — the committed PNGs must not differ between a Retina machine and a
/// build server.
final class Renderer: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private let window: NSWindow
    private var onFinish: ((Result<Void, Error>) -> Void)?

    override init() {
        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
        window = NSWindow(
            contentRect: CGRect(x: -10_000, y: -10_000, width: 1, height: 1),
            styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        // Transparent all the way down: the window, its backing, and the page.
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = webView
        window.orderBack(nil)
        webView.navigationDelegate = self
        webView.underPageBackgroundColor = .clear
        // `underPageBackgroundColor` covers the overscroll ground; the page's
        // own ground is a separate, older switch with no public spelling.
        webView.setValue(false, forKey: "drawsBackground")
    }

    func render(svg: URL, size: CGSize, completion: @escaping (Result<CGImage, Error>) -> Void) {
        let markup: String
        do { markup = try String(contentsOf: svg, encoding: .utf8) }
        catch { return completion(.failure(error)) }
        guard let intrinsic = intrinsicSize(ofSVG: markup) else {
            return completion(.failure(Failure("no viewBox and no width/height on the root <svg>")))
        }

        window.setContentSize(size)
        webView.frame = CGRect(origin: .zero, size: size)
        onFinish = { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): completion(.failure(error))
            case .success:
                let configuration = WKSnapshotConfiguration()
                configuration.rect = CGRect(origin: .zero, size: size)
                self.webView.takeSnapshot(with: configuration) { image, error in
                    if let error { return completion(.failure(error)) }
                    guard let image, let bitmap = Self.redraw(image, to: size) else {
                        return completion(.failure(Failure("snapshot produced no bitmap")))
                    }
                    completion(.success(bitmap))
                }
            }
        }
        webView.loadHTMLString(page(forSVG: markup, intrinsic: intrinsic), baseURL: nil)
    }

    /// The snapshot, resampled onto a transparent context of the exact size.
    private static func redraw(_ image: NSImage, to size: CGSize) -> CGImage? {
        var rect = CGRect(origin: .zero, size: size)
        guard let source = image.cgImage(forProposedRect: &rect, context: nil, hints: nil),
              let context = CGContext(
                data: nil, width: Int(size.width), height: Int(size.height),
                bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        context.interpolationQuality = .high
        context.clear(CGRect(origin: .zero, size: size))
        context.draw(source, in: CGRect(origin: .zero, size: size))
        return context.makeImage()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // One turn of the run loop after `didFinish`: the document is parsed,
        // but a snapshot taken in the same turn can catch the frame before the
        // first paint and come back empty.
        DispatchQueue.main.async { [weak self] in self?.onFinish?(.success(())) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        onFinish?(.failure(error))
    }

    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        onFinish?(.failure(error))
    }
}

struct Failure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// MARK: - PNG on disk

func encodePNG(_ image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
        data, UTType.png.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
}

// MARK: - the run

func collectSVGs() -> [URL] {
    var found: [URL] = []
    for family in families {
        let root = sourceRoot.appending(path: family)
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: nil)
        else { continue }
        for case let url as URL in walker where url.pathExtension.lowercased() == "svg" {
            found.append(url)
        }
    }
    return found.sorted { $0.path < $1.path }
}

let svgs = collectSVGs()
guard !svgs.isEmpty else {
    FileHandle.standardError.write(Data("error: no SVGs under \(sourceRoot.path)\n".utf8))
    exit(1)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let renderer = Renderer()
var remaining = svgs
var written = 0
var stale: [String] = []
var failures: [String] = []

func finish() -> Never {
    if checkOnly {
        if stale.isEmpty && failures.isEmpty {
            print("rasterize-badge-svgs: \(svgs.count) badges match their sources")
            exit(0)
        }
        for path in stale { print("stale: \(path)") }
        for message in failures { print("error: \(message)") }
        FileHandle.standardError.write(Data(
            "rasterize-badge-svgs --check: \(stale.count) stale, \(failures.count) failed — rerun without --check\n".utf8))
        exit(1)
    }
    for message in failures { FileHandle.standardError.write(Data("error: \(message)\n".utf8)) }
    print("rasterize-badge-svgs: wrote \(written) of \(svgs.count) badges into \(outputRoot.path)")
    exit(failures.isEmpty ? 0 : 1)
}

/// `app/public/rail/line-logos/x.svg` → `ios/Resources/rail-badge-raster/line-logos/x.svg.png`
func destination(for svg: URL) -> URL {
    let relative = svg.path.replacingOccurrences(of: sourceRoot.path + "/", with: "")
    return outputRoot.appending(path: relative + ".png")
}

func step() {
    guard let svg = remaining.popLast() else { finish() }
    let target = destination(for: svg)
    let label = svg.path.replacingOccurrences(of: sourceRoot.path + "/", with: "")

    guard let markup = try? String(contentsOf: svg, encoding: .utf8),
          let intrinsic = intrinsicSize(ofSVG: markup)
    else {
        failures.append("\(label): cannot read an intrinsic size")
        return DispatchQueue.main.async(execute: step)
    }

    renderer.render(svg: svg, size: outputSize(for: intrinsic)) { result in
        switch result {
        case .failure(let error):
            failures.append("\(label): \(error.localizedDescription)")
        case .success(let image):
            guard let png = encodePNG(image) else {
                failures.append("\(label): PNG encoding failed")
                break
            }
            if checkOnly {
                let existing = try? Data(contentsOf: target)
                // Compared by size and dimensions rather than byte equality:
                // WebKit's rasterizer is not bit-stable across OS releases, and
                // a gate that reddens on a system update is a gate people turn
                // off. What must not drift is that a companion exists for every
                // SVG and still has the aspect the popup lays out from.
                if existing == nil {
                    stale.append("\(label): no PNG companion")
                } else if let existing,
                          let source = CGImageSourceCreateWithData(existing as CFData, nil),
                          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                            as? [CFString: Any],
                          let w = properties[kCGImagePropertyPixelWidth] as? Int,
                          let h = properties[kCGImagePropertyPixelHeight] as? Int,
                          w != image.width || h != image.height {
                    stale.append("\(label): \(w)×\(h) on disk, \(image.width)×\(image.height) from source")
                }
            } else {
                do {
                    try FileManager.default.createDirectory(
                        at: target.deletingLastPathComponent(),
                        withIntermediateDirectories: true)
                    try png.write(to: target, options: .atomic)
                    written += 1
                } catch {
                    failures.append("\(label): \(error.localizedDescription)")
                }
            }
        }
        DispatchQueue.main.async(execute: step)
    }
}

DispatchQueue.main.async(execute: step)
application.run()
