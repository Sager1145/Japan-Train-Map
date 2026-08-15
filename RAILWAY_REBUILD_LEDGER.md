# 铁路线路数据分阶段重建台账 / Railway line-data staged rebuild ledger

> 配套规范：[`RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md`](./RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md)
>
> 本文件是跨 session 的唯一进度与验收台账。每个重建 session 开始前必须先读本文件，
> 结束前必须回写「重建进度」与「验收清单」两节。

---

## 0. 当前阶段

```text
Stage:            S16–S65 全部跑过 —— hk 27 / tw 39 / **jp 672 条显示线路已建**
                  jp 批次行 **592/596 建成**（658 unverified / 4 blocked / 0 pending）
                  站锚点 jp 10246 个 —— 10228 PASS / 18 WARNING / **0 ERROR**
                  structure 18268 行 · lanes 195 段
                  node --test 248 pass / 11 fail（清空后基线 188/55，目标 243/0）
                  余 4 条是明确「不画」的决定；3 项 topology ERROR 见 §6.12 待决
                  全境 Apple 复核未开始：阻塞在 Screen Recording 权限，见 §6.5
Stage (S01):      S01 完成 —— 分批合并工具链就绪，等待 S02 起逐批重建
Stage 1 executed: 2026-08-13 (Asia/Taipei)  线路数据清空
S01 executed:     2026-08-13 (Asia/Taipei)  promote / recompute / verify-batch
Branch:           main（按用户要求直接在 main 上操作，未新建分支）
Scope of reset:   jp, tw, hk
Untouched:        kr, mo
Code deleted:     无。前端渲染层、图层开关、popup、求解器全部保留
```

**Stage 1 的定义**：只清空线路数据（compact-v1 包的 `lines[]` / `lanes[]`），
保留包外壳与全部代码，使后续 session 可以一次只重建一部分线路并 append 回去。

---

## 1.0 五国验证实测（2026-08-14，S17 后）

规范 §24.4 要求「五国构建和验证均实际执行」。本次**逐国实跑**，不是抽样：

| 国家 | 包版本 | 显示线路 | 拓扑 | 站锚点 | strict 退出码 |
| --- | --- | ---: | --- | --- | --- |
| jp | 2025.4.2 | 17 | 16 PASS / **1 WARNING** / 0 ERROR | 260 — **260 PASS** / 0 W / 0 E | 0 / 0 |
| tw | 2025.6.0 | 39 | 38 PASS / **1 WARNING** / 0 ERROR | 586 — **586 PASS** / 0 W / 0 E | 0 / 0 |
| hk | 2025.2.0 | 27 | **27 PASS** / 0 W / 0 ERROR | 450 — **450 PASS** / 0 W / 0 E | 0 / 0 |
| kr | 2025.1.0 | 82 | **82 PASS** / 0 W / 0 ERROR | 1412 — **1412 PASS** / 0 W / 0 E | 0 / 0 |
| mo | 2025.2.0 | 3 | **3 PASS** / 0 W / 0 ERROR | 17 — **17 PASS** / 0 W / 0 E | 0 / 0 |

```text
合计 168 条显示线路 · 2725 个站锚点 —— 站锚点 2725 PASS / 0 WARNING / 0 ERROR
validate-station-render-anchoring.mjs --all  ->  1372+ 行全 PASS
npm run lint     PASS（121 JS / 76 JSON / 44 HTML 引用）
node --test      233 pass / 26 fail（26 项全部等待 jp 余下 580 条线路）
```

**两处 WARNING 都是已记录的已知项，不是新发现**：
jp = 東海道新幹線 1.90 km 无车站支线（§6.5）；tw = 阿里山線 之字折返（§6.3）。

**kr 82 条与 mo 3 条本轮未重建但确实跑过**，两者 0 WARNING / 0 ERROR ——
这正是 §24.4 要求「一并跑通」的那两国，此前只在计划里写着、没有实测记录。

---

## 1. Validation Scope（规范 §2 要求的时点记录）

```text
country / region:            jp, tw, hk（本次清空）；kr, mo（保持不动）
package version:             jp 2025.4.2 / tw 2025.6.0 / hk 2025.2.0（未改版本号）
N02 version:                 N02-25_GML（jp，见 data/raw/railway/jp/）
official-data version:       tw = TDX + NLSC + MOA（见 tw-2025.sources.md）
                             hk = 官方 service/station + 已记录几何来源
train service date:          未变更（train-store 未触碰）
Apple Maps capture date:     本阶段未采集
included transport modes:    未变更
display purpose:             基础设施网络显示（infrastructure_network）+ 已乘路线
application commit:          68abf09 + 未提交工作区改动
```

---

## 2. 清空前基线（Before）

### 2.1 数据包

| 包 | version | lines | stations | segments | lanes | bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| jp-2025.json | 2025.4.2 | 607 | 10161 | 9556 | 196 | 9,606,802 |
| tw-2025.json | 2025.6.0 | 39 | 586 | 548 | 0 | 476,688 |
| hk-2025.json | 2025.2.0 | 27 | 450 | 425 | 5 | 163,649 |
| kr-2025.json | 2025.1.0 | 82 | 1412 | 1330 | 31 | 861,811 |
| mo-2025.json | 2025.2.0 | 3 | 17 | 14 | 0 | 7,959 |

### 2.2 测试与验证

```text
node --test（33 个测试文件，逐文件执行）:  pass 243  fail 0
npm run lint:                              PASS（114 JS / 76 JSON / 44 HTML 引用；38 个前端脚本全局检查）
validate-railway-topology.mjs:             exit 0，五国 PASS
```

**这是重建的验收目标：重建完成时必须回到 243 pass / 0 fail。**

---

## 3. 本阶段实际改动

### 3.1 备份（未提交改动不会丢失）

清空前对三个包做了逐字节 gzip 快照，落在既有的 `data/raw/railway/<cc>/packages/` 归档目录：

```text
app/data/raw/railway/jp/packages/jp-2025-pre-rebuild-25031fbc.json.gz   2,795,730 B
app/data/raw/railway/tw/packages/tw-2025-pre-rebuild-7123a58a.json.gz     151,709 B
app/data/raw/railway/hk/packages/hk-2025-pre-rebuild-ad80bc90.json.gz      45,867 B
```

文件名中的 8 位十六进制是清空前源 JSON 的 sha256 前缀，可用于校验回滚。

### 3.2 清空动作

对 `app/public/rail/{jp,tw,hk}-2025.json`：

- `lines` → `[]`
- `lanes` → `[]`（tw 本来就没有该字段，保持没有）
- `stats` 全部数值字段 → `0`（仅 jp 有）
- **保留不动**：`format`、`version`、`generatedAt`、`crs`、`country`、
  `geometrySource`、`attributeSources`

版本号刻意不动，避免与 `japan-rail-continuity.test.js:31`、
`railway-display-curve.test.mjs:14`、`taiwan-rail-package.test.js:121` 的
version 断言产生第二处冲突源；重建完成时再按规范 §14 的流程同步改版本。

清空后体积：jp 1,034 B / tw 8,323 B / hk 2,092 B。`.json.gz` sidecar 已同步重生成
（并对齐 mtime，避免 `server/file-delivery.js` 认为 sidecar 过期而重复压缩）。

### 3.3 未做的事（重要）

- **没有删除任何代码。** `rail-network.js`、`railmap-style.js` 的 network 图层与源、
  station dots / labels / stationLanes、hover popup、图层开关全部原样保留。
- **没有删除 kr / mo 数据。**
- **没有删除或放宽任何测试断言**（规范 §24.5「无伪修复」）。
- **没有新建分支、没有提交。** 工作区改动仍未提交。

---

## 4. 清空后的状态（After）

```text
node --test:  pass 188  fail 55   （14 个测试文件转红；S01 后为 pass 198 / fail 55）
npm run lint: PASS（不变）
validate-railway-topology.mjs: exit 0；jp/tw/hk = Lines checked 0，kr = 82，mo = 3
rail-network.buildNetworkFromCompactPackage(空包): 不抛异常，
  segments/stations/stationLanes/stationLabels 全为 0 —— 前端对空包容错成立
app-family-smoke（前端沙箱冒烟）: 17 pass —— 页面脚本在空网络下仍可启动
```

---

## 5. 重建验收清单（55 项转红测试）

规则：每重建一批线路，勾掉这里能恢复的项；**不得靠改断言或加 skip 来变绿**。
未恢复的项必须在本文件写明原因与状态（`UNVERIFIED` / `DATA_CONFLICT` / 待后续批次）。

### 5.1 jp 相关

- [ ] `japan-rail-continuity.test.js` (5)
  - [ ] every Japanese package line is seam-free before it reaches the renderer
  - [x] Tokyo and Osaka metro lines use verified official line colours
  - [x] Japanese tunnel and bridge measures remain valid after branch splitting
  - [x] Japan renders one complete feature per line, never one per station interval
  - [x] official Japanese branch endpoints omitted by the old package are restored
