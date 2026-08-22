// Loader for rail.db — reads the published railway data and writes the
// relational mirror described by schema.sql. See build-rail-database.mjs for
// the CLI; everything that knows a file layout lives here.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, "..", "..", "..");
const SCHEMA_PATH = path.join(HERE, "schema.sql");

const AppCore = require(path.join(APP_DIR, "shared", "app-core.js"));
const normalizeStationName = AppCore.normalizeStationName;

// (code, slug) in the order the database should list them.
const COUNTRIES = [
  { code: "JP", slug: "jp", readingsFile: "station-readings.json" },
  { code: "TW", slug: "tw", readingsFile: "station-readings-tw.json" },
  { code: "HK", slug: "hk", readingsFile: "station-readings-hk.json" },
  { code: "KR", slug: "kr", readingsFile: "station-readings-kr.json" },
  { code: "MO", slug: "mo", readingsFile: "station-readings-mo.json" },
];

// N02_002 事業者種別. The four non-Japanese builders assign the same code
// space, which is why the mileage statistics stay country-generic.
const INSTITUTION_TYPES = [
  ["1", "JR新幹線", "高速鐵路"],
  ["2", "JR在来線", "傳統幹線"],
  ["3", "公営鉄道", "公營鐵路"],
  ["4", "民営鉄道", "民營鐵路"],
  ["5", "第三セクター", "第三部門"],
];

// N02_001 鉄道区分. '*' = the code space N02 itself defines; a country row is
// a code this project assigns beyond it.
const RAILWAY_CLASSES = [
  ["11", "*", "普通鉄道JR", null],
  ["12", "*", "普通鉄道", null],
  ["13", "*", "鋼索鉄道", null],
  ["14", "*", "懸垂式鉄道", null],
  ["15", "*", "跨座式鉄道", null],
  ["16", "*", "案内軌条式鉄道", null],
  ["17", "*", "無軌条鉄道", null],
  ["21", "*", "軌道", "Tram and light rail licensed under 軌道法."],
  ["22", "*", "懸垂式モノレール", null],
  ["23", "*", "跨座式モノレール", null],
  ["24", "*", "案内軌条式", null],
  ["25", "*", "浮上式", null],
  [
    "31",
    "TW",
    "林業鐵路",
    "Assigned by the Taiwan builder to the Alishan Forest Railway so a mountain line does not land in the 捷運 statistics bucket.",
  ],
  [
    "31",
    "KR",
    "모노레일·자기부상",
    "Assigned by the Korea builder to monorail and maglev lines.",
  ],
];

const ROMA_SOURCES = [
  [1, "osm"],
  [2, "wikidata"],
  [3, "official"],
];

const STRUCTURE_KINDS = [
  [1, "tunnel"],
  [2, "bridge"],
];

// rail-network.js SERVICE_STATUS_CODES / SUSPENDED_SERVICE_CODES. Code 4 is
// deliberately not "suspended": the trains run, two stations are passed.
const SERVICE_STATUSES = [
  [1, "service_suspended", 1],
  [2, "substitute_bus", 1],
  [3, "no_passenger_train", 1],
  [4, "all_trains_pass", 0],
];

const NAME_FIELDS = [
  ["name", null, "The station name as the reading table states it (the base name)."],
  ["kana", "ja-Hira", "Hiragana reading."],
  ["katakana", "ja-Kana", "Katakana reading."],
  ["romaji", "ja-Latn", "Hepburn romanization."],
  ["zh_Hant", "zh-Hant", "Traditional Chinese name."],
  ["zh_Hans", "zh-Hans", "Simplified Chinese name."],
  ["ja", "ja", "Japanese name (non-Japanese networks only)."],
  ["en", "en", "Official English name."],
];
const NAME_FIELD_KEYS = NAME_FIELDS.map(([field]) => field);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * The operator label and badge rules, lifted out of the browser module that
 * owns them so this database cannot drift into a second copy.
 *
 * public/app-operator-branding.js is a classic script whose dictionaries stay
 * inside its IIFE, so the marker below is widened to hand them back. It is an
 * EXACT-TEXT contract on purpose: if the module's export list is reworded this
 * throws instead of silently loading an empty alias table.
 */
