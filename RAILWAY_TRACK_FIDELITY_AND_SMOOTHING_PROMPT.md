# 轨道贴合与平滑 prompt

修两件事：**画出来的轨道与底图上的轨道对不上**，以及**转角太尖、不够顺滑**。
底图（OpenFreeMap positron，OpenMapTiles `transportation` 层 class=rail）的铁路已经足够顺滑，
要改的是**我们自己画的全部线路**那一套轨道线。范围覆盖支线、环线、上下行分线、站内轨道四种拓扑。

规则本体见 [`RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md`](./RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md)
§6 / §7.2 / §7.5 / §7.7 / §9 / §12。上下行「哪条是哪条」的判据已经写在
[`RAILWAY_ALIGNMENT_AUDIT_PROMPT.md`](./RAILWAY_ALIGNMENT_AUDIT_PROMPT.md)，**不要重造**。

## 动手前先知道这件事：五国现在跑着**三套**几何管线

| | 建包阶段做的几何处理 | 渲染阶段做的 |
| --- | --- | --- |
| **jp** | **没有**。N02 直出，全程无圆角、无平滑、无简化 | `smoothMicroKinks` 删毛刺（从不给真实转角倒角） |
| **tw** | `relax_polyline`（capped Laplacian）→ `round_polyline_corners`（Bezier 倒角）→ `enforce_min_corner_radius` | 同上 |
| **hk / mo / kr** | `geometry.py` 的 `despike` → `chaikin` → `simplify` | 同上 |

这解释了阶段 1 的基线：jp 的 30–45° 折角有 1,121 个，tw 只有 15 个。
**不是 jp 的资料更差，是 jp 从来没跑过那一步**。

所以这件事真正的题目**可能不是「给 jp 加平滑」，而是「三套管线要不要收敛成一套」**。
这是架构决定，必须在阶段 0 明确回答并写下理由，**不允许默认按「把 tw 那套照抄到 jp」实施**。
三个选项各自的代价至少要评估到这个程度：

- **收敛成一套共享 lib**（`scripts/railway/lib/`，参数按 §12.1 的 geometry profile 给）——
  一致性最好，但会同时改动四个已经稳定、审计全绿的国家包，回归面最大。
- **只给 jp 补一套**（移植 tw 的实现）—— 回归面最小，但五国从三套变四套，
  以后每条新规则都要写四遍。
- **不动建包层，改在渲染层**（`rail-network.js`）—— 单点改动、五国同时受益，
  但违反 §12「每档 LOD 只算一次并缓存」的代价要算清楚：渲染层每次 boot 都要重算 385k 顶点。

选哪个都可以，**但必须写明为什么，以及被否决的两个各自的代价**。

## 使用方式

把下面「任务」整段作为 prompt 交给一个 agent。结论必须带**可复算的数字**，
不接受「看起来顺滑了」「贴合改善了」。没量过的写「未测量」。

---

## 任务

你在修 jp/tw/hk/mo/kr 五国显示包的**轨道几何贴合度与平滑度**。
主战场是 jp（652 条线、385,537 个顶点）。

### 阶段 0 · 先读代码和规范，不要先看地图

地图是**最后**的验收，不是判据来源。先截图会让你先形成结论再去找证据。

**必读代码**（改动几乎全部落在这几处，读之前不要提方案）：