- [ ] `railmap-popup-japan.test.js` (3)
  - [ ] only audited Japanese line badges stay ahead of operator fallbacks
  - [x] rejected or missing package art may use a verified official line symbol
  - [ ] every non-line image falls back to the exact operator, never a parent or predecessor
- [x] `railway-display-curve.test.mjs` (1)
  - [x] station points and line intervals stay one-for-one after display grooming

### 5.2 tw 相关

- [x] `taiwan-rail-package.test.js` (4)
  - [x] Taiwan 2025 package matches compact-v1 and its characterized network
  - [x] Taipei Main Station is grouped across high speed, TRA, and metro
  - [x] Sanying Line uses the official 12-stop order and both official interchanges
  - [x] Taoyuan Airport MRT sample uses the official TYMC route and stations
- [x] `taiwan-solver-datasets.test.js` (1)
  - [x] Taiwan section geometry matches the drawn rail package

### 5.3 hk 相关

- [x] `hong-kong-rail-package.test.js` (3)
  - [x] Hong Kong package contains the complete MTR and Light Rail display network
  - [x] Hong Kong sample routes coincide exactly with the drawn network segments
  - [x] the Hong Kong tramway is one physical network, not six overlapping services
- [x] `railmap-popup-hong-kong.test.js` (2)
  - [x] the tramway carries its own company label and no fabricated emblem
  - [x] Hong Kong station popup renders a logo and MTR label for every served line

### 5.4 跨国 / 显示契约

- [ ] `railway-parallel-corridors.test.js` (17)
  - [x] independent lines over one corridor are drawn as separate lanes
  - [ ] different operators over one corridor are drawn as separate lanes
  - [x] one operator's two separate lines are drawn as separate lanes
  - [ ] a trunk and its own branch still overlap exactly
  - [x] two railways keep the same side of each other everywhere they meet
  - [x] lanes cut the drawn geometry only, never the topology
  - [x] station_features_are_not_screen_merged
  - [x] a line eases into its lane instead of stepping sideways
  - [x] a laned platform moves into the lane of the railway that calls there
  - [x] a laned platform's marker points along the railway it belongs to
  - [x] a branched line is never pulled into parallel lanes
  - [x] a ride over a parallel corridor is drawn on the railway it rode
  - [ ] one train keeps one side of a corridor for the whole way along it
  - [x] a ride carries no lane data at all off a parallel corridor
  - [x] one railway published as many services is drawn once, not many times
  - [x] independent railways sharing a corridor still render parallel
  - [x] a platform is an interchange when two RAILWAYS meet, not two services
- [ ] `station-render-anchoring.test.js` (6)
  - [x] test_interchange_dot_line_passes_through_center
  - [x] test_terminal_parallel_lane_ends_at_station_center
  - [ ] test_station_approach_does_not_use_hard_stub
  - [ ] test_station_anchor_is_protected_from_smoothing
  - [x] test_parallel_single_stop_lane_passes_through_station_dot
  - [x] test_ridden_route_uses_station_anchored_render_geometry
- [ ] `railway-topology-audit.test.js` (4)
  - [x] a stroke never opens by folding back over itself
  - [ ] the official network is drawn, and what is not is accounted for
  - [x] independent railways sharing a corridor stay separate lines
  - [x] the corridor report says how many railways each corridor holds
- [x] `apple-maps-railway-contract.test.js` (4)
  - [x] station_minz_is_independent_lod
  - [x] five_country_build_and_validation_scope
  - [x] station_label_dedupes_by_group_without_merging_markers
  - [x] underground_structure_is_preserved_without_guessing_other_countries
- [x] `ridden-route-network-geometry.test.js` (3)
  - [x] every jp ridden sample uses complete-network geometry
  - [x] every tw ridden sample uses complete-network geometry
  - [x] every hk ridden sample uses complete-network geometry
- [ ] `rail-network.test.js` (1)
  - [ ] compact rail package produces the characterized render model
- [ ] `rail-loader-parity.test.mjs` (1)
  - [ ] 整个文件在加载期即失败（空包导致 loader parity 断言无对象可比）

---

## 6. 重建进度

| Session | 代号 | 国家 | 线路范围 | 状态 | 日期 | 备注 |
| ---: | --- | --- | --- | --- | --- | --- |
| 01 | TOOLING | — | 分批合并工具链 | **done** | 2026-08-13 | 5 个文件，10 项新测试全绿；见 §6.1 |
| 02 | HK-A | hk | 港铁市区重铁 7 条 | **数据 done / Apple 待办** | 2026-08-13 | 门 1–4 全过，门 5 阻塞；见 §6.2 |
| 03 | HK-B | hk | 港铁长线与机场走廊 5 条 | **数据 done** | 2026-08-13 | 门 1–4 过 |
| 04 | HK-C | hk | 轻铁 610/615/615P | **数据 done** | 2026-08-13 | 门 1–4 过 |
| 05 | HK-D | hk | 轻铁 614/614P/751/761P | **数据 done** | 2026-08-14 | 751 由 extraSegments 解决，见 §6.4 |
| 06 | HK-E | hk | 轻铁 505/507/705/706 | **数据 done** | 2026-08-14 | 505 由 extraSegments 解决，见 §6.4 |
| 07 | HK-F | hk | 香港电车 4 条 | **数据 done** | 2026-08-13 | 门 1–4 过 |
| 08–15 | TW-A…H | tw | 台湾 39 条 **全部** | **数据 done** | 2026-08-13 | 门 1–4 过；1 项 WARNING 是阿里山之字折返 |
| 16 | J01 | jp | 新干线 9 条 + N02 管线 + jp 检查队列 | **数据 done / Apple 待办** | 2026-08-14 | 门 1–4 过，门 5 因 macOS 权限阻塞；见 §6.5 |
| 17 | J02 | jp | JR 北海道在来线 12 条 | **8/12 done** | 2026-08-15 | 修 partition 判据后 室蘭線 补建；见 §6.6 |
| 18–22 | J03-1…5 | jp | JR 东日本在来线 66 条 | **56/66 done** | 2026-08-15 | 包内 78 条显示线路，本批拓扑 0 ERROR；见 §6.8 |

### 6.6 S17 交付与发现（2026-08-14）

**7 条建成（8 条显示线路），5 条未建并逐条写明原因。** 包内累计 17 条显示线路，
拓扑 **16 PASS / 1 WARNING / 0 ERROR**、站锚点 **260/260 PASS**。
测试仍 233 pass / 26 fail（剩余项要等日本网络成形，不随单批变动）。

**修掉两个构建器缺陷**

1. **链游走会绕环打转。** 原走法只避免「回到上一站」，而两端点之间仍可能夹一个环
   （宗谷線 就是），于是它绕着环走：35 站的线报 **walked 50 of 35**。
   更糟的是另一种环形下它根本不会停。改为带 visited 集合，步数上界为 n。
   修完 **宗谷線 直接建成，258.89 km（官方 259.4 km）**——它从来不是拓扑问题，是我的 bug。
2. **区间长度对账的容差没有物理依据。** 原为 max(60 m, 3%)，导致 富良野線 16 段报 10 段、
   札沼線 13 段报 12 段。差值是**系统性**的：审计量的是收缩图节点到节点，本管线量的是
   站台中点到站台中点，差的正是两端各半个站台。容差改为
   `max(60 m, 3%) + (两端站台长之和)/2`，**依据是站台长度本身，不是调参**。
   改后 S17 与 S16 的对账噪音**全部归零**，而检查仍能抓「路走错了」。

**分支拆分：判据来自审计，不是我来选主线**

`branch_parts_json` + `main_path` 已经按运营者的官方营业区间给出了答案，本次只是**读它**：

| 线路 | 主路径 | 拆出的部分 | 结果 |
| --- | --- | --- | ---: |
| 函館線 | 函館→大沼→**駒ヶ岳**→森→旭川 | `rejoin_variant` 砂原経由 8 站 | **-2 建成 35.23 km**（官方 35.3） |
| 根室線 | 根室→新得 300.6 km | `disconnected_component` 滝川–富良野側 8 站 | 主线 306.62 + **-2 建成 54.52** |

**这正是规范 §11「北斗砂原支線」要的东西**：主线走駒ヶ岳側、砂原側单独成再次并入的支线，
依据是 JR 北海道自己的营业区间记录（分类表 notes 明写「运行信息明确标为渡島砂原経由」），
**没有一行 `if line == Hokuto`**。根室線 两个分量是 2024-03-31 富良野–新得 废止的真实事实，
不是资料缺口——按 §7.8 的要求给出的是结论而不是静默补线。

