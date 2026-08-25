import RailCore

/// The map layers menu, as state.
///
/// `app-map-init.js` builds nine checkboxes in the map's own corner control:
/// five for what of the reader's journeys is drawn, and four under 已乘路線顯示
/// for which categories of ridden line. The complete-network switch is the
/// ninth and it already had a home — `RailMapController.showsNetwork`, which
/// the control bar's train button presses — so it stays there rather than
/// being moved in here and having two owners.
///
/// The four category flags are `RailCore`'s own type: the classifier, the
/// filter and the "an unknown key stays visible" rule are all ported and
/// checked against the JavaScript, and re-declaring the flags here would put a
/// second copy of that vocabulary next to the checked one.
struct MapLayers: Equatable {

    // MARK: - 全部線路: the network the app ships

    /// Whether the network's own station dots are drawn.
    ///
    /// New, and it exists because the network side had exactly one switch —
    /// `RailMapController.showsNetwork`, the rail's train button — which drew
    /// six hundred lines and every station on them as a single decision. At a
    /// city zoom that is the difference between a readable map and a field of
    /// dots, and there was no way to ask for the lines without them.
    ///
    /// It does NOT replace `showsNetwork`: with the network off there are no
    /// stations to draw either, so this is read underneath it rather than
    /// beside it.
    var networkStations = true
    /// Whether those dots carry their station's name.
    ///
    /// Separate from the dots, because they fail differently: the dot is the
    /// map's structure and the name is its labelling, and a reader who wants
    /// to see where the stations are while a ride's own labels stay legible
    /// wants exactly one of the two. The zoom floor
    /// (`MapLabelStyle.stationLabelMinZoom`) still applies underneath — this
    /// can only take names away, never make them appear earlier.
    var networkStationNames = true

    // MARK: - 已乘坐線路: the reader's own journeys

    /// `map.routes` — the ridden route lines, **and the master switch for
    /// everything else the ridden layer draws**.
    ///
    /// It used to mean the lines and only the lines, mirroring
    /// `RailMap.setVisible`, which moves the route, cross-day, hover and
    /// selection layers and leaves every marker layer alone. That division
    /// produced a state nobody asks for: 列車経路 off, and the map still
    /// covered in the stop, terminal and pass-through dots of routes that were
    /// no longer drawn — station marks floating with nothing to belong to.
    ///
    /// So the three marker switches now hang off this one. They keep their own
    /// values rather than being forced off, which is what lets turning the
    /// master back on restore the arrangement the reader had; the sheet
    /// disables them while it is off so the switches never disagree with the
    /// map.
    var routes = true
    /// `map.stops` — intermediate calls: neither end of the journey, and not
    /// rolled through. Subordinate to ``routes``.
    var stops = true
    /// `map.terminals` — the journey's own two ends. Subordinate to ``routes``.
    var terminals = true
    /// `map.passThrough` — stations passed without calling. Subordinate to
    /// ``routes``.
    var passThrough = true
    /// 已乘路線顯示: 新幹線 / JR在來線 / 地下鐵 / 私鐵.
    var categories = Statistics.RiddenCategoryFilter()

    /// Whether any station dot is drawn at all.
    ///
    /// The cross-day diamond REPLACES a station's dot rather than adding a
    /// mark of its own, so it follows this rather than a switch of its own —
    /// `railmap.js` moves `TRAIN_XDAY_STOP_LAYER` with exactly this
    /// `stop || terminal`.
    var anyStationDots: Bool { routes && (stops || terminals) }

    /// Whether a marker record of this role is drawn.
    ///
    /// `stop-center` is the black core inside an intermediate stop's dot. It
    /// is not a mark in its own right — it is drawn INSIDE the dot it belongs
    /// to — so it can only follow that dot's switch.
    ///
    /// An unrecognised role draws, for the same reason an unrecognised
    /// category stays visible: a switch nobody wrote is not a switch that is
    /// off. That default is why ``routes`` is checked FIRST rather than added
    /// as another case: the master has to gate the roles nobody has named yet
    /// as well as the three that are.
    func draws(role: String) -> Bool {
        guard routes else { return false }
        // Explicit `return`s: the guard above makes this a multi-statement
        // body, and Swift's implicit single-expression return does not apply.
        switch role {
        case "terminal": return terminals
        case "stop", "stop-center": return stops
        case "pass": return passThrough
        case "xday": return anyStationDots
        default: return true
        }
    }
}
