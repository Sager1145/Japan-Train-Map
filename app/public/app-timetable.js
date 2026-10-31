// Read-only exact matching against a lazy native timetable snapshot. The
// Web route editor cannot apply incomplete historical/line evidence, so a
// candidate is a source-backed preview, never a silent itinerary expansion.
let timetableSnapshotPromise = null;
let timetableSearchToken = 0;

function indexWebTimetable(data) {
  if (data?.format !== "jtm-web-timetable-1" || !Array.isArray(data.trips) || !Array.isArray(data.stop_times)) throw new Error("Timetable format");
  const unique = (name, key) => new Map(data[name].map((row) => [row[key], row]));
  const grouped = (name, key) => {
    const map = new Map();
    for (const row of data[name]) {
      if (!map.has(row[key])) map.set(row[key], []);
      map.get(row[key]).push(row);
    }
    return map;
  };
  return { data, services: unique("services", "service_id"), names: grouped("service_name_periods", "service_id"),
    versions: unique("timetable_versions", "timetable_version_id"), calendars: unique("calendars", "calendar_id"),
    stations: unique("station_identities", "station_id"), stops: grouped("stop_times", "trip_id"),
    exceptions: grouped("calendar_exceptions", "calendar_id"), overrides: grouped("trip_stop_time_overrides", "trip_id"),
    numbers: grouped("trip_train_number_overrides", "trip_id"), symbols: grouped("trip_timetable_symbols", "trip_id"),
    sources: unique("source_documents", "source_id"), versionSources: grouped("timetable_version_sources", "timetable_version_id"),
    holidayYears: unique("holiday_calendar_years", "year"), holidays: new Set(data.holiday_dates.map((row) => row.service_date)),
  };
}

function webTimetableInterval(date, from, until) {
  return (!from || from <= date) && (!until || date < until);
}

