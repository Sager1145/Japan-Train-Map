import Foundation
import MapKit

/// What fraction of stations the card's 「マップで開く」 can hand to a real
/// Apple Maps place, and which places it picks.
///
/// Build it against the shipped rule rather than a copy of it, so that a change
/// to `StationPlaceLink` is a change to what this measures:
///
///     cd ios
///     xcrun swiftc -O -o /tmp/audit-station-places \
///         tools/audit-station-places.swift \
///         RailKit/Sources/RailPresentation/StationPlaceLink.swift
///     cd .. && /tmp/audit-station-places [jp tw hk mo kr] [--per-country 40]
///
/// The package side is read from `app/public/rail/*-2025.json` and
/// `app/data/station-readings*.json`; the Apple side is live `MKLocalSearch`,
/// through the same search plan, the same alias set and the same winner rule
/// the card runs. Coordinates are shifted into the basemap's datum for the four
/// GCJ-02 regions before anything is measured, exactly as `AppleMapDatum`
/// shifts them before anything is drawn.
///
/// Two things about the running machine change the answer, and both are worth
/// re-running for.
///
/// Its map SERVICE: a device inside mainland China gets one that returns
/// `MKError.placemarkNotFound` for every query outside Greater China, Japan and
/// Korea included. That is reported as UNSERVED rather than as a matching
/// failure — the two are different problems and only one of them is fixable
/// here.
///
/// Its LANGUAGE: the service answers 台北车站 to a Chinese device and Taibei
/// Station to an English one. Sweep the other language with the argument
/// domain, which is passed through to `NSUserDefaults` untouched:
///
///     /tmp/audit-station-places tw hk mo -AppleLanguages "(en)"
///
/// or build it for the simulator and `xcrun simctl spawn` it there, which is
/// the only way to measure a language the host is not set to.
@main
struct AuditStationPlaces {

    // MARK: - Geometry

    struct Point {
        var lon: Double
        var lat: Double
    }

    /// The same local flat-earth metre used by `audit-apple-map-datums.swift`.
    /// Both sides of every comparison here are within a few kilometres of each
    /// other, which is where that approximation is exact enough to be boring.
    static func distance(_ a: Point, _ b: Point) -> Double {
        let latitude = (a.lat + b.lat) / 2 * .pi / 180
        return hypot((b.lon - a.lon) * 111_320 * cos(latitude), (b.lat - a.lat) * 111_320)
    }

    /// `AppleMapDatum.gcj02(fromWGS84:)`. Duplicated rather than imported for
    /// the reason the sibling audit duplicates it: the app's copy lives in the
    /// app target, above the package, and a tool that linked the app target
    /// would need the whole of MapKit's UI layer to measure a coordinate.
    static func gcj02(_ point: Point) -> Point {
        let a = 6_378_245.0
        let ee = 0.00669342162296594323
        let x = point.lon - 105
        let y = point.lat - 35
        var dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * sqrt(abs(x))
        dLat += (20 * sin(6 * x * .pi) + 20 * sin(2 * x * .pi)) * 2 / 3
        dLat += (20 * sin(y * .pi) + 40 * sin(y / 3 * .pi)) * 2 / 3
        dLat += (160 * sin(y / 12 * .pi) + 320 * sin(y * .pi / 30)) * 2 / 3
        var dLon = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * sqrt(abs(x))
        dLon += (20 * sin(6 * x * .pi) + 20 * sin(2 * x * .pi)) * 2 / 3
        dLon += (20 * sin(x * .pi) + 40 * sin(x / 3 * .pi)) * 2 / 3
        dLon += (150 * sin(x / 12 * .pi) + 300 * sin(x / 30 * .pi)) * 2 / 3
        let radians = point.lat * .pi / 180
        let sine = sin(radians)
        let magic = 1 - ee * sine * sine
        let squareRoot = sqrt(magic)
        return Point(
            lon: point.lon + dLon * 180 / (a / squareRoot * cos(radians) * .pi),
            lat: point.lat + dLat * 180 / ((a * (1 - ee)) / (magic * squareRoot) * .pi))
    }

