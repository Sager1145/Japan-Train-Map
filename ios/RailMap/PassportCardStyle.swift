import SwiftUI

/// §6.1's **Memory JRM** personality, as stationery.
///
/// The spec gives this app two visual personalities and names exactly which
/// surfaces get which. Lists, map, detail, editor and import are *Operational*
/// — "calm / system-native / map-first". Statistics, replay covers and share
/// images are *Memory* — "expressive / railway-signage / route-colour /
/// ticket-and-map metaphors / editorial / souvenir-like". Passport is the one
/// screen the second column is written for, and until now it was drawn in the
/// first: seven identical `secondarySystemBackground` cards, each opening with
/// a `.headline` label, in the same stationery as the delete confirmation.
///
/// So this file is the passport's paper and ink and nothing else. It carries
/// no numbers and knows nothing about statistics — ``StatisticsDashboardContent``
/// composes the pages out of it — which is what keeps the Memory personality
/// from leaking anywhere §6.1 forbids it: a view has to ASK for a tone.
///
/// ## Three tones, and why not seven
///
/// A screen where every card shouts has no hero. The reference this is drawn
/// from (Flighty's Passport) is mostly quiet: one saturated data page, a
/// couple of tinted cards, and plain surfaces under the dense lists — so the
/// eye lands on the page that carries the headline numbers.
///
///   - ``PassportTone/feature`` is the data page: a deep gradient with white
///     ink, for the ONE card that answers the screen's question.
///   - ``PassportTone/soft`` is a passport page: the system card surface with
///     a tint wash and a keyline, for the cards that carry charts.
///   - ``PassportTone/plain`` is exactly the card this app already had, kept
///     for dense lists and for every non-statistics card in the workspace.
///
/// ## The colours, and §6.2
///
/// §6.2 bans scattered hex and reserves green / orange / red for status. Both
/// rules are kept here: every colour below is a **system palette** colour
/// (`systemBlue`, `systemIndigo`) resolved through a trait closure, deepened
/// by a factor rather than replaced by a literal, and none of the four status
/// hues appears — so no card on this screen can be misread as a state. The
/// deepening is what makes white ink legible: `systemBlue` under white text is
/// about 3.6:1, and the same hue at 70 % brightness is about 7:1.
///
/// It is deliberately **not** `Color.accentColor`. §6.2 gives the tint role to
/// "可点击、选中、当前路线", and a 200-point decorative surface is none of
/// those. The passport's colours are its own.
enum PassportTone: Equatable {
    /// The data page — deep gradient, white ink. At most one per screen.
    case feature
    /// A passport page — system surface, tint wash, hairline keyline.
    case soft
    /// The ordinary content card (§6.4's `radius-card` on a system surface).
    case plain
}

extension View {
    /// Draw this as one passport card.
    ///
    /// Also publishes ``PassportInk`` into the subtree, which is how the
    /// components below know whether they are drawing on colour without every
    /// call site having to say so twice (and get it wrong once).
    func passportCard(_ tone: PassportTone = .plain) -> some View {
        modifier(PassportCardSurface(tone: tone))
    }
}

// MARK: - ink

/// Which colours a card's contents draw in.
///
/// On a `.soft` or `.plain` card these are the semantic roles and nothing
/// else, so Increase Contrast and the dark appearance stay the system's
/// business. On a `.feature` card they are white at a set of opacities,
/// because there is no semantic colour for "on top of a saturated surface" —
/// `Color.primary` there would resolve to black in the light appearance and
/// vanish into the gradient.
struct PassportInk: Equatable {
    var onColor: Bool = false
    var increasedContrast: Bool = false

    static let plain = PassportInk()

    /// A heading or a figure — the thing being read.
    var title: Color { onColor ? .white : .primary }
    /// The small tracked label above a figure.
    var eyebrow: Color { onColor ? .white.opacity(increasedContrast ? 0.96 : 0.80) : .secondary }
    /// A caption under a figure, a footnote, a unit.
    var caption: Color { onColor ? .white.opacity(increasedContrast ? 0.92 : 0.72) : .secondary }
    /// A rule or divider.
    var rule: Color { onColor ? .white.opacity(0.24) : Color(.separator) }
    /// The translucent block a card nests inside itself — the reference's
    /// footer chip, and the highlight above a list.
    var chip: Color {
        onColor
            ? .white.opacity(increasedContrast ? 0.26 : 0.16)
            : Color(.systemIndigo).opacity(increasedContrast ? 0.18 : 0.10)
    }
    /// The unfilled part of a proportion bar…
    var track: Color { onColor ? .white.opacity(0.26) : Color.secondary.opacity(0.16) }
    /// …and the filled part. Never the positive/green role: §5.3.5 is explicit
    /// that a large number is not a success state.
    var fill: Color { onColor ? .white : Color.accentColor }
}