拆出的部分走 `-2` / `-3` 兄弟显示线路，与 `lib/rebuild-batches.mjs` 早就写明的
「一条 canonical 线路可解析出多条显示线路」契约一致；兄弟线共用母线的名称、运营者与颜色。
**站数少于 2 的部分不画**（石北線 0.2 km 短桩、海峡線 单站分量）：compact-v1 按站对定位几何，
它们是真轨道但没有可指名的端点，按未覆盖走廊记录。

**5 条未建，逐条是什么**

| 线路 | 图论事实 | 性质 |
| --- | --- | --- |
| 函館線 主线 | 主链走通，但 **札幌 → 苗穂 在本线自己的轨道图上无路径** | 待查：疑似 5dp 节点未接或去重丢边 |
| 千歳線 | 去掉机场支线后仍 1 终端 / 3 交叉 / 15 站 | 环未解释（分类表记「仍合并 1 条平行候选边」） |
| 室蘭線 | 去掉 室蘭 支线后 43/44 站、**1 个环** | 同上（记「仍合并 4 条平行候选边」） |
| 石北線 | 去掉 4 个部分后 15/16 站、**2 个环** | 同上（记「仍合并 1 条平行候选边」） |
| 海峡線 | **一条邻接边都没有** | 真实事实：青函隧道段无客运车站（吉岡海底/竜飛海底 2014 廃止） |

四条「环」全部落在分类表标了 `站区收缩后仍合并 N 条平行候选边` 的线路上——
**这不是巧合，是同一个根因**：站区收缩把平行股道并成了两站之间的第二条边。
下一 session 应当先判定这些平行候选边该合并还是该保留，而不是逐线绕开。
海峡線 需要的是一个显式决定（不画 / 作为无客运的物理轨道层），不是构建器改动。

**CSV 按行回写**：`mark-batch-status.mjs` 新增 `--lines`，S17 的 7 行置 `unverified`、
5 行保持 `pending`。一个 session 落地 7/12 时，把 12 行写成同一个状态就把表唯一承载的事实抹掉了。

### 6.12 按审计里程选股道 · jp 592/596 全部可建（2026-08-15）

**余下 3 条不是「缺证据」，证据一直在审计里程里。**

東十条 与 赤羽 **两站都能 0.0 m 投影到轨道上，但落在不同的平行股道上**，
于是两点之间的最短路是 5.926 km，而运营里程是 1.369 km。实测：把两站都锚到
**它们共有的那条 section**，路径长度是 **1.370 km** —— 审计里程本身就指明了
服务走的是哪条股道。

所以增加一遍 **Viterbi 锚点重选**：每站的候选是 400 m 内的各条 section，
相邻两站之间的代价是「切出来的长度」与「审计里程」之差，整条站序一次求解。
这不是构建器替资料选股道，而是**用运营者自己的里程把股道认出来**，
结果仍要过与其他所有区间相同的容差检查。

两条正则项，都是被实测逼出来的：

| 正则项 | 为什么 | 症状 |
| --- | --- | --- |
| 偏离站台每米记 0.5 m 代价 | 站台位置本身也是证据，里程分不出胜负时应留在最近的轨道上 | 王子 被挪到 19.5 m 外的平行股道，画出来的线离站点圆点 20 m |
| 投影落在 section 端点记 150 m 代价 | 站台在轨道**尽头之外**说明它不在这条轨道上 | 初台 距笔画 21 m，验证器报 `platform beyond the last surveyed vertex` |

**结果**

```text
jp 596 条 canonical -> 592 条已建（672 条显示线路）
站锚点 10246 —— 10228 PASS / 18 WARNING / **0 ERROR**
structure 18268 行 · lanes 195 段 · node --test 248 pass / 11 fail
余 4 条即 §6.11 已记录的「明确不画」，无一条是建不出来
```

官方营业里程对照：**東北線 干线 535.22 km（官方 東京–盛岡 535.3）**、
鹿児島線 230.69 + 48.71（官方 232.3 + 49.3）。

**新浮现的一个真问题（3 项 topology ERROR，未修，需要决定）**

`service_misclassified_as_independent_parallel`：成田線 / 東北線 / 東海道線 的
兄弟部分被画成**相隔 2 条车道**，最长的一段并行 9.70 km。

根因不是车道算法错了，而是**数据与规则在这里正面冲突**：

- 数据：N02 把**多条实体平行股道**记在同一个线路键下 ——
  `jp-…-東北線` 是 東京–神田–上野–日暮里 一侧，`-3` 是 田端–上中里–王子–日暮里–鶯谷–上野
  一侧，也就是 宇都宮 与 京浜東北/山手 两条**不同的实体轨道**；
- 规则：§7.4「车道数 = 独立**铁路**数」，同名同运营者即同一条铁路，只能占一条车道。

两条股道叠画会丢掉真实存在的轨道；分开画则违反车道契约。
**这正是 §7.2 那个决定，只是现在它的边界清楚了**：不再是「哪条股道属于哪个服务」，
而是「同一铁路的多条实体股道该不该各占一条车道」。
在决定之前，这三条线**保持绘制**（它们是 500+ km 真实铁路，不画的代价更大），
3 项 ERROR 如实留在台账里。

### 6.11 图分解四条判据 · jp 589/596（2026-08-15）

```text
jp 596 条 canonical -> 589 条已建（652 条显示线路）
站锚点 9936 —— 9920 PASS / 16 WARNING / 0 ERROR
structure 17734 行 · lanes 162 段
node --test 247 pass / 12 fail（清空后基线 188/55）
CSV：655 unverified / 4 blocked / 3 pending
```

**四条判据，全部由「官方营业里程对得上」验证，不是靠推测**

1. **跳站服务边不是第二条轨道。** 鶴見線 記 安善–大川 1.285 km，而
   安善–武蔵白石–大川 是 1.415 km —— 大川支線 自 1996 年 武蔵白石 站台拆除后
   就是这么跑的。**审计自己的里程能分辨两者**：真正的绕行短路（chord）一定更短，
   那才是它存在的理由；跳站边则与「经过该站」的路径等长。跳站边从排序图里移除并记录，
   它指的那段轨道本来就已经画了。

2. **等长还不够，必须用几何证实。** 函館線 森–駒ヶ岳 与 森–東森–駒ヶ岳 长度接近，
   但 東森 在砂原線上、直连边走的是駒ヶ岳線 —— **两条真实走向**。
   只按里程判会把其中一条删掉，18 km 轨道就不画了。
   现在候选边会被**真的切一次**，问它是否从被跳过的那站旁经过：
   同一条轨道会走到站台可及范围内，不同走向则把那站甩在后面。
   函館線 因此保住砂原線与藤城線，同时仍正确删掉三条真跳站边。

3. **无环的分支线路 = 主干 + 支线。** 树上任意两站之间只有一条路径，没有可选的东西：
   主干取最长贯通路径，其余各臂各成一笔，每条支线保留它离开的那个分岔站
   —— 那正是两笔笔画在图上相接的地方，每条边都恰好画一次。
   验证：**山陰線 673.19 km（官方 673.8）**、仙崎支線 1.99（官方 2.2）、
   鶴見線 拆出 海芝浦 与 大川 两支。

4. **删掉跳站边后仍存在的环 = 真的两条走向**（审计的 `branch_rejoins`）：
   長崎線 長与経由/市布経由、函館線 駒ヶ岳/砂原。两条都是真轨道、两条都画，
   绕远的那条成为再次并入的支线，而不是被丢弃。

**另外两条**：站序落在互不相连的轨道组上时按组切开
（阪急今津線 1984 年起在 西宮北口 物理分离、南海高野線 的 汐見橋線 段，
汐見橋線 切出 4.75 km / 官方 4.6）；主线建不出来时兄弟支线不单独发布。

**四条明确「不画」的决定（CSV 记 `blocked`）**

| 线路 | 事实 | 决定 |
| --- | --- | --- |
| 北海道 海峡線 | 2 站 **0 条邻接边**（吉岡海底/竜飛海底 2014 廃止） | 无客运区间可画 |
| 三岐鉄道 近鉄連絡線 | 1 站 0 边 | 同上 |
| 富山地鉄 富山駅南北接続線 | 1 站 0 边 | 同上 |
| 広島電鉄 循環線 | N02-25 基准日之前尚未开业，无线路键 | 需非 N02 几何 |

compact-v1 按**站对**定位几何，一条没有可指名端点的线路画不出来；
这不是缺陷，是这个 schema 与这条线路的事实之间的关系，记录下来即可。

**余 3 条 pending，全部是同一个决定**：東北線 東十条→赤羽（切 5.926 / 审计 1.369）、
東日本 東海道線 横浜→保土ヶ谷（9.104 / 2.567）、鹿児島線 水巻→折尾（9.426 / 1.685）。
N02 把多条实体股道记在同一个线路键下，**最短路不等于客运走的那条**。
可行的解法是「按审计里程选路径而不是选最短」，但那需要 k-最短路径并把几何一起重建；
**在没有「哪条股道属于哪个服务」的来源之前，构建器不应替它决定**（规范 §7.2）。
计划书把这件事分给 J03/J04 组，这就是它该被解决的地方。

