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

## 三、剩下 16 个环，按可处理性分三类

**不要一视同仁地去「清零」。** 下面的分类本身就是结论。

### A 类 · 被别的工作流挡住（4 个）—— 现在不能碰

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

### C 类 · 干净、机械、可以直接做（4 个）

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

1. **等配色工作流落地**，然后做 A 类的 `DISPLAY` 拆分（一次干掉 3 个环）。
2. C 类里的 `ROUTE_NEG_CACHE_MARKER`。
3. **死代码**——注意：全仓库真正的顶层死代码是**个位数**，不是几十个。
   已知清单（多数在 A 类文件里，同样被挡住）：
   ```
   railmap-style.js        ZOOM_STABILITY_ZOOMS, ZOOM_STABILITY_TOLERANCE_PX, tokens   ← 被挡
   railmap.js              解构出的 RAILWAY_STYLE, stationIconId                        ← 被挡
   rail-network.js         stationCount                                                 ← 被挡
   app-config.js           dayIndexForStop, inferDateFromTrainId（AppCore 解构别名）    ← 被挡
   railmap-interactions.js TRAIN_PICK_FAN_LAYER                                         ← 可做
   app-route-render.js     stops                                                        ← 可做
   ```
   外加约 30 个空的 `catch (e) {}` 参数（写成 `catch {}`）。
   **删之前必须对照 `npm run report:frontend` 的动态调用者列。**
4. **重复实现**：`distanceMeters` 仍有 3 份
   （`rail-network.js` / `app-route-solver.js` / `app-fit-worker.js`）。
   `app-fit-worker.js` 是 **Web Worker，不共享全局作用域**，那一份是合法例外，
   要么保留并注明，要么改用 `importScripts('app-core.js')`；另外两份没有理由。
5. **长函数**（`npm run report:frontend` 有清单）。只拆**算法类**：
   `smoothCorridorCurveUncached`(673)、`buildDeckRouteRecords`(661)、
   `buildDeckOverlapMap`(391)、`smoothCurveStationJoins`(273) —— 按中间产物切。
   `bindEvents` / `_wireInteractions` / `buildBaseStyle` 是**声明式清单**，
   长是它的自然形态，**只加分节注释，不切碎**。
6. **CSS 四层**：`railprint-base`(2723) / `ios-presentation`(1120) /
   `device-layout`(731) / `solid-surfaces`(670)。`!important` 只有 8 处（很克制），
   代价是**至少 15 个选择器在四个文件里都被写过**
   （`.toolbar` `.train-item` `.rp-modal` `.map-layers-control` `.form-grid` …）。
   先出一份 `app/public/styles/README.md` 说明「哪一层说了算」，**不要急着合并**。
7. **`scripts/` 层不在范围内**。29 个 `.py` + 13 个 `.mjs`，建包器三代同堂
   （`build-package-from-inventory.py` / `build-japan-package-from-inventory.py` /
   `build-hong-kong-rail-package.py` 并存），`migrations/` 里 17 个一次性脚本。
   背后是 12 GB 的资料管线，改错的代价和前端不是一个量级。**只出清单，不动代码。**

---

## 五、硬性规则

1. **先跑 `git status`**。这个仓库同时跑着多个会话。带着别人未提交改动的文件**不要动**；
   要提交就**逐文件 `git add <path>`，永远不要 `git add -A`**。
2. **删任何顶层绑定之前先查动态桥**（§1.1）。
3. **不许改任何几何/求解算法的数值行为。** 本次重构必须是行为等价的。
4. **不许减少测试数量。** 275 只能增不能减。
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