function webTimetableRuns(index, trip, date) {
  const version = index.versions.get(trip.timetable_version_id);
  const calendar = index.calendars.get(trip.calendar_id);
  if (!version || !calendar || version.completeness === "conflict" || !webTimetableInterval(date, version.effective_from, version.effective_until)) return false;
  const exceptions = (index.exceptions.get(trip.calendar_id) || []).filter((row) => row.service_date === date);
  if (exceptions.some((row) => row.exception_type === "remove")) return false;
  if (calendar.holiday_policy === "treat_as_sunday" && index.holidayYears.get(Number(date.slice(0, 4)))?.status !== "verified") return null;
  if (exceptions.some((row) => row.exception_type === "add")) return true;
  if (!webTimetableInterval(date, calendar.valid_from, calendar.valid_until)) return false;
  const weekday = index.holidays.has(date) && calendar.holiday_policy === "treat_as_sunday" ? 0 : new Date(`${date}T00:00:00Z`).getUTCDay();
  return Boolean(calendar[["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][weekday]]);
}

function webTimetableCalls(index, trip, date) {
  const overrides = new Map((index.overrides.get(trip.trip_id) || []).filter((row) => row.service_date === date).map((row) => [row.stop_sequence, row]));
  return (index.stops.get(trip.trip_id) || []).map((row) => {
    const override = overrides.get(row.stop_sequence);
    return { ...row, station: index.stations.get(row.station_id),
      arrival_seconds: override?.arrival_seconds_override ?? row.arrival_seconds,
      departure_seconds: override?.departure_seconds_override ?? row.departure_seconds,
      platform: override?.platform_override_present ? override.platform_override : row.platform,
      source_id: override?.source_id || row.source_id,
    };
  }).sort((a, b) => a.stop_sequence - b.stop_sequence);
}

function webTimetableSeconds(value) {
  if (!/^\d{2}:[0-5]\d$/.test(value || "")) return null;
  return (Number(value.slice(0, 2)) * 60 + Number(value.slice(3))) * 60;
}

function webTimetableCandidates(index, train, serviceName = "") {
  const date = getTrainDate(train);
  const from = train.stops?.[0];
  const to = train.stops?.[train.stops.length - 1];
  const departure = webTimetableSeconds(from?.departure);
  const arrival = webTimetableSeconds(to?.arrival);
  if (!isValidDateString(date) || !from?.n02_station_code || !to?.n02_station_code || departure === null || arrival === null) return { matches: [], holidayUnknown: false };
  const query = (serviceName || train.number || "").trim().toLowerCase();
  const matches = [];
  let holidayUnknown = false;
  for (const trip of index.data.trips) {
    const number = (index.numbers.get(trip.trip_id) || []).find((row) => row.service_date === date)?.train_number || trip.train_number;
    const service = index.services.get(trip.service_id);
    const names = [service?.canonical_name, number, trip.public_number,
      ...(index.names.get(trip.service_id) || []).filter((row) => webTimetableInterval(date, row.valid_from, row.valid_until)).map((row) => row.name)]
      .filter(Boolean).map((name) => name.toLowerCase());
    if (query && !names.some((name) => query === name || query.startsWith(`${name} `))) continue;
    const runs = webTimetableRuns(index, trip, date);
    if (runs === null) { holidayUnknown = true; continue; }
    if (!runs) continue;
    const calls = webTimetableCalls(index, trip, date);
    const passenger = calls.filter((row) => ["origin", "passenger_stop", "destination"].includes(row.call_type));
    const origin = passenger[0]; const destination = passenger[passenger.length - 1];
    if (passenger.length < 2 || origin.station?.reference_kind !== "current_n02" || destination.station?.reference_kind !== "current_n02" ||
      origin.station.current_source_code !== from.n02_station_code || destination.station.current_source_code !== to.n02_station_code ||
      origin.departure_seconds !== departure || destination.arrival_seconds !== arrival) continue;
    matches.push({ trip, service, number, calls, version: index.versions.get(trip.timetable_version_id) });
  }
  return { matches, holidayUnknown };
}

function resetTimetablePreview() {
  timetableSearchToken += 1;
  const host = document.getElementById("timetable-results");
  if (host) host.innerHTML = "";
  const button = document.getElementById("timetable-search");
  const train = getTrain();
  if (button) button.disabled = activeCountry !== "jp" || !train || !isValidDateString(getTrainDate(train)) ||
    !train.stops?.[0]?.n02_station_code || !train.stops?.[train.stops.length - 1]?.n02_station_code ||
    webTimetableSeconds(train.stops?.[0]?.departure) === null || webTimetableSeconds(train.stops?.[train.stops.length - 1]?.arrival) === null;
}

function renderWebTimetableMatches(index, result) {
  const clock = (seconds) => seconds == null ? "—" : `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`;
  const sourceHtml = (source) => {
    const title = `${source.publisher} · ${source.title}`;
    return /^https?:\/\//.test(source.url_or_locator)
      ? `<a href="${escapeHtml(source.url_or_locator)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
      : escapeHtml(`${title} · ${source.url_or_locator}`);
  };
  return `<p>${escapeHtml(I18N.t("timetable.found", { n: result.matches.length }))}</p>
    ${result.holidayUnknown ? `<p class="hint">${escapeHtml(I18N.t("timetable.holidayUnknown"))}</p>` : ""}
    ${result.matches.map(({ trip, service, number, calls, version }) => {
      const sourceIDs = new Set([...(index.versionSources.get(trip.timetable_version_id) || []).map((row) => row.source_id), ...calls.map((row) => row.source_id), ...(index.numbers.get(trip.trip_id) || []).map((row) => row.source_id)]);
      return `<details class="timetable-candidate"><summary>${escapeHtml(`${service?.canonical_name || ""} · ${number || trip.public_number || ""} · ${version.edition_name}`)}</summary>
        <p class="hint">${escapeHtml(I18N.t("timetable.readOnly"))} · ${escapeHtml(I18N.t(`timetable.status.${version.completeness}`))}</p>
        <div class="timetable-table"><table><thead><tr><th>${escapeHtml(I18N.t("guide.station"))}</th><th>${escapeHtml(I18N.t("guide.arrival"))}</th><th>${escapeHtml(I18N.t("guide.departure"))}</th></tr></thead><tbody>
          ${calls.map((row) => `<tr><td>${escapeHtml(row.station?.name_snapshot || row.station_id)}<small>${escapeHtml(I18N.t(row.call_type === "unknown" ? "timetable.status.unknown" : `stoptype.${row.call_type === "pass" ? "pass_through" : row.call_type}`))}${row.platform ? ` · ${escapeHtml(row.platform)}` : ""}</small></td><td>${clock(row.arrival_seconds)}</td><td>${clock(row.departure_seconds)}</td></tr>`).join("")}
        </tbody></table></div>
        ${(index.symbols.get(trip.trip_id) || []).length ? `<p>${escapeHtml(I18N.t("timetable.symbols"))}: ${escapeHtml(index.symbols.get(trip.trip_id).map((row) => `${row.station_name} ${row.symbol}`).join(" · "))}</p>` : ""}
        <ul>${[...sourceIDs].map((id) => index.sources.get(id)).filter(Boolean).map((source) => `<li>${sourceHtml(source)}</li>`).join("")}</ul></details>`;
    }).join("")}`;
}

function setupWebTimetable() {
  const button = document.getElementById("timetable-search");
  if (!button) return;
  document.getElementById("timetable-service").addEventListener("input", resetTimetablePreview);
  button.addEventListener("click", async () => {
    const train = getTrain(); if (!train || activeCountry !== "jp") return;
    const token = ++timetableSearchToken;
    const host = document.getElementById("timetable-results");
    button.disabled = true;
    host.textContent = I18N.t("timetable.loading");
    try {
      if (!timetableSnapshotPromise) timetableSnapshotPromise = fetch(new URL("timetable/snapshot.json", document.baseURI)).then((response) => {
        if (!response.ok) throw new Error("Timetable snapshot"); return response.json();
      }).then(indexWebTimetable).catch((error) => { timetableSnapshotPromise = null; throw error; });
      const index = await timetableSnapshotPromise;
      if (token !== timetableSearchToken || getTrain() !== train || activeCountry !== "jp") return;
      const result = webTimetableCandidates(index, train, document.getElementById("timetable-service").value);
      host.innerHTML = renderWebTimetableMatches(index, result);
    } catch { if (token === timetableSearchToken) host.textContent = I18N.t("timetable.failed"); }
    finally { if (token === timetableSearchToken) button.disabled = false; }
  });
}
