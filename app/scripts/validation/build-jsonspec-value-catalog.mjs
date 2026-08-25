#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_DIR = path.resolve(APP_DIR, "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DATA_DIR = path.join(APP_DIR, "data");

const OUTPUT_JSON = path.join(ROOT_DIR, "jsonspec-values.json");
const OUTPUT_MARKDOWN = path.join(ROOT_DIR, "jsonspec-values.md");
const CHECK_MODE = process.argv.includes("--check");

const COUNTRY_CONFIG = Object.freeze({
  jp: {
    label: "日本",
    package: "app/public/rail/jp-2025.json",
    stations: "app/data/stations.json",
    sections: "app/data/rail-sections.json",
    readings: "app/data/station-readings.json",
    stores: [
      "app/data/train-store.json",
      "app/data/default-trains.json",
      "app/data/special-samples/new-year-grand-loop.json",
      "app/data/special-samples/tokyo-limited-express-loop.json",
      "samples/jr_limited_shinkansen_itinerary_20260703_20260727_n02_v1_3_expanded_pass_through.json",
    ],
  },
  tw: {
    label: "台湾",
    package: "app/public/rail/tw-2025.json",
    stations: "app/data/stations-tw.json",
    sections: "app/data/rail-sections-tw.json",
    readings: "app/data/station-readings-tw.json",
    stores: ["app/data/train-store-tw.json"],
  },
  hk: {
    label: "香港",
    package: "app/public/rail/hk-2025.json",
    stations: "app/data/stations-hk.json",
    sections: "app/data/rail-sections-hk.json",
    readings: "app/data/station-readings-hk.json",
    stores: ["app/data/train-store-hk.json"],
  },
  mo: {
    label: "澳门",
    package: "app/public/rail/mo-2025.json",
    stations: "app/data/stations-mo.json",
    sections: "app/data/rail-sections-mo.json",
    readings: "app/data/station-readings-mo.json",
    stores: ["app/data/train-store-mo.json"],
  },
  kr: {
    label: "韩国",
    package: "app/public/rail/kr-2025.json",
    stations: "app/data/stations-kr.json",
    sections: "app/data/rail-sections-kr.json",
    readings: "app/data/station-readings-kr.json",
    stores: ["app/data/train-store-kr.json"],
  },
});

