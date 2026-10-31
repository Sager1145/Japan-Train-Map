// =========================================================================
//  app-import-controller.js — import/persistence orchestration boundary
//
//  Persistence reads and writes bytes; the progressive import engine applies
//  canonical stores. This controller is the only layer that coordinates both.
// =========================================================================

setPersistenceStateChangedListener(() => updateDataSourceUi());

// One UI append path for JSON paste and reviewed transfer-guide drafts.
async function appendJsonFromUi(jsonText) {
  if (importBusy()) return null;
  const country = activeCountry;
  const store = parseImportedCanonicalStore(jsonText);
  validateTrainStore({ schema_version: SCHEMA_VERSION, trains: store.trains.map((train) => normalizeImportedTrain(train)) });
  if (!HAS_BACKEND && isSampleMode()) {
    if (await uiConfirm(I18N.t("confirm.importInSample"))) {
      if (country !== activeCountry || importBusy()) return null;
      dataSourceMode = "user";
      sampleModeDate = null;
      resetTrainStoreForProgressiveLoad();
      updateDataSourceUi();
    }
  }
  if (country !== activeCountry || importBusy()) return null;
  fitActiveCountryOverview();
  resetImportProgress();
  els.search.value = "";
  const result = await importCanonicalStoreAppendProgressive(jsonText, ({ count, total, id }) => {
    setImportProgress(count, total, I18N.t("prog.loadingShort", { count, total, id }));
  });
  setImportProgress(result.count, result.count, I18N.t("prog.done", { count: result.count }));
  setStatus(els.importStatus, I18N.t("status.imported", { count: result.count, ids: result.ids.join(", ") }), "ok");
  await PersistenceService.flush();
  return result;
}

async function openLocalJsonAndImport() {
  const picked = await PersistenceService.pickLocalJson();
  if (!picked) return false;
  await replaceTrainStoreFromJsonText(
    picked.text,
    I18N.t("src.localJson", { name: picked.name }),
  );
  return true;
}

/**
 * @typedef {Object} ImportControllerContract
 * @property {(jsonText: string, sourceLabel?: string) => Promise<void>} replaceJson
 * @property {() => Promise<boolean>} openLocalJson
 */

/** @type {Readonly<ImportControllerContract>} */
const ImportController = Object.freeze({
  replaceJson: replaceTrainStoreFromJsonText,
  openLocalJson: openLocalJsonAndImport,
});
