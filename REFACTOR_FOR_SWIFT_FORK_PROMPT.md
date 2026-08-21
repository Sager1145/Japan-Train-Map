# 重构 prompt —— 以「能被照着移植成 Swift/iOS」为验收标准

> 一句话：这一轮重构的目标和上一轮一样（更有条理、更好读、删冗余、把运作逻辑讲清楚、
> 把函数之间的连接理顺），但**验收标准变了**：不是「读起来舒服」，而是
> **一个不认识这份代码的人，能不能照着它把同一个 app 写成 Swift**。
>
> 这两件事不冲突，而且是同一件事。上一轮之所以停在 8 个环，是因为再往下拆需要一个
> 「为什么要拆」的外部理由。现在有了：**分叉线就是拆分线。**

- 前作：[`REFACTOR_FRONTEND_ARCHITECTURE_PROMPT.md`](./REFACTOR_FRONTEND_ARCHITECTURE_PROMPT.md)
  —— app 家族的边界重构，已完成。**它的全部契约与硬性规则本文继承，不重复罗列的部分请直接去读它。**
- 本文接手它**没覆盖**的三块：`railmap-*` 地图层、`scripts/` 工具层、以及「移植边界」这个新主轴。

---

## 一、今天的实测基线（2026-08-21，`f21d337`，工作树干净）

不是估计，是刚跑出来的：

| 指标 | 值 | 怎么量的 |
| --- | --- | --- |
| 测试 | **294 pass / 0 fail**（16.2 s） | `cd app && npm test` |
| lint | 通过 | `npm run lint` |
| 前端 | **53 个 classic script / 33,614 行 / 2,060 个函数** | `wc -l public/*.js`、`npm run report:frontend` |
| 文件间依赖边 | **332** | `report:frontend` 的 File-level dependency map |
| 双向环（2-cycle） | **8** | 同上，全部是 B 类「设计使然」 |
| 共享可变绑定 | **171** | 同上 |
| ≥120 行的函数 | **38 个**（最长 929 行） | 括号配平扫描 |
| `scripts/` | **114 个 .mjs/.js/.py / 46,060 行** | `find scripts -type f` |
| 静态站点产物 | `_site` **51 MB**（`api/` 30 M + `rail/` 17 M） | `npm run build:static` 后 `du -sh` |

八个双向环（保留，见前作 §三 B 类）：

    app.js            ↔ app-country-session.js     setupCountrySelect
    app-render.js     ↔ app-editor.js              renderEditor ↔ applyMutationResult
    app-render.js     ↔ app-route-render.js        renderTrainLayers ↔ applyMutationResult
    app-render.js     ↔ app-store-ops.js           getTrain ↔ applyMutationResult
    app-store-ops.js  ↔ app-validation.js          validateTrain ↔ 四个规范化入口
    app-deck-records.js ↔ app-overlap-lanes.js     buildDeckOverlapMap ↔ 16 个反向符号
    app-deck-records.js ↔ app-map-init.js          handleDeckMarkerClick ↔ 三个 popup 入口
    railmap.js        ↔ railmap-interactions.js    RailMap ↔ RailMap（后者是前者的扩展文件）

**结论先说：这份代码对「JS 项目」而言已经算整齐**——每个文件有头注释、
`app.js` 和 `railmap.js` 的头部各自画了完整的模块地图、长函数带 §分节。
真正缺的四样东西全部是**分叉才暴露出来的**：

1. 图层/样式目录是**命令式 JS**，不是数据 —— Swift 端没法复用；
2. 平台设施（IndexedDB / fetch / SSE / Worker / MediaRecorder）**没有命名端口**，
   散在业务文件里 —— Swift 端不知道要实现哪几个接口；
3. 没有**黄金夹具（golden fixtures）** —— 移植后无法证明算法算得一样；
4. `scripts/` 有**实测的重复实现**（下面点名）—— 移植时会照抄三份不同的真相。

---

## 二、主轴：按「可移植性」重新分层

这是本轮的核心分析。逐文件数了 DOM / `window.` / MapLibre / IndexedDB / fetch 的出现次数，
33,614 行分成六层（行数加总正好等于全量，无遗漏）：

