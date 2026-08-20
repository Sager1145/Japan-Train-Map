import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadOsmPlatformIndex,
  platformServiceOf,
} from "../scripts/railway/lib/osm-basemap-cache.mjs";
import { pickPlatform } from "../scripts/railway/lib/station-track-claim.mjs";

/*
 * The OSM platform cache is 91% road furniture — 154,006 of its 168,881 indexed
 * elements are `highway=bus_stop`, because the fetch asks for
 * `public_transport=platform` and in Japan that tag is mostly bus shelters. A
 * bus shelter is not a platform a train calls at, and one of them was picked as
 * a station's platform: 紙屋町東's 宇品線 pick was node/9418004134, 広電バス's
 * 立町, 199 m away and named for the next stop of a DIFFERENT line.
 *
 * These tests are built on a synthetic cache directory rather than the
 * machine-local 54 MB one, so they are a contract CI can actually run. The tag
 * dictionaries are real, copied from the cells the campaign measured.
 */

// node/9418004134 — 広電バス's 立町 shelter. The pick that this rejection is for.
const TATEMACHI_BUS_STOP = {
  bus: "yes",
  highway: "bus_stop",
  name: "立町",
  operator: "広電バス",
  public_transport: "platform",
};
// way/929779365 — 広島電鉄's own tram platform, 66 m from the same dot.
const HIRODEN_TRAM_PLATFORM = {
  area: "yes",
  public_transport: "platform",
  railway: "platform",
  shelter: "yes",
  tram: "yes",
};
// way/445412130 — 都電荒川線's 熊野前. A TRAM platform that declares no mode at
// all, which is why "declares no rail mode" may never mean "is not rail".
const ARAKAWA_TRAM_PLATFORM_UNTAGGED = {
  operator: "東京都交通局",
  public_transport: "platform",
};

test("a platform element is classified by what it says it serves", () => {
  // Rail, by the platform tag or by a mode tag.
  assert.equal(platformServiceOf(HIRODEN_TRAM_PLATFORM), "rail");
  assert.equal(platformServiceOf({ railway: "platform" }), "rail");
  assert.equal(platformServiceOf({ public_transport: "platform", tram: "yes" }), "rail");
  assert.equal(platformServiceOf({ public_transport: "platform", train: "yes" }), "rail");
  assert.equal(
    platformServiceOf({ highway: "footway", railway: "platform_edge", train: "yes" }),
    "rail",
  );

  // Road, only on a POSITIVE declaration.
  assert.equal(platformServiceOf(TATEMACHI_BUS_STOP), "road");
  assert.equal(platformServiceOf({ highway: "bus_stop" }), "road");
  assert.equal(platformServiceOf({ highway: "crossing;bus_stop", bus: "yes" }), "road");
  assert.equal(platformServiceOf({ public_transport: "platform", bus: "yes" }), "road");

  // Unstated — kept, because this is how a great many real tram, metro and JR
  // platforms are mapped. すすきの (way/431614567), 熊野前 (way/445412130) and
  // JR京都駅0番のりば (way/516319355) are all this shape.
  assert.equal(platformServiceOf(ARAKAWA_TRAM_PLATFORM_UNTAGGED), "unstated");
  assert.equal(platformServiceOf({ public_transport: "platform" }), "unstated");
  assert.equal(platformServiceOf({ highway: "platform" }), "unstated");

  // A rail declaration wins over a road one on the same element: a stop shared
  // by a tram and a bus is still a tram stop.
  assert.equal(platformServiceOf({ railway: "platform", bus: "yes" }), "rail");
  assert.equal(platformServiceOf({ highway: "bus_stop", tram: "yes" }), "rail");
});

/** A cache directory holding exactly the elements a case needs. */
function syntheticCache(elements) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-cache-"));
  fs.mkdirSync(path.join(directory, "platforms"));
  fs.writeFileSync(
    path.join(directory, "platforms", "E132N34.json"),
    JSON.stringify({
      format: "osm-platform-cell",
      cell: "E132N34",
      fetchedAt: "2026-08-20T00:00:00Z",
      elements,
    }),
  );
  return directory;
}

const node = (id, tags, lon, lat) => ({
  type: "node",
  id,
  tags,
  geometry: [{ lat, lon }],
});
const way = (id, tags, coordinates) => ({
  type: "way",
  id,
  tags,
  geometry: coordinates.map(([lon, lat]) => ({ lat, lon })),
});

