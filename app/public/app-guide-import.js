// Preview-first adapter for Japanese transfer guides. Only text present in
// the source becomes a call; unresolved station identities require review.
function parseTransferGuideText(raw) {
  const legs = [];
  const unclaimed = [];
  let calls = [];
  let service = "";
  let equipment = "";
  let pendingTimes = [];
  let pendingName = "";
  let skipLeg = false;
  let departurePlatform = null;
  let arrivalPlatform = null;
  const copyCall = (call) => ({ ...call, times: call.times.map((time) => ({ ...time })) });
  const finish = () => {
    if (calls.length >= 2 && service && !skipLeg) {
      const saved = calls.map(copyCall);
      saved[0].departurePlatform = departurePlatform;
      saved[saved.length - 1].arrivalPlatform = arrivalPlatform;
      legs.push({ service, equipment, calls: saved });
    }
  };
  const boundary = () => {
    finish();
    calls = calls.length ? [copyCall(calls[calls.length - 1])] : [];
    departurePlatform = null;
    arrivalPlatform = null;
  };
  const readTimes = (line) => [...line.matchAll(/(\d{1,2})[:：](\d{2})\s*(発|着)?/g)]
    .map((match) => ({ minutes: Number(match[1]) * 60 + Number(match[2]), marker: match[3] || "", valid: Number(match[2]) < 60 }))
    .filter((time) => time.valid);
  for (const original of String(raw || "").split(/\r?\n/)) {
    let line = original.normalize("NFKC").replace(/J\s+R/g, "JR").trim();
    if (!line) continue;
    if (/Yahoo|CO2|排出量|ルートを共有|経路をシェア/i.test(line)) break;
    if (/\d{1,2}:\d{2}\s*[→⇒~〜]/.test(line) || /\d+月\d+日|\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const platform = line.match(/(発|着)\s*(\d+)番線/);
    if (platform) {
      if (platform[1] === "発") departurePlatform = Number(platform[2]);
      else arrivalPlatform = Number(platform[2]);
      continue;
    }
    line = line.replace(/\d[\d,]*円|\d+(?:\.\d+)?km|乗(?:り)?換(?:え)?\d+回|\d+駅|\d+両/gi, "").trim();
    if (!line) continue;
    if (/徒歩|バス|飛行機|航空/.test(line)) {
      boundary(); service = ""; equipment = ""; skipLeg = true;
      continue;
    }
    if (/^[発着]$/.test(line)) {
      const time = pendingTimes[pendingTimes.length - 1];
      if (time) time.marker = line;
      continue;
    }
    const times = readTimes(line);
    if (!times.length && /JR|新幹線|特急|快速|急行|各駅停車|普通|線(?:[・(\w\s]|$)|\d+号/.test(line) && !/行$|当駅始発|指定席|自由席/.test(line)) {
      // A line change without a new call is a through service, not a transfer.
      if (service && calls.length <= 1 && !skipLeg) continue;
      if (service || skipLeg) boundary();
      const stock = line.match(/\(([^)]+)\)/);
      equipment = stock?.[1] || "";
      service = line.replace(/\([^)]*\)|直通/g, "").trim();
      skipLeg = false;
      continue;
    }
    if (/当駅始発|指定席|自由席|グリーン車|IC優先|乗換|直通|行$|運賃|出発時刻|更新時刻|運行情報/.test(line) && !times.length) continue;
    const name = line.replace(/\d{1,2}[:：]\d{2}\s*(?:発|着)?/g, "")
      .replace(/^[発着\s→⇒|]+|[\s|]+$/g, "").replace(/\s+i{2,}$/i, "").trim();
    if (!name) {
      if (pendingName && times.length) {
        calls.push({ name: pendingName, times: [...pendingTimes, ...times] });
        pendingName = ""; pendingTimes = [];
      } else if (times.some((time) => time.marker === "発") && calls.length && !pendingTimes.length) {
        calls[calls.length - 1].times.push(...times);
      } else pendingTimes.push(...times);
      continue;
    }
    if (/\d+時間|^\(?\d+分\)?$|乗換案内|検索|詳細|保存/.test(name)) continue;
    if (!times.length && !pendingTimes.length) {
      if (pendingName) unclaimed.push(pendingName);
      pendingName = name;
      continue;
    }
    if (pendingName) { unclaimed.push(pendingName); pendingName = ""; }
    calls.push({ name, times: [...pendingTimes, ...times] });
    pendingTimes = [];
  }
  if (pendingName) unclaimed.push(pendingName);
  finish();
  return { legs, unclaimed };
}

