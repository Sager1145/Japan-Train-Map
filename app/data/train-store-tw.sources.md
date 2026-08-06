# Taiwan sample train sources

The bundled Taiwan store contains six journeys dated 2026-08-02 through
2026-08-13. Four trips were added for the 2026-08-05 and 2026-08-06 itinerary:

- THSR train 165, Taipei to Taichung on 2026-08-05.
- TRA local train 3262, Xinwuri to Taichung on 2026-08-05.
- TRA Tze-Chiang Limited Express (3000) train 137, Taichung to Changhua on
  2026-08-06.
- TRA local train 2204, Changhua to Taichung on 2026-08-06.

## Official timetable checks for the August 5-6 additions

- TRA train 137 official detail for 2026-08-06:
  <https://www.railway.gov.tw/tra-tip-web/tip/tip001/tip112/querybytrainno?rideDate=2026/08/06&trainNo=137>
  - Taichung 14:10, Changhua 14:23.
  - The official call list has no intermediate passenger stops in the ridden
    interval. Wuquan, Daqing, Wuri, Xinwuri, and Chenggong are therefore
    recorded as `pass_through`.
- TRA train 2204 official detail for 2026-08-06:
  <https://www.railway.gov.tw/tra-tip-web/tip/tip001/tip112/querybytrainno?rideDate=2026/08/06&trainNo=2204>
  - Changhua 14:11 arrival / 14:13 departure; Taichung 14:41 arrival.
  - The supplied “about 14:02” time is the same train's departure from Huatan;
    the closest matching local train from Changhua departs at 14:13.
- TRA train 3262 official detail for 2026-08-05:
  <https://www.railway.gov.tw/tra-tip-web/tip/tip001/tip112/querybytrainno?rideDate=2026/08/05&trainNo=3262>
  - Xinwuri 23:25 arrival / 23:26 departure; Taichung 23:37 arrival.
- THSR official timetable and fare search:
  <https://www.thsrc.com.tw/ArticleContent/a3b630bb-1066-4352-a1ef-58c7b4e8ef7c>
- THSR official timetable PDF, effective 2026-02-02:
  <https://www.thsrc.com.tw/Attachment/Download?pageID=a3b630bb-1066-4352-a1ef-58c7b4e8ef7c&id=b5e78f70-fa6d-4f75-8f31-a13387d7ea88>
  - Train 165 is marked as a daily train. Its published departures are Nangang
    21:20, Taipei 21:31, Banqiao 21:39, Taichung 22:20, and Zuoying 23:05.
  - The official journey result gives Taipei 21:31 and Taichung arrival 22:18.
    The supplied 21:33 is two minutes later than the published departure, so
    the canonical JSON uses the official scheduled 21:31 time.
  - Taoyuan, Hsinchu, and Miaoli are recorded as `pass_through` because they are
    physical stations in the ridden interval but are absent from train 165's
    official call list.

## Official rail geometry and station identifiers

- Official station ids, names, coordinates, station order, and line shapes:
  Ministry of Transportation TDX/PTX rail APIs
  <https://tdx.transportdata.tw/api-service/swagger/basic/5fa88b0c-120b-43f1-b188-c379ddb2593d>
- Geometry snapshot and source hashes: `public/rail/tw-2025.json`.

The three TRA trips use the official `臺中線` and operator
`國營臺灣鐵路股份有限公司`. THSR train 165 uses the official
`台灣高速鐵路` line and operator `台灣高速鐵路股份有限公司`. Every stop and
route-section endpoint uses the official TDX `StationUID` in the schema 1.3
compatibility field (`TRA-3300` through `TRA-3360`, or `THSR-1000` through
`THSR-1040`).

The pre-existing Taoyuan Airport MRT sample continues to use the official A13
timetable and stopping pattern:
<https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable-A13>.
Its route is sliced from the official-only `tw-tym-a` compact line and retains
all 13 physical stations from A13 to A1.

Rebuild the August 5-6 additions idempotently with:

```sh
cd app
node scripts/add-august-5-6-taiwan-itinerary.mjs
```

Rebuild the Airport MRT route after refreshing the Taiwan package with:

```sh
cd app
python3 scripts/rebuild-taiwan-sample-route.py
```
