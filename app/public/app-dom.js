// =========================================================================
//  app-dom.js — the cached DOM element table
//
//  `els` was declared in app.js, which made every module that touches the
//  DOM depend on the boot spine: app-render.js and app-map-fit.js reached
//  into app.js for NOTHING ELSE, so that one binding was the whole reason
//  those two files sat in a dependency cycle with it.
//
//  Owning the table here makes it a leaf. Nothing in this file depends on
//  another app module, and every consumer now depends on a table of DOM
//  handles instead of on the entry point.
//
//  Load order: index.html loads the app family at the END of <body> with no
//  `defer`, so the document is fully parsed by the time this evaluates and
//  getElementById resolves every element synchronously, before first render
//  — the same guarantee the table had inside app.js.
// =========================================================================

const els = {
  list: document.getElementById("train-list"),
  dateBar: document.getElementById("date-bar"),
  dateStatus: document.getElementById("date-status"),
  listTitle: document.getElementById("train-list-title"),
  importTarget: document.getElementById("import-target"),
  mapDateFilter: document.getElementById("map-date-filter"),
  search: document.getElementById("search-input"),
  importJson: document.getElementById("import-json-input"),
  importStatus: document.getElementById("import-status"),
  importProgressWrap: document.getElementById("import-progress-wrap"),
  importProgressFill: document.getElementById("import-progress-fill"),
  importProgressText: document.getElementById("import-progress-text"),
  localJsonFileInput: document.getElementById("local-json-file-input"),
  json: document.getElementById("train-json-input"),
  jsonStatus: document.getElementById("json-status"),
  fieldStatus: document.getElementById("field-status"),
  stopsBody: document.getElementById("stops-body"),
  id: document.getElementById("field-id"),
  number: document.getElementById("field-number"),
  trainType: document.getElementById("field-train-type"),
  company: document.getElementById("field-company"),
  direction: document.getElementById("field-direction"),
  origin: document.getElementById("field-origin"),
  destination: document.getElementById("field-destination"),
  color: document.getElementById("field-color"),
  toggleFocusZoom: document.getElementById("toggle-focus-zoom"),
  playTrains: document.getElementById("play-trains"),
  playbackBar: document.getElementById("playback-bar"),
  playbackToggle: document.getElementById("playback-toggle"),
  playbackStop: document.getElementById("playback-stop"),
  playbackPrev: document.getElementById("playback-prev"),
  playbackNext: document.getElementById("playback-next"),
  playbackSpeed: document.getElementById("playback-speed"),
  playbackSpeedValue: document.getElementById("playback-speed-value"),
  playbackLabel: document.getElementById("playback-label"),
  playbackStation: document.getElementById("playback-station"),
  playbackProgressFill: document.getElementById("playback-progress-fill"),
  playbackExport: document.getElementById("playback-export"),
  playbackRecording: document.getElementById("playback-recording"),
  playbackRecordingText: document.getElementById("playback-recording-text"),
  playbackRecordingStop: document.getElementById("playback-recording-stop"),
  playbackDownload: document.getElementById("playback-download"),
  playbackPreview: document.getElementById("playback-preview"),
  playbackExportOptions: document.getElementById("playback-export-options"),
  playbackShape: document.getElementById("playback-shape"),
  playbackQuality: document.getElementById("playback-quality"),
  playbackBitrate: document.getElementById("playback-bitrate"),
  playbackExportSummary: document.getElementById("playback-export-summary"),
  playbackExportStart: document.getElementById("playback-export-start"),
  playbackExportCancel: document.getElementById("playback-export-cancel"),
};
