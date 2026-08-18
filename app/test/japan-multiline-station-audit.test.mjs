import assert from "node:assert/strict";
import test from "node:test";

import { buildAudit } from "../scripts/validation/audit-japan-multiline-stations.mjs";

let auditPromise;
const audit = () => (auditPromise ||= Promise.resolve().then(() => buildAudit()));

test("every discovered Japanese multi-line station satisfies the render-junction contract", async () => {
  const report = await audit();
  assert.equal(report.summary.physical_station_groups_in_package, 9039);
  assert.equal(report.summary.multi_display_line_groups, 880);
  assert.ok(report.summary.audited_station_groups >= report.summary.multi_display_line_groups);
  assert.equal(report.summary.fix_required, 0);
  assert.equal(report.summary.stored_lanes_equal_pure_recomputation, true);
  assert.equal(
    report.summary.stored_lane_rows,
    report.summary.recomputed_lane_rows,
  );

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
      assert.equal(relationship.lane_equal, true);
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