function transferGuideDraftTrains(parsed, { date, ridden = false, country = "jp" }) {
  const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  // Carry the day across transfers as well as calls within one leg.
  let lastMinutes = null;
  let offset = 0;
  return parsed.legs.map((leg, index) => {
    const stops = leg.calls.map((call, stopIndex) => {
      const first = stopIndex === 0;
      const last = stopIndex === leg.calls.length - 1;
      let arrival = null;
      let departure = null;
      const selected = first ? call.times.filter((time) => time.marker !== "着")
        : last ? call.times.filter((time) => time.marker !== "発") : call.times;
      for (const time of selected) {
        let minutes = time.minutes + offset;
        // A small backward step is an OCR/source error for review, not a
        // fabricated 24-hour journey. Only an evening-to-morning wrap rolls.
        if (lastMinutes !== null && minutes < lastMinutes && lastMinutes % 1440 >= 1080 && time.minutes < 360) {
          offset += 1440; minutes += 1440;
        }
        lastMinutes = minutes;
        if (time.marker === "発" || first) departure = clock(minutes);
        else arrival = clock(minutes);
      }
      return { name: call.name, n02_station_code: null,
        platform_number: first ? call.departurePlatform ?? null : last ? call.arrivalPlatform ?? null : null,
        arrival, departure, stop_type: first ? "origin" : last ? "destination" : "stop", ride_segment: ridden };
    });
    return { id: `guide_${date.replace(/-/g, "")}_${index + 1}`, date, region: country,
      number: leg.service, train_type: /新幹線/.test(leg.service) ? "新幹線" : /特急/.test(leg.service) ? "特急" : "普通",
      vehicle_type: leg.equipment, origin: stops[0].name, destination: stops[stops.length - 1].name,
      direction: "down", visible: true, style: { color: "#1d7f8c" }, stops };
  });
}

function guideDraftProblems(draft) {
  let unresolved = 0;
  let invalidTimes = 0;
  draft.trains.forEach((train, index) => {
    if (!draft.included[index]) return;
    let previous = null;
    for (const stop of train.stops) {
      if (!resolveGuideStop(stop).has(stop.n02_station_code)) unresolved += 1;
      for (const value of [stop.arrival, stop.departure]) {
        if (!value) continue;
        if (!/^\d{2}:[0-5]\d$/.test(value)) { invalidTimes += 1; continue; }
        const minutes = Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
        if (previous !== null && minutes < previous) invalidTimes += 1;
        previous = minutes;
      }
    }
  });
  return { unresolved, invalidTimes };
}

let guideDraft = null;
let guideReadToken = 0;

function invalidateGuideDraft() {
  guideReadToken += 1;
  cancelGuideOcr();
  guideDraft = null;
  const button = document.getElementById("guide-commit");
  if (button) button.disabled = true;
  const preview = document.getElementById("guide-preview");
  if (preview) preview.innerHTML = "";
  const status = document.getElementById("guide-status");
  if (status) status.textContent = "";
}

function resolveGuideStop(stop) {
  const candidates = resolveStationCandidates({ name: stop.name });
  const codes = new Map(candidates.map((feature) => [stationCode(feature), feature]).filter(([code]) => code));
  if (codes.size === 1 && !stop.n02_station_code) stop.n02_station_code = [...codes.keys()][0];
  return codes;
}

function renderGuideDraft() {
  if (!guideDraft) return;
  const { unresolved, invalidTimes } = guideDraftProblems(guideDraft);
  const rowHtml = guideDraft.trains.map((train, index) => `<section class="guide-leg">
    <label><input type="checkbox" data-guide-include="${index}"${guideDraft.included[index] ? " checked" : ""} />${escapeHtml(train.number)}</label>
    ${train.stops.map((stop, stopIndex) => {
      const codes = resolveGuideStop(stop);
      return `<div class="guide-stop">
        <input data-guide-train="${index}" data-guide-stop="${stopIndex}" data-guide-field="name" aria-label="${escapeHtml(I18N.t("guide.station"))}" value="${escapeHtml(stop.name)}" />
        <select data-guide-train="${index}" data-guide-stop="${stopIndex}" data-guide-field="n02_station_code" aria-label="${escapeHtml(I18N.t("guide.stationCode"))}">
          <option value="">${escapeHtml(I18N.t("guide.chooseStation"))}</option>
          ${[...codes].map(([code, feature]) => `<option value="${escapeHtml(code)}"${code === stop.n02_station_code ? " selected" : ""}>${escapeHtml(`${stationName(feature)} · ${stationLineName(feature)} · ${code}`)}</option>`).join("")}
        </select>
        ${["arrival", "departure"].map((field) => `<label>${escapeHtml(I18N.t(`guide.${field}`))}<input data-guide-train="${index}" data-guide-stop="${stopIndex}" data-guide-field="${field}" value="${escapeHtml(stop[field] || "")}" placeholder="HH:MM" /></label>`).join("")}
      </div>`;
    }).join("")}
  </section>`).join("");
  document.getElementById("guide-preview").innerHTML = rowHtml;
  document.getElementById("guide-commit").disabled = unresolved > 0 || invalidTimes > 0 || !guideDraft.included.some(Boolean);
  document.getElementById("guide-status").textContent = unresolved ? I18N.t("guide.unresolved", { n: unresolved }) : I18N.t("guide.review");
  if (invalidTimes) document.getElementById("guide-status").textContent += ` ${I18N.t("guide.invalidTimes", { n: invalidTimes })}`;
  if (guideDraft.unclaimed.length) document.getElementById("guide-status").textContent += ` ${I18N.t("guide.unclaimed", { n: guideDraft.unclaimed.length })}`;
}

