import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  evaluateAppScripts,
  makeDummyElement,
  makeSandbox,
} from "../scripts/lib/app-family-sandbox.mjs";

test("map starts with ridden routes visible and the complete network optional", () => {
  const context = makeSandbox({
    i18n: { tc: (key) => String(key) },
  });
  evaluateAppScripts(context);

  context.__layerCalls = [];
  context.__mapContainer = makeDummyElement();
  vm.runInContext(
    `
      RailMap.setBasemapMode = () => {};
      RailMap.hasBasemap = () => true;
      RailMap.setVisible = (visible) => __layerCalls.push(["routes", visible]);
      RailMap.setMarkerVisibility = (kind, visible) =>
        __layerCalls.push([kind, visible]);
      RailMap.setNetworkVisible = (visible) =>
        __layerCalls.push(["network", visible]);
      RailMap.setNetworkStationsVisible = (visible) =>
        __layerCalls.push(["network-stations", visible]);
      RailMap.ensureNetwork = () => Promise.resolve();
      map = { getContainer: () => __mapContainer };
      buildMapLayersControl(true);
    `,
    context,
  );

  const calls = JSON.parse(JSON.stringify(context.__layerCalls));
  assert.deepEqual(calls.slice(0, 4), [
    ["routes", true],
    ["stop", true],
    ["terminal", true],
    ["pass", true],
  ]);
  assert.ok(calls.some(([layer, visible]) => layer === "network" && !visible));
  assert.ok(
    calls.some(([layer, visible]) => layer === "network-stations" && !visible),
  );
  assert.equal(
    calls.some(
      ([layer, visible]) =>
        (layer === "network" || layer === "network-stations") && visible,
    ),
    false,
  );
});
