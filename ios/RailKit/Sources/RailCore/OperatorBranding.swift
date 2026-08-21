import Foundation

/// Operator naming and logo rules — ported from `app-operator-branding.js`.
///
/// Nothing here is computed. It is eleven exact-match tables and four fallback
/// chains that decide two things a passenger sees: the short company label
/// beside a line's name, and which artwork the line wears. That makes it a
/// classifier, and a classifier's port is only as good as its handling of the
/// inputs nobody thought to sample.
///
/// **Why this file re-implements string comparison.** Every lookup here is by
/// whole string, and JavaScript compares strings by UTF-16 code unit. Swift
/// does not: `String` equality — and therefore `Dictionary`, `Set`, `hasPrefix`
/// and `contains` — is defined on canonical equivalence, so a decomposed
/// アルピコ交通 (ヒ + U+309A) matches the composed table key in Swift and misses
/// it in JavaScript. `CharacterSet.whitespacesAndNewlines` disagrees with
/// ECMAScript's trim in both directions: it lacks U+FEFF, which JavaScript
/// trims, and contains U+0085, which JavaScript does not. All four of those
/// differences appear in this data — the packages carry CJK, full-width forms
/// and one operator whose real name contains U+3000 — so the tables are keyed
/// on code units and the trim and prefix tests are written out longhand below.
/// A port that leaned on Swift's defaults would compile, pass review, and
/// quietly print a different company name than the web app for the same line.
public enum OperatorBranding {

    // MARK: - the argument

    /// The duck-typed `line` object the JavaScript reads.
    ///
    /// The app calls `logoForLine` with `network.lineById`'s objects, never
    /// with a compact-package row: the package stores `logo: 1`, meaning only
    /// "artwork was downloaded", and the network builder is what turns that
    /// flag into a `/rail/logos/<id>.png` path. Both `lineId` and `id` are
    /// carried because the JavaScript accepts either — the network spells it
    /// `lineId`, the package spells it `id`.
    public struct Line: Sendable, Equatable {
        public var lineId: String?
        public var id: String?
        public var `operator`: String?
        public var logo: String?

        public init(
            lineId: String? = nil,
            id: String? = nil,
            operator: String? = nil,
            logo: String? = nil
        ) {
            self.lineId = lineId
            self.id = id
            self.operator = `operator`
            self.logo = logo
        }
    }

    // MARK: - company labels

    /// One operator's passenger-facing short name.
    ///
    /// The tables are consulted **before** the legal-form strips, which is why
    /// `株式会社東急電鉄` becomes `東急電鉄` and not `東急`: the table key is the
    /// bare `東急電鉄`, and by the time the strip has produced it the lookup is
    /// already behind us. That looks like an oversight and is reproduced
    /// exactly, because the fixture records what the web app answers today.
    private static func labelOne(_ name: String) -> String {
        // `if (!name)` — the empty string is the only falsy value that reaches
        // here, since the caller has already coerced and split.
        if name.isEmpty { return "" }
        // Region order is the JavaScript's: Macao, Hong Kong, Taiwan, Japan.
        // No two tables share a key today, so the order is not load-bearing —
        // but it is the order a future collision would be resolved in.
        //
        // The JavaScript tests each VALUE for truthiness rather than the key
        // for presence. Identical to this only because no table maps to "" — a
        // future empty value would fall through to the strips instead.
        if let hit = macaoCompanyLabels[name] { return hit }
        if let hit = hongKongCompanyLabels[name] { return hit }
        if let hit = taiwanCompanyLabels[name] { return hit }
        if let hit = companyLabels[name] { return hit }
        return JSText.trim(
            JSText.removingLeadingOccurrence(
                of: legalPrefixes,
                in: JSText.removingAllOccurrences(of: companySuffixes, in: name)
            )
        )
    }

    /// The label for a whole operator field, which may name several companies.
    ///
    /// `/` separates co-operators (a line run jointly). Empty halves are
    /// dropped by `filter(Boolean)`, so `"東急電鉄//京王電鉄"` and
    /// `"東急電鉄/京王電鉄"` give the same answer.
    public static func companyLabel(_ operatorField: String?) -> String {
        JSText.split(operatorField ?? "", separator: slash)
            .map { labelOne(JSText.trim($0)) }
            .filter { !$0.isEmpty }
            .joined(separator: "/")
    }

    /// Maps Taiwan's many official spellings onto one passenger-facing name.
    ///
    /// Itinerary records store the short company name while route constraints
    /// keep the rail package's full official one, and Taiwan publishes both
    /// 臺 and 台 forms of most of them. Unlike ``companyLabel`` this leaves
    /// anything it does not recognise exactly as it found it — it is a
    /// normaliser, not a shortener.
    public static func normalizeTaiwanCompanyName(_ value: String?) -> String {
        JSText.split(value ?? "", separator: slash)
            .map { part -> String in
                let trimmed = JSText.trim(part)
                return taiwanCompanyLabels[trimmed] ?? trimmed
            }
            .filter { !$0.isEmpty }
            .joined(separator: "/")
    }

    /// The company label to show beside a line name, or "" to show none.
    ///
    /// Suppressed when the name already begins with the company, so that a
    /// popup reads 東急東横線 rather than 東急 東急東横線. Both spellings are
    /// tested — the short label and the raw operator string — because a line
    /// may be named after either.
    ///
    /// `startsWith` is a UTF-16 code-unit comparison. Swift's `hasPrefix` is
    /// not: it compares grapheme clusters, so a name written with a combining
    /// dakuten (カ + U+3099) is *not* prefixed by カ there while it is here.
    /// That single difference is enough to make the two apps print different
    /// popups for the same line, which is why ``JSText/hasPrefix(_:_:)`` exists.
    public static func companyFor(operator operatorField: String?, lineName: String?) -> String {
        let label = companyLabel(operatorField)
        if label.isEmpty { return "" }
        let name = lineName ?? ""
        if JSText.hasPrefix(name, label) { return "" }
        // `if (operator && ...)` — an empty operator string is falsy and skips
        // this test entirely.
        if let operatorField, !operatorField.isEmpty, JSText.hasPrefix(name, operatorField) {
            return ""
        }
        return label
    }