| 层 | 文件 | 行数 | 占比 | 移植方式 |
| --- | ---: | ---: | ---: | --- |
| **P 纯领域逻辑**（零 DOM、零 MapLibre、零存储） | 20 | **14,369** | 43% | **1:1 翻译成 Swift**，行为必须逐位等价 |
| **S 样式/设计 token** | 4 | 2,703 | 8% | 抽成**数据**，两端共读同一份 |
| **N i18n 目录** | 2 | 1,856 | 5% | 转成 `.xcstrings` 资源 |
| **M 地图适配** | 7 | 6,320 | 19% | MapLibre GL JS → **MapLibre Native (iOS)**，逐调用对照 |
| **V 视图/DOM** | 14 | 6,663 | 20% | **重写**为 SwiftUI，不移植 |
| **X 平台设施** | 6 | 1,703 | 5% | 换实现（见 §五映射表） |

P 层名单（这 14,369 行是分叉的真正资产，也是最该被讲清楚的部分）：

    rail-network.js 2286   app-overlap-lanes.js 2319   app-deck-records.js 1590
    app-route-graph.js 1450   app-route-solver.js 1375   app-stats.js 989
    railmap-geometry.js 853   app-store-ops.js 775   app-operator-branding.js 547
    app-route-simplify.js 523   app-route-features.js 281   app-validation.js 273
    app-stations.js 271   app-dates.js 192   app-route-service.js 191
    railmap-popup.js 146   app-datasets.js 128   app-coords.js 118
    app-scheduling.js 32   app-import-controller.js 30

**本轮重构的方向，就是让这六层在文件层面真的分开。** 现在还混着的地方（实测，逐条可查）：

| 混在哪 | 证据 | 该怎么归位 |
| --- | --- | --- |
| `app-events.js` 1,031 行里 128 处 DOM，但也持有事件语义 | `bindEvents` 388 行、`setupSidebarToggle` 268 行 | 语义留下、绑定表数据化（§Phase 2） |
| `app-persistence.js` 16 DOM + 19 IndexedDB + 3 fetch 混在一个文件 | `wc` + grep | X 层要拆出命名端口（§Phase 3） |
| `app-map-init.js` 45 DOM + 33 MapLibre | 同上 | V/M 分家 |
| `railmap-style.js` 的 `buildBaseStyle` **929 行**（全仓最长函数） | `railmap-style.js:997` | S 层数据化（§Phase 1，本轮最大收益） |
| `app-playback-video.js` 87 DOM + MediaRecorder | 同上 | 整个文件是 V+X，Swift 端全新写 |

---

## 三、不可动的契约

前作 §一 的五条**全部继承**（classic script 单一全局作用域 / `index.html` 顺序是唯一真相 /
`public/` 必须扁平且 app 家族以 `app` 开头 / 四个样式表层叠顺序即行为 / `.js.gz` 是服务器生成的 sidecar），
外加前作 §1.1 的**动态全局桥**（`RailOperatorBranding`、`activeRailPackageUrl`、`PERF_DEBUG`
—— 静态分析看不见，「lint 说没人用」不构成删除理由）。

本轮新增两条：

6. **`shared/app-core.js` 是唯一的 UMD 双载点**（427 行，浏览器挂 `AppCore`、Node 走
   `module.exports`）。它是 web 与 Node 之间已经存在的唯一共享层；**不要再开第二个**，
   要共享就往它里面放，或者按前作 §四 的结论选一个三方都已加载的叶子。
7. **`public/rail/*.json`（compact 包）与 `public/api/*.json` 是跨语言数据契约。**
   Swift 端将直接读同一批文件。**任何字段重命名从此是破坏性变更**，必须同步
   `scripts/validation/build-jsonspec-value-catalog.mjs` 与 `jsonspec.md`。

---

## 四、阶段计划

每一阶段都必须同时回答两个问题：*JS 侧有没有更清楚？* *Swift 侧有没有更好抄？*
只答得上一个的，不做。

### Phase 0 · 冻结基线 + 清垃圾（半天）