// A claim that calls EVERYTHING adjacent, so adjacency cannot be what rejects
// the bus stop. The rejection has to come from the mode tags alone.
const everythingAdjacent = { trackDistanceAt: () => 0 };

test("a road-bus stop is never the platform a line's trains call at", () => {
  // The shelter is nearer, and adjacency and alignment agree, so it wins every
  // ranking field pickPlatform has. Only the mode tags separate them.
  const directory = syntheticCache([
    node(9418004134, TATEMACHI_BUS_STOP, 132.4604, 34.39445),
    way(929779365, HIRODEN_TRAM_PLATFORM, [
      [132.4593, 34.3946],
      [132.4594, 34.3946],
    ]),
  ]);
  const { index, byService } = loadOsmPlatformIndex({ cacheDir: directory });
  assert.deepEqual(byService, { rail: 1, road: 1, unstated: 0 });

  const dot = [132.46, 34.3946];
  const nearest = [...index.within(dot, 250).entries()].sort((a, b) => a[1] - b[1])[0];
  assert.equal(nearest[0].key, "node/9418004134", "the shelter really is the nearest");

  const pick = pickPlatform(dot, [], everythingAdjacent, index, { radiusMeters: 250 });
  assert.equal(pick.platform.key, "way/929779365");
  assert.equal(pick.platform.serves, "rail");
  assert.equal(pick.candidates, 1, "the shelter is gone, not merely outranked");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a station with nothing but bus shelters around it has no platform, not a bus one", () => {
  // 田崎橋's 熊本市電 platform is not in the cache; before this rejection the
  // pick was 二本木口, a shelter 109 m away, and it cleared the 25 m on-track
  // gate at 4.5 m. "Cannot tell" is the only honest answer here.
  const directory = syntheticCache([
    node(
      5313725921,
      { highway: "bus_stop", bus: "yes", public_transport: "platform", name: "二本木口" },
      132.46,
      34.3946,
    ),
    node(1, { public_transport: "platform", bus: "yes", name: "春日寺前" }, 132.4602, 34.3947),
  ]);
  const { index, byService } = loadOsmPlatformIndex({ cacheDir: directory });
  assert.deepEqual(byService, { rail: 0, road: 2, unstated: 0 });
  assert.equal(pickPlatform([132.46, 34.3946], [], everythingAdjacent, index, { radiusMeters: 250 }), null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a tram platform that declares no mode is kept, and only ranked below one that does", () => {
  const directory = syntheticCache([
    way(445412130, ARAKAWA_TRAM_PLATFORM_UNTAGGED, [
      [132.46, 34.3946],
      [132.4601, 34.3946],
    ]),
    way(929779365, HIRODEN_TRAM_PLATFORM, [
      [132.4610, 34.3946],
      [132.4611, 34.3946],
    ]),
  ]);
  const { index, byService } = loadOsmPlatformIndex({ cacheDir: directory });
  assert.deepEqual(byService, { rail: 1, road: 0, unstated: 1 });

  const dot = [132.46005, 34.3946];
  // Alone in reach, the untagged tram platform is the answer — an absent tag is
  // not evidence against it.
  const alone = pickPlatform(dot, [], everythingAdjacent, index, { radiusMeters: 40 });
  assert.equal(alone.platform.key, "way/445412130");
  assert.equal(alone.platform.serves, "unstated");

  // With both in reach and both adjacent, the one that declares rail wins even
  // though it is 90 m further away.
  const both = pickPlatform(dot, [], everythingAdjacent, index, { radiusMeters: 250 });
  assert.equal(both.platform.key, "way/929779365");

  // …but adjacency still outranks the declaration: a rail platform the line's
  // own track does not reach loses to an untagged one that it does. This is the
  // order prompt 2.4 sets, and the reason the demotion is a tiebreak and not a
  // filter.
  const claim = {
    trackDistanceAt: (point) => (point[0] > 132.4605 ? 400 : 0),
  };
  const adjacencyWins = pickPlatform(dot, [], claim, index, { radiusMeters: 250 });
  assert.equal(adjacencyWins.platform.key, "way/445412130");
  fs.rmSync(directory, { recursive: true, force: true });
});
