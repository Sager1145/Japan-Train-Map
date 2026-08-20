# 前端架构重构 —— 进度与后续计划

> **给下一位接手者的第一句话：这份文件被覆盖过一次。**
> 2026-08-21 01:33，一个并行会话在没有先读取的情况下用 `cat >` 覆写了本文件。
> 原内容（很可能是驱动 `048c9bd`..`6c7281d` 那批提交的计划书）未进 git，无法恢复。
> 现在这份是**按当时真实代码状态重写的续作**，不是原件。
> 教训已经很清楚：**动任何一个未跟踪文件之前先读它**，这个仓库同时跑着多个会话。

对象：`app/public` 的 classic-script family。
目标：更有条理、更好读、删掉冗余/无用的东西、把运作逻辑讲清楚、把函数之间的连接理顺。

---

## 一、地基：这五条不能动

| # | 契约 | 证据 | 动了会怎样 |
| --- | --- | --- | --- |
| 1 | 前端是**一族 classic script，共享一个全局词法作用域**；无 ESM、无打包器 | `app/public/app.js` 文件头 | `scripts/build/precompute-train-parts.mjs` 的 Node vm 沙箱靠**顶层绑定**取值，改 ESM 即失效 |
| 2 | `index.html` 的 `<script src>` 顺序是**加载顺序的唯一真相** | `app-family-sandbox.mjs: readOrderedAppScripts()` | precompute / `app-family-smoke.test.mjs` / `check-undefined-globals.mjs` 三个消费者同时错位 |
| 3 | `public/` **必须扁平**，app 家族文件名以 `app` 开头 | 同上的过滤器 `!src.includes("/") && src.startsWith("app")` | 挪进子目录 = 被静默过滤掉，**不报错**，只是少一个模块 |
| 4 | 四个样式表的**层叠顺序**本身就是行为 | `test/stylesheet-architecture.test.js` | 换顺序 = 视觉回归 |
| 5 | `public/*.js.gz` 是服务器按 mtime 自动生成的 sidecar | `server/file-delivery.js: ensureGzipSidecar()` | 手改无意义；比 `.js` 旧是**正常的**，不要报成缺陷 |

### 1.1 静态分析看不见的东西：动态全局桥

有三个顶层绑定是通过 `window.X` / `global.X` 字符串查找被跨模块调用的，
**任何 AST 引用计数和 `no-unused-vars` 都看不见**：

```
RailOperatorBranding   app-operator-branding.js  ← railmap-popup.js
activeRailPackageUrl   app-config.js             ← railmap.js（且 test/railmap-country-network.test.js 会 stub 它）
PERF_DEBUG             app-config.js             ← app-config.js 自己
```

`activeRailPackageUrl` 是活教材：它在每一种静态死代码检测里都是「零引用」，
删掉它国家切换直接断。**「lint 说没人用」不构成删除理由。**
`npm run report:frontend` 会把动态调用者单独列一列，用它，别用 lint。

---

## 二、已完成（2026-08-21）

### 第一批 · `048c9bd`..`6c7281d`（另一会话）

建立了状态与服务边界，并且**造好了尺子**：

- `app-state.js`（状态所有者 + `AppActions`）、`app-country-session.js`、
  `app-route-service.js`、`app-import-controller.js`、`app-precompute-adapter.js`、
  `runtime-config.js`
- `scripts/validation/report-frontend-architecture.mjs`（`npm run report:frontend`）——
  逐函数清单：直接调用者、**动态调用者**、读写的共享状态、副作用、可达性分级
- `app/docs/frontend-architecture-baseline.md` —— 运行时流程与状态归属基线

### 第二批 · `cb8e340`..`08218bd`（本次）

主题只有一个：**把「别人家的东西」从它碰巧被写在的地方，搬到它该在的地方。**

| 提交 | 做了什么 | 环 |
| --- | --- | --- |
| `cb8e340` | `els`（DOM 表，12 文件 146 处引用）→ `app-dom.js` | 29 → 27 |
| `fe6fd7a` | API client（`HAS_BACKEND`/`CLIENT_ID`/`fetchJson`…）→ `app-api.js` | 27 → 26 |
| `ad01de4` | 五个数据集 + 两个站点索引 → `app-datasets.js`，写入改具名 install | 26 → 24 |
| `d8055fa` | 坐标原语（`coordKey` 等四个）→ `app-coords.js` | 24 → 19 |
| `444a57d` | `_statsYield` → `app-scheduling.js` 的 `yieldToEventLoop`（改名） | 19 |
| `35702e0` | rail-sections 载入器 → `app-datasets.js`（补齐上一步的漏） | 19 → 18 |
| `45d5f7b` | `dateLabel` → `app-dates.js` | 18 → 17 |
| `fde4be3` | `getFeatureDisplayCoordinate`/`getFeaturePathCoordinates`/`clone` → `app-coords.js` | 17 → 16 |
| `08218bd` | SSE 实时刷新 → `app-live-refresh.js` | 16（不变，见下） |

