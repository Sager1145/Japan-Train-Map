// Journey-level Passport facts. Inputs are the same aligned, confirmed trains
// and route entries already used by the mileage view; no second route pass.
function buildPassportSummary(trains, entries) {
  const years = new Map();
  const months = new Map();
  const weekdays = new Map();
  const stations = new Map();
  const operators = new Map();
  const routes = new Map();
  const journeys = [];
  let totalKm = 0;
  let totalMinutes = 0;
  let timedJourneys = 0;
  let undated = 0;

  const add = (map, key, name, km, pair = null) => {
    const row = map.get(key) || { name, pair, count: 0, km: 0 };
    row.count += 1;
    row.km += km;
    map.set(key, row);
  };
  const bucket = (map, key, km) => {
    const row = map.get(key) || { count: 0, km: 0 };
    row.count += 1;
    row.km += km;
    map.set(key, row);
  };

  for (let i = 0; i < trains.length && i < entries.length; i += 1) {
    const train = trains[i];
    const km = Number.isFinite(entries[i]?.km) ? entries[i].km : 0;
    const minutes = trainRideMinutes(train);
    totalKm += km;
    if (minutes !== null && minutes > 0) {
      totalMinutes += minutes;
      timedJourneys += 1;
    }

    const date = getTrainDate(train);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const year = Number(date.slice(0, 4));
      const month = Number(date.slice(5, 7));
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() + 1;
      bucket(years, year, km);
      if (!months.has(year)) months.set(year, new Map());
      if (!weekdays.has(year)) weekdays.set(year, new Map());
      bucket(months.get(year), month, km);
      bucket(weekdays.get(year), weekday, km);
    } else {
      undated += 1;
    }

    const company = String(train.company || "").trim();
    if (company) add(operators, company, company, km);
    const stops = train.stops || [];
    const ridden = effectivelyRiddenStopIndexes(stops);
    if (ridden.length < 2) continue;
    const from = stops[ridden[0]].name || "";
    const to = stops[ridden[ridden.length - 1]].name || "";
    journeys.push({ id: train.id, name: train.number || train.id, from, to, km, minutes: minutes || 0 });
    if (!from || !to) continue;
    add(stations, from, from, km);
    add(stations, to, to, km);
    const endpoints = [from, to].sort((a, b) => a.localeCompare(b, "ja"));
    add(routes, endpoints.join("\u001f"), endpoints[0], km, endpoints[1]);
  }

  const ranked = (map) => [...map.values()].sort((a, b) =>
    b.count - a.count || b.km - a.km || a.name.localeCompare(b.name, "ja"));
  const longest = (key) => journeys.reduce((best, row) => !best || row[key] > best[key] ? row : best, null);
  const shortest = (key) => journeys.filter((row) => row[key] > 0)
    .reduce((best, row) => !best || row[key] < best[key] ? row : best, null);
  return {
    journeys: trains.length,
    totalKm,
    totalMinutes,
    timedJourneys,
    undated,
    years,
    months,
    weekdays,
    stations: ranked(stations),
    operators: ranked(operators),
    routes: ranked(routes),
    longestDistance: longest("km"),
    shortestDistance: shortest("km"),
    longestTime: longest("minutes"),
    shortestTime: shortest("minutes"),
  };
}
