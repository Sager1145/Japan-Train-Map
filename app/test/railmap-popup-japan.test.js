"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const JAPAN_NETWORK = require(path.join(PUBLIC_DIR, "rail", "jp-2025.json"));
const JAPAN_MANIFEST = require(
  path.join(PUBLIC_DIR, "rail", "operator-logos", "jp", "manifest.json"),
);
const JAPAN_BADGE_AUDIT = require(
  path.join(PUBLIC_DIR, "rail", "operator-logos", "jp-badges", "manifest.json"),
);
const JAPAN_BADGE_BY_OPERATOR = new Map(
  JAPAN_BADGE_AUDIT.map((entry) => [entry.operator, entry]),
);

function loadPopup() {
  const win = {
    console,
    RailNetwork: { DEFAULT_LINE_COLOR: "#7C8A82" },
  };
  win.window = win;
  const context = vm.createContext(win);
  for (const file of ["app-operator-branding.js", "railmap-popup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8"), context, {
      filename: file,
    });
  }
  return { popup: win.RailMapPopup, branding: win.RailOperatorBranding };
}

test("only audited Japanese line badges stay ahead of operator fallbacks", () => {
  const { branding } = loadPopup();
  const packageImages = JAPAN_NETWORK.lines.filter((line) => line.logo);
  const linesWithBadges = packageImages.filter((line) =>
    branding.verifiedPackageLineLogo({
      ...line,
      lineId: line.id,
      // Same rule the renderer uses: a split part's badge is its parent's,
      // because the art is named after the railway rather than the stroke.
      logo: `/rail/logos/${line.id.replace(/-\d+$/, "")}.png`,
    }),
  );

  // 389/324, down from 391/326 with the 2026-08-18 gap repairs: five severed
  // sibling strokes (石北線-2, 常磐線-2, 日豊線-2/-2-p1, 山陽線-4 and the old
  // 山陽線-2 span) folded back into their trunks while 日豊線-p1 and 長崎線-3
  // appeared, and a split part carries its parent railway's badge. The
  // difference below is unchanged at 65, and the loop still proves every badge
  // it claims is a real PNG.
  // 388/323 with the 2026-08-18 pseudo-edge removals: 成田線-4 (the stroke the
  // three 成田-skipping audit edges produced) is no longer drawn, and it
  // carried its railway's badge like every split part.
  // 386/321 with the 2026-08-18 official shapes: 長崎線-3 folded into the
  // 市布新線 trunk and 東海道線(JR東日本)-4 renumbered to -3, so each family
  // shows one badge-carrying stroke fewer.
  // 385/320 after the 東京 Apple-layout correction: the former 東海道線-2
  // display stroke is now 総武線-3. 総武線 has no audited package badge, so
  // the stroke correctly uses the exact JR East operator fallback instead.
  // 383/318 on 2026-08-19: 養老線-2 and 西九州線-2 fold into their trunks now
  // that 大垣 and 伊万里 sit on the trunk chain, so each family shows one
  // badge-carrying stroke fewer. Both railways keep their badge on the trunk.
  // 381/316 on 2026-08-19: 東北線 loses the two strokes the 尾久 支線's skip
  // edges produced, and a split part carries its parent railway's badge, so
  // the JR East family shows two badge-carrying strokes fewer.
  assert.equal(packageImages.length, 381);
  assert.equal(linesWithBadges.length, 316);
  for (const line of linesWithBadges) {
    const existingLogo = `/rail/logos/${line.id.replace(/(?:-p?\d+)+$/, "")}.png`;
    const existingLogoPath = path.join(PUBLIC_DIR, existingLogo.replace(/^\//, ""));
    assert.equal(fs.existsSync(existingLogoPath), true, `${line.id} badge exists`);
    assert.equal(
      fs.readFileSync(existingLogoPath).subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
      `${line.id} badge is a PNG`,
    );
    assert.equal(
      branding.logoForLine({ ...line, lineId: line.id, logo: existingLogo }),
      existingLogo,
      `${line.operator} ${line.name} keeps its existing line badge`,
    );
  }

  assert.equal(packageImages.length - linesWithBadges.length, 65);
});

test("rejected or missing package art may use a verified line badge", () => {
  const { branding } = loadPopup();
  // 北勢線: package art was the pre-1944 北勢鉄道 predecessor mark; the line's
  // official 三岐鉄道 route letter is H. 丸ノ内線分岐線: no package art; the
  // branch publishes its own Marunouchi Mb badge. 京都市東西線: no package
  // art; the line publishes its official vermillion T symbol. Shinkansen
  // railways carry the official Shinkansen pictogram of the company that runs
  // them, which is the passenger-facing mark JR actually publishes; JR has no
  // per-route Shinkansen symbol, so the route is identified by colour + name.
  const overrides = new Map([
    ["jp-三岐鉄道-北勢線", "/rail/line-logos/sangi-hokusei.svg"],
    [
      "jp-東京地下鉄-4号線丸ノ内線分岐線",
      "/rail/line-logos/tokyo-metro-marunouchi-branch.svg",
    ],
    ["jp-京都市-東西線", "/rail/line-logos/kyoto-tozai.svg"],
    [
      "jp-北海道旅客鉄道-北海道新幹線",
      "/rail/line-logos/shinkansen-jr-hokkaido.svg",
    ],
    ["jp-東日本旅客鉄道-東北新幹線", "/rail/line-logos/shinkansen-jr-east.svg"],
    ["jp-東日本旅客鉄道-上越新幹線", "/rail/line-logos/shinkansen-jr-east.svg"],
    ["jp-東日本旅客鉄道-北陸新幹線", "/rail/line-logos/shinkansen-jr-east.svg"],
    [
      "jp-東海旅客鉄道-東海道新幹線",
      "/rail/line-logos/shinkansen-jr-central.svg",
    ],
    ["jp-西日本旅客鉄道-山陽新幹線", "/rail/line-logos/shinkansen-jr-west.svg"],
    ["jp-西日本旅客鉄道-北陸新幹線", "/rail/line-logos/shinkansen-jr-west.svg"],
    [
      "jp-九州旅客鉄道-九州新幹線",
      "/rail/line-logos/shinkansen-jr-kyushu.svg",
    ],
    [
      "jp-九州旅客鉄道-西九州新幹線",
      "/rail/line-logos/shinkansen-jr-kyushu.svg",
    ],
  ]);
  for (const [lineId, expected] of overrides) {
    const line = JAPAN_NETWORK.lines.find((entry) => entry.id === lineId);
    assert.ok(line, lineId);
    const packageLogo = line.logo ? `/rail/logos/${lineId}.png` : null;
    assert.equal(
      branding.logoForLine({ ...line, lineId, logo: packageLogo }),
      expected,
      lineId,
    );
    assert.equal(
      fs.existsSync(path.join(PUBLIC_DIR, expected.replace(/^\//, ""))),
      true,
      `${lineId} override asset exists`,
    );
  }
  // Every Shinkansen railway in the package resolves to the official
  // Shinkansen pictogram of the company operating it. 北陸新幹線 is stored as
  // two operator records and each half follows its own operator, so the pair
  // deliberately shows two different pictograms.
  const shinkansenPictograms = new Map([
    ["北海道旅客鉄道", "/rail/line-logos/shinkansen-jr-hokkaido.svg"],
    ["東日本旅客鉄道", "/rail/line-logos/shinkansen-jr-east.svg"],
    ["東海旅客鉄道", "/rail/line-logos/shinkansen-jr-central.svg"],
    ["西日本旅客鉄道", "/rail/line-logos/shinkansen-jr-west.svg"],
    ["九州旅客鉄道", "/rail/line-logos/shinkansen-jr-kyushu.svg"],
  ]);
  const shinkansenLines = JAPAN_NETWORK.lines.filter((line) =>
    line.name.includes("新幹線"),
  );
  assert.equal(shinkansenLines.length, 9);
  for (const line of shinkansenLines) {
    assert.equal(
      overrides.get(line.id),
      shinkansenPictograms.get(line.operator),
      `${line.operator} ${line.name} uses its operator's Shinkansen pictogram`,
    );
  }
  // The five pictograms are the supplied Commons assets, stored unchanged: no
  // recolouring, cropping or redrawing of the operators' artwork.
  const pictogramDigests = new Map([
    [
      "shinkansen-jr-hokkaido.svg",
      "5a633494bdb618d5591f06fc13905f9cc6782acb6c4fbadb1199f4599f7dd52c",
    ],
    [
      "shinkansen-jr-east.svg",
      "4248acd9bc349cf0270d311132094353ac0ae67602ab68acf9b9a8442590c99a",
    ],
    [
      "shinkansen-jr-central.svg",
      "7682d8e2db1aaae5ffffb604af34f420a27c359c5edd2ad38c8f903a58c57a9e",
    ],
    [
      "shinkansen-jr-west.svg",
      "aaecbde8de64d2e190f691a200d7b6c92759cf9ed33d38365d22dbde0a1b7de3",
    ],
    [
      "shinkansen-jr-kyushu.svg",
      "20fce2cc5be5dc6edd7c6c108787f3721883f3a3fbebc20533aa404e88f12c90",
    ],
  ]);
  assert.deepEqual(
    [...new Set(shinkansenPictograms.values())].sort(),
    [...pictogramDigests.keys()]
      .map((asset) => `/rail/line-logos/${asset}`)
      .sort(),
  );
  for (const [asset, digest] of pictogramDigests) {
    const pictogram = fs.readFileSync(
      path.join(PUBLIC_DIR, "rail", "line-logos", asset),
    );
    assert.equal(
      crypto.createHash("sha256").update(pictogram).digest("hex"),
      digest,
      `${asset} stays byte-for-byte the supplied Commons pictogram`,
    );
  }
});

test("every non-line image falls back to the exact operator, never a parent or predecessor", () => {
  const { branding } = loadPopup();
  const missingBadgeLines = JAPAN_NETWORK.lines.filter((line) => {
    const packageLogo = line.logo
      ? `/rail/logos/${line.id.replace(/-\d+$/, "")}.png`
      : null;
    return !branding.verifiedPackageLineLogo({
      ...line,
      lineId: line.id,
      logo: packageLogo,
    });
  });
  const unresolvedOperators = new Set(["万葉線", "鞍馬寺", "東武鉄道"]);
  // These resolve to official line symbols ahead of the operator mark;
  // the dedicated override test covers them.
  const lineSymbolOverrides = new Set([
    "jp-三岐鉄道-北勢線",
    "jp-東京地下鉄-4号線丸ノ内線分岐線",
    "jp-京都市-東西線",
    "jp-北海道旅客鉄道-北海道新幹線",
    "jp-東日本旅客鉄道-東北新幹線",
    "jp-東日本旅客鉄道-上越新幹線",
    "jp-東日本旅客鉄道-北陸新幹線",
    "jp-西日本旅客鉄道-北陸新幹線",
    "jp-東海旅客鉄道-東海道新幹線",
    "jp-西日本旅客鉄道-山陽新幹線",
    "jp-九州旅客鉄道-九州新幹線",
    "jp-九州旅客鉄道-西九州新幹線",
  ]);
  const coveredLines = missingBadgeLines.filter(
    (line) =>
      !unresolvedOperators.has(line.operator) && !lineSymbolOverrides.has(line.id),
  );

  // 337/330, moved by the 2026-08-15 rebuild, the 2026-08-17 paired alignments
  // and the 2026-08-18 gap repairs (−4 strokes net, including the stale
  // 函館線-4 duplicate). The rule is
  // unchanged and the loop below is what enforces it: every line without a
  // package badge must resolve to its OWN operator's mark. That is why a split
  // part now inherits its parent railway's badge — 京王線-2 and its kind
  // otherwise fell through to an operator mark those railways do not have.
  // 総武線-3 adds one operator-fallback stroke without adding an operator.
  // 336/329 on 2026-08-19: 東北線-7 is no longer produced — its 王子–上中里
  // track is 東北線-6 now. The operator count holds: JR East keeps every other
  // 東北線 stroke.
  // 335/328 on 2026-08-20: 函館線's two halves join into one railway once the
  // 苗穂 junction point stops rounding into two NODE_DP cells, so the 砂原支線
  // renumbers -3 → -2 and one badge-less stroke leaves the package — one fewer
  // line without a package badge, and one fewer resolving to its operator mark.
  // JR Hokkaido keeps its other strokes, so the operator count holds at 124, and
  // the 381 audited package badges are untouched: none of the lines involved
  // carried one.
  assert.equal(missingBadgeLines.length, 335);
  assert.equal(new Set(missingBadgeLines.map((line) => line.operator)).size, 124);
  assert.equal(coveredLines.length, 320);
  for (const line of coveredLines) {
    const logo = branding.operatorLogo(line.operator);
    assert.match(
      logo,
      /^\/rail\/(?:operator-logos\/(?:jp|jp-badges)|logos)\//,
      line.operator,
    );
    assert.equal(
      fs.existsSync(path.join(PUBLIC_DIR, logo.replace(/^\//, ""))),
      true,
      `${line.operator} asset exists`,
    );
    if (logo.startsWith("/rail/logos/")) {
      const sourceLineId = path.basename(logo, path.extname(logo));
      const sourceLine = JAPAN_NETWORK.lines.find(
        (entry) => entry.id === sourceLineId,
      );
      assert.equal(
        sourceLine?.operator,
        line.operator,
        `${line.operator} may reuse only its own company mark`,
      );
    }
    assert.equal(branding.logoForLine({ ...line, lineId: line.id }), logo);
  }

  const replacedWrongAssets = new Map([
    [
      "jp-四日市あすなろう鉄道-内部線",
      "/rail/operator-logos/jp-badges/badge-019.png",
    ],
    ["jp-養老鉄道-養老線", "/rail/operator-logos/jp/yoro-railway.webp"],
    ["jp-伊賀鉄道-伊賀線", "/rail/operator-logos/jp-badges/badge-009.png"],
    [
      "jp-筑波観光鉄道-筑波山鋼索鉄道線",
      "/rail/operator-logos/jp-badges/badge-025.png",
    ],
  ]);
  for (const [lineId, expected] of replacedWrongAssets) {
    const line = JAPAN_NETWORK.lines.find((entry) => entry.id === lineId);
    const legacyWrongAsset = `/rail/logos/${lineId}.png`;
    assert.equal(
      branding.logoForLine({ ...line, lineId, logo: legacyWrongAsset }),
      expected,
      lineId,
    );
    assert.notEqual(expected, legacyWrongAsset, lineId);
  }

  for (const lineId of [
    "jp-東日本旅客鉄道-常磐線",
    "jp-東日本旅客鉄道-中央線",
    "jp-東日本旅客鉄道-東北線",
    "jp-西日本旅客鉄道-山陽線",
    "jp-西日本旅客鉄道-関西線",
    "jp-九州旅客鉄道-鹿児島線",
    "jp-九州旅客鉄道-山陽線",
  ]) {
    const line = JAPAN_NETWORK.lines.find((entry) => entry.id === lineId);
    assert.equal(
      branding.logoForLine({
        ...line,
        lineId,
        logo: `/rail/logos/${lineId}.png`,
      }),
      branding.operatorLogo(line.operator),
      `${lineId} regional code is not valid over the package's full line`,
    );
  }

  // Neither operator publishes a distinct company mark. Keep the established
  // color swatch instead of fabricating a logo or borrowing another company’s.
  assert.equal(branding.operatorLogo("万葉線"), null);
  assert.equal(branding.operatorLogo("鞍馬寺"), null);
});

test("Japanese operator logo sources are auditable and render in hover popup", () => {
  const { popup, branding } = loadPopup();
  const downloaded = JAPAN_MANIFEST.filter((entry) => entry.status === "downloaded");
  assert.equal(downloaded.length, 89);
  assert.deepEqual(
    JAPAN_MANIFEST.filter((entry) => entry.status !== "downloaded").map(
      (entry) => entry.operator,
    ),
    ["万葉線", "鞍馬寺"],
  );
  for (const entry of downloaded) {
    assert.match(entry.sourcePage, /^https?:\/\//, `${entry.operator} source`);
    const sourcePath = path.join(
      PUBLIC_DIR,
      "rail",
      "operator-logos",
      "jp",
      entry.asset,
    );
    const runtimeAsset = JAPAN_BADGE_BY_OPERATOR.get(entry.operator)?.runtimeAsset;
    assert.ok(runtimeAsset, `${entry.operator} has a runtime audit decision`);
    assert.equal(branding.operatorLogo(entry.operator), runtimeAsset);
    assert.equal(fs.existsSync(sourcePath), true, `${entry.asset} source exists`);
    assert.equal(
      fs.existsSync(path.join(PUBLIC_DIR, runtimeAsset.replace(/^\//, ""))),
      true,
      `${entry.operator} runtime asset exists`,
    );

    const bytes = fs.readFileSync(sourcePath);
    const signature = bytes.subarray(0, 8).toString("hex");
    const validSignature =
      (entry.asset.endsWith(".svg") &&
        /<svg\b/.test(bytes.subarray(0, 2048).toString("utf8"))) ||
      (entry.asset.endsWith(".png") && signature === "89504e470d0a1a0a") ||
      (entry.asset.endsWith(".jpg") && signature.startsWith("ffd8ff")) ||
      (entry.asset.endsWith(".gif") && bytes.subarray(0, 3).toString() === "GIF") ||
      (entry.asset.endsWith(".webp") &&
        bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WEBP");
    assert.equal(validSignature, true, `${entry.asset} is a real image asset`);
  }

  const lineId = "jr-east-without-line-badge";
  const stationId = `${lineId}:station`;
  const network = {
    lineById: new Map([
      [
        lineId,
        {
          lineId,
          operator: "東日本旅客鉄道",
          name: "テスト線",
          color: "#00843D",
          logo: null,
        },
      ],
    ]),
    stationById: new Map([
      [stationId, { stationId, stationGroupId: "station", name: "テスト駅" }],
    ]),
    groupMembers: new Map([["station", [{ lineId }]]]),
  };
  const model = popup.buildPopupModel(network, stationId);
  assert.equal(model.lines[0].company, "JR東日本");
  assert.equal(model.lines[0].logo, "/rail/operator-logos/jp/q499071.svg");
  assert.match(popup.stationPopupHtml(model), /class="rp-line-logo"/);
});

test("Japanese operator fallbacks prefer badge-only crops and retain unavoidable wordmarks", () => {
  const { branding } = loadPopup();
  assert.equal(JAPAN_BADGE_AUDIT.length, 122);
  assert.equal(
    JAPAN_BADGE_AUDIT.filter((entry) => entry.mode === "cropped-emblem").length,
    33,
  );
  assert.equal(
    JAPAN_BADGE_AUDIT.filter((entry) => entry.mode === "original-emblem").length,
    65,
  );
  assert.equal(
    JAPAN_BADGE_AUDIT.filter((entry) => entry.mode === "original-wordmark").length,
    24,
  );

  for (const entry of JAPAN_BADGE_AUDIT) {
    assert.equal(branding.operatorLogo(entry.operator), entry.runtimeAsset, entry.operator);
    const runtimePath = path.join(PUBLIC_DIR, entry.runtimeAsset.replace(/^\//, ""));
    assert.equal(fs.existsSync(runtimePath), true, `${entry.operator} runtime asset exists`);
    if (entry.mode === "original-wordmark") {
      assert.equal(entry.runtimeAsset, entry.sourceAsset, `${entry.operator} keeps original`);
      assert.match(entry.reason, /retained instead of a color swatch/);
    }
    if (entry.mode === "cropped-emblem") {
      assert.notEqual(entry.runtimeAsset, entry.sourceAsset, `${entry.operator} uses crop`);
      const png = fs.readFileSync(runtimePath);
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.ok(png.readUInt32BE(16) <= 256, `${entry.operator} crop width`);
      assert.ok(png.readUInt32BE(20) <= 128, `${entry.operator} crop height`);
    }
  }
});

test("Sapporo and Hakodate trams use their passenger-facing municipal transit marks", () => {
  const { branding } = loadPopup();
  const sapporoOperator = "一般社団法人札幌市交通事業振興公社";
  const hakodateOperator = "函館市";
  assert.equal(branding.companyLabel(sapporoOperator), "札幌市電");
  assert.equal(branding.companyLabel(hakodateOperator), "函館市電");
  assert.equal(
    branding.operatorLogo(sapporoOperator),
    "/rail/operator-logos/jp-badges/badge-012.png",
  );
  assert.equal(
    branding.operatorLogo(hakodateOperator),
    "/rail/operator-logos/jp-badges/badge-028.png",
  );

  const sapporoAudit = JAPAN_BADGE_BY_OPERATOR.get(sapporoOperator);
  const hakodateAudit = JAPAN_BADGE_BY_OPERATOR.get(hakodateOperator);
  assert.equal(sapporoAudit.sourcePage, "https://www.city.sapporo.jp/st/");
  assert.match(sapporoAudit.reason, /ST mark rather than.*corporate mark/);
  assert.equal(
    hakodateAudit.sourcePage,
    "https://www.city.hakodate.hokkaido.jp/tram/",
  );

  const sapporoBadge = fs.readFileSync(
    path.join(PUBLIC_DIR, "rail", "operator-logos", "jp-badges", "badge-012.png"),
  );
  assert.equal(sapporoBadge.readUInt32BE(16), 56);
  assert.equal(sapporoBadge.readUInt32BE(20), 47);
});

test("official light-on-dark Japanese marks receive a readable popup matte", () => {
  const { popup, branding } = loadPopup();
  const lightMarks = [
    "/rail/operator-logos/jp-badges/badge-011.png",
    "/rail/operator-logos/jp/q7496602.png",
    "/rail/operator-logos/jp/q11657221.svg",
  ];
  for (const logo of lightMarks) {
    assert.equal(
      branding.logoNeedsDarkMatte(logo),
      true,
      logo,
    );
  }
  assert.equal(
    branding.logoNeedsDarkMatte("/rail/operator-logos/jp/q499071.svg"),
    false,
  );

  const lineId = "asa-coast";
  const stationId = `${lineId}:station`;
  const network = {
    lineById: new Map([
      [
        lineId,
        {
          lineId,
          operator: "阿佐海岸鉄道",
          name: "阿佐東線",
          color: "#00A0C6",
          logo: null,
        },
      ],
    ]),
    stationById: new Map([
      [stationId, { stationId, stationGroupId: "station", name: "テスト駅" }],
    ]),
    groupMembers: new Map([["station", [{ lineId }]]]),
  };
  const model = popup.buildPopupModel(network, stationId);
  assert.equal(model.lines[0].logoNeedsDarkMatte, true);
  assert.match(popup.stationPopupHtml(model), /rp-line-logo--dark-matte/);
});

test("Nippori lists the split Tohoku railway once", () => {
  const { popup } = loadPopup();
  const nipporiStrokes = JAPAN_NETWORK.lines.filter(
    (line) =>
      line.operator === "東日本旅客鉄道" &&
      line.name === "東北線" &&
      line.stations.some((station) => station[1] === "日暮里"),
  );
  // Two since 2026-08-19: the 電車線 stroke that ends 西日暮里→日暮里→上野 and
  // the 尾久 支線 stroke that arrives 尾久→日暮里. The third used to be the
  // 王子—日暮里 pseudo-edge's own stroke, which drew the same 支線 a second
  // time; what the popup has to prove is that several strokes of ONE railway
  // list once, and two prove it.
  assert.ok(nipporiStrokes.length >= 2, "fixture no longer exercises split strokes");

  const stationId = `${nipporiStrokes[0].id}:nippori`;
  const lineById = new Map(
    nipporiStrokes.map((line) => [
      line.id,
      {
        ...line,
        lineId: line.id,
        logo: line.logo ? `/rail/logos/${line.id.replace(/(?:-p?\d+)+$/, "")}.png` : null,
      },
    ]),
  );
  const network = {
    lineById,
    stationById: new Map([
      [stationId, { stationId, stationGroupId: "nippori", name: "日暮里" }],
    ]),
    groupMembers: new Map([
      ["nippori", nipporiStrokes.map((line) => ({ lineId: line.id }))],
    ]),
  };

  const model = popup.buildPopupModel(network, stationId);
  assert.equal(model.lines.length, 1);
  assert.equal(model.lines[0].label, "東北線");
});
