# 路径显示功能冲突审查与优化计划

审查范围：基础路线层 / 拾取车道 / 悬停高亮 / 悬停展开 / 选中线（casing）/ 日期 scope 淡化 / focus 加粗 / 车站圆点 / 显示设置滑杆 / 渐进导入 / zoomend 重建。

> **2026-07-06 平行显示重构（已落地）**：修复"悬停展开的平行线被切成小段/中间断开"。
> 根因一：重叠检测跑在每条 feature 各自 Douglas-Peucker 简化后的顶点上，共享同一段
> N02 轨道的两列车保留的顶点不同 → 段 key 只零星匹配 → 走廊被检测成碎片。
> 根因二：展开车道复用按 run 切碎的 pick 几何，相邻 run 偏移量不同时边界直接跳变。
> 重构后：`buildDeckOverlapMap` 在**原始（未简化）坐标**上做精确段匹配（共享集合
> intern 成唯一 Set 实例，run 边界按成员集识别，跨列车完全对齐）；
> `buildDeckRouteRecords` 返回 `{ records, expandRecords, groupInfo, spacingDeg }`
> —— base/pick 仍按 run 切（run 边界强制落在精确的原始顶点上）。
>
> **车道 = 刚性平移（用户要求）**：每个重叠组预计算一个恒定平移单位向量
> （组内规范方向的右垂线，sx 已按 cos(latRef) 校正为像素等距）+ 组内每列车的
> slot 居中倍数（groupInfo）。悬停展开时 railmap.js 把组内每列车的**完整路线
> 原封不动整体平移**到自己的车道——拐角、半径、长度完全不变，整条线一体移动、
> 永不断开；expand source 按组填充（悬停时才生成，成员几条线而已）。pick 车道
> 同样刚性平移，与可见扇形完全重合。true-track 在 0.35 淡入阈值后按 tid 整体隐藏
> （双向交叉淡入淡出，不闪、不双画）。zoom/pan 快路径只重乘新间距（~2ms）。
>
> **2026-07-06 悬停聚光（hover spotlight，P0 路径）**：悬停单条路线或展开的平行组时，
> 其余列车的线路、停站/通过站圆点（及端点站名标签）淡至 0.15 透明度，150ms GPU 过渡。
> 实现只走 `setPaintProperty` case 表达式（railmap.js `_applyHoverDim`，按 active-tid
> key 去重），hover 全程零 source 重建、零 record 重算。
>
> **2026-07-06 P1：点选列车零重建**：路由签名剔除 `sel:`，records 不再烘焙
> focused/focusBoost（选中加粗改由 SEL 图层的 line-width 表达式承担，
> `RailMap.setFocusBoost`；车道间距把 focusBoost 计入所有车，彻底与选中态无关）；
> 选中列车不再单独排序 tier（SEL 图层本就置顶）；`renderRoutesInView` 跳过与上次
> 完全相同的 setData 推送；overlap 图改用不含样式的独立签名（改颜色/线宽不重建
> 走廊图）。实测（89 班真实数据）：点选管线成本 ~600ms → **1ms**（缓存命中 +
> 零 source 重推），仅剩 SEL filter 切换与 marker 源更新。
>
> **2026-07-06 P1b：车站圆点零重建**：marker 与选中/缩放彻底解耦——
> ① records 不再烘焙 focused（选中圆点放大/描边加粗改由 SEL 圆点图层的
> `circle-radius`/`stroke-width` paint 表达式承担，`setFocusBoost` 联动）；
> ② alpha 改为 feature 属性走 `circle-opacity`（SEL 图层强制 1，跨日期选中照常
> 提亮，无需重建）；③ 两个 marker source 合一，选中切换 = 4 次 setFilter、
> 零 setData；④ 通过站 LOD 改为 pass 图层的 `minzoom`（跨越 z9 零重建）；
> ⑤ marker records 按路由签名缓存。至此**点选列车与缩放跨阈值在 JS 侧完全
> 零重建**：点选 = SEL filter ×6 + paint 若干；缩放 = 仅端点标签重排。

## 冲突清单

### C1（正确性，高）：重叠计数包含"不会显示的段" ✅ 已修复
`buildDeckOverlapMap` 遍历全部 items，但 `buildDeckRouteRecords` 会丢弃 opacity≤0 的记录（未乘坐段 `ride_segment=false` 一律隐藏；`dimOpacity=0` 时其他日期列车也被丢弃）。后果：×N 计数虚高、扇形与拾取走廊出现空车道、日期排序 slot 中混入不可见列车。
**修复**：建 overlap map 前按"该段实际会产生可见 record"过滤（ridden 且样式 opacity>0）。

