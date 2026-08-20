// =========================================================================
//  app-state.js — core application state owner and named state transitions
//
//  Classic-script compatibility is intentional: the lexical bindings below
//  remain visible to the ordered app family and the Node VM replay. New code
//  should read through AppState and change state through AppActions. Existing
//  direct writers are migrated one state group at a time.
// =========================================================================

/**
 * @typedef {Object} AppStateView
 * @property {{schema_version: string, trains: Array<Object>}} trainStore
 * @property {?string} selectedTrainId
 * @property {?string} focusedTrainId
 * @property {Map} endpointLabelMarkers
 * @property {string} selectedDate
 * @property {Array<string>} manualDates
 * @property {boolean} mapFollowsSelectedDate
 * @property {boolean} focusZoomEnabled
 * @property {?Object} map
 * @property {?Array<Object>} cachedRouteItems
 * @property {string} cachedRouteSignature
 * @property {string} cachedRouteOverlapSignature
 * @property {boolean} cachedRouteDateActive
 * @property {Array<Object>} cachedOrderedTrains
 * @property {boolean} importInProgress
 * @property {string} dataSourceMode
 * @property {?string} sampleModeDate
 * @property {boolean} userStoreAvailable
 * @property {boolean} sampleEditHintShown
 */

let trainStore = { schema_version: SCHEMA_VERSION, trains: [] };
let selectedTrainId = null;
let focusedTrainId = null;
// Live maplibregl.Marker instances for the on-map origin/destination labels.
let endpointLabelMarkers = new Map(); // label key -> { marker, el, anchor, fadeTimer }
// Which date the sidebar list is filtered to. ALL_DATES shows the combined
// "all trains" list; otherwise it is a concrete "YYYY-MM-DD" (or UNDATED).
let selectedDate = ALL_DATES;
// Dates the user created manually that may not yet have any train.
let manualDates = [];
// Whether the map mirrors the sidebar date filter.
let mapFollowsSelectedDate = false;
// Whether a date/train selection also fits the map to that selection.
let focusZoomEnabled = false;
// The maplibregl.Map instance created by initMap.
let map;

// Cached route render items and the signatures that define their scope.
let cachedRouteItems = null,
  cachedRouteSignature = "",
  cachedRouteOverlapSignature = "",
  cachedRouteDateActive = false;
let cachedOrderedTrains = [];
let importInProgress = false;

// What the store on screen represents, and therefore whether edits persist.
let dataSourceMode = "user";
let sampleModeDate = null;
let userStoreAvailable = false;
let sampleEditHintShown = false;

/** @type {Readonly<AppStateView>} */
const AppState = Object.freeze({
  get trainStore() {
    return trainStore;
  },
  get selectedTrainId() {
    return selectedTrainId;
  },
  get focusedTrainId() {
    return focusedTrainId;
  },
  get endpointLabelMarkers() {
    return endpointLabelMarkers;
  },
  get selectedDate() {
    return selectedDate;
  },
  get manualDates() {
    return manualDates;
  },
  get mapFollowsSelectedDate() {
    return mapFollowsSelectedDate;
  },
  get focusZoomEnabled() {
    return focusZoomEnabled;
  },
  get map() {
    return map || null;
  },
  get cachedRouteItems() {
    return cachedRouteItems;
  },
  get cachedRouteSignature() {
    return cachedRouteSignature;
  },
  get cachedRouteOverlapSignature() {
    return cachedRouteOverlapSignature;
  },
  get cachedRouteDateActive() {
    return cachedRouteDateActive;
  },
  get cachedOrderedTrains() {
    return cachedOrderedTrains;
  },
  get importInProgress() {
    return importInProgress;
  },
  get dataSourceMode() {
    return dataSourceMode;
  },
  get sampleModeDate() {
    return sampleModeDate;
  },
  get userStoreAvailable() {
    return userStoreAvailable;
  },
  get sampleEditHintShown() {
    return sampleEditHintShown;
  },
});

/**
 * Named transitions for state groups that have been migrated. Keeping these
 * operations beside the bindings makes their write ownership explicit while
 * the remaining groups are converted in later batches.
 */
const AppActions = Object.freeze({
  replaceTrainStore(nextStore) {
    trainStore = nextStore;
    return trainStore;
  },
  resetTrainStore() {
    trainStore = { schema_version: SCHEMA_VERSION, trains: [] };
    return trainStore;
  },
  resetWorkspaceForCountry() {
    selectedTrainId = null;
    focusedTrainId = null;
    dataSourceMode = "user";
    sampleModeDate = null;
    sampleEditHintShown = false;
    userStoreAvailable = false;
  },
  invalidateRouteRender() {
    cachedRouteItems = null;
    cachedRouteSignature = "";
  },
});

function isSampleMode() {
  return (
    dataSourceMode === "sample-single" ||
    dataSourceMode === "sample-all" ||
    dataSourceMode === "sample-new-year-grand-loop" ||
    dataSourceMode === "sample-tokyo-limited-express-loop"
  );
}

// Marker level-of-detail thresholds are state-adjacent render configuration:
// map initialization and record rendering must share the same values.
const PASSTHROUGH_MIN_ZOOM = 9;
const STOP_MIN_ZOOM = 7;
