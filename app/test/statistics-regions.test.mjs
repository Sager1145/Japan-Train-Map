import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { indexedDB } from "fake-indexeddb";
import { evaluateAppScripts, makeSandbox } from "../scripts/lib/app-family-sandbox.mjs";
const context = makeSandbox({indexedDB}); context.APP_RUNTIME_CONFIG={hasBackend:false}; evaluateAppScripts(context);
const run = source => vm.runInContext(source,context);
const ride = (id,date,ridden=true) => ({id,date,stops:[
  {name:"A",departure:"09:00",stop_type:"origin",ride_segment:ridden},
  {name:"B",arrival:"10:00",stop_type:"destination",ride_segment:ridden}
]});
test("regional counts and time respect actual rides and date scope",()=>{
  context.stores = new Map([["jp",{trains:[ride("a","2026-09-30"),ride("plan","2026-09-30",false)]}],["tw",{trains:[ride("b","2026-09-29"),ride("c","2026-09-30")]}],["hk",null]]);
  assert.equal(run("buildRegionRideSummary(stores).count"),3);
  assert.equal(run("buildRegionRideSummary(stores).minutes"),180);
  assert.equal(run('buildRegionRideSummary(stores,"2026-09-30").count'),2);
  assert.equal(run('buildRegionRideSummary(stores,"2026-09-30").minutes'),120);
});
test("reading another region does not mutate current store or persistence mode",async()=>{
  run('activeCountry="jp"; dataSourceMode="user"; trainStore={trains:[{id:"unsaved"}]}');
  const db=await run('openIdb(AppCore.countrySuffixed(USER_STORE_DB_NAME,"tw"),[USER_STORE_DATES_STORE,USER_STORE_META_STORE],"DB")');
  await new Promise((resolve,reject)=>{
    const tx=db.transaction("dates","readwrite");tx.objectStore("dates").put({date:"2026-09-30",trains:[ride("tw1","2026-09-30")]},"2026-09-30");tx.oncomplete=resolve;tx.onerror=reject;
  });db.close();
  assert.equal((await run('readRegionSavedStore("tw")')).trains[0].id,"tw1");
  assert.equal(run("activeCountry"),"jp");
  assert.equal(run("trainStore.trains[0].id"),"unsaved");
  assert.equal(run("dataSourceMode"),"user");
  assert.equal((await run('readRegionSavedStore("mo")')).trains.length,0);
});
