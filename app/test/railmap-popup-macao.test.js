"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const RailNetwork = require("../public/rail-network.js");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MACAO_NETWORK = JSON.parse(
  fs.readFileSync(path.join(PUBLIC_DIR, "rail", "mo-2025.json"), "utf8"),
);
const LOGO = "/rail/operator-logos/macao-lrt-badge.png";

function loadBrandingAndPopup() {
  const win = { console, RailNetwork };
  win.window = win;
  const context = vm.createContext(win);
  for (const filename of ["app-operator-branding.js", "railmap-popup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, filename), "utf8"), context, { filename });
  }
  return { branding: win.RailOperatorBranding, popup: win.RailMapPopup };
}

test("Macao LRT names and official operator logo cover every line", () => {
  const { branding } = loadBrandingAndPopup();
  for (const alias of [
    "澳門輕軌",
    "澳门轻轨",
    "澳門輕軌股份有限公司",
    "澳门轻轨股份有限公司",
    "Macao Light Rapid Transit Corporation, Limited",
    "Macao LRT",
  ]) {
    assert.equal(branding.companyLabel(alias), "澳門輕軌", alias);
    assert.equal(branding.operatorLogo(alias), LOGO, alias);
  }

  const logo = fs.readFileSync(path.join(PUBLIC_DIR, LOGO));
  assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(logo.readUInt32BE(16), 90);
  assert.equal(logo.readUInt32BE(20), 65);
  assert.ok(MACAO_NETWORK.lines.every((line) => line.operator === "澳門輕軌"));
  assert.ok(MACAO_NETWORK.lines.every((line) => branding.logoForLine(line) === LOGO));
});

test("Macao transfer-station popup renders the official logo and short name per line", () => {
  const { popup } = loadBrandingAndPopup();
  const network = RailNetwork.buildNetworkFromCompactPackage(MACAO_NETWORK);
  const lotus = [...network.stationById.values()].find(
    (station) => station.stationGroupId === "mo-official-mlm-lotus",
  );
  const model = popup.buildPopupModel(network, lotus.stationId);
  assert.equal(model.lines.length, 2);
  assert.ok(model.lines.every((line) => line.company === "澳門輕軌"));
  assert.ok(model.lines.every((line) => line.logo === LOGO));

  const html = popup.stationPopupHtml(model);
  assert.equal((html.match(/class="rp-line-logo/g) || []).length, model.lines.length);
  assert.equal((html.match(/class="rp-line-co">澳門輕軌/g) || []).length, model.lines.length);
});