| 位置 | 是什么 |
| --- | --- |
| `app/public/rail-network.js:27` `MICRO_KINK_SCALES` | 现有的唯一平滑：按**中位站距**分三档（700 m / 1600 m / ∞）的毛刺去除阈值 |
| `app/public/rail-network.js:180` `smoothMicroKinks` | 只删「短边＋大折角＋小横向偏移」的数字化毛刺，**从不给真实转角做圆角** |
| `app/public/rail-network.js:892` `displayPartsForLine` | 显示笔画的总装：解区间 → 支线拆 parts → 折叠端裁剪 → 毛刺去除 → 站点锚点恢复 |
| `app/public/rail-network.js:168` `sharedVertexKeys` | 支线 lead-in 与干线**逐点重合**的保护机制 |
| `app/public/rail-network.js:360–440` | 站点接近段重建：两侧测量 + smoothstep 窗口（`ANCHOR_WINDOW_RATIO=12`、min 180 m、max 2400 m、`ANCHOR_STEP_METERS=20`、`ANCHOR_MAX_DISPLACEMENT_METERS=250`） |
| `app/public/rail-network.js:44–75` | `RETRACE_*` / `REVERSAL_MAX_DEGREES=25` / `SHARP_TURN_DEGREES=110` / `TURN_RUN_METERS=60` |
| `app/public/railmap-style.js:788` | GeoJSON 源 `tolerance: 0.5`（geojson-vt，单位是**瓦片像素**），`line-join: round` |
| `app/scripts/railway/lib/geometry.py:94/108/123` | `chaikin` / `simplify` / `despike` —— **hk、mo、kr 建包时在用，jp 没用** |
| `app/scripts/railway/build-taiwan-rail-package.py:1057/1119/1176/1221` | **tw 已有整套圆角管线**：`relax_polyline`（capped Laplacian，每个顶点位移有上限）、`round_polyline_corners`（二次 Bezier 倒角，`CORNER_MAX_SAGITTA_METERS=8`）、`corner_radius_meters` / `windowed_corner_radius_meters`、`enforce_min_corner_radius`（`MIN_CORNER_RADIUS_METERS=40`、单次位移上限 3 m、16 轮） |
| `app/scripts/railway/build-japan-package-from-inventory.py` | jp 从 N02 直出，**全程没有任何圆角或平滑** |
| `app/scripts/validation/validate-basemap-alignment.mjs` | 常设「画的 vs OSM 底图」审计（头部注释就是完整用法） |
| `app/scripts/validation/validate-railway-topology.mjs:119/136` | `sharp_artificial_turn`：≥110° 且两侧各有 ≥60 m 真轨道 |
| `app/scripts/validation/validate-station-render-anchoring.mjs` | 月台是否落在它所属的轨道上 |
| `app/scripts/railway/lib/render-snapshot.mjs:351` | `EXPECTED_RENDER_HASH`，几何一变就会红 |

**必读规范**：§12（简化/平滑/LOD 的禁止项与保护集合）、§12.1（geometry profile 五档及其判据字段）、
§12.2（短线与路面电车的圆角上限公式）、§12.3、§7.2（共享走廊按实测几何绘制，2026-08-18 起不做屏幕平移）、
§7.5（全部线路与已乘坐共用同一套路径信息）、§7.7（上下行分线）、§9.1/§9.3（双锚点、多月台进站边）。

**注意工作区状态**：用户会并行开多个会话。写这份 prompt 时 HEAD=`6cfa221`、工作区干净、
`rail-network.js` / `lib/geometry.py` / 各国 build 脚本均无在途改动 —— 但这个状态随时会变。
第一次编辑前重跑 `git status` 并看 mtime，只碰你宣布要改的文件，动手前先向并行会话通报文件范围。

**两条硬契约，先记住再动手：**

- **跨语言产物比对一律 Node 解析后比值，绝不比字节。** Python 建包与 Node 发布对整数的
  文本写法曾经不同（已由 `node_number_style` 统一，commit `6cfa221`），由此产生的一份
  「13 条漂移线」名单把五个批次的晋升挡在门外，直到有人在九个历史提交上各重建一次，
  才发现那些线**从来没有漂移过**。几何工作最容易被这种假阳性带偏 —— 差异只以
  「解析后的值」为准。
- **`SHARP_TURN_DEGREES=110` 与 `TURN_RUN_METERS=60` 在 `rail-network.js` 与
  `validate-railway-topology.mjs` 里是刻意相等的**：渲染器不许焊出审计判定为
  「铁路转不过来」的角。平滑若动到这两个数，两边必须一起动，并说明为什么新的门槛
  仍然守得住这条关系。

