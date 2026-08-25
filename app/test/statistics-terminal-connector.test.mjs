import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  evaluateAppScripts,
  makeSandbox,
} from "../scripts/lib/app-family-sandbox.mjs";

function collectTerminalConnector(finish) {
  const context = makeSandbox();
  evaluateAppScripts(context);
  context.__finish = finish;
  return vm.runInContext(
    `(() => {
      activeCountry = "jp";
      const a = [139, 35];
      const b = [139.01, 35];
      const feature = {
        type: "Feature",
        properties: {
          train_id: "terminal-tail",
          route_id: "terminal-tail-primary",
          is_primary: true,
          segment_index: 0,
          from: "A",
          to: "B",
        },
        geometry: { type: "LineString", coordinates: [a, b, __finish] },
      };
      matchedRoutesGeoJson = { type: "FeatureCollection", features: [feature] };
      RailMap.canonicalizeRouteFeature = (value) => value;
      const train = {
        id: "terminal-tail",
        stops: [
          { name: "A", ride_segment: true },
          { name: "B", ride_segment: true },
        ],
        route_sections: [{ from: "A", to: "B" }],
      };
      return collectTrainStatsEntry(train, {
        map: new Map([[statsEdgeKey(a, b), 0]]),
        km: [1],
        mask: [5],
      });
    })()`,
    context,
  );
}

test("a short station-anchor tail inherits the edge it leaves", () => {
  const entry = collectTerminalConnector([139.0105, 35]);
  assert.deepEqual(Array.from(entry.edges), [0]);
  assert.equal(entry.spans.length, 1);
  assert.equal(entry.spans[0][2], 5);
});

test("a long terminal departure from the network stays unmatched", () => {
  const entry = collectTerminalConnector([139.1, 35]);
  assert.deepEqual(Array.from(entry.edges), [0]);
  assert.equal(entry.spans.length, 1);
  assert.equal(entry.spans[0][2], 0);
});
