# Taiwan sample train sources

The bundled Taiwan store contains one Taoyuan Airport MRT express journey from
A13 Airport Terminal 2 to A1 Taipei Main Station on 2026-08-02.

- Official timetable and express stopping pattern (A13, A12, A8, A3, A1):
  <https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable-A13>
- Official station ids, names, coordinates, order, and `LineID=A` shape:
  Ministry of Transportation TDX/PTX rail APIs
  <https://tdx.transportdata.tw/api-service/swagger/basic/5fa88b0c-120b-43f1-b188-c379ddb2593d>
- Geometry snapshot and source hashes: `public/rail/tw-2025.json`

The matched route is sliced directly from the official-only `tw-tym-a` compact
line. The canonical itinerary contains all 13 physical stations from A13 to
A1: the five express calls retain their official timetable times and the eight
intervening stations are marked `pass_through`. Its 12 `route_sections` and 13
stop markers use official shape slices and official station coordinates. No
OSM geometry, station, or attribution remains in this sample.

`n02_station_code` is the schema 1.3 compatibility key for the active official
station identifier. In this Taiwan store its values are official TDX
`StationUID` values (`TYMC-A13` ... `TYMC-A1`), not Japanese N02 codes.

Rebuild the sample route after refreshing the Taiwan package:

```sh
cd app
python3 scripts/rebuild-taiwan-sample-route.py
```
