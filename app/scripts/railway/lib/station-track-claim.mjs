/*
 * station-track-claim.mjs — decide WHICH OSM way a package line uses at a
 * place, and measure the drawn line against that way rather than against the
 * nearest rail of any kind.
 *
 * Why this exists (RAILWAY_MULTILINE_STATION_AUDIT_PROMPT.md 2.1): the standing
 * corridor audit measures every sample to the nearest ACTIVE rail way, with a
 * 50 m gate sustained over 150 m. Inside a station a dozen platform roads sit
 * 5-15 m apart, so a line drawn on the WRONG one is still within a few metres
 * of something and the gate can never fire. The only way to see that error is
 * to name the track the line is supposed to be on first.
 *
 * The claim is therefore an IDENTITY filter, never a distance ranking:
 * operator, then line name, then running-track qualifiers. Distance is used
 * only to measure, after the filter has decided what to measure against
 * ("不得按离站点最近认领" — the nearest way at a big station is usually a
 * crossover or a freight arrival road).
 */

// OSM writes the JR companies' legal names; the package uses the same, but a
// few operators differ in ways no normalisation can guess.
// Keys are the SPACE-STRIPPED form operatorForms() produces, so a full-width
// space in WILLER\u3000TRAINS does not hide the entry.
const OPERATOR_ALIASES = new Map([
  ["東京メトロ", ["東京地下鉄"]],
  ["東京地下鉄", ["東京メトロ"]],
  ["小田急箱根", ["箱根登山鉄道", "小田急箱根ホールディングス"]],
  ["ＪＲ東日本", ["東日本旅客鉄道"]],
  // Measured against the cache: the package files these under the brand while
  // OSM files them under the legal operator (or the other way round).
  ["OsakaMetro", ["大阪市高速電気軌道"]],
  ["大阪市高速電気軌道", ["OsakaMetro"]],
  ["大阪モノレール", ["大阪高速鉄道"]],
  ["一般社団法人札幌市交通事業振興公社", ["札幌市交通局", "札幌市"]],
  ["WILLERTRAINS", ["京都丹後鉄道", "北近畿タンゴ鉄道"]],
]);

/** Strip the decorations that separate a package line name from its OSM name. */
export function normaliseLineName(name) {
  return String(name || "")
    .replace(/\s+/gu, "")
    // 東北本線 / 中央本線 / 東海道本線 → 東北線 / 中央線 / 東海道線
    .replace(/本線$/u, "線")
    // 東京メトロ files its lines as "9号線千代田線"; OSM as "千代田線".
    .replace(/^\d+号線/u, "")
    // …and Osaka Metro as "1号線(御堂筋線)", which leaves a parenthesised name
    // behind. Without unwrapping it, 67 of the 105 unclaimable rows were that
    // one bracket.
    .replace(/^[（(]([^）)]+)[）)]$/u, "$1")
    .replace(/^JR|^ＪＲ/u, "");
}

function operatorForms(operator) {
  const base = String(operator || "").replace(/株式会社|\s+/gu, "");
  return [base, ...(OPERATOR_ALIASES.get(base) || [])].filter(Boolean);
}

function textMatches(candidate, forms) {
  const value = String(candidate || "").replace(/株式会社|\s+/gu, "");
  if (!value) return false;
  return forms.some((form) => form && (value.includes(form) || form.includes(value)));
}

/**
 * A predicate over index meta that answers "could this way be the line's own
 * running track here", plus how discriminating the answer is.
 *
 * `strength`:
 *   operator_and_name  both agree — the strongest claim the cache can support
 *   name               the name agrees, the operator tag is missing/different
 *   operator           the operator agrees, no named way in reach
 *   none               nothing identifies a way here; the caller must report
 *                      `undecidable`, never fall back to the nearest rail
 */
export function claimFilterFor(line) {
  const operators = operatorForms(line.operator);
  const name = normaliseLineName(line.name);
  const running = (meta) => meta.running;
  // A platform road at a terminus or a branch bay is routinely tagged
  // service=siding — 高岡's 城端線 platform is, and excluding it made the
  // claim jump to a running way 70 m away and report a defect that is not
  // there. A siding that CARRIES THE LINE'S NAME is that line's platform
  // track; yards and crossovers never are, and an unnamed siding cannot
  // identify itself, so both stay excluded.
  const namedPlatformRoad = (meta) =>
    meta.running || meta.service === "siding" || meta.service === "spur";
  // Equality after normalisation, NOT containment — and the operator prefix is
  // stripped first so both real spellings survive it:
  //   OSM 東京メトロ千代田線 − 東京メトロ → 千代田線 == 千代田線   (match)
  //   OSM 小田急箱根鉄道線   − 小田急箱根 → 鉄道線   == 鉄道線     (match)
  // while containment would have accepted 京浜東北線 for 東北線, handing the
  // 上野東京ライン 列車線 the 電車線's tracks — a wrong claim that measures
  // beautifully, because the two really do run side by side.
  // Platform roads are commonly tagged with a multi-value name —
  // 京王電鉄競馬場線;府中競馬正門前;1番線 — so every ";"-separated part is a
  // candidate spelling. Comparing the joined string made a terminus look
  // 180 m from its own metals when the platform road was 6 m away.
  const nameOk = (meta) => {
    if (!name || !meta.name) return false;
    for (const part of String(meta.name).split(/[;/]/u)) {
      let candidate = normaliseLineName(part);
      if (!candidate) continue;
      for (const form of operators)
        if (form && candidate.startsWith(form)) {
          candidate = normaliseLineName(candidate.slice(form.length));
          break;
        }
      if (candidate === name) return true;
    }
    return false;
  };
  const operatorOk = (meta) =>
    textMatches(meta.operatorJa, operators) || textMatches(meta.operator, operators);
  return {
    name,
    operators,
    levels: [
      {
        strength: "operator_and_name",
        accept: (m) => namedPlatformRoad(m) && operatorOk(m) && nameOk(m),
      },
      { strength: "name", accept: (m) => namedPlatformRoad(m) && nameOk(m) },
      { strength: "operator", accept: (m) => running(m) && operatorOk(m) },
    ],
  };
}

