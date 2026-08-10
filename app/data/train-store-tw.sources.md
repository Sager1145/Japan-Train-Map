# Taiwan sample train sources

The bundled Taiwan store contains twenty-three journeys dated 2026-08-02 through
2026-08-13. Three Taipei Metro trips were added for the 2026-08-02 itinerary:

- Bannan Line, Taipei Main Station to Ximen at about 14:45.
- Bannan Line, Ximen to Zhongxiao Fuxing at about 15:52.
- Bannan Line, Zhongxiao Fuxing to Ximen at 20:00.

Four trips were added for the 2026-08-05 and 2026-08-06 itinerary:

- THSR train 165, Taipei to Taichung on 2026-08-05.
- TRA local train 3262, Xinwuri to Taichung on 2026-08-05.
- TRA Tze-Chiang Limited Express (3000) train 137, Taichung to Changhua on
  2026-08-06.
- TRA local train 2204, Changhua to Taichung on 2026-08-06.

Eight trips were added for the 2026-08-08 and 2026-08-09 itinerary:

- TRA Tze-Chiang Limited Express (3000) train 191, Taichung to Chiayi on
  2026-08-08.
- Alishan train 5, Chiayi to Alishan on 2026-08-08.
- Shenmu Line train 120, the last Alishan to Shenmu service on 2026-08-08.
- Shenmu Line train 121, the last Shenmu to Alishan service on 2026-08-08.
- Zhushan sunrise train, Alishan to Zhushan on 2026-08-09.
- Zhushan sunrise train, Zhushan to Alishan on 2026-08-09.
- Alishan train 8, Alishan to Chiayi on 2026-08-09.
- TRA Tze-Chiang Limited Express (3000) train 125, Chiayi to Kaohsiung on
  2026-08-09.

Six Kaohsiung Metro and Light Rail trips were added for 2026-08-10:

- Red Line, Kaohsiung Main Station to Gangshan Station.
- The next southbound Red Line train, Gangshan Station to Siaogang.
- The next northbound Red Line train, Siaogang to Sanduo Shopping District.
- A later southbound Red Line train, Sanduo Shopping District to Kaisyuan,
  timed to leave about ten minutes for the Light Rail transfer.
- A complete counterclockwise Light Rail circuit from C3 Cianjhen Star, first
  heading toward C2 Kaisyuan Rueitian, and returning to C3.
- The next feasible northbound Red Line train after the C3/R6 walking
  transfer, Kaisyuan to Kaohsiung Main Station.

## Official Taipei Metro checks for the August 2 additions

- Taipei Metro's official Taipei Main Station fare and travel-time table:
  <https://web.metro.taipei/pages2026/WebStation/051/8>
  - BL12 Taipei Main Station to BL11 Ximen is a two-minute ride.
- Taipei Metro's official Zhongxiao Fuxing fare and travel-time table:
  <https://web.metro.taipei/pages2026/WebStation/010/8>
  - BL15 Zhongxiao Fuxing to BL11 Ximen is an eight-minute ride.
  - The physical Bannan Line stop order is Zhongxiao Fuxing, Zhongxiao
    Xinsheng, Shandao Temple, Taipei Main Station, and Ximen.
- The three departure times are user-supplied itinerary times. They are
  represented as approximate metro departures rather than numbered train
  services; the intermediate and arrival times use the official two- and
  eight-minute travel times above.
- All stops and route-section endpoints use the official TDX Taipei Metro
  StationUIDs `TRTC-BL11` through `TRTC-BL15`, the official line name `板南線`,
  and operator `臺北大眾捷運股份有限公司`. The passenger-facing `company`
  field uses the canonical short name `台北捷運`.

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

## Official timetable checks for the August 8-9 additions

- TRA train 191 official detail for 2026-08-08:
  <https://www.railway.gov.tw/tra-tip-web/tip/tip001/tip112/querybytrainno?rideDate=2026/08/08&trainNo=191>
  - Taichung 07:39, Changhua 07:53 arrival / 07:55 departure, and Chiayi
    08:43 arrival.
  - The route contains every physical station on the ridden interval. Stations
    omitted from the official call list are recorded as `pass_through`.
- Alishan Forest Railway official main-line timetable, effective from
  2025-01-10:
  <https://afrch.forest.gov.tw/0000115>
  - Uphill train 5 is the only listed daily train running over the full main
    line from Chiayi to Alishan: Chiayi 10:00, Beimen 10:08, Zhuqi 10:39,
    Jiaoliping 11:43, Fenqihu 12:16 arrival / 13:21 departure, Erwanping
    14:38, and Alishan 14:56.
  - Downhill train 8 runs over the full main line from Alishan to Chiayi:
    Alishan 11:50, Erwanping 12:09, Fenqihu 13:29, Jiaoliping 14:04, Zhuqi
    15:07, Beimen 15:39, and Chiayi 15:45.
  - Both records enumerate all 17 physical stations on the main line. Stations
    shown without a time in the official timetable are recorded as
    `pass_through`.
- Alishan Forest Railway official branch-line timetable:
  <https://afrch.forest.gov.tw/0000300>
  - The last Shenmu Line downhill service is train 120, Alishan 15:50 to
    Shenmu 15:57. The last return is train 121, Shenmu 16:10 to Alishan 16:17.
  - Zhushan sunrise-train times are announced at 16:30 on the preceding day
    rather than published as a permanent fixed timetable. The 2026-08-09
    itinerary records the single 04:40 departure from Alishan and the 06:20
    return from Zhushan. The official FAQ states that the ride takes about 25
    minutes, giving 05:05 and 06:45 arrivals.
  - The Zhushan records follow the official line-specific station sequence,
    retaining Dueigaoyue as `pass_through`, and constrain every interval to
    `祝山線`. Zhaoping belongs only to the separate `沼平線` station sequence
    in the official dataset, so it is not injected into the Zhushan record.
    The Shenmu records similarly constrain their interval to `神木線`.
