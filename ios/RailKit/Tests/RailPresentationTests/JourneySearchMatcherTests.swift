import Foundation
import RailCore
import RailPresentation
import Testing

/// JRM_FLIGHTY_UI_REFACTOR_SPEC.md §5.1's search-field contract.
///
/// The list is asserted field by field rather than by one happy-path query,
/// because the defect this replaces was precisely a *missing* field: the old
/// inline predicate searched six of the eight, and no test noticed because
/// every test searched by train number.
struct JourneySearchMatcherTests {

    static func train(
        id: String = "t-odoriko-1",
        date: String? = "2026-07-26",
        number: String = "踊り子1号",
        direction: String? = "下り",
        trainType: String? = "特急",
        company: String? = "JR東日本",
        origin: String = "東京",
        destination: String = "伊豆急下田",
        stops: [Stop]? = nil
    ) -> Train {
        Train(
            id: id,
            date: date,
            number: number,
            trainType: trainType,
            company: company,
            origin: origin,
            destination: destination,
            direction: direction,
            stops: stops ?? [
                Stop(name: origin, departure: "09:00", rideSegment: true),
                Stop(name: "熱海", arrival: "10:19", departure: "10:20", rideSegment: true),
                Stop(name: destination, arrival: "11:40", rideSegment: false),
            ])
    }

    // MARK: - every field §5.1 names

    @Test(arguments: [
        "t-odoriko",  // record id
        "踊り子",  // service name
        "2026-07-26",  // date
        "下り",  // direction
        "東京",  // origin
        "伊豆急下田",  // destination
        "熱海",  // an intermediate stop
        "特急",  // train type
        "JR東日本",  // operator
    ])
    func everyContractedFieldIsSearchable(needle: String) {
        #expect(JourneySearchMatcher.matches(Self.train(), query: needle))
    }

    /// The two that were missing before this module existed, named on their
    /// own so a regression reads as what it is rather than as one row of a
    /// parameterised failure.
    @Test
    func dateAndDirectionAreSearchable() {
        #expect(JourneySearchMatcher.matches(Self.train(), query: "2026-07"))
        #expect(JourneySearchMatcher.matches(Self.train(), query: "下り"))
    }

    @Test
    func aWordInNoFieldMatchesNothing() {
        #expect(!JourneySearchMatcher.matches(Self.train(), query: "のぞみ"))
    }

    // MARK: - how it matches

    @Test
    func matchingIsCaseInsensitive() {
        let train = Self.train(number: "Odoriko 1", company: "JR East")
        #expect(JourneySearchMatcher.matches(train, query: "odoriko"))
        #expect(JourneySearchMatcher.matches(train, query: "JR EAST"))
    }

    @Test
    func aSubstringIsEnough() {
        #expect(JourneySearchMatcher.matches(Self.train(), query: "伊豆"))
    }

    @Test
    func anEmptyOrBlankQueryMatchesEverything() {
        #expect(JourneySearchMatcher.matches(Self.train(), query: ""))
        #expect(JourneySearchMatcher.matches(Self.train(), query: "   \n "))
    }

    @Test
    func surroundingWhitespaceIsTrimmedRatherThanSearchedFor() {
        #expect(JourneySearchMatcher.matches(Self.train(), query: "  踊り子  "))
    }

    // MARK: - the field list itself

    @Test
    func absentOptionalFieldsContributeNothingRatherThanEmptyStrings() {
        let sparse = Self.train(
            date: nil, direction: nil, trainType: nil, company: nil,
            stops: [Stop(name: "東京", departure: "09:00", rideSegment: true)])
        #expect(!JourneySearchMatcher.fields(of: sparse).contains(""))
        // And an empty query still does not fall through to "matches nothing".
        #expect(JourneySearchMatcher.matches(sparse, query: ""))
    }

    /// §3.2 forbids the record id leading a journey's identity. The field
    /// order is the scan order, and the id is last in it.
    @Test
    func theRecordIdentifierIsLastInTheScanOrder() {
        let fields = JourneySearchMatcher.fields(of: Self.train())
        #expect(fields.first == "踊り子1号")
        #expect(fields.last == "t-odoriko-1")
    }

    // MARK: - filtering a day

    @Test
    func filteringKeepsStoreOrder() {
        let trains = [
            Self.train(id: "a", number: "踊り子1号"),
            Self.train(id: "b", number: "こだま700号"),
            Self.train(id: "c", number: "踊り子9号"),
        ]
        #expect(JourneySearchMatcher.filter(trains, query: "踊り子").map(\.id) == ["a", "c"])
    }

    @Test
    func filteringWithNoQueryReturnsEverythingUntouched() {
        let trains = [Self.train(id: "a"), Self.train(id: "b")]
        #expect(JourneySearchMatcher.filter(trains, query: " ").map(\.id) == ["a", "b"])
    }
}
