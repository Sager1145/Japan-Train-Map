# N02 Limited Express Train Manager

The original app was a single ~16 MB `index.html` with all data, CSS and the Leaflet
library inlined. It has been split into a **backend** (Node + Express) that serves the
large datasets over an API, and a **frontend** (plain HTML/CSS/JS) that fetches them.

## Structure

```
n02-train-manager/
├── server.js              # Express server: data API + static frontend
├── package.json
├── data/                  # Datasets extracted from the old index.html
│   ├── rail-sections.json   (~12 MB, 21,933 features)
│   ├── stations.json        (~3.3 MB, 10,234 features)
│   ├── default-trains.json
│   ├── matched-routes.json
│   └── matched-stops.json
└── public/                # Frontend (served as static files)
    ├── index.html         # Loads Leaflet from CDN + styles.css + app.js
    ├── styles.css         # App styles (Leaflet CSS now comes from CDN)
    └── app.js             # App logic; fetches data from /api/* on startup
```

## Running

```bash
cd n02-train-manager
npm install
npm start            # http://localhost:3000  (set PORT to change)
```

## API

| Endpoint               | Returns                          |
|------------------------|----------------------------------|
| `GET /api`             | List of available datasets       |
| `GET /api/rail-sections` | N02 railway sections GeoJSON   |
| `GET /api/stations`      | N02 stations GeoJSON           |
| `GET /api/default-trains`| Default train store            |
| `GET /api/matched-routes`| Matched limited-express routes |
| `GET /api/matched-stops` | Matched stops                  |

Large files are streamed from disk (not parsed per request) and sent with a 1-hour
`Cache-Control`.

## What changed in the frontend

- The five `<script type="application/json">` data blocks were removed from `index.html`
  and moved to `data/`. On startup `app.js` fetches them in parallel via `loadAppData()`
  before initializing the map.
- Leaflet's CSS and JS are loaded from the unpkg CDN instead of being inlined.
- CSS and JS were extracted into `styles.css` and `app.js`.
- The client-side train store still persists to `localStorage` / a local JSON file —
  per the chosen scope, the backend serves data only and does not persist trains.

## Notes

- The "下載目前 HTML" (download current HTML) button still works but now produces the
  frontend shell without embedded data, since the data lives on the server.
- The original `index.html` (and `index.zip`) in the parent folder are left untouched.
