// A read-only view across storage namespaces. Never changes activeCountry,
// the autosave baseline, the solver, or the active train store.
let statsRegionsToken = 0;

function buildRegionRideSummary(stores, date = ALL_DATES) {
  const regions = [];
  for (const [country, store] of stores) {
    const rides = (store?.trains || []).filter((train) =>
      (date === ALL_DATES || getTrainDate(train) === date) &&
      (train.stops || []).some((_, index) => isRideSegment(train, index)),
    );
    if (rides.length) regions.push({ country, count: rides.length, minutes: sumRideMinutes(rides) });
  }
  regions.sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));
  return {
    regions,
    count: regions.reduce((sum, row) => sum + row.count, 0),
    minutes: regions.reduce((sum, row) => sum + row.minutes, 0),
  };
}

async function readRegionSavedStore(country) {
  if (HAS_BACKEND) {
    const response = await fetch(apiResourceUrl(trainStoreApiForCountry(country)));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const store = await response.json();
    if (!Array.isArray(store?.trains)) throw new Error(I18N.t("guide.invalidStore"));
    return store;
  }
  const db = await openIdb(
    AppCore.countrySuffixed(USER_STORE_DB_NAME, country),
    [USER_STORE_DATES_STORE, USER_STORE_META_STORE],
    I18N.t("passport.regionsFailed"),
  );
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(USER_STORE_DATES_STORE, "readonly");
      const request = tx.objectStore(USER_STORE_DATES_STORE).getAll();
      tx.oncomplete = () => {
        const trains = [];
        for (const record of request.result || []) {
          if (!Array.isArray(record?.trains)) { reject(new Error(I18N.t("guide.invalidStore"))); return; }
          trains.push(...record.trains);
        }
        resolve({ trains });
      };
      tx.onerror = tx.onabort = () => reject(tx.error || new Error(I18N.t("passport.regionsFailed")));
    });
  } finally { db.close(); }
}

function invalidateStatsRegions() {
  statsRegionsToken += 1;
  const host = document.getElementById("passport-region-summary");
  if (host) host.textContent = "";
  const button = document.getElementById("passport-load-regions");
  if (button) button.disabled = false;
}

function bindStatsRegions() {
  const button = document.getElementById("passport-load-regions");
  if (!button || button.dataset.bound) return;
  button.dataset.bound = "true";
  button.addEventListener("click", async () => {
    const token = ++statsRegionsToken;
    const country = activeCountry;
    const date = passportScopeDate || ALL_DATES;
    const host = document.getElementById("passport-region-summary");
    button.disabled = true;
    host.textContent = I18N.t("passport.regionsLoading");
    const stores = new Map([[country, !HAS_BACKEND && isSampleMode() ? null : trainStore]]);
    const failures = [];
    // Read one namespace at a time; large saved stores should not all parse
    // in the same frame. The active in-memory store includes unsaved edits.
    for (const other of SUPPORTED_COUNTRIES) {
      if (token !== statsRegionsToken || activeCountry !== country || passportScopeDate !== date) return;
      if (other === country) continue;
      try { stores.set(other, await readRegionSavedStore(other)); }
      catch { failures.push(I18N.t(`country.${other}`)); }
    }
    if (token !== statsRegionsToken || activeCountry !== country || passportScopeDate !== date) return;
    const summary = buildRegionRideSummary(stores, date);
    host.innerHTML = `<p>${escapeHtml(date === ALL_DATES ? I18N.t("date.all") : dateLabel(date))} · ${escapeHtml(I18N.t("stat.trains", { n: summary.count }))} · ${escapeHtml(formatStatDuration(summary.minutes))}</p>
      ${summary.regions.map((row) => `<div class="passport-stat-rank"><span>${escapeHtml(I18N.t(`country.${row.country}`))}</span><strong>${escapeHtml(I18N.t("stat.trains", { n: row.count }))} · ${escapeHtml(formatStatDuration(row.minutes))}</strong></div>`).join("")}
      ${failures.length ? `<p class="hint">${escapeHtml(I18N.t("passport.regionsPartial", { names: failures.join("、") }))}</p>` : ""}`;
    button.disabled = false;
  });
}
