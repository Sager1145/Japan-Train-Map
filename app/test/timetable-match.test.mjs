import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";
import { evaluateAppScripts, makeSandbox } from "../scripts/lib/app-family-sandbox.mjs";
const context=makeSandbox();evaluateAppScripts(context);
const run=s=>vm.runInContext(s,context);
function fixture() {
 const data={format:'jtm-web-timetable-1',services:[{service_id:'svc',canonical_name:'北斗'}],service_name_periods:[],
 timetable_versions:[{timetable_version_id:'v',effective_from:'2026-09-01',effective_until:'2026-10-01',completeness:'partial'}],
 calendars:[{calendar_id:'c',monday:1,tuesday:1,wednesday:1,thursday:1,friday:1,saturday:0,sunday:0,valid_from:'2026-09-01',valid_until:'2026-10-01',holiday_policy:'none'}],
 calendar_exceptions:[],holiday_calendar_years:[],holiday_dates:[],station_identities:[
 {station_id:'a',name_snapshot:'A',reference_kind:'current_n02',current_source_code:'001'},
 {station_id:'b',name_snapshot:'B',reference_kind:'current_n02',current_source_code:'002'},
 {station_id:'c',name_snapshot:'C',reference_kind:'current_n02',current_source_code:'003'}],
 trips:[{trip_id:'t',service_id:'svc',calendar_id:'c',timetable_version_id:'v',train_number:'1',public_number:'北斗1号'}],
 stop_times:[{trip_id:'t',stop_sequence:0,station_id:'a',departure_seconds:32400,call_type:'origin'},
 {trip_id:'t',stop_sequence:1,station_id:'b',arrival_seconds:34200,call_type:'passenger_stop'},
 {trip_id:'t',stop_sequence:2,station_id:'c',arrival_seconds:36000,call_type:'destination'}],
 trip_stop_time_overrides:[],trip_train_number_overrides:[],trip_timetable_symbols:[],timetable_version_sources:[],source_documents:[]};
 context.data=data;context.train={id:'ride',date:'2026-09-30',number:'北斗1号',stops:[{n02_station_code:'001',departure:'09:00'},{n02_station_code:'003',arrival:'10:00'}]};
 return data;
}
const match=()=>{run('idx=indexWebTimetable(data)');return run('webTimetableCandidates(idx,train)');};
test('exact timetable match requires day, full endpoints, times and service; no same-name fallback',()=>{
 fixture();assert.equal(match().matches.length,1);
 context.train.stops[1]={n02_station_code:'002',arrival:'09:30'};assert.equal(match().matches.length,0);
 context.train.stops[1]={n02_station_code:'003',arrival:'10:01'};assert.equal(match().matches.length,0);
 context.train.stops[1]={n02_station_code:'003',arrival:'10:00'};context.train.number='別の列車';assert.equal(match().matches.length,0);
 context.train.number='北斗1号';context.train.date='2026-10-01';assert.equal(match().matches.length,0);
});
test('service calendars are half-open and remove exceptions beat additions',()=>{
 const data=fixture();context.train.date='2026-09-26';assert.equal(match().matches.length,0);
 data.calendar_exceptions.push({calendar_id:'c',service_date:'2026-09-26',exception_type:'add'});assert.equal(match().matches.length,1);
 data.calendar_exceptions.push({calendar_id:'c',service_date:'2026-09-26',exception_type:'remove'});assert.equal(match().matches.length,0);
});
test('date overrides affect endpoint time, platform clearing and train number',()=>{
 const data=fixture();data.trip_stop_time_overrides.push({trip_id:'t',service_date:'2026-09-30',stop_sequence:0,departure_seconds_override:32700,platform_override_present:1,platform_override:null});
 data.trip_train_number_overrides.push({trip_id:'t',service_date:'2026-09-30',train_number:'3'});
 assert.equal(match().matches.length,0);context.train.stops[0].departure='09:05';context.train.number='3';
 const result=match();assert.equal(result.matches.length,1);assert.equal(result.matches[0].calls[0].platform,null);
});
test('unknown holiday years, conflicts and historical-only endpoints are excluded',()=>{
 const data=fixture();data.calendars[0].holiday_policy='treat_as_sunday';
 assert.equal(match().matches.length,0);assert.equal(match().holidayUnknown,true);
 data.holiday_calendar_years.push({year:2026,status:'verified'});assert.equal(match().matches.length,1);
 data.timetable_versions[0].completeness='conflict';assert.equal(match().matches.length,0);
 data.timetable_versions[0].completeness='partial';data.station_identities[0].reference_kind='historical_overlay';assert.equal(match().matches.length,0);
});
// The snapshot is local-only and never committed: most of its sources are
// operator timetables marked verification_only, not ours to redistribute. The
// check runs on a machine that has exported it and skips on one that has not.
const snapshotSkip=fs.existsSync(new URL('../public/timetable/snapshot.json',import.meta.url))
 ?false
 :'the bundled-snapshot check needs app/public/timetable/snapshot.json, which is local-only';
test('bundled snapshot retains template, call, symbol and provenance records',{skip:snapshotSkip},()=>{
 context.data=JSON.parse(fs.readFileSync(new URL('../public/timetable/snapshot.json',import.meta.url),'utf8'));
 const idx=run('indexWebTimetable(data)');
 assert.equal(idx.data.trips.length,882);assert.equal(idx.data.stop_times.length,8520);assert.equal(idx.data.trip_timetable_symbols.length,24);
 assert.match(idx.data.source_sha256,/^[a-f0-9]{64}$/);
 assert.ok(idx.data.source_documents.length>1000);
});