- 记录本文 §一 全部数字为基线；跑一次 `npm run precompute` 存下
  `data/sample-data` 的整树哈希（前作用的验收锚点）。
- 删掉工作副本里的 Finder 复制垃圾：仓库根有 **37 个空的 `_site N/` 目录**，
  `_site/` 里有 `rail-network 2.js`、`app-overlap-lanes 2/3/4.js` 这类重复产物
  （`.gitignore:57` 已忽略，所以不脏 git，但静态服务器实实在在多背了这些字节）。
- 不改任何 `public/*.js`。**这一阶段是纯粹的量尺子。**

### Phase 1 · railmap 层：把「图层目录」从代码变成数据（本轮最大收益）

上一轮完全没碰这七个文件（6,320 行）。它们**不难读**——`railmap.js` 头部有完整模块地图，
`buildBaseStyle` 有 §1–§11 分节——问题是**形态**：一份 MapLibre 图层目录被写成了 929 行命令式函数。

1. `buildBaseStyle`（`railmap-style.js:997`）拆成两半：
   **①「图层清单」**——每个图层的 id / source / 依赖的 paint 表达式，声明为纯数据；
   **②「装配器」**——把主题、network、opts 代入清单产出 style JSON。
   JS 侧收益：929 行 → 清单 + 一个短装配器，加图层不再需要读 900 行。
   Swift 侧收益：**清单可以直接序列化成 JSON，被 MapLibre Native 读**，
   两端从此共用同一份图层定义，而不是各写一遍。
2. **表达式平价核对表。** 实测在用的 MapLibre 算子只有 13 种、paint/layout 属性 9 种：

       get 101 · case 14 · zoom 13 · coalesce 13 · interpolate 6 · in 5
       literal 4 · step 3 · var 2 · match 2 · line-progress 2 · at 2 · let 1
       line-width 37 · line-dasharray 6 · text-field 4 · line-gradient 4
       icon-image 4 · text-variable-anchor 3 · symbol-sort-key 2
       line-sort-key 2 · circle-pitch-alignment 1

   面窄是好消息。逐条对 MapLibre Native iOS 当前版本核实**是否支持、语义是否一致**，
   写成一张表进 `app/docs/`。**不要假设支持，逐条核实并记录版本号。**
   `line-gradient` + `line-progress`（尾迹）与 `text-variable-anchor` 是重点核对项。
3. `rail-network.js`（2,286 行）当前一个文件干三件事：**包解码**、**几何派生**
   （`displayPartsForLine` 143 行、`canonicalizeRouteFeature` 163 行、
   `buildNetworkFromCompactPackage` 365 行）、**空间索引**。三件事三个边界，
   这也正是 Swift 端会分成的三个 type。
4. `railmap-interactions.js ↔ railmap.js` 那个环**不要动**——后者是前者的官方扩展文件，
   头注释写明了，是一个模块拆成两个文件，不是耦合。

**验收**：`npm test` ≥ 294、lint 过、`report:frontend` 边数不增、
**style JSON 的输出逐字节相同**（拿 attach 前后的 `map.getStyle()` 序列化对拍）。

### Phase 2 · view 与 domain 的缝（V 层 6,663 行）

- `bindEvents` 388 行 + `setupSidebarToggle` 268 行 → **声明式绑定表**
  （元素 → 事件 → 动作名），行为不变。JS 侧：一眼看得出「哪个控件触发哪个动作」；
  Swift 侧：这张表就是 SwiftUI 的 action 列表，不用逆向 388 行。
- `renderStopsTable` 207 行（`app-editor.js:116`）等 V 层长函数：把里面残留的
  **领域计算**（时刻推导、站序判定、里程换算）下沉到 P 层文件，DOM 拼装留在原地。
  判据很简单：**这段代码在没有 `document` 的环境下还有意义吗？** 有 → 它属于 P 层。
- 这一步会自然产生一张「**领域动作清单**」（app 能做的全部事：增删改行程、
  切国家、导入、播放、导出…）。**把它写进文档**——它就是 Swift 端的 view-model 协议。

### Phase 3 · 平台端口（X 层 1,703 行）

把散落的平台设施收敛成**命名端口**，每个端口一个文件、一份接口注释：