/**
 * Distance from `point` to the line's own claimed track.
 *
 * Tries the identity levels in order and stops at the first that finds
 * anything inside `radiusMeters`; a weaker level is only consulted because the
 * stronger one found NOTHING, never because it was further away.
 */
export function anyRunningTrackAt(point, index, radiusMeters = 25) {
  // Same rule as the claim filter: a NAMED siding is a platform road, and at a
  // shared station it is often the only rail near the dot. 佐世保's 松浦鉄道
  // platform stands among JR佐世保線 sidings; calling that dot "floating with
  // no rail within 25 m" was an artifact of excluding them.
  const found = index.within(
    point,
    radiusMeters,
    (meta) =>
      meta.running ||
      ((meta.service === "siding" || meta.service === "spur") && meta.name),
  );
  if (!found.size) return null;
  let best = null;
  for (const [meta, distance] of found)
    if (!best || distance < best.distance) best = { meta, distance };
  return best;
}

export function claimedTrackAt(point, filter, index, radiusMeters = 200) {
  for (const level of filter.levels) {
    const found = index.within(point, radiusMeters, level.accept);
    if (!found.size) continue;
    let best = null;
    for (const [meta, distance] of found)
      if (!best || distance < best.distance) best = { meta, distance };
    return {
      strength: level.strength,
      distance: best.distance,
      way: best.meta,
      wayIds: [...found.keys()].map((meta) => meta.id).sort((a, b) => a - b),
    };
  }
  return null;
}

/** Smallest angle between two headings, ignoring which way round they point. */
function axisDifference(a, b) {
  if (a == null || b == null) return null;
  const raw = Math.abs(((a - b + 540) % 360) - 180);
  return raw > 90 ? 180 - raw : raw;
}

/**
 * Which platform a line's trains use here.
 *
 * Ranked exactly as RAILWAY_MULTILINE_STATION_AUDIT_PROMPT.md 2.4 says, and in
 * that order — adjacency to the line's OWN claimed track first, then how well
 * the platform's long axis agrees with the running direction, and only then
 * distance. File order and "nearest platform" are never deciding fields: at
 * 東京 the nearest platform to a 東北新幹線 dot is a 東海道新幹線 island.
 *
 * `margin` is the gap between the winner and the runner-up. Under ~30 m the
 * two candidates are the two faces of one island (or two islands of one
 * group) and the cache cannot separate them — the caller must send that to
 * review rather than trusting the ranking.
 */
export function pickPlatform(point, bearings, claim, platformIndex, options = {}) {
  const radius = options.radiusMeters || 150;
  const adjacency = options.adjacencyMeters || 25;
  const found = platformIndex.within(point, radius);
  if (!found.size) return null;
  const candidates = [];
  for (const [meta, distance] of found) {
    const alignment =
      bearings && bearings.length
        ? Math.min(
            ...bearings
              .map((bearing) => axisDifference(meta.axis, bearing))
              .filter((value) => value != null),
            Infinity,
          )
        : null;
    // Adjacency is measured from the platform's own midpoint to the claimed
    // track, not from the station dot: the dot is what is under suspicion.
    const adjacent =
      claim && claim.trackDistanceAt
        ? claim.trackDistanceAt(meta.midpoint) <= adjacency
        : null;
    candidates.push({
      platform: meta,
      distance,
      alignmentDegrees: Number.isFinite(alignment) ? alignment : null,
      adjacentToClaimedTrack: adjacent,
    });
  }
  candidates.sort((a, b) => {
    const adjacencyRank = Number(b.adjacentToClaimedTrack === true) - Number(a.adjacentToClaimedTrack === true);
    if (adjacencyRank) return adjacencyRank;
    const aligned = (row) => (row.alignmentDegrees == null ? 90 : row.alignmentDegrees);
    const alignmentRank = aligned(a) - aligned(b);
    if (Math.abs(alignmentRank) > 15) return alignmentRank;
    return a.distance - b.distance;
  });
  const best = candidates[0];
  const runnerUp = candidates.find(
    (row) => row.platform.key !== best.platform.key && row.platform.midpoint,
  );
  const margin = runnerUp
    ? Math.hypot(
        (runnerUp.platform.midpoint[0] - best.platform.midpoint[0]) *
          111320 *
          Math.cos((best.platform.midpoint[1] * Math.PI) / 180),
        (runnerUp.platform.midpoint[1] - best.platform.midpoint[1]) * 111320,
      )
    : null;
  // Whether the runner-up would have changed the answer. Two faces of one
  // island sit metres apart and are BOTH adjacent to the same track, so the
  // pick between them cannot alter "is this dot on a platform its own line
  // serves" — measured, that is 47 of the 57 close calls. Only when the two
  // disagree does the margin actually matter.
  const decisionChanges =
    runnerUp != null &&
    runnerUp.adjacentToClaimedTrack !== best.adjacentToClaimedTrack;
  return {
    ...best,
    marginMeters: margin,
    candidates: candidates.length,
    decisionChanges,
  };
}