### 6.10 结构（隧道/桥梁）补回 + tw 并发写入澄清（2026-08-15）

**`structure` 此前一直是 0 —— 这是我引入的缺口，不是资料没有。**
旧包有 16173 行隧道/桥梁区间，`data/raw/railway/jp/osm/osm-structure.json.gz`
（21933 个区段的 OSM 匹配结果）一直躺在那里没被读。

补法：`path_between` 现在**同时返回它走过的区段串** `(section, from_m, to_m)`，
带方向符号（`from_m > to_m` 表示逆着区段自身数字化方向走）。结构是按**区段自己的里程**
测的，所以只有切割过程知道「区段 412 的 300–900 m 那条隧道」落在整条线的哪一段里；
逆行的区段必须把结构一起镜像，否则隧道会画到线的另一头。

```text
jp 包现在 15826 行 structure（目标断言要 >16000）
```

**断言仍然红，且不该改。** 每一条 structure 行的边界与类型断言全过，
差的 ~350 行属于**尚未建成的 33 条线路**（東北線 一条就占很多隧道）。
把阈值调低就是规范 §24.5 的伪修复。

**顺带转绿**：`Tokyo and Osaka metro lines use verified official line colours`
（计划书原本排在 S34）、`Japan renders one complete feature per line`、
`rejected or missing package art may use a verified official line symbol` 等。

**tw 的三项失败与本 session 无关**：并发的另一个 Claude session（PID 80739）
在 01:00 把 tw 包重建为 **2025.6.1**，为阿里山之字折返尾巴引入了 OSM 几何
（relation 5570989、ODbL、取得日 2026-08-14，理由：官方中心线不含这段可通行轨道）。
`taiwan-rail-package.test.js` 本来就允许**已声明**的 OSM 例外（断言前会删掉
`geometrySource.osmGeometry` 再查），那三项失败是它写到一半时的中间态；
对方写完后 **tw 4/4 全绿**。**没有动 tw 任何文件**——并发 session 的工作不该被另一个 session 编辑。

### 6.9 S23–S65 全批次跑通 · jp 数据侧收口（2026-08-15）

```text
jp 596 条 canonical  ->  563 条已建（578 条显示线路，含 -N 兄弟）
站锚点 8799 —— 8788 PASS / 11 WARNING / 0 ERROR
拓扑 569 PASS / 7 WARNING / 2 ERROR（2 项均为 missing_line，即余下 33 条未建）
lint PASS · node --test 238 pass / 21 fail（清空后基线是 188/55）
五国：tw 38/1/0 · hk 27/0/0 · kr 82/0/0 · mo 3/0/0，站锚点四国全 PASS
```

**新增的两条图分解规则（本轮让 +64 条线路可建）**

1. **邻接图先按连通分量拆**。一条线路不一定是一个连通的东西：常磐線、鹿児島線 各两段，
   信越線 三段——新干线开通后中间那段被移交，审计记作 `disconnected`。
   每个分量各是一笔连续笔画，因此各自成一条显示线路，**中间不搭桥**。
2. **环 + 尾巴分解**。`loop_with_tail`（大江戸線 光が丘 尾巴接环、ユーカリが丘線、
   ポートアイランド線、京王線）无法用一串**互不重复**的车站表示，因为服务会两次经过接点。
   剥叶子求出 2-core 作环、挂在环上的树各成一条尾巴，两者共享接点站——
   这正是两笔笔画在地图上相接的地方。

**一条本轮抓到的伪环：三站互邻不是环，是跳站边**

広見線 的 明智 / 日本ライン今渡 / 新可児 三站互相邻接，被当成「环」画出来，
结果 **新可児 距本线每一笔笔画 172 m**，拓扑验证器报 `station_not_on_line`。
真实铁路里三站互邻只能是**其中一条边跳过了中间那站**——正是 2026-08-13 审计
删掉的 12 条「跳站直连边」的同类，只是这条没被删到。
判据：**环至少 4 站**。删那条边等于由构建器认定三者中哪个是错的，不做。
加了这条判据后 57 条错误的 `-N` 分解被 `--prune` 清出包外。

**一处 ID 回归（已修，教训值得记）**

`line_id_for()` 把运营者别名也套进了 **ID**：`jp-東京メトロ-3号線銀座線`。
存档包证明方向反了——`jp-東京地下鉄-3号線銀座線` + `"operator": "東京メトロ"`：
**ID 用 N02 法人名，品牌只进 `operator` 显示字段**。ID 是持久化身份，
已乘路线、检查队列、批次表都指向它，改 ID 等于把这些引用全部悬空。
症状是 `rail-loader-parity` 整个文件加载期崩溃、测试总数从 259 掉到 249。

**余 33 条未建，按需要的证据分类**

| 类型 | 条数 | 需要什么 |
| --- | ---: | --- |
| 多余边（成环）无记录含义 | 18 | 判定这些平行/跳站候选边该合并、保留还是删除 |
| 无邻接边的连络线 | 3 | 显式决定：不画 / 物理轨道层（海峡線 · 近鉄連絡線 · 富山駅南北接続線） |
| 真实运营断开 | 2 | 拆分判据（阪急今津線 1984 年分离 · 南海高野線 汐見橋線 段） |
| 平行股道选错（gross detour） | 1 | 鹿児島線 水巻→折尾（切 9.4 km / 审计 1.7 km） |
| 无 N02 线路键 | 1 | 広島電鉄 循環線需要非 N02 几何 |
| 其余（主线失败连带支线退回） | 8 | 随上面各条解决 |

**这 33 条不是算法问题**：再写分解规则只会变成替资料做决定。
每一条都需要一份来源，属于拥有它的 session。

### 6.8 S18–S22 · JR 东日本 66 条（2026-08-15）

| Session | 批次 | 本批行数 | 已建 | 包内累计显示线路 |
| ---: | --- | ---: | ---: | ---: |
| 18 | J03-1 | 14 | **7** | — |
| 19 | J03-2 | 13 | **12** | — |
| 20 | J03-3 | 13 | **13** | — |
| 21 | J03-4 | 13 | **12** | — |
| 22 | J03-5 | 13 | **12** | — |
| | | **66** | **56** | **78 条**（含 -N 兄弟） |

```text
拓扑（按本批线路计）  S16–S22 全部 0 ERROR
站锚点               1515 个 —— 1512 PASS / 3 WARNING / 0 ERROR
lint PASS · node --test 234 pass / 25 fail
```

**这一轮修掉四个构建器缺陷，全部由验证器或对账实测暴露，不是推测**

1. **`partition_by_audit` 的「内部站」判据错了**（水郡線 触发）。原判据是「邻居全在支线集合内」，
   但审计的支线站表**不一定包含分岔站**：常陸太田支線 从 南酒出 起列，而 南酒出 的邻居 上菅谷
   在集合外，于是 南酒出 被留在主线上——主线因此跑出去再折回，
   上菅谷→南酒出→常陸鴻巣 在 2.8 km 的直线距离上切出 4.9 km，
   拓扑验证器报 `wrong_branch_direction 140°`。
   **正确判据：主线穿过的站有两个集合外邻居（左右各一），挂在支线上的最多一个。**
   修完 室蘭線 直接建成。

2. **「两端点 + 全覆盖」不等于链**（南武線 触发）。南武線 30 站 **30 条边**，
   比链多一条。游走能覆盖全部 30 站、看起来是条链，但它的顺序是
   尻手→川崎→八丁畷——每一步都走在真实边上，笔画却折回自己。
   **判据改为边数必须等于站数−1**；多出来的边意味着「线路往哪走」有选择，
   而选择属于审计的 partition，不属于游走。
   partition 拿不出时**降级为游走并记录**（`order walked from the graph`），
   否则会误伤 6 条本来干净的线路。

3. **区间切出的路径可能跑到别的股道上**（東北線 触发）。N02 把 京浜東北/山手/宇都宮/货物
   多条实体股道记在同一个 `東北線` 键下，它们在联络线处相接，
   于是两个相邻站之间的最短路可以离开客运走的那条：
   **大宮 → 北与野 切出 32.593 km，审计 1.572 km，直线 1.763 km。**
   这类区间**拒绝而不是记录**——地图上留一条 32 km 的笔画比不画更糟。
   门槛 `max(3×审计, 审计+2 km)`。同时抓到 東十条→赤羽 5.926 vs 1.369。

4. **主线建不出来时，支线不得单独发布**。函館線 的 砂原支線、東北線 的两段短兄弟线
   都曾在主线缺席时进包——地图上等于宣称支线才是这条铁路。
   现在主线失败即整条线路全部退回。

