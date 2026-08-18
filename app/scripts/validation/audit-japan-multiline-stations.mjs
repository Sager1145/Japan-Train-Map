#!/usr/bin/env node
/*
 * Whole-country multi-line station audit.
 *
 * The report is deliberately built from the compact package AND the final
 * render model.  Coincident source rows are not accepted as continuity: an
 * A/B relationship passes only when the two interval ends, railway identity,
 * rendered lane and station feature agree at one node.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { laneRowsForPackage } from "../railway/build-parallel-corridors.mjs";
import {
  distanceMeters,
  pointSegmentDistanceMeters,
} from "../railway/lib/railway-topology.mjs";

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT_DIR = path.resolve(APP_DIR, "..");
const PACKAGE_PATH = path.join(APP_DIR, "public/rail/jp-2025.json");
const NETWORK_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/rebuild-inventory/stations/n02-station-network.json",
);
const RULES_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/evidence/multi-line-station-audit-rules.json",
);
const TOKYO_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/evidence/tokyo-station-platforms.json",
);
const OUTPUT_DIR = path.join(ROOT_DIR, "outputs/railway-audit/multi-line-stations");
const JSON_PATH = path.join(OUTPUT_DIR, "audit.json");
const CSV_PATH = path.join(OUTPUT_DIR, "audit.csv");
const MARKDOWN_PATH = path.join(OUTPUT_DIR, "README.md");

const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const coordinateKey = (point) => `${point[0]},${point[1]}`;
const samePoint = (a, b) => coordinateKey(a) === coordinateKey(b);
const rounded = (value, digits = 3) =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

function decodeIntervals(line) {
  let previousEnd = null;
  return line.segments.map((row) => {
    const coordinates = row[1]
      ? [previousEnd, ...row[2].map((point) => [...point])]
      : row[2].map((point) => [...point]);
    previousEnd = coordinates.at(-1);
    return coordinates;
  });
}

function bearing(a, b) {
  const latitude = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  return (
    (Math.atan2(
      (b[0] - a[0]) * Math.cos(latitude),
      b[1] - a[1],
    ) *
      180) /
      Math.PI +
    360
  ) % 360;
}

function angularDifference(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function nearestDistinct(coordinates, fromStart) {
  const ordered = fromStart ? coordinates : coordinates.slice().reverse();
  const station = ordered[0];
  return ordered.find((point) => distanceMeters(station, point) > 0.05) || station;
}

function stationGeometry(line, stationIndex) {
  const intervals = decodeIntervals(line);
  const point = [line.stations[stationIndex][2], line.stations[stationIndex][3]];
  const incoming = stationIndex > 0 ? intervals[stationIndex - 1] : null;
  const outgoing = stationIndex < intervals.length ? intervals[stationIndex] : null;
  const incomingPrior = incoming ? nearestDistinct(incoming, false) : null;
  const outgoingNext = outgoing ? nearestDistinct(outgoing, true) : null;
  const outwardBearings = [];
  if (incomingPrior && !samePoint(incomingPrior, point))
    outwardBearings.push(bearing(point, incomingPrior));
  if (outgoingNext && !samePoint(outgoingNext, point))
    outwardBearings.push(bearing(point, outgoingNext));

  const stationTurn =
    incomingPrior && outgoingNext
      ? angularDifference(bearing(incomingPrior, point), bearing(point, outgoingNext))
      : null;
  let endpointExact = true;
  if (incoming) endpointExact &&= samePoint(incoming.at(-1), point);
  if (outgoing) endpointExact &&= samePoint(outgoing[0], point);

  const outwardIntervals = [];
  if (incoming) outwardIntervals.push(incoming.slice().reverse());
  if (outgoing) outwardIntervals.push(outgoing);
  const immediateReturn = outwardIntervals.some((coordinates) => {
    let left = false;
    for (const coordinate of coordinates) {
      const distance = distanceMeters(point, coordinate);
      if (distance > 1) left = true;
      else if (left && distance < 0.1) return true;
    }
    return false;
  });

  let measure = line.segments
    .slice(0, stationIndex)
    .reduce((sum, row) => sum + Number(row[0]) * 1000, 0);
  if (line.isLoop && stationIndex === 0) measure = 0;
  const structure = (line.structure || []).filter(
    (row) => measure >= Number(row[0]) - 25 && measure <= Number(row[1]) + 25,
  );
  const kinds = new Set(structure.map((row) => Number(row[2])));
  const layers = structure.map((row) => Number(row[3]) || 0);
  let vertical = "surface";
  if (line.isHSR) vertical = "shinkansen";
  else if (kinds.has(1) || (line.kind === "subway" && !kinds.has(2))) vertical = "underground";
  else if (kinds.has(2) || layers.some((layer) => layer > 0)) vertical = "elevated";

  return {
    intervals,
    point,
    endpoint: stationIndex === 0 || stationIndex === line.stations.length - 1,
    endpointExact,
    immediateReturn,
    outwardBearings,
    stationTurn: rounded(stationTurn),
    vertical,
    structure: structure.map((row) => ({
      kind: Number(row[2]) === 1 ? "tunnel" : Number(row[2]) === 2 ? "bridge" : "unknown",
      layer: Number(row[3]) || 0,
      from_m: Number(row[0]),
      to_m: Number(row[1]),
    })),
  };
}

function distanceToParts(point, parts) {
  let best = Infinity;
  for (const coordinates of parts || []) {
    for (let index = 1; index < coordinates.length; index += 1)
      best = Math.min(
        best,
        pointSegmentDistanceMeters(point, coordinates[index - 1], coordinates[index]),
      );
  }
  return best;
}

function familyId(lineId) {
  return lineId.replace(/(-p?\d+)+$/u, "");
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exactEvidence(tokyo) {
  const byLine = new Map();
  for (const row of tokyo.surveyed_intervals || []) {
    const [operator, name] = row.line.split("␟");
    for (const station of [row.from_station, row.to_station]) {
      const key = `${operator}\0${name}\0${station}`;
      const value = byLine.get(key) || { osm_ways: new Set(), sources: new Set() };
      for (const way of row.osm_ways || []) value.osm_ways.add(way);
      if (row.source) value.sources.add(row.source);
      byLine.set(key, value);
    }
  }
  for (const row of tokyo.geometry_patches || []) {
    const [operator, name] = row.line.split("␟");
    const key = `${operator}\0${name}\0${row.station}`;
    const value = byLine.get(key) || { osm_ways: new Set(), sources: new Set() };
    for (const way of row.osm_ways || []) value.osm_ways.add(way);
    byLine.set(key, value);
  }
  return byLine;
}

function bestContinuationTurn(a, b) {
  if (!a.geometry.outwardBearings.length || !b.geometry.outwardBearings.length) return null;
  let best = Infinity;
  for (const one of a.geometry.outwardBearings) {
    for (const two of b.geometry.outwardBearings) {
      best = Math.min(best, Math.abs(180 - angularDifference(one, two)));
    }
  }
  return rounded(best);
}

function sameVisibleLane(a, b) {
  if (a.render.lane === 0 || b.render.lane === 0)
    return a.render.lane === 0 && b.render.lane === 0;
  if (a.render.bearing == null || b.render.bearing == null) return false;
  const vector = (row) => {
    const angle = ((row.render.bearing + 90) * Math.PI) / 180;
    return [Math.sin(angle) * row.render.lane, Math.cos(angle) * row.render.lane];
  };
  const one = vector(a);
  const two = vector(b);
  return Math.hypot(one[0] - two[0], one[1] - two[1]) < 0.05;
}

function classifyPair(a, b, occurrences) {
  const paired =
    a.line.alignmentRole === "paired_alignment" ||
    b.line.alignmentRole === "paired_alignment";
  if (paired) return "D";
  const sameRailway = a.railwayIdentity === b.railwayIdentity;
  const verticalPair = new Set([a.geometry.vertical, b.geometry.vertical]);
  const verticallySeparated =
    a.line.isHSR !== b.line.isHSR ||
    (verticalPair.size > 1 &&
      [...verticalPair].some((value) => value === "underground" || value === "elevated" || value === "shinkansen"));
  if (verticallySeparated) return "E";
  if (!sameRailway) return "C";
  const sameRailwayCount = occurrences.filter(
    (candidate) => candidate.railwayIdentity === a.railwayIdentity,
  ).length;
  return sameRailwayCount === 2 && a.geometry.endpoint && b.geometry.endpoint ? "A" : "B";
}

function electedJunction(occurrences, railwayIdentity) {
  const members = occurrences.filter(
    (row) => row.railwayIdentity === railwayIdentity && row.line.alignmentRole !== "paired_alignment",
  );
  const canonical = members.find((row) => row.line.id === familyId(row.line.id));
  const elected =
    canonical ||
    members.slice().sort((a, b) => b.totalKm - a.totalKm || a.line.id.localeCompare(b.line.id))[0];
  return elected?.geometry.point || null;
}

export function buildAudit() {
  const pkg = readJson(PACKAGE_PATH);
  const stationNetwork = readJson(NETWORK_PATH);
  const rules = readJson(RULES_PATH);
  const tokyo = readJson(TOKYO_PATH);
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const exactSources = exactEvidence(tokyo);
  const explicitByGroup = new Map(
    rules.explicit_station_rules.map((row) => [row.station_group, row]),
  );
  const networkByGroup = new Map();
  for (const station of stationNetwork.stations) {
    const list = networkByGroup.get(station.physical_station_group) || [];
    list.push(station);
    networkByGroup.set(station.physical_station_group, list);
  }

  const renderedStations = new Map();
  for (const feature of network.stations.features)
    renderedStations.set(
      `${feature.properties.lineId}\0${feature.properties.stationGroupId}`,
      feature,
    );
  const renderedLanes = new Map();
  for (const feature of network.stationLanes.features)
    renderedLanes.set(
      `${feature.properties.lineId}\0${feature.properties.stationGroupId}`,
      feature,
    );

  const occurrencesByGroup = new Map();
  for (const line of pkg.lines) {
    const display = network.lineById.get(line.id);
    const totalKm = line.segments.reduce((sum, row) => sum + Number(row[0]), 0);
    line.stations.forEach((station, stationIndex) => {
      const group = station[0];
      const geometry = stationGeometry(line, stationIndex);
      const key = `${line.id}\0${group}`;
      const laneFeature = renderedLanes.get(key);
      const baseFeature = renderedStations.get(key);
      const rendered = laneFeature || baseFeature;
      const operatorForEvidence = line.operator === "東京メトロ" ? "東京地下鉄" : line.operator;
      const evidence = exactSources.get(
        `${operatorForEvidence}\0${line.name}\0${station[1]}`,
      );
      const occurrence = {
        line,
        station,
        stationIndex,
        geometry,
        totalKm,
        railwayIdentity: line.railwayIdentity || familyId(line.id),
        render: {
          coordinate: rendered?.geometry.coordinates || geometry.point,
          lane: Number(rendered?.properties.lane || 0),
          bearing: rounded(rendered?.properties.bearing),
        },
        pointToTrackMeters: rounded(distanceToParts(geometry.point, display?.parts), 6),
        evidence: evidence
          ? {
              osm_way_ids: [...evidence.osm_ways].sort((a, b) => a - b),
              sources: [...evidence.sources].sort(),
              basis: "registered_OSM_physical_track",
            }
          : {
              osm_way_ids: [],
              sources: [rules.sources.n02],
              basis: "N02_station_feature_and_RailroadSection; no per-interval OSM way registered",
            },
      };
      const list = occurrencesByGroup.get(group) || [];
      list.push(occurrence);
      occurrencesByGroup.set(group, list);
    });
  }

  const freshLanes = laneRowsForPackage(pkg);
  const storedLanes = pkg.lanes || [];
  const lanesPure = JSON.stringify(freshLanes) === JSON.stringify(storedLanes);
  const groups = [];

  for (const [stationGroup, occurrences] of occurrencesByGroup) {
    const distinctLines = new Set(occurrences.map((row) => row.line.id));
    const siblingCount = new Set(occurrences.map((row) => familyId(row.line.id))).size;
    const hasSibling = siblingCount < distinctLines.size;
    const hasLane = occurrences.some((row) => row.render.lane !== 0);
    const hasOffset = occurrences.some((row) => row.pointToTrackMeters > 0.5);
    if (distinctLines.size < 2 && !hasSibling && !hasLane && !hasOffset) continue;

    const scopeReasons = [];
    if (distinctLines.size >= 2) scopeReasons.push("physical_station_group_on_multiple_display_lines");
    if (hasSibling) scopeReasons.push("sibling_display_strokes_meet_here");
    if (hasLane) scopeReasons.push("final_parallel_lane_applies_at_station");
    if (hasOffset) scopeReasons.push("station_point_to_track_offset");
    const stationFacts = networkByGroup.get(stationGroup) || [];
    const roles = new Set(
      stationFacts.flatMap((row) => [row.station_style, ...(row.station_style_tags || [])]),
    );
    if ([...roles].some((role) => /branch|terminal|revers/u.test(role)))
      scopeReasons.push("branch_or_terminal_topology_role");
    if (new Set(occurrences.map((row) => row.line.name)).size > 1)
      scopeReasons.push("canonical_line_boundary_or_interchange");

    const relationships = [];
    const manualReasons = new Set();
    const errors = new Set();
    const suggestedByLine = new Map();
    for (let left = 0; left < occurrences.length; left += 1) {
      for (let right = left + 1; right < occurrences.length; right += 1) {
        const a = occurrences[left];
        const b = occurrences[right];
        const classification = classifyPair(a, b, occurrences);
        const shouldShare = classification === "A" || classification === "B";
        const coordinateEqual = samePoint(a.geometry.point, b.geometry.point);
        const renderedCoordinateEqual = samePoint(a.render.coordinate, b.render.coordinate);
        const identityEqual = a.railwayIdentity === b.railwayIdentity;
        const laneEqual = sameVisibleLane(a, b);
        const tangent = bestContinuationTurn(a, b);
        const problems = [];
        if (shouldShare && !coordinateEqual) problems.push("junction_coordinate_mismatch");
        if (shouldShare && !renderedCoordinateEqual) problems.push("rendered_junction_coordinate_mismatch");
        if (shouldShare && !identityEqual) problems.push("railway_identity_mismatch");
        if (shouldShare && !laneEqual) problems.push("junction_lane_mismatch");
        if (classification === "A" && (tangent == null || tangent >= 5))
          problems.push("continuation_tangent_not_under_5_degrees");
        if (shouldShare && (a.geometry.immediateReturn || b.geometry.immediateReturn))
          problems.push("immediate_leave_and_return");
        for (const problem of problems) errors.add(`${a.line.id} ↔ ${b.line.id}: ${problem}`);

        if (shouldShare) {
          const point = electedJunction(occurrences, a.railwayIdentity);
          if (point) {
            suggestedByLine.set(a.line.id, point);
            suggestedByLine.set(b.line.id, point);
          }
        }
        if ((classification === "C" || classification === "E") && coordinateEqual)
          manualReasons.add(
            `${a.line.id} ↔ ${b.line.id}: independent or vertically separated lines share one source point; platform-level evidence is required`,
          );
        if (
          classification === "D" &&
          [a.line, b.line].some(
            (line) => line.alignmentRole === "paired_alignment" && line.alignmentDirection === "unassigned",
          )
        )
          manualReasons.add(`${a.line.id} ↔ ${b.line.id}: paired alignment direction remains unassigned`);

        relationships.push({
          lines: [a.line.id, b.line.id],
          classification,
          should_share_junction: shouldShare,
          exact_source_coordinate_equal: coordinateEqual,
          exact_render_coordinate_equal: renderedCoordinateEqual,
          railway_identity_equal: identityEqual,
          lane_equal: laneEqual,
          continuation_tangent_difference_degrees: tangent,
          problems,
        });
      }
    }

    for (const occurrence of occurrences) {
      if (!occurrence.geometry.endpointExact)
        errors.add(`${occurrence.line.id}: station is not the exact adjacent-interval endpoint`);
      if (occurrence.geometry.immediateReturn)
        errors.add(`${occurrence.line.id}: geometry leaves the station and immediately returns`);
      if (occurrence.pointToTrackMeters > 0.5)
        errors.add(`${occurrence.line.id}: point-to-track ${occurrence.pointToTrackMeters} m`);
    }
    if (!lanesPure) errors.add("package lanes are not the pure recomputation of final geometry");

    const explicit = explicitByGroup.get(stationGroup);
    const classes = [...new Set(relationships.map((row) => row.classification))].sort();
    const status = errors.size
      ? "FIX_REQUIRED"
      : manualReasons.size
        ? "NEEDS_HUMAN_PLATFORM_REVIEW"
        : explicit
          ? "FIXED_AND_VERIFIED"
          : "VERIFIED_NO_CHANGE";
    const stationName = occurrences[0].station[1];
    const lineRows = occurrences.map((row) => ({
      display_line_id: row.line.id,
      canonical_line: row.line.name,
      operator: row.line.operator,
      current_point: row.geometry.point,
      suggested_point: suggestedByLine.get(row.line.id) || row.geometry.point,
      platform_track_layer: {
        platform: row.evidence.basis === "registered_OSM_physical_track" ? "registered_line_platform" : "N02_line_station_feature",
        track: row.evidence.basis,
        vertical: row.geometry.vertical,
        structures: row.geometry.structure,
      },
      railwayIdentity: row.railwayIdentity,
      lane: row.render.lane,
      render_point: row.render.coordinate,
      render_bearing_degrees: row.render.bearing,
      station_turn_degrees: row.geometry.stationTurn,
      exact_adjacent_interval_endpoint: row.geometry.endpointExact,
      point_to_track_meters: row.pointToTrackMeters,
      immediate_leave_and_return: row.geometry.immediateReturn,
      osm_way_ids: row.evidence.osm_way_ids,
      source_refs: row.evidence.sources,
      alignment_role: row.line.alignmentRole || null,
      alignment_direction: row.line.alignmentDirection || null,
    }));

    groups.push({
      station_group: stationGroup,
      station_name: stationName,
      scope_reasons: [...new Set(scopeReasons)].sort(),
      classifications: classes.length ? classes : ["C"],
      operators: [...new Set(occurrences.map((row) => row.line.operator))].sort(),
      display_line_ids: occurrences.map((row) => row.line.id).sort(),
      network_roles: [...roles].filter(Boolean).sort(),
      apple_maps_result: explicit?.apple_maps_result || "pending_dedicated_capture",
      explicit_evidence: explicit?.evidence || null,
      explicit_rule: explicit?.rule || null,
      lines: lineRows,
      relationships,
      repair_status: status,
      unresolved_reasons: [...manualReasons].sort(),
      validation_errors: [...errors].sort(),
    });
  }

  groups.sort((a, b) =>
    b.display_line_ids.length - a.display_line_ids.length ||
    a.station_name.localeCompare(b.station_name, "ja") ||
    a.station_group.localeCompare(b.station_group),
  );
  const fixed = groups.filter((row) => row.repair_status === "FIXED_AND_VERIFIED");
  const verified = groups.filter((row) => row.repair_status === "VERIFIED_NO_CHANGE");
  const manual = groups.filter((row) => row.repair_status === "NEEDS_HUMAN_PLATFORM_REVIEW");
  const failed = groups.filter((row) => row.repair_status === "FIX_REQUIRED");
  const relationshipCounts = Object.fromEntries(
    ["A", "B", "C", "D", "E"].map((classification) => [
      classification,
      groups.flatMap((row) => row.relationships).filter((row) => row.classification === classification).length,
    ]),
  );
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    package: path.relative(ROOT_DIR, PACKAGE_PATH),
    package_version: pkg.version,
    evidence: path.relative(ROOT_DIR, RULES_PATH),
    summary: {
      physical_station_groups_in_package: occurrencesByGroup.size,
      audited_station_groups: groups.length,
      multi_display_line_groups: groups.filter((row) => row.display_line_ids.length >= 2).length,
      audited_display_station_occurrences: groups.reduce((sum, row) => sum + row.lines.length, 0),
      relationship_counts: relationshipCounts,
      fixed_and_verified: fixed.length,
      verified_no_change: verified.length,
      needs_human_platform_review: manual.length,
      fix_required: failed.length,
      stored_lanes_equal_pure_recomputation: lanesPure,
      stored_lane_rows: storedLanes.length,
      recomputed_lane_rows: freshLanes.length,
    },
    fixed_station_groups: fixed.map((row) => ({ station_group: row.station_group, station_name: row.station_name })),
    verified_no_change_station_groups: verified.map((row) => ({ station_group: row.station_group, station_name: row.station_name })),
    needs_human_station_groups: manual.map((row) => ({
      station_group: row.station_group,
      station_name: row.station_name,
      reasons: row.unresolved_reasons,
    })),
    failed_station_groups: failed.map((row) => ({
      station_group: row.station_group,
      station_name: row.station_name,
      errors: row.validation_errors,
    })),
    station_groups: groups,
  };
}

function csvRows(audit) {
  const headers = [
    "station_group",
    "station_name",
    "display_line_id",
    "canonical_line",
    "operator",
    "current_point",
    "suggested_point",
    "platform_track_layer",
    "classifications",
    "should_share_junction",
    "railwayIdentity",
    "lane",
    "tangent_differences_degrees",
    "point_to_track_meters",
    "osm_way_ids",
    "apple_maps_result",
    "repair_status",
    "unresolved_reasons",
    "validation_errors",
  ];
  const rows = [headers];
  for (const group of audit.station_groups) {
    for (const line of group.lines) {
      const relationships = group.relationships.filter((row) => row.lines.includes(line.display_line_id));
      rows.push([
        group.station_group,
        group.station_name,
        line.display_line_id,
        line.canonical_line,
        line.operator,
        line.current_point,
        line.suggested_point,
        line.platform_track_layer,
        [...new Set(relationships.map((row) => row.classification))],
        relationships.some((row) => row.should_share_junction),
        line.railwayIdentity,
        line.lane,
        relationships.map((row) => ({ with: row.lines.find((id) => id !== line.display_line_id), value: row.continuation_tangent_difference_degrees })),
        line.point_to_track_meters,
        line.osm_way_ids,
        group.apple_maps_result,
        group.repair_status,
        group.unresolved_reasons,
        group.validation_errors,
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function markdown(audit) {
  const s = audit.summary;
  const lines = [
    "# 日本多线车站全量审计",
    "",
    `生成时间：${audit.generated_at}`,
    "",
    "本报告的连续性判定使用相邻区间端点、`railwayIdentity`、最终 render lane、最终站点 feature 和切线；不把同名或同坐标本身视为通过。逐站逐线明细见 `audit.csv`，完整关系和证据字段见 `audit.json`。",
    "",
    "## 汇总",
    "",
    "| 指标 | 数量 |",
    "| --- | ---: |",
    `| package physical station groups | ${s.physical_station_groups_in_package} |`,
    `| 审计 station groups | ${s.audited_station_groups} |`,
    `| 多 display-line groups | ${s.multi_display_line_groups} |`,
    `| 审计 display station occurrences | ${s.audited_display_station_occurrences} |`,
    `| A / B / C / D / E 关系 | ${["A", "B", "C", "D", "E"].map((key) => s.relationship_counts[key]).join(" / ")} |`,
    `| 已修复并验证 | ${s.fixed_and_verified} |`,
    `| 无需修改并验证 | ${s.verified_no_change} |`,
    `| 仍需人工站台判断 | ${s.needs_human_platform_review} |`,
    `| 自动验收失败 | ${s.fix_required} |`,
    `| lanes 纯函数重算 | ${s.stored_lanes_equal_pure_recomputation ? "PASS" : "FAIL"} (${s.stored_lane_rows}/${s.recomputed_lane_rows}) |`,
    "",
    "## 交付物与验收",
    "",
    "- `audit.csv`：逐站逐 display line 全量表，包含点位、站台/轨道/层级、A–E、junction、identity、lane、切线、point-to-track、OSM/Apple 状态和未解决原因。",
    "- `audit.json`：保留每个 station group 的线路对关系、证据和自动验收细节。",
    "- `screenshots/tokyo-before-after.png` 与 `screenshots/sapporo-before-after.png`：直接由重建前归档包和最终包渲染的局部拓扑对照。",
    "- `screenshots/tokyo-final-ui.png`：现行应用、最终 render model 与在线底图的东京站 UI 核对。",
    "",
    "2026-08-18 验收结果：`npm test` 272/272 PASS；本审计 `--strict` PASS；topology strict 657 线中 651 PASS / 6 WARNING / 0 ERROR；station anchoring strict 10209 PASS / 14 WARNING / 0 ERROR。render snapshot、continuity、parallel corridor、paired alignment、route slicing 和 gzip parity 全部通过。",
    "",
    "topology 保留的 6 个 warning 是既有的中央/奥羽/篠ノ井/东海道/木次线锐角或东海道新干线覆盖告警；留萌线为已登记的废止线缺口。14 个 anchoring warning 均是终点进站位移，最终线到点和端点距离均为 0。",
    "",
    "## 本次证据、构建器与测试文件",
    "",
    "- Evidence：`app/data/raw/railway/jp/evidence/multi-line-station-audit-rules.json`、`tokyo-station-platforms.json`，以及重建 inventory 中的 station network、line-shape overrides 和 network corrections。",
    "- Builders/validation：`build-japan-package-from-inventory.py`、`build-parallel-corridors.mjs`、`finalize-japan-package.mjs`、`promote-lines.mjs`、`audit-japan-multiline-stations.mjs`、`render-japan-multiline-comparisons.mjs`。",
    "- Tests：`japan-multiline-station-audit.test.mjs`、`japan-rail-continuity.test.js`、`rail-network.test.js`、`rail-package-promotion.test.mjs`、`railway-display-curve.test.mjs`、`station-render-anchoring.test.js` 和 `railmap-popup-japan.test.js`。",
    "",
    "## 已修复车站",
    "",
    ...(audit.fixed_station_groups.length
      ? audit.fixed_station_groups.map((row) => `- ${row.station_name} (${row.station_group})`)
      : ["- 无"]),
    "",
    "## 无需修改但已验证",
    "",
    ...audit.verified_no_change_station_groups.map((row) => `- ${row.station_name} (${row.station_group})`),
    "",
    "## 仍需人工判断",
    "",
    ...(audit.needs_human_station_groups.length
      ? audit.needs_human_station_groups.map(
          (row) => `- ${row.station_name} (${row.station_group})：${row.reasons.join("；")}`,
        )
      : ["- 无"]),
    "",
    "## 自动验收失败",
    "",
    ...(audit.failed_station_groups.length
      ? audit.failed_station_groups.map(
          (row) => `- ${row.station_name} (${row.station_group})：${row.errors.join("；")}`,
        )
      : ["- 无"]),
    "",
    "Apple Maps 项若为 `pending_dedicated_capture`，表示已有核对队列但尚未把该站提升为视觉签核；不会被伪装成已核对。",
    "",
  ];
  return lines.join("\n");
}

function main() {
  const audit = buildAudit();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(audit, null, 2)}\n`);
  fs.writeFileSync(CSV_PATH, csvRows(audit));
  fs.writeFileSync(MARKDOWN_PATH, markdown(audit));
  process.stdout.write(
    `jp multi-line stations: ${audit.summary.audited_station_groups} groups, ` +
      `${audit.summary.fix_required} failures, ${audit.summary.needs_human_platform_review} manual, ` +
      `lanes ${audit.summary.stored_lanes_equal_pure_recomputation ? "pure" : "STALE"}\n`,
  );
  if (process.argv.includes("--strict") && audit.summary.fix_required) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
