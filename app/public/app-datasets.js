// =========================================================================
//  app-datasets.js — the loaded country datasets, and the named installs
//
//  These five collections plus the two station indexes used to be declared
//  in app.js. Reading them therefore meant depending on the boot spine, and
//  app-stats.js and app-persistence.js reached into app.js for NOTHING BUT
//  these — that was the whole of their dependency cycle with the entry point.
//
//  Ownership lives here; the loaders stay where they are. app.js still
//  decides WHEN to fetch, app-stations.js still decides HOW to index, and
//  app-precompute-adapter.js still installs the Node VM's copies — but each
//  of them now goes through a named install below instead of assigning a
//  binding that belongs to somebody else. That is what makes the write side
//  greppable: every dataset swap in the app is one of these calls.
//
//  What is deliberately NOT here: railSectionsReady / railSectionsTextReady.
//  Those are the loader's in-flight bookkeeping, not the data, and they stay
//  private to app.js.
// =========================================================================

// Data is served by the backend instead of being embedded in the page.
let railSectionsGeoJson,
  stationsGeoJson,
  defaultTrainStore,
  matchedRoutesGeoJson,
  matchedStopsGeoJson;
let stationCandidatesIndex;
// N02_005c -> N02_005 station name. The station name is a per-station constant
// (see jsonspec §13.4): it is kept ONCE on each stop, and route_sections carry
// only codes — their from/to names are resolved from this map on load and
// stripped from the persisted/exported JSON so the archive doesn't repeat every
// station name in both the stops and the sections.
let stationNameByCode = new Map();
function stationNameForCode(code) {
  return (code && stationNameByCode.get(String(code))) || "";
}

const AppDatasets = {
  // The three seed collections boot fetches together.
  installSeedData({ defaultStore, matchedRoutes, matchedStops }) {
    defaultTrainStore = defaultStore;
    this.installMatchedData({ matchedRoutes, matchedStops });
  },
  // The precompute adapter installs the matched pair WITHOUT a default store:
  // offline export reads its trains from the host, never from the seed.
  installMatchedData({ matchedRoutes, matchedStops }) {
    matchedRoutesGeoJson = matchedRoutes;
    matchedStopsGeoJson = matchedStops;
  },
  installStations(featureCollection) {
    stationsGeoJson = featureCollection;
    return stationsGeoJson;
  },
  installRailSections(featureCollection) {
    railSectionsGeoJson = featureCollection;
    return railSectionsGeoJson;
  },
  // The country switch drops the outgoing country's track before the incoming
  // country's is fetched. Never leave the two loaded at once: the countries
  // share station names (松山, 板橋, 岡山 …), so a stop resolved against the
  // wrong network would not look like an error, it would look like a route.
  clearRailSections() {
    railSectionsGeoJson = null;
  },
  installStationIndexes(candidates, nameByCode) {
    stationCandidatesIndex = candidates;
    stationNameByCode = nameByCode;
  },
};