### C2（性能，高）：overlap 图每次渲染全量重建 ✅ 已修复（签名缓存 + 视图变化仅重算偏移）
`cachedRouteItems` 有 signature 缓存，但 overlap map、走廊规范方向图、run 切分没有。每次选中列车、调显示滑杆、每次 zoomend 都跑 O(全部段数) 的 Map 构建 + 图遍历。
**修复**：overlap map/dirFor/run 边界与 `cachedRouteSignature` 绑定缓存；zoomend 只按新 `spacingDeg` 重算 n>1 runs 的 `pickPath` 偏移。

### C3（体验，低）：收拢瞬间双重绘制 ✅ 已修复（淡出至 1/3 处再恢复 true-track）
collapse 时立即恢复 true-track 过滤，扇形还在 160ms 淡出 → 同一列车短暂画两份。
**修复**：淡出结束后再恢复 base 过滤，或 base 与扇形交叉淡入淡出。

### C4（体验，中）：车站圆点拾取优先级打断车道滑动 ✅ 已修复（仅 hover 让位，click 保留圆点优先）
`queryAt` 先查 6px 内 marker：沿扇形滑动经过车站时 hover/tooltip 跳到圆点所属列车。
**修复**：展开状态下若 marker 列车 ∈ 展开集合，保持当前 route hover；或展开时 route 优先。

### C5（正确性，中）：车道间距的纬度/缩放漂移 ✅ 已修复（moveend/zoomend 按 ≥5% 漂移阈值刷新）
`overlapOffsetDeg` 用地图中心纬度换算 px→度。只重建于 zoomend：大幅南北平移后像素间距漂移（九州→北海道约 ±20%）；缩放动画期间固定 px 的 pickWidth 与固定"度"的偏移错位。
**修复**：moveend 且中心纬度变化超阈值时也重建；长期方案见 P3-2。

### C6（设计债）：dashed / 未乘坐段展示能力缺失
`routeSegmentStyleValues` 的 `dashed` 恒为 false 且未乘坐段整体隐藏；railmap 各层（含扇形 colorA）无 dasharray 通道。未来若要显示"计划未乘"段，overlap/扇形/拾取全链路都要补。

### C7（维护，中）：两套 overlap 实现并存 + 死文件 ✅ 已清理（删除 2 个死文件 + vendor/leaflet、vendor/deckgl + 约 140 行死路径）
`deckgl-routes.js`、`leaflet.polylineoffset.js` 已不被 index.html 引用；`splitForOverlap` 恒 false 使 `getRouteSegmentRecords` / `buildRouteOverlapMap` / `splitRouteFeatureIntoStyledRuns` / `getRouteOverlapInfoForKey` 不可达。旧 `buildRouteOverlapMap` 的 slot 排序（列表顺序）与新实现（日期排序）规则不同，易误导后续修改。
**修复**：删除死文件与死路径，或至少在旧实现处注明已废弃 + 排序规则差异。

### C8（性能，低）：hover 进出时扫描 records 求组内列车 ✅ 已修复（setData 预建索引）
`_setExpandedGroup` 每次 filter 全部 `_records`。
**修复**：`setData` 时预建 `groupKey → tids` Map。

### C9（性能，中）：渐进导入 O(N²) ✅ 已修复（120ms 合并渲染）
`appendTrainToLayers` 每导入一条即清缓存 + 全量 `renderTrainLayers`（含 overlap 图重建）。
**修复**：导入期节流合并（每 k 条或 rAF/idle 合并一次），结尾的权威 renderAll 不变。

### C10（体验，低）：自定义超宽线可盖住相邻车道 ✅ 已修复（间距 ≥ 最宽可见线 +4px）
车道间距 `max(3×DEFAULT_TRAIN_WEIGHT×scale, 12)` 只随全局 scale 缩放；`train.style.weight` 很大（如 ≥10）加 focusBoost 后线宽可超过间距，扇形互相覆盖。
**修复**：spacing 纳入当前可见列车的最大实际线宽（如 `max(…, maxWeight×scale+4)`）。

## 优化计划（按优先级）

| 阶段 | 项 | 内容 |
| --- | --- | --- |
| P0 正确性 | C1 | overlap 统计只含可见段 |
| P0 | C4 | 展开时 marker/车道拾取优先级 |
| P1 性能 | C2+C9+C8 | overlap/方向图/run 切分缓存化；zoomend 仅重算偏移；导入节流；groupKey→tids 预索引 |
| P1 | C5 | moveend 纬度阈值重建 |
| P2 体验 | C3 | 收拢期间双画消除 |
| P2 | C10 | 间距对最大线宽自适应 |
| P3 架构 | C7 | 删除死代码/死文件，统一 overlap 实现 |
| P3（可选） | — | 迁移到 MapLibre `line-offset`（像素级偏移，彻底消除纬度/缩放漂移；需按走廊规范方向预翻转每个 run 的坐标序） |
| P3 | C6 | 未乘坐/虚线展示能力补全（如有需求） |