### 阶段 1 · 复算基线（先有数字，再谈方案）

下面是 2026-08-20 的实测基线，测于 **HEAD=`6cfa221`、工作区干净**，并在该 commit 的
全量重建后复测过一次，逐字段相同。**你必须自己重跑一遍确认**，不要引用本文的数字当证据。

```js
// 逐国统计显示几何的顶点数、平均边长、转角分布
const RailNetwork = require('./app/public/rail-network.js');
// 对每条 line 调 RailNetwork.displayPartsForLine(line)，
// 逐顶点算 turnDegrees(前, 当前, 后)，分档计数：>=110 / 90-110 / 60-90 / 45-60 / 30-45 / 20-30
```

| 国家 | 线数 | 顶点 | 平均边长 | ≥110° | 90–110° | 60–90° | 45–60° | 30–45° | 20–30° |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jp | 652 | 385,537 | 70.8 m | 12 | 25 | 92 | 247 | **1,121** | **2,479** |
| tw | 39 | 22,333 | 80.8 m | 3 | 1 | 0 | 1 | 15 | 37 |
| hk | 27 | 3,693 | 99.0 m | 0 | 0 | 1 | 2 | 45 | 173 |
| mo | 3 | 168 | 83.7 m | 0 | 0 | 0 | 0 | 1 | 13 |
| kr | 82 | 25,939 | 176.2 m | 0 | 1 | 0 | 1 | 6 | 73 |

按顶点归一：jp 的 30–45° 折角率是 tw 的 **4 倍**，20–30° 是 **3.7 倍**。
tw/hk/kr 在**建包阶段**做过 Chaikin / Bezier / Laplacian，jp 一次都没做过。
这**指向**「jp 的尖角在包几何里就已经存在，不是渲染参数问题」——但这是**假设**，
阶段 3 必须用数据判定，不许直接抄这句当结论。

**审计基线**（改动后这三个数只能变好，不能变差）：

```text
validate-railway-topology.mjs   jp 652 线 · PASS 641 / WARNING 11 / ERROR 0
                                sharp_artificial_turn 10 · interval_doubles_back_at_station 5
                                uncovered_corridor 5 · wrong_branch_direction 1
                                parallel_not_shared_lead_in 1 · reversal_joint_redraws_track 1 · missing_line 1
                                tw PASS 38/WARNING 1 · hk 27/0 · mo 3/0 · kr 81/1
validate-station-render-anchoring.mjs   jp 10,216 月台全 PASS，五国 0 WARNING / 0 ERROR
包体积与顶点数                   记下改前的 jp-2025.json 字节数与顶点数，阶段 3 要用
```

### 阶段 2 · 贴合：先分清是谁错了

**2.1 跑全量比对。** OSM 缓存已经在 `outputs/osm-basemap-cache/`（73 个 cell / 172 MB），
**不需要再 `--fetch`**，只有报「uncached」时才补抓：

```bash
node scripts/validation/validate-basemap-alignment.mjs --json outputs/basemap-2026-08-20.json --all
```

**2.2 每条 finding 必须归入三类之一，逐条给证据。** 三类的处理方式完全不同：

| 类 | 判据 | 处理 |
| --- | --- | --- |
| **我们画错了** | 我方线贴着 disused/abandoned/razed 的 OSM way（≤25 m），或偏差 ≥250 m | 改**数据**（重路由/换源），不是改平滑 |
| **底图粗** | OSM way 顶点数远少于 N02（长隧道被志愿者画成直弦） | 写进裁定 ledger，附 way id + 两边顶点数 |
| **系统性偏移** | 全线中位 >10 m 但处处 ≤20 m | 通常是站点锚定把线拉到月台中点（ゆいレール 实测 ~18 m），**这是设计**，归阶段 2.5 |