| 端口 | 现在在哪 | Swift 端要实现成什么 |
| --- | --- | --- |
| `StorePort`（读写行程库） | `app-persistence.js` 的 IndexedDB 段（19 处） | SQLite/GRDB 或 Core Data |
| `DatasetPort`（取 rail 包/站点/分片） | `app-api.js` + `app-datasets.js` + `app-import.js` 的 fetch | bundle 内文件 + `URLSession` |
| `LivePort`（变更推送） | `app-live-refresh.js`（SSE） | iOS 单机版**可以没有**，端口留空实现 |
| `ComputePort`（后台算力） | `app-fit-worker.js`（Web Worker） | `Task` / `DispatchQueue` |
| `CapturePort`（录像导出） | `app-playback-video.js` 的 MediaRecorder | `AVAssetWriter`（见 §五注意事项） |

`runtime-config.js` + `app-precompute-adapter.js` 已经是这个思路的雏形（前作留下的），
照着它们的写法扩展即可。**做完这一步，Swift 工程的 protocol 列表就是这五个。**

### Phase 4 · `scripts/` 去重与归档（114 文件 / 46,060 行）

前作把这一层列为「只出清单、不动代码」。现在要动了，因为移植时照抄三份不同真相是真实风险。

**实测的重复实现**（同名函数分布在多文件，已核对不是同名异义的全部列出）：

| 函数 | 份数 | 分布 |
| --- | ---: | --- |
| `parseArgs` | 7 | `promote-lines` + 6 个 `validation/*` |
| `metres` | 7 | 5 个 railway 脚本 + 1 migration + 1 test |
| `decodeIntervals` | 5 | `public/rail-network.js` + 4 个脚本 |
| `turnDegrees` | 5 | `public/rail-network.js` + 2 脚本 + 2 测试 |
| `distanceMeters` | 4 | `public/app-route-simplify.js`（合并后的唯一 haversine）+ `rail-network.js`（**故意不同的等距圆柱算法**）+ 1 脚本 + 1 测试 |
| `station` / `departureOf` / `makeTrain` / `makeJourney` | 6/6/4/3 | 全部在 `scripts/migrations/` 的一次性行程脚本里 |

做法，按优先级：

1. **`parseArgs` ×7 → `scripts/lib/`。** 纯机械，零风险，最先做。
2. **`decodeIntervals` / `turnDegrees` / `metres`**：先判定**是不是同一个算法**。
   前作在 `distanceMeters` 上栽过一次——当时以为三份重复，实测是**两个算法家族**
   （haversine R=6371000 与等距圆柱 111320 m/deg），合并前必须对拍。
   **同样的对拍纪律照搬**：从成品包取真实经纬度，比 IEEE-754 位型，零差异才合并。
3. **`scripts/migrations/` 的 17 个一次性脚本归档。** `add-august-*-itinerary.mjs` 这一批
   是历史操作记录，跑过就不会再跑，却贡献了上表一半的重复。移进
   `scripts/migrations/archive/`（或按仓库习惯只留 ledger 记录），
   `package.json` 里对应的 `update:*` 脚本一并处理。**归档不是删除**——它们是数据变更的证据链。
4. `scripts/railway/` 47 个文件是最大的一坨，但**本轮只出清单不重排**：
   它背后是活跃的数据构建流程（见记忆 `jp-rebuild-pipeline-s16`），
   而且 `rebuild:railway:jp` 第一步已知**不幂等**。动它属于另一个项目。

### Phase 5 · 移植规格三件套（文档，不是代码）—— **全原生策略的前置条件**

写进 `app/docs/port/`，每份都必须**指回源文件行号**，不许凭印象：

1. **`data-model.md`** —— 行程 JSON、compact rail 包、precompute 分片的字段级 schema。
   已有 `jsonspec.md` + `jsonspec-values.json`（11 MB 机器值目录）打底，
   本步做的是**提炼出 Swift `Codable` 能照抄的那一层**。