function setupGuideImport() {
  const text = document.getElementById("guide-text");
  if (!text) return;
  const date = document.getElementById("guide-date");
  const now = new Date();
  date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const ridden = document.getElementById("guide-ridden");
  const status = document.getElementById("guide-status");
  for (const input of [text, date, ridden]) input.addEventListener("input", invalidateGuideDraft);
  document.getElementById("guide-read").addEventListener("click", () => {
    invalidateGuideDraft();
    if (importBusy()) return;
    if (!isValidDateString(date.value)) { status.textContent = I18N.t("guide.invalidDate"); return; }
    const parsed = parseTransferGuideText(text.value);
    const trains = transferGuideDraftTrains(parsed, { date: date.value, ridden: ridden.checked, country: activeCountry });
    if (!trains.length) { status.textContent = I18N.t("guide.noLegs"); return; }
    guideDraft = { trains, included: trains.map(() => true), country: activeCountry, unclaimed: parsed.unclaimed };
    renderGuideDraft();
  });
  document.getElementById("guide-preview").addEventListener("change", (event) => {
    if (!guideDraft) return;
    const target = event.target;
    if (target.dataset.guideInclude !== undefined) guideDraft.included[Number(target.dataset.guideInclude)] = target.checked;
    else if (target.dataset.guideField) {
      const train = guideDraft.trains[Number(target.dataset.guideTrain)];
      const stop = train.stops[Number(target.dataset.guideStop)];
      stop[target.dataset.guideField] = target.value.trim() || null;
      if (target.dataset.guideField === "name") stop.n02_station_code = null;
      train.origin = train.stops[0].name;
      train.destination = train.stops[train.stops.length - 1].name;
    }
    renderGuideDraft();
  });
  document.getElementById("guide-commit").addEventListener("click", async () => {
    if (!guideDraft || importBusy()) return;
    if (guideDraft.country !== activeCountry) { invalidateGuideDraft(); status.textContent = I18N.t("guide.countryChanged"); return; }
    const problems = guideDraftProblems(guideDraft);
    if (problems.unresolved || problems.invalidTimes || !guideDraft.included.some(Boolean)) { renderGuideDraft(); return; }
    const button = document.getElementById("guide-commit");
    button.disabled = true;
    try {
      const trains = guideDraft.trains.filter((_, index) => guideDraft.included[index]);
      const result = await appendJsonFromUi(JSON.stringify({ schema_version: SCHEMA_VERSION, trains }));
      if (result) { invalidateGuideDraft(); status.textContent = I18N.t("guide.imported", { n: result.count }); }
      else renderGuideDraft();
    } catch (error) { renderGuideDraft(); status.textContent = error.message; }
  });
  const images = document.getElementById("guide-image");
  images.addEventListener("change", async () => {
    invalidateGuideDraft();
    const token = guideReadToken;
    const files = [...images.files];
    if (!files.length) return;
    status.textContent = I18N.t("guide.reading");
    try {
      const result = await readGuideImages(files, token, ({ page, total, percent }) => {
        status.textContent = I18N.t("guide.ocrProgress", { page, total, percent });
      });
      if (result === null || token !== guideReadToken) return;
      text.value = result;
      status.textContent = I18N.t("guide.ocrReview");
    } catch { if (token === guideReadToken) status.textContent = I18N.t("guide.ocrUnavailable"); }

  });
}
