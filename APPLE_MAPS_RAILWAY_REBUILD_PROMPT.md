# Apple Maps 公共交通视觉铁路层重建 Prompt（现有架构对齐版）

下面整段内容可直接交给代码代理执行。

---

## 任务

在现有 `Japan-Train-Map` 仓库上重建和校正铁路与车站渲染，使整体视觉语言、信息层级和缩放行为尽可能接近 macOS「地图」App 的「大众运输／公共交通」视图，同时严格遵守本项目已确定的产品差异。

这不是从零设计新系统。先读代码、现有验证器、数据来源说明和既有审计输出；保留已经正确的机制，只修改有证据证明不符合下述契约的部分。

## 最终产品契约

以下要求优先级最高，不得用“Apple Maps 在某一档缩放不是这样”作为理由推翻：

1. 车站只使用位于铁路线上的圆点表示。
2. 车站圆点在任何缩放等级都不得变成 JR、地铁、运营商或线路 logo／徽章。
3. 不显示车站设施的淡蓝色填充、轮廓、站区面、站厅面或站台面。
4. 地图缩小时不得把多个车站合并成一个点、胶囊、数字聚合标记或共用站点实体。
5. 某缩放等级决定显示的每一个车站，其可见几何必须仍是圆点，且圆心落在最终显示的对应线路中心线上。
6. 允许沿用现有 `minz`／重要度规则，在低缩放时逐个省略不重要车站。这属于独立 LOD 过滤，不是站点合并。
7. 同一换乘站可以有多个对应不同线路的线上圆点；站名标签可以去重，但不得因此合并圆点或线路身份。

已确认并应保留的点样式：

- 单一铁路／线路车站：使用对应线路色的实心圆点。
- 换乘站：白色圆心、线路色描边的空心圆点。
- 若并行 lane 的点当前通过 MapLibre symbol 图标绘制，只要最终像素几何是纯圆点、无 logo、无文字，就符合要求，不必为了“必须是 circle layer”重写。

## 事实优先级

发生冲突时按以下顺序判断：

1. 本 Prompt 的最终产品契约。
2. 仓库当前真实代码、数据结构与可执行验证器。
3. macOS「地图」App 的公共交通视图实测截图。
4. Apple 官方文档能明确证明的功能行为。
5. 推测、旧报告或抽象设计术语。

不要把不存在于仓库的抽象模型当成现有实现，也不要要求先建设一套全新的站点、站群或拓扑架构。当前实现的关键概念包括：

- compact package 中的线路、parts／segments 与 station 数据；
- `railwayId`、有符号 `lane`、`stationLanes`；
- MapLibre 的 `line-offset` 与当前车站点渲染；
- `parallel-corridors.mjs`、`build-parallel-corridors.mjs`、`collapse-branch-services.mjs`；
- 现有 topology、station anchoring 和 parallel corridor 验证器。

先沿着这些结构解决问题。只有当前结构确实无法满足验收条件，并且有最小失败用例证明时，才允许引入新字段或新中间产物。

## Apple Maps 视觉核验要求

必须使用电脑上的 macOS「地图」App，并切换到「大众运输／公共交通」视图进行核验。不要把标准地图视图当成铁路视觉参考。

### 核验状态

每张参考截图必须满足：

- 未选中车站、线路或地点；
- 没有搜索结果聚合、搜索 pin、路线规划高亮或导航覆盖；
- 记录地点、比例尺或可复现的缩放档位；
- 区分底图设施面、交通线网层、文字标签和选择态覆盖物；
- 不把 Apple 的站区设施面误认为本项目必须实现的车站点样式。

### 地点覆盖

日本必须尽量覆盖不同规模、密度和运营形态，至少检查：

- 东京：東京、新宿、渋谷、池袋、上野、秋葉原、品川；
- 大阪／关西：大阪／梅田、新大阪、難波、天王寺、京都；
- 地方枢纽与乡村站：札幌、仙台、名古屋、金沢、広島、博多、小淵沢，以及至少 3 个普通单线小站；
- 并行密集走廊、地上／地下切换、支线汇入和多运营商换乘各至少 2 例。

台湾至少检查：

- 台北車站、板橋、南港、西門、忠孝復興、北門、高雄車站、左營；
- 台铁、高铁、捷运、机场捷运交会处及普通单线站。

香港至少检查：