2. **`algorithms.md`** —— P 层 14,369 行里每个算法的**输入/输出/不变量**：
   路线求解（Dijkstra + 机构规则 + hint）、重叠车道与走廊平滑、
   Douglas-Peucker 抽稀、里程统计口径（**去重并集，不是累加**——这条已经踩过坑）、
   站名读音与角色分层。每条写清楚**边界条件与已知例外**（阿里山折返、常磐線折返、
   東京駅焊接共享点…这些例外全部有记忆条目，逐条引用）。
3. **`style-spec.md`** —— Phase 1 产出的图层清单 + 表达式平价表 + 四层 CSS 的结论
   （已有 `app/public/styles/README.md` 251 行实测结论，直接引用）。

### Phase 6 · 黄金夹具（golden fixtures）—— **全原生策略的前置条件**

**没有这一步，Swift 端就是「重写」，不是「移植」，永远无法证明算得对。**

对 P 层每个算法，冻结一组「输入 → 输出」JSON 夹具：

- 输入取自真实数据（五国成品包 + `data/train-store*.json`），覆盖已知的坑：
  折返、支线拆分、环线接缝、跨日、多线车站、并行走廊。
- 输出直接存 JS 现在算出来的值（**这就是定义**，不做「应该是多少」的二次判断）。
- JS 侧加测试读同一批夹具（测试数只增不减，从 294 起）。
- Swift 侧写同名测试读**同一批文件**。两端对同一夹具给出同一答案 = 移植正确。

这一步同时是**最好的 JS 侧防回归网**——它把 14k 行纯逻辑的行为钉死了，
后续再重构 P 层就有了硬证据，不用每次都跑 186 秒的 precompute。

### Phase 7 · Xcode 脚手架（策略已定：**全原生**，见 §六）

**这一阶段起才允许写 Swift。Phase 0–6 全部完成之前不要建工程。**

1. **工程骨架**：Xcode 工程 + 本地 SPM 包，按 §二 的分层建 target，
   一一对应，不要发明新的分层：

       RailCore        P 层的 Swift 翻译（无 UIKit/SwiftUI import，纯逻辑）
       RailData        数据契约（Codable）+ 五个 Port 的实现
       RailStyle       S 层图层清单的读取与装配（喂 MapLibre Native）
       RailMapKit      M 层：MapLibre Native 的 SwiftUI 封装
       RailApp         V 层：SwiftUI 界面，按 Phase 2 的领域动作清单接线
       RailCoreTests   读 Phase 6 的黄金夹具，与 JS 侧比对同一批答案

   `RailCore` **不许 import 上面任何一个**——这条边界就是 §二 P 层的定义，
   编译器替你守住它。

2. **P 层翻译顺序**（依赖从少到多，每一个都必须先有夹具再动手）：

       app-coords / app-dates / app-scheduling          原语，无依赖
       app-route-simplify（haversine + Douglas-Peucker）  已是全仓唯一副本
       app-operator-branding / app-stations / app-validation
       rail-network（包解码 → 几何派生 → 空间索引，Phase 1.3 已拆成三块）
       app-route-graph → app-route-solver               求解核心，最难
       app-overlap-lanes → app-deck-records             几何最重
       app-stats                                        口径是去重并集，不是累加

   **一个算法一个 PR，绿灯定义是「Swift 与 JS 对同一夹具给出同一答案」。**
   浮点不要求逐位相同，但必须先声明容差并说明理由；几何/里程类默认容差
   应当小到不影响渲染与统计口径（建议先按 1e-9 相对误差起步，超了就查，不要放宽了事）。

3. **数据打包**：`_site` 已证明零后端可跑（`hasBackend:false`）。
   51 MB 全进 bundle 可接受，但按国家拆成 on-demand resources 更合适
   （jp 包 17 M 是大头，tw/hk/mo/kr 都很小）。

4. **JS 侧不退休。** 全原生不等于删掉 web 端：web 端是**黄金夹具的生成器**，
   也是算法的参考实现。规则 3「不许改数值行为」在整个移植期间继续有效——
   JS 侧一改，夹具就失效，Swift 侧的绿灯就变成假的。

---

## 五、JS → Apple 技术映射

