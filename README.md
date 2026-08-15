# Japan Train Map

An interactive railway journey map, itinerary editor, and rail-coverage tracker for Japan, Taiwan, Hong Kong, Macao, and South Korea.

[Open the live map](https://sager1145.github.io/Japan-Train-Map/) · [Train JSON specification](./jsonspec.md) · [Agent integration guide](./AGENT.md) · [Deployment guide](./DEPLOY-GITHUB-PAGES.md)

Japan Train Map turns personal trip records into routes that follow the railway network. It can edit trains and stops, solve station-to-station paths, show stopping and pass-through stations, separate trips by date and region, and calculate ridden distance and network coverage. The same frontend runs with a local Node.js backend or as a browser-only static site.

> This is a journey-recording and visualization tool, not a timetable planner. It does not provide live departures, fares, disruptions, reservations, or guaranteed operational routing.

## Contents

- [Features](#features)
- [Supported regions](#supported-regions)
- [Try it online](#try-it-online)
- [Run locally](#run-locally)
- [User guide](#user-guide)
- [Map controls](#map-controls)
- [Import, export, and persistence](#import-export-and-persistence)
- [Train JSON format](#train-json-format)
- [HTTP API and agent imports](#http-api-and-agent-imports)
- [Development](#development)
- [Static deployment](#static-deployment)
- [Troubleshooting](#troubleshooting)
- [Railway data and attribution](#railway-data-and-attribution)

## Features

### Railway-aware route mapping

- Solves routes over a country-specific station and track graph instead of joining stations with straight lines.
- Uses stop order, official station identifiers, train type, operator, `route_policy`, and per-section line/operator constraints.
- Never silently substitutes a fake straight line when a route cannot be solved.
- Keeps Japan, Taiwan, Hong Kong, Macao, and South Korea in separate graphs so same-named stations cannot route into the wrong country.
- Caches solved geometry in IndexedDB and ships precomputed geometry for static sample itineraries.

### Trip organization and editing

- Groups trains by date, with a combined **All** view and optional map filtering to the selected date.
- Searches by train number, name, station, or train ID.
- Adds, duplicates, deletes, reorders, shows, or hides trains.
- Edits train ID, number, type, company, direction, origin, destination, and display color.
- Edits stop names, arrival/departure times, stop type, ridden state, and running order.
- Supports origins, passenger stops, pass-through stations, operational stops, and destinations.
- Understands branch/junction groupings supplied through `route_sections` and can toggle an entire branch as ridden or hidden.
- Supports overnight itineraries using times such as `25:10` for 01:10 the following day.

### Interactive map

- Draws train routes in their assigned colors and adds an ink casing to the selected route.
- Distinguishes terminals, intermediate stops, and pass-through stations with different marker treatments.
- Displays overlapping railways as stable parallel lanes and provides a train chooser when touch input hits multiple routes.
- Shows route and station information on hover or click.
- Provides an optional complete railway-network overlay with line colors and station points.
- Separately toggles routes, intermediate stops, terminals, pass-through stations, and ridden railway categories.
- Offers OpenFreeMap light/dark basemaps or a no-basemap mode.

### Statistics

- Calculates selected-day and all-time ridden distance.
- Reports railway-network coverage and actual ride totals.
- Breaks results down by line and ride count.
- Lists the most frequently ridden sections.
- Deduplicates overlapping ridden geometry when calculating coverage.

Only segments whose effective ridden state is true contribute to the rendered trip and statistics.

### Interface and accessibility

- Traditional Chinese, Simplified Chinese, Japanese, and English UI.
- Light, dark, and system-following themes.
- Auto-detected, forced mobile, and forced desktop layouts.
- Mobile workspace navigation for Trains, Editor, Statistics, Data, and Display.
- Collapsible/resizable sidebar and keyboard-accessible map popovers.
- Local display preferences that do not alter exported train data.

### Data workflows

- Validates, imports, and exports canonical schema 1.3 JSON.
- Accepts a full store, a bare train array, or a single train object on lenient import paths.
- Progressively imports large stores one train at a time and reports progress.
- Opens and saves local JSON files where the browser supports the File System Access API, with download/share fallbacks elsewhere.
- Runs with server-backed autosave and live refresh locally, or browser-only IndexedDB persistence on static hosting.
- Exposes an HTTP endpoint that lets scripts and AI agents import trips into the local server.

## Supported regions

Every region has its own rail package, solver data, station-name table, sample data, saved store, and map bounds.

| Code | Region | Included network scope |
| --- | --- | --- |
| `jp` | Japan | Shinkansen, JR conventional lines, subways, private and third-sector railways, trams, monorails, AGTs, funiculars, and other published passenger rail |
| `tw` | Taiwan | High-speed rail, Taiwan Railways, metros, light rail, Alishan Forest Railway, and other packaged passenger lines |
| `hk` | Hong Kong | MTR heavy rail, all 11 Light Rail routes, and Hong Kong Tramways track |
| `mo` | Macao | Currently operating Macao LRT lines in the packaged dataset |
| `kr` | South Korea | High-speed, conventional, metropolitan, metro, light-rail, and monorail networks in the packaged dataset |

Package dates are identifiers, not promises of real-time completeness. Read the region source documents under `app/public/rail/` for exact versions and limitations.

## Try it online

The public static build is available at:

**<https://sager1145.github.io/Japan-Train-Map/>**

On first use, the site opens read-only sample data for the selected region. To keep changes:

1. Open the **Data** workspace.
2. Select **Save as My Data**.
3. Confirm the save.
4. Continue editing; subsequent changes auto-save in this browser.

Static-site data is stored in IndexedDB on the current browser and device. It is not uploaded and does not automatically sync across devices. Use **Save / Save As JSON** or **Download JSON** to make a portable backup.

The OpenFreeMap basemap needs an internet connection. The packaged railway overlays and route datasets are served with the site; choose **No Basemap** in **Map Layers** when an online basemap is unavailable or unwanted.

## Run locally

The local version adds server-backed persistence, Server-Sent Events for live tab updates, and the agent-import API.

### Requirements

- Node.js 18 or newer
- npm
- A modern browser with JavaScript and IndexedDB enabled

### Install and start

```bash
git clone https://github.com/Sager1145/Japan-Train-Map.git
cd Japan-Train-Map/app
npm ci
npm start
```

Open <http://localhost:3000>. Stop the server with `Ctrl+C`.

Use another port on macOS/Linux:

```bash
PORT=8080 npm start
```

PowerShell:

```powershell
$env:PORT=8080
npm start
```

After dependencies are installed, macOS/Linux users can alternatively run the repository-level launcher:

```bash
./run-app.sh
```

Set `NODE_BIN=/path/to/node` before the script to select a specific Node.js executable.

### Local persistence warning

Local edits auto-save into the country-specific files under `app/data/`. Some of these files are repository data, so editing trips may appear in `git status`. Export a JSON backup before clearing or replacing a store, and only commit itinerary changes intentionally.

## User guide

### 1. Choose a region, language, and theme

Use the selectors at the top of the menu:

- **Region** switches the railway network and the active data store.
- **Language** changes UI labels and available station-name readings.
- **Theme** selects System, Light, or Dark.

Switching regions never merges stores. Finish or export work in one region before moving to another if you need a portable backup.

### 2. Browse and filter trips

The **Trains** workspace contains the date bar, search box, train list, and list actions.

- Choose a date to show that day's trains.
- Choose **All** to combine dates.
- Enable **Map shows current date only** to hide off-date trips rather than dimming them.
- Use **Add Date** to create an empty date bucket.
- Use **Remove Empty Dates** to remove manual buckets with no trains.
- Search by train number, display name, station, or ID.
- Select a train card to highlight it and open it in the editor.
- Use **Locate** to fit the selected route in the map.
- Enable **Auto-focus** to fit newly selected trains automatically.

The train list sorts by date, then departure time, then ID. Trains without an explicit date use the current import date, a date inferred from an ID such as `20260703_train`, or the final `undated` bucket.

### 3. Create a train

1. Select the date that should own the train.
2. Press **Add Train**. The app creates a region-specific starter train with a unique ID.
3. In **Train Data**, edit the ID, train number, type, company, direction, origin, destination, and color.
4. Press **Apply Fields**.
5. Use **Show/Hide** to control whether the train is drawn without deleting it.
6. Use **Move Up** and **Move Down** to change its order in the store.

Train IDs may contain only ASCII letters, digits, `_`, and `-`, and must be unique within the active store.

### 4. Enter stops and times

The stop table is the ordered itinerary used by the route solver.

1. Keep the first row as `origin` and the last row as `destination`.
2. Use **Add Stop** for intermediate rows.
3. Enter the station name and, when available through JSON, its official `n02_station_code`.
4. Enter arrival/departure times using `HH:MM`.
5. Choose the correct stop type.
6. Mark the stopping stations you actually rode with **Ride**.
7. Reorder rows with the arrow buttons or delete them with `×`.

Stop types:

| Value | Meaning | Typical times |
| --- | --- | --- |
| `origin` | Boarding/start boundary | Departure required; arrival normally blank |
| `passenger_stop` | Scheduled passenger stop | Arrival and departure as applicable |
| `pass_through` | Station passed without stopping | Arrival/departure blank |
| `operational_stop` | Non-passenger operational stop | Arrival/departure as known |
| `destination` | Alighting/end boundary | Arrival required; departure normally blank |

Pass-through **Ride** checkboxes are read-only. Their effective state is derived from the nearest stopping stations on both sides. If either bounding stop is not ridden, the pass-through station and the adjoining un-ridden route segments are hidden.

For an overnight run, keep the train's starting date and continue the clock beyond 24 hours:

```text
23:48   same day
25:10   01:10 on the following day
48:05   00:05 two days later
```

The legacy form `10:00+1` can still be parsed, but 24+ hour notation is preferred. Overnight routes show a day-boundary marker and dashed continuation unless **Show Full Cross-Day Runs** is enabled in Display.

### 5. Rebuild the route

1. Confirm the active region is correct.
2. Confirm every important stop has the correct name or official station code.
3. Press **Rebuild Route from Stops**.
4. Wait for the status beneath the train fields.
5. Press **Locate** to frame the result.
6. If trip layers are hidden, open **Map Layers** and enable **Train Routes** plus the desired markers.

The editor can derive ordinary adjacent `route_sections` from the stops. Ambiguous branches, through services, and line-specific routings may require JSON constraints:

- `route_policy.preferred_line_names` and `preferred_operator_names` are train-wide soft preferences.
- `route_sections[].line_names` and `operator_names` are hard constraints for a particular adjacent-stop section.
- A route section can also carry a branch-specific `number` or `name` for joined/split services.

These advanced fields are not exposed by the basic train form. Edit or generate canonical JSON, import it, and then rebuild. See [jsonspec.md](./jsonspec.md) for the full rules.

### 6. Select and inspect the map

- Hover a route to see the train/section label.
- Click a route to select its train.
- Click or hover a station marker for station, time, line, and operator information where available.
- On touch devices, choose from the displayed list when several trains overlap under one tap.
- Click an empty part of the map to close a popup, clear the current train selection, and then return from a date to the **All** view one level at a time.
- Use the sidebar edge control to hide, show, or resize the workspace.

### 7. Read statistics

Open **Statistics** after routes are solved. The panel reports the selected date and complete store separately, including coverage, actual ride totals, line breakdowns, ride counts, and most-ridden sections.

Statistics are based on resolved geometry and effective `ride_segment` state. A train that validates but has no ridden stops contributes no visible trip and no ridden mileage.

## Map controls

Open **Map Layers** in the upper-right of the map.

| Control | Effect |
| --- | --- |
| OpenFreeMap / No Basemap | Selects the online light/dark basemap or a plain background |
| Train Routes | Shows or hides all recorded train-route lines |
| Intermediate Stops | Shows or hides passenger/operational stop markers |
| Terminals | Shows or hides origin/destination markers |
| Pass-through Stations | Shows or hides pass-through markers |
| All Railway Lines | Loads and displays the complete packaged network and station points |
| High-speed / conventional / metro / private categories | Filters ridden routes by railway category without changing the store |

The bottom-right information button explains map symbols and links to the active region's data sources.

### Display settings

The **Display** workspace stores visual preferences in browser local storage. These settings do not enter exported JSON.

Common controls include:

- route width;
- ridden-route opacity;
- off-date dimming;
- basemap opacity;
- terminal, stop-center, and pass-through marker sizes;
- marker border width;
- selected-route size boost;
- station kana, romanization, and Chinese-name display;
- complete versus dashed cross-day display; and
- mobile/desktop UI mode.

The advanced fitted-curve and hover-region controls are visualization/debugging aids. Fitted-curve slider changes require **Rebuild Fitted Curves** before they take effect, and fitted curves only apply where multiple trains share a corridor.

## Import, export, and persistence

### Import behavior

The two UI import paths intentionally do different things:

| Action | Behavior |
| --- | --- |
| Paste JSON → **Start Loading / Import Items** | Appends trains to the current store; duplicate incoming IDs receive unique suffixes |
| **Open Local JSON** | Validates the file and replaces the current active-region store |
| Agent `POST` with default `mode=replace` | Replaces the selected server store |
| Agent `POST` with `mode=append` | Upserts by exact ID; matching IDs are replaced |

Use **Validate Import JSON** before applying pasted content. Large imports load progressively and roll back the newly appended prefix if an item fails validation.

On the static site, importing while sample data is visible prompts you to convert the result into **My Data** so it will not disappear on reload.

### Export and backup

- **Export JSON** refreshes the on-page canonical JSON preview.
- **Save / Save As JSON** and **Download JSON** save the current active-region store.
- On supported touch devices, saving may open the system share sheet.
- **Download Current HTML** captures the current DOM but is a same-folder snapshot: it still references the app's scripts, styles, and data by relative URL and is not a standalone offline application.

Exported stores contain itinerary data and routing constraints, not solved GeoJSON geometry. Geometry is rebuilt or loaded from cache.

### Local server versus static site

| Capability | Local Node.js server | Static site / GitHub Pages |
| --- | --- | --- |
| User data | Country-specific JSON files under `app/data/` | Country-specific IndexedDB databases in the browser |
| Autosave | Debounced backend `PUT` | IndexedDB, one record per date |
| Sample data | Fallback when no saved store exists | Read-only, precomputed chunks |
| Multi-tab live refresh | Yes, through Server-Sent Events | No server push; stale same-date writes are rejected locally |
| Agent HTTP import | Yes | No backend endpoint |
| Local JSON import/export | Yes | Yes |

Server store files:

```text
app/data/train-store.json       Japan
app/data/train-store-tw.json    Taiwan
app/data/train-store-hk.json    Hong Kong
app/data/train-store-mo.json    Macao
app/data/train-store-kr.json    South Korea
```

### Destructive data actions

The **Danger Zone** contains:

- **Delete All**: removes every train from the current in-memory store.
- **Reset Sample**: local-server mode only; replaces the current store with the built-in default sample.
- **Clear Saved Data**: clears the active saved store and recovery copies after confirmation.

Export a JSON backup first. These actions are scoped to the active region, but their effect on that region is intentional.

## Train JSON format

Imports and exports use schema version 1.3:

```json
{
  "schema_version": "1.3",
  "trains": [
    {
      "id": "20260703_odoriko_001",
      "date": "2026-07-03",
      "number": "踊り子1号",
      "train_type": "特急",
      "company": "JR東日本",
      "origin": "東京",
      "destination": "伊豆急下田",
      "direction": "down",
      "visible": true,
      "style": {
        "color": "#2F80ED"
      },
      "stops": [
        {
          "name": "東京",
          "n02_station_code": null,
          "arrival": null,
          "departure": "09:00",
          "stop_type": "origin",
          "ride_segment": true
        },
        {
          "name": "伊豆急下田",
          "n02_station_code": null,
          "arrival": "11:40",
          "departure": null,
          "stop_type": "destination",
          "ride_segment": true
        }
      ]
    }
  ]
}
```

Important rules:

- The root must be a schema 1.3 store for canonical import/export. Lenient UI/API paths also accept a train array or one train object.
- Each train requires a unique `id`, `number`, `origin`, `destination`, and at least two stops.
- Every stop exports `name`, `n02_station_code`, `arrival`, `departure`, `stop_type`, and boolean `ride_segment`.
- `ride_segment` defaults to `false`; omitting it can produce a valid but invisible train.
- `n02_station_code` is a historical compatibility key whose value comes from the active region's official station-code system; it is not always a Japanese N02 code.
- Route geometry is not embedded in the store.
- Only the passenger's actual boarding-to-alighting range should be recorded for limited express and high-speed trips.

For all fields, route policies, station-code formats, validation rules, branch constraints, multilingual names, and pass-through behavior, read [jsonspec.md](./jsonspec.md). A complete importable itinerary is available in [samples](./samples/).

## HTTP API and agent imports

The API is available only when running the Node.js server.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api` | Health check, dataset/store index, and live-client count |
| `GET` | `/api/<dataset>` | Railway sections, stations, readings, defaults, and matched datasets |
| `GET` | `/api/train-store[-<country>]` | Read a saved country store; returns 404 if none exists |
| `PUT` | `/api/train-store[-<country>]` | Validate and replace a country store |
| `DELETE` | `/api/train-store[-<country>]` | Clear a country store |
| `GET` | `/api/events` | Server-Sent Events stream for live store changes |
| `POST` | `/api/agent/import` | Replace or append trains and notify open maps |

Country store endpoints:

| Region | Store endpoint |
| --- | --- |
| Japan | `/api/train-store` |
| Taiwan | `/api/train-store-tw` |
| Hong Kong | `/api/train-store-hk` |
| Macao | `/api/train-store-mo` |
| South Korea | `/api/train-store-kr` |

Rail-section, station, and reading datasets follow the same suffix rule: Japan is unsuffixed; the other regions use `-tw`, `-hk`, `-mo`, or `-kr`. `GET /api` returns the authoritative list for the running server.

### Agent import examples

Replace Japan's store:

```bash
curl -X POST "http://localhost:3000/api/agent/import?country=jp" \
  -H "Content-Type: application/json" \
  --data-binary @plan.json
```

Append to Taiwan's store, replacing trains with matching IDs:

```bash
curl -X POST "http://localhost:3000/api/agent/import?country=tw&mode=append" \
  -H "Content-Type: application/json" \
  --data-binary @more-trains.json
```

Valid countries are `jp`, `tw`, `hk`, `mo`, and `kr`. Valid modes are `replace` and `append`; `replace` is the default. The request body limit is 25 MB.

A successful response includes the mode, country, total/add/replace counts, imported IDs, and the number of connected live map clients. Open local-server tabs receive the change through `/api/events`, reload the correct country store, and solve/render the imported routes without a manual refresh.

See [AGENT.md](./AGENT.md) for the complete integration workflow.

## Development

Application commands run from `app/`.

### Common commands

```bash
npm start          # local Express app on port 3000
npm test           # Node test suite
npm run lint       # JavaScript, global-reference, JSON, and asset checks
npm run build      # precompute all samples and assemble the static site
npm run serve:static  # serve an existing ../_site build on port 4000
npm run dev:static    # full static build, then serve it
```

The full build writes `_site/` at the repository root. It can be computation- and memory-intensive because it solves every bundled sample route for all five regions plus the curated Japan loops.

Targeted data commands include:

```bash
npm run precompute
npm run precompute:tw
npm run precompute:hk
npm run precompute:mo
npm run precompute:kr
npm run precompute:new-year-grand-loop
npm run precompute:tokyo-limited-express-loop
npm run rebuild:railway:jp
npm run audit:apple-tiles:jp
```

The script catalog and dependency rules are documented in [app/scripts/README.md](./app/scripts/README.md). Files in `app/scripts/migrations/` are one-shot historical data corrections, not normal installation steps.

### Repository layout

```text
.
├── app/
│   ├── data/                 processed datasets, sample stores, and raw inputs
│   ├── public/               browser UI, MapLibre renderer, styles, and rail packages
│   ├── scripts/              build, validation, railway, sample, and migration tools
│   ├── server/               Express routes, persistence, delivery, and live events
│   ├── shared/               helpers shared by browser and server
│   ├── test/                 unit, integration, topology, and static-build tests
│   ├── package.json
│   └── server.js
├── samples/                  importable schema 1.3 itinerary examples
├── AGENT.md                  HTTP agent-control guide
├── DEPLOY-GITHUB-PAGES.md    static hosting and browser-storage guide
├── jsonspec.md               canonical train-store and data specification
└── run-app.sh                local launcher
```

The frontend uses framework-free classic JavaScript modules loaded in an intentional order. MapLibre GL renders the map and railway layers. Express serves static files, datasets, persistence endpoints, and live events in local mode. Shared protocol helpers live in `app/shared/` and must not import browser-only or tooling code.

### Verification before a change

For ordinary source changes:

```bash
cd app
npm run lint
npm test
```

For deployment or build changes, also run the relevant precompute commands and:

```bash
npm run build
npm run serve:static
```

Test the generated site at <http://localhost:4000>. The static server intentionally behaves like GitHub Pages: it has no backend API or fallback routing.

## Static deployment

The included [GitHub Actions workflow](./.github/workflows/deploy-pages.yml) deploys `_site/` whenever `main` is pushed.

For a fork:

1. Open the repository's **Settings → Pages**.
2. Choose **GitHub Actions** as the build source if it is not enabled automatically.
3. Push to `main` or run **Deploy to GitHub Pages** manually from the Actions tab.
4. Wait for both the build and deploy jobs to complete.

The workflow:

- installs dependencies with `npm ci`;
- precomputes sample routes for all regions and curated datasets;
- copies the frontend and published railway data;
- disables backend-only behavior;
- rewrites API requests to static `.json` files;
- fingerprints scripts and styles;
- runs lint and tests against the generated artifact; and
- uploads a `.nojekyll` Pages site.

Static hosting cannot provide server autosave, SSE live refresh, agent imports, shared multi-device data, or multi-user collaboration. See [DEPLOY-GITHUB-PAGES.md](./DEPLOY-GITHUB-PAGES.md) for storage details and deployment troubleshooting.

## Troubleshooting

### The server says the port is already in use

Run it on a different port:

```bash
PORT=3001 npm start
```

Then open <http://localhost:3001>.

### A train imported successfully but nothing is drawn

Check all of the following:

1. **Train Routes** is enabled in **Map Layers**.
2. The train's `visible` field is not `false`.
3. The relevant stopping stations have `ride_segment: true`.
4. The active region matches the train's station identifiers.
5. The selected-date filter is not hiding the train.
6. The route was rebuilt or allowed to finish solving.

### The solver cannot find a route

- Prefer official station codes over names when names are ambiguous.
- Confirm stop order and region.
- Check the train's line/operator constraints.
- Use hard per-section `line_names` constraints at branch points.
- Split a reversing or train-number-changing service into correctly constrained sections.
- Remember that the app refuses to draw a straight-line fallback.

### Changes disappeared on the live site

You were probably editing read-only sample data. Load the sample again if needed, then choose **Save as My Data** before editing. Browser privacy modes, site-data clearing, and some storage policies can delete IndexedDB; export JSON backups for important records.

### The basemap is blank

The railway overlay can still work without it. Check network/content-blocker settings, select **OpenFreeMap** again to retry, or choose **No Basemap**. The app retries failed tiles when connectivity returns.

### Import validation fails

- Confirm the JSON parses.
- Use `schema_version: "1.3"` for a full store.
- Ensure required train fields and at least two stops exist.
- Use only the five documented stop types.
- Make every `ride_segment` a boolean.
- Use `#RRGGBB` colors and valid train IDs.
- Remove unsupported fields; canonical objects reject unknown keys.

The import status preserves pasted text after failure so it can be corrected and retried.

### Static preview reports missing sample data

`npm run serve:static` only serves an existing artifact. Run the full build first:

```bash
npm run build
npm run serve:static
```

### Local saved data is corrupt

The server's `GET /api/train-store[-<country>]` path streams the stored bytes as-is so they can be inspected or recovered. Export or copy the file before using **Clear Saved Data**. Append imports intentionally refuse to overwrite a corrupt store.

## Railway data and attribution

This project combines processed government, operator, and OpenStreetMap data. Geometry is intended for journey visualization and coverage analysis, not engineering, cadastral, safety-critical, or real-time operational use.

- **Japan:** MLIT National Land Numerical Information, Railway Data N02-25; selected OpenStreetMap-derived names and attributes
- **Taiwan:** MOTC TDX/PTX, NLSC, the Alishan Forest Railway authority, and Taipei Metro GIS
- **Hong Kong:** MTR and Hong Kong Tramways official/open data, supplemented by prepared alignment data
- **Macao:** Macao Light Rapid Transit Corporation and DSCC mapping data
- **South Korea:** data.go.kr railway datasets and OpenStreetMap track geometry
- **Basemap:** OpenFreeMap and OpenStreetMap contributors

Detailed provenance, versions, rebuild methods, limitations, and applicable data licenses are recorded alongside each package:

- [Japan sources](./app/public/rail/jp-2025.sources.md)
- [Taiwan sources](./app/public/rail/tw-2025.sources.md)
- [Hong Kong sources](./app/public/rail/hk-2025.sources.md)
- [Macao sources](./app/public/rail/mo-2025.sources.md)
- [South Korea sources](./app/public/rail/kr-2025.sources.md)

Operator marks and line symbols belong to their respective owners and are used for identification. Their source records are maintained in `app/public/rail/logo-credits.json`.

No repository-wide software license file is currently present. Do not assume permission beyond the licenses and terms attached to each data source and asset.
