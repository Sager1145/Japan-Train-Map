import SwiftUI

/// **排版契约：每个文本角色都有字号上限与下限。这条不可移除。**
///
/// See `ios/README.md`, "The typography contract", for the prose version and
/// the reason it is a contract rather than a convention.
///
/// ## What this is for
///
/// Layout in this app has broken the same way four separate times, and every
/// time the mechanism was a piece of text free to grow or shrink without a
/// stated bound:
///
///   - 「197 時間 9 分」 wrapped to two lines in a four-across metric row, so
///     its caption sat a line below the other three and the row lost its
///     baseline.
///   - The editor's navigation title reached the toolbar as 「乗車記録…」.
///   - The journey card's date chip was crushed to a sliver at an
///     accessibility size and the train name drew on top of it.
///   - A button carrying `minimumScaleFactor` reported that it fitted any
///     width, so the `ViewThatFits` above it never reached the candidate that
///     actually fitted.
///
/// A bound is not a licence to shrink text. §10.1 is explicit — 「空间不足时改
/// 为纵向，不通过无限缩小字体解决」 — so the ceiling exists to stop a layout
/// from being asked a question it cannot answer, and the floor exists to stop
/// the answer being illegible. Where the two would collide, the LAYOUT gives
/// way: that is what `.content` below means by having no line limit.
///
/// ## The two rules that are easy to get wrong
///
/// 1. **Never put `minimumScaleFactor` on anything that is, or is inside, a
///    `ViewThatFits` candidate.** It satisfies any width by squashing its own
///    text, so the candidate always "fits" and the later candidates are dead
///    code. A candidate has to state its true width — that is what
///    ``Role/metricValue`` does with `lineLimit(1)` plus `fixedSize`. The rule
///    is transitive: it binds every view in a candidate's subtree, not only
///    the one the `ViewThatFits` names.
/// 2. **`Text` answers a height proposal that is too short by dropping a line
///    and truncating, not by overflowing.** So a reserved height computed from
///    a `@ScaledMetric` under-estimates real line height at accessibility
///    sizes and silently truncates. Release the height constraint once the
///    container is fully open, and pair it with
///    `fixedSize(horizontal: false, vertical: true)`.
///
/// Both were found by measurement, not by reading, and both cost a session
/// each.
nonisolated enum RailType {

    /// What a piece of text is FOR, which is what decides how far it may move.
    ///
    /// Deliberately not named after sizes. A role survives a redesign; a name
    /// like `.small` invites the next person to pick it for how it looks.
    enum Role {
        /// A figure in a dense tile — a metric row, a statistics card.
        ///
        /// Follows the reader all the way up — on a statistics screen the
        /// figure is the content, not chrome. What is bounded here is the
        /// SHAPE, not the size: one line, stating its true width, so the grid
        /// above can honestly decide between four-across, two-by-two and
        /// stacked instead of being told that everything fits.
        case metricValue
        /// The same figure in the STACKED arrangement, where the grid has run
        /// out of candidates to fall back to.
        ///
        /// Identical bounds to ``metricValue`` and one difference that matters:
        /// it may take a second line. `metricValue` states its true width on
        /// one line precisely so the grid can reject the across arrangements —
        /// but under the last candidate there is nothing left to reject into,
        /// so the same rule there would overflow the card instead of wrapping
        /// inside it.
        case metricValueStacked
        /// The caption under a ``metricValue``. Two lines, because a caption
        /// is words and words wrap — and the one capped role in this pair,
        /// held at or below the figure it labels. A caption that out-sizes its
        /// own value inverts the hierarchy exactly as surely as the reverse.
        case metricLabel
        /// Chrome: a control's glyph, a bar label, a scope capsule. Barely
        /// moves — §7.7's note is that chrome is not reading text, and a map
        /// control that grows past its 48-point capsule is less usable, not
        /// more.
        case chrome
        /// A heading. Follows the reader all the way up, but is allowed to
        /// take a second line rather than shrink to fit one.
        case title
        /// Reading text — a journey name, a station, a status sentence, body
        /// copy.
        ///
        /// Its ceiling is the system maximum: this is the role §14.4 is about,
        /// and it must reach `.accessibility5` intact. It carries no line
        /// limit on purpose. When it does not fit, the CONTAINER changes shape
        /// — that is the whole of §10.1.
        case content
    }

    /// The floor and ceiling for a role, as Dynamic Type sizes.
    static func range(_ role: Role) -> ClosedRange<DynamicTypeSize> {
        switch role {
        // A floor of `.xSmall` everywhere rather than `.large`: the reader who
        // has turned text DOWN has done it deliberately and gets what they
        // asked for. The bounds exist to protect layout from the top end.
        //
        // NOT capped, and the reasoning is the point: on a statistics screen
        // the figure IS the content — 「8,266 km」 is the answer the reader
        // opened the screen for. A ceiling here below the one on `.content`
        // and `.title` would render the prose in the same card LARGER than the
        // number it describes, which inverts the hierarchy at exactly the text
        // size where it matters most. The cap also bought nothing:
        // a metric layout already degrades from across to stacked — by a
        // `ViewThatFits` walk, or by the adaptive column count
        // `PassportMetricGrid` uses — and with the figure stating its true
        // width (or wrapping inside a fixed column) that happens on its own.
        // This is gotcha 6 in the handoff — a size problem answered with a
        // ceiling when the layout was already able to answer it.
        case .metricValue, .metricValueStacked: DynamicTypeSize.xSmall ... .accessibility5
        // The caption stays capped, and stays at or below the figure it
        // labels: a label that out-sizes its own value is the same inversion
        // from the other direction.
        case .metricLabel: DynamicTypeSize.xSmall ... .accessibility1
        case .chrome: DynamicTypeSize.xSmall ... .xxLarge
        case .title: DynamicTypeSize.xSmall ... .accessibility5
        case .content: DynamicTypeSize.xSmall ... .accessibility5
        }
    }

    /// How many lines the role may take. `nil` means unbounded — the container
    /// is expected to give way instead.
    static func lineLimit(_ role: Role) -> Int? {
        switch role {
        case .metricValue: 1
        case .metricValueStacked: 2
        case .metricLabel: 2
        case .chrome: 1
        case .title: 2
        case .content: nil
        }
    }
}

extension View {
    /// Apply a role's typographic bounds.
    ///
    /// One call rather than three modifiers at each site, so a role added
    /// later cannot be applied half-way — and so that the contract is
    /// greppable: every bounded piece of text in this app says `railType`.
    func railType(_ role: RailType.Role) -> some View {
        modifier(RailTypeBounds(role: role))
    }
}

private struct RailTypeBounds: ViewModifier {
    var role: RailType.Role

    func body(content: Content) -> some View {
        content
            .dynamicTypeSize(RailType.range(role))
            .lineLimit(RailType.lineLimit(role))
            // §10.1 again, from the other side: a role that is allowed to wrap
            // has to be ALLOWED THE HEIGHT to wrap into, or `Text` answers the
            // short proposal by truncating instead (see the type note above).
            .fixedSize(horizontal: false, vertical: true)
    }
}