    // MARK: - logos

    /// The operator's own mark, if one is published for that exact string.
    ///
    /// Three Japanese tables are tried against the RAW operator, then Macao and
    /// Hong Kong two-hop through their label into ``operatorLogos``, then
    /// Taiwan normalises first. The raw/label asymmetry is the reason a large
    /// number of well-known railways have a label and no mark: the badge tables
    /// are keyed on short names like 東京メトロ, while operators such as 東急電鉄,
    /// 京王電鉄, 小田急電鉄, 西武鉄道, 東武鉄道, 阪急電鉄, 阪神電気鉄道,
    /// 近畿日本鉄道, 南海電気鉄道, 名古屋鉄道, 京成電鉄, 京浜急行電鉄, 相模鉄道
    /// and the municipal operators reach this function under their full legal
    /// names and match nothing. Reproduced, not repaired.
    public static func operatorLogo(_ operatorField: String?) -> String? {
        let raw = JSText.trim(operatorField ?? "")
        if let hit = japanOperatorBadgeOverrides[raw] { return hit }
        if let hit = japanOperatorLogos[raw] { return hit }
        if let hit = japanPackageOperatorLogos[raw] { return hit }
        // `OPERATOR_LOGOS[MACAO_COMPANY_LABELS[raw]]`: a miss in the first
        // lookup indexes the second with `undefined`, which is a miss too, so
        // falling through is the same behaviour.
        if let label = macaoCompanyLabels[raw], let hit = operatorLogos[label] { return hit }
        if let label = hongKongCompanyLabels[raw], let hit = operatorLogos[label] { return hit }
        // Taiwan's normaliser returns its input unchanged when it recognises
        // nothing, which is what lets an already-short 台鐵 resolve here.
        if let hit = operatorLogos[normalizeTaiwanCompanyName(raw)] { return hit }
        return nil
    }

    /// A verified badge for this exact line id, if the app publishes one.
    ///
    /// A missing id indexes the table with `undefined` in JavaScript, which is
    /// a miss, so returning nil for nil is the same answer and not a guard
    /// added for Swift's benefit.
    public static func lineLogo(_ lineId: String?) -> String? {
        guard let lineId else { return nil }
        return lineLogos[lineId]
    }

    /// The package's own badge for a line — but only where it is a line badge.
    ///
    /// The package flag originally meant no more than "an image was
    /// downloaded". The audit set it is checked against holds the ones that
    /// turned out to be company marks, generic Shinkansen marks, out-of-scope
    /// regional JR codes, three historical predecessor marks and one
    /// parent-company mark; none of those may outrank the line's real operator.
    ///
    /// The set is consulted with the stroke's OWN id, and split parts and
    /// paired alignments carry their parent's artwork under a suffixed id
    /// (`jp-東日本旅客鉄道-中央線-2`) that the set does not contain. Seventeen
    /// strokes therefore keep exactly the company marks the audit exists to
    /// reject. That is what the JavaScript does today and the fixture records
    /// it; changing it is a data decision, not a porting one.
    public static func verifiedPackageLineLogo(_ line: Line?) -> String? {
        // `if (!line || !line.logo)` — an empty logo string is falsy and stops
        // here, before the audit set is ever consulted.
        guard let line, let logo = line.logo, !logo.isEmpty else { return nil }
        let lineId = firstTruthy(line.lineId, line.id) ?? ""
        // The `jp-` guard is part of the rule, not an optimisation: every entry
        // in the set is a Japanese id, and a non-Japanese line keeps whatever
        // badge the package gave it without being examined at all.
        if JSText.hasPrefix(lineId, "jp-"), japanNonLineLogoIds.contains(lineId) {
            return nil
        }
        return logo
    }

    /// The badge a line actually draws: package art, then the per-line table,
    /// then the operator's mark.
    ///
    /// The order is the JavaScript's `||` chain. `??` is faithful here only
    /// because no step can produce the empty string — the package badge is
    /// guarded above and no table maps to "" — so nothing falsy-but-present can
    /// reach it.
    public static func logoForLine(_ line: Line?) -> String? {
        guard let line else { return nil }
        return verifiedPackageLineLogo(line)
            ?? lineLogo(firstTruthy(line.lineId, line.id))
            ?? operatorLogo(line.operator)
    }

    /// Whether a logo needs a dark matte behind it in the hover popup.
    ///
    /// These are the operators' correct current marks, drawn predominantly in
    /// white because their official sites place them on a dark header. Only
    /// these get a matte, so the original artwork stays legible in both themes.
    /// Note there is no trim: the set is matched against the string as given.
    public static func logoNeedsDarkMatte(_ logo: String?) -> Bool {
        logosRequiringDarkMatte.contains(logo ?? "")
    }

    // MARK: - JavaScript's `a || b` over strings

    /// `a || b` for strings, where "" is falsy and Swift's `??` would keep it.
    private static func firstTruthy(_ values: String?...) -> String? {
        for value in values {
            if let value, !value.isEmpty { return value }
        }
        return nil
    }

    private static let slash: UInt16 = 0x002F

    /// Stripped wherever they appear, before the anchored prefixes below. The
    /// order of the two passes is what makes 公益財団法人株式会社X resolve to X.
    private static let companySuffixes = ["株式会社", "有限会社"]

    /// Stripped only at the start of the name.
    private static let legalPrefixes = [
        "一般社団法人", "一般財団法人", "公益社団法人", "公益財団法人", "地方独立行政法人",
    ]

