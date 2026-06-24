# Agent control / AI 代理操作指南

This document is for an AI agent (e.g. Claude) that needs to **drive the Japan
Train Map app directly**: import a rail plan and have the route appear on the
map automatically, with no clicking and no manual reload.

本文件面向需要**直接操作本应用**的 AI 代理（如 Claude）：导入行程后，路线会
自动在地图上渲染，无需任何点击或手动刷新。

---

## How it works / 工作原理

1. The agent `POST`s a full `schema_version` `"1.3"` train store to
   `POST /api/agent/import`.
2. The server validates it, saves it to `data/train-store.json`, and pushes a
   `store-changed` event over Server-Sent Events (`GET /api/events`).
3. Every open browser tab receives the event, reloads the store, **re-solves
   each route's geometry** (Dijkstra over the N02 rail graph) and re-renders the
   map — automatically.

So the agent never touches the UI. It only calls one HTTP endpoint; the open map
updates itself.

> The route geometry is solved **in the browser**, from each train's `origin`,
> `destination`, `route_policy` and `route_sections`. The richer those fields,
> the more precise the rendered line — see [`jsonspec.md`](./jsonspec.md) for the
> full field semantics.

---

## Endpoints / 接口

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/agent/import` | Import a rail plan (replace by default). |
| `POST` | `/api/agent/import?mode=append` | Merge trains into the existing store (upsert by `id`). |
| `GET`  | `/api/events` | SSE stream of `store-changed` events (the frontend subscribes; agents normally don't need this). |
| `GET`  | `/api/train-store` | Read the currently-saved store (`404` if none). |
| `PUT`  | `/api/train-store` | Same as before — the UI's autosave path. |
| `DELETE` | `/api/train-store` | Clear the store; open maps fall back to built-in defaults. |
| `GET`  | `/api` | Health/listing, includes `live_clients` (number of open maps). |

### `POST /api/agent/import`

**Body** — a full canonical store (preferred):

```json
{
  "schema_version": "1.3",
  "trains": [ { "id": "20260703_odoriko_001", "...": "..." } ]
}
```

For convenience the endpoint is also lenient: a **bare array of trains**
(`[ {…}, {…} ]`) or a **single train object** (`{ "id": …, "stops": […] }`) is
accepted and wrapped into a 1.3 store automatically.

**Query**

- `mode=replace` *(default)* — the posted store becomes the entire store.
- `mode=append` — posted trains are merged into the existing store; a posted
  train whose `id` already exists **replaces** that train (upsert).

**Response**

```json
{
  "ok": true,
  "mode": "replace",
  "trains_total": 1,
  "trains_added": 1,
  "trains_replaced": 0,
  "live_clients": 1,
  "ids": ["20260703_odoriko_001"]
}
```

`live_clients` tells the agent how many maps are currently open and will update.
If it is `0`, the plan is still saved — it renders the next time the page opens.

---

## Examples / 示例

Replace the whole store with one train (curl):

```bash
curl -X POST http://localhost:3000/api/agent/import \
  -H "Content-Type: application/json" \
  --data-binary @plan.json
```

Append more trains without dropping what's already there:

```bash
curl -X POST "http://localhost:3000/api/agent/import?mode=append" \
  -H "Content-Type: application/json" \
  --data-binary @more-trains.json
```

PowerShell (Windows):

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/agent/import `
  -ContentType "application/json" -InFile plan.json
```

Minimal valid train (the browser solves the route from these fields):

```json
{
  "schema_version": "1.3",
  "trains": [
    {
      "id": "20260703_test_001",
      "date": "2026-07-03",
      "name": "踊り子1号",
      "origin": "東京",
      "destination": "伊豆急下田",
      "stops": [
        { "name": "東京", "stop_type": "origin", "departure": "09:00" },
        { "name": "伊豆急下田", "stop_type": "destination", "arrival": "11:40" }
      ]
    }
  ]
}
```

---

## Agent checklist / 代理操作清单

1. Make sure the server is running (`cd app && npm start`, default
   <http://localhost:3000>).
2. Build a `schema_version` `"1.3"` store per [`jsonspec.md`](./jsonspec.md).
   A real, importable example lives in [`samples/`](./samples).
3. `POST` it to `/api/agent/import` (use `?mode=append` to add without
   replacing).
4. Check the JSON response: `ok: true`, the `ids`, and `live_clients`.
5. Any open map re-solves and draws the route on its own. To confirm visually,
   open or reload <http://localhost:3000>.

---

## Notes / 说明

- **Live refresh is automatic.** Each open tab subscribes to `/api/events` on
  boot and reloads on any store change (agent import, another tab's edit, or a
  clear). The tab that made an edit skips its own echo via an `X-Client-Id`
  header, so there is no reload loop.
- **The store is the single source of truth.** The agent import path writes the
  same `data/train-store.json` the UI autosaves to, so agent and human edits
  interoperate.
- **Solving is client-side.** The server does not compute geometry; it stores
  and broadcasts. A plan therefore renders only where a browser can solve it —
  but the saved plan persists regardless of whether a map is open.
