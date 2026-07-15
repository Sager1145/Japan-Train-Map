// Parity test: OLD loader (legacy flat pkg, logic copied verbatim from git
// version of railmap.js) vs NEW loader (compact-v1, extracted live from
// ../public/railmap.js) must produce identical render-relevant output.
import fs from "fs";

const src = fs.readFileSync("../public/railmap.js", "utf8");
function extract(name) {
  const i = src.indexOf(name);
  if (i < 0) throw new Error("not found: " + name);
  const start = src.indexOf("{", i);
  let d = 0, j = start;
  for (;; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (d === 0) break; }
  }
  return src.slice(i, j + 1);
}
const prelude =
  'const DEFAULT_LINE_COLOR = "#7C8A82";\n' +
  'const RANK_MINZOOM = [3, 4, 5, 6, 7];\n' +
  'const STATION_DOT_GAP_PX = 22;\n' +
  'const STATION_LOD_K = (STATION_DOT_GAP_PX * 40075.017) / (256 * Math.cos((35 * Math.PI) / 180));\n' +
  'const STATION_MINZ_CAP = 14;\n' +
  extract("function minzForRank") + "\n" +
  extract("function stationMinzForLine") + "\n";

// NEW loader, extracted from the actual shipped file
const newLoaderSrc = prelude + extract("async function loadNetwork") + "\nreturn loadNetwork;";
const makeNewLoader = new Function("fetch", newLoaderSrc);

// OLD loader logic (verbatim from the pre-migration railmap.js)
function oldLoad(pkg, helpers) {
  const { minzForRank, stationMinzForLine, DEFAULT_LINE_COLOR } = helpers;
  const lineById = new Map(), colorByLine = new Map(), lineMinzByLine = new Map();
  for (const l of pkg.lines) {
    lineById.set(l.lineId, l);
    colorByLine.set(l.lineId, l.color || DEFAULT_LINE_COLOR);
    lineMinzByLine.set(l.lineId, minzForRank(l.rank));
  }
  const segFeatures = pkg.segments.map((seg) => ({
    type: "Feature", geometry: seg.geometry,
    properties: {
      segmentId: seg.segmentId, lineId: seg.lineId,
      color: colorByLine.get(seg.lineId) || DEFAULT_LINE_COLOR,
      minz: lineMinzByLine.get(seg.lineId) || 0,
    },
  }));
  const kmByLine = new Map();
  for (const s of pkg.segments) kmByLine.set(s.lineId, (kmByLine.get(s.lineId) || 0) + s.km);
  const dotMinzByLine = new Map(), terminiByLine = new Map();
  for (const l of pkg.lines) {
    const lineMinz = lineMinzByLine.get(l.lineId) || 0;
    const n = (l.stationOrder || []).length;
    dotMinzByLine.set(l.lineId, stationMinzForLine(lineMinz, kmByLine.get(l.lineId) || 0, n));
    if (!l.isLoop && n >= 2)
      terminiByLine.set(l.lineId, new Set([l.stationOrder[0], l.stationOrder[n - 1]]));
  }
  const stationById = new Map(), groupMembers = new Map();
  const stFeatures = pkg.stations.map((st) => {
    stationById.set(st.stationId, st);
    const gk = st.stationGroupId || "solo:" + st.stationId;
    let arr = groupMembers.get(gk);
    if (!arr) groupMembers.set(gk, (arr = []));
    arr.push(st);
    const term = terminiByLine.get(st.lineId);
    const minz = term && term.has(st.stationId)
      ? lineMinzByLine.get(st.lineId) || 0 : dotMinzByLine.get(st.lineId) || 0;
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [st.lon, st.lat] },
      properties: {
        stationId: st.stationId, lineId: st.lineId, name: st.name,
        nameRoma: st.nameRoma || "", stationGroupId: st.stationGroupId || "", minz,
      },
    };
  });
  return {
    version: pkg.version,
    segments: { type: "FeatureCollection", features: segFeatures },
    stations: { type: "FeatureCollection", features: stFeatures },
    lineById, stationById, groupMembers,
  };
}

const helpersSrc = prelude + "return { minzForRank, stationMinzForLine, DEFAULT_LINE_COLOR };";
const helpers = new Function(helpersSrc)();

const legacy = JSON.parse(fs.readFileSync("../public/rail/jp-2025.json.legacy.bak", "utf8"));
const compactRaw = fs.readFileSync("../public/rail/jp-2025.json", "utf8");
const fetchStub = async () => ({ ok: true, json: async () => JSON.parse(compactRaw) });

const oldNet = oldLoad(legacy, helpers);
const newNet = await makeNewLoader(fetchStub)();
if (!newNet) throw new Error("new loader returned null");

const J = (x) => JSON.stringify(x);
let fail = 0;
const eq = (label, a, b) => {
  if (J(a) !== J(b)) { fail++; console.log("MISMATCH", label); console.log(" old:", J(a).slice(0, 220)); console.log(" new:", J(b).slice(0, 220)); }
};

eq("segment count", oldNet.segments.features.length, newNet.segments.features.length);
eq("station count", oldNet.stations.features.length, newNet.stations.features.length);
// features may be globally ordered differently; compare keyed by id
const key = (fc, k) => new Map(fc.features.map((f) => [f.properties[k], f]));
const so = key(oldNet.segments, "segmentId"), sn = key(newNet.segments, "segmentId");
for (const [id, f] of so) eq("segment " + id, f, sn.get(id));
const to = key(oldNet.stations, "stationId"), tn = key(newNet.stations, "stationId");
for (const [id, f] of to) eq("station " + id, f, tn.get(id));
// also check global ordering (affects nothing visually, but report)
const orderSame =
  J(oldNet.segments.features.map((f) => f.properties.segmentId)) ===
  J(newNet.segments.features.map((f) => f.properties.segmentId)) &&
  J(oldNet.stations.features.map((f) => f.properties.stationId)) ===
  J(newNet.stations.features.map((f) => f.properties.stationId));
console.log("feature ordering identical:", orderSame);

// popup-relevant line fields
for (const [id, ol] of oldNet.lineById) {
  const nl = newNet.lineById.get(id);
  if (!nl) { fail++; console.log("missing line", id); continue; }
  for (const k of ["lineId","name","operator","isHSR","isLoop","rank","color","stationOrder"])
    eq("line."+k+" "+id, ol[k], nl[k]);
  eq("line.logo "+id, ol.logo || null, nl.logo || null);
  eq("line.nameRoma "+id, ol.nameRoma, nl.nameRoma);
}
eq("lineById size", oldNet.lineById.size, newNet.lineById.size);
// stationById + groupMembers
for (const [id, os] of oldNet.stationById) {
  const ns = newNet.stationById.get(id);
  if (!ns) { fail++; console.log("missing station", id); continue; }
  for (const k of ["stationId","name","lineId","seq","lon","lat","stationGroupId","nameRoma","romaSource"])
    eq("st."+k+" "+id, os[k], ns[k]);
}
eq("stationById size", oldNet.stationById.size, newNet.stationById.size);
eq("groupMembers keys", [...oldNet.groupMembers.keys()].sort(), [...newNet.groupMembers.keys()].sort());
for (const [gk, arr] of oldNet.groupMembers)
  eq("group "+gk, arr.map((s)=>s.stationId).sort(), (newNet.groupMembers.get(gk)||[]).map((s)=>s.stationId).sort());
eq("version", oldNet.version, newNet.version);

console.log(fail === 0 ? "PARITY OK — all render/popup outputs identical" : "FAILURES: " + fail);
process.exit(fail === 0 ? 0 : 1);