**`promote-lines.mjs --prune`（新增）**：删除**本批拥有**、但构建器已不再产出的线路。
没有它，早期用有缺陷的构建器 promote 进去的线路会永远留在包里——
构建器不再产出它，之后每次 promote 都「untouched」，地图继续画着没有东西能复现的几何。
这与 staging 规则防的是相反方向的同一类事故，因此**作用域严格限定在本批行**。

**`verify-batch.mjs` 门 3 改为按本批线路判定**。原本跑全国 `--strict`：
JR 东日本的 中央線 因为 **JR 东海的 中央線（200 km，S29 才建）没画** 而被判 ERROR ——
验证器按名称把「缺线」归到了同名的已画线路上。用一个 session 的未完成工作去否决另一个
session，这道门在重建中途就没法用了。改为读 `--json`、只看本批线路、
并排除 `missing_line` 这一类**全网完整性**判据（S66 全量跑时它必须归零）。

**未建的 10 条**（S18 7 条 / S19 1 / S21 1 / S22 1）连同 S17 的 4 条，
根因仍是 §6.7 的 A 族（平行候选边成环）与 B 族（审计支线站数 <2）。

### 6.7 全境试建 —— 高风险线形清单（计划书 §10 要求 S16 交付）

修完游走 bug 后**全 596 条跑了一遍**（约 1 分钟；此前那次「25 CPU 分钟没跑完」正是
游走在环里空转，不是数据量问题）。结果：

```text
565 / 596 canonical 线路可建   ->  582 条显示线路（含 -N 兄弟）
31 条建不出来，落在下面五个族里（原第六族 C 已由修构建器解决）
全境试建耗时 12 秒
```

**这份清单的用法**：每批只处理属于自己的那几条，不留尾巴。同一族的线路根因相同，
**应当一次性定判据再分批应用**，不要逐线绕开。

| 族 | 条数 | 现象 | 该定的判据 |
| --- | ---: | --- | --- |
| **A 平行候选边成环** | 18 | 去掉审计支线后仍剩 1–8 个环 | 站区收缩把平行股道并成两站间的第二条边。定：何时合并、何时保留 |
| **B 审计支线站数 <2** | 7 | 支线被审计记录但只有 0–1 站 | 既画不出（compact-v1 按站对定位）又不能当支线移除。定：这类短股道的表示方式 |
| ~~**C 本线区段图不连通**~~ | ~~6~~ **0** | ~~相邻两站之间无路径~~ | **已解决——是构建器缺陷，见下** |
| **D 无邻接边** | 3 | 连络线，无客运车站 | 显式决定：不画 / 作为物理轨道层 |
| **E 无 N02 线路键** | 1 | 広島電鉄 循環線（2026-03-28 开业，N02-25 基准日之前不存在） | 资料包 README 已记；需要非 N02 几何来源 |
| **F 线路自身分成多个轨道组** | 3 | 一条线的车站分布在互不相连的两组轨道上 | 三条**都是真实的运营断开**，需要像 根室線 那样拆成两部分 |

**C 族根因：锚点选段没有考虑可达性（构建器缺陷，已修）**

原以为「连接段被 N02 归在别的键下」。实测**推翻了这个猜测**：六个断点里五个，
本线自己的键在两站附近都有轨道。真正的原因是——

一条线的 N02 区段**不一定是一个连通图**：上下行平行股道是各自独立的要素，
只在测绘让它们相接的地方相接。`project()` 按几何最近取段，于是相邻两站可以
各自落在**互不相连的平行股道**上，两者之间自然切不出区间。
東北線 400 个区段分成 3 组，主组覆盖 155 站里的 154 站，但 日暮里 一带
有个 8 段的小组把个别车站吸走了——「无路径」就是这么来的。

修法：**锚点按「部分」而非按线路选轨道组**。一个 part 是一笔连续的笔画，
它的车站必须落在同一个连通轨道组上，而**由这个 part 自己的车站投票**决定是哪一组。
按整条线选一组会打断真的分成两段的线路（根室線），按最近取段会打断平行股道多的线路（東北線）。

```text
修前 579 建成 / 35 skip      修后 582 建成 / 32 skip
C 族 6 条 -> 0 条：上越線 · 東北線 · 東北線-3 直接建成
剩下三条改报真实原因（F 族），不再是误导性的「无路径」
已发布的 17 条线路 stations/segments 逐字节不变 —— 本次修改不需要重新 promote
```

**F 族三条都是真实运营断开，不是缺陷**

| 线路 | 分开的部分 | 事实 |
| --- | --- | --- |
| 阪急 今津線 | 今津 与其余 9 站相距 1.6 km | 今津北線/今津南線 1984 年起在 西宮北口 物理分离 |
| 南海 高野線 | 汐見橋 · 芦原町 等 4 站，3.5–4.3 km | 汐見橋線 段，运营上独立 |
| JR北海道 函館線 | 旭川 側 26 站，距另 52 站 111 km | N02 的 函館線 区段在此有缺口，**需要核实是缺口还是归属** |

**审计包的 `branch_parts_json` 没有记录前两条**——它们不是支线，是同一线路名下的
两段独立轨道。处理方式与 根室線 相同（拆成 `-2` 兄弟线），但判据要另找来源。

**S18 的负担因此从 7 条降到 4 条**：上越線 · 東北線 · 東北線-3 已建成，
剩下 中央線 · 常磐線 · 東海道線 · 総武線 四条 A 族。

**A 平行候选边成环（18 条）**

```text
S17 J02    千歳線 · 室蘭線 · 石北線
S18 J03-1  中央線 · 常磐線 · 東海道線(東) · 総武線
S19 J03-2  成田線          S22 J03-5  鶴見線
S23 J04-1  山陽線          S27 J05-1  長崎線 · 鹿児島線
S29 J05-3  東海道線(海)    S30 J05-4  予讃線
S33 J06-3  大江戸線        S48 J09-1  富山地鉄本線
S63 J12-1  ポートアイランド線   S64 J12-2  ユーカリが丘線
```

**S18 一批就占 4 条 A 族 + 3 条 C 族**——J03-1 是全计划最重的一批，
建议在进 S18 之前先把 A 与 C 两族的判据定下来，否则 S18 会被这 7 条拖住。

**B 审计支线站数 <2（7 条）**：白新線 · 佐世保線 · 京王線 · 名鉄広見線 ·
松浦鉄道西九州線 · 広島電鉄宇品線 · 伊予鉄城南線

**F 线路自身分成多个轨道组（3 条）**：函館線 · 阪急今津線 · 南海高野線 —— 见上表。

**D 无邻接边（3 条）**：海峡線 · 三岐鉄道 近鉄連絡線 · 富山地鉄 富山駅南北接続線。

**注意**：`data/staging/jp-2025.staging.json` 现在含全部 579 条，但**只有 promote 过的进包**
（当前 17 条）。staging 是构建产物，不是发布物。

**CSV 回写**：S02–S16 共 75 行已由 `mark-batch-status.mjs` 置为 `unverified`
（数据侧完成、Apple 复核未闭环）。此前 15 个 session 只写了本表、没写 CSV，
现已补齐——CSV 是逐线权威清单，不回写等于把进度只记在散文里。

### 6.5 S16 交付与发现（2026-08-14）

**结论先说**：新干线 9 条全部建成并 promote，110 个站锚点 **110 PASS / 0 ERROR**，
拓扑 8 PASS / 1 WARNING / 0 ERROR，测试 **221 → 233 pass、38 → 26 fail**。
门 5（Apple 复核）**未闭环**，原因是环境权限，不是数据——见下文「一处环境阻塞」。

**`scripts/railway/n02/` 不是重建路径，这是本 session 第一个发现**

计划书写的是「用 n02/{...}.py 复建管线」。实测这条路走不通，而且原因不是缺依赖：

| | `n02/build_package.py` 产出 | 已发布包（五国共用） |
| --- | --- | --- |
| format | `compact-v2` | `compact-v1` |
| 车道 | 逐顶点 `d` 烘进 `segments[i][3]` | 独立 `lanes[]` 表，由 build-parallel-corridors 重算 |
| 车站行 | 9 字段 | 6 字段 `[group, name, lon, lat, roma, romaSource]` |
| structure 行 | 以 **段序号** 开头 | 以 **米数** 开头 |

`finalize-japan-package.mjs` 读 `row[0]` 当米数，喂给它 v2 的 structure
就是把段序号当成米。两者是两个格式，而渲染器与其余四国只认前者。
所以本 session **新写驱动**，只保留 `n02_source.py`——它对 Shift-JIS 图层的解析
（cp932、字符串零填充、UTF-8 副本被舍入）是唯一权威且经过验证的部分。

**新增 `app/scripts/railway/build-japan-package-from-inventory.py`**

与 hk/tw 的 `build-package-from-inventory.py` 同构，来源分工：