裁定 ledger 在 `app/data/raw/railway/jp/evidence/basemap-alignment-exclusions.json`（现 13 条）。
里面的**不要重报**，新增同类必须补条目并写明证据（way id、顶点数、N02 section 号）。

**2.3 两条硬禁止。**

- 不得为了贴底图改站序、分支归属、Junction 位置或拓扑（§12 明文禁止）。
- 不得把 OSM `service=siding|yard|spur|crossover` 的轨道当匹配目标 —— 它们会把干线吸到侧线上。
  匹配干线只认 `usage=main|branch` 且无 `service=*` 的 way。

**2.4 什么时候该上 map matching。** 只有当「我方中心线整体骑在另一条实体轨道上」时才需要
重投影（HMM 地图匹配）。几十米的抖动是**平滑**问题，不要用 map match 去解 —— 匹配会把噪声
换成另一种噪声，并且会顺手破坏支线共享顶点。

**2.5 站内轨道**（这一节单列，因为它同时是贴合问题和平滑问题）：

- 现状是「抬起 anchor → 读穿过月台的真实走向 → 在真实里程处切开 → 两端用 smoothstep 窗口
  横移到 anchor」。窗口最陡处斜率 1.5·d/L。
- 要量的三件事：(a) 窗口内是否**新引入**了转角（改前改后对比逐顶点 deflection）；
  (b) 大位移站（jp 峰值实测约 130–159 m，東海道線/大阪）附近的曲率是否合理；
  (c) 多月台站与站群（§9.3）的进站边选择是否还对。
- **绝对不许**为了顺滑把月台点挪到轨道上。方向是反的：把线带到 anchor，从不反过来
  （`rail-network.js` 注释已写明理由：拓扑锚点与渲染锚点必须是同一个点）。

### 阶段 3 · 四种拓扑各自的不变量

改动可以是全局的，**验收必须分拓扑**。每类给出改前/改后的数字。

**3.1 支线（branch）。** lead-in 是干线顶点的**字面拷贝**。任何平滑对共享顶点必须产生
**逐点相同**的结果，否则共享段裂成相距几米的两条线。
验收：每条 branch stroke 在共享段与干线的最大距离 **= 0**（逐点相同），不是「< 1 m」。
现有保护是 `sharedVertexKeys` + `protectedKeys`；新加的平滑必须接进同一套保护，不能另起一套。

**3.2 环线（loop）。** 接缝（首尾同站）两侧的切线必须连续，平滑窗口不得跨过接缝造成开口或重叠。
验收：接缝处 deflection 与相邻顶点同量级；环长变化 < 0.1%。
已知坑：环线方向不能用几何反推（`canonicalLineSlice` 自报方向）。

**3.3 上下行分线（paired_alignment）。** jp 现有 15 条笔画：

```text
日本海ひすいライン-p1(unassigned) · 日豊線-p1(up) · 鹿児島線-2-p1(unassigned) · 鹿児島線-p1(down)
函館線-p1(down) · 上越線-p1(up) · 上越線-p2(up) · 中央線-p1(unassigned) · 奥羽線-p1(up)
東北線-p1(unassigned) · 東北線-p2(up) · 羽越線-p1(unassigned) · 羽越線-p2(unassigned)
東海道線-2-p1(down) · 北陸線-p1(down)
```

两条笔画必须**各自**贴各自的 bore，不得互相吸引。
验收：逐区间量两条的分离幅度（**点到线段**，不是点到顶点），平滑前后变化 ≤ 1 m；
已知刻度：笹子/新笹子 25 m · 倶利伽羅 40 m · 新子不知 124 m · 清水/新清水 840 m。
「哪条是哪条」照 `RAILWAY_ALIGNMENT_AUDIT_PROMPT.md` 阶段 B，别重判。

**3.4 站内轨道。** 见 2.5。验收用 `validate-station-render-anchoring.mjs`，
五国必须保持 0 WARNING / 0 ERROR。

### 阶段 4 · 平滑：三个可能根因，分别判定

