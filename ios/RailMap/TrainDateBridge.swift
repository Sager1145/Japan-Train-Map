import Foundation
import RailCore

extension Train {
    /// The shape `RailCore.Dates` works in.
    ///
    /// `Dates` declares its own minimal train and stop rather than taking the
    /// full `Train`, because the two were ported in parallel by different
    /// workers and neither could depend on the other's model. That is a real
    /// seam, not a design: two models of one thing eventually disagree about
    /// it, and the disagreement will not show up in either port's fixtures
    /// because each is checked only against its own JavaScript.
    ///
    /// Closing it means making `Dates` operate on `Train` and regenerating the
    /// dates fixture. Until then this conversion is the single place the two
    /// meet, so there is one thing to delete rather than several.
    var forDates: Dates.Train {
        Dates.Train(
            id: id,
            date: date,
            stops: stops.map {
                Dates.Stop(arrival: $0.arrival, departure: $0.departure, stopType: $0.stopType)
            }
        )
    }
}