    // MARK: - the tables
    //
    // Transcribed mechanically from the JavaScript's own closure rather than by
    // hand. Every character that cannot be seen is written as an escape, so
    // that no two entries can differ by something invisible in review.

    private static let companyLabels = CodeUnitTable([
        ("東日本旅客鉄道", "JR東日本"),
        ("西日本旅客鉄道", "JR西日本"),
        ("東海旅客鉄道", "JR東海"),
        ("九州旅客鉄道", "JR九州"),
        ("北海道旅客鉄道", "JR北海道"),
        ("四国旅客鉄道", "JR四国"),
        ("東京地下鉄", "東京メトロ"),
        ("東京都", "都営"),
        ("大阪市高速電気軌道", "大阪メトロ"),
        ("名古屋市", "名古屋市営"),
        ("横浜市", "横浜市営"),
        ("神戸市", "神戸市営"),
        ("京都市", "京都市営"),
        ("札幌市", "札幌市営"),
        ("仙台市", "仙台市営"),
        ("福岡市", "福岡市営"),
        ("熊本市", "熊本市電"),
        ("鹿児島市", "鹿児島市電"),
        ("函館市", "函館市電"),
        ("一般社団法人札幌市交通事業振興公社", "札幌市電"),
        ("東急電鉄", "東急"),
        ("京王電鉄", "京王"),
        ("京成電鉄", "京成"),
        ("京浜急行電鉄", "京急"),
        ("小田急電鉄", "小田急"),
        ("西武鉄道", "西武"),
        ("東武鉄道", "東武"),
        ("相模鉄道", "相鉄"),
        ("近畿日本鉄道", "近鉄"),
        ("南海電気鉄道", "南海"),
        ("京阪電気鉄道", "京阪"),
        ("阪急電鉄", "阪急"),
        ("阪神電気鉄道", "阪神"),
        ("名古屋鉄道", "名鉄"),
        ("西日本鉄道", "西鉄"),
    ])

    private static let taiwanCompanyLabels = CodeUnitTable([
        ("國營臺灣鐵路股份有限公司", "台鐵"),
        ("臺灣鐵路股份有限公司", "台鐵"),
        ("台灣鐵路股份有限公司", "台鐵"),
        ("交通部臺灣鐵路管理局", "台鐵"),
        ("臺灣鐵路管理局", "台鐵"),
        ("台灣鐵路管理局", "台鐵"),
        ("臺鐵", "台鐵"),
        ("台鐵", "台鐵"),
        ("台灣高速鐵路股份有限公司", "台灣高鐵"),
        ("臺灣高速鐵路股份有限公司", "台灣高鐵"),
        ("台灣高速鐵路", "台灣高鐵"),
        ("臺灣高速鐵路", "台灣高鐵"),
        ("臺灣高鐵", "台灣高鐵"),
        ("台灣高鐵", "台灣高鐵"),
        ("臺北大眾捷運股份有限公司", "台北捷運"),
        ("台北大眾捷運股份有限公司", "台北捷運"),
        ("臺北捷運", "台北捷運"),
        ("台北捷運", "台北捷運"),
        ("新北大眾捷運股份有限公司", "新北捷運"),
        ("新北捷運股份有限公司", "新北捷運"),
        ("新北捷運", "新北捷運"),
        ("桃園大眾捷運股份有限公司", "桃園捷運"),
        ("桃園捷運股份有限公司", "桃園捷運"),
        ("桃園捷運", "桃園捷運"),
        ("臺中捷運股份有限公司", "台中捷運"),
        ("台中捷運股份有限公司", "台中捷運"),
        ("臺中捷運", "台中捷運"),
        ("台中捷運", "台中捷運"),
        ("高雄捷運股份有限公司", "高雄捷運"),
        ("高雄捷運", "高雄捷運"),
        ("農業部林業及自然保育署阿里山林業鐵路及文化資產管理處", "阿里山林鐵"),
        ("農業部阿里山林業鐵路及文化資產管理處", "阿里山林鐵"),
        ("阿里山林業鐵路及文化資產管理處", "阿里山林鐵"),
        ("阿里山林業鐵路", "阿里山林鐵"),
        ("阿里山林鐵", "阿里山林鐵"),
    ])

    private static let hongKongCompanyLabels = CodeUnitTable([
        ("MTR", "MTR"),
        ("香港鐵路有限公司", "MTR"),
        ("香港鐵路有限公司 MTR Corporation", "MTR"),
        ("MTR Corporation Limited", "MTR"),
        ("香港電車", "香港電車"),
        ("香港电车", "香港電車"),
        ("香港電車有限公司", "香港電車"),
        ("Hongkong Tramways Limited", "香港電車"),
        ("Hong Kong Tramways", "香港電車"),
    ])

    private static let macaoCompanyLabels = CodeUnitTable([
        ("澳門輕軌", "澳門輕軌"),
        ("澳门轻轨", "澳門輕軌"),
        ("澳門輕軌股份有限公司", "澳門輕軌"),
        ("澳门轻轨股份有限公司", "澳門輕軌"),
        ("Macao Light Rapid Transit Corporation, Limited", "澳門輕軌"),
        ("Macao LRT", "澳門輕軌"),
    ])

