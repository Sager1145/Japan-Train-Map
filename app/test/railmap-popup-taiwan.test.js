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
  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, "railmap-popup.js"), "utf8"),
    vm.createContext(win),
    { filename: "railmap-popup.js" },
  );
  return win.RailMapPopup;
}

const TAIWAN_OPERATORS = [
  ["國營臺灣鐵路股份有限公司", "台鐵", "tra.svg"],
  ["台灣高速鐵路股份有限公司", "台灣高鐵", "thsr.jpg"],
  ["臺北大眾捷運股份有限公司", "台北捷運", "trtc.svg"],
  ["新北大眾捷運股份有限公司", "新北捷運", "ntmetro.svg"],
  ["桃園大眾捷運股份有限公司", "桃園捷運", "tym.png"],
  ["臺中捷運股份有限公司", "台中捷運", "tcmrt.svg"],
  ["高雄捷運股份有限公司", "高雄捷運", "krtc.svg"],
  ["阿里山林業鐵路及文化資產管理處", "阿里山林鐵", "alsr.svg"],
];

test("Taiwan hover popup uses short operator names and shared company logos", () => {
  const popup = loadPopup();
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
