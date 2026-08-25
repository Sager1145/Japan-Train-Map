#!/usr/bin/env swift

import Foundation
import MapKit

/// A reproducible, geographically distributed station audit against the same
/// MapKit service the iOS app draws over.
///
/// Run from the repository root:
///
///     xcrun swift ios/tools/audit-apple-map-datums.swift [jp|tw|hk|mo|kr]
///
/// The package side is read from `app/public/rail/*-2025.json`; the Apple side
/// is live `MKLocalSearch`. For interchange complexes the closest combination
/// of package platform and Apple result is used, because both legitimately
/// carry several coordinates under one passenger-facing station name.

struct Target {
    var country: String
    var name: String
    var query: String
}

struct Point {
    var lon: Double
    var lat: Double
}

struct ResultRow {
    var country: String
    var name: String
    var appleName: String
    var source: Point
    var apple: Point
    var wgsResidual: Double
    var gcjResidual: Double
}

let targets: [Target] = [
    // Japan — Hokkaido to Okinawa, with the three largest urban complexes.
    .init(country: "jp", name: "札幌", query: "Sapporo Station Japan"),
    .init(country: "jp", name: "函館", query: "Hakodate Station Japan"),
    .init(country: "jp", name: "仙台", query: "Sendai Station Japan"),
    .init(country: "jp", name: "東京", query: "Tokyo Station Japan"),
    .init(country: "jp", name: "新宿", query: "Shinjuku Station Japan"),
    .init(country: "jp", name: "横浜", query: "Yokohama Station Japan"),
    .init(country: "jp", name: "金沢", query: "Kanazawa Station Japan"),
    .init(country: "jp", name: "名古屋", query: "Nagoya Station Japan"),
    .init(country: "jp", name: "京都", query: "Kyoto Station Japan"),
    .init(country: "jp", name: "大阪", query: "Osaka Station Japan"),
    .init(country: "jp", name: "広島", query: "Hiroshima Station Japan"),
    .init(country: "jp", name: "博多", query: "Hakata Station Japan"),
    .init(country: "jp", name: "鹿児島中央", query: "Kagoshima-Chuo Station Japan"),
    .init(country: "jp", name: "那覇空港", query: "Naha Airport Station Japan"),

    // Taiwan — west-coast trunk, both HSR/TRA complexes and the east coast.
    .init(country: "tw", name: "臺北", query: "台北車站"),
    .init(country: "tw", name: "板橋", query: "板橋車站"),
    .init(country: "tw", name: "桃園", query: "高鐵桃園站"),
    .init(country: "tw", name: "新竹", query: "新竹火車站"),
    .init(country: "tw", name: "臺中", query: "台中火車站"),
    .init(country: "tw", name: "嘉義", query: "嘉義火車站"),
    .init(country: "tw", name: "臺南", query: "台南火車站"),
    .init(country: "tw", name: "左營", query: "高鐵左營站"),
    .init(country: "tw", name: "高雄", query: "高雄車站"),
    .init(country: "tw", name: "花蓮", query: "花蓮火車站"),
    .init(country: "tw", name: "臺東", query: "台東火車站"),

    // Hong Kong — urban MTR, border, airport and northwest light rail.
    .init(country: "hk", name: "香港", query: "港鐵 香港站"),
    .init(country: "hk", name: "中環", query: "港鐵 中環站"),
    .init(country: "hk", name: "金鐘", query: "港鐵 金鐘站"),
    .init(country: "hk", name: "紅磡", query: "港鐵 紅磡站"),
    .init(country: "hk", name: "九龍塘", query: "港鐵 九龍塘站"),
    .init(country: "hk", name: "羅湖", query: "港鐵 羅湖站"),
    .init(country: "hk", name: "屯門", query: "港鐵 屯門站"),
    .init(country: "hk", name: "元朗", query: "港鐵 元朗站"),
    .init(country: "hk", name: "青衣", query: "港鐵 青衣站"),
    .init(country: "hk", name: "機場", query: "港鐵 機場站 香港"),
    .init(country: "hk", name: "迪士尼", query: "港鐵 迪士尼站"),
    .init(country: "hk", name: "海怡半島", query: "港鐵 海怡半島站"),

    // Macao — every operating station, not a sample.
    .init(country: "mo", name: "媽閣", query: "澳門輕軌 媽閣站"),
    .init(country: "mo", name: "海洋", query: "澳門輕軌 海洋站"),
    .init(country: "mo", name: "馬會", query: "澳門輕軌 馬會站"),
    .init(country: "mo", name: "運動場", query: "澳門輕軌 運動場站"),
    .init(country: "mo", name: "排角", query: "澳門輕軌 排角站"),
    .init(country: "mo", name: "路氹西", query: "澳門輕軌 路氹西站"),
    .init(country: "mo", name: "蓮花", query: "澳門輕軌 蓮花站"),
    .init(country: "mo", name: "協和醫院", query: "澳門輕軌 協和醫院站"),
    .init(country: "mo", name: "東亞運", query: "澳門輕軌 東亞運站"),
    .init(country: "mo", name: "路氹東", query: "澳門輕軌 路氹東站"),
    .init(country: "mo", name: "科大", query: "澳門輕軌 科大站"),
    .init(country: "mo", name: "機場", query: "澳門輕軌 機場站"),
    .init(country: "mo", name: "氹仔碼頭", query: "澳門輕軌 氹仔碼頭站"),
    .init(country: "mo", name: "石排灣", query: "澳門輕軌 石排灣站"),
    .init(country: "mo", name: "橫琴", query: "澳門輕軌 橫琴站"),

    // Korea — capital area plus every principal intercity direction.
    .init(country: "kr", name: "서울", query: "Seoul Station South Korea"),
    .init(country: "kr", name: "용산", query: "Yongsan Station South Korea"),
    .init(country: "kr", name: "인천", query: "Incheon Station South Korea"),
    .init(country: "kr", name: "수원", query: "Suwon Station South Korea"),
    .init(country: "kr", name: "대전", query: "Daejeon Station South Korea"),
    .init(country: "kr", name: "대구", query: "Daegu Station South Korea"),
    .init(country: "kr", name: "부산", query: "Busan Station South Korea"),
    .init(country: "kr", name: "광주송정", query: "Gwangju Songjeong Station South Korea"),
    .init(country: "kr", name: "목포", query: "Mokpo Station South Korea"),
    .init(country: "kr", name: "강릉", query: "Gangneung Station South Korea"),
    .init(country: "kr", name: "춘천", query: "Chuncheon Station South Korea"),
]

