// =========================================================================
//  app-country-session.js — country-session coordinator
//
//  Owns the transition across persistence, datasets, translations, map state,
//  solver caches, route caches, selection state, and rendering. Import code
//  supplies stores; it no longer owns this application-level workflow.
// =========================================================================

let countrySwitchInFlight = false;

function updateCountrySelect() {
  const select = document.getElementById("country-select");
  if (!select) return;
  select.value = activeCountry;
  select.disabled = countrySwitchInFlight;
}

function setupCountrySelect() {
  const select = document.getElementById("country-select");
  if (!select) return;
  updateCountrySelect();
  select.addEventListener("change", async () => {
    try {
      await CountrySession.switchTo(select.value);
    } catch (err) {
      console.error("Country switch failed.", err);
      setStatus(
        els.importStatus,
        I18N.t("status.countrySwitchFailed", {
          msg: (err && err.message) || "",
        }),
        "err",
      );
    } finally {
      // Reflect the real state — a refused or failed switch snaps back.
      updateCountrySelect();
    }
  });
}

async function switchCountrySession(next) {
  if (!SUPPORTED_COUNTRIES.includes(next) || next === activeCountry) return;
  // A progressive load owns the store globals; switching mid-flight would
  // interleave two replacements. The select snaps back via the caller.
  if (countrySwitchInFlight || importInProgress) {
    if (els.importStatus) {
      setStatus(els.importStatus, I18N.t("status.importBusy"), "warn");
    }
    return;
  }
  countrySwitchInFlight = true;
  updateCountrySelect();
  try {
    // Land all network, IndexedDB, and recovery-journal work in the old
    // country's namespace before any country-dependent target is changed.
    try {
      await PersistenceService.flush();
    } catch (err) {
      console.warn(
        "Could not flush pending saves before the country switch.",
        err,
      );
    }

    persistUiDateState();
    activeCountry = next;
    if (window.I18N && typeof I18N.setCountry === "function") {
      I18N.setCountry(next);
      I18N.applyStatic(document);
      if (typeof I18N.setStationReadings === "function") {
        I18N.setStationReadings({
          country: next.toUpperCase(),
          byCode: {},
          byName: {},
        });
      }
    }
    try {
      localStorage.setItem(COUNTRY_STORAGE_KEY, next);
    } catch {
      /* preference just won't survive a reload */
    }

    TRAIN_STORE_API = trainStoreApiForCountry(next);
    const networkCountryReady =
      typeof RailMap !== "undefined" &&
      typeof RailMap.switchNetworkCountry === "function"
        ? RailMap.switchNetworkCountry(next, railPackageUrlsForCountry(next))
        : Promise.resolve(null);
    PersistenceService.resetForCountry();
    PersistenceService.exitRecoveryMode();

    // Runtime route artifacts do not encode country. Purge them before the new
    // country's same-named stations or reused train ids can read old geometry.
    // Persisted caches remain isolated by countryDbName and are not deleted.
    RouteService.resetForCountry();
    if (matchedRoutesGeoJson && Array.isArray(matchedRoutesGeoJson.features)) {
      matchedRoutesGeoJson.features = matchedRoutesGeoJson.features.filter(
        (feature) =>
          !String((feature.properties || {}).route_id || "").endsWith(
            "-runtime-primary",
          ),
      );
    }
    AppActions.resetWorkspaceForCountry();

    applyUiDateStateForCountrySwitch();
    updateDataSourceUi();
    if (typeof map !== "undefined" && map) {
      map.setMaxBounds(null);
      map.setMinZoom(2);
      fitActiveCountryOverview({ animate: true });
      map.once("moveend", () => applyJapanMapConstraints());
    }

    // The station index must belong to the NEW country before a single train
    // of it is read. Loading the store concurrently with the dataset reload
    // meant the incoming trains were validated — and progressively rendered —
    // against the outgoing country's index, and the two countries share
    // station names: §6.4's branch-leak check resolved Taiwan's 桃園 to 近鉄
    // 名古屋線, 岡山 to 山陽新幹線, 松山 to 予讃線, and warned about two dozen
    // phantom leaks on every switch to tw. Boot already orders it this way
    // (loadAppData awaits buildStationIndexesSliced before anything reads a
    // stop); the switch now does too.
    await Promise.all([
      reloadSolverDatasetsForCountrySwitch(),
      networkCountryReady,
      loadActiveCountryStationReadings(),
    ]);
    await loadActiveCountryStore({
      persistEachStep: false,
      finalPersist: false,
      selectFirstTrain: false,
    });

    // Progressive loading may have rendered before complete-line geometry was
    // ready. Invalidate once and publish an authoritative final render.
    AppActions.invalidateRouteRender();
    if (typeof invalidateDeckRouteCaches === "function") {
      invalidateDeckRouteCaches();
    }
    renderAll();
    if (!PersistenceService.recoveryMode) {
      setStatus(
        els.importStatus,
        I18N.t("status.countrySwitched", {
          name: I18N.t(`country.${activeCountry}`),
        }),
        "ok",
      );
    }
  } finally {
    countrySwitchInFlight = false;
    updateCountrySelect();
  }
}

/**
 * @typedef {Object} CountrySessionContract
 * @property {(country: string) => Promise<void>} switchTo
 */

/** @type {Readonly<CountrySessionContract>} */
const CountrySession = Object.freeze({
  switchTo: switchCountrySession,
});

// Compatibility name for console/test callers while the classic-script API is
// still supported. Application controllers use CountrySession directly.
const switchActiveCountry = CountrySession.switchTo;
