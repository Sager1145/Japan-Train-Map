#!/usr/bin/env node

/**
 * Download company-logo fallbacks for Japanese rail lines which do not have a
 * dedicated line badge in the compact rail package.
 *
 * Logo assignments come from the operator article's current Wikidata P154
 * claim.  Files and their source metadata are then read from Wikimedia
 * Commons.  Re-running the script never replaces an existing asset unless
 * --overwrite is passed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const NETWORK_PATH = path.join(PUBLIC_DIR, "rail", "jp-2025.json");
const OUTPUT_DIR = path.join(PUBLIC_DIR, "rail", "operator-logos", "jp");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json");

// These package entries carried a historical predecessor mark or a parent
// company's mark, so they need a verified operator fallback even though an
// image is present in the legacy line-logo package.
const FORCED_OPERATOR_FALLBACKS = Object.freeze([
  "伊賀鉄道",
  "筑波観光鉄道",
  "養老鉄道",
]);

const PAGE_ALIASES = Object.freeze({
  京都市: "京都市交通局",
  熊本市: "熊本市交通局",
  鹿児島市: "鹿児島市交通局",
  函館市: "函館市企業局交通部",
  東京メトロ: "東京地下鉄",
  "WILLER　TRAINS": "WILLER TRAINS",
  一般社団法人札幌市交通事業振興公社: "札幌市交通事業振興公社",
});

const COMMONS_SEARCH_ALIASES = Object.freeze({
  くま川鉄道: "Kumagawa Rail Road",
  こうべ未来都市機構: "Kobe Future City railway",
  アルピコ交通: "Alpico Kotsu",
  ラクテンチ: "Rakutenchi cable railway",
  一般社団法人札幌市交通事業振興公社: "Sapporo streetcar logo",
  万葉線: "Manyosen logo",
  三陸鉄道: "Sanriku Railway logo",
  上田電鉄: "Ueda Electric Railway logo",
  信楽高原鐵道: "Shigaraki Kohgen Railway logo",
  函館市: "Hakodate Transportation Bureau logo",
  北陸鉄道: "Hokuriku Railroad logo",
  十国峠: "Jukkokutoge Cable Car logo",
  南阿蘇鉄道: "Minami-Aso Railway logo",
  四国ケーブル: "Shikoku Cable logo",
  四日市あすなろう鉄道: "Yokkaichi Asunarou Railway logo",
  土佐くろしお鉄道: "Tosa Kuroshio Railway logo",
  大山観光電鉄: "Oyama Cable Car logo",
  山万: "Yamaman logo",
  嵯峨野観光鉄道: "Sagano Scenic Railway logo",
  明知鉄道: "Akechi Railway logo",
  松浦鉄道: "Matsuura Railway logo",
  比叡山鉄道: "Hieizan Railway logo",
  熊本市: "Kumamoto City Transportation Bureau logo",
  甘木鉄道: "Amagi Railway logo",
  由利高原鉄道: "Yuri Kogen Railway logo",
  皿倉登山鉄道: "Sarakura Cable Car logo",
  神戸六甲鉄道: "Rokko Cable Car logo",
  福島交通: "Fukushima Transportation logo",
  秋田内陸縦貫鉄道: "Akita Nairiku Railway logo",
  立山黒部貫光: "Tateyama Kurobe Kanko logo",
  若桜鉄道: "Wakasa Railway logo",
  近江鉄道: "Ohmi Railway logo",
  野岩鉄道: "Yagan Railway logo",
  錦川鉄道: "Nishikigawa Railway logo",
  長崎電気軌道: "Nagasaki Electric Tramway logo",
  阿佐海岸鉄道: "Asa Seaside Railway logo",
  鞍馬寺: "Kurama-dera cable car logo",
  鹿児島市: "Kagoshima City Transportation Bureau logo",
});

// Some current operator marks are present on Commons but are not linked from
// the corresponding Wikidata P154 property.  These names were checked against
// the operator article or current official site before being added here.
const COMMONS_LOGO_FILES = Object.freeze({
  アルピコ交通: "ALPICO GROUP logo.svg",
  上田電鉄: "Ueda-dentetsu-mark-train.svg",
  北陸鉄道: "Hokutetsu logomark.svg",
  南阿蘇鉄道: "Minamiaso Rail logo.jpg",
  四日市あすなろう鉄道: "YAR logo.svg",
  山万: "Yamaman logo.png",
  嵯峨野観光鉄道: "Sagano Scenic Railway logo.svg",
  明知鉄道: "Akechi Railway Logo.svg",
  松浦鉄道: "Matsuura Railway logo.jpg",
  甘木鉄道: "Amagi Railway logo.png",
  福島交通: "Fukushima Transportation Logomark.svg",
  近江鉄道: "Ohmi Railway Group Logo.png",
  長崎電気軌道: "長崎電気軌道株式会社 ロゴ.png",
  // Wikidata previously pointed P154 at a building photo; use the actual mark.
  長良川鉄道: "Nagaragawa Railway logo.svg",
});

// Operators without a Commons/Wikidata logo use the mark served by their
// current official website.  Direct asset URLs keep the downloaded files
// reproducible; sourcePage is the human-readable page that displays the mark.
const OFFICIAL_LOGOS = Object.freeze({
  くま川鉄道: {
    url: "http://kumagawa-rail.com/wp-content/uploads/2025/06/kt-hp_logo.jpg",
    sourcePage: "https://www.kumagawa-rail.com/",
  },
  こうべ未来都市機構: {
    url: "https://www.kfcc.co.jp/img/logo.png",
    sourcePage: "https://www.kfcc.co.jp/",
  },
  ラクテンチ: {
    url: "https://rakutenchi.jp/shared/images/logo.png",
    sourcePage: "https://rakutenchi.jp/",
  },
  一般社団法人札幌市交通事業振興公社: {
    url: "https://www.stsp.or.jp/wp-content/themes/stsp/images/logo.svg",
    sourcePage: "https://www.stsp.or.jp/",
  },
  一般財団法人青函トンネル記念館: {
    url: "http://seikan-tunnel-museum.jp/img/common/logo.png",
    sourcePage: "http://seikan-tunnel-museum.jp/",
    assetBase: "seikan-tunnel-museum",
  },
  三陸鉄道: {
    url: "https://www.sanrikutetsudou.com/wp-content/uploads/2024/03/logo.png",
    sourcePage: "https://www.sanrikutetsudou.com/",
  },
  上田電鉄: {
    url: "https://www.ukg.co.jp/cms/wp-content/themes/ukg/assets/img/header_logo.svg",
    sourcePage: "https://www.ukg.co.jp/",
  },
  信楽高原鐵道: {
    url: "https://koka-skr.co.jp/img/header/logo.jpg",
    sourcePage: "https://koka-skr.co.jp/",
  },
  函館市: {
    url: "https://www.city.hakodate.hokkaido.jp/assets/images/tram/img_company_logo_01.png",
    sourcePage: "https://www.city.hakodate.hokkaido.jp/tram/",
  },
  十国峠: {
    url: "https://www.jukkoku-cable.jp/common/images/logo1059_4.svg",
    sourcePage: "https://www.jukkoku-cable.jp/",
  },
  四国ケーブル: {
    url: "https://www.shikoku-cable.co.jp/_wp/wp-content/themes/shikokucable/assets/img/common/headerlogo.png",
    sourcePage: "https://www.shikoku-cable.co.jp/",
  },
  土佐くろしお鉄道: {
    url: "https://static.wixstatic.com/media/310f5f_766d64a3836b47318d3c43d134fbef09~mv2.png",
    sourcePage: "https://www.tosakuro.com/",
  },
  大山観光電鉄: {
    url: "https://www.ooyama-cable.co.jp/global-image/header/16-logo.png",
    sourcePage: "https://www.ooyama-cable.co.jp/",
  },
  比叡山鉄道: {
    url: "https://sakamoto-cable.jp/sakamoto/wp-content/themes/sakamoto-cable/images/logo.svg",
    sourcePage: "https://www.sakamoto-cable.jp/",
  },
  熊本市: {
    url: "https://www.kotsu-kumamoto.jp/common/images/top1/header.jpg",
    sourcePage: "https://www.kotsu-kumamoto.jp/",
  },
  由利高原鉄道: {
    url: "https://www.obako5.com/wp-content/uploads/2022/03/topbanner.png",
    sourcePage: "https://www.obako5.com/",
  },
  皿倉登山鉄道: {
    url: "https://www.sarakurayama-cablecar.co.jp/wp-content/uploads/2020/06/logo.png",
    sourcePage: "https://www.sarakurayama-cablecar.co.jp/",
  },
  神戸六甲鉄道: {
    url: "https://www.rokkosan.com/wp-content/themes/top/images/logo@2x.png",
    sourcePage: "https://www.rokkosan.com/",
  },
  秋田内陸縦貫鉄道: {
    url: "https://www.akita-nairiku.com/images/common/header_logo.png",
    sourcePage: "https://www.akita-nairiku.com/",
  },
  立山黒部貫光: {
    url: "https://www.alpen-route.co.jp/wps/wp-content/uploads/2026/05/cropped-logo_202605.png",
    sourcePage: "https://www.alpen-route.co.jp/",
  },
  若桜鉄道: {
    url: "https://wakatetsu.co.jp/wp/wp-content/themes/wakatesu/img/logo-3.svg",
    sourcePage: "https://wakatetsu.co.jp/",
  },
  野岩鉄道: {
    url: "https://www.yagan.co.jp/assets/img/common/logo-yagan.svg",
    sourcePage: "https://www.yagan.co.jp/",
  },
  錦川鉄道: {
    url: "https://nishikigawa.com/wp-content/uploads/logo-white-main.png",
    sourcePage: "https://nishikigawa.com/",
  },
  阿佐海岸鉄道: {
    url: "https://asatetu.com/dmv/wp-content/themes/dmv/img/gnav/gnav-logo.svg",
    sourcePage: "https://asatetu.com/",
  },
  鹿児島市: {
    url: "https://www.kotsu-city-kagoshima.jp/wp/wp-content/themes/kotsuTemp/img/logo.gif",
    sourcePage: "https://www.kotsu-city-kagoshima.jp/",
  },
  伊賀鉄道: {
    url: "https://www.igatetsu.co.jp/igatetsu/wp-content/themes/igatetsuwp/images/logo.png",
    sourcePage: "https://www.igatetsu.co.jp/",
    assetBase: "iga-railway",
    preferOfficial: true,
  },
  筑波観光鉄道: {
    url: "https://mt-tsukuba.com/wordpress2026/wp-content/themes/tsukubasan/img/common/icon_logo01.png",
    sourcePage: "https://mt-tsukuba.com/company/",
    assetBase: "tsukuba-kanko",
    preferOfficial: true,
  },
  養老鉄道: {
    url: "https://www.yororailway.co.jp/wp-content/themes/yororailway/img/webp/logo.webp",
    sourcePage: "https://www.yororailway.co.jp/about/",
    assetBase: "yoro-railway",
    preferOfficial: true,
  },
});

const USER_AGENT =
  "Japan-Train-Map operator-logo sync (https://github.com/; Wikimedia asset attribution)";
const OVERWRITE = process.argv.includes("--overwrite");
const SEARCH_UNRESOLVED = process.argv.includes("--search-unresolved");
const SEARCH_OFFICIAL = process.argv.includes("--search-official");
const SEARCH_OFFICIAL_ALL = process.argv.includes("--search-official-all");

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function queryUrl(base, params) {
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(url, attempts = 6) {
  let response;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (response.ok || response.status !== 429) return response;
    await pause(750 * 2 ** attempt);
  }
  return response;
}

async function wikipediaEntities(operators) {
  const titleToOperator = new Map(
    operators.map((operator) => [PAGE_ALIASES[operator] || operator, operator]),
  );
  const results = new Map();

  for (const titles of chunks([...titleToOperator.keys()], 40)) {
    const data = await fetchJson(
      queryUrl("https://ja.wikipedia.org/w/api.php", {
        action: "query",
        format: "json",
        formatversion: "2",
        prop: "pageprops",
        ppprop: "wikibase_item",
        redirects: "1",
        titles: titles.join("|"),
      }),
    );
    const redirectedTitles = new Map(
      (data.query?.redirects || []).map((redirect) => [redirect.to, redirect.from]),
    );
    for (const page of data.query?.pages || []) {
      const requestedTitle = redirectedTitles.get(page.title) || page.title;
      const operator =
        titleToOperator.get(requestedTitle) ||
        titleToOperator.get(page.title) ||
        [...titleToOperator.entries()].find(([, value]) => value === page.title)?.[1];
      if (operator && page.pageprops?.wikibase_item) {
        results.set(operator, {
          articleTitle: page.title,
          entityId: page.pageprops.wikibase_item,
        });
      }
    }
  }
  return results;
}

function claimEndTime(claim) {
  return claim.qualifiers?.P582?.[0]?.datavalue?.value?.time || null;
}

function pickCurrentLogo(claims = []) {
  return claims
    .filter((claim) => claim.rank !== "deprecated")
    .filter((claim) => !claimEndTime(claim))
    .sort((a, b) => Number(b.rank === "preferred") - Number(a.rank === "preferred"))
    .map((claim) => claim.mainsnak?.datavalue?.value)
    .find((value) => typeof value === "string");
}

async function wikidataLogos(operatorEntities) {
  const byEntity = new Map([...operatorEntities].map(([operator, value]) => [value.entityId, operator]));
  const results = new Map();
  for (const ids of chunks([...byEntity.keys()], 40)) {
    const data = await fetchJson(
      queryUrl("https://www.wikidata.org/w/api.php", {
        action: "wbgetentities",
        format: "json",
        props: "claims",
        ids: ids.join("|"),
      }),
    );
    for (const [entityId, entity] of Object.entries(data.entities || {})) {
      const logoFile = pickCurrentLogo(entity.claims?.P154);
      if (logoFile) results.set(byEntity.get(entityId), logoFile);
    }
  }
  return results;
}

async function wikidataOfficialSites(operatorEntities) {
  const byEntity = new Map(
    [...operatorEntities].map(([operator, value]) => [value.entityId, operator]),
  );
  const results = new Map();
  for (const ids of chunks([...byEntity.keys()], 40)) {
    const data = await fetchJson(
      queryUrl("https://www.wikidata.org/w/api.php", {
        action: "wbgetentities",
        format: "json",
        props: "claims",
        ids: ids.join("|"),
      }),
    );
    for (const [entityId, entity] of Object.entries(data.entities || {})) {
      const sites = (entity.claims?.P856 || [])
        .filter((claim) => claim.rank !== "deprecated")
        .map((claim) => claim.mainsnak?.datavalue?.value)
        .filter((value) => typeof value === "string")
        .sort((a, b) => Number(b.startsWith("https:")) - Number(a.startsWith("https:")));
      if (sites.length) results.set(byEntity.get(entityId), sites);
    }
  }
  return results;
}

function logoUrlsFromHtml(html, pageUrl) {
  const candidates = new Set();
  const attributePattern = /(?:src|href|content)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    const value = match[1].replace(/&amp;/g, "&");
    if (!/(?:logo|ロゴ|symbol|brand|header)[^?#]*(?:svg|png|webp|gif|jpe?g)(?:[?#]|$)/i.test(value)) {
      continue;
    }
    try {
      candidates.add(new URL(value, pageUrl).href);
    } catch {
      // Ignore malformed markup from third-party widgets.
    }
  }
  return [...candidates];
}

function imageUrlsFromHtml(html, pageUrl) {
  const candidates = new Set();
  const attributePattern = /(?:src|href|content)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    const value = match[1].replace(/&amp;/g, "&");
    if (!/(?:svg|png|webp|gif|jpe?g)(?:[?#]|$)/i.test(value)) continue;
    try {
      candidates.add(new URL(value, pageUrl).href);
    } catch {
      // Ignore malformed markup from third-party widgets.
    }
  }
  return [...candidates];
}

async function officialLogoCandidates(sites, includeAllImages = false) {
  for (const site of sites) {
    try {
      const response = await fetchWithRetry(site, 3);
      if (!response.ok) continue;
      const html = await response.text();
      const candidates = logoUrlsFromHtml(html, response.url || site);
      if (candidates.length) return candidates.slice(0, 8);
      if (includeAllImages) return imageUrlsFromHtml(html, response.url || site).slice(0, 15);
    } catch {
      // Try the next official URL when an old host no longer responds.
    }
  }
  return [];
}

async function commonsFileInfo(fileNames) {
  const results = new Map();
  for (const names of chunks(fileNames, 40)) {
    const data = await fetchJson(
      queryUrl("https://commons.wikimedia.org/w/api.php", {
        action: "query",
        format: "json",
        formatversion: "2",
        prop: "imageinfo",
        iiprop: "url|mime|extmetadata",
        titles: names.map((name) => `File:${name}`).join("|"),
      }),
    );
    for (const page of data.query?.pages || []) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      results.set(page.title.replace(/^File:/, ""), {
        sourcePage: info.descriptionurl,
        downloadUrl: info.url,
        mime: info.mime,
        license: info.extmetadata?.LicenseShortName?.value || "",
        licenseUrl: info.extmetadata?.LicenseUrl?.value || "",
      });
    }
  }
  return results;
}

async function commonsSearch(operator) {
  const data = await fetchJson(
    queryUrl("https://commons.wikimedia.org/w/api.php", {
      action: "query",
      format: "json",
      formatversion: "2",
      list: "search",
      srnamespace: "6",
      srlimit: "6",
      srsearch: COMMONS_SEARCH_ALIASES[operator] || `${operator} logo`,
    }),
  );
  await pause(150);
  return (data.query?.search || []).map((result) => result.title.replace(/^File:/, ""));
}

async function wikipediaImageCandidates(operators) {
  const titleToOperator = new Map(
    operators.map((operator) => [PAGE_ALIASES[operator] || operator, operator]),
  );
  const results = new Map(operators.map((operator) => [operator, []]));
  for (const titles of chunks([...titleToOperator.keys()], 30)) {
    const data = await fetchJson(
      queryUrl("https://ja.wikipedia.org/w/api.php", {
        action: "query",
        format: "json",
        formatversion: "2",
        prop: "images",
        imlimit: "500",
        redirects: "1",
        titles: titles.join("|"),
      }),
    );
    const redirectedTitles = new Map(
      (data.query?.redirects || []).map((redirect) => [redirect.to, redirect.from]),
    );
    for (const page of data.query?.pages || []) {
      const requestedTitle = redirectedTitles.get(page.title) || page.title;
      const operator = titleToOperator.get(requestedTitle) || titleToOperator.get(page.title);
      if (!operator) continue;
      results.set(
        operator,
        (page.images || [])
          .map((image) => image.title.replace(/^ファイル:|^File:/, ""))
          .filter((title) => /(?:logo|logomark|symbol|mark|ロゴ|社章)/i.test(title)),
      );
    }
  }
  return results;
}

function extensionFor(fileName, mime) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension) return extension;
  if (mime === "image/svg+xml") return ".svg";
  if (mime === "image/png") return ".png";
  return ".img";
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function download(url, filePath) {
  const cleanUrl = new URL(url);
  cleanUrl.search = "";
  const response = await fetchWithRetry(cleanUrl);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  await pause(250);
}

async function main() {
  const network = JSON.parse(await fs.readFile(NETWORK_PATH, "utf8"));
  const missingLines = network.lines.filter((line) => !line.logo);
  const operators = [
    ...new Set([
      ...missingLines.map((line) => line.operator),
      ...FORCED_OPERATOR_FALLBACKS,
    ]),
  ].sort();
  const entities = await wikipediaEntities(operators);
  const wikidataLogoFiles = await wikidataLogos(entities);
  const commonsLogoFiles = new Map(
    operators.map((operator) => [
      operator,
      COMMONS_LOGO_FILES[operator] || wikidataLogoFiles.get(operator),
    ]),
  );
  const fileInfo = await commonsFileInfo(
    [...new Set(commonsLogoFiles.values())].filter(Boolean),
  );

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const manifest = [];
  for (const operator of operators) {
    const entity = entities.get(operator);
    const logoFile = commonsLogoFiles.get(operator);
    const info = fileInfo.get(logoFile);
    const official = OFFICIAL_LOGOS[operator];
    if (entity && logoFile && info && !official?.preferOfficial) {
      const extension = extensionFor(logoFile, info.mime);
      const asset = `${entity.entityId.toLowerCase()}${extension}`;
      const outputPath = path.join(OUTPUT_DIR, asset);
      if (OVERWRITE || !(await exists(outputPath))) {
        await download(info.downloadUrl, outputPath);
      }
      manifest.push({
        operator,
        linesWithoutBadge: missingLines.filter((line) => line.operator === operator).length,
        articleTitle: entity.articleTitle,
        entityId: entity.entityId,
        logoFile,
        asset,
        sourceType: "wikimedia-commons",
        sourcePage: info.sourcePage,
        license: info.license,
        licenseUrl: info.licenseUrl,
        status: "downloaded",
      });
      continue;
    }

    if (official) {
      const extension = extensionFor(new URL(official.url).pathname, "");
      const assetBase = official.assetBase || entity?.entityId?.toLowerCase();
      const asset = `${assetBase}${extension}`;
      const outputPath = path.join(OUTPUT_DIR, asset);
      if (OVERWRITE || !(await exists(outputPath))) {
        await download(official.url, outputPath);
      }
      manifest.push({
        operator,
        linesWithoutBadge: missingLines.filter((line) => line.operator === operator).length,
        articleTitle: entity?.articleTitle || null,
        entityId: entity?.entityId || null,
        logoFile: path.basename(new URL(official.url).pathname),
        asset,
        sourceType: "official-operator-site",
        sourcePage: official.sourcePage,
        license: "Operator trademark",
        licenseUrl: "",
        status: "downloaded",
      });
      continue;
    }

    {
      manifest.push({
        operator,
        linesWithoutBadge: missingLines.filter((line) => line.operator === operator).length,
        articleTitle: entity?.articleTitle || null,
        entityId: entity?.entityId || null,
        status: !entity ? "article-not-found" : "logo-not-found",
      });
    }
  }

  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  const downloaded = manifest.filter((entry) => entry.status === "downloaded");
  const unresolved = manifest.filter((entry) => entry.status !== "downloaded");
  console.log(`Downloaded/mapped ${downloaded.length}/${operators.length} operators.`);
  if (unresolved.length) {
    console.log("Unresolved:");
    unresolved.forEach((entry) => console.log(`- ${entry.operator}: ${entry.status}`));
    if (SEARCH_UNRESOLVED) {
      const articleCandidates = await wikipediaImageCandidates(
        unresolved.map((entry) => entry.operator),
      );
      console.log("Japanese Wikipedia article-image candidates:");
      unresolved.forEach((entry) => {
        console.log(
          `- ${entry.operator}: ${articleCandidates.get(entry.operator)?.join(" | ") || "(none)"}`,
        );
      });
      console.log("Commons search candidates:");
      for (const entry of unresolved) {
        const candidates = await commonsSearch(entry.operator);
        console.log(`- ${entry.operator}: ${candidates.join(" | ") || "(none)"}`);
      }
    }
    if (SEARCH_OFFICIAL || SEARCH_OFFICIAL_ALL) {
      const sites = await wikidataOfficialSites(entities);
      console.log("Official-site logo candidates:");
      for (const entry of unresolved) {
        const candidates = await officialLogoCandidates(
          sites.get(entry.operator) || [],
          SEARCH_OFFICIAL_ALL,
        );
        console.log(`- ${entry.operator}: ${candidates.join(" | ") || "(none)"}`);
      }
    }
  }
}

await main();