    private static let japanOperatorBadgeOverrides = CodeUnitTable([
        ("アルピコ交通", "/rail/operator-logos/jp-badges/badge-001.png"),
        ("えちごトキめき鉄道", "/rail/operator-logos/jp-badges/badge-002.png"),
        ("えちぜん鉄道", "/rail/operator-logos/jp-badges/badge-003.png"),
        ("くま川鉄道", "/rail/operator-logos/jp-badges/badge-004.png"),
        ("こうべ未来都市機構", "/rail/operator-logos/jp-badges/badge-005.png"),
        ("しなの鉄道", "/rail/operator-logos/jp-badges/badge-006.png"),
        ("とさでん交通", "/rail/operator-logos/jp-badges/badge-007.png"),
        ("ラクテンチ", "/rail/operator-logos/jp-badges/badge-008.png"),
        ("伊賀鉄道", "/rail/operator-logos/jp-badges/badge-009.png"),
        ("一畑電車", "/rail/operator-logos/jp-badges/badge-010.png"),
        ("一般財団法人青函トンネル記念館", "/rail/operator-logos/jp-badges/badge-011.png"),
        ("一般社団法人札幌市交通事業振興公社", "/rail/operator-logos/jp-badges/badge-012.png"),
        ("甘木鉄道", "/rail/operator-logos/jp-badges/badge-013.png"),
        ("関東鉄道", "/rail/operator-logos/jp-badges/badge-014.png"),
        ("京阪電気鉄道", "/rail/operator-logos/jp-badges/badge-015.png"),
        ("錦川鉄道", "/rail/operator-logos/jp-badges/badge-016.png"),
        ("近江鉄道", "/rail/operator-logos/jp-badges/badge-017.png"),
        ("高松琴平電気鉄道", "/rail/operator-logos/jp-badges/badge-018.png"),
        ("四日市あすなろう鉄道", "/rail/operator-logos/jp-badges/badge-019.png"),
        ("鹿児島市", "/rail/operator-logos/jp-badges/badge-020.png"),
        ("若桜鉄道", "/rail/operator-logos/jp-badges/badge-021.png"),
        ("神戸六甲鉄道", "/rail/operator-logos/jp-badges/badge-022.png"),
        ("水間鉄道", "/rail/operator-logos/jp-badges/badge-023.png"),
        ("静岡鉄道", "/rail/operator-logos/jp-badges/badge-024.png"),
        ("筑波観光鉄道", "/rail/operator-logos/jp-badges/badge-025.png"),
        ("長野電鉄", "/rail/operator-logos/jp-badges/badge-026.png"),
        ("東京メトロ", "/rail/operator-logos/jp-badges/badge-027.png"),
        ("函館市", "/rail/operator-logos/jp-badges/badge-028.png"),
        ("肥薩おれんじ鉄道", "/rail/operator-logos/jp-badges/badge-029.png"),
        ("富士山麓電気鉄道", "/rail/operator-logos/jp-badges/badge-030.png"),
        ("福井鉄道", "/rail/operator-logos/jp-badges/badge-031.png"),
        ("野岩鉄道", "/rail/operator-logos/jp-badges/badge-032.png"),
        ("立山黒部貫光", "/rail/operator-logos/jp-badges/badge-033.png"),
    ])