export function loadBranding() {
  const file = path.join(APP_DIR, "public", "app-operator-branding.js");
  const source = fs.readFileSync(file, "utf8");
  const marker = "  return Object.freeze({\n    companyLabel,";
  if (!source.includes(marker)) {
    throw new Error(
      `app-operator-branding.js no longer exposes its tables at the expected marker; update ${path.relative(APP_DIR, path.join(HERE, "load.mjs"))}`,
    );
  }
  const tables = [
    "COMPANY_LABELS",
    "TAIWAN_COMPANY_LABELS",
    "HONG_KONG_COMPANY_LABELS",
    "MACAO_COMPANY_LABELS",
    "OPERATOR_LOGOS",
    "JAPAN_OPERATOR_LOGOS",
    "JAPAN_OPERATOR_BADGE_OVERRIDES",
    "JAPAN_PACKAGE_OPERATOR_LOGOS",
    "LINE_LOGOS",
  ];
  const widened = source.replace(
    marker,
    `  return Object.freeze({\n    __tables: { ${tables.join(", ")} },\n    companyLabel,`,
  );
  const context = { window: {}, globalThis: undefined };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(widened, context, { filename: file });
  const branding = context.window.RailOperatorBranding;
  if (!branding || !branding.__tables) {
    throw new Error("app-operator-branding.js did not publish RailOperatorBranding");
  }
  return branding;
}

/** Web path of a package badge, matching rail-network.js's own rule. */
function packageLogoPath(lineId) {
  return `/rail/logos/${lineId.replace(/(?:-p?\d+)+$/, "")}.png`;
}

