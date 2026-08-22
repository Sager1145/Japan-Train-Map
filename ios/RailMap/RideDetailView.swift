import RailCore
import SwiftUI

/// One recorded journey, stop by stop.
///
/// Everything shown here comes straight off the ported `Train`, so the app can
/// present a complete itinerary today — before the route solver lands and the
/// ride can be drawn on the map. That ordering is deliberate: the record is
/// the thing the app is *for*, and being able to read it is worth more than
/// waiting to be able to draw it.
struct RideDetailView: View {
    let train: Train

    var body: some View {
        List {
            Section {
                LabeledContent("Train", value: train.number)
                if let type = train.trainType, !type.isEmpty {
                    LabeledContent("Type", value: type)
                }
                if let company = train.company, !company.isEmpty {
                    LabeledContent("Operator", value: company)
                }
                LabeledContent("From", value: train.origin)
                LabeledContent("To", value: train.destination)
                if let date = train.date { LabeledContent("Date", value: date) }
            }

            Section("Stops") {
                ForEach(Array(train.stops.enumerated()), id: \.offset) { _, stop in
                    stopRow(stop)
                }
            }
        }
        .navigationTitle(train.number)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func stopRow(_ stop: Stop) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // A pass-through is drawn differently on the map and read
            // differently here: the reader did not get off, and the row should
            // not look like a call.
            Image(systemName: symbol(for: stop))
                .imageScale(.small)
                .foregroundStyle(stop.rideSegment ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                .frame(width: 16)

            // The line a stop is on lives on the route section, not the stop,
            // so it is not shown here — showing a guessed one would be worse
            // than showing none.
            Text(stop.name)
                .foregroundStyle(stop.rideSegment ? .primary : .secondary)

            Spacer()

            VStack(alignment: .trailing, spacing: 1) {
                if let arrival = stop.arrival, !arrival.isEmpty {
                    Text(arrival).font(.caption).monospacedDigit()
                }
                if let departure = stop.departure, !departure.isEmpty {
                    Text(departure)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func symbol(for stop: Stop) -> String {
        switch stop.stopType {
        case "pass_through": "circle.dotted"
        case "origin", "destination": "circle.fill"
        default: "circle"
        }
    }
}