```text
几何        N02-25_GML.zip Shift-JIS RailroadSection（按 line/operator 取本线区段）
站锚点      N02 Station 站台折线的沿线中点，投影到本线自己的轨道
站序        rebuild-inventory 的有向邻接图（已含 2026-08-13 全部修正）
方向        分类表的 main_path（「新青森 → 東京」），几何定不了方向，审计定了
kind/颜色   n02-line-shape-classification.csv 的 render_kind / render_color_hex
英文站名    osm/osm-station-names.json（ODbL，按 N02_005g）
rank/nameRoma/logo   由存档的 pre-rebuild 包按 (operator, name) **carry**
```

**区间几何是「在本线轨道图上求两个锚点间的最短路」，不是切一条拼好的中心线。**
日本一条线路不总是一条折线——596 条里有分支、回归、环线、之字。把它们拼成一条
再切，等于替资料决定一个它没说的顺序。逐区间求路是图能回答的问题，而且答案可验：
每段都与审计的 `distance_km` 对账。

`rank` / `nameRoma` / `logo` 三项**刻意 carry 而非重新派生**：它们是别处验过的显示属性
（2026-08-10 的 594 条 logo 全量复审就是验它的），重新派生等于把那次复审扔掉。

**四段与审计距离不符——查下来是审计偏短，不是本次画错**

| 线路 | 区间 | 本次切出 | 审计 | 官方营业里程 |
| --- | --- | ---: | ---: | ---: |
| 東北新幹線 | 上野–東京 | 3.709 | 3.375 | 3.6 |
| 東海道新幹線 | 品川–東京 | 6.621 | 6.226 | 6.8 |
| 九州新幹線 | 新鳥栖–久留米 | 5.722 | 5.506 | 5.7 |
| 山陽新幹線 | 新尾道–三原 | 10.486 | 10.086 | 10.3 |

四段全部是本次更接近官方值。审计的 `distance_km` 是**收缩图节点到节点**的长度，
本次是**站台中点到站台中点**，差的正是锚点到图节点那一截。
这条对账规则保留（它抓的是「路走错了」），但**它偏短是已知的，不是缺陷**。

**批次表 `stations` 列是 N02 要素数，不是车站数**

東海道新幹線 表里 18、本次 17；山陽新幹線 表里 20、本次 19。查下来两条线的
**新大阪（006911）都有两条站台折线**，N02 记了两个要素、同一个 005g。
distinct 站数 17 / 19 是对的，与 pre-rebuild 包一致。CSV 那一列此后按「要素数」读。

**東海道新幹線 1.90 km 未画（WARNING，不修）**

分类表记录它有 1 条 `terminal_branch`：2.125 km、**0 个车站**（名古屋车辆所引入线）。
compact-v1 的绘制单位是「站到站区间」，一条没有车站的支线在这个 schema 里
**没有可指名的端点**——`extraSegments` 也不行，那个字段用两个车站索引指端点。
所以它被记录、被报成 `uncovered_corridor` WARNING，**不被伪造成一段客运轨道**。
拿到 physical-track 层之前，这是它该有的状态。

**`verify-batch.mjs` 门 5 对 jp 会空转通过（已修）**

门 5 原本用 `rows.map(row => row.line_id)` 过滤检查队列。tw/hk 的批次表 `line_id`
就是显示 id，能对上；**jp 的批次表存的是 `operator␟line` 规范键**，与队列里的
`jp-<operator>-<line>` 永远不相等 → 选出 0 行 → `queue.length` 为 0 → 门 5 不报错。
也就是说：jp 的每一批都会在「一个检查点都没看」的情况下通过 Apple 门。
改为按门 1 已经解析出的显示 id 过滤。`plan-apple-capture-tiles.py` 有同一处
（`--session 16` 原本返回 "no checkpoints matched"），改为规范键与显示 id 都接受。

**新增 `app/scripts/railway/build-japan-check-queue.py` —— jp 检查队列 20379 行**

```text
line_shape         596      每条线一项
station_anchor   10149      每条线的每个车站一项
segment_geometry  9634      每条邻接边一项
```

hk/tw 的队列由 `audit-compact-rail-network.py` 从**成品包**生成；jp 不行——
包正在逐批重建，而队列必须先于第一批存在（门 5 要读它）。所以队列**从审计资料包生成**，
坐标对已建成的线取自已发布包、对未建成的线取自审计站点位置，并用新增列
`geometry_basis` 区分（`drawn_geometry` 220 行 / `audited_station` 20159 行）。
这一列不是装饰：只有前者是项目**做出过的断言**，后者只是「去这里看」。
另加 `canonical_key` 列，使一行能追回 CSV。

**每次 promote 之后必须重跑本脚本**（`--lines` 只重写指定线路，已记录的复核结论保留）。

**覆盖瓦片**：jp 20379 检查点 → **6915 张**（2.9×，约 7.5 小时）。
计划书估的是 6598，同量级。S16 单批 220 检查点 → 211 张（约 14 分钟）——
新干线是长线、跨全国，几乎压不动，与港铁 12.5× 的压缩比正好是两个极端。

**一处环境阻塞：Apple 采集需要两项 macOS 权限（只能由用户授予）**

本机是 macOS，采集脚本可以跑，但两项 TCC 权限都没给到 Claude：

```text
辅助功能 Accessibility  → osascript 通过 System Events 摆窗口/收侧边栏
                          实测 `get name of every process` 直接挂起
屏幕录制 Screen Recording → screencapture
                          实测报 "could not create image from rect"
```

这属于系统安全设置，**不由我修改**。授权后 hk 72 张（约 5 分钟）、tw 416 张（约 27 分钟）、
jp 6915 张（约 7.5 小时）都可以直接跑，脚本本身可断点续跑。

**因此「差异量化流水线」本 session 未交付，且不应假装交付。**
`overlay-project-geometry.py` 已能把项目几何按同一取景叠到 Apple 截图上（S02 交付），
但「量化偏差、只把超阈值项推给人工」需要先有真实截图来标定
Apple railway 像素的判据。没有截图就写一个未标定的检测器、再声称它能用，
正是这套规范要避免的事。**列为 S17 的第一项，前置条件是上面两项权限。**

**依赖记录**：本管线需要 `pyshp` 与 `numpy`（`n02_source.py` / N02 图层解析），
系统 python 3.9 没有。本次用 venv 装，未写进仓库依赖清单——
若要 CI 化需要补 `requirements.txt`。

**新增 `app/scripts/railway/mark-batch-status.mjs`**：SOP 第 9 步的唯一写入者，
只改 `status` 字段、其余字节不动，状态词表 `done/unverified/blocked/pending`。
`unverified` 不是软化版 `done`——它明确表示门 1–4 过、Apple 未闭环。

**测试**

```text
S05/S06 补完  pass 221 / fail 38
S16 后        pass 233 / fail 26
目标          pass 243 / fail  0
```

本轮转绿 12 项，全部是「日本包非空」才可能成立的项：
`apple-maps-railway-contract` 3 项（含 `five_country_build_and_validation_scope`）、
`railway-display-curve` 1 项、`station-render-anchoring` 4 项、
`railway-parallel-corridors` 2 项、`railway-topology-audit` 2 项。
剩余 26 项仍等日本其余 587 条线路（S17 起）。

### 6.3 S03–S15 交付与发现

**统一构建器 `app/scripts/railway/build-package-from-inventory.py`（取代 S02 的 HK 专用版）**

台湾原构建器同样跑不了：`build-taiwan-rail-package.py` 需要 8 个下载输入
（TDX/PTX 快照、4 份 NLSC shapefile、台北捷运 GeoJSON、阿里山详图），
`data/raw/railway/tw/` 里一个都没有——与香港是同一类来源留存缺口。

| | hk | tw |
| --- | --- | --- |
| 站序 | 审计有向服务图（按线路自身 layer） | 同左 |
| 几何 | hk-track-alignments.json + hk-tram-alignments.json | 审计包 `evidence/source-compact-package.json` 的逐线中心线 |
| rank / isHSR | 按规则派生（重铁 1 / 轻铁 3） | 由审计源包 carry |

**结果：hk 25/27、tw 39/39 全部与审计包一致**——里程差 < 0.1 km、站数完全相同、
站锚点最大偏差 < 1 m。

**被拒绝构建的 2 条（不是失败，是拒绝猜测）**

| 线路 | 图论事实 | 为什么不能建 |
| --- | --- | --- |
| 輕鐵505 | 17 站 / 18 条唯一边 / 1 个链端点 / 4 个奇度节点 | 无欧拉路径 |
| 輕鐵751 | 23 站 / 23 条唯一边 / 1 个链端点 / 2 个奇度节点 | 有欧拉路径但会重复经过车站 |