func packageStations(country: String, name: String) throws -> [Point] {
    let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appending(path: "app/public/rail/\(country)-2025.json")
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let lines = root["lines"] as! [[String: Any]]
    var result: [Point] = []
    for line in lines {
        for row in line["stations"] as? [[Any]] ?? [] where row.count >= 4 {
            guard row[1] as? String == name,
                  let longitude = row[2] as? Double,
                  let latitude = row[3] as? Double else { continue }
            result.append(Point(lon: longitude, lat: latitude))
        }
    }
    return result
}

func distance(_ a: Point, _ b: Point) -> Double {
    let latitude = (a.lat + b.lat) / 2 * .pi / 180
    return hypot((b.lon - a.lon) * 111_320 * cos(latitude), (b.lat - a.lat) * 111_320)
}

func gcj02(_ point: Point) -> Point {
    let a = 6_378_245.0
    let ee = 0.00669342162296594323
    let x = point.lon - 105
    let y = point.lat - 35
    func latitudeTerm() -> Double {
        var value = -100 + 2 * x + 3 * y + 0.2 * y * y
            + 0.1 * x * y + 0.2 * sqrt(abs(x))
        value += (20 * sin(6 * x * .pi) + 20 * sin(2 * x * .pi)) * 2 / 3
        value += (20 * sin(y * .pi) + 40 * sin(y / 3 * .pi)) * 2 / 3
        value += (160 * sin(y / 12 * .pi) + 320 * sin(y * .pi / 30)) * 2 / 3
        return value
    }
    func longitudeTerm() -> Double {
        var value = 300 + x + 2 * y + 0.1 * x * x
            + 0.1 * x * y + 0.1 * sqrt(abs(x))
        value += (20 * sin(6 * x * .pi) + 20 * sin(2 * x * .pi)) * 2 / 3
        value += (20 * sin(x * .pi) + 40 * sin(x / 3 * .pi)) * 2 / 3
        value += (150 * sin(x / 12 * .pi) + 300 * sin(x / 30 * .pi)) * 2 / 3
        return value
    }
    let radians = point.lat * .pi / 180
    let sine = sin(radians)
    let magic = 1 - ee * sine * sine
    let squareRoot = sqrt(magic)
    let latitudeOffset = latitudeTerm() * 180 / ((a * (1 - ee)) / (magic * squareRoot) * .pi)
    let longitudeOffset = longitudeTerm() * 180 / (a / squareRoot * cos(radians) * .pi)
    return Point(lon: point.lon + longitudeOffset, lat: point.lat + latitudeOffset)
}

