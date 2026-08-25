import Foundation
import RailPresentation
import Testing

/// The station card's 「マップで開く」 rule, checked against the answers a live
/// `MKLocalSearch` actually gave.
///
/// Every candidate list below is a transcription of one recorded search —
/// names, categories and distances as the service returned them — rather than
/// an invented one. That is deliberate: the failure this rule exists to prevent
/// is not a mis-typed string, it is picking a plausible WRONG place, and the
/// wrong places are ones no test author would have thought to write down. The
/// bus stop outside a bank ranked first for 臺北; the road stop 5 m from 金鐘
/// outranked the station 137 m away.
///
/// `ios/tools/audit-station-places.swift` is the other half. It runs this same
/// rule over a live sweep and reports the hit rate; these lock in what it found
/// so that a change to the rule has to answer for the cases it already solved.
struct StationPlaceLinkTests {

    func station(_ names: String..., country: String = "tw") -> StationPlaceLink.Station {
        StationPlaceLink.Station(names: names, country: country)
    }

    func transit(_ name: String, _ metres: Double) -> StationPlaceLink.Candidate {
        StationPlaceLink.Candidate(name: name, isPublicTransport: true, metres: metres)
    }

    func untyped(_ name: String, _ metres: Double) -> StationPlaceLink.Candidate {
        StationPlaceLink.Candidate(name: name, isPublicTransport: false, metres: metres)
    }

    // MARK: - Folding

    /// The two sides never spell a station the same way, and the fold is what
    /// makes that stop mattering.
    @Test(arguments: [
        // Traditional against the Simplified the service answers in.
        ("臺北", "台北车站"),
        ("金鐘", "金钟站"),
        ("媽閣", "妈阁"),
        ("土瓜灣", "土瓜湾"),
        // The word for "station" on either side, or both.
        ("鍾屋村", "钟屋村站"),
        ("十字路", "十字路车站"),
        ("嘉義", "嘉义火车站"),
        ("서울", "서울역"),
        // An operator's mark, glued to the front by one side and to the back
        // by the other.
        ("金鐘港鐵站", "金钟"),
        ("台中", "高铁台中站"),
        ("南科", "台湾铁路管理局南科火车站"),
        // A bracket the service adds and the package does not.
        ("五塊厝", "五块厝(地铁站)"),
    ])
    func foldsToTheSameString(_ package: String, _ apple: String) {
        #expect(StationPlaceLink.normalize(package) == StationPlaceLink.normalize(apple))
    }

    /// Two different stations must not fold together. 新埔 is both a Taipei
    /// metro station and a TRA station 60 km away, and 左營/新左營 are two
    /// stations 400 m apart — the fold is allowed to ignore script and
    /// punctuation, never a syllable.
    @Test(arguments: [
        ("左營", "新左營"), ("大安", "大安森林公園"), ("中山", "中山國中"),
        ("東京", "東京テレポート"), ("金鐘", "九龍塘"),
    ])
    func keepsDifferentStationsApart(_ one: String, _ other: String) {
        #expect(StationPlaceLink.normalize(one) != StationPlaceLink.normalize(other))
    }

    /// An English name is a separate spelling rather than something a fold
    /// could reach — no transform turns 東京 into Tokyo. It matches because the
    /// card hands the rule every spelling it knows, which is why
    /// `StationCard.searchNames` carries the romaji and the readings and not
    /// just the header.
    @Test
    func reachesAnEnglishNamedPlaceThroughTheStationsOtherSpellings() {
        let candidates = [transit("Tokyo Station", 40)]
        #expect(StationPlaceLink.best(candidates, for: station("東京", "Tokyo", country: "jp")) == 0)
        #expect(StationPlaceLink.best(candidates, for: station("東京", country: "jp")) == nil)
    }

    /// A name made of nothing but a station word keeps it, or every such name
    /// would fold to the empty string and match all the others.
    @Test
    func neverFoldsANameAway() {
        #expect(!StationPlaceLink.normalize("駅").isEmpty)
        #expect(!StationPlaceLink.normalize("站").isEmpty)
        #expect(!StationPlaceLink.normalize("(公交站)").isEmpty)
    }

    // MARK: - Picking the place

    /// The recorded answer to 臺北, in the order the service gave it. The bus
    /// stop outside 台北银行 came first and stood 1.6 km away.
    @Test
    func picksTheStationRatherThanTheFirstResult() {
        let candidates = [
            transit("台北银行(公交站)", 1_643),
            transit("台北车站", 51),
            transit("台北车站(地铁站)", 134),
            transit("台北车站(公交站)", 114),
            transit("台北车站(东三门)(公交站)", 113),
        ]
        let index = StationPlaceLink.best(candidates, for: station("臺北", "Taipei"))
        #expect(index == 1)
    }

    /// 金鐘, recorded. Distance alone picks 金钟道(金钟港铁站)(东行方向) at 5 m;
    /// the station itself is 137 m away and is the answer.
    @Test
    func prefersItsOwnNameOverBeingMentionedInABracket() {
        let candidates = [
            transit("金钟道(金钟港铁站)(东行方向)", 5),
            transit("金钟道(金钟港铁站)(西行方向)", 28),
            transit("金钟道，太古广场(港铁金钟站)", 85),
            transit("金钟", 137),
        ]
        let index = StationPlaceLink.best(candidates, for: station("金鐘港鐵站", country: "hk"))
        #expect(index == 3)
    }

