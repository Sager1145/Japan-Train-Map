import SwiftUI

/// Shape, quality and bitrate — and what the three of them add up to.
///
/// The web app puts these in a row beside the transport rather than in a
/// modal, "so the numbers a choice produces — pixels, bitrate, estimated file —
/// are visible beside the choice itself, before committing to a run that takes
/// minutes". A row of three selects does not fit across a phone, so this is a
/// sheet; the part that matters is kept, which is that the summary sits with
/// the controls and updates as they move.
///
/// §5.6 asks for exactly this shape: exporting is a secondary flow, and the
/// frame, quality and bitrate appear only once it is opened.
struct VideoExportOptionsView: View {
    @Bindable var settings: VideoExportSettings
    /// The map's own size in points, which is what the crop is taken from.
    let sourceSize: CGSize
    let displayScale: CGFloat
    /// The planned run, from `Playback.plan` — the only honest input to a file
    /// size, and zero when nothing is queued.
    let seconds: Double
    let onStart: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(AppLocalization.self) private var localization

    private var plan: VideoExportSettings.Plan {
        settings.plan(sourceSize: sourceSize, displayScale: displayScale)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(
                        localization.countryText("video.shape", fallback: "Frame"),
                        selection: $settings.shape
                    ) {
                        ForEach(VideoExportSettings.Shape.allCases) { shape in
                            Text(label(shape)).tag(shape)
                        }
                    }
                    Picker(
                        localization.countryText("video.quality", fallback: "Quality"),
                        selection: $settings.quality
                    ) {
                        ForEach(VideoExportSettings.Quality.allCases) { quality in
                            Text(label(quality)).tag(quality)
                        }
                    }
                    Picker(
                        localization.countryText("video.bitrate", fallback: "Bitrate"),
                        selection: $settings.bitrate
                    ) {
                        ForEach(VideoExportSettings.Bitrate.allCases) { bitrate in
                            Text(label(bitrate)).tag(bitrate)
                        }
                    }
                } footer: {
                    Text(
                        localization.journeyText(
                            "ios.video.qualityNote",
                            fallback:
                                "Quality is a ceiling, not a target: the map is never "
                                + "scaled up past what it is drawn at."))
                }

                Section {
                    LabeledContent(
                        localization.journeyText("ios.video.size", fallback: "Size"),
                        value: "\(plan.pixelDescription) · \(VideoExportSettings.framesPerSecond) fps")
                    LabeledContent(
                        localization.journeyText("ios.video.rate", fallback: "Bitrate"),
                        value: plan.megabitsPerSecond.formatted(
                            .number.precision(.fractionLength(1))) + " Mbps")
                    if seconds > 0 {
                        LabeledContent(
                            localization.journeyText("ios.video.length", fallback: "Length"),
                            value: Self.duration(seconds))
                        LabeledContent(
                            localization.journeyText("ios.video.estimate", fallback: "Estimated file"),
                            value: Self.bytes(plan.bytes(forSeconds: seconds)))
                    }
                } header: {
                    Text(localization.journeyText("ios.video.output", fallback: "Output"))
                } footer: {
                    if seconds <= 0 {
                        Text(
                            localization.journeyText(
                                "ios.video.noRun",
                                fallback:
                                    "No journey with a drawn route is in scope, so there is "
                                    + "nothing to film yet."))
                    }
                }
                .monospacedDigit()
            }
            .navigationTitle(localization.countryText("video.export", fallback: "Export video"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localization.text("ios.cancel", fallback: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(localization.countryText("video.start", fallback: "Start recording")) {
                        onStart()
                    }
                    .disabled(seconds <= 0)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - labels

    private func label(_ shape: VideoExportSettings.Shape) -> String {
        switch shape {
        case .square: localization.countryText("video.shape.square", fallback: "Square")
        case .wide: localization.countryText("video.shape.wide", fallback: "Wide 16:9")
        case .tall: localization.countryText("video.shape.tall", fallback: "Tall 9:16")
        case .native: localization.countryText("video.shape.native", fallback: "As shown")
        }
    }

    private func label(_ quality: VideoExportSettings.Quality) -> String {
        switch quality {
        case .q1080: localization.countryText("video.quality.q1080", fallback: "1080p")
        case .q720: localization.countryText("video.quality.q720", fallback: "720p")
        case .q540: localization.countryText("video.quality.q540", fallback: "540p")
        case .qmax: localization.countryText("video.quality.qmax", fallback: "Maximum")
        }
    }

    private func label(_ bitrate: VideoExportSettings.Bitrate) -> String {
        switch bitrate {
        case .high: localization.countryText("video.bitrate.high", fallback: "High")
        case .standard: localization.countryText("video.bitrate.standard", fallback: "Standard")
        case .small: localization.countryText("video.bitrate.small", fallback: "Small file")
        }
    }

    /// `formatDuration` — `m:ss`, the web app's own shape.
    static func duration(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        return "\(total / 60):\(String(format: "%02d", total % 60))"
    }

    static func bytes(_ value: Double) -> String {
        Int64(max(0, value)).formatted(.byteCount(style: .file))
    }
}