- Alishan Forest Railway official FAQ (approximately 25 minutes between
  Alishan and Zhushan):
  <https://afrch.forest.gov.tw/faqs?iPage=2>
- TRA train 125 official detail for 2026-08-09:
  <https://www.railway.gov.tw/tra-tip-web/tip/tip001/tip112/querybytrainno?rideDate=2026/08/09&trainNo=125>
  - Chiayi 16:17 arrival / 16:19 departure; Xinying 16:32 / 16:34; Yongkang
    16:53 / 16:54; Tainan 16:59 / 17:01; Xinzuoying 17:25 / 17:26; Kaohsiung
    17:34 arrival.
  - All 30 physical stations from Chiayi through Kaohsiung are retained.
    The 24 stations absent from the official call list are recorded as
    `pass_through`.

## Official timetable checks for the August 10 additions

- Kaohsiung Metro ordinary-weekday station timetables, updated 2026-07-01:
  <https://www.krtc.com.tw/Guide/train_times?n=R11>
  <https://www.krtc.com.tw/Guide/train_times?n=R24>
  <https://www.krtc.com.tw/Guide/train_times?n=RK1>
  <https://www.krtc.com.tw/Guide/train_times?n=R3>
  <https://www.krtc.com.tw/Guide/train_times?n=R8>
  <https://www.krtc.com.tw/Guide/train_times?n=R6>
  - The first train leaves R11 Kaohsiung Main Station at 14:38, calls at R24
    `岡山高醫` at 15:08, and continues to the requested RK1 `岡山車站`
    terminal at 15:10.
  - The next southbound train leaves RK1 at 15:16 and reaches R3 Siaogang at
    16:06. The next northbound train leaves R3 at 16:12 and reaches R8 Sanduo
    Shopping District at 16:24. To keep the final Metro-to-Light-Rail transfer
    at ten minutes, the selected southbound train leaves R8 at 17:03, calls at
    R7 at 17:05, and reaches R6 Kaisyuan at 17:08.
  - After the Light Rail circuit and the approximately 80-metre walk from C3
    Cianjhen Star, the next feasible northbound Red Line train leaves R6 at
    18:54 and reaches R11 at 19:04.
- Kaohsiung Metro official Red/Orange Line station-to-station travel-time
  table, updated 2026-03-02:
  <https://www.krtc.com.tw/Guide/time_between_train>
  - The table supplies terminal arrivals where station departure-time pages do
    not list arrivals, including R11 to RK1 in 32 minutes and RK1 to R3 in 50
    minutes.
- C3 Cianjhen Star ordinary-weekday Light Rail timetable, updated 2026-08-04:
  <https://www.krtc.com.tw/KLRT/train_timesLRT?n=C3>
  - From C3 toward C2 Kaisyuan Rueitian is the counterclockwise (`逆行`)
    direction. The closest official departure to the requested 17:20 is
    17:18.
- Kaohsiung Light Rail official station-to-station travel-time table, updated
  2026-03-02:
  <https://www.krtc.com.tw/KLRT/time_between_train>
  - A complete counterclockwise circuit from C3 takes 89 minutes, returning
    at 18:47. The JSON enumerates all 38 physical intervals and repeats C3 as
    the destination, for 39 stops in total.
  - Every Metro and Light Rail station is a passenger stop. Intermediate
    timestamps reproduce the official station departure tables or are derived
    from the official directional travel-time matrix.

## Official rail geometry and station identifiers

- Official station ids, names, coordinates, station order, and line shapes:
  Ministry of Transportation TDX/PTX rail APIs
  <https://tdx.transportdata.tw/api-service/swagger/basic/5fa88b0c-120b-43f1-b188-c379ddb2593d>
- Geometry snapshot and source hashes: `public/rail/tw-2025.json`.

The earlier Taichung-area TRA trips use the official `臺中線`. Train 191 uses
`臺中線` from Taichung to Changhua and `縱貫線南段` from Changhua to Chiayi.
Their saved `company` is `台鐵`, while route constraints retain the official
operator `國營臺灣鐵路股份有限公司`. THSR train 165 similarly saves
`台灣高鐵` while its official `台灣高速鐵路` line and
`台灣高速鐵路股份有限公司` operator stay in route metadata. The Alishan
main-line and branch trips save `阿里山林鐵`, while route metadata keeps the
official `阿里山線`, `神木線`, or `祝山線` plus
`阿里山林業鐵路及文化資產管理處`. Every stop and route-section endpoint uses
the official TDX or Forest Railway station identifier in the schema 1.3
compatibility field.

The pre-existing Taoyuan Airport MRT sample saves `桃園捷運` as its company
label and continues to use the official A13
timetable and stopping pattern:
<https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable-A13>.
Its route is sliced from the official-only `tw-tym-a` compact line and retains
all 13 physical stations from A13 to A1.

Rebuild the August 5-6 additions idempotently with:

```sh
cd app
node scripts/add-august-5-6-taiwan-itinerary.mjs
```

Rebuild the August 2 Taipei Metro additions idempotently with:

```sh
cd app
node scripts/add-august-2-taipei-metro-itinerary.mjs
```

Rebuild the August 8-9 additions idempotently with:

```sh
cd app
node scripts/add-august-8-9-taiwan-itinerary.mjs
```

Rebuild the August 10 Kaohsiung additions idempotently with:

```sh
cd app
node scripts/add-august-10-kaohsiung-itinerary.mjs
```

Rebuild the Airport MRT route after refreshing the Taiwan package with:

```sh
cd app
python3 scripts/rebuild-taiwan-sample-route.py
```
