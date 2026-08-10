"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

function loadPopup() {
  const win = {
    console,
    RailNetwork: { DEFAULT_LINE_COLOR: "#7C8A82" },
  };
  win.window = win;
  const context = vm.createContext(win);
  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, "app-operator-branding.js"), "utf8"),
    context,
    { filename: "app-operator-branding.js" },
  );
  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, "railmap-popup.js"), "utf8"),
    context,
    { filename: "railmap-popup.js" },
  );
  return { popup: win.RailMapPopup, branding: win.RailOperatorBranding };
}

const TAIWAN_OPERATORS = [
  ["國營臺灣鐵路股份有限公司", "台鐵", "tra.svg"],
  ["台灣高速鐵路股份有限公司", "台灣高鐵", "thsr.svg"],
  ["臺北大眾捷運股份有限公司", "台北捷運", "trtc-badge.png"],
  ["新北大眾捷運股份有限公司", "新北捷運", "ntmetro.svg"],
  ["桃園大眾捷運股份有限公司", "桃園捷運", "tym.png"],
  ["臺中捷運股份有限公司", "台中捷運", "tcmrt.svg"],
  ["高雄捷運股份有限公司", "高雄捷運", "krtc-badge.png"],
  ["阿里山林業鐵路及文化資產管理處", "阿里山林鐵", "alsr-badge.png"],
];

test("Taiwan hover popup uses short operator names and company-logo fallbacks", () => {
  const { popup } = loadPopup();
  const stationId = "line-0:station";
  const lineById = new Map();
  const members = [];

  TAIWAN_OPERATORS.forEach(([operator], index) => {
    const lineId = `line-${index}`;
    lineById.set(lineId, {
      lineId,
      operator,
      name: `測試線${index}`,
      color: "#123456",
      logo: null,
    });
    members.push({ lineId });
  });

  const network = {
    lineById,
    stationById: new Map([
      [stationId, { stationId, stationGroupId: "station", name: "測試站" }],
    ]),
    groupMembers: new Map([["station", members]]),
  };
  const model = popup.buildPopupModel(network, stationId);
  const byCompany = new Map(model.lines.map((line) => [line.company, line]));

  for (const [operator, shortName, asset] of TAIWAN_OPERATORS) {
    assert.equal(popup.companyLabel(operator), shortName);
    assert.equal(
      byCompany.get(shortName).logo,
      `/rail/operator-logos/${asset}`,
    );
    assert.equal(
      fs.existsSync(path.join(PUBLIC_DIR, "rail", "operator-logos", asset)),
      true,
      `${asset} exists`,
    );
  }

  const html = popup.stationPopupHtml(model);
  assert.equal((html.match(/class="rp-line-logo"/g) || []).length, 8);
  assert.match(html, />台鐵<\/span>/);
  assert.match(html, />台灣高鐵<\/span>/);
  assert.match(html, />台北捷運<\/span>/);
});

test("every Taiwan operator fallback is an emblem-only asset", () => {
  const { branding } = loadPopup();
  const expectedDimensions = new Map([
    ["trtc-badge.png", [243, 128]],
    ["krtc-badge.png", [131, 87]],
    ["alsr-badge.png", [149, 128]],
  ]);

  for (const [operator, , asset] of TAIWAN_OPERATORS) {
    assert.equal(branding.operatorLogo(operator), `/rail/operator-logos/${asset}`);
    const content = fs.readFileSync(path.join(PUBLIC_DIR, "rail", "operator-logos", asset));
    if (asset.endsWith(".svg")) {
      assert.doesNotMatch(content.toString("utf8"), /<text\b/i, `${asset} has embedded text`);
      continue;
    }
    assert.deepEqual([...content.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    if (expectedDimensions.has(asset)) {
      assert.deepEqual(
        [content.readUInt32BE(16), content.readUInt32BE(20)],
        expectedDimensions.get(asset),
        `${asset} badge crop dimensions`,
      );
    }
  }
});

const TAIWAN_LINE_LOGOS = [
  ["tw-trtc-bl", "trtc-bl.svg"],
  ["tw-trtc-r", "trtc-r.svg"],
  ["tw-trtc-r-xinbeitou", "trtc-r.svg"],
  ["tw-trtc-g", "trtc-g.svg"],
  ["tw-trtc-g-xiaobitan", "trtc-g.svg"],
  ["tw-trtc-o-luzhou", "trtc-o.svg"],
  ["tw-trtc-o-huilong", "trtc-o.svg"],
  ["tw-trtc-br", "trtc-br.svg"],
  ["tw-trtc-y", "ntmetro-y.svg"],
  ["tw-ntmetro-v-green", "ntmetro-v.svg"],
  ["tw-ntmetro-v-blue", "ntmetro-v.svg"],
  ["tw-ntmetro-k", "ntmetro-k.svg"],
  ["tw-tym-a", "tym-a.svg"],
  ["tw-tcmrt-g", "tcmrt-g.svg"],
  ["tw-krtc-r", "krtc-r.svg"],
  ["tw-krtc-o", "krtc-o.svg"],
  ["tw-klrt-c", "krtc-c.svg"],
];

test("Taiwan metro lines prefer their dedicated line badge", () => {
  const { branding } = loadPopup();
  for (const [lineId, asset] of TAIWAN_LINE_LOGOS) {
    assert.equal(branding.lineLogo(lineId), `/rail/line-logos/${asset}`);
    assert.equal(
      fs.existsSync(path.join(PUBLIC_DIR, "rail", "line-logos", asset)),
      true,
      `${asset} exists`,
    );
  }

  assert.equal(
    branding.logoForLine({
      lineId: "tw-trtc-bl",
      operator: "臺北大眾捷運股份有限公司",
    }),
    "/rail/line-logos/trtc-bl.svg",
  );
  assert.equal(
    branding.logoForLine({
      lineId: "tw-tra-western-north",
      operator: "國營臺灣鐵路股份有限公司",
    }),
    "/rail/operator-logos/tra.svg",
  );
  assert.equal(
    branding.logoForLine({
      lineId: "custom",
      operator: "臺北大眾捷運股份有限公司",
      logo: "/rail/logos/custom.png",
    }),
    "/rail/logos/custom.png",
  );
});

test("Taiwan company names normalize to passenger-facing short names", () => {
  const { branding } = loadPopup();
  assert.equal(
    branding.normalizeTaiwanCompanyName("國營臺灣鐵路股份有限公司"),
    "台鐵",
  );
  assert.equal(
    branding.normalizeTaiwanCompanyName(
      "臺北大眾捷運股份有限公司/台灣高速鐵路股份有限公司",
    ),
    "台北捷運/台灣高鐵",
  );
  assert.equal(
    branding.companyLabel("農業部阿里山林業鐵路及文化資產管理處"),
    "阿里山林鐵",
  );

  const thsrSvg = fs.readFileSync(
    path.join(PUBLIC_DIR, "rail", "operator-logos", "thsr.svg"),
    "utf8",
  );
  assert.doesNotMatch(thsrSvg, /<(?:rect|image)\b/i);
});