**不要先选算法。** 先把「尖」分解成三种，各自报数：

- **(a) 包几何自带的折角**（N02 顶点噪声）：逐顶点 deflection 配两侧边长。
  折角集中在**短边**（<30 m）就是数字化噪声，属于 `smoothMicroKinks` 的射程但阈值没盖住。
- **(b) 低 zoom 的假尖角**：同一个顶点在 z14 与 z8 的**屏幕**夹角差。
  geojson-vt 的 `tolerance: 0.5` 是瓦片像素，低 zoom 抽稀会把缓弯抽成折线。
  tw 曾经的低缩放尖角就是这一类（`tolerance:2` 解决，资料本身没有假尖角）。
- **(c) 缺圆角**：真实曲线被离散成平均 70.8 m 的直边，z15+ 每个顶点都是可见折点。
  量「目标 zoom 下相邻两边的屏幕夹角」，>3–4° 肉眼就能看出。

三者的修法互斥：(a) 调毛刺阈值、(b) 调渲染/LOD 参数、(c) 才需要真正的圆角管线。
**报了数才能动手。**

**4.1 方案必须落成 geometry profile，不是一个全局 tolerance。**
按 §12.1 分五档（`long_intercity` / `urban_standard` / `short_local` /
`dense_tram_or_light_rail` / `loop_or_reversing_complex`），判据字段照 §12.1 那张表（物理长度、
目标 zoom 屏幕长度、中位与最小站距、中位边长、junction 密度、曲率密度、分支/环数、
运输模式、街道运行与否）。现有的 `MICRO_KINK_SCALES` 只按中位站距分三档，是这件事的雏形，
可以升级但不得再按线路名硬编码。

**4.2 圆角上限必须满足 §12.2 的拓扑安全形式：**

```text
corner_radius <= profile factor × min(进边长, 出边长,
                                      到最近受保护站点距离, 到最近受保护 junction 距离)
```

**4.3 保护集合**（每条都要有独立测试）：站点锚点 · junction · 支线 lead-in 共享顶点 ·
paired alignment 两笔 · 环线接缝 · terminus · shared-edge boundary · structure 边界
（`line.structure` 的行段区间，桥/隧起讫）。§12 的禁止项照抄：不得平滑后重猜 junction、
不得每条 ServicePath 各自平滑同一条 PhysicalEdge、不得把 lane offset 烘焙进几何、
不得跨不兼容 transition 平滑、不得为视觉圆润改站序/分支/拓扑。

**4.4 至少三个候选算法做对比实验**，不许选一个直接上：

- **tw 的现成管线**（用不用取决于文首那个架构决定，**不是默认答案**）：`relax_polyline` → `round_polyline_corners`
  → `enforce_min_corner_radius`。它已经带着本仓要的两条性质 —— **每个顶点位移有硬上限**、
  **倒角半径由相邻边长决定**（正是 §12.2 那个公式的一个实现）。要做的是把它从
  `build-taiwan-rail-package.py` 抽进 `scripts/railway/lib/`，参数按 profile 给，而不是复制一份。
  注意它跑在**建包阶段**，而 jp 的毛刺去除跑在**渲染阶段**（`rail-network.js`）——
  先决定新管线落在哪一层，两层都放会违反 §12「每档 LOD 只算一次并缓存」。
- Chaikin（`geometry.py:94` 已有，hk/mo/kr 在用；每轮顶点 ×2，且会把曲线往内侧缩）
- Visvalingam–Whyatt（面积判据，视觉上比 Douglas–Peucker 顺）
- 铁路本征形状：直线–缓和曲线(clothoid)–圆曲线 拟合 / G1 Hermite 插值
  （真实线路就是这么设计的，理论上最贴，代价是实现复杂度）