| 现在 | iOS 端 | 注意事项 |
| --- | --- | --- |
| MapLibre GL JS（vendored 1.4 MB） | **MapLibre Native iOS**（SPM: `MapLibre`） | 同一套 style spec；**表达式支持逐条核实**（Phase 1.2） |
| GeoJSON source + `setData` | `MLNShapeSource` | 语义接近，更新频率策略要重测 |
| `line-gradient` + `line-progress` 尾迹 | 同名属性 | 记忆里踩过两个坑，移植时重现 |
| IndexedDB | SQLite (GRDB) 或 Core Data | 行程库有**分片写入**逻辑，别照抄分片，原生直接整存 |
| `fetch` + Express 后端 | 优先 **bundle 内文件**；远端才 `URLSession` | `_site` 已证明**零后端可跑**（`hasBackend:false`），iOS 走离线优先 |
| SSE (`app-live-refresh.js`) | 单机版不需要 | 端口留空实现 |
| Web Worker | `Task` / `DispatchQueue` | fit-curve 计算量已实测（见记忆 `render-perf-hotpath`） |
| `canvas.captureStream()` + MediaRecorder | `AVAssetWriter`（+ `ReplayKit` 备选） | **风险项**：WebGL 画布读不回来才走的 captureStream，iOS 端是完全不同的路子，按新功能排期而不是移植 |
| CSS 四层（base/ios/solid/device） | SwiftUI + 设计 token | **20 个选择器在四个文件里都被写过**（实测），别试图 1:1 搬 |
| `localStorage` | `UserDefaults` | 直译 |
| `I18NStrings` 1,376 行目录 | `.xcstrings` String Catalog | 机械转换，可脚本化 |
| 数据体量 `_site` 51 MB | App bundle 或首启下载 | 51 MB 进 bundle 可接受；按国家拆分下载更好 |

---

## 六、分叉策略：**已定为「全原生」**（2026-08-21 拍板）

| | 做法 | 结论 |
| --- | --- | --- |
| **A** | **全原生**：P 层 14,369 行翻成 Swift，SwiftUI + MapLibre Native | ✅ **采用** |
| B | WKWebView 套壳：直接装 `_site` | ✗ 不是原生 app，手势/内存/后台受限 |
| C | 混合：JavaScriptCore 跑原样 JS，再逐个换成 Swift | ✗ 已评估，不走 |

选了 A，就要认下它的代价，并且**在 Phase 0–6 就把代价对冲掉**：

| A 的代价 | 对冲手段 | 在哪一阶段 |
| --- | --- | --- |
| 算法要重写一遍，可能算错 | **黄金夹具**：两端读同一批输入输出文件 | Phase 6，**不可跳过** |
| 两套实现会漂移 | JS 侧冻结数值行为（规则 3）+ 夹具跑在两边的 CI | Phase 6 + Phase 7.4 |
| 移植时不知道边界条件 | **`algorithms.md` 写清每条不变量与已知例外** | Phase 5.2 |
| 样式两端各写一遍 | 图层清单数据化，两端共读同一份 | Phase 1 |
| 中途没有可跑的 app | 按依赖顺序逐算法翻译，每个都独立绿灯 | Phase 7.2 |

**因此 Phase 5 和 Phase 6 从「加分项」升级为「前置条件」。**
选 C 的话夹具还只是保险；选 A 之后，**没有夹具就没有任何办法证明 Swift 版算得对**——
路线求解、走廊平滑、里程统计这三样，肉眼看不出错，只有对拍看得出。

---

## 七、硬性规则（继承前作，逐条仍然有效）

1. **先跑 `git status`。** 这个仓库同时跑着多个会话。带着别人未提交改动的文件不要动；
   提交要**逐文件 `git add <path>`，永远不要 `git add -A`**。
2. **删任何顶层绑定之前先查动态桥**（前作 §1.1）。`npm run report:frontend` 有专列。
3. **不许改任何几何/求解算法的数值行为。** 本轮全部改动必须行为等价。
4. **测试数只增不减。** 当前 **294**。
5. **一个阶段一个提交**，不许把「搬代码」和「改逻辑」放进同一个提交。
6. **结论必须带可复算的数字。** 没量过的写「未测量」。
7. **新增**：任何声称「这两份实现重复」的判断，必须先做**位型对拍**才能合并
   —— 前作在 `distanceMeters` 上已经栽过一次，那是两个算法家族不是重复。