function assetFile(webPath) {
  return path.join(APP_DIR, "public", webPath.replace(/^\//, ""));
}

/**
 * The source artwork one manifest row describes, as a web path.
 *
 * A manifest names its asset by bare filename — `q1007890.svg` — because it
 * sits in the directory it describes. That is unjoinable to anything: the file
 * is `/rail/operator-logos/jp/q1007890.svg` everywhere else in this database.
 * Resolving it here is what lets a badge on screen be traced to the Wikidata
 * entity and licence it came from.
 */
function manifestAssetPath(manifest, row) {
  return row.asset ? `/rail/operator-logos/${manifest}/${row.asset}` : null;
}

/** Every source path the manifests name, deduplicated. */
function manifestAssetPaths(sources) {
  const paths = new Map();
  for (const [manifest, rows] of sources.logoManifests)
    for (const row of rows) {
      const webPath = manifestAssetPath(manifest, row);
      if (webPath) paths.set(webPath, webPath);
    }
  return paths;
}

/** Majority vote over a Map-of-counts, ties broken by first insertion. */
function majority(counts) {
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function countIn(map, key) {
  let counts = map.get(key);
  if (!counts) {
    counts = new Map();
    map.set(key, counts);
  }
  return counts;
}

function bump(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

/**
 * Read every published file this database mirrors. Returns the parsed shapes
 * keyed by country slug so the writer below never touches the filesystem.
 */
export function readSources() {
  const railDir = path.join(APP_DIR, "public", "rail");
  const dataDir = path.join(APP_DIR, "data");
  const byCountry = new Map();
  for (const country of COUNTRIES) {
    const packageFile = `${country.slug}-2025.json`;
    const sectionsFile =
      country.slug === "jp" ? "rail-sections.json" : `rail-sections-${country.slug}.json`;
    const stationsFile =
      country.slug === "jp" ? "stations.json" : `stations-${country.slug}.json`;
    const sourcesDoc = `${country.slug}-2025.sources.md`;
    byCountry.set(country.slug, {
      ...country,
      packageFile,
      sourcesDoc: fs.existsSync(path.join(railDir, sourcesDoc)) ? sourcesDoc : null,
      pkg: readJson(path.join(railDir, packageFile)),
      readings: readJson(path.join(dataDir, country.readingsFile)),
      sections: readJson(path.join(dataDir, sectionsFile)).features,
      stations: readJson(path.join(dataDir, stationsFile)).features,
      sectionsFile,
      stationsFile,
    });
  }
  return {
    byCountry,
    logoCredits: readJson(path.join(railDir, "logo-credits.json")),
    logoManifests: [
      ["jp", path.join(railDir, "operator-logos", "jp", "manifest.json")],
      ["jp-badges", path.join(railDir, "operator-logos", "jp-badges", "manifest.json")],
    ]
      .filter(([, file]) => fs.existsSync(file))
      .map(([name, file]) => [name, readJson(file)]),
    branding: loadBranding(),
  };
}

/** Normalize one source-section feature to the neutral property names. */
function sectionProperties(properties) {
  return {
    lineName: properties.N02_003 ?? properties.line_name ?? "",
    operator: properties.N02_004 ?? properties.operator ?? "",
    railwayClass: properties.N02_001 ?? properties.railway_class_code ?? "",
    institutionType: properties.N02_002 ?? properties.institution_type_code ?? "",
  };
}

/** Normalize one source-station feature to the neutral property names. */
function stationProperties(properties) {
  return {
    ...sectionProperties(properties),
    name: properties.N02_005 ?? properties.station_name ?? "",
    stationCode: properties.N02_005c ?? properties.n02_station_code ?? "",
    groupCode: properties.N02_005g ?? properties.n02_group_code ?? "",
    displayPoint: properties.display_point ?? null,
  };
}

/**
 * Build the database at `outFile`. `geometry: false` skips the three vertex
 * tables, which is the difference between a ~45 MB file and a ~21 MB one.
 */
export function buildDatabase({ outFile, geometry = true, log = () => {} } = {}) {
  const sources = readSources();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.rmSync(outFile, { force: true });
  fs.rmSync(`${outFile}-journal`, { force: true });

  const db = new DatabaseSync(outFile);
  db.exec("PRAGMA journal_mode = OFF");
  db.exec("PRAGMA synchronous = OFF");
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

  const insert = (sql) => db.prepare(sql);
  const counts = {};
  const tally = (table, n = 1) => {
    counts[table] = (counts[table] || 0) + n;
  };

  db.exec("BEGIN");

  // ── vocabularies ──
  const insertInstitution = insert(
    "INSERT INTO institution_type (code, label_ja, label_zh) VALUES (?, ?, ?)",
  );
  for (const row of INSTITUTION_TYPES) insertInstitution.run(...row);
  const insertClass = insert(
    "INSERT INTO railway_class (code, country_code, label, note) VALUES (?, ?, ?, ?)",
  );
  for (const row of RAILWAY_CLASSES) insertClass.run(...row);
  const insertRoma = insert("INSERT INTO roma_source (code, name) VALUES (?, ?)");
  for (const row of ROMA_SOURCES) insertRoma.run(...row);
  const insertStructureKind = insert(
    "INSERT INTO structure_kind (code, name) VALUES (?, ?)",
  );
  for (const row of STRUCTURE_KINDS) insertStructureKind.run(...row);
  const insertServiceStatus = insert(
    "INSERT INTO service_status (code, name, suspended) VALUES (?, ?, ?)",
  );
  for (const row of SERVICE_STATUSES) insertServiceStatus.run(...row);
  const insertNameField = insert(
    "INSERT INTO name_field (field, bcp47, description) VALUES (?, ?, ?)",
  );
  for (const row of NAME_FIELDS) insertNameField.run(...row);

  // ── operator aliases (the four branding dictionaries) ──
  const { __tables: brandingTables } = sources.branding;
  const insertAlias = insert(
    "INSERT OR IGNORE INTO operator_alias (scope, alias, label) VALUES (?, ?, ?)",
  );
  for (const [scope, table] of [
    ["JP", brandingTables.COMPANY_LABELS],
    ["TW", brandingTables.TAIWAN_COMPANY_LABELS],
    ["HK", brandingTables.HONG_KONG_COMPANY_LABELS],
    ["MO", brandingTables.MACAO_COMPANY_LABELS],
  ]) {
    for (const [alias, label] of Object.entries(table)) {
      insertAlias.run(scope, alias, label);
      tally("operator_alias");
    }
  }

  // ── prepared statements for the bulk tables ──
  const insertCountry = insert(`INSERT INTO country
    (code, slug, package_file, package_format, package_version, package_generated_at,
     crs, official_only, license, authority, method, sources_doc, readings_file,
     readings_revision, readings_package_version, line_count, station_count,
     interval_count, vertex_count, length_km)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertLanguage = insert(
    "INSERT OR IGNORE INTO country_language (country_code, ord, lang) VALUES (?, ?, ?)",
  );
  const insertDataSource = insert(
    "INSERT INTO data_source (country_code, category, field, value) VALUES (?, ?, ?, ?)",
  );
  const insertOperator = insert(`INSERT INTO operator
    (country_code, name, short_name, display_label, logo_path, line_count)
    VALUES (?,?,?,?,?,?)`);
  const insertLine = insert(`INSERT INTO line
    (id, country_code, operator_id, name, name_norm, name_roma, line_code, rank, kind,
     color, color_dark, color_reference, color_source, color_policy, label_policy,
     railway_identity, railway_class_code, institution_type_code, class_source,
     is_hsr, is_loop, service_status, station_count, interval_count, vertex_count,
     length_km, logo_asset, badge_path, badge_dark_matte)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertStation = insert(`INSERT INTO station
    (country_code, code, name, name_norm, name_roma, lon, lat, line_count, name_variant_count)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertLineStation = insert(`INSERT INTO line_station
    (line_id, seq, station_id, name, name_roma, roma_source, lon, lat, measure_m, is_terminal)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertInterval = insert(`INSERT INTO "interval"
    (line_id, seq, from_station_id, to_station_id, length_km, start_m, end_m,
     shares_start_vertex, vertex_count)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertIntervalVertex = insert(
    "INSERT INTO interval_vertex (interval_id, seq, lon, lat) VALUES (?, ?, ?, ?)",
  );
  const insertStructure = insert(`INSERT INTO line_structure
    (line_id, start_m, end_m, kind_code, layer) VALUES (?,?,?,?,?)`);
  const insertServiceSpan = insert(`INSERT INTO line_service_span
    (line_id, from_seq, to_seq, status_code) VALUES (?,?,?,?)`);
  const insertAlignment = insert(`INSERT INTO line_alignment
    (line_id, alignment_of, role, direction, source, split_source) VALUES (?,?,?,?,?,?)`);
  const insertAlignmentPair = insert(`INSERT INTO line_alignment_pair
    (line_id, with_line_id, from_station, to_station, direction, source)
    VALUES (?,?,?,?,?,?)`);
  const insertExtraSegment = insert(`INSERT INTO line_extra_segment
    (line_id, from_seq, to_seq, status, evidence) VALUES (?,?,?,?,?)`);
  const insertReversalTail = insert(
    "INSERT INTO line_reversal_tail (line_id, seq, lon, lat) VALUES (?, ?, ?, ?)",
  );
  const insertLane = insert(`INSERT INTO lane
    (country_code, line_id, part_index, from_m, to_m, lane) VALUES (?,?,?,?,?,?)`);
  const insertStationName = insert(`INSERT OR IGNORE INTO station_name
    (country_code, key_type, key, key_norm, field, value) VALUES (?,?,?,?,?,?)`);
  const insertLineStationName = insert(`INSERT INTO line_station_name
    (line_id, seq, field, value, source) VALUES (?,?,?,?,?)`);
  const insertSection = insert(`INSERT INTO source_section
    (country_code, ord, line_name, operator, railway_class_code, institution_type_code,
     vertex_count) VALUES (?,?,?,?,?,?,?)`);
  const insertSectionVertex = insert(
    "INSERT INTO source_section_vertex (section_id, seq, lon, lat) VALUES (?, ?, ?, ?)",
  );
  const insertSourceStation = insert(`INSERT INTO source_station
    (country_code, ord, station_code, group_code, station_id, name, line_name, operator,
     railway_class_code, institution_type_code, display_lon, display_lat, vertex_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertSourceStationVertex = insert(
    "INSERT INTO source_station_vertex (source_station_id, seq, lon, lat) VALUES (?, ?, ?, ?)",
  );

  const stationIdByKey = new Map(); // `${code}␟${stationCode}` -> station.id

  for (const country of sources.byCountry.values()) {
    const { pkg, code, slug } = country;
    log(`  ${code}: ${pkg.lines.length} lines`);

    // ── the country's own source-section / source-station layer first: the
    //    line classification codes below are joined out of it ──
    const classByNameOperator = new Map();
    const classByName = new Map();
    for (const feature of country.sections) {
      const p = sectionProperties(feature.properties);
      const value = `${p.railwayClass}␟${p.institutionType}`;
      bump(countIn(classByNameOperator, `${p.lineName}␟${p.operator}`), value);
      bump(countIn(classByName, p.lineName), value);
    }
    const classByGroupCode = new Map();
    for (const feature of country.stations) {
      const p = stationProperties(feature.properties);
      bump(
        countIn(classByGroupCode, p.groupCode),
        `${p.railwayClass}␟${p.institutionType}`,
      );
    }

    // Totals the country row states, walked once before anything references
    // it: `country` is the parent of every table written below.
    const readings = country.readings || {};
    const stationCodes = new Set();
    let countryVertices = 0;
    let countryLengthKm = 0;
    let countryIntervals = 0;
    for (const line of pkg.lines) {
      for (const row of line.stations) stationCodes.add(row[0]);
      countryIntervals += line.segments.length;
      for (const row of line.segments) {
        countryLengthKm += row[0];
        countryVertices += row[2].length;
      }
    }

    // ── the country row and its provenance ──
    const geometrySource = pkg.geometrySource || {};
    insertCountry.run(
      code,
      slug,
      `public/rail/${country.packageFile}`,
      pkg.format,
      pkg.version,
      pkg.generatedAt ?? null,
      pkg.crs ?? null,
      geometrySource.officialOnly ?? null,
      geometrySource.license ?? null,
      geometrySource.authority ?? null,
      geometrySource.method ?? null,
      country.sourcesDoc ? `public/rail/${country.sourcesDoc}` : null,
      `data/${country.readingsFile}`,
      readings.officialRevision ?? null,
      readings.packageVersion ?? null,
      pkg.lines.length,
      stationCodes.size,
      countryIntervals,
      countryVertices,
      countryLengthKm,
    );
    tally("country");

    (readings.languages || []).forEach((lang, index) => {
      insertLanguage.run(code, index, lang);
      tally("country_language");
    });

    for (const [field, value] of Object.entries(geometrySource)) {
      if (field === "providers") {
        for (const provider of value) {
          insertDataSource.run(code, "geometry_provider", null, provider);
          tally("data_source");
        }
        continue;
      }
      insertDataSource.run(
        code,
        "geometry",
        field,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
      tally("data_source");
    }
    for (const [field, value] of Object.entries(pkg.attributeSources || {})) {
      insertDataSource.run(
        code,
        "attribute",
        field,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
      tally("data_source");
    }
    for (const source of readings.sources || []) {
      insertDataSource.run(code, "reading", null, source);
      tally("data_source");
    }

    // ── operators ──
    const linesByOperator = new Map();
    for (const line of pkg.lines) {
      const list = linesByOperator.get(line.operator) || [];
      list.push(line);
      linesByOperator.set(line.operator, list);
    }
    const operatorIdByName = new Map();
    for (const [name, lines] of linesByOperator) {
      const shortName = lines.find((line) => line.operatorShort)?.operatorShort ?? null;
      const result = insertOperator.run(
        code,
        name,
        shortName,
        sources.branding.companyLabel(name),
        sources.branding.operatorLogo(name),
        lines.length,
      );
      operatorIdByName.set(name, Number(result.lastInsertRowid));
      tally("operator");
    }

    // ── stations (deduplicated by package group code) ──
    const stationAgg = new Map();
    for (const line of pkg.lines) {
      for (const row of line.stations) {
        let agg = stationAgg.get(row[0]);
        if (!agg) {
          agg = { names: new Map(), roma: null, lon: 0, lat: 0, n: 0 };
          stationAgg.set(row[0], agg);
        }
        bump(agg.names, row[1]);
        if (!agg.roma && row[4]) agg.roma = row[4];
        agg.lon += row[2];
        agg.lat += row[3];
        agg.n += 1;
      }
    }
    for (const [stationCode, agg] of stationAgg) {
      const name = majority(agg.names);
      const result = insertStation.run(
        code,
        stationCode,
        name,
        normalizeStationName(name),
        agg.roma,
        agg.lon / agg.n,
        agg.lat / agg.n,
        agg.n,
        agg.names.size,
      );
      stationIdByKey.set(
        `${code}␟${stationCode}`,
        Number(result.lastInsertRowid),
      );
      tally("station");
    }

    // ── the reading table, mirrored then resolved ──
    const readingByCode = readings.byCode || {};
    const readingByNameNorm = new Map();
    for (const [rawKey, entry] of Object.entries(readings.byName || {})) {
      readingByNameNorm.set(normalizeStationName(rawKey), entry);
    }
    const japanKeyedByCode = slug === "jp";
    for (const [rawKey, entry] of Object.entries(readingByCode)) {
      const keyType = japanKeyedByCode ? "code" : "line_station";
      for (const field of NAME_FIELD_KEYS) {
        const value = entry[field];
        if (!value) continue;
        insertStationName.run(
          code,
          keyType,
          rawKey,
          normalizeStationName(rawKey),
          field,
          value,
        );
        tally("station_name");
      }
    }
    for (const [rawKey, entry] of Object.entries(readings.byName || {})) {
      for (const field of NAME_FIELD_KEYS) {
        const value = entry[field];
        if (!value) continue;
        insertStationName.run(
          code,
          "name",
          rawKey,
          normalizeStationName(rawKey),
          field,
          value,
        );
        tally("station_name");
      }
    }

    // ── lines, their stations, their intervals ──
    for (const line of pkg.lines) {
      const stations = line.stations;
      const segments = line.segments;
      const lengthKm = segments.reduce((sum, row) => sum + row[0], 0);
      const vertexCount = segments.reduce((sum, row) => sum + row[2].length, 0);

      const nameOperatorKey = `${line.name}␟${line.operator}`;
      let classValue = null;
      let classSource = null;
      if (classByNameOperator.has(nameOperatorKey)) {
        classValue = majority(classByNameOperator.get(nameOperatorKey));
        classSource = "section:name+operator";
      } else if (classByName.has(line.name)) {
        classValue = majority(classByName.get(line.name));
        classSource = "section:name";
      } else {
        const counts = new Map();
        for (const row of stations) {
          const perStation = classByGroupCode.get(row[0]);
          if (!perStation) continue;
          for (const [value, n] of perStation) counts.set(value, (counts.get(value) || 0) + n);
        }
        if (counts.size) {
          classValue = majority(counts);
          classSource = "station:group";
        }
      }
      const [railwayClass, institutionType] = classValue
        ? classValue.split("␟")
        : [null, null];

      const logoAsset = line.logo ? packageLogoPath(line.id) : null;
      const badgePath = sources.branding.logoForLine({
        lineId: line.id,
        id: line.id,
        operator: line.operator,
        logo: logoAsset,
      });

      insertLine.run(
        line.id,
        code,
        operatorIdByName.get(line.operator),
        line.name,
        line.nameNorm ?? null,
        line.nameRoma ?? null,
        line.lineCode ?? null,
        line.rank,
        line.kind ?? null,
        line.color,
        line.colorDark ?? null,
        line.colorReference ?? null,
        line.colorSource ?? null,
        line.colorPolicy ?? null,
        line.labelPolicy ?? null,
        line.railwayIdentity ?? null,
        railwayClass,
        institutionType,
        classSource,
        line.isHSR ? 1 : 0,
        line.isLoop ? 1 : 0,
        line.serviceStatus ?? null,
        stations.length,
        segments.length,
        vertexCount,
        lengthKm,
        logoAsset,
        badgePath,
        sources.branding.logoNeedsDarkMatte(badgePath) ? 1 : 0,
      );
      tally("line");

      // Station measures accumulate the interval lengths that precede them.
      let measureM = 0;
      const stationIds = stations.map((row) => stationIdByKey.get(`${code}␟${row[0]}`));
      stations.forEach((row, index) => {
        insertLineStation.run(
          line.id,
          index,
          stationIds[index],
          row[1],
          row.length > 4 ? row[4] || null : null,
          row.length > 5 ? row[5] ?? null : null,
          row[2],
          row[3],
          measureM,
          !line.isLoop && (index === 0 || index === stations.length - 1) ? 1 : 0,
        );
        tally("line_station");
        if (index < segments.length) measureM += segments[index][0] * 1000;

        // Resolve this line-station's names through the frontend's own order.
        const lineStationKey = `${line.id}:${row[0]}`;
        let entry = readingByCode[row[0]];
        let source = "readings:code";
        if (!entry) {
          entry = readingByCode[lineStationKey];
          source = "readings:line_station";
        }
        if (!entry) {
          entry = readingByNameNorm.get(normalizeStationName(row[1]));
          source = "readings:name";
        }
        const written = new Set();
        if (entry) {
          for (const field of NAME_FIELD_KEYS) {
            const value = entry[field];
            if (!value) continue;
            insertLineStationName.run(line.id, index, field, value, source);
            written.add(field);
            tally("line_station_name");
          }
        }
        // Japan's reading table only covers the stations the itineraries visit,
        // but every package station row carries a romanization of its own.
        if (!written.has("romaji") && row.length > 4 && row[4]) {
          insertLineStationName.run(line.id, index, "romaji", row[4], "package");
          tally("line_station_name");
        }
      });

      let startM = 0;
      segments.forEach((row, index) => {
        const endM = startM + row[0] * 1000;
        const result = insertInterval.run(
          line.id,
          index,
          stationIds[index],
          stationIds[(index + 1) % stations.length],
          row[0],
          startM,
          endM,
          row[1] ? 1 : 0,
          row[2].length,
        );
        tally("interval");
        if (geometry) {
          const intervalId = Number(result.lastInsertRowid);
          row[2].forEach((coordinate, vertexIndex) => {
            insertIntervalVertex.run(
              intervalId,
              vertexIndex,
              coordinate[0],
              coordinate[1],
            );
          });
          tally("interval_vertex", row[2].length);
        }
        startM = endM;
      });

      for (const row of line.structure || []) {
        insertStructure.run(line.id, row[0], row[1], row[2], row[3]);
        tally("line_structure");
      }
      for (const row of line.serviceSpans || []) {
        insertServiceSpan.run(line.id, row[0], row[1], row[2]);
        tally("line_service_span");
      }
      if (line.alignmentOf || line.alignmentRole || line.alignmentDirection) {
        insertAlignment.run(
          line.id,
          line.alignmentOf ?? null,
          line.alignmentRole ?? null,
          line.alignmentDirection ?? null,
          line.alignmentSource ?? null,
          line.alignmentSplitSource ?? null,
        );
        tally("line_alignment");
      }
      for (const pair of line.alignmentPairs || []) {
        insertAlignmentPair.run(
          line.id,
          pair.with,
          pair.from ?? null,
          pair.to ?? null,
          pair.direction ?? null,
          pair.source ?? null,
        );
        tally("line_alignment_pair");
      }
      for (const extra of line.extraSegments || []) {
        insertExtraSegment.run(
          line.id,
          extra.from,
          extra.to,
          extra.status ?? null,
          extra.evidence ?? null,
        );
        tally("line_extra_segment");
      }
      (line.reversalTails || []).forEach((point, index) => {
        insertReversalTail.run(line.id, index, point[0], point[1]);
        tally("line_reversal_tail");
      });
    }

    for (const row of pkg.lanes || []) {
      insertLane.run(code, row[0], row[1], row[2], row[3], row[4]);
      tally("lane");
    }

    // ── the solver's source layer ──
    country.sections.forEach((feature, index) => {
      const p = sectionProperties(feature.properties);
      const coordinates = feature.geometry?.coordinates || [];
      const result = insertSection.run(
        code,
        index,
        p.lineName,
        p.operator,
        p.railwayClass,
        p.institutionType,
        coordinates.length,
      );
      tally("source_section");
      if (geometry) {
        const sectionId = Number(result.lastInsertRowid);
        coordinates.forEach((coordinate, vertexIndex) => {
          insertSectionVertex.run(sectionId, vertexIndex, coordinate[0], coordinate[1]);
        });
        tally("source_section_vertex", coordinates.length);
      }
    });

    country.stations.forEach((feature, index) => {
      const p = stationProperties(feature.properties);
      const coordinates = feature.geometry?.coordinates || [];
      const result = insertSourceStation.run(
        code,
        index,
        p.stationCode,
        p.groupCode,
        stationIdByKey.get(`${code}␟${p.groupCode}`) ?? null,
        p.name,
        p.lineName,
        p.operator,
        p.railwayClass,
        p.institutionType,
        p.displayPoint ? p.displayPoint[0] : null,
        p.displayPoint ? p.displayPoint[1] : null,
        coordinates.length,
      );
      tally("source_station");
      if (geometry) {
        const sourceStationId = Number(result.lastInsertRowid);
        coordinates.forEach((coordinate, vertexIndex) => {
          insertSourceStationVertex.run(
            sourceStationId,
            vertexIndex,
            coordinate[0],
            coordinate[1],
          );
        });
        tally("source_station_vertex", coordinates.length);
      }
    });

  }

  // ── badge assets ──
  const insertCredit = insert(
    "INSERT OR IGNORE INTO logo_credit (line_id, source_url, license) VALUES (?, ?, ?)",
  );
  for (const [lineId, credit] of Object.entries(sources.logoCredits)) {
    insertCredit.run(lineId, credit.src ?? null, credit.license ?? null);
    tally("logo_credit");
  }
  // Every badge path any row points at, checked against the shipped file.
  const insertAssetRow = insert(
    "INSERT OR IGNORE INTO logo_asset (path, kind, file_exists, byte_size) VALUES (?, ?, ?, ?)",
  );
  const assetKinds = new Map();
  for (const row of db.prepare("SELECT logo_asset FROM line WHERE logo_asset IS NOT NULL").all())
    assetKinds.set(row.logo_asset, "line");
  for (const row of db.prepare("SELECT logo_path FROM operator WHERE logo_path IS NOT NULL").all())
    if (!assetKinds.has(row.logo_path)) assetKinds.set(row.logo_path, "operator");
  for (const row of db.prepare("SELECT badge_path FROM line WHERE badge_path IS NOT NULL").all())
    if (!assetKinds.has(row.badge_path)) assetKinds.set(row.badge_path, "badge");
  // Last, so a file that is ALSO drawn keeps the kind that says it is drawn.
  // `source` means only "nothing on the site asks for this one".
  for (const webPath of manifestAssetPaths(sources).values())
    if (!assetKinds.has(webPath)) assetKinds.set(webPath, "source");
  for (const [webPath, kind] of assetKinds) {
    let exists = 0;
    let size = null;
    try {
      size = fs.statSync(assetFile(webPath)).size;
      exists = 1;
    } catch {
      exists = 0;
    }
    insertAssetRow.run(webPath, kind, exists, size);
    tally("logo_asset");
  }

  const insertManifest = insert(`INSERT INTO operator_logo_manifest
    (manifest, operator, lines_without_badge, article_title, entity_id, logo_file,
     asset, asset_path, source_type, source_page, license, license_url, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [manifest, rows] of sources.logoManifests) {
    for (const row of rows) {
      const assetPath = manifestAssetPath(manifest, row);
      insertManifest.run(
        manifest,
        row.operator,
        row.linesWithoutBadge ?? null,
        row.articleTitle ?? null,
        row.entityId ?? null,
        row.logoFile ?? null,
        row.asset ?? null,
        assetPath,
        row.sourceType ?? null,
        row.sourcePage ?? null,
        row.license ?? null,
        row.licenseUrl ?? null,
        row.status ?? null,
      );
      tally("operator_logo_manifest");
    }
  }

  const insertMeta = insert("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  insertMeta.run("schema_version", "1");
  insertMeta.run("generator", "scripts/build/build-rail-database.mjs");
  insertMeta.run("generated_at", new Date().toISOString());
  insertMeta.run("geometry_included", geometry ? "1" : "0");
  insertMeta.run(
    "sources",
    JSON.stringify(
      [...sources.byCountry.values()].map((country) => ({
        country: country.code,
        package: `public/rail/${country.packageFile}`,
        packageVersion: country.pkg.version,
        readings: `data/${country.readingsFile}`,
        sections: `data/${country.sectionsFile}`,
        stations: `data/${country.stationsFile}`,
      })),
    ),
  );

  db.exec("COMMIT");
  db.exec("ANALYZE");
  db.exec("VACUUM");
  db.close();
  return counts;
}

export { COUNTRIES, NAME_FIELD_KEYS };