每个方案报同一张表：**顶点数变化 · 里程变化(%) · 最大横向位移(m) · 20–45° 折角计数 ·
对 basemap 偏差中位数的影响 · 每类拓扑不变量是否守住**。
硬门槛：**里程变化 < 0.1%**，**最大横向位移 < 该 profile 的屏幕误差上限**。

**4.5 顶点预算。** jp 已有 385k 顶点，Chaikin 两轮就是 1.5M。必须报包体积与首帧时间的
前后对比。超预算就做 LOD 分档（低 zoom 少顶点、高 zoom 保真），不许靠牺牲高 zoom 保真度换体积。

### 阶段 5 · 开源调研（必须做，且必须落到「用不用 / 为什么」）

至少 **8 个**项目/库，逐个给：repo 地址 · 许可证 · 它解决的是上面哪个子问题 ·
**为什么适用或不适用于本仓**。不得把 GPL/AGPL 代码复制进本仓；借鉴算法与阈值可以，
但必须在代码注释里注明出处。

起始清单（**不是答案**，需要自己核实、淘汰、扩充）：

- **OpenRailwayMap** —— OSM 铁路标签模型与渲染约定：`usage=main|branch`、
  `service=siding|yard|spur|crossover`、`railway=abandoned|disused|razed` 生命周期前缀。
  阶段 2.3 的匹配过滤条件应该照它的定义写。
- **PostGIS** `ST_ChaikinSmoothing` / `ST_SimplifyVW` / `ST_SimplifyPreserveTopology` ——
  三种算法的参数语义与边界行为，是 4.4 的现成参照。
- **Turf.js** `@turf/bezier-spline`（Kochanek–Bartels）、`@turf/simplify`；
  **simplify-js**；**chaikin-smooth** —— JS 侧现成实现，注意它们都不保护拓扑。
- **d3-shape** `curveCatmullRom` / `curveBasis` —— 注意区分「渲染时的视觉曲线」与
  「改数据的几何曲线」，本仓需要的是后者（§12 要求 LOD 从同一 canonical edge 派生并缓存）。
- **地图匹配**：Valhalla Meili · GraphHopper Map Matching · OSRM `match` · fmm(Fast Map Matching)
  —— HMM 匹配，只对阶段 2.4 那类整体错位有用。
- **clothoid 拟合**：pyclothoids · Bertolazzi–Frego 的 G1 fitting —— 4.4 最后一个候选的实现参考。
- **MapLibre GL JS / geojson-vt** —— 确认 `tolerance` 的单位、与 `maxzoom` 的交互、
  `line-join: round` 与 `line-round-limit` 的实际行为。这是根因 (b) 的判据来源。
- **OpenMapTiles / planetiler** 的 `transportation` 层泛化规则 —— 解释底图在低 zoom
  为什么和我们对不上（合并要素、按 class 抽稀），避免把底图的泛化当成我们的缺陷。

可以再查：osm2pgsql 的 generalization、railway alignment reconstruction 相关论文、
GTFS shape 平滑工具。

### 阶段 6 · 实施顺序

1. 先修**贴合真缺陷**（阶段 2 判成「我们画错了」的），
2. 再做 **geometry profile + 圆角**，
3. 最后调**渲染参数**（tolerance / LOD）。

反过来做会用平滑掩盖错走向。每步单独 commit，每步都跑门禁。

**门禁（全量，不许挑着跑）**，在 `app/` 下：

```bash
npm test && npm run lint
node scripts/validation/validate-railway-topology.mjs
node scripts/validation/validate-station-render-anchoring.mjs
node scripts/validation/validate-basemap-alignment.mjs --strict
node scripts/railway/build-parallel-corridors.mjs      # 几何一变必须重跑派生表
```

- `EXPECTED_RENDER_HASH`（`app/scripts/railway/lib/render-snapshot.mjs:351`）只能在
  **写明理由**后单点更新；不得为了让测试通过去改断言。
- 已乘坐线路是同一套路径的切片（§7.5），几何一变必须确认已乘线跟随，并重跑
  `npm run precompute`（及 tw/hk/mo/kr 变体）确认产物一致或说明差异。
