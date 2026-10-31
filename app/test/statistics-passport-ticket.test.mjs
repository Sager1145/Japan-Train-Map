import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { evaluateAppScripts, makeSandbox } from "../scripts/lib/app-family-sandbox.mjs";

const context = makeSandbox();
evaluateAppScripts(context);
const run = (source) => vm.runInContext(source, context);

test("Passport excludes unconfirmed journeys and keeps network coverage distinct", async () => {
  run(`
    passportScopeDate = "2026-09-30";
    aggregateMileageStats = (_idx, entries) => ({
      riddenAll: entries.length * 12,
      unmatchedKm: entries.length * 2,
      totals: { all: 100 },
      lineRidByCat: new Map(),
      lineOperator: new Map(),
    });
    sumRideMinutes = (trains) => trains.length * 60;
    serviceGroupStats = (trains) => ({
      hsr: { km: trains.length * 14 }, ltd: { km: 0 }, other: { km: 0 },
    });
    topRiddenSegments = () => null;
  `);
  const stop = (ridden) => ({ name: ridden ? "A" : "B", stop_type: "stop", ride_segment: ridden });
  context.__trains = [
    { id: "ridden", date: "2026-09-30", number: "T1", company: "JR", stops: [stop(true), stop(true)] },
    { id: "planned", date: "2026-09-30", number: "T2", company: "JR", stops: [stop(false), stop(false)] },
  ];
  context.__entries = [{ km: 14, edges: [], spans: [] }, { km: 99, edges: [], spans: [] }];
  const view = await run("buildMileageStatsView({}, __trains, __entries)");
  assert.equal(view.ticket.rideCount, 1);
  assert.equal(view.ticket.stopCount, 2);
  assert.equal(view.daily.trainCount, 1);
  assert.equal(view.passport.totalKm, 14);
  assert.equal(view.passport.operators[0].count, 1);
  assert.equal(view.overall.rideMinutes, 60);
  assert.equal(view.overall.riddenAll - view.overall.unmatchedKm, 10);
  context.__ticketView = view;
  assert.match(run("statsRecordTicketHtml(__ticketView)"), /ticket\.record/);
});

test("ticket date follows the printed field and undirected routes share one rank", () => {
  assert.equal(run('statsTicketDate("2026-09-03")'), "2026.9.3");
  context.__routeTrains = [
    { id: "a", date: "2026-09-03", number: "A", stops: [{ name: "A", stop_type: "stop", ride_segment: true }, { name: "B", stop_type: "stop", ride_segment: true }] },
    { id: "b", date: "2026-09-04", number: "B", stops: [{ name: "B", stop_type: "stop", ride_segment: true }, { name: "A", stop_type: "stop", ride_segment: true }] },
  ];
  context.__routeEntries = [{ km: 8 }, { km: 8 }];
  const passport = run("buildPassportSummary(__routeTrains, __routeEntries)");
  assert.equal(passport.routes.length, 1);
  assert.equal(passport.routes[0].count, 2);
  assert.equal(passport.undated, 0);
});