private struct PassportInkKey: EnvironmentKey {
    static let defaultValue = PassportInk.plain
}

extension EnvironmentValues {
    var passportInk: PassportInk {
        get { self[PassportInkKey.self] }
        set { self[PassportInkKey.self] = newValue }
    }
}

// MARK: - the paper

private struct PassportCardSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    var tone: PassportTone

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: RailStyle.cardCornerRadius, style: .continuous)
    }

    func body(content: Content) -> some View {
        content
            // §6.4: card padding 16–20. The data page takes the top of that
            // band because it is the only card whose margin is part of the
            // picture; the rest keep the 18 every card in this app used.
            .padding(tone == .feature ? 20 : 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { fill }
            .clipShape(shape)
            .overlay { edge }
            .environment(
                \.passportInk,
                PassportInk(onColor: tone == .feature, increasedContrast: contrast == .increased))
    }

    @ViewBuilder private var fill: some View {
        switch tone {
        case .feature:
            ZStack(alignment: .bottomTrailing) {
                PassportPalette.dataPage
                // The guilloche a passport prints under its data page, in the
                // one object this passport is about. Decoration, so it is
                // hidden from VoiceOver and drawn far below the ink: at a
                // tenth of white it reads as texture in both appearances and
                // as nothing at all through the text on top of it.
                Image(systemName: "train.side.front.car")
                    .font(.system(size: 120))
                    .foregroundStyle(.white.opacity(0.07))
                    .offset(x: 34, y: 30)
                    .accessibilityHidden(true)
            }
        case .soft:
            ZStack {
                Color.railElevated(.secondarySystemBackground)
                PassportPalette.wash
            }
        case .plain:
            Color.railElevated(.secondarySystemBackground)
        }
    }

    /// §6.5: under Increase Contrast a surface gains an edge rather than more
    /// colour. The soft tone carries its keyline always — the wash alone is
    /// too faint to say where the card stops.
    @ViewBuilder private var edge: some View {
        switch tone {
        case .feature:
            if contrast == .increased {
                shape.strokeBorder(Color.white.opacity(0.55), lineWidth: 1)
            }
        case .soft:
            shape.strokeBorder(PassportPalette.keyline, lineWidth: 1)
        case .plain:
            if contrast == .increased {
                shape.strokeBorder(Color(.separator), lineWidth: 1)
            }
        }
    }
}

/// The passport's own colours: two system hues, deepened.
enum PassportPalette {

    /// The data page. Blue into indigo along the diagonal, which is the
    /// direction the eye reads the card in.
    static var dataPage: LinearGradient {
        LinearGradient(
            colors: [
                deepened(.systemBlue, light: 0.30, dark: 0.44),
                deepened(.systemIndigo, light: 0.26, dark: 0.42),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }

    /// The tint wash on a soft card — the same two hues at the opacity where
    /// they colour the paper without colouring the text on it.
    static var wash: LinearGradient {
        LinearGradient(
            colors: [Color(.systemIndigo).opacity(0.12), Color(.systemBlue).opacity(0.04)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }

    static var keyline: Color {
        Color(
            UIColor { traits in
                let strong = traits.accessibilityContrast == .high
                return UIColor.systemIndigo.withAlphaComponent(strong ? 0.55 : 0.20)
            })
    }

    /// A system hue at a fraction of its own brightness.
    ///
    /// Derived rather than written down, for the reason §6.2 gives: a literal
    /// navy would not follow the appearance, would not answer Increase
    /// Contrast, and would not move when the system palette is revised. HSB
    /// keeps the hue exactly and touches only the two components that decide
    /// whether white text on it is legible.
    private static func deepened(_ base: UIColor, light: CGFloat, dark: CGFloat) -> Color {
        Color(
            UIColor { traits in
                let resolved = base.resolvedColor(with: traits)
                var hue: CGFloat = 0
                var saturation: CGFloat = 0
                var brightness: CGFloat = 0
                var alpha: CGFloat = 0
                guard
                    resolved.getHue(
                        &hue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
                else { return resolved }
                var amount = traits.userInterfaceStyle == .dark ? dark : light
                if traits.accessibilityContrast == .high { amount += 0.08 }
                return UIColor(
                    hue: hue,
                    saturation: min(1, saturation + 0.05),
                    brightness: max(0, brightness * (1 - amount)),
                    alpha: alpha)
            })
    }
}

/// The line a real passport prints in every language at once, in the four the
/// five networks of this app are read in.
///
/// Decoration, and deliberately NOT localized: a passport does not pick one of
/// these words for you, it prints them all. `Text(verbatim:)` because none of
/// it is a key, and hidden from VoiceOver because it says nothing a reader
/// needs said.
struct PassportBookletLine: View {
    @Environment(\.passportInk) private var ink

    var body: some View {
        Text(verbatim: "PASSPORT · パスポート · 護照 · 여권")
            .font(.caption2.weight(.medium))
            .tracking(1.1)
            .foregroundStyle(ink.caption)
            // Chrome bounds, and the one `minimumScaleFactor` in this file.
            // `RailType`'s contract bans it inside a `ViewThatFits` candidate
            // (it makes any width "fit") and §10.1 bans it as an answer to a
            // layout problem — neither applies to a line that carries no
            // information and has to stay on one line to read as engraving.
            .railType(.chrome)
            .minimumScaleFactor(0.7)
            .accessibilityHidden(true)
    }
}

// MARK: - the pieces a page is set from

/// The small tracked label above a figure — the reference's "FLIGHTS",
/// "DISTANCE", "FLIGHT TIME".
///
/// Uppercased through the environment rather than in the string, so the
/// Japanese and Chinese labels (乗車時間, 停靠站) pass through untouched while
/// the English ones read as the document labels they are imitating. The
/// tracking does the same job in every script.
struct PassportEyebrow: View {
    @Environment(\.passportInk) private var ink
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .tracking(0.7)
            .foregroundStyle(ink.eyebrow)
            .railType(.metricLabel)
    }
}

/// A card's head row: its label, and whatever control belongs to that card.
struct PassportCardHeader<Accessory: View>: View {
    @Environment(\.passportInk) private var ink
    let title: String
    var systemImage: String?
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ink.eyebrow)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.subheadline.weight(.bold))
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(ink.title)
                .railType(.title)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            accessory()
        }
    }
}