- 三个 `PYTHONHASHSEED` 各建一次，涉及重建的产物必须逐字节相同。

### 阶段 7 · 验收（不接受「看起来顺滑」）

给出改前/改后同一组表：

1. 五国转角分布表（六档）+ 顶点数 + 平均边长
2. 逐线里程变化，列出最大的 3 条并解释
3. basemap 偏差：中位 / p95 / 最大 · ERROR 与 WARNING 条数 · 新增 ledger 条目
4. 站点锚定审计：PASS / WARNING / ERROR
5. 拓扑审计：每个 code 的条数
6. 四类拓扑的不变量（3.1–3.4 的验收数字）
7. 包体积、首帧时间
8. 截图：至少 6 处 × z10/z14/z16 三档，必须覆盖
   —— 1 个支线分岔 · 1 个环线接缝 · 1 处上下行分线 · 1 个大站站内 ·
   1 处长隧道（底图粗的那类）· 1 处路面电车或短线。
   截图只用于确认，不用于推断。

**「地图上看着顺了」与「审计数字降了」是两件事，验收必须分开写。**
`tolerance: 0.5`（geojson-vt，单位是瓦片像素）与 `line-join: round` 会在低缩放吃掉一部分
尖角**观感**，而拓扑审计量的是**包内几何**。所以：第 1、5、6 项是几何指标，第 8 项是观感指标，
**不许拿观感的改善去抵几何指标没动**，也不许反过来拿审计数字下降就宣称观感已好。
根因 (b) 的修法只改观感、不改几何，报告里要标明它属于哪一列。

浏览器验证要点：console 条目会重复；地图在 pane 隐藏时加载会卡住；
先 `resize_window` 钉住宽高再 eval，否则可能读到 0×0；eval 拿到的 computed style 可能是旧值，
**截图才是真值**；隐藏 pane 上鼠标拖拽会超时，用 `RailMap._map.jumpTo` 移图再截图。

### 输出格式

```text
0 事实基线      转角分布 / 三件审计 / 顶点数与体积（改前）
1 贴合诊断      findings 总数 × 三类成因逐条 · 新增 ledger · 真缺陷清单
2 拓扑分类      支线 / 环线 / 上下行 / 站内 —— 各自的量与不变量
3 平滑根因      (a) 包内噪声 / (b) 低 zoom 泛化 / (c) 缺圆角，各自数字与结论
4 方案对比      ≥3 个算法 × 6 个指标的表 + 选型理由
5 开源调研      ≥8 项 × (repo / 许可证 / 对应子问题 / 用不用 · 为什么)
6 实施          逐 commit 的改动与门禁结果
7 验收          改前/改后对照表 + 截图清单
8 未解决        每条写明缺什么（缺来源 / 缺 OSM 数据 / 缺审计记录）
```

## 已知不是缺陷（不要重复报）

- **长隧道底图直弦**：青梅線 奥多摩–白丸（OSM way/219089831 只有 9 个顶点，1,120 m 直弦）、
  山陰線 梁瀬–上夜久野（way/526659788）等，ledger 13 条。底图粗的是它，不是我们。
- **新幹線隧道处的底图偏差** —— 底图错，勿改我们的几何。
- **站点锚定造成的 ≤20 m 系统性偏移** —— ゆいレール 实测约 18 m，50 m 门槛本就不报它。
- **志段味線 / 水害休止线** —— 已裁定。
- **阿里山線 神木/阿里山 的 180° 折返尾轨**（tw）—— 真 switchback，`reversalTails` 保护。
- **上越線 湯檜曽/松川ループ 的大转角** —— 真螺旋，摆幅 405°/492°。
- **常磐線 天王台–我孫子、中央本線 甲斐大和–笹子、あいの風 倶利伽羅–石動** ——
  见 `RAILWAY_ALIGNMENT_AUDIT_PROMPT.md` 末节的假阳性名单。