- 紅磡、九龍塘、何文田、中環、金鐘、北角、屯門、元朗；
- 港铁重铁、机场快线／东涌线共享走廊、屯门轻铁网络和普通单线站。

澳门与韩国不要求承担主要 Apple 视觉研究样本，但必须进入代码和数据回归范围，不能漏检。

### 缩放覆盖

每类代表地点至少截取并比较以下层级：

- 区域级：只显示骨干网络；
- 都市圈级：线路和主要站开始可辨；
- 城市级：普通站逐步出现；
- 街区级：并行线、换乘点和线路标签可辨；
- 车站级：检查点是否仍在线上、是否出现不允许的 logo 或站区轮廓。

尽量记录地图显示的比例尺。不要以一次滚轮步进等同于固定 zoom 值；项目内自动化测试仍使用明确 zoom 数值。

### 已知观察与正确解释

- Apple 在缩小方向通常逐个省略车站点，不会把多个车站聚成一个数字或胶囊标记。
- Apple 在较高缩放可能撤掉线上点并改用运营商／线路徽章；本项目明确不采用该行为，始终保留圆点语法。
- Apple 会显示淡蓝色或蓝灰色车站设施面；本项目明确不采用该行为。
- Apple 的真实线位在低缩放可能粘连、交叉。本项目现有按屏幕像素保持可辨识的平行 lane 是有意的清晰度改进，不得仅为了“完全复制 Apple”而退回不可辨识的重叠线。
- Apple 的低缩放线宽和间距会变化。不要用“绝对像素永远不变”描述或测试本项目。

## 当前缩放契约

先检查 `app/public/railmap-style.js`、相关 tokens 和验证器，以代码中的实际数值为准。当前设计意图是：

- `railwayScale()` 使用以 zoom 为输入的 interpolate 表达式，这是必要且合法的 MapLibre 样式机制，不是错误。
- 约在锚点 `z7` 及以上使用完整视觉权重；更低 zoom 将线宽、间距、offset 和车站点按共同尺度缩小，最低约为完整权重的三分之一。
- 当前基准 token 大致为：车站点 7 px、铁路 3.5 px、gap 1.4 px。除非截图、可读性比较和回归测试共同证明需要调整，不要随意更换。
- 并行走廊的稳定性契约是比例稳定，而不是所有 zoom 下绝对像素值相同。

任何跨 zoom 的 lane spread、line width、gap 或 marker 尺寸比较，必须先除以 `railwayScaleAt(zoom)` 再比较。测试 zoom 至少覆盖：

```text
[3, 5, 8, 10, 12, 14, 16, 18]
```

不得设置“paint 中出现 zoom 就报错”的规则；不得把 z7 以下按比例缩小判为缺陷。

## 并行线与走廊契约

保留并验证现有原则：

- `railwayId` 表示需要独立显示的铁路身份；service／route 数量不等于需要独立 lane 的数量。
- 同一物理铁路上的分支服务不应仅因 route 不同而平移成多条平行线。
- 独立铁路共享走廊时可以分配有符号 `lane`，并通过 MapLibre `line-offset` 分离。
- 车站点必须使用与对应线一致的 lane／offset 计算。
- 分支、终点短枝和脱离共享走廊的部分应自然回到其正确中心线，不得生成悬空短线或车站引线。
- 屯门轻铁等多 route 共用物理轨道的网络，继续按现有 collapse 逻辑处理；不要按 route 数机械展开 lane。
- 不要仅因为 Apple 按真实线位绘制，就删除本项目的固定／成比例屏幕间距设计。

修改走廊算法前，必须先构造最小真实案例，证明现有 `parallel-corridors.mjs` 或构建阶段输出无法满足验收要求。

## 车站锚定契约

对每个可见车站点验证：

1. 圆点中心落在该站对应的最终绘制 railway part 上；
2. 若线路有非零 lane，点与线使用同一方向和同一 offset 语义；
3. 多线换乘站的各点分别锚定各自线路，不允许用跨 lane 胶囊或共用中心代替；
4. 圆点不得通过辅助 stub、引线或伪造短 segment“接回”线路；
5. 端点站和中间站的 LOD 可以不同，但不能改变站点身份；
6. 标签去重不得影响点的数量、位置或线路归属。

优先扩展 `validate-station-render-anchoring.mjs` 与对应测试，不要另写一套无法和现有输出对账的验证系统。