extension PassportCardHeader where Accessory == EmptyView {
    init(_ title: String, systemImage: String? = nil) {
        self.init(title: title, systemImage: systemImage) { EmptyView() }
    }
}

/// The one figure a card is about: value, unit, and the line under it.
struct PassportHeadline: View {
    /// How loud this figure is. A page has ONE ``page`` headline; a figure
    /// inside a stamped block is a ``field``, or the day would shout down the
    /// total it is a part of.
    enum Prominence {
        case page
        case field
    }

    @Environment(\.passportInk) private var ink
    /// What the figure IS, for VoiceOver — the eyebrow is not always the
    /// answer, because a headline sometimes sits under a card header instead.
    let label: String
    let value: String
    /// The whole block, spoken. `--` read as dashes says nothing, so the
    /// caller spells the unset state as a sentence.
    let spoken: String
    var unit: String?
    var caption: String?
    var prominence: Prominence = .page

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(value)
                    .font(
                        .system(
                            prominence == .page ? .largeTitle : .title,
                            design: .rounded
                        ).bold())
                    .monospacedDigit()
                    .foregroundStyle(ink.title)
                    .railType(.metricValueStacked)
                    // Inert unless the change arrives inside an animated
                    // transaction, and these land from an async store that has
                    // none — so the token is spelled here. §9.4 keeps numeric
                    // updates out of `RailMotion.animation`'s Reduce Motion
                    // path on purpose.
                    .contentTransition(.numericText())
                    .animation(RailMotion.replace, value: value)
                if let unit {
                    Text(unit)
                        .font(
                            (prominence == .page ? Font.title3 : Font.subheadline)
                                .weight(.semibold))
                        .foregroundStyle(ink.caption)
                        .railType(.metricLabel)
                }
            }
            if let caption {
                Text(caption)
                    .font(prominence == .page ? .subheadline : .caption)
                    .monospacedDigit()
                    .foregroundStyle(ink.caption)
                    .railType(.content)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(label))
        .accessibilityValue(Text(spoken))
    }
}

/// The translucent block a card nests inside itself — the reference's footer
/// chip, and the field a passport stamps a single day into.
///
/// §6.4: a block INSIDE a card takes `radius-control`, never the card's own
/// radius, because radius is what expresses depth here.
extension View {
    func passportBlock() -> some View { modifier(PassportBlockSurface()) }
}

private struct PassportBlockSurface: ViewModifier {
    @Environment(\.passportInk) private var ink

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                ink.chip,
                in: RoundedRectangle(
                    cornerRadius: RailStyle.controlCornerRadius, style: .continuous))
    }
}

/// A hairline that follows the paper it is drawn on. `Divider()` resolves the
/// system separator, which is a dark grey line and invisible on a feature
/// card.
struct PassportRule: View {
    @Environment(\.passportInk) private var ink