**基线对照**

| 指标 | 起点 (`6c7281d`) | 现在 (`08218bd`) |
| --- | --- | --- |
| 有向依赖边 | 290 | 286 |
| **互相依赖（2-环）** | **29** | **16** |
| 被多个文件写的共享绑定 | 38 | 36 |
| `app.js` 行数 | **696** | **440** |
| 测试 | 275 pass / 0 fail | **275 pass / 0 fail** |
| lint | 通过 | 通过 |
| precompute | 201 solved | **201 solved，输出逐字节相同** |

坐标原语和 rail-sections 载入器那两步动到了**路由缓存键的字节格式**，
所以除测试外还做了更硬的验收：跑完整 `npm run precompute`（201 车 / 约 186 s），
对整棵 `data/sample-data` 取哈希，**前后完全一致**（`72ddc48b…`）。

---

## 三、剩下的环，按可处理性分三类

> **2026-08-21 更新**：A 类和 C 类都已做完，环 **16 → 8**，剩下的 8 个全是 B 类。
> 下面保留原始分类，因为 B 类那八个「为什么不该拆」的理由仍然有效。

**不要一视同仁地去「清零」。** 下面的分类本身就是结论。

### A 类 · 被别的工作流挡住（4 个）—— ✅ 已解锁并做完（`5517b49`）

`app-display-settings.js` / `app-map-init.js` 目前带着**2026-08-20 线路配色工作流的未提交改动**
（`git status` 可见）。git 只能整文件暂存，动它们就会把别人的半成品扫进提交。

```
app-display-features.js → app-display-settings.js   经由 DISPLAY
app-route-render.js     → app-display-settings.js   经由 DISPLAY
app-overlap-lanes.js    → app-display-settings.js   经由 DISPLAY, APPLIED_FIT_CURVE_SETTINGS
app-map-init.js         → app-deck-records.js       经由 handleDeckMarkerClick
```

**等配色工作流提交后再做。** 做法已经想好了：`app-display-settings.js` 里
第 20–86 行是**设置值**（`DISPLAY_DEFAULTS` / `DISPLAY` / `APPLIED_FIT_CURVE_SETTINGS` /
`applyPendingFitCurveSettings`），其余是**设置面板 UI**。把值拆成一个叶子文件，
三个环同时消失。值那一段自包含，不依赖面板。

### B 类 · 设计使然，**不该硬拆**（8 个）

```
app-render.js       ↔ app-route-render.js    renderTrainLayers ↔ applyMutationResult
app-render.js       ↔ app-editor.js          renderEditor      ↔ applyMutationResult
app.js              ↔ app-country-session.js setupCountrySelect
app-store-ops.js    ↔ app-validation.js      validateTrain
app-store-ops.js    ↔ app-import.js          runProgressiveAppend
app-persistence.js  ↔ app-route-service.js   RouteService ↔ warmRouteCacheFromIndexedDb
app-overlap-lanes.js↔ app-deck-records.js    buildDeckOverlapMap（反向 16 个符号）
app-render.js       ↔ app-store-ops.js       getTrain
```

前两个已经试算过：`MutationResults` + `applyMutationResult` 挪到一个独立分发文件，
**环只会平移**——分发器要调 `renderEditor`/`renderTrainLayers`，
而 editor/route-render 要调分发器。真要断，只能改成事件订阅（渲染器注册、分发器只发通知），
那是**设计变更，不是搬运**，代价与收益需要单独立项评估。
其余几个是「编排层调模块入口 + 模块回报结果」的正常形状。

### C 类 · 干净、机械、可以直接做（4 个）—— ✅ 已做完（`5517b49`）

```
app-live-refresh.js → app-import.js       经由 replaceTrainStoreFromStoreProgressive（反向 drainPendingLiveReload）
app-persistence.js  → app-route-graph.js  经由 buildTrainRouteSolveContext, ROUTE_NEG_CACHE_MARKER
app-store-ops.js    → app-persistence.js  经由 exitStoreRecoveryMode, storeRecoveryMode, saveTrainStore
app-route-render.js → app-overlap-lanes.js 经由 invalidateDeckRouteCaches, _deckCachePut
```

最容易的是第二个：`ROUTE_NEG_CACHE_MARKER` 是个常量，挪到叶子即可。
第一个需要一个「导入完成」回调，属于 B 类的小号版本，先想清楚再动。