func median(_ values: [Double]) -> Double {
    let sorted = values.sorted()
    guard !sorted.isEmpty else { return .nan }
    if sorted.count.isMultiple(of: 2) {
        return (sorted[sorted.count / 2 - 1] + sorted[sorted.count / 2]) / 2
    }
    return sorted[sorted.count / 2]
}

let requestedCountries = Set(CommandLine.arguments.dropFirst())
let selectedTargets = requestedCountries.isEmpty
    ? targets
    : targets.filter { requestedCountries.contains($0.country) }

func search(_ request: MKLocalSearch.Request, attempts: Int = 3) async throws -> MKLocalSearch.Response {
    var lastError: Error?
    for attempt in 0..<attempts {
        do {
            return try await MKLocalSearch(request: request).start()
        } catch {
            lastError = error
            if attempt + 1 < attempts {
                try await Task.sleep(for: .seconds(2 * (attempt + 1)))
            }
        }
    }
    throw lastError!
}

var rows: [ResultRow] = []
for target in selectedTargets {
    let sources = try packageStations(country: target.country, name: target.name)
    guard !sources.isEmpty else {
        print("MISS\t\(target.country)\t\(target.name)\tpackage station not found")
        continue
    }
    let centre = sources[0]
    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = target.query
    request.region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: centre.lat, longitude: centre.lon),
        span: MKCoordinateSpan(latitudeDelta: 0.18, longitudeDelta: 0.18))
    do {
        let response = try await search(request)
        let candidates = response.mapItems.map {
            Point(lon: $0.location.coordinate.longitude, lat: $0.location.coordinate.latitude)
        }
        var best: (source: Point, apple: Point, appleName: String, score: Double)?
        for source in sources {
            for (index, apple) in candidates.enumerated() {
                // Do not make candidate selection itself favour either datum.
                // A valid Apple result may be close to WGS84 or to its GCJ-02
                // display copy, depending on the region served by MapKit.
                let score = min(distance(source, apple), distance(gcj02(source), apple))
                if best == nil || score < best!.score {
                    best = (source, apple, response.mapItems[index].name ?? "?", score)
                }
            }
        }
        guard let best, best.score < 3_000 else {
            print("MISS\t\(target.country)\t\(target.name)\tno plausible Apple result")
            continue
        }
        let wgsResidual = distance(best.source, best.apple)
        let gcjResidual = distance(gcj02(best.source), best.apple)
        rows.append(ResultRow(
            country: target.country, name: target.name, appleName: best.appleName,
            source: best.source, apple: best.apple,
            wgsResidual: wgsResidual, gcjResidual: gcjResidual))
        print(String(format: "ROW\t%@\t%@\t%.1f\t%.1f\t%@\t%.7f\t%.7f",
            target.country, target.name, wgsResidual, gcjResidual, best.appleName,
            best.apple.lon, best.apple.lat))
    } catch {
        print("MISS\t\(target.country)\t\(target.name)\t\(error)")
    }
}

for country in ["jp", "tw", "hk", "mo", "kr"] where requestedCountries.isEmpty || requestedCountries.contains(country) {
    let group = rows.filter { $0.country == country }
    guard !group.isEmpty else {
        print("SUMMARY\t\(country)\t0\tUNAVAILABLE")
        continue
    }
    let wgs = median(group.map(\.wgsResidual))
    let gcj = median(group.map(\.gcjResidual))
    let chosen = wgs <= gcj ? "WGS84" : "GCJ-02"
    print(String(format: "SUMMARY\t%@\t%d\t%.1f\t%.1f\t%@",
        country, group.count, wgs, gcj, chosen))
}
