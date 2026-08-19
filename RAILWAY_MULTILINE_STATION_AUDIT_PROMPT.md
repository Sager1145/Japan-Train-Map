# 多线车站 / 站台点位 / 底图轨道对照 审计 prompt

对日本铁路数据的**多线车站**审查「每条线的点是否落在自己的站台上」「该焊的是否焊成一个
实体 junction」「站前后是否沿底图同源的实体轨道」。规则本体见
[`RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md`](./RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md)
§R13/R14 与 §16；上下行分线与支线走向另见
[`RAILWAY_ALIGNMENT_AUDIT_PROMPT.md`](./RAILWAY_ALIGNMENT_AUDIT_PROMPT.md)。

**这不是一次从零开始的审计。** 发现、分类、验收的骨架 2026-08-18 已建成并入库，全量跑过一次。
本 prompt 的任务是：**修掉检测器的三个盲点 → 加上站域尺度的底图轨道对照 → 分批关掉 487 个
待人工判断的车站**。把下面「审计任务」整段交给 agent。

---

## 审计任务

你在关闭日本多线车站审计的剩余部分。**只报可复算的结论**：每条判定给出测得的数值、测法、
数据出处。没量过的写「未测量」，不要推断。地图截图是**最后**的验收，不是判据来源。

### 阶段 0 · 先读现状，不要重建已有的东西

已存在且**不要重写**的部件：

| 部件 | 路径 |
| --- | --- |
| 全量多线车站审计器 | `app/scripts/validation/audit-japan-multiline-stations.mjs`（663 行，导出 `buildAudit()`） |
| 其回归测试 | `app/test/japan-multiline-station-audit.test.mjs`（钉死 9039/880/fix_required=0） |
| 走廊尺度底图比对 | `app/scripts/validation/validate-basemap-alignment.mjs`（841 行，Overpass + 缓存 + 排除账本） |
| OSM 缓存（**已全量下载**） | `outputs/osm-basemap-cache/` 72 个 1° cell，118 MB，`out tags geom` |
| 站台/几何证据 loader | `build-japan-package-from-inventory.py` 的 `load_station_platform_corrections` / `apply_station_geometry_patches` / `assign_station_platforms` / `extend_display_part_at_platforms` / `apply_registered_shared_junctions` |
| 证据文件 | `app/data/raw/railway/jp/evidence/tokyo-station-platforms.json`（5 块：geometry_patches / platform_assignments / display_part_extensions / shared_junctions / surveyed_intervals） |
| 判定规则登记 | `.../evidence/multi-line-station-audit-rules.json` |
| 对照渲染 | `app/scripts/validation/render-japan-multiline-comparisons.mjs`（前后 SVG+PNG） |
| Apple 采集 | `plan-apple-capture-tiles.py` → `capture-apple-maps-checkqueue.py` → `overlay-project-geometry.py` |

先跑一次拿到基线，不要凭本文的数字工作：

```bash
node app/scripts/validation/audit-japan-multiline-stations.mjs
```

2026-08-18 的基线（`outputs/railway-audit/multi-line-stations/audit.json`）：

```text
9039 physical station groups → 审计 1258（多 display-line 880）→ 2442 个 line×station occurrence
关系 A 3 / B 41 / C 1036 / D 41 / E 552
FIXED_AND_VERIFIED 3（東京 003766・札幌 000227・日暮里 003417）
VERIFIED_NO_CHANGE 768 · NEEDS_HUMAN_PLATFORM_REVIEW 487 · FIX_REQUIRED 0
（2026-08-18 车道机制移除后重跑：审计范围收敛到 880 组，NEEDS_HUMAN 480，FIX_REQUIRED 仍为 0）
```

**487 就是这次要关的活。** 它们几乎全是同一条：576 个线对「independent or vertically separated
lines share one source point」——C 类换乘线与 E 类垂直分层线共用一个 N02 源点。另有 13 条是
D 类 paired alignment 方向 unassigned（那是**缺来源**，按 `RAILWAY_ALIGNMENT_AUDIT_PROMPT.md`
阶段 C 处理，不要当几何缺陷修）。