---

## 四、下一步该做什么（按顺序）

> **2026-08-21 更新**：1、2、3、4、5、6 都已落地（见下）。这一节现在记的是
> **做完之后剩下什么**，以及**哪些原始判断是错的**——后者比前者重要，
> 因为下一个人如果照着原清单动手，会删掉活着的东西。

### 已完成

1. ✅ **A 类 `DISPLAY` 拆分** —— 配色工作流落地（`b32570e`）后解锁，新增叶子
   `app-display-values.js`（零出边），一次干掉 3 个环。环 **16 → 8**。
2. ✅ **`ROUTE_NEG_CACHE_MARKER`** 挪进 `app-persistence.js` §14。C 类四个环
   连同长函数一起在 `5517b49` 落地。
3. ✅ **死代码** —— `cb4196b`。见下「原清单错在哪」。
4. ✅ **重复实现 `distanceMeters`** —— `e124776`。见下。
5. ✅ **长函数**（只拆算法类，声明式清单只加分节注释）：
   `smoothCorridorCurveUncached` 673 → 225、`buildDeckRouteRecords` 661 → 335、
   `buildDeckOverlapMap` 391 → 60、`smoothCurveStationJoins` 273 → 92。
6. ✅ **CSS 四层** —— `app/public/styles/README.md`（244 行，实测非推演）。
   结论：层叠顺序是 base → ios → solid → device，**20 个**选择器在四个文件里都被写过
   （原文估「至少 15 个」），solid 的不透明底色输给 device 的无前缀规则，
   因为 solid 的 `!important` 只覆盖 `backdrop-filter` 和 `box-shadow`。**没有合并，按计划只出文档。**

### 原清单错在哪（步骤 3）

九个候选里**六个已经过时**。逐条实测（`git ls-files 'public/*.js'`，52 个文件；
`public/` 下那些带空格 2 的影子文件是 Finder 复制的未跟踪垃圾，已清理，从不计入）：

| 候选 | 实际 | 证据 |
|---|---|---|
| `TRAIN_PICK_FAN_LAYER` | **活着** | 根本不在 `railmap-interactions.js` 里。定义在 `railmap-style.js:631`，`railmap.js` 五处 + 一个测试在用 |
| `stationIconId` | **真死，已删** | 见下 |
| `stationCount` | **活着** | `rail-network.js` 11 处全是函数内 `const`，每一个都被读 |
| `app-route-render.js` `stops` | **不存在** | 只有一处注释和一处 `train.stops`，没有这个绑定 |
| `railmap.js` 解构的 `RAILWAY_STYLE` | **不存在** | 已经没了 |
| `dayIndexForStop` / `inferDateFromTrainId` | **活着**，且在 `shared/app-core.js` 不在 `app-config.js` | 死的是 `app-config.js` 的解构别名，早已消失 |
| 约 30 个空 `catch (e) {}` | **0 处** | `public/` 里非 vendor 的 catch 全是 `catch {`，只剩 vendored maplibre 两处 |
| `ZOOM_STABILITY_*` / `railmap-style.js` `tokens` | 不存在 | 全仓 0 处 / 只有注释里的散文 |

真正删掉的是 `railmap-style.js` 里**一簇四个绑定共 36 行**：
`STATION_ICON_BASE_PX` / `stationIconId` / `stationIconImage` / `stationIconSize`。
根因是 `38cf0a8`（drop screen-space lanes）删掉了车道站台符号图层——它们唯一的调用者——
helper 却活了下来，还在 `RailMapStyle` 上导出，描述一张没人栅格化的位图。
`STATION_ICON_BASE_PX` 只是**传递性**死亡：它被 `stationIconSize` 读，那个函数走了才浮出来。

**故意留下的一个**：`app-state.js:65` 的 `AppState`——51 行冻结 getter 门面，全仓零读者。
但它不是遗留物，是 `048c9bd` 开的**在途迁移**的声明读路径（文件自己的头注释第 6 行说明了这件事），
兄弟 `AppActions` 在 5 个文件里活着。删它等于**倒退**同一场重构的另一步，那是架构决定不是死代码清理。

计划书原话「全仓库真正的顶层死代码是**个位数**」是对的：全量扫过 51 个文件，
4 个真死，1 个未被引用但有意保留。

### 原清单错在哪（步骤 4）

原文说「`distanceMeters` 仍有 3 份（`rail-network.js` / `app-route-solver.js` / `app-fit-worker.js`），
`app-fit-worker.js` 是合法例外，另外两份没有理由」——**两处都错**。
`rail-network.js` 那份是**不同算法**，而缺掉的第三份 haversine 在测试 harness 里。

