import assert from "node:assert/strict";
import test from "node:test";

import { buildAudit } from "../scripts/validation/audit-japan-multiline-stations.mjs";

// osm: false on purpose. The station-zone basemap comparison and the
// duplicate-stroke adjudication both read the machine-local OSM cell cache
// that validate-basemap-alignment.mjs --fetch downloads; CI has no cache, and
// a contract test that changes its scope depending on whether a 118 MB
// download happened is not a contract. Those two live in their own audits
// (audit-duplicate-strokes.mjs, and the basemap columns of audit.csv).
let auditPromise;
const audit = () =>
  (auditPromise ||= Promise.resolve().then(() => buildAudit({ osm: false })));

test("every discovered Japanese multi-line station satisfies the render-junction contract", async () => {
  const report = await audit();
  assert.equal(report.summary.physical_station_groups_in_package, 9039);
  // 881 since 2026-08-19: ユーカリが丘線's 公園 is drawn by two strokes now
  // (the residential ring and the ユーカリが丘 tail meet there), so it enters
  // the multi-line set. 塩尻 was already in it — its count went 3 strokes to 4.
  // 876 on 2026-08-19: 大垣, 伊万里 and 赤羽 are drawn by one stroke each now
  // that the trunks run through them, and 室/西大垣/川東/東山代 lose the
  // sibling stroke that used to double them.
  // 874 on 2026-08-19: 王子 and 東十条 are drawn by one stroke each now that the
  // 電車線 trunk runs through them instead of the 尾久 支線's two skip edges.
  assert.equal(report.summary.multi_display_line_groups, 874);
  assert.ok(report.summary.audited_station_groups >= report.summary.multi_display_line_groups);
  assert.equal(report.summary.fix_required, 0);

  for (const station of report.station_groups) {
    assert.deepEqual(station.validation_errors, [], station.station_name);
    for (const line of station.lines) {
      assert.equal(
        line.exact_adjacent_interval_endpoint,
        true,
        `${station.station_name} ${line.display_line_id} endpoint`,
      );
      assert.ok(
        line.point_to_track_meters <= 0.5,
        `${station.station_name} ${line.display_line_id} point-to-track`,
      );
      assert.equal(
        line.immediate_leave_and_return,
        false,
        `${station.station_name} ${line.display_line_id} immediate return`,
      );
    }
    for (const relationship of station.relationships) {
      if (!relationship.should_share_junction) continue;
      assert.equal(relationship.exact_source_coordinate_equal, true);
      assert.equal(relationship.exact_render_coordinate_equal, true);
      assert.equal(relationship.railway_identity_equal, true);
      if (relationship.classification === "A")
        assert.ok(
          relationship.continuation_tangent_difference_degrees < 5,
          `${station.station_name} ${relationship.lines.join(" ↔ ")} tangent`,
        );
    }
  }
});

test("Tokyo, Sapporo and Nippori are explicit evidence-backed repairs", async () => {
  const report = await audit();
  const fixed = new Map(
    report.fixed_station_groups.map((row) => [row.station_group, row.station_name]),
  );
  assert.equal(fixed.get("003766"), "東京");
  assert.equal(fixed.get("000227"), "札幌");
  assert.equal(fixed.get("003417"), "日暮里");
  assert.equal(
    report.station_groups.some((station) =>
      station.display_line_ids.includes("jp-北海道旅客鉄道-函館線-4"),
    ),
    false,
    "the unreproducible duplicate 鹿部–大沼 stroke must stay pruned",
  );
});