> **2026-08-19 执行状态**：阶段 1、2、3 全部落地并入库，门槛按实测校准。
> 站台窄抓已完成（72 cell / 54 MB / **168,881 个站台**，`fetch-osm-station-platforms.mjs`），
> 站台选择与 `platform_pick_margin_m` 已接入审计。仍未做的是阶段 3.2 的
> **section-usage provenance**（要改正被并行会话占用的 Python 构建器），
> 以及阶段 4 起的证据登记与分批修复。
>
> **全量结果（2026-08-19 收敛后，2,164 个 line×station 实测）**：
>
> ```text
> 与底图一致                 1864    落在本线自己的站台上            55
> 终点站具名轨道未到车挡          36    整条线的系统性测绘差            24
> 地下段（底图近似，不迁就）       26    已裁决豁免（水害休止＋导轨巴士）      5
> 无贴合本线具名轨道的站台        17    立体叠置站缺层级               17
> 两候选站台判定分歧             2    无可认领轨道不做结论            17
> ── 真缺陷 ──
> 落在别的站台上（已指名）        16    站点悬空                     6
> ```
>
> **收敛过程本身是主要产出**：初版 `package_wrong` 113 条、`platform_pick_ambiguous` 57 条、
> `undecidable` 105 条，逐条查证后绝大多数是**检测器假象**，每一条都有实证反例：
>
> | 假象 | 实证 | 处置 |
> | --- | --- | --- |
> | 具名侧线被当非运行轨排除 | 高岡 城端線 站台股道 OSM 标 `service=siding` | 具名 siding/spur 算站台股道；yard/crossover 与无名侧线仍排除 |
> | 隧道段当缺陷 | 初台 离 京王線 隧道 27.9 m、离自己的 京王新線 隧道 75.3 m | 沿用已裁决：OSM 隧道是近似连线，**底图错** |
> | 共用站被判「悬空」 | 佐世保 松浦鉄道 的点站在 JR佐世保線 侧线之间 | 悬空判据同样接受具名站台股道 |
> | 终点站具名轨道未延伸到车挡 | 终点站进站中位 7.8 m vs 中间站 22.2 m | 进站合格则不算点位缺陷（**兜底**，不覆盖站台证据） |
> | 整条线系统性测绘差 | 清和学園前 36.5/29.4、三ツ屋 30.7/31.5、長町 42.9/45.0 | 站点偏移 ≤ 本线自身偏移+15 m 即非站点缺陷 |
> | 水害休止 4 线＋导轨巴士 | 厚狭 美祢線、夜明 日田彦山線、志段味線（OSM 记 `highway=bus_guideway`） | `station-basemap-exclusions.json`，只豁免分歧不豁免通过行 |
> | 站台候选「模糊」 | 57 条里 **47 条两个候选对是否贴合本线轨道结论一致**，模糊与结论无关 | 仅当次优候选会改变结论才记模糊 → 57 降到 2 |
> | 运营商／线名对不上 | Osaka Metro 的 OSM 运营商是 `大阪市高速電気軌道`、线名是 `Osaka Metro御堂筋線`，而包里是 `1号線(御堂筋線)`——归一化剥掉 `1号線` 后**剩一对括号** | 补括号剥离＋运营商别名（Osaka Metro／大阪モノレール／札幌市電／WILLER TRAINS）→ `undecidable` 105 降到 17，Osaka Metro 67 行中位 **2.1 m** |
>
> 途中发现并修掉一处**串扰**：具名侧线对「站点认领」该算，对「走廊有几股道」不该算——
> 否则侧线把股道数顶过 4，重复绘制从 4 处虚涨到 7 处（9,700 m）。两者已分开。
>
> 重复绘制：49 组关系 → **真重复 4 组 / 6,340 m**、人工 7、合法共轨 27。
>
> **批次 2（2026-08-19）**：新机制 `station_anchor_overrides`——只替换 N02 站台要素、
> **绝不移动 RailroadSection**（`geometry_patches` 会两个一起换，那需要我们没测过的替代轨道）。
> 证据由 `build-station-anchor-evidence.mjs` 生成，**只有目标站台落在本线具名轨道 25 m 内才写行**；
> 13 行落地，`wrong_platform` 16→8、`package_wrong` 6→3。两条自我否决：名古屋 西名古屋港線
> 应用后 148.9→195.7 m **反而更差**（ref 14;15 是 JR 岛）已撤销；広島電鉄 宇品線 建了不 promote
> （移动 紙屋町西 会把线裂成干线+支线，属拓扑变化）。
>
> **一处自查漏掉、由并行会话抓到的回归**：批次 1 的 品川 选点让
> `高輪ゲートウェイ→品川` 从 0.837 km/12° 变成 1.294 km/**169°**。已撤销并 promote，
> 现为 838 m/10°。根因是 `validate-railway-topology` 的 `sharp_artificial_turn`
> 要求折点**两侧边都 ≥60 m**，而这里是 70 m 与 36 m，从缝里漏掉。
> 补救：审计新增**无边长门槛的 >90° 折点扫描**（`adjacent_interval_fold_degrees` 列），
> 全网 26 处 >120°，按站点网络的 `reversing_station`/`loop_station` 标签与
> paired_alignment 角色扣除后 **10 处待解释**。教训：构建器 NOTE 里的
> 「interval differs from audited distance」不是背景噪声，是待查项。
>
> **批次 1 已交付（2026-08-19）**：4 站 6 条显示线改用正确的官方 N02 站台要素
> （`evidence/station-platform-assignments.json`，loader 已泛化为合并 `station-platform-*.json`）。
> 岸里玉出 高野線 185 m → **1.2 m**、品川 東海道線 32 → 6.9、西船橋 総武線 24.2 → 11.0、
> 大阪 東海道線 23.5 → 2.1。**没有覆盖任何官方几何**——每条都是在 N02 已有要素之间改选。
> `PYTHONHASHSEED=1,2,3` 三建逐字节一致。
>
> **重要结构性发现**：N02 全网只有 **66 / 10,153** 个 (线, 站) 组合存在第二个站台要素，
> 所以「改选站台」这条便宜路径天生只覆盖极少数。241 条底图分歧里只有 6 条属于它，
> 其余 235 条要动就得像 東京 那样**登记制几何补丁覆盖官方测绘**——那需要逐站论证
> （東京 的依据是 N02 把两条新干线逐顶点抄重了，是可证的源级缺陷），不能成批做。
> `scripts/railway/n02/dump-station-platform-features.py` 把这个区分做成了审计的
> `fix_class` 列。
> 门禁：`npm test` 230/230 · lint 干净 · topology jp 654 PASS / 3 WARNING / 0 ERROR ·
> station anchoring `--strict` 通过 · 多线审计 `fix_required` 0（900 组，509 待人工）·
> 重复审计 `--strict` exit 1（4 处未修，符合预期）。

### 阶段 1 · 先修检测器的四个盲点

不先修这四条，报告会**自我恭喜**：现在它 `fix_required=0`，但三个关键列没有信息量。

**1.1 `point_to_track_meters` 是恒等 0，不是「贴合真实轨道」的证据。**
它量的是站点到**本线自己画的 `display.parts`** 的距离，而站点就是从那条线上取的。
实测：2442 行**全部为 0**，最大值 0。测试里的 `≤0.5 m` 断言因此是自洽性检查，通过它不代表
点落在真实轨道上。发现条件里的 `station_point_to_track_offset` 也因此**从未触发过**
（scope_reasons 计数里根本不出现）。

必须新增**独立于本包**的指标（阶段 2 给方案）：

- `point_to_claimed_track_m` —— 站点到**该线认领的那条 OSM way**（不是任意 way）
- `approach_median_offset_m` —— 站前后各 500 m 的采样中位偏移
- `platform_pick_margin_m` —— 选中站台与次优候选站台的判据差

**1.2 C/E 类的 `suggested_point` 现在等于 `current_point`，是空列。**
`electedJunction()` 只对 `should_share_junction`（A/B）生效，C/E 走不到它。原 prompt 要求的
「建议点位」对这 487 个站**一个都没给出**。修法：给 C/E 增加**按站台的建议点位**——从阶段 2
的站台候选集取该线自己的站台中点，写进 `suggested_point`，并附 `suggested_point_basis`
（`osm_platform_relation` / `osm_platform_way` / `n02_second_station_feature` / `none`）。
没有候选就写 `none` 并把原因写进 `unresolved_reasons`，**不要**回填 current_point 冒充建议。

**1.3 发现条件第七条「相邻区间显示线与底图轨道明显不重合」尚未实现。**
实际触发过的 scope_reasons 只有四个（原第五个
`final_parallel_lane_applies_at_station` 随车道机制一并移除），且全部来自包内部（第六个 `station_point_to_track_offset` 见 1.1，恒不触发）：
`physical_station_group_on_multiple_display_lines` 880 ·
`canonical_line_boundary_or_interchange` 812 · `branch_or_terminal_topology_role` 651 ·
`sibling_display_strokes_meet_here` 72。
阶段 2 的指标必须**回灌成第六个 scope reason**（`station_zone_basemap_disagreement`），
否则「与底图不重合但只有单条线」的车站永远进不了审计范围。

**1.4 「同一条铁路被画了多次」现在完全不检查。**
`classifyPair()` 对同 `railwayIdentity` 的两笔只判 A/B，然后检查它们在车站处焊不焊得上；
**没有任何一条检查问「这两笔是不是在画同一条轨道」**。实测 日暮里–上野 一带（10 m 重采样、
点到线段）：

```text
東北線 三笔，railwayIdentity 同为 jp-jr-east-ueno-tokyo-through
  東北線-2  川口→東京   16.13 km
  東北線-3  田端→上野    3.45 km
  東北線-4  東十条→尾久   9.03 km
按 3 m 判据：
  -3 的 51.2% 长度落在 -2 的 3 m 内，最长连续 1.65 km
  -3 的 46.9% 长度落在 -4 的 3 m 内，最长连续 1.27 km
  -4 的 43.1% 长度落在 -2 的 3 m 内，最长连续 2.82 km
```

同一模式在 **赤羽** 复现（同一 railwayIdentity 三笔进框，框内 ±1.5 km）：

```text
東北線（无后缀）· 東北線-2 · 東北線-6   三笔同为 jp-jr-east-ueno-tokyo-through
  東北線-6 的 68.9% 框内长度落在 東北線 的 3 m 内，最长连续 1.02 km
  東北線   的 47.2% 框内长度落在 東北線-6 的 3 m 内
另有跨铁路一例：東北新幹線 与 赤羽線 有 240 m 落在 3 m 内（高架上下叠置，性质不同，见 3.5）
```

**3 m 不是複々線。** 列車線/電車線 实际相距 10–25 m 且全程平行；3 m 以内连续 1–2.8 km
只可能是这些笔画走了**同一条 N02 区段**——同一条轨道被抄了两三遍，渲染出来就是几条同色线
互相压着，每一条都不在真轨道上。修法见阶段 3。

### 阶段 2 · 底图轨道对照（本次新增的核心）

**2.1 为什么现有的走廊比对结构上抓不到站台选错。**
`validate-basemap-alignment.mjs` 量的是「到**任意**活跃 OSM 铁路 way 的最近距离」，门槛
**50 m 且持续 ≥150 m**。大站里十几股平行道彼此相距 5–15 m，画在**哪一股都 <10 m**；
站台选错的位移是 20–120 m、持续 100–300 m。两个条件同时不过门。
**结论：站台选错对现有比对是不可见的，必须另建站域尺度的比对，判据从「任意轨道」换成
「该线自己认领的轨道」。** 不要修改走廊比对的门槛去兼容——它的 50 m 是为站台锚定留的余量，
在 ゆいレール 全线标定过（max 17.6 m），收紧会满屏误报。

**2.2 数据来源：活轨缓存已全量在本地，站台需要第二遍窄抓。**

缓存已有（**不要重抓**）：72 个 cell、118 MB，东京 cell（`E139N35.json`）24,282 条 way，
标签含 `name`/`name:ja`/`operator`/`operator:ja`/`gauge`/`electrified`/`usage`/`service`/
`layer`/`bridge`/`tunnel`/`colour`——**足够按线路认领轨道**。

缓存**没有**的：查询是 `way["railway"~"^(rail|light_rail|subway|tram|monorail|narrow_gauge|
funicular|construction|disused|abandoned|razed)$"] … out tags geom;`，只取 way，
所以 `railway=platform`、站点 node、`public_transport=stop_area` relation **全都不在**。
必须补一遍窄抓，缓存到 `outputs/osm-basemap-cache/platforms/`（**必须在 `app/` 之外**——
`npm run lint` 会 JSON-parse `app/` 下每个 `*.json`）：

```text
[out:json][timeout:180];
(
  way     ["railway"="platform"]({{bbox}});
  way     ["public_transport"="platform"]({{bbox}});
  relation["public_transport"="platform"]({{bbox}});
  relation["public_transport"="stop_area"]({{bbox}});
  node    ["railway"~"^(station|halt)$"]({{bbox}});
  way     ["railway"~"^(station|halt)$"]({{bbox}});
);
out tags geom;
```

沿用同一套 cell/边距/断点续抓/双端点轮换/3 s 间隔（公共实例夜间 504 是常态，重试即可）。
可只对**审计涉及的 1258 个 station group 的并集 bbox** 抓，但按 1° cell 合并请求：
72 条查询比 1258 条快一个量级，且与现有缓存同键。

**2.3 way → line 的认领算法（禁止「取最近 way」）。**
对每条线在每个车站的前后 500 m，按下列**顺序**打分选出「该线的轨道集合」，
每一步都要把落选原因记下来：

1. `operator` / `operator:ja` 与包内 operator 匹配（含 東京メトロ↔東京地下鉄 这类同义表）；
2. `name` / `name:ja` 与 canonical line 名匹配（OSM 常用旧名/俗名，允许别名表，别名必须登记）；
3. `gauge` 与该线一致（1067/1435/762；新幹線 1435 与在来線 1067 并行时这一条单独就能分开）；
4. `layer`/`tunnel`/`bridge` 与包内 `structure` 行（kind 1=隧道 2=桥、layer）一致；
5. `usage`=main/branch 且 `service` 为空（`service=yard|siding|spur|crossover` 一律排除）；
6. 最后才用走向：way 长轴与该线在该站的进出切线夹角最小者。

只有 1–5 全部无法区分时才允许 6 单独决定，并把该行标 `claim_basis=bearing_only` 进人工队列。
**任何情况下不得按「离站点最近」认领**——大站里最近的那条常是渡り線或貨物着発線。

**2.4 站台选择与三个新指标。**
候选站台 = OSM `railway=platform` way/relation ∪ `public_transport=platform` ∪ N02 该站的全部
站台要素。排序判据：先按 2.3 的认领轨道**相邻**（站台长轴到认领轨道 ≤25 m），
再按站台长轴与线路走向夹角，最后才是距离。`ref`（番線）能对上就写进证据。

- `point_to_claimed_track_m`：站点到认领轨道的点到**线段**距离（不是点到顶点）。
- `approach_median_offset_m`：站前后各 500 m，按 30 m 重采样（复用
  `app/scripts/railway/lib/railway-topology.mjs` 的 `resample`/`createEdgeIndex`/
  `pointSegmentDistanceMeters`），取到认领轨道集合的中位数。
- `platform_pick_margin_m`：最优与次优候选站台的中点距离。**margin < 30 m 一律进人工队列**，
  因为并列站台在这个尺度上判不出来。

**已实现（2026-08-19）**：站台窄抓 `scripts/validation/fetch-osm-station-platforms.mjs`
（`nwr[railway=platform]` ＋ `nwr[public_transport=platform]` ＋ 站点 node，同一套 1° 网格、
断点续抓、双端点轮换；72 cell、54 MB、168,881 个站台、零失败），
站台选择 `pickPlatform()` 按 **贴合本线认领轨道 → 长轴夹角 → 距离** 排序。
`scripts/railway/lib/osm-basemap-cache.mjs`（带标签的 OSM 索引，
72 cell／137,858 条活轨，加载 0.7 s）＋ `station-track-claim.mjs`（认领）已接入
`audit-japan-multiline-stations.mjs`，新增列 `point_to_claimed_track_m` /
`approach_median_offset_m` / `basemap_verdict` / `claim_basis` / `claimed_osm_way_ids`。
**实测三个坑**：①OSM 站台股道的 name 常是 `線名;駅名;番線` 分号串，整串比对会让终点站假报
180 m；②站点远离本线具名轨道有两种成因——**悬空**（25 m 内无任何运行轨道）与**踩着轨道但
不是本线具名轨道**（如 日吉 站在 東急目黒線 的轨上，因为 新横浜線 从地下起步），后者靠站台
数据定案；③**站台贴合判据是平面的，分不开立体叠置站**：新大阪 東海道新幹線 因此被指到
在来線 的「1;2 番线」。修法＝该线不在地面时，要求候选站台自带 layer 标签才采信，否则记
`platform_level_unverified`（10 例）。**不拿平面证据去判立体问题。**

**2.5 门槛必须先标定再使用。** 跑全量之前，在三个已知正确的对象上标定并把数字写进脚本注释
（照 `validate-basemap-alignment.mjs` 的做法）：

- **ゆいレール 全线**：站台锚定造成的系统性偏移上限，实测 max 17.6 m；
- **東京**：`tokyo-station-platforms.json` 已登记 12 条 OSM 区间，是唯一有实测轨道的站；
- **札幌**：函館線两笔画共享 junction 的范例。

**已标定（2026-08-19，四条线逐站实测）**：

```text
                站点到认领轨道 中位/p90/max     进站中位 中位/p90/max
ゆいレール          3.1 /  5.0 /  5.5 m         1.7 /  3.9 /  6.6 m
山手線              3.8 / 12.2 / 13.3 m         2.7 /  5.9 /  8.7 m
東海道新幹線         2.4 / 17.1 / 91.9 m         2.4 /  9.2 /  9.3 m
函館線              3.0 / 18.1 / 27.7 m         2.7 / 13.0 / 22.7 m
```

据此定 **站点 25 m、进站中位 20 m**。原先猜的 10 m／15 m 太紧——p90 本身就到 12–18 m，
会把站台锚定模型自己报成缺陷，正是 2.5 警告的失败模式。函館線 的两个离群值
（站点 27.7 m、进站 22.7 m）**故意保留会报**：它们是第一批复核项，不是要调掉的噪声。

**2.6 排除账本。** 新建 `app/data/raw/railway/jp/evidence/station-basemap-exclusions.json`，
schema 照 `basemap-alignment-exclusions.json`，每条必须写「为什么是底图错而不是我们错」。
下列结论**已裁决，直接引用，不要重新调查**：

- 新幹線与长隧道 55 处 50–120 m 偏差：OSM 隧道是志愿者近似连线，**N02 更可信，底图错**；
- 水害休止 4 线 133 km（美祢線全线 / 肥薩線 八代–吉松 / 日田彦山線 添田–夜明 BRT /
  津軽線 蟹田–三厩）：OSM 已改标废线故底图不画，我们按 N02 画，**是产品决策不是缺陷**；
- ガイドウェイバス志段味線：OSM 记 `highway=bus_guideway`，铁路类比对必脱靶；
- 4 处真旧线位缺陷（福知山線 尼崎–塚口 / 筑豊線 折尾 / 飯田線 城西–向市場 / 奥羽線 赤岩）与
  奥羽線-p1 陣場 的粗 bore：已在走廊尺度立案，**不在本次范围**，别重复报。

**2.7 Apple 地图的位置。** Apple 只做**视觉签核**，不是坐标来源；坐标来源是 OSM way/platform
与 N02。采集需要 macOS「辅助功能」+「屏幕录制」两项权限，未授权就把 `apple_maps_result` 留在
`pending_dedicated_capture`——**不许把 N02 fallback 写成已核对**。当前基线 1256/1258 是 pending、
`osm_way_ids` 只有 12/2442 行有值，这两个诚实口径必须保住。

### 阶段 3 · 重复绘制检测（同一条铁路被画了多次）

**3.1 几何判据分档。** 一律点到**线段**，不是点到顶点（按顶点量会虚增约一半：
倶利伽羅 按顶点 180 m、按线段 40 m）。重采样 ≤10 m。

| 档 | 判据 | 处置 |
| --- | --- | --- |
| **duplicate** | 中位间距 ≤3 m 且连续 ≥200 m | 同一条轨道被画两次，必须改道或剪除 |
| **suspect** | 3–12 m 且连续 ≥200 m | 可能重复、也可能是真复线而几何精度不足 → 人工 |
| **parallel** | 12–40 m 全程稳定平行，且双方各有自己的站台 | 合法（複々線／貨物線／paired alignment），登记进账本 |
| **separate** | >40 m | 不同走廊，不在本检查范围 |

**已实现（2026-08-19）**：`scripts/railway/lib/duplicate-strokes.mjs` ＋
`scripts/validation/audit-duplicate-strokes.mjs`（`--strict`，报告落
`outputs/railway-audit/duplicate-strokes/`）。**关键修正**：单靠几何会把
`-p1/-p2` 这类**契约要求逐点重合的支线共轨**一起报掉（49 组关系里 27 组属此类）。
真正的裁决靠底图股道数——普通複線在 OSM 里就是 2 条 way，所以门槛是 **≥4 条
（两组独立复线）才算缺陷**，3 条进人工，≤2 条判为合法共轨。全网结果：
**真重复 4 组（6,340 m）**、人工 7 组、合法共轨 27 组。四组真重复正是
東北線-2/-3（2,290 m）、東北線-3/-4（2,210 m）、東北線/-6（1,340 m，赤羽）、
千歳線/-2（500 m）——即截图里 日暮里 与 赤羽 那两处。

**3.2 已实现（2026-08-19），且结论改变了修法。**
`scripts/validation/audit-section-usage.py` **只读推导**每条线骑在哪些 N02 区段上——画出的
区间本来就是区段几何的切片，逐顶点回配即可，**不必改那个被并行会话占用的构建器**，
而且对归档包同样有效。四对真重复的区段级确认：

```text
東北線-2 ↔ -3   共用 9 段 / 2,240 m      東北線-3 ↔ -4   共用 10 段 / 2,240 m
東北線  ↔ -6   共用 4 段 / 1,180 m      千歳線  ↔ -2    共用 7 段 / 1,060 m
```

**改道可行性（藤城線 式判据：盒内有没有没人用的本线区段）**：

```text
日暮里–上野   盒内 28 段，19 段已用，**未使用 9 段 / 5,374 m**（含 1,547 m 与 1,106 m 两段）
赤羽         盒内  8 段，8 段全用光，未使用 0 段
南千歳       盒内  9 段，9 段全用光，未使用 0 段
```

所以只有 日暮里 那一簇有官方轨道可改。但**现有证据机制表达不了这次改道**：

- `line-shape-overrides.json` 是**站级**的（main_path + 支线站序），指不到区段；
- 笔画几何＝站锚点之间的最短路，而 `platform_assignments` 的粒度是
  **每条源线路 × 车站一次**（`platforms[key][group] = chosen`，key=(line, operator)）——
  東北線-2/-3/-4 是同一条源线路的三个显示笔画，**无法各自锚到不同站台**。
  N02 在 日暮里 确有 2 个、上野 有 4 个 東北線 站台要素，材料是够的，缺的是机制粒度。

**结论：修这 4 处需要新增「按显示笔画（part）而非按源线路」的站台/区段偏好能力。**
那是有设计分量的构建器改动，不该在批次里顺手做。赤羽与南千歳 则连官方备用区段都没有，
要动只能走登记制几何。

**3.2 原始设计（保留作参考）：**
几何判据在站场里会被渡り線和着発線干扰。真正的判据是**两笔是否走了同一条 N02 区段**。
`TrackGraph` 已经知道每个区间走过哪些 piece（`self.source[piece] = (index, measure)`，
`_assemble()` 沿 `walked` 组装），只是没落盘。让 `build-japan-package-from-inventory.py` 输出
provenance sidecar（放 `outputs/`，**不能放 `app/`**）：

```text
outputs/railway-audit/section-usage.json
  line_id → [ { from, to, section_pieces:[…], parent_section_ids:[…], measure_range_m } ]
```

于是 duplicate = **两笔的 parent_section_id 集合交集非空，且交集里程 ≥200 m**。
这是集合运算，没有阈值争议，也骗不过——複々線 的两条股道在 N02 里**本来就是不同区段**。

**3.3 修法顺序：不要一上来就删笔画。**

1. 先问**这一笔该不该存在**。三笔 東北線 分别是 列車線 / 電車線 / 尾久経由，**都该存在**；
   缺陷是其中两笔被路由到了同一条区段上，不是笔画多余。删掉任何一笔都会丢掉一条真实线路。
2. 该存在 → **改道**：把被抄的那一笔重新路由到它自己的 N02 区段，或在
   `rebuild-inventory/evidence/line-shape-overrides.json` / 站台证据里登记正确走向。
3. 确属冗余 → 剪除，并**在测试里钉住防复活**，照 `函館線-4` 的先例
   （`japan-multiline-station-audit.test.mjs` 已有该断言）。
4. 两种情况都要重跑几何与 stats：重复笔画会让同一条铁路在图上被画两三遍，
   叠成一条粗线，读者看不出哪条才是真轨道。

**3.4 全网扫描，不要只修截图里那一处。**
对**同 `railwayIdentity` 的所有笔画对**和**同 operator+name 的所有笔画对**全量跑，
按「重复里程」降序输出。日暮里 的 東北線 只是最显眼的一例，不是唯一一例。
把结果回灌成第七个 scope reason（`same_railway_drawn_twice`）——**已实现**，
并且是按**重合发生的那一段**（±600 m）标记车站，不是按整条线：東北線-2 长 16 km 而只重复
2.3 km，按线标记会把它每一站都拖进来。当前命中 8 个车站：日暮里・西日暮里・田端・上野・
鶯谷・赤羽・北赤羽・南千歳。

**3.5 已知合法，不要报。**

- **複々線**（線路別/方向別）：常磐線 天王台–我孫子、東北線 電車線/列車線——相距 10–25 m 且各有站台。
- **paired alignment**：湯檜曽/土合 两个站台相距 73 m 是要画的事实。
- **単線環状一圈经过两次**：ディズニーリゾートライン 1,340 m、ユーカリが丘線 883 m。
- **貨物線／連絡線 与本线并行**：梅田貨物線 3,427 m、白新線 東新潟–大形 2,053 m。
- **垂直叠置的共线走廊**：赤羽 的 東北新幹線 与 赤羽線（埼京線）同一高架上下层，实测有 240 m
  落在 3 m 内——**几何重合是真的**，两条是不同 railwayIdentity 的不同铁路，不能当重复剪除。
  判据是 `railwayIdentity` 不同**且** `structure` 的 layer 不同，归 E 类，不进 duplicate 名单。
  （屏幕平移已移除，这类叠置就是照实画；要分开只能靠各自真实的高程/平面差。）

### 阶段 4 · 证据登记（扩展现有 loader，不另起炉灶）

**3.1 一律先写 evidence 再 build，禁止直接改 `app/public/rail/jp-2025.json`。**
人工判断进证据文件，几何由构建器产出。

**3.2 复用 `tokyo-station-platforms.json` 的五块 schema。**
它已被 `build-japan-package-from-inventory.py` 消费，且并行会话已在其上扩展过
`display_part_extensions` / `shared_junctions` / `surveyed_intervals`。要全国化时：
**泛化文件名与 loader 的输入列表**（例如 `evidence/station-platforms/*.json` + index），
保持同一 schema 与同一段消费代码，不要新建第二条通路。

每条记录必须带：station group、涉及线路、精确 junction point 或站台点、`railwayIdentity`、
OSM way / platform relation id、`retrieved` 日期、来源 URL、判断理由。区间几何另记
line / from / to / role / osm_ways / coordinates / 来源说明。

**3.3 `n02_coords` 逐顶点匹配、失配即停机的安全性质不得放宽。** 这是几何补丁机制唯一的护栏。

**3.4 登记几何可按审计站序自动反转，不得复制一份反向数据。** 首尾必须与车站节点逐值闭合。

### 阶段 5 · A–E 分类与已知反例

分类逻辑已在 `classifyPair()` 里（D=paired_alignment → E=垂直/新幹線分离 → C=不同
railwayIdentity → A=同 identity 且两笔均以此站为端点 → 其余 B）。你要做的是**校核它的
E 类判定是否吃到了正确的 vertical**：`vertical` 来自 `structure` 行按里程 ±25 m 取窗口，
`kind=1` 判地下、`kind=2` 或 `layer>0` 判高架。窗口取空的站会退化成 `surface`——
对 487 个站逐个确认这一点，凡是 `structure` 无覆盖却实为地下/高架的，先补 structure。

判 A 类必须满足：一个真实 junction point、两侧区间逐值共享该点、同 `railwayIdentity`、
切线差 <5°、无立即折返。**两个恰好相同的站点坐标不算连续性。**

### 阶段 6 · 最终 render model 才是验收对象

从 `buildNetworkFromCompactPackage()` 读最终 `stations` / `segments` feature 核对，
不比较源坐标而已（现有审计已这么做，保持）。

**2026-08-18 起没有屏幕空间车道**：`line-offset`/`icon-offset`、包 `lanes` 表的渲染消费、
车道站台标记层与全部车道契约测试已按用户指令删除（规则文档 R14 已标废止）。
因此渲染坐标恒等于源坐标，验收项里**不再有 lane**：共享 junction 只看
「两侧区间逐值共享同一点、`railwayIdentity` 相同、切线差 <5°、无立即折返」。
两条线在图上叠住时判据是阶段 3 的重复绘制，而不是该把谁推开。

### 阶段 7 · 分批执行与并行会话协议

**6.1 分批。** 487 个站不可能一把梭。排序：涉及线路数降序 → 有 A/B 关系的优先 → E 类垂直分层
→ 枢纽客流。**每批 ≤25 站**，每批走完整一轮：写 evidence → build（staging）→ `promote-lines.mjs`
→ `recompute-package-derived.mjs`（stats+gzip）→ 全量门禁 → 记账。

**6.2 并行会话。** 本仓经常有多个 Claude 会话同时改同一批 evidence/staging。开工前
`git status` + 看 mtime；promote 前**备份 staging**（会被互相覆盖）；跨会话通报归属；
冲突裁决原则 = **「证据文件现行版 = 更晚明确意图」**。
保留工作区中与本任务无关的改动，不得 reset 或覆盖。

### 阶段 8 · 验收门禁（全部要跑，给出数字）

```bash
cd app && npm test && npm run lint
node scripts/validation/audit-japan-multiline-stations.mjs --strict
node scripts/validation/validate-railway-topology.mjs --country jp --strict
node scripts/validation/validate-station-render-anchoring.mjs --country jp --strict
node scripts/validation/validate-basemap-alignment.mjs --strict
```

外加阶段 2 的站域底图比对与阶段 3 的重复绘制扫描，两者都要有 `--strict`；
可以并进 `audit-japan-multiline-stations.mjs`，也可以各自成脚本，但必须进门禁清单。

2026-08-18 基线：`npm test` 272/272 · topology 657 线 651 PASS / 6 WARNING / 0 ERROR ·
anchoring 10209 PASS / 14 WARNING / 0 ERROR · 走廊比对当时 594/663 线 ≤50 m。
外加：

- 新增的站域底图比对 `--strict`（暖缓存下应是秒级，全量重跑免费）；
- `PYTHONHASHSEED=1,2,3` 各建一次，产物**逐字节相同**（R12）；
- 与上一次构建**逐线 diff**，站数/里程每一条变化都要解释，只该动你打算动的那几条；
- 特征值（render hash、站数、segment 数、徽章计数）变动要写明理由，
  **不得为了让测试通过而改断言**。

### 阶段 9 · 输出成果

沿用 `outputs/railway-audit/multi-line-stations/{audit.json,audit.csv,README.md}`，
在现有列（station_group / station_name / display_line_id / canonical_line / operator /
current_point / suggested_point / platform_track_layer / A–E / should_share_junction /
railwayIdentity / tangent / point_to_track_meters / osm_way_ids / apple_maps_result /
repair_status / unresolved_reasons / validation_errors）之外**新增**：

```text
suggested_point_basis        建议点位的依据枚举，无候选写 none
claimed_osm_way_ids          2.3 认领的轨道 way（与 osm_way_ids 分开：一个是认领，一个是登记）
claim_basis                  operator|name|gauge|layer|usage|bearing_only
platform_ref                 番線（能对上才写）
point_to_claimed_track_m
approach_median_offset_m
platform_pick_margin_m
basemap_verdict              agrees | package_wrong | basemap_wrong | undecidable(+理由)
duplicate_partner_line_id    与之重复的笔画（可多条）
duplicate_length_m           重复里程（几何档）与 shared_section 交集里程
duplicate_median_gap_m       重复段的中位间距
shared_parent_section_ids    源级判据：共用的 N02 区段
duplicate_verdict            duplicate | suspect | parallel | separate
```

四张名单照旧（已修复 / 无需修改但已验证 / 仍需人工判断 / 自动验收失败），外加改过的
evidence、构建器、测试文件清单与测试结果。截图用 `render-japan-multiline-comparisons.mjs`
扩展 station 列表产出前后对照（现有 東京 / 札幌 两组是范式）。

## 已知不是缺陷的（不要重复报）

- **東京 两新干线曾一点重合**：N02-25 把 東北新幹線 站区轨道与站台要素逐顶点抄成
  東海道新幹線 的（RailroadSection #16342 == #11932），已用登记制几何补丁修好，勿再动。
- **湯檜曽 / 土合 两个站台相距 73 m**：这正是要画的事实，不是要抹平的分歧。
- **函館線-4 重复笔画必须保持被剪除**：测试有断言。
- **札幌 两个轨道组锚点相距 208 m**：N02 站内区段的真实缺口，已记录未桥接。
- **走廊尺度已裁决的 5 类 finding**：见 2.6。
- **D 类 13 条 paired alignment `unassigned`**：缺方向来源，不是几何缺陷。

## 已知缺陷但缺资料，不是几何问题

- **仁山駅** 不在 2026-08-13 审计资料里，画不出来。
- **中央線 勝沼ぶどう郷–甲斐大和** 分离有据，但 N02 在那两站只存一个站台，检测器不会报。

## 陷阱速查

- `npm run lint` JSON-parse `app/` 下所有 `*.json` → **任何缓存都放 `outputs/`**（已 gitignore）。
- Overpass 公共实例夜间 504／连接拒绝是常态；双端点轮换 + 退避即可。
- `pkill -f` 会误杀命令行含同名关键字的监控进程；`pgrep` 自匹配用 `[.]` 转义。
- Xcode 自带 python3 无 numpy/pyshp，需 `pip3 --user`。
- 做 UI 截图时：MapLibre 在隐藏 pane 上加载会卡死，鼠标拖拽/滚轮会超时——用
  `RailMap._map.jumpTo` 移图后再截图；train-map 服务器伺服 `_site` 快照，改源码要
  `build:static` 后 reload。
- Apple 采集脚本必须在 macOS 本机跑，且需要辅助功能 + 屏幕录制两项权限。
