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
  // tw — OSM files the New Taipei operator without the 大眾 the package uses,
  // and the two do not contain one another, so no suffix rule can bridge them.
  ["新北大眾捷運", ["新北捷運"]],
  ["新北捷運", ["新北大眾捷運"]],
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

// The company-form words that carry no identity. 株式会社 is Japan's; the
// Chinese ones are Taiwan's, where OSM routinely writes 高雄捷運公司 for the
// package's 高雄捷運股份有限公司 and 臺中捷運公司 for 臺中捷運股份有限公司 —
// neither contains the other, so containment alone cannot match them. No
// Japanese or Korean operator name contains these characters, so stripping
// them is inert outside tw/hk/mo.
const COMPANY_FORM = /株式会社|股份有限公司|有限公司|股份公司|公司|\s+/gu;

function operatorForms(operator) {
  const base = String(operator || "").replace(COMPANY_FORM, "");
  return [base, ...(OPERATOR_ALIASES.get(base) || [])].filter(Boolean);
}

function textMatches(candidate, forms) {
  const value = String(candidate || "").replace(COMPANY_FORM, "");
  if (!value) return false;
  return forms.some((form) => form && (value.includes(form) || form.includes(value)));
}

/**
 * A predicate over index meta that answers "could this way be the line's own
 * running track here", plus how discriminating the answer is.
 *
 * `strength`:
 *   operator_and_name  both agree — the strongest claim the cache can support
 *   name               the name agrees and the way names NO operator to
 *                      disagree with
 *   operator           the operator agrees, no named way in reach
 *   name_other_operator  only the name agrees, and the way says somebody else
 *                      runs it — last, because two railways can share a line
 *                      name
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
  // A name-only claim belongs to a way that says NOTHING about who runs it —
  // and there are thousands of those. A way that says outright that somebody
  // else runs it is a different, much weaker thing, because two railways can
  // share a line name: 東武鉄道 and JR East both run a 日光線 into 日光, 300 m
  // apart, and the normalisation that makes OSM's spellings comparable is
  // exactly what brings them together — "JR日光線" loses its JR and equals
  // 東武鉄道's 日光線, while 東武's own metals, filed as 東武日光線, keep the
  // brand prefix and do NOT. Ranked equal, the claim measured 東武日光 against
  // a JR East siding, called an N02 feature 0.2 m from its own line 80.7 m
  // adrift, and an override moved the dot onto JR日光駅's platform.
  //
  // It is still worth something, though, and dropping it outright cost eight
  // stations their claim: where two companies run over one railway, OSM tags
  // the owner and the package files the service — 神戸高速線's metals say
  // 神戸高速鉄道 while 阪神 and 阪急 both run them, and 亀山, 上越妙高, 児島 and
  // 関西空港 are all company boundaries where the way carries the neighbour's
  // name. So it goes LAST instead: a way the line's own operator runs is always
  // preferred, and a way named for the line under somebody else's name is
  // taken only when nothing else here identifies itself at all.
  const operatorDisowns = (meta) =>
    Boolean(meta.operatorJa || meta.operator) && !operatorOk(meta);
  return {
    name,
    operators,
    levels: [
      {
        strength: "operator_and_name",
        accept: (m) => namedPlatformRoad(m) && operatorOk(m) && nameOk(m),
      },
      {
        strength: "name",
        accept: (m) => namedPlatformRoad(m) && nameOk(m) && !operatorDisowns(m),
      },
      { strength: "operator", accept: (m) => running(m) && operatorOk(m) },
      {
        strength: "name_other_operator",
        accept: (m) => namedPlatformRoad(m) && nameOk(m),
      },
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

/** Metres between two [lon, lat] points, flat-earth over station distances. */
function metres(a, b) {
  return Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180),
    (a[1] - b[1]) * 111320,
  );
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
 *
 * `options.otherStations` are the line's OTHER stops, and they bound the
 * search: adjacency-first ranking is right about which track matters and says
 * nothing about which STATION a platform belongs to, so where the line's own
 * metals run past a stop that stands on somebody else's, the ranking will
 * happily reach down the line for a platform that is adjacent. 広島電鉄's
 * 宇品線 is the case. Both its northern termini — 紙屋町西 and 紙屋町東 — are
 * on the 本線's 相生通り metals, because the 宇品線 branches at the 紙屋町
 * crossing and has no platform of its own there; its own named track is the
 * wye curve 34 m away. So for 紙屋町西 the two platforms 11.3 m and 18.2 m from
 * the dot both measured 43.2 m from a 宇品線 way and lost, and the pick went
 * 148.4 m down 鯉城通り to way/929779365, which is 本通's northbound platform
 * (67 m from 本通's own dot, paired 56 m from the platform 本通 itself picks).
 * The margin gate could not catch it either: the runner-up was 本通's OTHER
 * platform, so the two agreed and `decisionChanges` was false.
 *
 * A platform that stands closer to another stop of the same line than to this
 * one is that stop's platform. It is a Voronoi test, so it cannot fire on the
 * genuine long moves this is for — 横浜's 相鉄本線 island is 234 m from the dot
 * and still nearer 横浜 than 平沼橋, a kilometre up the line.
 *
 * A candidate that says outright it serves a ROAD bus and no railway is thrown
 * out before any of that (`serves === "road"`, classified in
 * osm-basemap-cache.mjs). It has to be thrown out rather than ranked down,
 * because none of the three ranking fields can see the difference: 紙屋町東's
 * 宇品線 pick was 広電バス's 立町 shelter, 199 m away and named for the next
 * stop of a DIFFERENT line, and it beat the trams' own platforms on adjacency
 * because 相生通り carries 宇品線-named track past it, cleared the same-line
 * Voronoi test because 立町 is not a 宇品線 stop, and cleared the 25 m on-track
 * gate at 14.7 m. Nothing about it is nearly right; it is not a railway
 * platform at all. 91% of the index is that shape.
 *
 * A candidate that declares NOTHING (`serves === "unstated"`) is only ranked
 * below one that declares rail, never dropped — a bare
 * `public_transport=platform` way is how 都電荒川線's 熊野前, 札幌市電's
 * すすきの and JR京都駅's 0番のりば are all mapped. The demotion sits BELOW
 * adjacency on purpose: adjacency to the line's own claimed track is the
 * strongest evidence the cache holds (prompt 2.4), and a tag that a volunteer
 * did not type is not evidence against it.
 */
export function pickPlatform(point, bearings, claim, platformIndex, options = {}) {
  const radius = options.radiusMeters || 150;
  const adjacency = options.adjacencyMeters || 25;
  const otherStations = options.otherStations || [];
  const found = platformIndex.within(point, radius);
  if (!found.size) return null;
  const candidates = [];
  for (const [meta, distance] of found) {
    if (meta.serves === "road") continue;
    if (
      meta.midpoint &&
      otherStations.some((station) => metres(meta.midpoint, station) < distance)
    )
      continue;
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
    const declaresRail = (row) => Number(row.platform.serves === "rail");
    const serviceRank = declaresRail(b) - declaresRail(a);
    if (serviceRank) return serviceRank;
    const aligned = (row) => (row.alignmentDegrees == null ? 90 : row.alignmentDegrees);
    const alignmentRank = aligned(a) - aligned(b);
    if (Math.abs(alignmentRank) > 15) return alignmentRank;
    return a.distance - b.distance;
  });
  // Every candidate belonged to a neighbouring stop: this station has no
  // platform of its own in the cache, which is a "cannot tell", not a pick.
  if (!candidates.length) return null;
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