    /// Hong Kong's street-running trams have no place of their own: 汕頭街 is
    /// held as a stop on 莊士敦道. With nothing better in the list, the bracket
    /// is the station.
    @Test
    func fallsBackToTheBracketWhenNothingCarriesTheNameItself() {
        let candidates = [transit("庄士敦道(汕头街)(西行方向)", 4)]
        let index = StationPlaceLink.best(candidates, for: station("汕頭街", country: "hk"))
        #expect(index == 0)
    }

    /// …but only within 150 m. Four other tram stops on 渣華道 carry the road's
    /// name between 300 m and 1.2 km, and the service lists them in no
    /// particular order.
    @Test
    func doesNotTakeADistantStopOnTheSameRoad() {
        let candidates = [
            transit("北角道，渣华道(东行方向)", 1_223),
            transit("琴行街(渣华道)(西行方向)", 864),
        ]
        #expect(StationPlaceLink.best(candidates, for: station("渣華道", country: "hk")) == nil)
    }

    /// The bus stop at a station carries the station's name, sits metres from
    /// the platform, and is not the station. Taiwan's small TRA stops are held
    /// this way and nothing else: the card sends the captioned pin instead.
    @Test(arguments: [
        "龙泉车站(公交站)", "麟洛车站(公交站)", "石龟车站(公交站)",
        "泰安火车站(公交站)", "玉里火车站(公交站)",
    ])
    func neverPicksARoadStop(_ name: String) {
        let package = String(name.prefix(while: { $0 != "车" && $0 != "火" }))
        let candidates = [transit(name, 3)]
        #expect(StationPlaceLink.best(candidates, for: station(package)) == nil)
    }

    /// Nothing at all is a real answer, and the caller depends on it: on the
    /// China map service every Japanese and Korean query comes back empty.
    @Test
    func answersNothingRatherThanGuessing() {
        #expect(StationPlaceLink.best([], for: station("東京", country: "jp")) == nil)
        let unrelated = [transit("東京都庁", 120), untyped("東京タワー", 300)]
        #expect(StationPlaceLink.best(unrelated, for: station("東京", country: "jp")) == nil)
    }

    /// A station further away than the budget is a different station of the
    /// same name, not this one.
    @Test
    func holdsTheDistanceBudget() {
        #expect(StationPlaceLink.best([transit("泰安车站", 599)], for: station("泰安")) != nil)
        #expect(StationPlaceLink.best([transit("泰安车站", 601)], for: station("泰安")) == nil)
    }

    /// A categorised station beats an uncategorised one of the same name, and
    /// an unbracketed spelling beats a bracketed one, before distance is
    /// consulted at all.
    @Test
    func ordersTheTiersBeforeDistance() {
        let candidates = [
            untyped("大安", 5),
            transit("大安(地铁站)", 60),
            transit("大安", 400),
        ]
        #expect(StationPlaceLink.best(candidates, for: station("大安")) == 2)
    }

    // MARK: - Queries

    @Test
    func asksForTheBareNameFirstAndTheSuffixedOneSecond() {
        #expect(StationPlaceLink.queries(for: station("東京", country: "jp")) == ["東京", "東京駅"])
        #expect(StationPlaceLink.queries(for: station("臺北", country: "tw")) == ["臺北", "臺北站"])
        #expect(StationPlaceLink.queries(for: station("金鐘", country: "hk")) == ["金鐘", "金鐘站"])
    }

    /// A name that already ends in the word gets one query, not 서울역역.
    @Test
    func neverDoublesAStationWordThatIsAlreadyThere() {
        #expect(StationPlaceLink.queries(for: station("서울역", country: "kr")) == ["서울역"])
        #expect(StationPlaceLink.queries(for: station("山鼻站", country: "tw")) == ["山鼻站"])
    }

    // MARK: - Links

    /// The place link carries the identifier and NOTHING else. A `place-id`
    /// Apple cannot resolve answers 「找不到你搜尋的頁面」 rather than falling
    /// back to a coordinate sitting beside it, so a second parameter would be a
    /// fallback that never fires.
    @Test
    func placeLinkNamesThePlaceAndOnlyThePlace() {
        let url = StationPlaceLink.placeURL(placeID: "H2710I3F9267AE5EC56")
        #expect(url?.absoluteString == "https://maps.apple.com/place?place-id=H2710I3F9267AE5EC56")
    }

    /// An identifier that is not one cannot be allowed to build a URL: the
    /// result would be a link that resolves to an error page, which is worse
    /// than the pin it replaced.
    @Test(arguments: ["", "   ", "abc def", "I123&q=x", "../place"])
    func refusesToBuildAPlaceLinkFromRubbish(_ rubbish: String) {
        #expect(StationPlaceLink.placeURL(placeID: rubbish) == nil)
    }

    /// The fallback is unchanged from what the card sent before places were
    /// resolved at all — a positioned, captioned pin.
    @Test
    func pinLinkKeepsThePositionAndTheCaption() {
        let url = StationPlaceLink.pinURL(name: "東京", latitude: 35.681391, longitude: 139.766103)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(url.host == "maps.apple.com")
        #expect(items.first { $0.name == "ll" }?.value == "35.681391,139.766103")
        #expect(items.first { $0.name == "q" }?.value == "東京")
    }
}
