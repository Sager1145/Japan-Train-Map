"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const JAPAN_NETWORK = require(path.join(PUBLIC_DIR, "rail", "jp-2025.json"));
const JAPAN_MANIFEST = require(
  path.join(PUBLIC_DIR, "rail", "operator-logos", "jp", "manifest.json"),
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

test("Japanese package line badges stay ahead of operator-logo fallbacks", () => {
  const { branding } = loadPopup();
  const linesWithBadges = JAPAN_NETWORK.lines.filter((line) => line.logo);

  assert.equal(linesWithBadges.length, 349);
  for (const line of linesWithBadges) {
    const existingLogo = `/rail/logos/${line.id}.png`;
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
});

test("Japanese routes without line badges use verified operator-logo assets", () => {
  const { branding } = loadPopup();
  const missingBadgeLines = JAPAN_NETWORK.lines.filter((line) => !line.logo);
  const unresolvedOperators = new Set(["万葉線", "鞍馬寺"]);
  const coveredLines = missingBadgeLines.filter(
    (line) => !unresolvedOperators.has(line.operator),
  );

  assert.equal(missingBadgeLines.length, 245);
  assert.equal(new Set(missingBadgeLines.map((line) => line.operator)).size, 87);
  assert.equal(coveredLines.length, 242);
  for (const line of coveredLines) {
    const logo = branding.operatorLogo(line.operator);
    assert.match(logo, /^\/rail\/operator-logos\/jp\//, line.operator);
    assert.equal(
      fs.existsSync(path.join(PUBLIC_DIR, logo.replace(/^\//, ""))),
      true,
      `${line.operator} asset exists`,
    );
    assert.equal(branding.logoForLine({ ...line, lineId: line.id }), logo);
  }

  // Neither operator publishes a distinct company mark. Keep the established
  // color swatch instead of fabricating a logo or borrowing another company’s.
  assert.equal(branding.operatorLogo("万葉線"), null);
  assert.equal(branding.operatorLogo("鞍馬寺"), null);
});

test("Japanese operator logo sources are auditable and render in hover popup", () => {
  const { popup, branding } = loadPopup();
  const downloaded = JAPAN_MANIFEST.filter((entry) => entry.status === "downloaded");
  assert.equal(downloaded.length, 85);
  assert.deepEqual(
    JAPAN_MANIFEST.filter((entry) => entry.status !== "downloaded").map(
      (entry) => entry.operator,
    ),
    ["万葉線", "鞍馬寺"],
  );
  for (const entry of downloaded) {
    assert.match(entry.sourcePage, /^https?:\/\//, `${entry.operator} source`);
    const expectedAsset = `/rail/operator-logos/jp/${entry.asset}`;
    const assetPath = path.join(
      PUBLIC_DIR,
      "rail",
      "operator-logos",
      "jp",
      entry.asset,
    );
    assert.equal(branding.operatorLogo(entry.operator), expectedAsset);
    assert.equal(fs.existsSync(assetPath), true, `${entry.asset} exists`);

    const bytes = fs.readFileSync(assetPath);
    const signature = bytes.subarray(0, 8).toString("hex");
    const validSignature =
      (entry.asset.endsWith(".svg") &&
        /<svg\b/.test(bytes.subarray(0, 2048).toString("utf8"))) ||
      (entry.asset.endsWith(".png") && signature === "89504e470d0a1a0a") ||
      (entry.asset.endsWith(".jpg") && signature.startsWith("ffd8ff")) ||
      (entry.asset.endsWith(".gif") && bytes.subarray(0, 3).toString() === "GIF");
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

test("official light-on-dark Japanese marks receive a readable popup matte", () => {
  const { popup, branding } = loadPopup();
  const lightMarks = [
    "seikan-tunnel-museum.png",
    "q7496602.png",
    "q11650435.png",
    "q11657221.svg",
  ];
  for (const asset of lightMarks) {
    assert.equal(
      branding.logoNeedsDarkMatte(`/rail/operator-logos/jp/${asset}`),
      true,
      asset,
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