    private static let japanOperatorLogos = CodeUnitTable([
        ("JR東海交通事業", "/rail/operator-logos/jp/q7862679.svg"),
        ("WILLER\u{3000}TRAINS", "/rail/operator-logos/jp/q19727758.svg"),
        ("えちごトキめき鉄道", "/rail/operator-logos/jp/q11260966.svg"),
        ("えちぜん鉄道", "/rail/operator-logos/jp/q1007890.svg"),
        ("くま川鉄道", "/rail/operator-logos/jp/q8194074.jpg"),
        ("こうべ未来都市機構", "/rail/operator-logos/jp/q11237259.png"),
        ("しなの鉄道", "/rail/operator-logos/jp/q11254401.svg"),
        ("とさでん交通", "/rail/operator-logos/jp/q3537118.png"),
        ("のと鉄道", "/rail/operator-logos/jp/q7063103.svg"),
        ("アイジーアールいわて銀河鉄道", "/rail/operator-logos/jp/q5371026.svg"),
        ("アルピコ交通", "/rail/operator-logos/jp/q4735443.svg"),
        ("ラクテンチ", "/rail/operator-logos/jp/q11346676.png"),
        ("一畑電車", "/rail/operator-logos/jp/q128426.svg"),
        ("一般社団法人札幌市交通事業振興公社", "/rail/operator-logos/jp/q11521202.svg"),
        ("一般財団法人青函トンネル記念館", "/rail/operator-logos/jp/seikan-tunnel-museum.png"),
        ("三岐鉄道", "/rail/operator-logos/jp/q7418001.svg"),
        ("三陸鉄道", "/rail/operator-logos/jp/q7418928.png"),
        ("上田電鉄", "/rail/operator-logos/jp/q11263296.svg"),
        ("丹後海陸交通", "/rail/operator-logos/jp/q11368524.png"),
        ("九州旅客鉄道", "/rail/operator-logos/jp/q498366.svg"),
        ("京福電気鉄道", "/rail/operator-logos/jp/q3537126.svg"),
        ("京都市", "/rail/operator-logos/jp/q5359594.svg"),
        ("京阪電気鉄道", "/rail/operator-logos/jp/q1188274.svg"),
        ("伊予鉄道", "/rail/operator-logos/jp/q3138970.svg"),
        ("伊賀鉄道", "/rail/operator-logos/jp/iga-railway.png"),
        ("信楽高原鐵道", "/rail/operator-logos/jp/q7496306.jpg"),
        ("函館市", "/rail/operator-logos/jp/q3082613.png"),
        ("北大阪急行電鉄", "/rail/operator-logos/jp/q2323022.svg"),
        ("北条鉄道", "/rail/operator-logos/jp/q11402201.png"),
        ("北海道旅客鉄道", "/rail/operator-logos/jp/q498930.svg"),
        ("北陸鉄道", "/rail/operator-logos/jp/q5878320.svg"),
        ("十国峠", "/rail/operator-logos/jp/q11380603.svg"),
        ("南阿蘇鉄道", "/rail/operator-logos/jp/q11408721.jpg"),
        ("和歌山電鐵", "/rail/operator-logos/jp/q11417705.svg"),
        ("四国ケーブル", "/rail/operator-logos/jp/q7496602.png"),
        ("四国旅客鉄道", "/rail/operator-logos/jp/q496531.svg"),
        ("四日市あすなろう鉄道", "/rail/operator-logos/jp/q17211160.svg"),
        ("土佐くろしお鉄道", "/rail/operator-logos/jp/q7827542.png"),
        ("大井川鐵道", "/rail/operator-logos/jp/q842075.svg"),
        ("大山観光電鉄", "/rail/operator-logos/jp/q11434695.png"),
        ("大阪モノレール", "/rail/operator-logos/jp/q1903962.svg"),
        ("富士山麓電気鉄道", "/rail/operator-logos/jp/q116872861.svg"),
        ("富山地方鉄道", "/rail/operator-logos/jp/q1131125.svg"),
        ("山万", "/rail/operator-logos/jp/q11465832.png"),
        ("山形鉄道", "/rail/operator-logos/jp/q11045417.svg"),
        ("岡山電気軌道", "/rail/operator-logos/jp/q860466.svg"),
        ("嵯峨野観光鉄道", "/rail/operator-logos/jp/q50187147.svg"),
        ("平成筑豊鉄道", "/rail/operator-logos/jp/q3943894.svg"),
        ("広島電鉄", "/rail/operator-logos/jp/q1196530.svg"),
        ("御岳登山鉄道", "/rail/operator-logos/jp/q6880754.svg"),
        ("明知鉄道", "/rail/operator-logos/jp/q8193797.svg"),
        ("智頭急行", "/rail/operator-logos/jp/q4133832.svg"),
        ("東京メトロ", "/rail/operator-logos/jp/q682894.svg"),
        ("東日本旅客鉄道", "/rail/operator-logos/jp/q499071.svg"),
        ("東海旅客鉄道", "/rail/operator-logos/jp/q513679.svg"),
        ("松浦鉄道", "/rail/operator-logos/jp/q6788223.jpg"),
        ("比叡山鉄道", "/rail/operator-logos/jp/q11547404.svg"),
        ("熊本市", "/rail/operator-logos/jp/q900963.jpg"),
        ("熊本電気鉄道", "/rail/operator-logos/jp/q5357168.svg"),
        ("甘木鉄道", "/rail/operator-logos/jp/q11574278.png"),
        ("由利高原鉄道", "/rail/operator-logos/jp/q11577568.png"),
        ("皿倉登山鉄道", "/rail/operator-logos/jp/q11480880.png"),
        ("神戸六甲鉄道", "/rail/operator-logos/jp/q130517459.png"),
        ("神戸新交通", "/rail/operator-logos/jp/q5366038.svg"),
        ("福井鉄道", "/rail/operator-logos/jp/q5507652.svg"),
        ("福島交通", "/rail/operator-logos/jp/q5507741.svg"),
        ("秋田内陸縦貫鉄道", "/rail/operator-logos/jp/q11595259.png"),
        ("秩父鉄道", "/rail/operator-logos/jp/q843780.svg"),
        ("立山黒部貫光", "/rail/operator-logos/jp/q11597848.png"),
        ("若桜鉄道", "/rail/operator-logos/jp/q11616555.svg"),
        ("西日本旅客鉄道", "/rail/operator-logos/jp/q502125.svg"),
        ("西日本鉄道", "/rail/operator-logos/jp/q869251.svg"),
        ("豊橋鉄道", "/rail/operator-logos/jp/q3081081.svg"),
        ("近江鉄道", "/rail/operator-logos/jp/q3276327.png"),
        ("遠州鉄道", "/rail/operator-logos/jp/q9286431.svg"),
        ("野岩鉄道", "/rail/operator-logos/jp/q8046688.svg"),
        ("錦川鉄道", "/rail/operator-logos/jp/q11650435.png"),
        ("長崎電気軌道", "/rail/operator-logos/jp/q901485.png"),
        ("長良川鉄道", "/rail/operator-logos/jp/q11653637.svg"),
        ("長野電鉄", "/rail/operator-logos/jp/q6958437.svg"),
        ("関東鉄道", "/rail/operator-logos/jp/q845943.svg"),
        ("阿佐海岸鉄道", "/rail/operator-logos/jp/q11657221.svg"),
        ("阿武隈急行", "/rail/operator-logos/jp/q4670567.svg"),
        ("静岡鉄道", "/rail/operator-logos/jp/q5362040.svg"),
        ("高尾登山電鉄", "/rail/operator-logos/jp/q7677245.svg"),
        ("高松琴平電気鉄道", "/rail/operator-logos/jp/q566998.svg"),
        ("筑波観光鉄道", "/rail/operator-logos/jp/tsukuba-kanko.png"),
        ("養老鉄道", "/rail/operator-logos/jp/yoro-railway.webp"),
        ("鹿児島市", "/rail/operator-logos/jp/q3537114.gif"),
    ])