compact-v1 的 `stations` 是**互不重复**的有序表，`segments[i]` 对应 station i→i+1。
两条线两个方向不镜像，任何单一不重复站序都必然丢掉方向独有的边——
正是规范 §19.7 的 `network_union_missing_branch_edge`。
**这需要一个显式决定（扩展 schema 还是接受丢边），不能由构建器代劳。**

**过程中修掉的 3 个真 bug**

1. 两站线被误判成单向环（A→B + B→A 也满足「每站一条出边、边数=站数」），
   迪士尼綫因此画成 5.69 km 而不是 3.03 km。改判据为「无互反边且 ≥3 站」。
2. 高雄環狀輕軌是**双向闭环**，既没有单向环也没有链端点，原判据两头落空。
   补上「无向图每站恰好 2 个邻居且成单一环」的判据。
3. `recompute-package-derived.mjs` 只在包里已有 `lanes` 字段时才重算，
   而台湾包**从来没有过 lanes 表**——高铁与台铁纵贯线并行了大半个西海岸却没有分道数据。
   改为无条件重算，台湾因此第一次有了 8 段 lane。

**一次由我造成的数据损失（已修复，但要记下来）**

我尝试用香港构建器的 `build_derived_datasets()` 重生成两国 solver 数据集。
它按 `codePrefix` 派生车站代码，而**车站代码是持久化身份**（train store 引用它，
台湾的必须是 TDX StationUID）。结果重写了全部代码、打挂 6 个原本通过的测试。
回滚时只能恢复到 git HEAD，而 HEAD 早于审计——**三鶯線的 12 个车站与 11 条 section
是仅存在于未提交状态的工作，被我覆盖后丢失**。

已按官方存档 `data/raw/railway/tw/sanying-official-stations.json`（含 `stationUid`）
精确复原，新增：

```text
app/scripts/railway/restore-taiwan-sanying-solver-rows.py   按官方 UID 补回 12 个车站
app/scripts/railway/rebuild-solver-sections.py              从已绘制的包重算 sections
```

`taiwan-solver-datasets.test.js` 现在 **5/5 全绿**（重建前是 4/1）。
`build-package-from-inventory.py --write-datasets` 已**禁用并写明原因**：
在拿到真正的 code 前缀映射之前，这条路是关着的。

**香港 sections 暂不重算**：505/751 未建，现在重算会把它们的 38 条 section 删掉——
那是倒退不是修复。等这两条线定案后再做。

**测试进展**

```text
清空后        pass 188 / fail 55
S01 后        pass 198 / fail 55
S03–S15 后    pass 213 / fail 41
目标          pass 243 / fail  0
```

### 6.4 S05/S06 补完：`extraSegments` schema 扩展（2026-08-14）

**结论先说**：香港 27 条线**全部建成**，450 个站锚点 450 PASS / 0 ERROR，
拓扑 27/27 PASS，`hong-kong-rail-package.test.js` **7/0 全绿**。

**为什么原来的判据是错的**

我先前判定 505/751「无法用 compact-v1 表达」，前提是「站序必须是邻接游走」。
这个前提本身错了：compact-v1 的站序是**沿中心线的顺序**，不是邻接顺序——
`split_route` 在两个相邻投影站点之间切中心线，无论两站之间是否有直达车。
所以站序总是存在（按投影里程排序），需要额外记录的只是**这个顺序没有表示出来的服务边**。

| 线路 | 站数 | 沿线顺序的相邻对 | 唯一服务边 | 顺序表示不了的边 |
| --- | ---: | ---: | ---: | ---: |
| 輕鐵505 | 17 | 16（其中 1 对无服务） | 18 | **3** |
| 輕鐵751 | 23 | 22（全部有服务） | 23 | **1** |

这 4 条边正是审计 README 记录的非镜像段：
505 的 兆康↔青松、石排↔鳴琴、山景(南)↔建安，751 的 市中心↔友愛。

**schema 扩展**

每条线新增可选字段 `extraSegments`，每项用两个 station 索引指明端点，
**几何可选**：

```json
"extraSegments": [
  { "from": 0, "to": 2, "status": "data_coverage_gap", "evidence": "HK-LR-GEOM-002: …" }
]
```

**当前 4 项全部没有几何，这是刻意的。**`hk-track-alignments.json` 每条线只有一条折线、
不分左右股道（未解决的审计问题 `HK-LR-GEOM-002`）。从这条共用中心线切出来的笔画会
**正好压在站序链上**，等于在地图上断言两个方向共轨——恰与官方服务数据相反；
凭空造出分离几何更糟。所以边被记录、被标记、**不被绘制**。

`rail-network.js` 只绘制带几何的项，因此将来拿到分股道 alignment 时
**不需要改 schema，也不需要改代码**。

新增 `app/test/extra-segments.test.mjs`（5 项全绿）同时钉住两条相反的规则：
边必须被记录；没有几何的边必须画不出笔画。第 4 项用合成 fixture 验证
「带几何时确实多出一条笔画且两端焊在它指名的站点上」，这样这个字段不会是装饰品。

`app/public/rail/hk-2025.sources.md` 已按规范 §3.6 写明该字段的显示层语义。

**顺带修完的两处**

- `rebuild-solver-sections.py --country hk`：27 条线齐了才重算，425 → 425 条 section，
  几何与已绘制的包对齐。（此前 505/751 缺席时重算会删掉它们的 38 条 section，是倒退。）
- `npm run precompute:hk` 重生成香港样例行程，`hong-kong-rail-package` 的
  「sample routes coincide exactly」随之转绿。

**一处环境限制（不是代码 bug）**

`precompute-train-parts.mjs` 发布产物后会 `rmSync` 掉 `.previous` 目录，
而这台 Linux VM **不允许 unlink**，所以脚本在清理阶段必定报 EPERM 退出 1 ——
产物本身已经正确写入。残留目录已移到仓库根的 `_to_delete/sample-data-hk.previous`，
请自行删除。台湾侧未触发（本轮无需重跑 tw precompute）。

**测试**

```text
S03–S15 后    pass 213 / fail 41
S05/S06 补完  pass 221 / fail 38
目标          pass 243 / fail  0
```

剩余 38 项**全部依赖日本数据**（已逐条确认：`railway-parallel-corridors` 第一条失败即
「成田空港線 took no lane」）。香港与台湾的数据侧到此结束，只剩 Apple 瓦片核对。

本轮转绿：`railmap-popup-hong-kong` 4/0 全绿、`taiwan-rail-package` 4/0 全绿、
`taiwan-solver-datasets` 5/0 全绿、`i18n-*` 全绿，
`railway-topology-audit` +2、`railway-parallel-corridors` +2、`ridden-route-network-geometry` +2。
剩余 41 项里 33 项依赖 jp（S16 起），8 项依赖 hk 的 505/751 与 Apple 核对。

**一处 test 断言改动（按规范 §14 流程，非降标准）**

`taiwan-rail-package.test.js` 的 `#4EB7D5` 改为 `#4eb7d5`：包颜色现在来自审计资料包的
`colours/line-colours.csv`（小写），而 `finalize-japan-package.mjs` 早已把日本统一为小写。
五国统一一种写法，颜色值本身没变，改动理由写在断言旁。

### 6.2 S02 交付与发现

**新建 `app/scripts/railway/build-hong-kong-package-from-inventory.py`**

原 `build-hong-kong-rail-package.py` 需要 `--mtr-html` 与 `--mtr-csv` 两个输入，
它们当年下载到 /tmp 后**没有归档进 `data/raw/railway/hk/`**，今天已无法重跑 ——
这是一处来源留存缺口。新构建器改从 2026-08-13 审计资料包读取：

```text
站序        stations/station-connections.csv 的有向客运服务图（只走 layer=passenger_service）
站点身份    stations/station-network.json（含 station_english）
线上锚点    每线 station_points 的 on_line_render_anchor
颜色        colours/line-colours.csv 的 render_color_hex
几何        data/raw/railway/hk/hk-track-alignments.json（与旧包同一份中心线）
```

几何切割**复用原构建器的 `split_route` / `compact_line`**，因此本次重建与旧包的差别
只在「站序与身份的来源」，不在「折线怎么切」——否则两者无从比较。

**与旧包的逐线比对（7 条）**

| 线路 | 站数 | 站序 | 旧包 km | 新包 km | 站锚点最大偏差 |
| --- | ---: | --- | ---: | ---: | ---: |
| hk-mtr-isl | 17 | same | 15.02 | 15.02 | 0.01 m |
| hk-mtr-twl | 16 | rev | 15.77 | 15.77 | 0.01 m |
| hk-mtr-ktl | 17 | rev | 17.31 | 17.31 | 0.01 m |
| hk-mtr-tkl-poa | 7 | same | 9.53 | 9.53 | 0.01 m |
| hk-mtr-tkl-lhp | 2 | same | 3.06 | 3.06 | 0.00 m |
| hk-mtr-sil | 5 | same | 6.89 | 6.89 | 0.00 m |
| hk-mtr-drl | 2 | rev | 3.03 | 3.03 | 0.00 m |

