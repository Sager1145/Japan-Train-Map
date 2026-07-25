// Shared pipeline for the special-sample loop generators
// (generate-new-year-grand-loop.mjs / generate-tokyo-limited-express-loop.mjs):
// route pieces -> station-code lookup -> expandRouteStationPieces -> stops.
// The generated JSON is COMMITTED under data/special-samples/, so everything
// here — object field order included — is a byte-for-byte output contract.

import fs from "node:fs";
import path from "node:path";
import {
  expandRouteStationPieces,
  findStationCode,
} from "./expand-route-stations.mjs";

// Route-policy fields every generated train shares. Key ORDER is part of each
// consumer's committed-output contract, and the consumers disagree AFTER the
// four fields below (train-store.json puts allowed_institution_type_codes
// before the preferred_* fields; the loop samples put it last) — so the
// variable tail is supplied via `overrides` in each caller's own order.
// Overriding a base key (jr_only) keeps its position here.
export function defaultRoutePolicy(overrides) {
  return {
    mode: "single_primary_route",
    jr_only: true,
    allow_alternatives: false,
    allow_browser_straight_line_fallback: false,
    ...overrides,
  };
}

// One generated loop train. `details` is the generator's optional per-service
// record: { company?, routePieces?, passengerStops?, times? } — services
// without a `times` map get null intermediate times, and services without
// `passengerStops` stop everywhere (locals).
export function makeLoopTrain({
  order,
  id,
  date,
  number,
  trainType,
  origin,
  originCode,
  departure,
  destination,
  destinationCode,
  arrival,
  lineNames,
  color,
  operator,
  details = {},
}) {
  let currentName = origin;
  let currentCode = originCode;
  const pieceSpecs = details.routePieces || [
    { to: destination, lineNames },
  ];
  const pieces = pieceSpecs.map((pieceSpec) => {
    const toCode =
      pieceSpec.to === destination
        ? destinationCode
        : findStationCode(pieceSpec.to, pieceSpec.lineNames);
    if (!toCode) {
      throw new Error(
        `${order}: N02 station code not found for ${pieceSpec.to}`,
      );
    }
    const piece = {
      from: currentName,
      to: pieceSpec.to,
      from_n02_station_code: currentCode,
      to_n02_station_code: toCode,
      line_names: pieceSpec.lineNames,
    };
    currentName = pieceSpec.to;
    currentCode = toCode;
    return piece;
  });
  const expanded = expandRouteStationPieces(pieces);
  if (
    !expanded ||
    expanded.stations[0]?.name !== origin ||
    expanded.stations.at(-1)?.name !== destination
  ) {
    throw new Error(`${order}: failed to expand ${origin} -> ${destination}`);
  }
  const passengerStops = details.passengerStops
    ? new Set(details.passengerStops)
    : null;
  const stops = expanded.stations.map((station, index) => {
    const isOrigin = index === 0;
    const isDestination = index === expanded.stations.length - 1;
    const isPassengerStop =
      isOrigin ||
      isDestination ||
      !passengerStops ||
      passengerStops.has(station.name);
    const times = details.times?.[station.name] || {};
    return {
      name: station.name,
      n02_station_code: station.code,
      arrival: isOrigin
        ? null
        : isDestination
          ? arrival
          : times.arrival || null,
      departure: isDestination
        ? null
        : isOrigin
          ? departure
          : times.departure || null,
      stop_type: isOrigin
        ? "origin"
        : isDestination
          ? "destination"
          : isPassengerStop
            ? "passenger_stop"
            : "pass_through",
      ride_segment: true,
    };
  });
  return {
    id,
    date,
    number,
    train_type: trainType,
    company: details.company || "JR東日本",
    origin,
    destination,
    direction: destination,
    visible: true,
    style: { color },
    route_policy: defaultRoutePolicy({
      preferred_line_names: lineNames,
      preferred_operator_names: [operator],
      institution_filter_mode: "soft",
      allowed_institution_type_codes: ["2"],
    }),
    route_sections: expanded.sections.map((section) => ({
      ...section,
      operator_names: [operator],
    })),
    stops,
  };
}

export function writeLoopStore(outputPath, trains) {
  const store = { schema_version: "1.3", trains };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(store, null, 2)}\n`);
  console.log(`Wrote ${store.trains.length} trains to ${outputPath}`);
}