    private static let japanPackageOperatorLogos = CodeUnitTable([
        ("沖縄都市モノレール", "/rail/logos/jp-沖縄都市モノレール-沖縄都市モノレール線.png"),
        ("いすみ鉄道", "/rail/logos/jp-いすみ鉄道-いすみ線.png"),
        ("わたらせ渓谷鐵道", "/rail/logos/jp-わたらせ渓谷鐵道-わたらせ渓谷線.png"),
        ("愛知環状鉄道", "/rail/logos/jp-愛知環状鉄道-愛知環状鉄道線.png"),
        ("伊勢鉄道", "/rail/logos/jp-伊勢鉄道-伊勢線.png"),
        ("井原鉄道", "/rail/logos/jp-井原鉄道-井原線.png"),
        ("会津鉄道", "/rail/logos/jp-会津鉄道-会津線.png"),
        ("岳南電車", "/rail/logos/jp-岳南電車-岳南鉄道線.png"),
        ("紀州鉄道", "/rail/logos/jp-紀州鉄道-紀州鉄道線.png"),
        ("黒部峡谷鉄道", "/rail/logos/jp-黒部峡谷鉄道-本線.png"),
        ("小湊鐵道", "/rail/logos/jp-小湊鐵道-小湊鐵道線.png"),
        ("湘南モノレール", "/rail/logos/jp-湘南モノレール-江の島線.png"),
        ("上信電鉄", "/rail/logos/jp-上信電鉄-上信線.png"),
        ("上毛電気鉄道", "/rail/logos/jp-上毛電気鉄道-上毛線.png"),
        ("真岡鐵道", "/rail/logos/jp-真岡鐵道-真岡線.png"),
        ("水間鉄道", "/rail/logos/jp-水間鉄道-水間線.png"),
        ("水島臨海鉄道", "/rail/logos/jp-水島臨海鉄道-水島本線.png"),
        ("あいの風とやま鉄道", "/rail/logos/jp-あいの風とやま鉄道-あいの風とやま鉄道線.png"),
        ("IRいしかわ鉄道", "/rail/logos/jp-IRいしかわ鉄道-IRいしかわ鉄道線.png"),
        ("ハピラインふくい", "/rail/logos/jp-ハピラインふくい-ハピラインふくい線.png"),
        ("青い森鉄道", "/rail/logos/jp-青い森鉄道-青い森鉄道線.png"),
        ("仙台市", "/rail/logos/jp-仙台市-南北線.png"),
        ("流鉄", "/rail/logos/jp-流鉄-流山線.png"),
        ("多摩都市モノレール", "/rail/logos/jp-多摩都市モノレール-多摩都市モノレール線.png"),
        ("筑豊電気鉄道", "/rail/logos/jp-筑豊電気鉄道-筑豊電気鉄道線.png"),
        ("津軽鉄道", "/rail/logos/jp-津軽鉄道-津軽鉄道線.png"),
        ("天竜浜名湖鉄道", "/rail/logos/jp-天竜浜名湖鉄道-天竜浜名湖線.png"),
        ("島原鉄道", "/rail/logos/jp-島原鉄道-島原鉄道線.png"),
        ("肥薩おれんじ鉄道", "/rail/logos/jp-肥薩おれんじ鉄道-肥薩おれんじ鉄道線.png"),
        ("道南いさりび鉄道", "/rail/logos/jp-道南いさりび鉄道-道南いさりび鉄道線.png"),
        ("北九州高速鉄道", "/rail/logos/jp-北九州高速鉄道-小倉線.png"),
        ("仙台空港鉄道", "/rail/logos/jp-仙台空港鉄道-仙台空港線.png"),
        ("ひたちなか海浜鉄道", "/rail/logos/jp-ひたちなか海浜鉄道-湊線.png"),
    ])

    private static let japanNonLineLogoIds = CodeUnitSet([
        "jp-沖縄都市モノレール-沖縄都市モノレール線",
        "jp-いすみ鉄道-いすみ線",
        "jp-しなの鉄道-しなの鉄道線",
        "jp-わたらせ渓谷鐵道-わたらせ渓谷線",
        "jp-愛知環状鉄道-愛知環状鉄道線",
        "jp-伊勢鉄道-伊勢線",
        "jp-井原鉄道-井原線",
        "jp-会津鉄道-会津線",
        "jp-岳南電車-岳南鉄道線",
        "jp-紀州鉄道-紀州鉄道線",
        "jp-四日市あすなろう鉄道-内部線",
        "jp-九州旅客鉄道-九州新幹線",
        "jp-九州旅客鉄道-鹿児島線",
        "jp-九州旅客鉄道-山陽線",
        "jp-九州旅客鉄道-日豊線",
        "jp-黒部峡谷鉄道-本線",
        "jp-三岐鉄道-北勢線",
        "jp-小湊鐵道-小湊鐵道線",
        "jp-湘南モノレール-江の島線",
        "jp-上信電鉄-上信線",
        "jp-上毛電気鉄道-上毛線",
        "jp-真岡鐵道-真岡線",
        "jp-水間鉄道-水間線",
        "jp-水島臨海鉄道-水島本線",
        "jp-西日本旅客鉄道-関西線",
        "jp-西日本旅客鉄道-山陽新幹線",
        "jp-西日本旅客鉄道-山陽線",
        "jp-西日本旅客鉄道-赤穂線",
        "jp-西日本旅客鉄道-博多南線",
        "jp-西日本旅客鉄道-姫新線",
        "jp-あいの風とやま鉄道-あいの風とやま鉄道線",
        "jp-IRいしかわ鉄道-IRいしかわ鉄道線",
        "jp-ハピラインふくい-ハピラインふくい線",
        "jp-青い森鉄道-青い森鉄道線",
        "jp-仙台市-南北線",
        "jp-流鉄-流山線",
        "jp-多摩都市モノレール-多摩都市モノレール線",
        "jp-大井川鐵道-大井川本線",
        "jp-筑波観光鉄道-筑波山鋼索鉄道線",
        "jp-筑豊電気鉄道-筑豊電気鉄道線",
        "jp-津軽鉄道-津軽鉄道線",
        "jp-天竜浜名湖鉄道-天竜浜名湖線",
        "jp-島原鉄道-島原鉄道線",
        "jp-東海旅客鉄道-東海道新幹線",
        "jp-東日本旅客鉄道-上越新幹線",
        "jp-東日本旅客鉄道-常磐線",
        "jp-東日本旅客鉄道-成田線",
        "jp-東日本旅客鉄道-川越線",
        "jp-東日本旅客鉄道-中央線",
        "jp-東日本旅客鉄道-東海道線",
        "jp-東日本旅客鉄道-東北新幹線",
        "jp-東日本旅客鉄道-東北線",
        "jp-東日本旅客鉄道-北陸新幹線",
        "jp-肥薩おれんじ鉄道-肥薩おれんじ鉄道線",
        "jp-豊橋鉄道-渥美線",
        "jp-道南いさりび鉄道-道南いさりび鉄道線",
        "jp-北九州高速鉄道-小倉線",
        "jp-仙台空港鉄道-仙台空港線",
        "jp-ひたちなか海浜鉄道-湊線",
        "jp-養老鉄道-養老線",
        "jp-伊賀鉄道-伊賀線",
        "jp-西日本旅客鉄道-北陸新幹線",
        "jp-仙台市-東西線",
        "jp-北海道旅客鉄道-北海道新幹線",
        "jp-九州旅客鉄道-西九州新幹線",
    ])

