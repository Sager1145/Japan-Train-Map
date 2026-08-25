import Foundation
import RailCore

/// One reason the draft in the editor cannot be saved yet, attached to the
/// field that can fix it.
struct RideDraftIssue: Identifiable, Equatable {

    /// Where the problem lives, and therefore where the message goes.
    ///
    /// §5.4: "校验必须尽量在字段旁实时显示，不能只在表单底部给一个泛化错误."
    /// The cases that are *not* a text field — `.stops`, `.routePolicy`,
    /// `.record` — are the rules that genuinely have no single field to stand
    /// next to; they anchor a section instead, and "查看错误" scrolls to it.
    enum Field: Hashable {
        case id
        case date
        case number
        case origin
        case destination
        case color
        /// The stop list as a whole (its length).
        case stops
        /// One row of it.
        case stop(Int)
        /// One written route section. The editor can add, reorder and edit
        /// them, so its rules need somewhere to be said other than the
        /// catch-all at the bottom of the form.
        case routeSection(Int)
        /// `route_policy`'s structural invariants — no field of their own,
        /// because the editor exposes the two the reader can choose and the
        /// rest are schema constants.
        case routePolicy
        /// A rule the field-level checks did not account for. Never expected;
        /// present so a validator change cannot silently produce a draft that
        /// is refused with no explanation.
        case record

        /// Whether focus can be moved into it, or only scrolled to.
        var isTextField: Bool {
            switch self {
            case .id, .date, .number, .origin, .destination, .color: true
            default: false
            }
        }
    }

    enum Severity: Equatable {
        /// Blocks the save.
        case error
        /// Saving works, but not the way the reader expects. §8.3's id
        /// collision is the one that matters: the record is written under its
        /// previous id rather than overwriting somebody else's journey.
        case warning
    }

    let field: Field
    let severity: Severity
    /// A key for ``AppLocalization/editorText(_:_:)``, or — for `.record` — a
    /// message out of `TrainValidation` that is not translatable.
    let key: String
    let params: [String: Localization.Param]
    /// Set only when `key` is not a catalog key: the validator's own English.
    let literal: String?

    var id: String { "\(field)-\(key)-\(literal ?? "")" }

    init(
        field: Field,
        severity: Severity = .error,
        key: String,
        params: [String: Localization.Param] = [:],
        literal: String? = nil
    ) {
        self.field = field
        self.severity = severity
        self.key = key
        self.params = params
        self.literal = literal
    }
}

/// The editor's validation, expressed field by field.
///
/// ## This does not have rules of its own
///
/// `TrainValidation.validateTrain` is the rule set — ported, fixture-pinned,
/// and shared with the web app — and this must never disagree with it. So the
/// authoritative validator is *actually run*, over the draft encoded to the
/// same JSON the exporter writes, and the field-level checks below exist to
/// say the same "no" **next to the field that causes it**.
///
/// The order of the checks is `validateTrain`'s own order, and the last step
/// is the safety net: if the authoritative validator refuses a draft that no
/// field-level check explained, the raw message is surfaced rather than the
/// save silently doing nothing.
///
/// That net already caught one divergence. The editor's old `canSave` required
/// `!draft.stops.isEmpty`, while the rule is `stops.count >= 2` — so a
/// one-stop journey could be saved from this app and then be rejected by the
/// app's own exporter and by the web app's importer.
enum RideDraftValidation {