## 不显示车站淡蓝色轮廓

检查最终合成后的全部样式层，而不只检查铁路 overlay：

- 项目自有铁路层不得生成 station polygon、facility polygon、platform polygon 或淡蓝色 halo／outline；
- 如果底图样式自带此类车站设施面，应在本项目最终样式中按可识别 source-layer／class 精确过滤或重设为不可见；
- 不得用隐藏所有建筑、道路或普通 POI 的粗暴规则解决；
- 不得误删车站圆点的白心或必要描边；白心换乘圆点不是淡蓝色站区轮廓。

增加样式级测试，证明最终相关 layer 中没有可见的淡蓝色车站设施填充／描边。

## 不合并车站

检查数据构建、source 配置和运行时渲染三个阶段：

- station source 不得启用 cluster；
- 不得按屏幕距离、像素网格或 zoom 把不同车站合成新 feature；
- 不得生成带数量的聚合点；
- 不得把同名但不同线路位置的圆点合并成单一几何；
- 允许标签层对同一车站名去重；
- 允许通过每个独立 station feature 自己的 `minz` 在低缩放省略显示。

测试必须明确区分 `independent_lod_omission` 与 `station_merge`，不能因为低缩放少了部分点就自动报合并错误。

## 五国数据边界

必须覆盖 `jp`、`tw`、`hk`、`mo`、`kr` 五国／地区。先读各数据包的 `.sources.md`，遵守每个国家真实的数据来源和限制，不得把日本的字段或来源当成五国通用。

- 日本：N02 等日本数据只适用于日本；不要假设存在五国通用 N02 轨道图。
- 台湾：遵守现有官方来源契约；如果来源说明拒绝 OSM fallback，不得偷偷添加 OSM 回退。
- 香港：按现有官方 service／station 数据及已记录的几何来源处理。
- 澳门：即使视觉样本较少，也必须完成构建、schema、空值与回归检查。
- 韩国：按来源说明处理官方 station 数据和已记录的轨道几何来源，不得伪称全部几何都来自同一官方数据集。

若某国缺少实现次级视觉效果所需的可靠字段，应报告 `data_coverage_gap`，不能猜测、按名称硬编码或复制邻国规则。

## 两项次级 Apple 风格差距

完成圆点、无轮廓、无合并、锚定与缩放主契约后，再审计以下两项：

### 地下段虚线

Apple 公共交通视图在若干地点会以虚线表现地下段。先核对五国数据是否有可靠、逐 segment 的地上／地下属性。

- 只有可靠字段存在时才实现；
- 共享走廊中的虚线必须保持 lane、颜色、宽度与缩放比例一致；
- 不得把调试／跨日用的 dash 规则误复用为地下语义；
- 覆盖不完整时只实现可证明的范围并报告，不得按线路名猜测整条线路都在地下。

### 线路名沿线书写

Apple 会在部分缩放等级把线路名直接放在线上。先检查现有名称、语言、方向和冲突避让能力。

- 只在可读且不会遮挡车站圆点时显示；
- 名称沿线路方向放置，不能变成站点 logo；
- 共享走廊不能把多个名称堆在同一位置；
- 使用现有多语言字段和 collision 机制；
- 数据或布局证据不足时，记录为后续项，不得阻塞主契约验收。

## 执行顺序

### 1. 建立真实基线

阅读：

```text
app/public/railmap-style.js
app/scripts/validation/validate-railway-topology.mjs
app/scripts/validation/validate-station-render-anchoring.mjs
app/scripts/railway/lib/parallel-corridors.mjs
app/scripts/railway/build-parallel-corridors.mjs
app/scripts/railway/collapse-branch-services.mjs
app/test/railway-parallel-corridors.test.js
outputs/railway-audit/railway-audit.txt
outputs/railway-audit/railway-audit.json
```

同时查找五国 compact package、`.sources.md`、station layer、symbol/circle layer、`minz`、`stationLanes`、`line-offset`、`line-dasharray` 与 line label 相关代码。

### 2. 运行修改前验证

从仓库根执行：

```bash
cd app
node scripts/validation/validate-railway-topology.mjs
node scripts/validation/validate-station-render-anchoring.mjs --all
node --test test/railway-parallel-corridors.test.js
npm test
npm run lint
```