    private static let logosRequiringDarkMatte = CodeUnitSet([
        "/rail/operator-logos/jp-badges/badge-011.png",
        "/rail/operator-logos/jp/q7496602.png",
        "/rail/operator-logos/jp/q11657221.svg",
    ])

    private static let operatorLogos = CodeUnitTable([
        ("MTR", "/rail/operator-logos/mtr-badge.png"),
        ("澳門輕軌", "/rail/operator-logos/macao-lrt-badge.png"),
        ("台鐵", "/rail/operator-logos/tra.svg"),
        ("台灣高鐵", "/rail/operator-logos/thsr.svg"),
        ("台北捷運", "/rail/operator-logos/trtc-badge.png"),
        ("新北捷運", "/rail/operator-logos/ntmetro.svg"),
        ("桃園捷運", "/rail/operator-logos/tym.png"),
        ("台中捷運", "/rail/operator-logos/tcmrt.svg"),
        ("高雄捷運", "/rail/operator-logos/krtc-badge.png"),
        ("阿里山林鐵", "/rail/operator-logos/alsr-badge.png"),
    ])

    private static let lineLogos = CodeUnitTable([
        ("jp-三岐鉄道-北勢線", "/rail/line-logos/sangi-hokusei.svg"),
        ("jp-東京地下鉄-4号線丸ノ内線分岐線", "/rail/line-logos/tokyo-metro-marunouchi-branch.svg"),
        ("jp-京都市-東西線", "/rail/line-logos/kyoto-tozai.svg"),
        ("jp-北海道旅客鉄道-北海道新幹線", "/rail/line-logos/shinkansen-jr-hokkaido.svg"),
        ("jp-東日本旅客鉄道-東北新幹線", "/rail/line-logos/shinkansen-jr-east.svg"),
        ("jp-東日本旅客鉄道-上越新幹線", "/rail/line-logos/shinkansen-jr-east.svg"),
        ("jp-東日本旅客鉄道-北陸新幹線", "/rail/line-logos/shinkansen-jr-east.svg"),
        ("jp-東海旅客鉄道-東海道新幹線", "/rail/line-logos/shinkansen-jr-central.svg"),
        ("jp-西日本旅客鉄道-山陽新幹線", "/rail/line-logos/shinkansen-jr-west.svg"),
        ("jp-西日本旅客鉄道-北陸新幹線", "/rail/line-logos/shinkansen-jr-west.svg"),
        ("jp-九州旅客鉄道-九州新幹線", "/rail/line-logos/shinkansen-jr-kyushu.svg"),
        ("jp-九州旅客鉄道-西九州新幹線", "/rail/line-logos/shinkansen-jr-kyushu.svg"),
        ("tw-trtc-bl", "/rail/line-logos/trtc-bl.svg"),
        ("tw-trtc-r", "/rail/line-logos/trtc-r.svg"),
        ("tw-trtc-r-xinbeitou", "/rail/line-logos/trtc-r.svg"),
        ("tw-trtc-g", "/rail/line-logos/trtc-g.svg"),
        ("tw-trtc-g-xiaobitan", "/rail/line-logos/trtc-g.svg"),
        ("tw-trtc-o-luzhou", "/rail/line-logos/trtc-o.svg"),
        ("tw-trtc-o-huilong", "/rail/line-logos/trtc-o.svg"),
        ("tw-trtc-br", "/rail/line-logos/trtc-br.svg"),
        ("tw-trtc-y", "/rail/line-logos/ntmetro-y.svg"),
        ("tw-ntmetro-v-green", "/rail/line-logos/ntmetro-v.svg"),
        ("tw-ntmetro-v-blue", "/rail/line-logos/ntmetro-v.svg"),
        ("tw-ntmetro-k", "/rail/line-logos/ntmetro-k.svg"),
        ("tw-tym-a", "/rail/line-logos/tym-a.svg"),
        ("tw-tcmrt-g", "/rail/line-logos/tcmrt-g.svg"),
        ("tw-krtc-r", "/rail/line-logos/krtc-r.svg"),
        ("tw-krtc-o", "/rail/line-logos/krtc-o.svg"),
        ("tw-klrt-c", "/rail/line-logos/krtc-c.svg"),
        ("hk-mtr-lr-505", "/rail/line-logos/mtr-lr-505.svg"),
        ("hk-mtr-lr-507", "/rail/line-logos/mtr-lr-507.svg"),
        ("hk-mtr-lr-610", "/rail/line-logos/mtr-lr-610.svg"),
        ("hk-mtr-lr-614", "/rail/line-logos/mtr-lr-614.svg"),
        ("hk-mtr-lr-614p", "/rail/line-logos/mtr-lr-614p.svg"),
        ("hk-mtr-lr-615", "/rail/line-logos/mtr-lr-615.svg"),
        ("hk-mtr-lr-615p", "/rail/line-logos/mtr-lr-615p.svg"),
        ("hk-mtr-lr-705", "/rail/line-logos/mtr-lr-705.svg"),
        ("hk-mtr-lr-706", "/rail/line-logos/mtr-lr-706.svg"),
        ("hk-mtr-lr-751", "/rail/line-logos/mtr-lr-751.svg"),
        ("hk-mtr-lr-761p", "/rail/line-logos/mtr-lr-761p.svg"),
    ])
}