const CANONICAL_CODE_PATTERN = /^(?:\d{6}|[A-Z][A-Z0-9]*-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$/;

function absolute(relativePath) {
  return path.join(ROOT_DIR, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(absolute(relativePath), "utf8"));
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(values) {
  return [
    ...new Set(
      [...values]
        .filter(
          (value) =>
            value !== null &&
            value !== undefined &&
            String(value) !== "",
        )
        .map(String),
    ),
  ].sort(compareText);
}

function sha256(relativePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(absolute(relativePath))).digest("hex");
}

function loadBranding() {
  const context = vm.createContext({ window: {} });
  const sourcePath = path.join(PUBLIC_DIR, "app-operator-branding.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const returnMarker = "  return Object.freeze({\n    companyLabel,";
  if (!source.includes(returnMarker)) {
    throw new Error("Unable to expose company alias tables from app-operator-branding.js");
  }
  const instrumentedSource = source.replace(
    returnMarker,
    `  window.__JSONSPEC_COMPANY_ALIASES__ = {\n` +
      `    jp: COMPANY_LABELS,\n` +
      `    tw: TAIWAN_COMPANY_LABELS,\n` +
      `    hk: HONG_KONG_COMPANY_LABELS,\n` +
      `    mo: MACAO_COMPANY_LABELS,\n` +
      `    kr: {},\n` +
      `  };\n\n${returnMarker}`,
  );
  vm.runInContext(
    instrumentedSource,
    context,
    { filename: "app-operator-branding.js" },
  );
  return {
    api: context.window.RailOperatorBranding,
    aliases: context.window.__JSONSPEC_COMPANY_ALIASES__,
  };
}

function stationProperties(country, properties) {
  if (country === "jp") {
    return {
      code: properties.N02_005c,
      groupCode: properties.N02_005g,
      name: properties.N02_005,
      lineName: properties.N02_003,
      operatorName: properties.N02_004,
      institutionTypeCode: properties.N02_002,
      railwayClassCode: properties.N02_001,
    };
  }
  return {
    code: properties.n02_station_code,
    groupCode: properties.n02_group_code,
    name: properties.station_name,
    lineName: properties.line_name,
    operatorName: properties.operator,
    institutionTypeCode: properties.institution_type_code,
    railwayClassCode: properties.railway_class_code,
  };
}

function sectionProperties(country, properties) {
  if (country === "jp") {
    return {
      lineName: properties.N02_003,
      operatorName: properties.N02_004,
      institutionTypeCode: properties.N02_002,
      railwayClassCode: properties.N02_001,
    };
  }
  return {
    lineName: properties.line_name,
    operatorName: properties.operator,
    institutionTypeCode: properties.institution_type_code,
    railwayClassCode: properties.railway_class_code,
  };
}

function addToSetMap(map, key, value) {
  if (!key || !value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(String(value));
}

function mergeLocalizedNames(target, reading) {
  if (!reading || typeof reading !== "object") return;
  for (const [key, value] of Object.entries(reading)) {
    if (key === "name" || !value) continue;
    if (!target[key]) target[key] = new Set();
    target[key].add(String(value));
  }
}

function localizedObject(value) {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, values]) => [key, sorted(values)])
      .filter(([, values]) => values.length),
  );
}

function extractObservedValues(storePaths) {
  const trainTypes = new Set();
  const companies = new Set();
  const preferredLines = new Set();
  const preferredOperators = new Set();
  const requiredLines = new Set();
  const requiredOperators = new Set();

  for (const relativePath of storePaths) {
    const parsed = readJson(relativePath);
    const trains = Array.isArray(parsed) ? parsed : parsed.trains || [];
    for (const train of trains) {
      if (train.train_type) trainTypes.add(String(train.train_type));
      if (train.company) companies.add(String(train.company));
      for (const value of train.route_policy?.preferred_line_names || []) preferredLines.add(String(value));
      for (const value of train.route_policy?.preferred_operator_names || []) preferredOperators.add(String(value));
      for (const section of train.route_sections || []) {
        for (const value of section.line_names || []) requiredLines.add(String(value));
        for (const value of section.operator_names || []) requiredOperators.add(String(value));
      }
    }
  }

  return {
    train_type_values: sorted(trainTypes),
    company_values: sorted(companies),
    preferred_line_names: sorted(preferredLines),
    preferred_operator_names: sorted(preferredOperators),
    section_line_names: sorted(requiredLines),
    section_operator_names: sorted(requiredOperators),
  };
}

function buildCountry(country, config, branding) {
  const railPackage = readJson(config.package);
  const stationCollection = readJson(config.stations);
  const sectionCollection = readJson(config.sections);
  const readings = readJson(config.readings);

  const stationRows = stationCollection.features.map((feature) =>
    stationProperties(country, feature.properties || {}),
  );
  const sectionRows = sectionCollection.features.map((feature) =>
    sectionProperties(country, feature.properties || {}),
  );

  const operators = sorted([
    ...railPackage.lines.map((line) => line.operator),
    ...stationRows.map((row) => row.operatorName),
    ...sectionRows.map((row) => row.operatorName),
  ]);
  const operatorCompanyLabels = operators.map((operatorName) => ({
    operator_name: operatorName,
    company_value: branding.api.companyLabel(operatorName) || operatorName,
  }));
  const acceptedCompanyAliases = Object.entries(branding.aliases[country] || {})
    .map(([inputValue, companyValue]) => ({
      input_value: String(inputValue),
      normalized_company_value: String(companyValue),
    }))
    .sort(
      (left, right) =>
        compareText(left.input_value, right.input_value) ||
        compareText(left.normalized_company_value, right.normalized_company_value),
    );

  const lineMeta = new Map();
  for (const row of sectionRows) {
    const key = `${row.lineName || ""}\u0000${row.operatorName || ""}`;
    if (!lineMeta.has(key)) {
      lineMeta.set(key, {
        line_name: row.lineName || "",
        operator_name: row.operatorName || "",
        institution_type_codes: new Set(),
        railway_class_codes: new Set(),
      });
    }
    const item = lineMeta.get(key);
    if (row.institutionTypeCode) item.institution_type_codes.add(String(row.institutionTypeCode));
    if (row.railwayClassCode) item.railway_class_codes.add(String(row.railwayClassCode));
  }

  const stationIndex = new Map();
  function indexStation(key, row) {
    if (!key) return;
    if (!stationIndex.has(key)) stationIndex.set(key, []);
    stationIndex.get(key).push(row);
  }
  for (const row of stationRows) {
    indexStation(`exact\u0000${row.lineName}\u0000${row.operatorName}\u0000${row.groupCode}\u0000${row.name}`, row);
    indexStation(`group\u0000${row.lineName}\u0000${row.operatorName}\u0000${row.groupCode}`, row);
    indexStation(`name\u0000${row.lineName}\u0000${row.operatorName}\u0000${row.name}`, row);
    indexStation(`code\u0000${row.code}\u0000${row.name}`, row);
  }

  function codesForPackageStation(line, station) {
    if (country === "jp") {
      return sorted(
        (stationIndex.get(`code\u0000${station[0]}\u0000${station[1]}`) || [])
          .map((row) => row.code)
          .filter((code) => CANONICAL_CODE_PATTERN.test(String(code || ""))),
      );
    }
    const keys = [
      `exact\u0000${line.name}\u0000${line.operator}\u0000${station[0]}\u0000${station[1]}`,
      `group\u0000${line.name}\u0000${line.operator}\u0000${station[0]}`,
      `name\u0000${line.name}\u0000${line.operator}\u0000${station[1]}`,
    ];
    for (const key of keys) {
      const codes = sorted(
        (stationIndex.get(key) || [])
          .map((row) => row.code)
          .filter((code) => CANONICAL_CODE_PATTERN.test(String(code || ""))),
      );
      if (codes.length) return codes;
    }
    return [];
  }

  const lines = railPackage.lines.map((line) => {
    const meta = lineMeta.get(`${line.name || ""}\u0000${line.operator || ""}`);
    const stationSequence = line.stations.map((station) => ({
      name: String(station[1] || ""),
      canonical_code_candidates: codesForPackageStation(line, station),
    }));
    return {
      display_line_id: String(line.id || ""),
      line_name: String(line.name || ""),
      operator_name: String(line.operator || ""),
      company_value:
        branding.api.companyLabel(line.operator) || String(line.operator || ""),
      institution_type_codes: sorted(meta?.institution_type_codes || []),
      railway_class_codes: sorted(meta?.railway_class_codes || []),
      color: /^#[0-9a-fA-F]{6}$/.test(String(line.color || "")) ? String(line.color) : null,
      name_roma: line.nameRoma ? String(line.nameRoma) : "",
      station_sequence: stationSequence,
    };
  });
  const sequencedLineNames = sorted(lines.map((line) => line.line_name));
  const allLineNames = sorted([
    ...sequencedLineNames,
    ...stationRows.map((row) => row.lineName),
    ...sectionRows.map((row) => row.lineName),
  ]);
  const unsequencedLineNames = allLineNames.filter(
    (lineName) => !sequencedLineNames.includes(lineName),
  );

  const stationCatalog = new Map();
  function ensureStation(code) {
    if (!stationCatalog.has(code)) {
      stationCatalog.set(code, {
        code,
        names: new Set(),
        localized_names: {},
        reading_name: "",
        line_names: new Set(),
        operator_names: new Set(),
        institution_type_codes: new Set(),
        railway_class_codes: new Set(),
        in_solver_network: false,
        in_station_readings: false,
      });
    }
    return stationCatalog.get(code);
  }

  const excludedNoncanonicalStationCodes = [];
  for (const row of stationRows) {
    const code = String(row.code || "");
    if (!CANONICAL_CODE_PATTERN.test(code)) {
      excludedNoncanonicalStationCodes.push({
        value: code,
        name: String(row.name || ""),
        line_name: String(row.lineName || ""),
        operator_name: String(row.operatorName || ""),
        reason: "Does not match the schema 1.3 canonical station-code pattern; never write this value to n02_station_code.",
      });
      continue;
    }
    const item = ensureStation(code);
    item.in_solver_network = true;
    if (row.name) item.names.add(String(row.name));
    if (row.lineName) item.line_names.add(String(row.lineName));
    if (row.operatorName) item.operator_names.add(String(row.operatorName));
    if (row.institutionTypeCode) item.institution_type_codes.add(String(row.institutionTypeCode));
    if (row.railwayClassCode) item.railway_class_codes.add(String(row.railwayClassCode));
  }

  for (const [code, reading] of Object.entries(readings.byCode || {})) {
    if (!CANONICAL_CODE_PATTERN.test(code)) continue;
    const item = ensureStation(code);
    item.in_station_readings = true;
    if (reading?.name) {
      item.names.add(String(reading.name));
      item.reading_name = String(reading.name);
    }
    mergeLocalizedNames(item.localized_names, reading);
  }

  if (country === "jp") {
    for (const line of railPackage.lines) {
      for (const station of line.stations || []) {
        const code = String(station[0] || "");
        if (!CANONICAL_CODE_PATTERN.test(code) || !station[4]) continue;
        const item = ensureStation(code);
        if (!item.localized_names.romaji) item.localized_names.romaji = new Set();
        item.localized_names.romaji.add(String(station[4]));
      }
    }
  }

  const stations = [...stationCatalog.values()]
    .map((item) => {
      const names = sorted(item.names);
      const canonicalName = item.reading_name || names[0] || "";
      return {
        code: item.code,
        canonical_name: canonicalName,
        names,
        localized_names: localizedObject(item.localized_names),
        line_names: sorted(item.line_names),
        operator_names: sorted(item.operator_names),
        institution_type_codes: sorted(item.institution_type_codes),
        railway_class_codes: sorted(item.railway_class_codes),
        in_solver_network: item.in_solver_network,
        in_station_readings: item.in_station_readings,
      };
    })
    .sort((left, right) => compareText(left.code, right.code));
  const stationNames = new Set(stations.flatMap((station) => station.names));
  const nameFallbacks = Object.entries(readings.byName || {})
    .map(([lookupName, value]) => {
      const localized = {};
      mergeLocalizedNames(localized, value);
      return {
        lookup_name: String(lookupName),
        canonical_name: String(value?.name || lookupName),
        localized_names: localizedObject(localized),
        has_canonical_station_code: stationNames.has(String(lookupName)),
      };
    })
    .sort((left, right) => compareText(left.lookup_name, right.lookup_name));

  const unmappedLineStations = lines.reduce(
    (total, line) => total + line.station_sequence.filter((station) => !station.canonical_code_candidates.length).length,
    0,
  );
  const ambiguousLineStations = lines.reduce(
    (total, line) => total + line.station_sequence.filter((station) => station.canonical_code_candidates.length > 1).length,
    0,
  );

  return {
    label: config.label,
    package_version: String(railPackage.version || ""),
    recommended_company_values: sorted(operatorCompanyLabels.map((row) => row.company_value)),
    operator_company_labels: operatorCompanyLabels,
    accepted_company_aliases: acceptedCompanyAliases,
    operator_names: operators,
    line_names: allLineNames,
    line_names_without_display_sequence: unsequencedLineNames,
    lines,
    stations,
    station_name_fallbacks: nameFallbacks,
    excluded_noncanonical_station_codes: excludedNoncanonicalStationCodes.sort(
      (left, right) =>
        compareText(left.value, right.value) ||
        compareText(left.line_name, right.line_name) ||
        compareText(left.name, right.name),
    ),
    observed_train_values: extractObservedValues(config.stores),
    stats: {
      operators: operators.length,
      recommended_company_values: sorted(operatorCompanyLabels.map((row) => row.company_value)).length,
      accepted_company_aliases: acceptedCompanyAliases.length,
      line_names: allLineNames.length,
      line_names_without_display_sequence: unsequencedLineNames.length,
      line_variants: lines.length,
      station_codes: stations.length,
      solver_station_codes: stations.filter((station) => station.in_solver_network).length,
      reading_only_station_codes: stations.filter((station) => !station.in_solver_network && station.in_station_readings).length,
      station_name_fallbacks: nameFallbacks.length,
      station_name_fallbacks_without_canonical_code: nameFallbacks.filter(
        (row) => !row.has_canonical_station_code,
      ).length,
      line_station_occurrences: lines.reduce((total, line) => total + line.station_sequence.length, 0),
      line_station_occurrences_without_canonical_code: unmappedLineStations,
      line_station_occurrences_with_multiple_code_candidates: ambiguousLineStations,
      excluded_noncanonical_station_code_occurrences:
        excludedNoncanonicalStationCodes.length,
    },
  };
}

function markdownCell(value) {
  const text = Array.isArray(value) ? value.join(" / ") : String(value ?? "");
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMarkdown(catalog) {
  const lines = [
    "# Railprint JSONSpec 程序值穷举附录",
    "",
    "> 本文件由 `app/scripts/validation/build-jsonspec-value-catalog.mjs` 从当前程序数据机械生成，",
    "> 是 `jsonspec.md` 的规范性数据附录。请勿手工编辑；更新 rail package、stations、",
    "> station-readings、operator branding 或 bundled train stores 后重新运行生成器。",
    "",
    "`company` 与 `train_type` 在 schema 中是开放字符串，不存在理论上的封闭全集。",
    "本附录穷举的是当前程序中可推导的推荐 company、正式 operator、正式 line、合法 canonical station code、",
    "站名/多语言读法及现有行程实际出现值。`display_line_id` 只用于查表，绝不能写入 `line_names` 或站点代码字段。",
    "",
    "完整关系、每条线路的物理站序及机器可读字段见 [`jsonspec-values.json`](./jsonspec-values.json)。",
    "",
    "## 汇总",
    "",
    "| 地区 | 推荐 company | operator_names | line_names | 线路变体 | station codes | solver 可用 codes | reading-only codes |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [country, value] of Object.entries(catalog.countries)) {
    lines.push(
      `| ${country.toUpperCase()} ${value.label} | ${value.stats.recommended_company_values} | ${value.stats.operators} | ${value.stats.line_names} | ${value.stats.line_variants} | ${value.stats.station_codes} | ${value.stats.solver_station_codes} | ${value.stats.reading_only_station_codes} |`,
    );
  }

  for (const [country, value] of Object.entries(catalog.countries)) {
    lines.push("", `## ${country.toUpperCase()} · ${value.label}`, "");
    lines.push("### 运营者 → 推荐 `company`", "");
    lines.push("| `operator_names` 正式值 | 推荐 train `company` |", "| --- | --- |");
    for (const row of value.operator_company_labels) {
      lines.push(`| ${markdownCell(row.operator_name)} | ${markdownCell(row.company_value)} |`);
    }

    lines.push("", "### 程序接受的 `company` 别名归一化", "");
    if (!value.accepted_company_aliases.length) {
      lines.push("（没有封闭别名表；使用上表推荐值或经过核实的乘客向名称。）");
    } else {
      lines.push("| 输入别名 | 归一化后的 `company` |", "| --- | --- |");
      for (const row of value.accepted_company_aliases) {
        lines.push(
          `| ${markdownCell(row.input_value)} | ${markdownCell(row.normalized_company_value)} |`,
        );
      }
    }

    lines.push("", "### 当前 bundled 行程中实际出现的开放字符串值", "");
    lines.push(`- \`train_type\`：${value.observed_train_values.train_type_values.map((item) => `\`${item}\``).join("、") || "（无）"}`);
    lines.push(`- \`company\`：${value.observed_train_values.company_values.map((item) => `\`${item}\``).join("、") || "（无）"}`);

    lines.push("", "### 带 display 物理站序的线路变体", "");
    lines.push("| display_line_id（不可写入 canonical hint） | `line_names` 正式值 | `operator_names` 正式值 | 推荐 company | 类型码 | 颜色 | 物理站序（code 候选 + name） |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const line of value.lines) {
      const sequence = line.station_sequence
        .map((station) => `${station.canonical_code_candidates.join("|") || "null"} ${station.name}`)
        .join(" → ");
      lines.push(
        `| ${markdownCell(line.display_line_id)} | ${markdownCell(line.line_name)} | ${markdownCell(line.operator_name)} | ${markdownCell(line.company_value)} | ${markdownCell(line.institution_type_codes)} | ${markdownCell(line.color || "")} | ${markdownCell(sequence)} |`,
      );
    }

    lines.push("", "### 当前 solver 中存在、但没有 display 站序的其它正式 `line_names`", "");
    lines.push(
      value.line_names_without_display_sequence.length
        ? value.line_names_without_display_sequence.map((item) => `\`${item}\``).join("、")
        : "（无）",
    );

    lines.push("", "### 站点", "");
    lines.push("| canonical `n02_station_code` | 规范站名 | 其它/本地化名称 | `line_names` | `operator_names` | solver | readings |", "| --- | --- | --- | --- | --- | :---: | :---: |");
    for (const station of value.stations) {
      const localized = Object.entries(station.localized_names)
        .flatMap(([language, names]) => names.map((name) => `${language}:${name}`));
      const otherNames = sorted([...station.names.filter((name) => name !== station.canonical_name), ...localized]);
      lines.push(
        `| ${markdownCell(station.code)} | ${markdownCell(station.canonical_name)} | ${markdownCell(otherNames)} | ${markdownCell(station.line_names)} | ${markdownCell(station.operator_names)} | ${station.in_solver_network ? "✓" : ""} | ${station.in_station_readings ? "✓" : ""} |`,
      );
    }

    lines.push("", "### 没有 canonical code 对应项的其它程序站名 fallback", "");
    const nameOnlyFallbacks = value.station_name_fallbacks.filter(
      (row) => !row.has_canonical_station_code,
    );
    if (!nameOnlyFallbacks.length) {
      lines.push("（无）");
    } else {
      lines.push("| lookup name | 规范名称 | 本地化名称 |", "| --- | --- | --- |");
      for (const row of nameOnlyFallbacks) {
        const localized = Object.entries(row.localized_names)
          .flatMap(([language, names]) => names.map((name) => `${language}:${name}`));
        lines.push(
          `| ${markdownCell(row.lookup_name)} | ${markdownCell(row.canonical_name)} | ${markdownCell(localized)} |`,
        );
      }
    }

    lines.push("", "### 程序中存在但禁止写入 canonical JSON 的站点值", "");
    if (!value.excluded_noncanonical_station_codes.length) {
      lines.push("（无）");
    } else {
      lines.push("| 禁用值 | 站名 | 线路 | 运营者 | 原因 |", "| --- | --- | --- | --- | --- |");
      for (const row of value.excluded_noncanonical_station_codes) {
        lines.push(
          `| ${markdownCell(row.value)} | ${markdownCell(row.name)} | ${markdownCell(row.line_name)} | ${markdownCell(row.operator_name)} | ${markdownCell(row.reason)} |`,
        );
      }
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeOrCheck(filePath, content) {
  if (CHECK_MODE) {
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
    if (current !== content) throw new Error(`${path.relative(ROOT_DIR, filePath)} is stale; run build-jsonspec-value-catalog.mjs`);
    return;
  }
  fs.writeFileSync(filePath, content, "utf8");
}

const branding = loadBranding();
const sourceFiles = sorted(
  [
    "app/public/app-operator-branding.js",
    ...Object.values(COUNTRY_CONFIG).flatMap((config) => [
      config.package,
      config.stations,
      config.sections,
      config.readings,
      ...config.stores,
    ]),
  ],
);
const catalog = {
  catalog_version: "1",
  schema_version: "1.3",
  description: "Exhaustive program-derived values useful when authoring Railprint canonical train JSON.",
  open_string_fields: {
    company: "Open string. recommended_company_values and observed_train_values.company_values enumerate current program-derived values, not a schema whitelist.",
    train_type: "Open string. observed_train_values.train_type_values enumerates bundled examples, not a schema whitelist.",
    number: "Open string derived from the actual service/timetable; it cannot be enumerated from the rail network package.",
  },
  canonical_field_sources: {
    company: "countries.*.recommended_company_values or a verified passenger-facing through-service combination joined with /",
    preferred_operator_names: "countries.*.operator_names",
    route_section_operator_names: "countries.*.operator_names",
    preferred_line_names: "countries.*.line_names",
    route_section_line_names: "countries.*.line_names",
    n02_station_code: "countries.*.stations[].code",
    platform_number: "A verified service timetable or passenger record only; null when unavailable. Never infer it from platform geometry or station groups.",
    stop_name: "countries.*.stations[].canonical_name",
    stop_name_fallback: "countries.*.station_name_fallbacks[].lookup_name when no canonical station code is available",
    route_section_station_order: "countries.*.lines[].station_sequence",
    style_color: "countries.*.lines[].color when a line-derived color is desired",
  },
  warnings: [
    "display_line_id and rail package geometry/group ids are lookup-only and must never be written as canonical station codes or line_names.",
    "A station code with in_solver_network=false exists only in the readings table and may not be routable in the current package.",
    "A station_sequence item with no canonical_code_candidates must use null in generated JSON; never copy the package geometry station id.",
    "A station_sequence item with multiple canonical_code_candidates requires branch/line-specific disambiguation.",
    "Physical platform geometry and map anchors are not service platform numbers; platform_number must remain null unless a verified service-specific source provides it.",
  ],
  source_files: sourceFiles.map((relativePath) => ({
    path: relativePath,
    sha256: sha256(relativePath),
  })),
  countries: Object.fromEntries(
    Object.entries(COUNTRY_CONFIG).map(([country, config]) => [country, buildCountry(country, config, branding)]),
  ),
};

const json = `${JSON.stringify(catalog, null, 2)}\n`;
const markdown = renderMarkdown(catalog);
writeOrCheck(OUTPUT_JSON, json);
writeOrCheck(OUTPUT_MARKDOWN, markdown);

for (const [country, value] of Object.entries(catalog.countries)) {
  console.log(
    `${country.toUpperCase()}: ${value.stats.operators} operators, ${value.stats.line_variants} lines, ${value.stats.station_codes} station codes`,
  );
}
console.log(CHECK_MODE ? "jsonspec value catalogs are current" : "wrote jsonspec-values.json and jsonspec-values.md");