实际是**两个家族**：

| 算法 | 位置 | 常数 |
|---|---|---|
| haversine `2R·asin(√x)` | `app-route-solver.js` / `app-fit-worker.js` / `test/fit-curve-invariants.test.js` | R = 6371000 m |
| 等距圆柱（equirectangular） | `rail-network.js` / `test/station-render-anchoring.test.js` / `scripts/railway/lib/railway-topology.mjs` | 111320 m/deg |
| 等距圆柱、返回 **km**、名字不同 | `shared/app-core.js` 的 `equirectKm` | 111.32 lon / 110.574 lat |

**真重复只有 haversine 那三份。** 合并落点不是 `app-core.js`：

| 方案 | Worker 载荷 | 相对今天 | 剩余副本 |
|---|---|---|---|
| 现状 | 110,375 B / 33,985 B gz | — | 3 |
| `importScripts("app-core.js")` | 125,658 B / 39,450 B | +13.8% / +16.1% gz | 1 |
| `importScripts("app-route-solver.js")` | 159,473 B / 46,735 B | +44.5% / +37.5% gz | 1 |
| **搬进 `app-route-simplify.js`** ✅ | 110,375 B / 33,985 B | **+0.0%** | **1** |

`app-route-simplify.js` 是页面（`index.html` #21）、Worker（已在它的 `importScripts` 里）
和 vm harness（已把它读进上下文）**三者本来就都加载**的唯一叶子，所以零新增字节，
而且一次干掉**两份**副本而不是一份。依赖图 310 边 → 310 边，无新环。

对拍：从五国成品包里取 **423,754 组真实经纬度**，比 IEEE-754 原始位型。
合并前 4 份 × 423,754 = 1,695,016 次比较 0 处不同；合并后 847,508 次 0 处不同。
`test/distance-meters-parity.test.js` 从 3 个测试改成 5 个（282 → 284），
钉的东西从「三份副本保持一致」改成「只剩一份声明 + Worker 与 harness 确实在读它 +
八个返回值的位型 + `rail-network.js` 那份仍然故意不同」。反证过：把副本加回
`app-fit-worker.js`，第 1、2 项立刻红。

### 仍然剩下的

- **等距圆柱家族还有三份**（`rail-network.js` / `test/station-render-anchoring.test.js` /
  `scripts/railway/lib/railway-topology.mjs`）。测试那份可以用动态 `import()` 读 `railway-topology.mjs`
  —— `railway-topology-audit.test.js` 已经在用这个写法 —— 把 3 收成 2。没做：与步骤 4 的
  haversine 是两件事，一个提交只做一件事。
- **B 类 8 个环不动**（设计使然）。真要断只能改事件订阅，那是设计变更不是搬运，需单独立项。
- **`app/node_modules` 有 618 个文件被 git 跟踪**，尽管 `.gitignore:6` 写着
  `app/node_modules/`（该规则不会取消跟踪它生效之前就加进去的文件）。
  源头是 `045b5394`「Move project files into app/」，带进来的是 express 一系传递依赖，
  不是有意 vendor 的补丁包；CI 跑 `npm ci`，不依赖它们。
  代价是**任何一次依赖安装都会弄脏 `git status`**——在「逐文件 `git add`、多会话并行」
  这条规则下是实打实的隐患。清法：`git rm -r --cached app/node_modules`。
- **步骤 7（`scripts/` 层）按原计划不动代码**，只有清单。

## 五、硬性规则

1. **先跑 `git status`**。这个仓库同时跑着多个会话。带着别人未提交改动的文件**不要动**；
   要提交就**逐文件 `git add <path>`，永远不要 `git add -A`**。
2. **删任何顶层绑定之前先查动态桥**（§1.1）。
3. **不许改任何几何/求解算法的数值行为。** 本次重构必须是行为等价的。
4. **不许减少测试数量。** 当前 **284**，只能增不能减（08-21：275 → 282 转角半径 → 284 距离对拍）。
5. **一个阶段一个提交**，不许把「搬代码」和「改逻辑」放进同一个提交。
6. 结论必须带**可复算的数字**。没量过的写「未测量」。

## 六、每阶段验收

```bash
cd app && npm test && npm run lint && npm run report:frontend
```

动到坐标/缓存键/几何时追加（这是唯一硬证据）：

```bash
cd app && npm run precompute && find data/sample-data -type f | sort | xargs shasum -a 256 | shasum -a 256
```

哈希与改动前一致才算过。当前基线：`72ddc48b4d693d0ef30b14cdae7407753040103a1a131e47ea64cf8a877c9cab`
