import UIKit

/// An operator's badge, from the web tables' own path to a decoded image.
///
/// Lived on the map's station-callout builder until the callout became a card
/// in a sheet (`StationCardView`). It is here rather than there because the
/// rule it applies belongs to the artwork and not to whoever is drawing it:
/// one table names the files, and every surface that shows a badge has to
/// resolve a name the same way or the two disagree about which operators have
/// a mark at all.
///
/// `@MainActor` because that is where it is read from — a SwiftUI view body,
/// and before that an `MKAnnotationView` — and because the decoded-image cache
/// is shared mutable state that would otherwise need a lock of its own to say
/// so. `NSCache` is thread-safe, but "thread-safe" is not what the compiler is
/// asking; it is asking who owns it.
@MainActor
enum OperatorBadge {

    /// A web path — `/rail/logos/<id>.png` — resolved in the bundle.
    ///
    /// The ported rule returns the path the JavaScript hands to an `<img>`, so
    /// the leading slash is stripped and the rest used as-is. Keeping the web's
    /// own directory names is what lets one table serve both clients; inventing
    /// a second naming scheme here would be a second thing to keep in step.
    ///
    /// With one exception, and it is not a naming scheme: **ImageIO has no SVG
    /// decoder on iOS**, and 95 of the files the tables name are SVG. An
    /// `<img>` renders them; `UIImage` returns nil, and the row silently falls
    /// back to a colour swatch — which is what about a quarter of them did.
    /// `rasterize-badge-svgs.swift` writes a PNG beside each one under the
    /// SVG's own name plus `.png`, so the fix is to append four characters to
    /// the answer the table already gave. The table still decides.
    ///
    /// macOS *does* decode SVG, which is why this survived review: the artwork
    /// opens in Preview, in Xcode, and under `sips`, and only the simulator and
    /// the device disagree.
    static func image(_ path: String?) -> UIImage? {
        guard let path, !path.isEmpty else { return nil }
        if let cached = cache.object(forKey: path as NSString) { return cached }
        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let decodable = relative.hasSuffix(".svg") ? relative + ".png" : relative
        guard let url = Bundle.main.resourceURL?.appending(path: decodable),
              let image = UIImage(contentsOfFile: url.path)
        else { return nil }
        cache.setObject(image, forKey: path as NSString)
        return image
    }

    /// A station complex can list a dozen railways and a reader opens one
    /// station card after another, so the same handful of badges is decoded
    /// over and over without this.
    private static let cache = NSCache<NSString, UIImage>()

    /// The matte a handful of marks need, and only they.
    ///
    /// Not decoration and not a theme rule: a few operators' current mark is
    /// drawn predominantly in WHITE because their own site puts it on a dark
    /// header. `OperatorBranding.logoNeedsDarkMatte` names them, and the
    /// original artwork then stays legible in both appearances.
    static let matte = UIColor(
        red: 0x24 / 255, green: 0x31 / 255, blue: 0x3a / 255, alpha: 1)
}