    var body: some View {
        Rectangle()
            .fill(ink.rule)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}

/// A label and its figure on one line — the compact form of a group the card
/// has already stated in full.
struct PassportRow: View {
    @Environment(\.passportInk) private var ink
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(ink.title)
                .railType(.content)
            Spacer(minLength: 8)
            Text(value)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(ink.caption)
                .multilineTextAlignment(.trailing)
                .railType(.content)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The reference's metric block: a tiny label, a figure, and an optional line
/// of colour under it ("4 Long Haul", "1.4x around the world").
///
/// Laid out by an ADAPTIVE grid rather than by `ViewThatFits`, which is the
/// one structural difference from ``StatisticsMetricGrid`` and the reason this
/// is a second component rather than a restyling of the first. The candidate
/// walk in that grid needs every figure to state its true width on one line
/// (see `RailType`'s contract); here the column count comes from a scaled
/// minimum instead, so a long figure may wrap INSIDE its cell and a caption
/// underneath cannot break the row's shared baseline — there is no shared
/// baseline to break.
struct PassportMetricGrid: View {
    struct Item: Identifiable {
        let label: String
        let value: String
        var caption: String?
        var id: String { label }

        init(_ label: String, _ value: String, caption: String? = nil) {
            self.label = label
            self.value = value
            self.caption = caption
        }
    }

    @Environment(\.passportInk) private var ink
    /// Two across on a phone at the default text size, one at accessibility
    /// sizes — §10.1's "空间不足时改为纵向", reached by measurement rather than
    /// by a size class.
    @ScaledMetric(relativeTo: .title2) private var columnMinimum: CGFloat = 120

    let items: [Item]

    var body: some View {
        LazyVGrid(
            columns: [
                GridItem(.adaptive(minimum: columnMinimum), spacing: 16, alignment: .topLeading)
            ],
            alignment: .leading,
            spacing: 18
        ) {
            ForEach(items) { item in cell(item) }
        }
    }

    private func cell(_ item: Item) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            PassportEyebrow(item.label)
            Text(item.value)
                .font(.system(.title2, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(ink.title)
                .railType(.metricValueStacked)
                .contentTransition(.numericText())
                .animation(RailMotion.replace, value: item.value)
            if let caption = item.caption {
                Text(caption)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(ink.caption)
                    .railType(.metricLabel)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The block a card nests inside itself — the reference's footer chip.
///
/// Here it carries a figure rather than a navigation: the detail this would
/// push to is the next card down in the same scroll view, and a button that
/// scrolls the reader somewhere they can already see is furniture (§5.3.2 says
/// the same thing about the inline map that used to sit here).
struct PassportBand: View {
    @Environment(\.passportInk) private var ink
    let label: String
    let value: String
    var detail: String?
    /// 0…1, or `nil` for a band with no proportion to show.
    var fraction: Double?
    let spoken: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                PassportEyebrow(label)
                Spacer(minLength: 8)
                Text(value)
                    .font(.subheadline.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(ink.title)
                    .railType(.metricValue)
            }
            if let fraction {
                GeometryReader { geometry in
                    Capsule()
                        .fill(ink.track)
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(ink.fill)
                                .frame(width: geometry.size.width * clamp(fraction))
                        }
                }
                .frame(height: 6)
            }
            if let detail {
                Text(detail)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(ink.caption)
                    .railType(.metricLabel)
            }
        }
        .passportBlock()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(label))
        .accessibilityValue(Text(spoken))
    }

    private func clamp(_ fraction: Double) -> CGFloat {
        guard fraction.isFinite else { return 0 }
        return CGFloat(min(max(fraction, 0), 1))
    }
}

/// The one row a list is worth opening for, lifted out of the list — the
/// reference's "Most flown aircraft".
struct PassportHighlight: View {
    @Environment(\.passportInk) private var ink
    let eyebrow: String
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            PassportEyebrow(eyebrow)
            Text(title)
                .font(.system(.title3, design: .rounded).weight(.bold))
                .foregroundStyle(ink.title)
                .railType(.content)
            Text(detail)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(ink.caption)
                .railType(.metricLabel)
        }
        .passportBlock()
        .accessibilityElement(children: .combine)
    }
}

/// A capsule of metadata on a card's head row — the scope, the region.
struct PassportChip: View {
    @Environment(\.passportInk) private var ink
    let text: String
    var systemImage: String?

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage).font(.caption2.weight(.semibold))
            }
            Text(text)
                .font(.footnote.weight(.semibold))
                .monospacedDigit()
        }
        .foregroundStyle(ink.title)
        .railType(.chrome)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(ink.chip, in: Capsule())
    }
}

/// A quiet note at the foot of a card — §5.7's neutral wording for unmatched
/// distance, which is information about coverage rather than a data error and
/// must not borrow the critical role's colour.
struct PassportNote: View {
    @Environment(\.passportInk) private var ink
    let title: String
    let message: String
    var systemImage: String = "info.circle"

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .railType(.content)
                Text(message)
                    .font(.footnote)
                    .railType(.content)
            }
        } icon: {
            Image(systemName: systemImage)
        }
        .foregroundStyle(ink.caption)
        .accessibilityElement(children: .combine)
    }
}