    static func issues(
        for draft: Train, originalID: String, existingIDs: Set<String>
    ) -> [RideDraftIssue] {
        var issues: [RideDraftIssue] = []

        // -- id ------------------------------------------------------------
        let id = draft.id.trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty {
            issues.append(RideDraftIssue(field: .id, key: "ios.editor.idRequired"))
        } else if !TrainValidation.matchesTrainIDPattern(draft.id) {
            issues.append(RideDraftIssue(field: .id, key: "ios.editor.idRule"))
        } else if draft.id != originalID, existingIDs.contains(draft.id) {
            // §8.3. A warning, not an error: `ItineraryStore.replace` refuses
            // to overwrite the other journey and keeps this one's previous id,
            // so the save succeeds — just not the way it was typed.
            issues.append(
                RideDraftIssue(
                    field: .id, severity: .warning, key: "ios.editor.idTaken",
                    params: ["id": .string(draft.id)]))
        }

        // -- date ----------------------------------------------------------
        if let date = draft.date, !date.isEmpty, date != TrainValidation.undated,
            !Dates.isValidDateString(date)
        {
            issues.append(RideDraftIssue(field: .date, key: "ios.editor.dateRule"))
        }

        // -- identity ------------------------------------------------------
        if isBlank(draft.number) {
            issues.append(RideDraftIssue(field: .number, key: "ios.editor.numberRequired"))
        }
        if isBlank(draft.origin) {
            issues.append(RideDraftIssue(field: .origin, key: "ios.editor.originRequired"))
        }
        if isBlank(draft.destination) {
            issues.append(
                RideDraftIssue(field: .destination, key: "ios.editor.destinationRequired"))
        }

        // -- stops ---------------------------------------------------------
        if draft.stops.count < 2 {
            issues.append(
                RideDraftIssue(
                    field: .stops, key: "ios.editor.stopCountRule",
                    params: ["count": .number(Double(draft.stops.count))]))
        }
        for (index, stop) in draft.stops.enumerated() {
            if isBlank(stop.name) {
                issues.append(
                    RideDraftIssue(field: .stop(index), key: "ios.editor.stopNameRequired"))
            }
            if !TrainValidation.stopTypes.contains(stop.stopType) {
                issues.append(
                    RideDraftIssue(field: .stop(index), key: "ios.editor.stopTypeRule"))
            }
            if let code = stop.n02StationCode, !code.isEmpty,
                TrainValidation.stationCodeSystem(code) == nil
            {
                issues.append(
                    RideDraftIssue(field: .stop(index), key: "ios.editor.stationCodeRule"))
            }
            if let platform = stop.platformNumber, platform < 0 {
                issues.append(
                    RideDraftIssue(field: .stop(index), key: "ios.editor.platformRule"))
            }
        }
        // The two cross-field rules: neither end of the journey needs both an
        // arrival and a departure.
        if let first = draft.stops.first, hasBothTimes(first) {
            issues.append(RideDraftIssue(field: .stop(0), key: "ios.editor.firstStopTimes"))
        }
        if draft.stops.count > 1, let last = draft.stops.last, hasBothTimes(last) {
            issues.append(
                RideDraftIssue(
                    field: .stop(draft.stops.count - 1), key: "ios.editor.lastStopTimes"))
        }

        // -- route sections ------------------------------------------------
        // Every rule `validateTrain` applies to a written section, said next
        // to the section rather than at the foot of the form. The editor is
        // where these become reachable at all: a hand-written store rarely has
        // a section with one endpoint, and an editor with an "add section"
        // button produces one on the first tap.
        for (index, section) in (draft.routeSections ?? []).enumerated() {
            let hasFrom = !isBlank(section.from ?? "")
                || !isBlank(section.fromN02StationCode ?? "")
            let hasTo = !isBlank(section.to ?? "") || !isBlank(section.toN02StationCode ?? "")
            if !hasFrom || !hasTo {
                issues.append(
                    RideDraftIssue(
                        field: .routeSection(index), key: "ios.editor.sectionEndpoints",
                        params: ["index": .number(Double(index + 1))]))
            }
            for code in [section.fromN02StationCode, section.toN02StationCode] {
                guard let code, !code.isEmpty else { continue }
                if TrainValidation.stationCodeSystem(code) == nil {
                    issues.append(
                        RideDraftIssue(
                            field: .routeSection(index), key: "ios.editor.sectionCodeRule",
                            params: ["index": .number(Double(index + 1))]))
                    break
                }
            }
        }

        // -- route policy --------------------------------------------------
        // The three the editor actually exposes get their own message; the
        // schema constants it does not expose stay with the generic refusal
        // and its "reset to the canonical policy" repair.
        if let policy = draft.routePolicy {
            let allowed = policy.allowedInstitutionTypeCodes ?? []
            if !allowed.allSatisfy(TrainValidation.defaultAllowedInstitutionTypeCodes.contains) {
                issues.append(
                    RideDraftIssue(field: .routePolicy, key: "ios.editor.policyCodesRule"))
            }
            if let mode = policy.institutionFilterMode, !mode.isEmpty,
                mode != "soft", mode != "hard"
            {
                issues.append(
                    RideDraftIssue(field: .routePolicy, key: "ios.editor.policyModeRule"))
            }
        }

        // -- style ---------------------------------------------------------
        if let color = draft.style?.color, !color.isEmpty,
            !TrainValidation.isValidTrainColor(color)
        {
            issues.append(RideDraftIssue(field: .color, key: "ios.editor.colorRule"))
        }

        // -- the authoritative pass ----------------------------------------
        if let message = schemaRefusal(draft) {
            let explained = issues.contains { $0.severity == .error }
            // Two of these are now explained field by field, so the net firing
            // means a rule moved in `TrainValidation` — which is exactly what
            // it is for.
            if !explained {
                let isPolicy = message.contains("route_policy")
                issues.append(
                    RideDraftIssue(
                        field: isPolicy ? .routePolicy : .record,
                        key: isPolicy ? "ios.editor.policyProblem" : "ios.editor.otherProblem",
                        literal: isPolicy ? nil : message))
            }
        }

        return issues
    }

    /// Whether `TrainValidation` — the shared, fixture-pinned rules — refuses
    /// this draft, and what it said.
    ///
    /// The draft goes through the same `Encodable` the exporter uses, so what
    /// is validated is byte-for-byte the record that would be written. `ids`
    /// starts empty on purpose: duplicate detection needs the whole store and
    /// is handled above, against the ids the workspace publishes.
    private static func schemaRefusal(_ draft: Train) -> String? {
        do {
            let data = try JSONEncoder().encode(draft)
            guard let text = String(data: data, encoding: .utf8) else { return nil }
            let json = try TrainValidation.JSON.parse(text)
            var ids: Set<String> = []
            try TrainValidation.validateTrain(json, index: 0, ids: &ids)
            return nil
        } catch let error as TrainValidation.ValidationError {
            return error.message
        } catch {
            return error.localizedDescription
        }
    }

    private static func isBlank(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func hasBothTimes(_ stop: Stop) -> Bool {
        !(stop.arrival ?? "").isEmpty && !(stop.departure ?? "").isEmpty
    }
}

extension Array where Element == RideDraftIssue {
    /// Every blocking issue, in the order the form shows the fields.
    var blocking: [RideDraftIssue] { filter { $0.severity == .error } }

    func first(for field: RideDraftIssue.Field) -> RideDraftIssue? {
        first { $0.field == field }
    }

    func all(for field: RideDraftIssue.Field) -> [RideDraftIssue] {
        filter { $0.field == field }
    }
}
