# Japan Train Map · N02 特急列車管理

基于「国土数値情報（鉄道データ N02）」的日本铁路地图与 JR 特急 / 新干线列车线路编辑器。
后端用 Express 提供铁路 / 车站数据，前端用 Leaflet 在地图上渲染列车路线、停靠站与通过站，
所有列车数据通过 `train-store.json` 自动保存与载入。

---

## 运行方法

> 前置条件：已安装 [Node.js](https://nodejs.org/) **18 或更高版本**（自带 npm）。
> 在终端中运行 `node -v` 可查看版本。

应用代码都在 `app/` 子文件夹内，所有命令都需要先进入该文件夹。

### Windows（PowerShell 或 命令提示符）

```powershell
cd "app"
npm install      # 首次运行时安装依赖（之后可跳过）
npm start        # 启动服务器
```

启动后在浏览器中打开： <http://localhost:3000>
停止服务器：在终端按 `Ctrl + C`。

### macOS（终端 Terminal）

```bash
cd app
npm install      # 首次运行时安装依赖（之后可跳过）
npm start        # 启动服务器
```

启动后在浏览器中打开： <http://localhost:3000>
停止服务器：在终端按 `Control + C`。

> 提示：两个系统的命令基本一致。先用 `cd` 进入项目根目录下的 `app` 文件夹，
> 再依次执行 `npm install` 和 `npm start`。如需更换端口，可设置环境变量
> `PORT`（例如 macOS：`PORT=8080 npm start`；Windows PowerShell：`$env:PORT=8080; npm start`）。

---

## 项目结构

```
Japan Train Map/
├── README.md            # 本文件
├── jsonspec.md          # 列车 JSON 数据规范（schema_version 1.2）
└── app/                 # 应用本体
    ├── server.js        # Express 后端：提供数据 API + 静态前端
    ├── package.json     # 项目依赖与启动脚本
    ├── package-lock.json
    ├── node_modules/    # 依赖（npm install 生成）
    ├── public/          # 前端
    │   ├── index.html   # 页面
    │   ├── app.js       # 地图与编辑器逻辑（Leaflet）
    │   └── styles.css   # 样式
    └── data/            # 数据
        ├── rail-sections.json    # N02 铁路区间几何
        ├── stations.json         # N02 车站
        ├── default-trains.json   # 内置示例列车
        ├── matched-routes.json   # 匹配后的路线
        ├── matched-stops.json    # 匹配后的停靠站
        ├── train-store.json      # 列车数据持久化存储（自动保存 / 载入）
        ├── N02-25_GML.zip        # N02 原始 GML 数据源
        └── samples/              # 示例 JSON
            └── jr_limited_shinkansen_itinerary_*.json
```

---

## 接口（API）

服务器启动后提供以下接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api` | 列出所有可用数据集 |
| `GET` | `/api/rail-sections` | N02 铁路区间几何数据 |
| `GET` | `/api/stations` | N02 车站数据 |
| `GET` | `/api/default-trains` | 内置示例列车 |
| `GET` | `/api/matched-routes` | 匹配后的路线 |
| `GET` | `/api/matched-stops` | 匹配后的停靠站 |
| `GET` | `/api/train-store` | 读取已保存的列车存储（无则返回 404） |
| `PUT` | `/api/train-store` | 保存列车存储（请求体须为 `schema_version: "1.2"` 的存储对象） |
| `DELETE` | `/api/train-store` | 清空已保存的存储，下次启动回退到内置默认值 |

前端会自动从 `/api/train-store` 载入数据，编辑后自动通过 `PUT` 保存，无需手动操作。

---

## 列车 JSON 规范

导入 / 导出的 JSON 顶层格式固定为：

```json
{
  "schema_version": "1.2",
  "trains": []
}
```

字段含义、路线策略（`route_policy`）、停靠站 / 通过站（`route_sections`）等
完整定义见 [`jsonspec.md`](./jsonspec.md)。
`app/data/samples/` 下提供了一份符合该规范的真实行程示例，可直接在界面中导入参考。

---

## 数据来源

- 铁路与车站数据：「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成。
  © Ministry of Land, Infrastructure, Transport and Tourism of Japan, CC BY 4.0.
- 地图底图：© OpenStreetMap contributors.