// MARK: - JavaScript string semantics, written out

/// A string compared the way JavaScript compares one: by UTF-16 code unit.
///
/// Swift's `String` is equal under canonical equivalence, so `"アルピコ交通"`
/// written with a combining semi-voiced mark equals the composed spelling and
/// would find a table entry that a JavaScript object lookup misses. The tables
/// in this file are keyed on this type so that they answer the same question
/// the JavaScript answers, and no other.
private struct CodeUnits: Hashable {
    let units: [UInt16]
    init(_ value: String) { units = Array(value.utf16) }
}

/// A JavaScript object used as a lookup table.
private struct CodeUnitTable {
    private let entries: [CodeUnits: String]

    init(_ pairs: [(String, String)]) {
        var entries: [CodeUnits: String] = [:]
        entries.reserveCapacity(pairs.count)
        for (key, value) in pairs { entries[CodeUnits(key)] = value }
        self.entries = entries
    }

    subscript(key: String) -> String? { entries[CodeUnits(key)] }
}

/// A JavaScript `Set` of strings, whose `has` is SameValueZero — again, code
/// units, not canonical equivalence.
private struct CodeUnitSet {
    private let members: Set<CodeUnits>

    init(_ values: [String]) { members = Set(values.map(CodeUnits.init)) }

    func contains(_ value: String) -> Bool { members.contains(CodeUnits(value)) }
}

/// The three string operations this module depends on, in ECMAScript's terms.
///
/// Each has a Foundation counterpart that is *nearly* right, and the gap in
/// each case is silent: the code compiles, the tests over ASCII pass, and the
/// disagreement only shows up on the CJK, full-width and combining-mark data
/// this app is entirely made of.
private enum JSText {

    /// ECMAScript `TrimString`: WhiteSpace ∪ LineTerminator.
    ///
    /// Not `CharacterSet.whitespacesAndNewlines`, which differs at both ends —
    /// it omits U+FEFF (ZWNBSP), which ECMAScript trims, and includes U+0085
    /// (NEL), which ECMAScript does not. Both appear in the fixture precisely
    /// because they are the two characters that make the two implementations
    /// disagree about where a name begins.
    static func isWhiteSpace(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D:  // TAB LF VT FF CR
            return true
        case 0x0020, 0x00A0:  // SPACE, NBSP
            return true
        case 0x1680, 0x2000...0x200A, 0x202F, 0x205F, 0x3000:  // category Zs
            return true
        case 0x2028, 0x2029:  // LINE / PARAGRAPH SEPARATOR
            return true
        case 0xFEFF:  // ZWNBSP
            return true
        default:
            return false
        }
    }

    static func trim(_ value: String) -> String {
        let units = Array(value.utf16)
        var start = 0
        var end = units.count
        while start < end, isWhiteSpace(units[start]) { start += 1 }
        while end > start, isWhiteSpace(units[end - 1]) { end -= 1 }
        // Returning the original when nothing is trimmed keeps the exact string
        // rather than a re-encoded copy of it.
        guard start != 0 || end != units.count else { return value }
        return String(decoding: units[start..<end], as: UTF16.self)
    }

    /// `String.prototype.startsWith` — a code-unit comparison.
    ///
    /// `hasPrefix` compares grapheme clusters under canonical equivalence, so
    /// `"カ\u{3099}線".hasPrefix("カ")` is false in Swift and true in JavaScript.
    static func hasPrefix(_ value: String, _ prefix: String) -> Bool {
        let value = Array(value.utf16)
        let prefix = Array(prefix.utf16)
        guard prefix.count <= value.count else { return false }
        for index in 0..<prefix.count where value[index] != prefix[index] {
            return false
        }
        return true
    }

    /// `String.prototype.split` on a single BMP code unit.
    ///
    /// An empty input yields one empty part, as in JavaScript — the caller's
    /// `filter(Boolean)` is what discards it.
    static func split(_ value: String, separator: UInt16) -> [String] {
        let units = Array(value.utf16)
        var parts: [String] = []
        var start = 0
        for index in 0..<units.count where units[index] == separator {
            parts.append(String(decoding: units[start..<index], as: UTF16.self))
            start = index + 1
        }
        parts.append(String(decoding: units[start...], as: UTF16.self))
        return parts
    }

    /// `replace(/(?:a|b)/g, "")`.
    ///
    /// A global regular expression scans the ORIGINAL string left to right and
    /// resumes after each match, so nothing it produces is rescanned:
    /// `株式株式会社会社` loses one occurrence and keeps the `株式会社` its removal
    /// creates. This scan does the same.
    static func removingAllOccurrences(of needles: [String], in value: String) -> String {
        let units = Array(value.utf16)
        let needles = needles.map { Array($0.utf16) }
        var out: [UInt16] = []
        out.reserveCapacity(units.count)
        var index = 0
        while index < units.count {
            var matched = false
            for needle in needles where matches(needle, in: units, at: index) {
                index += needle.count
                matched = true
                break
            }
            if !matched {
                out.append(units[index])
                index += 1
            }
        }
        return String(decoding: out, as: UTF16.self)
    }

    /// `replace(/^(?:a|b|…)/, "")` — anchored, and at most one removal.
    static func removingLeadingOccurrence(of needles: [String], in value: String) -> String {
        let units = Array(value.utf16)
        for needle in needles {
            let needle = Array(needle.utf16)
            if matches(needle, in: units, at: 0) {
                return String(decoding: units[needle.count...], as: UTF16.self)
            }
        }
        return value
    }

    private static func matches(_ needle: [UInt16], in units: [UInt16], at start: Int) -> Bool {
        guard !needle.isEmpty, start + needle.count <= units.count else { return false }
        for offset in 0..<needle.count where units[start + offset] != needle[offset] {
            return false
        }
        return true
    }
}