`rev` = 站序方向与旧包相反。新构建器按**站锚点在中心线上的投影里程**定向，
不再沿用抓取载荷的偶然方向；两个方向都是事实，但投影定向是确定性的、可复现的。
颜色由旧包的大写 HEX 变为审计资料包的小写 HEX（与 jp 包一致，CSS/MapLibre 等价）。

**验收门结果**

```text
1 coverage    7/7 行全部落地
2 derived     lanes / stats 与新算一致
3 topology    PASS   Lines checked: 7   PASS: 7  WARNING: 0  ERROR: 0
4 anchoring   PASS   hk: 66 platforms — 66 PASS, 0 WARNING, 0 ERROR
5 apple       0/132  ← BLOCKED
```

66 = 17+16+17+7+2+5+2，与计划表一致。

**发现**

| 项 | 性质 | 处理 |
| --- | --- | --- |
| `build-hong-kong-rail-package.py` 的输入未归档，无法重跑 | 来源留存缺口 | 已由新构建器绕过；旧构建器保留但不再是重建路径 |
| 轻铁 505 / 751（1 个端点）、705 / 706（0 个端点）无法链成简单站序 | 正是审计包 README 记录的 4 条非镜像/单向环线 | 构建器**拒绝猜测**并报 SKIPPED，留给 S05 / S06 按方向性证据处理 |
| 4 条电车向量不在 `hk-track-alignments.json` | 几何在 `hk-tram-alignments.json`，且是实体轨道而非服务线路 | S07 处理 |
| `recompute-package-derived.mjs` 在「重算无变化」时跳过了 .gz 重写，留下 0 线路的陈旧 sidecar | **S02 发现的真 bug** | 已修：sidecar 无条件与 .json 对账；新增测试断言五国 .gz 解压后与 .json 逐字节相同 |

**门 5（Apple 核对）的执行方式已定案**

尝试用 computer-use 在 Mac 上直接驱动截图，结论如下：

| 途径 | 权限 | 可否用于逐点截图 |
| --- | --- | --- |
| 地图 App | full（可点击/输入） | 只能靠搜索定位，会产生 pin，违反规范 §13「无搜索聚合、pin」；缩放靠步进不可复现 |
| 终端机 | click-only（不能输入命令） | 无法运行现成的 `capture-apple-maps-reference.sh` |
| Safari / Chrome | read-only | 无法用 `maps.apple.com/?ll=&z=&t=r` 跳转交接给地图 App |

因此逐点截图必须**由本人在 Mac 上运行一条命令**，新增：

```text
app/scripts/validation/capture-apple-maps-checkqueue.py
```

它由 check-queue 驱动（而不是像 `capture-apple-maps-reference.sh` 那样写死代表地点），
沿用同一套可采信条件：`t=r` 大众运输视图、无 `q=` 因而无 pin、窗口 1512×855、
截图区域 0,33,1512,855、逐点记录 check_id/坐标/缩放到 `captured-index.csv`。
已存在的 PNG 会跳过，因此中断后重跑即续传；非 macOS 运行时直接报错退出。

```bash
python3 app/scripts/validation/capture-apple-maps-checkqueue.py --session 2
```

### 6.1 S01 交付与发现

**交付**

```text
app/scripts/railway/lib/rebuild-batches.mjs        批次表读取 + 逐国 line id 解析
app/scripts/railway/promote-lines.mjs              按 session/line id 从 staging upsert 进已发布包
app/scripts/railway/recompute-package-derived.mjs  重算 lanes / stats，重写 .gz
app/scripts/validation/verify-batch.mjs            单 session 五道验收门
app/test/rail-package-promotion.test.mjs           10 项不变量测试（原计划命名为 .test.js，
                                                   因需 import ESM 模块改为 .test.mjs）
```

`.gitignore` 新增 `app/data/staging/`；`check-source.mjs` 的 SKIPPED_DIRECTORIES 新增 `staging`。

**关键设计决定**

- 已发布包的 `lines` 每次写入按 `id` 码位序重排 —— 这是 promote 顺序无关性的来源。
- `lanes` / `stats` 不由 promote 写，改由 `recompute-package-derived.mjs` 负责；
  `stats.sourceIntervalsRegeometried` 与 `sourceIntervalsKept` 是 N02 几何构建的来源计数，
  读成品包无法恢复，因此**原样carry**并在输出中标注「来自上次完整构建」，
  由 jp 完整后的 `finalize-japan-package.mjs` 重述，不伪造中间值。
- jp 的批次表 `line_id` 是 N02 canonical identity（`operator␟line`），
  与包里的 display line id（`jp-<operator>-<line>`，分支拆分后还有 `-2`/`-3` 兄弟）不是一回事，
  因此 jp 走 (operator, name) 归一化匹配，并沿用 finalize 的 2 条运营者别名
  （東京地下鉄→東京メトロ、大阪市高速電気軌道→Osaka Metro）。一条 canonical 行解析出多条
  display line 是正常的。

**发现（已写成测试断言，不是备注）**

| 项 | 性质 | 处理 |
| --- | --- | --- |
| `広島電鉄␟循環線` 在 canonical 清单中但旧包没有 | 2026-08-13 核验新增线路 | S60–S62 重建时新建 |
| `三岐鉄道␟近鉄連絡線`（1.17 km / 1 站）旧包缺失 | **旧包的覆盖缺口**，N02 基线本就有 | S48–S52 重建时补回 |
| `富山地方鉄道␟富山駅南北接続線`（0.26 km / 1 站）旧包缺失 | 同上 | S48–S52 重建时补回 |
| `jp-北海道旅客鉄道-留萌線` 旧包有但 canonical 清单已删 | 2026-08-13 核验废线 | 不重建 |

这 4 项被写进 `rail-package-promotion.test.mjs` 的精确断言集合：
再出现第 5 个未解析行，测试立刻红，不会混进「已知差异」里蒙混过关。

> 每批次必须记录：canonical identity 清单、来源与版本、AllowedTransition 状态、
> 是否引入 `UNVERIFIED`，以及本批次让哪些第 5 节的测试转绿。

---

## 7. 下一 session 起手式

**先清 S17 的 5 条尾巴**（见 §6.6），其中 4 条是同一个根因：分类表标注
「站区收缩后仍合并 N 条平行候选边」的线路，其邻接图里两站之间多出第二条边而成环。
判定这些平行候选边该合并还是该保留，一次解决四条（千歳線 / 室蘭線 / 石北線 /
以及 函館線 札幌→苗穂 无路径）。海峡線 需要一个显式决定，不是构建器改动。

之后进 S18（J03-1 · JR 东日本 14 条 / 3436 km，全计划最重的一批）。

### 每批的标准动作

```bash
cd app
N=18   # 本批号
python3 scripts/railway/build-japan-package-from-inventory.py --session $N
node   scripts/railway/promote-lines.mjs --country jp --session $N   # 或 --lines <只促成功的那些>
node   scripts/railway/recompute-package-derived.mjs --country jp
python3 scripts/railway/build-japan-check-queue.py        # 重跑，让本批坐标落到已画几何上
node   scripts/validation/verify-batch.mjs --session $N
node   scripts/railway/mark-batch-status.mjs --session $N --status unverified [--lines ...]
```

构建器需要 `pyshp` + `numpy`（系统 python 3.9 没有，用 venv）。
**一批没有全建成时**：只 promote 建成的那些（`--lines` 显示 id），
CSV 也只回写那几行——不要把整批写成同一个状态。
兄弟线路 `-2` 若其主线未建成，**先不要 promote**：只画支线而主线缺席，
在地图上等于宣称支线才是主线。

**未决项（不随批次推进而消失，解决前每批开场都要看一眼）**

1. **平行候选边成环**（S17 遗留 4 条）——分类表标注「站区收缩后仍合并 N 条平行候选边」
   的线路，邻接图里两站之间多一条边而成环，构建器拒绝。需要一次性判定合并/保留。
2. **差异量化流水线**（S16 未交付）——前置条件是用户授予辅助功能与屏幕录制权限；
   拿到真实截图才能标定 Apple railway 像素判据。权限未给则继续如实标为未交付。

---

## 8. 回滚方式

```bash
cd app
gzip -dc data/raw/railway/jp/packages/jp-2025-pre-rebuild-25031fbc.json.gz > public/rail/jp-2025.json
gzip -dc data/raw/railway/tw/packages/tw-2025-pre-rebuild-7123a58a.json.gz > public/rail/tw-2025.json
gzip -dc data/raw/railway/hk/packages/hk-2025-pre-rebuild-ad80bc90.json.gz > public/rail/hk-2025.json
for c in jp tw hk; do gzip -9 -c public/rail/$c-2025.json > public/rail/$c-2025.json.gz; done
```

回滚后应重新得到 243 pass / 0 fail。
