// =========================================================================
//  app-import-controller.js — import/persistence orchestration boundary
//
//  Persistence reads and writes bytes; the progressive import engine applies
//  canonical stores. This controller is the only layer that coordinates both.
// =========================================================================

setPersistenceStateChangedListener(() => updateDataSourceUi());

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