    static let gcjCountries: Set<String> = ["tw", "hk", "mo", "kr"]

    // MARK: - The package side

    struct Subject {
        var country: String
        var name: String
        var roma: String
        /// Every other spelling the readings table holds, which is what the
        /// card hands the rule through `Localization.stationNameAliases`. The
        /// tool would under-report without them by exactly the cases they
        /// exist for: on an English device the service answers Barra, Jockey
        /// Club and Admiralty, and only the table knows those are 媽閣, 馬會
        /// and 金鐘.
        var aliases: [String]
        var source: Point
        var display: Point
    }

    /// `app/data/station-readings*.json`, reduced to the alias lists.
    ///
    /// Keyed by the station's own code first and its name second, which is
    /// `Localization.stationReadingRow`'s order and for its reason: the code is
    /// the official identity and two stations share a name often enough to
    /// matter.
    static func readings(country: String) -> (byCode: [String: [String]], byName: [String: [String]]) {
        let suffix = country == "jp" ? "" : "-\(country)"
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appending(path: "app/data/station-readings\(suffix).json")
        guard let data = try? Data(contentsOf: url),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return ([:], [:]) }
        func lists(_ table: Any?) -> [String: [String]] {
            guard let table = table as? [String: [String: Any]] else { return [:] }
            return table.mapValues { row in
                ["zh_Hant", "zh_Hans", "ja", "en", "romaji", "kana"]
                    .compactMap { row[$0] as? String }
                    .filter { !$0.isEmpty }
            }
        }
        return (lists(root["byCode"]), lists(root["byName"]))
    }

    /// One station per NAME, in package order.
    ///
    /// Per name rather than per platform because the card's question is about
    /// the place: a complex whose six platforms are six rows in the package is
    /// one station on Apple Maps, and measuring it six times would report the
    /// same hit six times and make the interchanges dominate the score.
    static func subjects(country: String) throws -> [Subject] {
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appending(path: "app/public/rail/\(country)-2025.json")
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let lines = root["lines"] as! [[String: Any]]
        let table = readings(country: country)
        var seen: Set<String> = []
        var result: [Subject] = []
        for line in lines {
            for row in line["stations"] as? [[Any]] ?? [] where row.count >= 4 {
                guard let name = row[1] as? String, !name.isEmpty,
                    let lon = row[2] as? Double, let lat = row[3] as? Double,
                    seen.insert(name).inserted
                else { continue }
                let source = Point(lon: lon, lat: lat)
                let code = row[0] as? String
                result.append(Subject(
                    country: country, name: name,
                    roma: (row.count > 4 ? row[4] as? String : nil) ?? "",
                    aliases: code.flatMap { table.byCode[$0] } ?? table.byName[name] ?? [],
                    source: source,
                    display: gcjCountries.contains(country) ? gcj02(source) : source))
            }
        }
        return result
    }

    /// Every `count`-th station, so the sample spans the whole package rather
    /// than its first prefecture. Package order follows the line list, which
    /// follows the operator, so a prefix would be one company's network.
    static func spread(_ subjects: [Subject], count: Int) -> [Subject] {
        guard subjects.count > count, count > 0 else { return subjects }
        let step = Double(subjects.count) / Double(count)
        return (0..<count).map { subjects[Int(Double($0) * step)] }
    }

    // MARK: - The Apple side

    /// One `MKLocalSearch`, retried past the throttle but not past a miss.
    ///
    /// `MKError.placemarkNotFound` means the service answered and had nothing;
    /// retrying it three times with a back-off would turn a 900-station sweep
    /// into an hour of waiting for the same empty answer.
    static func search(
        _ query: String, near point: Point, transportOnly: Bool
    ) async throws -> [MKMapItem] {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        request.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: point.lat, longitude: point.lon),
            latitudinalMeters: 3_000, longitudinalMeters: 3_000)
        request.resultTypes = .pointOfInterest
        if transportOnly {
            request.pointOfInterestFilter = MKPointOfInterestFilter(including: [.publicTransport])
        }
        var lastError: Error?
        for attempt in 0..<3 {
            do { return try await MKLocalSearch(request: request).start().mapItems } catch {
                if (error as NSError).code == MKError.placemarkNotFound.rawValue { throw error }
                lastError = error
                try? await Task.sleep(for: .seconds(2 * (attempt + 1)))
            }
        }
        throw lastError!
    }

    struct Outcome {
        var subject: Subject
        var appleName: String
        var identifier: String
        var metres: Double
        var pass: Int
    }

    // MARK: - Run

    static func main() async throws {
        var arguments = Array(CommandLine.arguments[1...])
        var perCountry = 40
        if let index = arguments.firstIndex(of: "--per-country"), index + 1 < arguments.count {
            perCountry = Int(arguments[index + 1]) ?? perCountry
            arguments.removeSubrange(index...(index + 1))
        }
        // Anything else beginning with a dash belongs to `NSUserDefaults`'
        // argument domain rather than to this tool: `-AppleLanguages "(en)"`
        // is how the sweep is re-run in another language, and the answers
        // change with it — the same service returns 台北车站 to a Chinese
        // device and Taibei Station to an English one.
        while let index = arguments.firstIndex(where: { $0.hasPrefix("-") }) {
            let end = index + 1 < arguments.count ? index + 1 : index
            arguments.removeSubrange(index...end)
        }
        let wanted = arguments.isEmpty ? ["jp", "tw", "hk", "mo", "kr"] : arguments

        for country in wanted {
            let sample = spread(try subjects(country: country), count: perCountry)
            var outcomes: [Outcome] = []
            var unmatched: [Subject] = []
            var unserved = 0

            for subject in sample {
                let station = StationPlaceLink.Station(
                    names: [subject.name, subject.roma] + subject.aliases, country: country)
                var plan: [(String, Bool)] = StationPlaceLink.queries(for: station)
                    .map { ($0, true) }
                if let first = plan.first { plan.append((first.0, false)) }

                var resolved: Outcome?
                var answered = false
                for (pass, step) in plan.enumerated() where resolved == nil {
                    let items: [MKMapItem]
                    do { items = try await search(step.0, near: subject.display, transportOnly: step.1) }
                    catch { continue }
                    answered = true
                    let candidates = items.map { item in
                        StationPlaceLink.Candidate(
                            name: item.name ?? "",
                            isPublicTransport: item.pointOfInterestCategory == .publicTransport,
                            metres: distance(
                                subject.display,
                                Point(
                                    lon: item.location.coordinate.longitude,
                                    lat: item.location.coordinate.latitude)))
                    }
                    guard let index = StationPlaceLink.best(candidates, for: station) else { continue }
                    resolved = Outcome(
                        subject: subject, appleName: items[index].name ?? "",
                        identifier: items[index].identifier?.rawValue ?? "",
                        metres: candidates[index].metres, pass: pass)
                }

                if let resolved {
                    outcomes.append(resolved)
                    print(String(
                        format: "HIT\t%@\t%@\t%@\t%.0f\tpass=%d\t%@",
                        country, subject.name, resolved.appleName, resolved.metres,
                        resolved.pass, resolved.identifier.isEmpty ? "no-id" : resolved.identifier))
                } else if answered {
                    unmatched.append(subject)
                    print("MISS\t\(country)\t\(subject.name)\tno result was this station")
                } else {
                    unserved += 1
                    print("UNSERVED\t\(country)\t\(subject.name)\tthe map service returned nothing")
                }
            }

            let withID = outcomes.filter { !$0.identifier.isEmpty }.count
            let metres = outcomes.map(\.metres).sorted()
            let median = metres.isEmpty ? Double.nan : metres[metres.count / 2]
            let worst = metres.last ?? .nan
            let secondPass = outcomes.filter { $0.pass > 0 }.count
            print(String(
                format: "SUMMARY\t%@\t%d sampled\t%d resolved\t%d unmatched\t%d unserved"
                    + "\t%d with place-id\t%d needed a later pass\tmedian %.0f m\tworst %.0f m",
                country, sample.count, outcomes.count, unmatched.count, unserved,
                withID, secondPass, median, worst))
        }
    }
}
