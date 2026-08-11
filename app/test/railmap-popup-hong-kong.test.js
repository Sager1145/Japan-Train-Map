"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const RailNetwork = require("../public/rail-network.js");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const HONG_KONG_NETWORK = JSON.parse(
  fs.readFileSync(path.join(PUBLIC_DIR, "rail", "hk-2025.json"), "utf8"),
);

function loadBrandingAndPopup() {
  const win = { console, RailNetwork };
  win.window = win;
  const context = vm.createContext(win);
  for (const filename of ["app-operator-branding.js", "railmap-popup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, filename), "utf8"), context, { filename });
  }
  return { branding: win.RailOperatorBranding, popup: win.RailMapPopup };
}

const LIGHT_RAIL_BADGES = Object.freeze({
  "hk-mtr-lr-505": "mtr-lr-505.svg",
  "hk-mtr-lr-507": "mtr-lr-507.svg",
  "hk-mtr-lr-610": "mtr-lr-610.svg",
  "hk-mtr-lr-614": "mtr-lr-614.svg",
  "hk-mtr-lr-614p": "mtr-lr-614p.svg",
  "hk-mtr-lr-615": "mtr-lr-615.svg",
  "hk-mtr-lr-615p": "mtr-lr-615p.svg",
  "hk-mtr-lr-705": "mtr-lr-705.svg",
  "hk-mtr-lr-706": "mtr-lr-706.svg",
  "hk-mtr-lr-751": "mtr-lr-751.svg",
  "hk-mtr-lr-761p": "mtr-lr-761p.svg",
});

test("Hong Kong lines use Light Rail route badges and the official MTR fallback", () => {
  const { branding } = loadBrandingAndPopup();
  assert.equal(branding.companyLabel("香港鐵路有限公司"), "MTR");
  assert.equal(branding.companyLabel("MTR"), "MTR");
  assert.equal(branding.operatorLogo("MTR"), "/rail/operator-logos/mtr-badge.png");
  assert.equal(
    fs.existsSync(path.join(PUBLIC_DIR, "rail", "operator-logos", "mtr-badge.png")),
    true,
  );

  for (const line of HONG_KONG_NETWORK.lines.filter((l) => l.operator === "MTR")) {
    const logo = branding.logoForLine({ ...line, lineId: line.id });
    const expected = LIGHT_RAIL_BADGES[line.id]
      ? `/rail/line-logos/${LIGHT_RAIL_BADGES[line.id]}`
      : "/rail/operator-logos/mtr-badge.png";
    assert.equal(logo, expected, `${line.id} logo`);
    assert.equal(fs.existsSync(path.join(PUBLIC_DIR, logo)), true, `${line.id} asset exists`);
  }
});

// Hong Kong Tramways is a second operator in the same package. It has no
// usable emblem to ship, and a fabricated one would be worse than none — so
// its tracks fall back to the popup's line-colour swatch beside a company
// label, and must never be branded as MTR.
test("the tramway carries its own company label and no fabricated emblem", () => {
  const { branding } = loadBrandingAndPopup();
  for (const alias of [
    "香港電車",
    "香港电车",
    "香港電車有限公司",
    "Hongkong Tramways Limited",
    "Hong Kong Tramways",
  ])
    assert.equal(branding.companyLabel(alias), "香港電車", alias);

  const tram = HONG_KONG_NETWORK.lines.filter((line) => line.operator === "香港電車");
  assert.equal(tram.length, 4);
  for (const line of tram) {
    assert.equal(branding.logoForLine({ ...line, lineId: line.id }), null, `${line.id} logo`);
    assert.equal(branding.companyFor(line.operator, line.name), "香港電車", line.id);
  }
});

test("MTR fallback asset contains only the compact emblem", () => {
  const png = fs.readFileSync(path.join(PUBLIC_DIR, "rail", "operator-logos", "mtr-badge.png"));
  assert.equal(png.readUInt32BE(16), 55);
  assert.equal(png.readUInt32BE(20), 47);
});

test("Hong Kong station popup renders a logo and MTR label for every served line", () => {
  const { popup } = loadBrandingAndPopup();
  const network = RailNetwork.buildNetworkFromCompactPackage(HONG_KONG_NETWORK);
  const admiralty = [...network.stationById.values()].find(
    (station) => station.stationGroupId === "hk-official-mtr-adm",
  );
  const model = popup.buildPopupModel(network, admiralty.stationId);
  assert.ok(model.lines.length >= 4);
  assert.ok(model.lines.every((line) => line.company === "MTR" && line.logo));
  const html = popup.stationPopupHtml(model);
  assert.equal((html.match(/class="rp-line-logo/g) || []).length, model.lines.length);
  assert.equal((html.match(/class="rp-line-co">MTR/g) || []).length, model.lines.length);
});
