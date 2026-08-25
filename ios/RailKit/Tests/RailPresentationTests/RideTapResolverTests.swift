import Testing

@testable import RailPresentation

/// The tap arithmetic, including the cases a hand-run in the simulator cannot
/// reach reliably: two rides exactly on top of each other, a tap past the end
/// of a line, and a segment whose two vertices are the same point.
struct RideTapResolverTests {

    private typealias Point = RideTapResolver.Point

    private func line(_ points: [(Double, Double)]) -> [Point] {
        points.map { Point(x: $0.0, y: $0.1) }
    }

    @Test("a tap on the line finds the ride")
    func tapOnLine() {
        let ride = RideTapResolver.Candidate(id: "a", strokes: [line([(0, 0), (100, 0)])])
        #expect(RideTapResolver.hits(at: Point(x: 50, y: 4), among: [ride]) == ["a"])
    }

    @Test("a tap beyond the tolerance finds nothing")
    func tapAway() {
        let ride = RideTapResolver.Candidate(id: "a", strokes: [line([(0, 0), (100, 0)])])
        #expect(RideTapResolver.hits(at: Point(x: 50, y: 40), among: [ride]).isEmpty)
    }

    /// The reason the distance is measured to the segment rather than to its
    /// endpoints: the midpoint of a long segment is nowhere near either end.
    @Test("distance is to the segment, not to its nearer vertex")
    func segmentNotVertex() {
        let ride = RideTapResolver.Candidate(id: "a", strokes: [line([(0, 0), (1000, 0)])])
        #expect(RideTapResolver.hits(at: Point(x: 500, y: 2), among: [ride]) == ["a"])
    }

    /// Past the end of the line the answer IS the endpoint distance, which is
    /// what the 0…1 clamp is for.
    @Test("past the end, the distance is to the endpoint")
    func beyondTheEnd() {
        let ride = RideTapResolver.Candidate(id: "a", strokes: [line([(0, 0), (100, 0)])])
        #expect(RideTapResolver.hits(at: Point(x: 112, y: 0), among: [ride]) == ["a"])
        #expect(RideTapResolver.hits(at: Point(x: 130, y: 0), among: [ride]).isEmpty)
    }

    @Test("every ride under the finger is returned, nearest first")
    func manyRides() {
        let near = RideTapResolver.Candidate(id: "near", strokes: [line([(0, 0), (100, 0)])])
        let far = RideTapResolver.Candidate(id: "far", strokes: [line([(0, 10), (100, 10)])])
        let away = RideTapResolver.Candidate(id: "away", strokes: [line([(0, 90), (100, 90)])])
        #expect(
            RideTapResolver.hits(at: Point(x: 50, y: 1), among: [far, near, away])
                == ["near", "far"])
    }

    /// Two rides drawn on the same metres of track — the case the chooser
    /// exists for. Both are returned, in a stable order that does not depend on
    /// which was built first.
    @Test("coincident rides are both offered, in a stable order")
    func coincidentRides() {
        let stroke = line([(0, 0), (100, 0)])
        let b = RideTapResolver.Candidate(id: "b", strokes: [stroke])
        let a = RideTapResolver.Candidate(id: "a", strokes: [stroke])
        #expect(RideTapResolver.hits(at: Point(x: 50, y: 0), among: [b, a]) == ["a", "b"])
        #expect(RideTapResolver.hits(at: Point(x: 50, y: 0), among: [a, b]) == ["a", "b"])
    }

    @Test("a ride is one answer however many of its strokes are under the tap")
    func oneAnswerPerRide() {
        let ride = RideTapResolver.Candidate(
            id: "a",
            strokes: [line([(0, 0), (100, 0)]), line([(0, 2), (100, 2)])])
        #expect(RideTapResolver.hits(at: Point(x: 50, y: 1), among: [ride]) == ["a"])
    }

    /// A stroke cut at a station can carry two identical vertices. Dividing by
    /// that segment's length would answer NaN, and NaN compares false against
    /// the tolerance — so the ride would vanish rather than being offered.
    @Test("a zero-length segment does not swallow the ride")
    func degenerateSegment() {
        let ride = RideTapResolver.Candidate(
            id: "a", strokes: [line([(10, 10), (10, 10)])])
        #expect(RideTapResolver.hits(at: Point(x: 12, y: 10), among: [ride]) == ["a"])
    }

    @Test("a stroke with fewer than two points draws nothing and hits nothing")
    func singlePointStroke() {
        let ride = RideTapResolver.Candidate(id: "a", strokes: [line([(10, 10)])])
        #expect(RideTapResolver.hits(at: Point(x: 10, y: 10), among: [ride]).isEmpty)
    }
}