注意：`validate-railway-topology.mjs` 默认检查五国，不要给它传不存在的 `--all`。如果需要机器可读结果，使用脚本实际支持的 `--json` 用法，并保留到 `outputs/railway-audit/`。

记录修改前失败，不能把既有失败归咎于本次改动，也不能删除测试来获得绿色结果。

### 3. 建立 Apple Maps 截图矩阵

按本 Prompt 的地点和缩放要求操作 macOS「地图」App。报告中为每类行为选择代表截图，同时保留完整截图索引：

```text
country | city | station/corridor | scale | station glyph | line width | lane behavior | facility area | label behavior | notes
```

Apple 观察只用于判断视觉语言和发现差距。本项目明确的三项差异——始终圆点、不画淡蓝站区、不做 logo——不得被截图推翻。

### 4. 做最小代码修改

优先顺序：

1. 消除任何 zoom-to-logo 或非圆形站点分支；
2. 保证最终样式不显示淡蓝车站设施面；
3. 消除真正的站点 clustering／merge，同时保留独立 `minz` LOD；
4. 修正圆点与最终 lane 的锚定偏差；
5. 补齐 z3／z5 的成比例缩放测试；
6. 仅在数据可靠时处理地下虚线和沿线名称；
7. 不重写已经通过验证的 topology／corridor 机制。

### 5. 增补或更新测试

至少覆盖：

- `station_glyph_is_circle_at_all_zooms`
- `station_glyph_never_morphs_to_logo`
- `station_source_has_no_clustering`
- `station_features_are_not_screen_merged`
- `station_minz_is_independent_lod`
- `visible_station_center_matches_rendered_lane`
- `interchange_is_open_circle`
- `single_line_station_is_solid_circle`
- `station_facility_area_is_not_visible`
- `parallel_spread_is_scale_normalized`
- `parallel_zoom_levels_include_3_and_5`
- `labels_may_dedupe_without_merging_markers`
- 五国构建和验证均被实际执行。

错误代码继续使用仓库现有 snake_case 风格。能复用现有错误代码就复用；新增代码也用小写 snake_case，不建立第二套大写命名体系。

### 6. 修改后验证

重新运行全部基线命令，并另外运行所有新建或受影响的定向测试。若仓库提供本地地图预览，至少在日本、台湾、香港各完成：

- 一个高密度枢纽；
- 一个普通单线站；
- 一个共享／并行走廊；
- 区域、城市、街区、车站四类缩放。

对最终渲染截图做像素级人工复核：圆点形状、圆心在线、白心／实心语义、无 logo、无淡蓝站区、无聚合点。

## 验收条件

只有同时满足以下条件才可宣告完成：

1. 五国验证范围为 `jp, tw, hk, mo, kr`，没有漏掉韩国或澳门。
2. 每一个当前可见 station marker 都是线上圆点。
3. 任意 zoom 下都没有 station logo／badge 替换分支。
4. 最终地图没有淡蓝色车站设施填充或轮廓。
5. 没有 cluster、屏幕距离合并、数字聚合或跨 lane 胶囊站点。
6. 低缩放少点只能由独立 station `minz`／重要度 LOD 解释。
7. 换乘白心、单线实心规则稳定。
8. 非零 lane 的车站点与对应最终线路使用同一 offset。
9. zoom 比例测试覆盖 z3、z5 以及 z8–z18，归一化后稳定。
10. 现有 topology、station anchoring、parallel corridor 与完整测试没有新增回归。
11. 未通过伪造几何、隐藏错误、降低容差或删除断言来通过测试。
12. 地下虚线与沿线名称若实现，具有可靠数据依据；若不具备，已明确报告覆盖缺口且不阻塞主契约。

## 最终交付

输出：

1. 修改文件清单与每项修改目的；
2. Apple Maps 实测矩阵与代表截图索引；
3. 主契约逐条 PASS／FAIL；
4. 五国数据来源与限制摘要；
5. 修改前后测试命令、结果与新增测试；
6. 仍存在的数据覆盖缺口；
7. 地下虚线和沿线名称的实现状态；
8. 若仍有 FAIL，提供可复现地点、zoom、feature／railway 标识和最小失败证据。

不要仅提交一份理论审计报告。应在不破坏现有正确机制的前提下完成代码修改、测试和视觉验证；如果代码已经满足某条要求，应给出证据并保持原样。
