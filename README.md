# Japan Train Map · N02 Limited Express Train Manager / N02 特急列車管理

| English | 中文 |
| --- | --- |
| A Japanese railway map and JR limited-express / Shinkansen route editor built on "National Land Numerical Information (Railway Data N02)". An Express backend serves the rail and station data; a Leaflet frontend renders train routes, stops and pass-through stations on the map. All train data is auto-saved to and loaded from `train-store.json`. | 基于「国土数値情報（鉄道データ N02）」的日本铁路地图与 JR 特急 / 新干线列车线路编辑器。后端用 Express 提供铁路 / 车站数据，前端用 Leaflet 在地图上渲染列车路线、停靠站与通过站，所有列车数据通过 `train-store.json` 自动保存与载入。 |

---

## Run / 运行方法

| English | 中文 |
| --- | --- |
| **Prerequisite:** [Node.js](https://nodejs.org/) **18 or newer** (npm included). Run `node -v` to check your version. | **前置条件：** 已安装 [Node.js](https://nodejs.org/) **18 或更高版本**（自带 npm）。运行 `node -v` 可查看版本。 |
| All application code lives in the `app/` subfolder, so every command runs from there. | 应用代码都在 `app/` 子文件夹内，所有命令都需先进入该文件夹。 |

### Windows (PowerShell or Command Prompt) / Windows（PowerShell 或命令提示符）

```powershell
cd app
npm install      # install dependencies, first run only / 首次安装依赖，之后可跳过
npm start        # start the server / 启动服务器
```

| English | 中文 |
| --- | --- |
| Then open <http://localhost:3000> in your browser. | 然后在浏览器中打开 <http://localhost:3000>。 |
| Stop the server: press `Ctrl + C` in the terminal. | 停止服务器：在终端按 `Ctrl + C`。 |

### macOS (Terminal) / macOS（终端 Terminal）

```bash
cd app
npm install      # install dependencies, first run only / 首次安装依赖，之后可跳过
npm start        # start the server / 启动服务器
```

| English | 中文 |
| --- | --- |
| Then open <http://localhost:3000> in your browser. | 然后在浏览器中打开 <http://localhost:3000>。 |
| Stop the server: press `Control + C` in the terminal. | 停止服务器：在终端按 `Control + C`。 |

| English | 中文 |
| --- | --- |
| The commands are essentially identical on both systems: `cd` into the `app` folder under the project root, then run `npm install` and `npm start`. To use a different port, set the `PORT` environment variable (macOS: `PORT=8080 npm start`; Windows PowerShell: `$env:PORT=8080; npm start`). | 两个系统的命令基本一致：先 `cd` 进入项目根目录下的 `app` 文件夹，再依次执行 `npm install` 与 `npm start`。如需更换端口，可设置环境变量 `PORT`（macOS：`PORT=8080 npm start`；Windows PowerShell：`$env:PORT=8080; npm start`）。 |

---

## Project structure / 项目结构

```
Japan Train Map/
├── README.md            # this file / 本文件
├── jsonspec.md          # train JSON data spec (schema_version 1.3, 1.2-compatible) / 列车 JSON 数据规范
├── samples/             # sample JSON (a real spec-compliant itinerary to import) / 示例 JSON，可在界面导入参考
│   └── jr_limited_shinkansen_itinerary_*.json
└── app/                 # the application / 应用本体
    ├── server.js        # Express backend: data API + static frontend / 后端：数据 API + 静态前端
    ├── package.json     # dependencies and start scripts / 项目依赖与启动脚本
    ├── package-lock.json
    ├── node_modules/    # dependencies (created by npm install) / 依赖，npm install 生成
    ├── public/          # frontend / 前端
    │   ├── index.html   # page / 页面
    │   ├── app.js       # map + editor logic (Leaflet) / 地图与编辑器逻辑（Leaflet）
    │   └── styles.css   # styles / 样式
    └── data/            # data / 数据
        ├── rail-sections.json    # N02 rail section geometry / N02 铁路区间几何
        ├── stations.json         # N02 stations / N02 车站
        ├── default-trains.json   # built-in sample trains / 内置示例列车
        ├── matched-routes.json   # matched routes / 匹配后的路线
        ├── matched-stops.json    # matched stops / 匹配后的停靠站
        ├── train-store.json      # persisted train data (auto save/load) / 列车数据持久化存储（自动保存 / 载入）
        └── N02-25_GML.zip        # raw N02 GML source data / N02 原始 GML 数据源
```

---

## API / 接口

Once the server is running it exposes the following endpoints. / 服务器启动后提供以下接口：

| Method / 方法 | Path / 路径 | Description | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api` | List all available datasets | 列出所有可用数据集 |
| `GET` | `/api/rail-sections` | N02 rail section geometry | N02 铁路区间几何数据 |
| `GET` | `/api/stations` | N02 station data | N02 车站数据 |
| `GET` | `/api/default-trains` | Built-in sample trains | 内置示例列车 |
| `GET` | `/api/matched-routes` | Matched routes | 匹配后的路线 |
| `GET` | `/api/matched-stops` | Matched stops | 匹配后的停靠站 |
| `GET` | `/api/train-store` | Read the saved train store (404 if none saved) | 读取已保存的列车存储（无则返回 404） |
| `PUT` | `/api/train-store` | Save the train store (body must be a `schema_version` `"1.3"` or `"1.2"` store object) | 保存列车存储（请求体须为 `schema_version` 为 `"1.3"` 或 `"1.2"` 的存储对象） |
| `DELETE` | `/api/train-store` | Clear the saved store; next boot falls back to built-in defaults | 清空已保存的存储，下次启动回退到内置默认值 |
| `POST` | `/api/agent/import` | **Agent control:** import a full `1.3` store; open maps re-solve & render it automatically (`?mode=append` to merge) | **代理操作：** 导入完整 `1.3` 存储，已打开的地图自动重算并渲染（`?mode=append` 合并） |
| `GET` | `/api/events` | Server-Sent Events stream of `store-changed` notifications (the frontend uses this for live refresh) | `store-changed` 通知的 SSE 流（前端用于实时刷新） |

| English | 中文 |
| --- | --- |
| The frontend loads from the train-store endpoint on boot and auto-saves edits back via `PUT` — no manual action needed. API calls resolve relative to `index.html` (so the app also works when served under a sub-path). | 前端启动时从 train-store 接口载入数据，编辑后自动通过 `PUT` 保存，无需手动操作。API 调用相对于 `index.html` 解析（因此部署在子路径下也能正常工作）。 |
| **AI agents** can drive the app directly: `POST` a rail plan to `/api/agent/import` and every open map live-refreshes via `/api/events` (Server-Sent Events) — re-solving and re-rendering the route with no manual reload. See [`AGENT.md`](./AGENT.md) for the full agent guide. | **AI 代理**可直接操作本应用：将行程 `POST` 到 `/api/agent/import`，所有已打开的地图通过 `/api/events`（SSE）实时刷新——自动重算并重绘路线，无需手动刷新。完整代理指南见 [`AGENT.md`](./AGENT.md)。 |

---

## Train JSON spec / 列车 JSON 规范

| English | 中文 |
| --- | --- |
| The top-level format for imported / exported JSON is fixed: | 导入 / 导出的 JSON 顶层格式固定为： |

```json
{
  "schema_version": "1.3",
  "trains": []
}
```

| English | 中文 |
| --- | --- |
| Each train carries a `date` field (`YYYY-MM-DD`, added in 1.3). The sidebar groups trains by date — a date-button bar, the selected day's list, and an `全部` / All combined list — sorted by date then departure time. Older `1.2` JSON without `date` still imports: the date is taken from the currently-selected day, then inferred from the id prefix (e.g. `20260703_...` → `2026-07-03`), otherwise `undated`. | 每个 train 带有 `date` 字段（`YYYY-MM-DD`，1.3 新增）。侧栏按日期分组——日期按钮区、当前日期列表，以及 `全部` 总清单——并按日期与发车时间排序。没有 `date` 的旧版 `1.2` JSON 仍可导入：日期取当前选中日期，其次从 id 前缀解析（如 `20260703_...` → `2026-07-03`），都没有则为 `undated`。 |
| Field meanings, route policy (`route_policy`), stops / pass-through stations (`route_sections`) and the optional geometry cache (`route_geometry_cache`) are fully defined in [`jsonspec.md`](./jsonspec.md). A real spec-compliant itinerary is provided under `samples/` and can be imported directly from the UI for reference. | 字段含义、路线策略（`route_policy`）、停靠站 / 通过站（`route_sections`）以及可选的几何缓存（`route_geometry_cache`）等完整定义见 [`jsonspec.md`](./jsonspec.md)。`samples/` 下提供了一份符合该规范的真实行程示例，可直接在界面中导入参考。 |

---

## Data sources / 数据来源

| English | 中文 |
| --- | --- |
| Railway and station data: produced by processing "National Land Numerical Information (Railway Data N02)" (Ministry of Land, Infrastructure, Transport and Tourism of Japan). © MLIT Japan, CC BY 4.0. | 铁路与车站数据：「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成。© 日本国土交通省，CC BY 4.0。 |
| Map basemap: © OpenStreetMap contributors. | 地图底图：© OpenStreetMap contributors。 |
