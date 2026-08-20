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
//  The rail-sections loader lives here too. It was left in app.js at first,
//  on the theory that in-flight bookkeeping is not data — but app-route-service
//  calls ensureRailSectionsLoaded before a solve, and that one call was the
//  whole of its dependency cycle with the entry point. A dataset's loader
//  belongs with the dataset.
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
    railSectionsReady = null;
    railSectionsTextReady = null;
  },
  // Start (or restart) the DOWNLOAD only — response.text(), no JSON.parse — so
  // the ~1.1 s parse never blocks boot or first paint. ensureRailSectionsLoaded
  // parses it in yielding chunks after the map is on screen. Returns the
  // promise so the caller can attach its own failure reporting.
  startRailSectionsDownload() {
    railSectionsTextReady = fetchText(railSectionsApiForCountry(activeCountry));
    return railSectionsTextReady;
  },
  installStationIndexes(candidates, nameByCode) {
    stationCandidatesIndex = candidates;
    stationNameByCode = nameByCode;
  },
};

// Tracks the in-flight (or resolved) rail-sections PARSE. rail-sections.json is
// ~12 MB raw / 2.4 MB gzipped and is consumed ONLY by the route solver, which
// runs after the map is already on screen — so it is fetched in parallel with
// boot but never blocks first paint. ensureRailSectionsLoaded() awaits it right
// before the first solve.
let railSectionsReady = null;
// The DOWNLOAD (response.text(), no JSON.parse). Kept separate from
// railSectionsReady (the parse pipeline) so the ~1.1 s parse can be deferred
// off the first-paint path and run in yielding chunks later.
let railSectionsTextReady = null;

async function parseFeatureCollectionChunked(text) {
  return parseFeatureCollectionTextChunked(text, {
    now: () => performance.now(),
    yieldControl: yieldToEventLoop,
  });
}

async function ensureRailSectionsLoaded() {
  if (railSectionsGeoJson) return railSectionsGeoJson;
  if (!railSectionsReady) {
    railSectionsReady = (async () => {
      // Reuse the in-flight/finished boot download; re-fetch once on failure.
      let text;
      try {
        text = await (railSectionsTextReady ||
          AppDatasets.startRailSectionsDownload());
      } catch {
        text = await AppDatasets.startRailSectionsDownload();
      }
      const data = AppDatasets.installRailSections(
        await parseFeatureCollectionChunked(text),
      );
      // Release the raw ~12 MB JSON string (≈24 MB as a JS string): the memoised
      // download promise would otherwise keep it resident for the whole session,
      // which matters on memory-tight iPhones.
      railSectionsTextReady = null;
      return data;
    })();
    // On any failure clear the memo so a later call retries cleanly.
    railSectionsReady.catch(() => {
      railSectionsReady = null;
    });
  }
  return railSectionsReady;
}