---

## 八、每阶段验收

    cd app && npm test && npm run lint && npm run report:frontend

动到坐标 / 缓存键 / 几何时追加（唯一硬证据）：

    cd app && npm run precompute && find data/sample-data -type f | sort | xargs shasum -a 256 | shasum -a 256

哈希与改动前一致才算过。Phase 1 追加 style JSON 逐字节对拍；Phase 6 之后追加夹具测试。

---

## 九、可直接粘贴给新会话的 prompt

```text
你要在 Japan-Train-Map 仓库做一轮重构。目标有两个，它们是同一件事：
(1) 让代码更有条理、更好读，删掉冗余/无用的实现，把运作逻辑讲清楚，把函数之间的连接理顺；
(2) 让这份代码能被照着移植成一个 Swift / SwiftUI / Xcode 的 iPhone app。
验收标准是 (2)：一个不认识这份代码的人，能不能照着它把同一个 app 写成 Swift。

先读这三份文件，不要跳过：
  REFACTOR_FOR_SWIFT_FORK_PROMPT.md          <- 本轮的计划与实测基线，你的主文档
  REFACTOR_FRONTEND_ARCHITECTURE_PROMPT.md   <- 上一轮的成果与契约，全部仍然有效
  app/public/app.js 与 app/public/railmap.js 的头注释  <- 两张模块地图

开工前先复现基线，数字对不上就先停下来说明：
  cd app && npm test        预期 294 pass / 0 fail
  cd app && npm run lint    预期通过
  cd app && npm run report:frontend   预期 53 scripts / 2060 functions / 332 edges

然后按主文档 §四 的 Phase 0 → 7 顺序推进，一个 Phase 一个提交。
每个 Phase 动手前先说明：这一步让 JS 侧哪里更清楚、让 Swift 侧哪里更好抄。
只答得上一个的，不做。

七条硬性规则（主文档 §七，逐条遵守）：
  1. 先跑 git status；这个仓库有并行会话；提交逐文件 git add，永远不要 git add -A
  2. 删任何顶层绑定之前先查动态全局桥（report:frontend 有专列；lint 说没人用不算理由）
  3. 不许改任何几何/求解算法的数值行为，本轮必须行为等价
  4. 测试数只增不减，当前 294
  5. 一个阶段一个提交，不许把「搬代码」和「改逻辑」放进同一个提交
  6. 结论必须带可复算的数字，没量过的写「未测量」
  7. 任何「这两份实现重复」的判断，必须先做 IEEE-754 位型对拍才能合并

最先做、收益最大的两件事：
  - Phase 1：railmap-style.js:997 的 buildBaseStyle（929 行，全仓最长）拆成
    「图层清单数据」+「装配器」。这一步做完，同一份图层定义能同时喂给
    MapLibre GL JS 和 MapLibre Native iOS，而不是两端各写一遍。
  - Phase 6：给纯逻辑层（20 个文件 / 14,369 行 / 零 DOM 零 MapLibre 零存储）
    建黄金夹具。没有它，Swift 端就是重写而不是移植，永远无法证明算得对。

每个 Phase 结束跑：cd app && npm test && npm run lint && npm run report:frontend
动到坐标/缓存键/几何时另加 npm run precompute 并对 data/sample-data 取整树哈希，
必须与改动前一致。

分叉策略已拍板：**全原生**（Swift + SwiftUI + MapLibre Native，P 层 14,369 行全部翻成
Swift；不套 WKWebView，不用 JavaScriptCore）。这意味着主文档的 Phase 5（移植规格）与
Phase 6（黄金夹具）是**前置条件而不是加分项**：路线求解、走廊平滑、里程统计这三样
肉眼看不出错，没有夹具就没有任何办法证明 Swift 版算得对。

本轮（Phase 0–6）只做 JS 侧的准备工作。**不要写任何 Swift 代码，不要建 Xcode 工程**
—— 那是 Phase 7，前六个阶段全部完成并验收之后才开始。
```
