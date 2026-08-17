# 铁路数据、拓扑、列车路径与 Apple Maps 风格显示统一规则

> 本文是 `Japan-Train-Map` 的唯一统一检查与实施规范，可直接交给开发者或代码代理执行。
>
> 它同时约束铁路事实、物理拓扑、线路归属、列车服务、显示派生和 Apple Maps 风格视觉验收，但各层拥有不同的事实来源和决定权限。

---

## 0. 规范目的

对项目中的铁路数据进行逐国家、逐线路、逐物理边、逐分岔点、逐车站、逐相关列车行程和逐渲染层级的系统检查，并修正能够由现有证据可靠确定的问题。

必须同时达到：

```text
physically coherent
operationally plausible
topologically explicit
geometrically continuous
visually clean
stable across zoom levels
auditable
```

本规范不是要求为视觉效果重写全部系统，也不是允许以“保持现有架构”为理由保留已被证据证明错误的拓扑。实施原则是：

1. 先判定问题属于哪一层；
2. 再使用该层适用的证据和不变量；
3. 优先复用当前 compact package、`parts`、`segments`、`railwayId`、`lane`、`stationLanes`、`line-offset` 和现有验证器；
4. 概念分层和正确性不变量必须成立，但不强制一次性改写全部存储结构；
5. 只有当前结构无法表达已证明的正确结果时，才增加最小字段、适配层或中间产物；
6. 不得用通过旧验证器作为拒绝正确性修复的依据。

---

## 1. 规范用语与决定权限

本文中的关键词含义如下：

- **必须 / 不得**：验收所需的强制要求；
- **应该 / 不应该**：默认要求，偏离时必须记录理由和证据；
- **可以**：允许的实现选择；
- **显示层产品例外**：项目有意不同于 Apple Maps 的显示选择，只能覆盖显示层行为，不能覆盖铁路事实。

### 1.1 不使用单一的全局优先级

发生冲突时，必须先按问题类型分流。

#### 物理铁路、线路归属、服务路径或合法转向问题

```text
明确且有时点的权威事实
>
物理铁路和运营证据
>
项目中可追溯的原始数据
>
当前派生数据、代码和验证器
>
Apple Maps 宏观观察
>
推测
```

#### 显示产品行为问题

```text
本文第 16 节的显示产品契约
>
经确认的项目设计 token 和回归测试
>
Apple Maps 公共交通视图实测
>
当前偶然实现
>
推测
```

#### 视觉测量问题

```text
可复现的未选中 Apple Maps 截图
>
记录完整的人工测量
>
主观印象
```

当前代码是“实现基线”，不是铁路事实真值；Apple Maps 是“视觉参考”，不是股道级拓扑真值。

### 1.2 不可违反的关系

```text
Physical Junction
≠ Railway Membership Boundary
≠ Service Connection Anchor
≠ Station Routable Anchor
≠ Station Display Anchor
```

```text
Physical connectivity
≠ legal train transition
```

```text
Shared Physical Edge
≠ parallel physical track
≠ shared display corridor
```

```text
Railway Identity
≠ Train Service Path
≠ Display Identity
≠ Display Path
```

```text
Apple Maps screenshot
= visual evidence
≠ track-level topology authority
```

```text
existing test PASS
≠ proof that the tested invariant is complete
```

```text
unknown evidence
≠ PASS
```

---

## 2. 固定范围、版本和时点

任何 PASS、ERROR 或覆盖率统计前，必须记录：

```text
Validation Scope:
  country / region:
  package version:
  N02 version, if applicable:
  OSM extract timestamp, if applicable:
  official-data version:
  train service date or timetable period:
  Apple Maps capture date:
  included transport modes:
  included operating statuses:
  passenger / freight scope:
  display purpose:
  application commit / build:
```

### 2.1 五国数据边界

项目回归范围为：

```text
jp, tw, hk, mo, kr
```

必须先读取各数据包的 `.sources.md`。不得把日本 N02 字段、许可、覆盖率或分类方法套用到其他国家或地区。

- 日本：N02 可作为线路身份和线路级中心线的重要来源，但不是五国通用数据模型；
- 台湾：遵守现有官方数据来源契约；来源说明禁止 OSM fallback 时不得私自回退；
- 香港：按已有官方 service/station 数据和已记录几何来源处理；
- 澳门：即使视觉样本较少，也必须执行构建、schema、空值和回归检查；
- 韩国：分别记录车站和轨道几何来源，不得伪称全部内容来自同一个官方数据集。

某国缺少次级视觉字段时，输出 `data_coverage_gap` 或 `UNVERIFIED`，不得按名称猜测或复制邻国规则。

### 2.2 目标铁路和运营状态

不得把“来源数据中存在”等同于“当前仍运营且必须显示”。至少区分：

```text
active
temporarily_suspended
partially_suspended
under_reconstruction
closed
converted_to_non_rail
planned_or_under_construction
unknown_status
```

以及：

```text
passenger
freight_only
yard
siding
depot
industrial
test_track
heritage
non_target_mode
```

来源时点冲突时必须输出 `DATA_CONFLICT` 或 `UNVERIFIED`。

### 2.3 全量检查基线

日本 N02 范围应遍历：

```text
ALL canonical N02 railway identities within the declared Japanese scope
```

其他国家应遍历各自官方/项目规范来源中的全部 in-scope identity。

Canonical identity 至少包含：

```text
(country, operator, line_name, mode, source_version)
```

同名但物理独立的线路必须保持不同 identity 或不同且有解释的 component。

---

## 3. 六层统一模型

这些是强制概念边界；实现可以通过现有字段、派生索引或适配层表达，不要求立即更换全部文件格式。

### 3.1 Source Evidence Layer

保存原始来源、版本、时间、许可、字段和置信度。任何人工修正或例外必须能追溯到这里。

### 3.2 Physical Railway Layer

表示规范物理铁路中心线和可运行结构：

```text
PhysicalNode {
  id
  kind: station_anchor | junction | terminus | track_node | boundary_node
  geometry
  structure
  source
  confidence
}

PhysicalEdge {
  id
  from_node
  to_node
  canonical_geometry
  direction_capability
  structure
  operating_status
  source
  confidence
}
```

PhysicalEdge 是唯一拥有规范物理几何的对象。

### 3.3 Railway Identity Layer

表示正式或项目定义铁路对物理边的归属：

```text
RailwayIdentity
RailwayMembership {
  railway_identity_id
  physical_edge_id
  valid_from
  valid_to
  source
  confidence
}
```

一条 PhysicalEdge 可以有多个 membership；一个 RailwayIdentity 可以有多个有解释的连通分量。

### 3.4 Service / Train Path Layer

表示具体服务在特定日期按方向经过的物理边：

```text
ServicePath {
  service_id
  service_date
  ordered_directed_edge_ids[]
  stop_events[]
  pass_through_events[]
  line_transition_events[]
  reversal_events[]
}
```

ServicePath 可以跨 RailwayIdentity，但每次切换必须有合法 transition 和证据。

### 3.5 Semantic Station Layer

必须区分：

```text
station identity
station group / interchange group
platform or line identity
station routable anchor
station display anchor
label identity
transfer connector
```

允许站群和换乘分组；禁止因站群关系把多条显示线上的圆点合并成一个可见几何。

### 3.6 Display Identity / Display Path Layer

```text
DisplayIdentity {
  id
  source_railway_identity_ids[]
  network_display_group_id
  display_mode: infrastructure_network | route_identity
  product_role
  style
}

NetworkDisplayGroup {
  id
  member_display_identity_ids[]
  mode
  shared_style
  grouping_reason
}

DisplayPath {
  display_identity_id
  ordered_display_edge_refs[]
  zoom_visibility
  labels
}

CanonicalDisplayEdge {
  id
  source_physical_edge_ids[]
  canonical_display_geometry_by_lod
  resolved_signed_lane
  resolved_line_offset_by_zoom
  from_display_node
  to_display_node
  source_version
}

DisplayEdgeRef {
  canonical_display_edge_id
  traversal_direction: forward | reverse
  from_measure, optional
  to_measure, optional
}
```

现有 compact package 中的 `railwayId` 在渲染和 lane 语境下必须解释为 **Display Identity**。新代码和报告优先称为 `displayRailwayId`；如果为兼容仍保留字段名 `railwayId`，必须在 schema/source 文档中明确其显示层语义。

`NetworkDisplayGroup` 用于有轨电车、轻轨等支线和 route 数量很多、但概览图只需要表达基础设施网络的系统。它只控制显示去重，不合并 RailwayIdentity、ServicePath、方向、车次或合法转向数据。

`CanonicalDisplayEdge` 构成全项目唯一的渲染路径目录。全部线路、已乘坐线路、已乘坐行程、选中服务和调试高亮都只能通过 `DisplayEdgeRef` 引用这个目录，不能各自保存或重新生成一套路径坐标。

### 3.7 Rendered Feature Layer

最终 MapLibre 图层、圆点、线宽、casing、label、`line-offset` 和 LOD。该层只能从 DisplayPath 和站点显示锚点派生。

不同渲染层允许使用不同 filter、颜色、透明度、宽度、casing、排序和显隐，但同一个 `canonical_display_edge_id` 在相同 zoom/LOD 下必须解析为完全相同的：

```text
display geometry
segment boundaries
junction coordinates
traversal alignment
signed lane
line-offset
LOD selection
```

方向只决定坐标遍历顺序和事件顺序，不产生第二份几何。

### 3.8 禁止跨层污染

禁止：

- 用 Apple Maps 彩色服务线定义物理股道；
- 用 RailwayIdentity 终点代替 ServicePath 的下一事件；
- 用换乘 connector 作为列车轨道；
- 用 lane 偏移后的坐标覆盖 PhysicalEdge 或站点 routable anchor；
- 因显示线重合就断言物理共轨；
- 因物理共轨就强制所有显示身份完全重合；
- 为了让圆点“看起来在线上”创建 stub、引线或伪造短轨道。
- 为全部线路和已乘坐线路分别执行 map matching、拼接、snap、简化、平滑或 lane 计算；
- 在已乘坐记录中保存可独立漂移的完整坐标副本，而不是引用 CanonicalDisplayEdge。

---

## 4. 数据源的正确角色

### 4.1 N02（仅适用范围内）

主要用于：

```text
licensed railway existence at the source vintage
line identity and operator
station identity and station geometry
line-level centreline geometry
coarse and medium-scale topology
```

不得假定 N02 包含完整股道数、道岔转向权限、信号方向、站台级路径、当前服务状态或完整 structure 属性。

### 4.2 OSM

主要用于独立股道候选、平行轨道、站场和 crossover 背景、tunnel/bridge/layer、名称、route relation 和候选 Junction。

OSM 几何连通只证明连接候选，不自动证明列车可任意转向。

### 4.3 运营者资料和时刻表

主要用于当前运营状态、官方线路边界、服务日期、停站/通过站、方向、直通、折返和分支选择。

### 4.4 Apple Maps

主要用于宏观走向、视觉比例、颜色/casing/标签、缩放显隐和视觉连续性。

不得单独用于判断精确道岔位置、合法转向、共轨边界、单双线拓扑、正式线路边界或某车次的具体分支。

### 4.5 数据冲突格式

```text
DATA CONFLICT

Question:
N02 / country canonical source:
OSM:
Official / timetable evidence:
Apple Maps observation:
Current project:

Likely interpretation:
Confidence:
Reason:
Required manual decision:
```

不得静默选取最方便的数据源。

---

## 5. PhysicalGraph 和合法转向

RailwayGraph 在语义上必须是有向多重图：

```text
RailwayGraph {
  nodes
  physical_edges
  allowed_transitions
  railway_memberships
}

AllowedTransition {
  incoming_edge_id
  outgoing_edge_id
  direction
  status: allowed | forbidden | inferred | unknown
  source
  confidence
}
```

必须能够表达：

- 两节点之间多条平行边；
- 同一物理边多线路归属；
- 单向或方向受限边；
- Junction 的逐转向许可；
- 合法折返、环线和再次并入支线；
- 多连通分量；
- 换乘 connector 与运行 edge 的分离；
- 数据时点和运营状态。

当前实现若尚未持久化完整 AllowedTransition，可用派生表或验证适配层逐步实现；但 `unknown` transition 不得被判为 PASS。

### 5.1 构建顺序

```text
source geometries
→ canonical physical nodes and edges
→ duplicate / parallel / crossing classification
→ station routable anchoring
→ railway memberships
→ allowed transitions
→ service paths
→ display identities and paths
→ rendered features
```

禁止先平滑、lane offset 或视觉拼接，再反推物理拓扑。

### 5.2 几何相交不等于连接

以下情况不得自动连接：

- 不同高程的投影相交；
- 隧道与地面线、桥上与桥下；
- 无道岔的同层交叉；
- 长期平行轨道；
- 坐标误差造成的短重合；
- 站场内靠近但不相通的股道。

只有节点身份、structure、来源和转向证据共同支持时，才能建立可运行连接。

---

## 6. 线路形状、分支和 Junction

线路必须先按**拓扑形状**分类，再决定 vectorline、chain、LOD 和平滑方式。不得先套用一条 LineString，再根据失败结果猜线路类型。

顶层分类：

```text
ordinary_linear
branched
atypical
```

细分类至少包括：

```text
linear
terminal_branch
rejoining_variant
loop
loop_with_tail
reversing
disconnected
homonymous_independent
complex_network
topology_anomaly
```

分类必须由节点度数、cycle、edge traversal、Junction 数量、端点数量、站序和运营证据共同确定，并记录：

```text
top_level_shape_class
shape_subclass
classification_evidence
expected_endpoints
expected_junctions
expected_cycles
expected_reversals
confidence
```

只有显示、站序或人工审查需要时才定义 `primary_display_path`。它不自动等于官方主线，必须记录选择方法、来源和置信度。

分支进一步分类：

```text
terminal_branch
rejoining_branch
service_branch
railway_membership_branch
station_throat_candidate
parallel_track_candidate
disconnected_component
```

不得把站场多股道、上下行分离、会让线或短 crossover 自动分类成客运支线。

### 6.1 形状分类对应的 vectorline 规则

#### 6.1.1 普通型 `ordinary_linear`

仅当线路是没有需要独立表达的分支或 cycle 的连续链时，可以用一条 vectorline 串联全部有序车站。

必须满足：

- 从一个真实端点连续到另一个真实端点；
- 每个中间目标车站按正确站序出现；
- 不跳站、不重复 edge、不为串联车站产生回头；
- vectorline 中没有人为桥接的直线；
- 同一物理区间不因上下行重复两次。

#### 6.1.2 支线型 `branched`

可以用一条 vectorline 表达经证据选定的主链；每条 terminal branch、service branch 或其他 maximal non-branching branch 必须使用另一条独立 vectorline。分支多时允许多个较小 vectorline。

必须满足：

- 每条 branch vectorline 在真实 Physical Junction 与主链共享节点；
- branch 与主链共享 Junction，但不融合成一条会重复 edge、折返或跳跃的 vectorline；
- 主链不复制支线 edge；
- branch 不在 Junction 前后制造短重叠、悬空端点或连接引线；
- 每个支线车站只出现在正确 branch chain 上；
- `primary_display_path` 的选择不能删除非主线支线。

#### 6.1.3 异形 `atypical`

异形线路必须按图结构表达，禁止强制压成单一普通 vectorline：

- `loop`：保留闭合 cycle；不能人为切成两个伪终点，也不能重复闭环 edge；
- `loop_with_tail`：闭环和 tail 分成可解释的 chain，在唯一 Junction 相接；
- `reversing`：PhysicalEdge 保持真实结构，ServicePath 显式记录 reversal；显示网络不因折返重复绘制同一 edge；
- `rejoining_variant`：支线在第一个 Junction 分出、在第二个 Junction 再并入，主链与 variant 分别成 chain；不得把 variant 拼进主链造成回头或重复区间；
- `complex_network`：按 maximal non-branching chains 和 cycle 分解，不使用“最长一条线覆盖全部”的策略；
- `disconnected/homonymous_independent`：每个有解释的 component 独立保存，不用直线强接。

海鸥线一类带环状结构、九州横断一类具有折返运行、函馆线一类分支再次并入、迪士尼轻轨一类闭环线路，都必须进入相应专项回归；具体分类仍以目标时点的真实拓扑和服务证据为准，示例名称不能替代证据。

### 6.2 形状解析验证

每条线路必须输出：

```text
shape class
physical components
cycle basis / loop count
physical endpoints
service termini
junction list
reversal list
maximal non-branching chains
vectorline-to-edge mapping
station order per chain
unassigned or multiply-assigned edges
```

以下情况必须报错：

- edge 未分配给任何应显示 chain；
- 同一 edge 在基础网络中被无理由分配多次；
- branch 被吸收到主线并导致回头；
- loop 被错误打开或闭合；
- rejoining variant 只识别一个 Junction；
- reversing service 缺少 reversal event；
- vectorline 的相邻边不共享合法节点。

### 6.3 六种不同锚点/边界

必须区分：

1. Physical Junction；
2. Railway Membership Boundary；
3. Service Connection Anchor；
4. Station Routable Anchor；
5. Station Display Anchor；
6. Shared Physical Edge boundary。

Physical Junction 可以位于车站、站间、线路所或普通轨道上，不得为了方便移到最近车站。

Service Connection Anchor 是从 Junction 沿合法方向继续到达的下一停靠站、通过站、线路切换点、折返点或终点，不一定是最近车站。

### 6.4 Junction 不等于服务终点

```text
branch-specific edge
→ Physical Junction
→ shared physical edges
→ next service anchor
```

ServicePath 不得在 Junction 处提前停止；RailwayMembership 是否继续则必须按线路归属证据决定。

### 6.5 方向选择

```text
incoming directed edge
→ enumerate legal outgoing transitions
→ apply service and railway constraints
→ follow ordered directed edges
→ reach next service anchor
```

优先级：

```text
legal transition
>
service and line evidence
>
station / route-relation order
>
heading continuity
>
distance
```

Nearest station 不得作为唯一规则。

转角只作为告警：大于 135° 通常需要折返证据，但正式 switchback、终点折返、三角线和灯泡线允许大角度。必须区分 `reversal_expected` 与 `reversal_unexpected`。

---

## 7. Shared、Parallel、Duplicate 和 Display Lane

所有接近或重叠几何必须分类为：

```text
DUPLICATE_REPRESENTATION
SHARED_PHYSICAL_EDGE
PARALLEL_INDEPENDENT_EDGES
CROSSING_WITHOUT_CONNECTION
SHARED_DISPLAY_CORRIDOR_ONLY
UNKNOWN
```

### 7.1 Shared Physical Edge

多个服务或铁路身份真正共用物理区间时必须：

- 引用同一 `physical_edge_id`；
- 使用同一规范物理几何；
- 每个 LOD 只简化和平滑一次；
- 不分别拟合漂移的近似线；
- 允许不同方向和不同显示样式。

### 7.2 Display Lane

独立 DisplayIdentity 共享走廊时可以获得有符号 `signed_lane`，通过 MapLibre `line-offset` 分离。

- lane 是屏幕空间显示语义；
- 同一对线路不得在走廊中无故换边；
- 反向数字化必须在计算 lane 顺序前校正；
- station display marker 必须使用同一显示路径和 lane；
- lane 不得写回 PhysicalEdge、routable anchor 或原始 source geometry。

### 7.3 route 数不等于 lane 数

同一物理铁路上的多个 route/service 默认复用一个 DisplayIdentity，不得仅因 route 数量机械展开 lane。屯门轻铁等多 route 共用轨道的网络继续按经验证的 collapse 逻辑处理。

但这是一项显示产品策略，不是物理事实：若明确产品需求或可读性证据要求区分服务，可以建立额外 DisplayIdentity；仍不得复制 PhysicalEdge。

### 7.4 密集有轨电车／轻轨网络的基础设施显示模式

有轨电车、路面电车、轻轨和其他具有大量交织 route、短支线或双向服务的网络，默认使用 `infrastructure_network` 显示模式，不把每条 service 和每个方向分别画成平行线。

用户所说的“把所有线路的交集显示上”，在几何实现中必须明确为：

```text
NetworkDisplayGeometry
= union of all unique in-scope physical/display edges
+ deduplication of every shared/overlapping edge
```

即：显示所有唯一轨道区间的**几何并集**，而多条 route 的重叠交集只绘制一次。不得只保留数学交集而丢失各条支线。

对 `NetworkDisplayGroup` 中所有纳入显示的 route：

```text
network_edges = union(map_to_display_edges(route_1 ... route_n))
draw_count(edge) = 1, when route_multiplicity(edge) >= 1
```

必须满足：

- route 数量不改变同一 edge 的线宽、lane 数或绘制次数；
- 上行、下行和环线两个运行方向引用同一显示 edge，不生成方向 lane；
- 共用区间只画一条 network stroke，颜色使用该 NetworkDisplayGroup 的稳定系统色；
- 分支的唯一 edge 全部保留，因此网络覆盖不能因 collapse 丢失；
- route 编号、目的地和方向继续保存在 Service 层，可用于搜索、行程和选中态；
- 选中具体 service 时可以叠加高亮视图，但该视图必须引用同一 CanonicalDisplayEdge ids 和解析结果，不得生成高亮专用路径、永久复制基础网络或把两个方向并排显示；
- 方向信息应该通过列车位置、箭头、文字、事件顺序或选中态表达，而不是常驻双线；
- 不同运营系统只有在产品定义为同一 `NetworkDisplayGroup` 时才合并样式；否则保留不同系统身份，并只对真正需要区分的系统使用最少稳定 lane。

实际位于不同街道、不同走廊或具有显著空间分离的单向轨道，仍是不同 PhysicalEdge。它们不得在物理层错误合并；在城市/街区高缩放应保留其真实唯一几何，低缩放是否归纳成代表中心线必须由明确 LOD 规则决定。

#### 7.4.1 平面 Junction 的显示

有实际可运行连接的平面交叉口或分岔点，应显示为唯一轨道臂的拓扑并集：

```text
junction_arms = unique incident display edges at the Physical Junction
draw each arm exactly once
join all connected arms at one stable visible junction point
```

渲染要求：

- 所有真实且纳入范围的入口/出口方向臂必须到达同一个稳定 Junction；
- 内部节点使用连续 line join，不显示断头 cap、空洞、短 stub 或重叠粗结；
- 不按 route 枚举“直行、左转、右转”的每一种服务组合；
- 不为每个 AllowedTransition 画一条额外转弯弧；
- 若原始数据具有真实且在当前 zoom 可辨识的转弯轨道，可作为唯一 PhysicalEdge 显示，但仍只画一次；
- station marker 位于 Junction 附近时，仍按站点对应的 network edge 锚定，不用 marker 遮掩错误连接；
- round join/cap 只能改善像素连接，不能跨越无物理连接的方向臂。

#### 7.4.2 仅几何交叉而不连接

桥上/桥下、隧道/地面或无道岔交叉不得因显示 union 自动连接。此时：

- 两条唯一线都可见；
- 不共享 Junction node；
- 使用 structure/layer、casing 或绘制顺序表达上下关系；
- 路线求解不得在交叉点换线。

### 7.5 全部线路与已乘坐线路共用同一套路径信息

这是所有运输模式和所有显示模式的强制不变量，不只适用于有轨电车。

系统只能构建一份版本化的 `CanonicalDisplayEdge` 路径目录：

```text
CanonicalDisplayEdgeCatalog
  ├─ all-network view: set/union of DisplayEdgeRef
  ├─ ridden-history view: union of journey DisplayEdgeRef sequences
  ├─ selected-service view: one ordered DisplayEdgeRef sequence
  └─ debug view: references to the same edge ids
```

#### 7.5.1 同一来源、不同视图

全部线路显示和已乘坐线路显示只能有以下差异：

```text
included edge refs
draw order
colour / opacity / width / casing
visibility / interaction state
optional ridden count or recency styling
```

它们不得在以下信息上产生分叉：

```text
edge identity
path coordinates
junction position
segment boundary
branch choice
lane and line-offset
LOD geometry
station display anchoring
```

全网基础层先从目录取得全部 in-scope edge refs；已乘坐层再按用户行程记录取得同一目录中的 edge refs。已乘坐层不是第二套铁路数据，也不是第二次路线重建结果。

#### 7.5.2 行程记录格式

已乘坐行程至少保存：

```text
journey_id
service/date evidence, when known
ordered DisplayEdgeRef[]
catalog_version
```

方向相反时复用同一个 `canonical_display_edge_id`，只改变 `traversal_direction`。同一 edge 只乘坐一部分时，使用稳定的 `from_measure/to_measure` 裁切同一规范几何，不创建新的自由坐标 LineString。

原始 GPS、导入轨迹或旧坐标可以作为 Source Evidence 保留，但必须先完成一次可审计的 map matching，转换成 edge refs 后才能用于铁路显示。不得让原始轨迹直接替代规范显示路径。

`catalog_version` 不匹配、edge id 失效或 measure 超界时必须重新映射或标为 `UNVERIFIED`，不得静默回退到旧坐标。

#### 7.5.3 渲染一致性

相同 zoom、LOD 和 `canonical_display_edge_id` 下：

```text
resolve_geometry(all_network, edge_id)
=== resolve_geometry(ridden, edge_id)
=== resolve_geometry(selected_service, edge_id)
```

已乘坐/选中层应准确覆盖在基础网络的同一中心线上。需要同时看见底线和高亮时，只能使用宽度、透明度、casing、颜色或绘制顺序表达，不得给已乘坐层另加 lateral offset。

多次乘坐同一 edge 时，默认仍只画一次；次数、最近乘坐时间或完成度可以影响样式或属性，但不能复制几何。密集网络的基础设施 union 和已乘坐子集也必须引用同一批 CanonicalDisplayEdge ids。

#### 7.5.4 唯一允许的路径更新

若物理数据、Junction、lane 或 LOD 修复导致规范显示路径变化，应更新 CanonicalDisplayEdgeCatalog 并让所有视图同时读取新版本。不得只修全网层而留下已乘坐层漂移，也不得只修已乘坐层来掩盖基础路径错误。

### 7.6 支线和终点

支线离开共享走廊后应自然回到自己的中心线；终点短枝不得产生悬空线、伪造接回线或车站引线。

### 7.7 上下行走不同轨道（paired alignment）

有些复线区间两个方向走**物理上分离的两条走向**（別線線増），相距可达数公里。
N02 只以「同一车站存两个站台要素」暗示此事，**不带方向属性**。以下每条规则都是
在 上越線 / 日豊線 / 鹿児島線 / 北陸線 / 函館線 上先做错、再由实测纠正得出的。

**R1 分离幅度按点到线段量，不是点到顶点。** N02 隧道中心线顶点间距约 270 m，
按顶点量会把每对隧道虚增约一半间距。已知刻度：

```text
中央本線 笹子 / 新笹子      25 m   双洞，普通复线
北陸本線 倶利伽羅          40 m   同一条隧道的两个洞
日本海ひすいライン 新子不知  124 m   真 別線
上越線 清水 / 新清水      840 m   旗舰案例
```

阈值 **100 m**，落在最宽双洞与最窄真別線之间。它只是**前置筛**——没有来源，
两侧都不画。

**R2 分离段跨度是「共用站 → 共用站」。** 两条 bore 在**车站之间**分开
（上越線 在 湯檜曽 以南 117 m 进 新清水トンネル），而 compact-v1 没有
「首站之前的轨道」这个位置：`decodeIntervals()` 会把区间端点钉到站点行上
（`rail-network.js:734`），前置几何一定被抹掉。故起点取**两方向仍共用的最后一站**，
终点取会合站。代价是引入段两笔重合，这是双线区间的事实。

**R3 主线落在哪条 bore 上必须实测，不得推定。** 三次首猜两次错，一次是反的：

```text
上越線   主线原本画在上り线（湯檜曽–土合 7.529 km 对审计 3.493）
日豊線   猜 primary=up，实测 primary=down
鹿児島線 猜 primary=down，实测 primary=up —— 反的
```

判据：**从具名构造物自身的顶点量到两条笔画**，取近者。反过来（笔画→构造物）
会被笔画长度稀释，给出 543 m 对 577 m 这种无意义的结果。

**R4 运营方的「上り／下り」到本仓约定的映射逐线不同，且会反转。** 本仓约定
`down` = 站序前进方向。站序是运营方上り的线路（鹿児島線 八代→門司港、
奥羽線 青森→福島、北陸線 敦賀→米原）**必须换算**，照抄词面会把每次乘车判到错的股道。
每条证据行必须写明该线的换算。

**R5 分离有据 ≠ 方向有据。** 两个独立主张，两个独立来源字段：`alignmentSource`
（方向）与 `alignmentSplitSource`（分离）。只有分离有据时方向写 `unassigned`，
乘车匹配退回几何拟合，而不是被一个猜测带偏。

**R6 第二条 bore 的几何取自 OSM 时，必须按名字封掉另一条 bore 再路由。**
最短路**结构上就是新线那条**：直接跑最短路会把 松川ループ 整段返回成下り线，
并把 湯檜曽 螺旋抄近道剪成 120° 弯。只替换构建器已判定分离的区间；引入段保留 N02
以与主线**逐点重合**，换源即产生假平行轨。

**R7 螺旋按「沿线任意一段的最大连续转角」判，不按整段净转角。** 净值会互相抵消：
上越線 上り 净 −120°、实际摆幅 405°。门槛 上り >300°、下り <250°。

**R8 路由的两个端点必须取自同一连通分量。** 越後中里 的最近顶点属于
土樽越後中里停車場線 侧线，另一个分量 —— 由此产生的「无路径」是**假阴性**，
曾让 松川ループ 被误记为「OSM 没有上り股道」。

**R9 按名字排除无关线路的构造物。** 不排除则判据**无论真相如何都会给出答案**：
金谷川 旁 11.8 km 的是 東北新幹線 福島トンネル（会把 24 km 新干线隧道算到在来線笔画上）、
田原坂 旁 2,944 m 的是 九州新幹線 新田原坂トンネル、陣場 旁 3,177 m 的 矢立トンネル
是複線断面且在跨度之外。

**R10 「离车站多近」不能判定「是否同一条轨道」，两个分布重叠。**
佐世保線 的真服务边离 早岐 **334 m** 且确是同轨；旁通轨道可以离站 **75 m** 仍是另一条轨。
按距离排序在任何方向都不可能：放宽会丢真轨道，收紧会让重复绘制回来。要判同轨须问
**是否走同一条 N02 区段**，或直接问轨道图有无第二条边不相交的路径。

**R10b 別線 有两种形状，跳站型测不出也切不出。** 站台分离型（上越線）由 N02 第二个
站台要素暴露；**跳站型（函館線 藤城線 跳过 新函館北斗・仁山）两端各只有一个站台**，
该有两个的站根本不在线上。且**经过被跳站的路更短**（13.285 对 13.309），最短路永远
给不出它，跳站判据反而会报「runs past 新函館北斗」——而它自己的轨道离那站 2.9 km。
故跳站型必须在证据文件里**点名被跳过的车站**并在搜索中排除该站区段（`bypasses`）。
排除「第一条路径的全部区段」是错的：那会连两条走向**共用的接近段**一起封掉，
于是任何第二条路都不存在——这正是 藤城線 曾被误判为「N02 没有」的原因。

**R11 轨道组拆分点的车站属于两条笔画。** 拆分点就是岔口，岔口站两侧都要有——
否则**跨越边界的区间没人画**。札幌 因此丢了 桑園–札幌 1.314 km 干线且 函館 侧没有 札幌。

**R12 任何为顺序敏感用途迭代的集合都必须排序。** `longest_path()` 迭代
`near[node]` 集合，字符串哈希每进程随机化 → 主干走向每次重建都可能不同
（東海道線 与兄弟笔画互换 15 km）。等距叶子要按站号打破平局。
验收方式：`PYTHONHASHSEED=1,2,3` 各建一次，产物必须逐字节相同。

---

## 8. 全线路完整性与几何连续性

对每个 canonical RailwayIdentity 检查：

```text
missing_identity
missing_component
missing_edge
unexpected_component
unexpected_gap
wrong_endpoint
wrong_terminus
wrong_membership
invalid_merge
invalid_split
unexplained_duplicate_geometry
parallel_track_collapsed
crossing_connected
shared_edge_duplicated
station_anchor_missing
station_anchor_far_from_edge
status_mismatch
```

覆盖比较必须双向执行：

```text
canonical source → current project
current project → canonical source
canonical source → OSM, where applicable
OSM → canonical source, where applicable
```

RailwayIdentity 不要求单一 LineString。正确表示可以是一组有解释的 components、maximal non-branching chains、MultiLineString 或 feature collection。

相邻片段必须共享 canonical node，或拥有“同一真实节点的不同表示”这一明确证据后再 snap。单纯距离接近不得自动 merge。

Snap 必须记录原坐标、修正坐标、偏移量、理由、来源和置信度，并保证不合并平行轨道、不改变 AllowedTransition。

---

## 9. 车站、站群、换乘和终点

### 9.1 双锚点规则

每个站点至少区分：

- `routable_anchor`：位于规范 PhysicalEdge，用于图和服务路径；
- `display_anchor`：由最终 DisplayPath 和 lane 在渲染时派生，用于可见圆点。

Display anchor 可以在屏幕空间偏移；routable anchor 不得随 lane 改变。

### 9.2 每个车站的点位必须逐站验证

不得只抽查枢纽或按线路首末站推断中间站正确。每个 in-scope station/platform membership 都必须具有一条验证记录：

```text
station_id
station_group_id
railway / display identity
official/source point or platform geometry
candidate PhysicalEdges
selected routable edge and measure
display edge ref and resolved display point
distance to source station anchor
station order neighbours
selection evidence and reason
status / confidence
```

必须分别检查：

- 来源点/站台是否属于正确车站、线路、运营者和时点；
- routable anchor 是否位于该站实际可用的正确 PhysicalEdge；
- 前后站序是否沿合法路径连续；
- display anchor 是否位于同一 canonical display edge 的最终 lane/offset 上；
- 终点站、环线站、分支站、折返站和再次并入处是否被错误吸附到邻线；
- 同名邻站、平行线路和大型站场是否发生错线；
- 每个低置信度或超容差站点是否进入人工队列。

容差必须按来源精度、交通模式、站场规模、局部轨道间距和 zoom/显示目的声明。不得用一个足以跨越多条股道或相邻车站的全局大容差换取全绿。

若来源只提供站区 polygon，应该先派生线路相关的站台/站区 anchor；不得无条件使用 polygon centroid，因为它可能落在建筑、道路或错误股道上。

### 9.3 多轨道、多月台车站的进站边选择

大型车站存在多条轨道和多个站台时，先为指定 RailwayIdentity、ServicePath 和方向枚举合法候选 PhysicalEdge。候选必须：

- 属于或有证据服务于该线路/服务；
- 与进站和出站方向具有合法 transition；
- 不属于无关线路、车库、侧线或不可用站台；
- 能与前后业务锚点构成连续路径。

在合法候选之间按以下优先级选择：

```text
official platform / track assignment
>
service, direction and allowed-transition evidence
>
RailwayMembership and station/platform association
>
continuity with both neighbouring service events
>
distance to the line-specific station point, platform endpoint,
or station-boundary approach anchor
>
smaller heading change / straighter and smoother through movement
>
total distance
```

实现时应同时计算：

```text
entry_anchor_distance
exit_anchor_distance
source_station_distance
incoming_turn_angle
outgoing_turn_angle
combined_curvature_cost
path_length_excess
```

对于终点或只有一侧相邻事件的车站，优先选择最接近该线路站台端点/进站边界 anchor 且 transition 合法的进站 edge。对于通过站，优先选择从上一事件到下一事件更直、更顺、无异常横跳的合法 edge sequence。

“最近”或“更直”只能用于合法且线路匹配的候选之间消歧，不能覆盖官方站台分配、方向限制或转向禁令。若最佳候选之间证据接近、缺少股道资料或需要猜测，结果必须为 `UNVERIFIED`，不得静默选择最近线。

同一站不同线路可以拥有不同 routable anchor 和 display marker；同一服务的站点选择不得随 zoom 改变。

### 9.4 站群与“不得合并圆点”

允许：

- 同站名/换乘站的 semantic station group；
- transfer relationship；
- 标签去重；
- 无障碍或步行换乘 connector。

禁止：

- 把不同线路位置的圆点合并成一个可见 feature；
- 用同一个跨 lane 胶囊代表多条线；
- 把 transfer connector 当作列车可运行边；
- 用数百米直线把站点补成物理轨道。

### 9.5 四类终点

```text
physical_edge_terminus
railway_membership_terminus
service_terminus
display_chain_endpoint
```

它们可以重合，也可以不同。必须分别验证物理延伸、归属越界、服务穿越、平滑外插和显示切片结束。

---

## 10. 列车路径验证

所有列车路径必须从事件序列重建：

```text
event[i]
→ ordered directed PhysicalEdges
→ event[i+1]
```

事件包括：

```text
origin
passenger_stop
pass_through
line_transition
reversal
destination
```

必须检查：

```text
station_event_order
directed_edge_continuity
allowed_transition_usage
railway_membership_sequence
service_date_validity
branch_choice
shared_physical_edge_usage
unexpected_reversal
route_jump
terminus_violation
wrong_operator
wrong_mode
transfer_connector_used_as_track
```

Dijkstra 或 shortest path 只有同时满足以下条件才能 PASS：

1. 所有 edge 物理存在；
2. 所有 Junction transition 为 allowed，或具有明确证据的 inferred；
3. 服务日期和运行状态有效；
4. 线路/运营者约束一致；
5. 不使用 passenger transfer connector；
6. 不发生无记录折返；
7. 不因最近节点跳入平行线；
8. 路径长度和走向无异常。

使用 `unknown` transition 的路径最多为 `UNVERIFIED`。

---

## 11. 特急北斗专项验证

北斗必须绑定具体：

```text
service_date
train_number
direction
origin
destination
timetable_source
```

分别输出 passenger stops、pass-through stations、line transitions 和 reversals。

大沼—森区域必须明确：

- 使用函馆线主路径还是砂原方向；
- 分支选择是否由车次、通过站或运营资料支持；
- Junction 是否只是显示泛化；
- 是否发生无记录掉头；
- 是否被同名线路或最近节点算法引入错误分支。

Apple Maps 只能核对宏观分支形状。

不得用 `if line == Hokuto` 或类似单线路硬编码绕过通用拓扑问题。数据例外必须带 source、date、reason、confidence 和回归测试。

---

## 12. 几何简化、平滑与 LOD

只能处理 PhysicalEdge 的规范显示派生或明确 DisplayPath 派生。

每个 `CanonicalDisplayEdge` 的每档 LOD、lane 和 offset 只能在统一路径构建阶段计算一次并缓存；全部线路、已乘坐、选中服务和 debug 图层只能读取该结果，不能在运行时各自再做几何处理。

禁止：

- 平滑后重新猜 Junction；
- 每条 ServicePath 独立平滑同一 PhysicalEdge；
- 把 lane offset 烘焙进 PhysicalEdge；
- 跨不兼容 transition 平滑；
- 为视觉圆润改变站序、分支或拓扑。

必须保护：

```text
physical junction
physical terminus
railway membership boundary
station routable anchor
shared-edge boundary
visually relevant structure boundary
```

每个 LOD 必须从同一 canonical PhysicalEdge 派生，且不改变连通、路线选择、并行轨道归属、Junction 位置、终点和 shared-edge identity。

参数应考虑 target zoom、metres per pixel、局部长度/曲率/点密度、到 Junction/站点/终点距离和 structure，而不是只按整条线路总长设 tolerance。

### 12.1 按线路尺度和形状选择 Geometry Profile

不得让短小线路、路面电车、长距离干线和复杂环线无条件共用同一套细节、圆角、缩放和阈值参数。每条 DisplayIdentity/NetworkDisplayGroup 必须获得一个可追溯的 geometry profile，例如：

```text
long_intercity
urban_standard
short_local
dense_tram_or_light_rail
loop_or_reversing_complex
```

Profile 不能只按线路总长度判断，至少综合：

```text
physical/display length
screen length at target zooms
median and minimum station spacing
median edge length
junction density
curvature density
branch/cycle count
transport mode
street-running / separated alignment
```

每个 profile 必须分别定义并测试：

```text
simplification tolerance by zoom
maximum screen deviation
smoothing / corner radius bounds
snap and merge tolerance
minimum retained edge / branch length
junction and station protection distance
line and station minz / LOD thresholds
label spacing
minimum visible network extent
```

### 12.2 短小线路和路面电车的保护规则

`short_local` 和 `dense_tram_or_light_rail` 至少满足：

- 简化误差相对更小，不能删除一个站间区间、短支线、街角转弯或交叉口方向臂；
- 圆角/平滑半径必须受相邻 edge 长度、最近站点距离和最近 Junction 距离共同限制，不能跨过站点或把相邻两个转弯融成一个弧；
- snap/merge 阈值必须小于可分辨的邻近轨道/街道间隔，不能把平行街道或密集交叉口压成一个节点；
- LOD 不得只因全线短或屏幕长度小而整条消失；骨架、端点、关键 Junction 和独有支线应由拓扑重要度保护；
- 短 branch 不能套用长干线的最小长度过滤器；
- station marker 密集时可以逐站执行独立 LOD，但不能改站序、合并 marker 或改变线路形状；
- 基础设施 union、官方系统色和 Junction 单次绘制规则在所有 zoom 保持一致；
- 线路从低 zoom 出现到高 zoom 展开的过程中，不得发生 branch 突然换接、loop 开口、Junction 跳动或方向臂消失后接到错误道路。

圆角上限至少应满足以下拓扑安全形式，而不是使用无限制固定半径：

```text
corner_radius
<= profile factor × min(
     incoming edge length,
     outgoing edge length,
     distance to nearest protected station,
     distance to nearest protected junction
   )
```

具体 factor 和各 zoom 数值必须从实际代码、目标屏幕误差及 Apple Maps tile 审计校准，写入 profile 配置并由独立测试锁定。不得散落为线路名称硬编码。

### 12.3 长线路与短线路一致性边界

不同 profile 可以使用不同的简化、圆角和出现阈值，但必须继续共享同一个 CanonicalDisplayEdgeCatalog 和 PhysicalEdge 来源。Profile 只决定同一规范路径的 LOD 派生方式，不能改变站序、物理连通、branch identity、service path 或官方颜色。

---

## 13. Apple Maps 参考获取与证据边界

使用 macOS“地图”App 的“大众运输/公共交通”视图，不得用标准地图视图代替。

已有截图满足以下条件且捕获日期、位置和尺度仍适用时，可以复用；仅在截图缺失、状态不明、版本敏感或需要新增地点时强制重采集。

每张截图必须：

- 未选中车站、线路或地点；
- 无搜索聚合、pin、路线高亮或导航覆盖；
- 记录地点、日期、比例尺或可复现缩放档；
- 区分底图设施面、交通网络、标签和选择态；
- 标为 `visual_evidence`。

截图是 raster reference。像素检查适合视觉比例和最终合成结果，不适合推断精确 Junction 或 legal transition。

### 13.1 地点覆盖

日本至少覆盖：

- 东京、新宿、涩谷、池袋、上野、秋叶原、品川；
- 大阪/梅田、新大阪、难波、天王寺、京都；
- 札幌、仙台、名古屋、金泽、广岛、博多、小渊泽；
- 至少 3 个普通单线小站；
- 并行密集走廊、地上/地下切换、支线汇入、多运营商换乘各至少 2 例。

台湾至少覆盖台北车站、板桥、南港、西门、忠孝复兴、北门、高雄车站、左营，以及台铁、高铁、捷运、机场捷运交会和普通单线站。

香港至少覆盖红磡、九龙塘、何文田、中环、金钟、北角、屯门、元朗，以及重铁、机场快线/东涌线共享走廊、轻铁网络和普通单线站。

澳门和韩国必须进入数据与代码回归；若承担视觉结论，则补充代表截图。

### 13.2 缩放覆盖

每类代表地点检查区域、都市圈、城市、街区、车站五类尺度。自动化测试使用明确 zoom：

```text
[3, 5, 8, 10, 12, 14, 16, 18]
```

滚轮步数不得被记录为固定 zoom。

### 13.3 Apple Maps screenshot tile 必须全量逐个检查

“代表地点审查”不能替代存档 tile 全量审查。每次最终视觉验收必须先从各国 `.sources.md`、Apple reference `README.md` 和 manifest 确认原始参考根目录；当前至少包括：

```text
app/data/raw/railway/jp/apple-maps/tiles/
app/data/raw/railway/hk/rebuild-inventory/evidence/apple-maps-reference/
app/data/raw/railway/tw/rebuild-inventory/evidence/apple-maps-reference/
```

新增国家或目录后必须自动纳入。`out/`、`mosaics/`、calibration、cache 和本项目生成的 comparison render 默认不是 Apple 原始参考，除非 manifest 明确标记为 reference input。

#### 13.3.1 建立不可遗漏的清单

递归枚举所有被 manifest/README 声明为 Apple reference 的 `.png/.jpg/.jpeg/.webp`，为每个文件记录：

```text
reference_id
relative_path
sha256
country
width / height / device scale
capture date
theme
zoom or scale
centre / bbox / tile row-column
selection state
manifest source
valid / corrupt / metadata_missing
```

清单生成后冻结本次 `reference_inventory_hash`。审计期间新增、删除或改变的 tile 必须使审计失效并重新运行。

#### 13.3.2 每个 tile 的一对一比较

对清单中每个有效 reference tile，必须使用相同 country、bbox/centre、zoom/scale、viewport、theme 和像素尺寸生成项目 render，并逐张产出：

```text
Apple reference
project render
side-by-side image
aligned overlay / flicker pair
semantic difference masks
manual review status
```

底图供应商或字体不同时，不能以全图 raw RGB 差异作为唯一判定。自动比较至少分离或评估：

```text
railway coverage and macro alignment
official line colour / contrast
stroke and casing proportions
station point presence and anchoring
junction / branch / loop shape
parallel-lane and dense-network behaviour
facility-area exclusion
label density and collisions
zoom / LOD behaviour
```

每个 tile 必须单独打开或在可辨识分辨率的审查工具中逐张查看，并具有独立结果行。允许相同 checksum 复用自动测量，但不得从清单删除重复路径，也不得免除逐项状态确认。

#### 13.3.3 完整性门槛

```text
inventory_count
= PASS + WARNING + ERROR + UNVERIFIED + NOT_APPLICABLE
```

并且：

```text
missing_result_count = 0
unchecked_valid_tile_count = 0
```

只有清单覆盖率达到 100% 才能宣告 tile 审计完成。损坏、缺元数据、无法复现视口或未人工检查的 tile 必须分别标记 `UNVERIFIED`，不能从分母移除。

必须输出逐 tile CSV/JSON、失败队列、按国家/zoom/问题类型汇总，以及可跳转到原图、项目图和差异图的索引。平均分或代表截图 PASS 不得覆盖任何单 tile ERROR。

#### 13.3.4 证据边界

全量 tile 检查用于显示完整性和宏观走向；即使每一张 tile 都通过，也不能据此证明精确道岔、站台级轨道或合法转向。此类问题仍按物理/运营证据规则验证。

---

## 14. 当前样式 token 和缩放契约

`app/public/railmap-style.js` 是数值实现的唯一源，测试负责锁定经视觉测量确认的契约；本文不建立第二套独立 token。

目标全权重基准（2026-08-13 更新）为：

```text
station diameter: 6 CSS px
rail core width: 2.5 CSS px
rail core / station diameter: 5 / 12 ≈ 0.4167
station diameter / rail core: 2.4
parallel edge-to-edge gap: 1.2 CSS px
network casing edge per side: 0.6 CSS px
full-weight zoom anchor: z7
minimum scale: 1/3
```

`2.5 CSS px` 是全权重下的规范 core token，不是建议范围。当前实现中任何仍为 `3 CSS px`、或继续由 `stationDiameter × 0.5` 推导出的 rail core 都属于待修正旧值；实现、独立契约测试、验证器和来源说明必须同步改为 `2.5`，不得只修改本文。

此次减小只针对 railway coloured core：车站直径保持 `6px`，平行线 edge-to-edge gap 保持 `1.2px`，network casing 单侧保持 `0.6px`。因此车站相对线路更突出，并行线中心距在全权重下为：

```text
parallel centre distance = 2.5 + 1.2 = 3.7 CSS px
```

除非新的 Apple Maps 全量 tile 审计、可读性测试和产品决定共同支持，不得由单条线路或单个国家私自恢复较粗 core。无障碍/高对比模式如需加粗，必须作为显式主题 profile，不能改变默认 token。

如果代码和本文数值不同，以如下流程处理，而不是静默选一方：

1. 检查 `RAILWAY_STYLE`、`railwayScale()` 和契约测试；
2. 判断是经批准的视觉 retune、代码回归还是文档过期；
3. 同一改动中同步代码、独立断言、来源说明和本文日期/数值；
4. 保留 Apple 测量区间和代表截图证据。

`railwayScale()` 使用 zoom interpolate 是合法且必要的。z7 以下按共同尺度缩小，到下限后停止；z7 及以上保持全权重。

lane spread、line width、gap、casing 和 marker 尺寸的跨 zoom 比较必须先除以 `railwayScaleAt(zoom)`。稳定性要求是归一化比例稳定，不是绝对像素恒定。

不得设置“paint 表达式出现 zoom 就报错”的规则。

---

## 15. Apple Maps 风格指标

### 15.1 可量化指标

```text
railway stroke width
casing width
station-dot diameter
station-dot / line-width ratio
round cap and join
line colour and contrast
label density and collision
line visibility by zoom
station visibility by zoom
parallel display-lane spacing
```

每项记录 reference screenshot、capture scale、measurement method、measured range、project value 和 tolerance。

### 15.2 全部线路必须使用可追溯的官方颜色

每个 in-scope RailwayIdentity、DisplayIdentity 或 NetworkDisplayGroup 都必须具有一条 `OfficialColorRecord`：

```text
object_id
colour_scope: line | route | system | operator
official_name
official_colour_value
official_colour_space
official_source
source_date / valid period
dark-theme transform, if any
status / confidence
```

颜色来源优先使用运营者官网、官方线路图、官方 design/brand guideline 或官方开放数据。不得从 Apple Maps 截图、OSM 任意 tag、第三方百科或当前代码颜色反推“官方色”。这些只能用于发现差异或在来源冲突时辅助审查。

必须满足：

- 全部线路逐 identity 核对，不能只检查主要线路；
- 官方给出 RGB/HEX/色票时保存原值，不先经过主题变换；
- 官方只给名称或印刷色时记录转换方法、色彩空间和误差；
- light theme 默认直接使用经确认的官方色；
- dark theme 可以为对比度调整亮度/明度，但应尽量保持 hue 和 identity，记录确定性变换，并能够追溯回官方原色；
- casing、选中态和透明度可以变化，但线路 core colour 不得无理由改成相近色；
- 同名线路、运营者色和 route 色必须按官方适用范围区分，不能用运营者色覆盖已发布线路色；
- 来源时点不同导致颜色变化时按目标显示日期选择，并保留 valid period。

若 `infrastructure_network` 合并多条 route：

1. 有官方 system/network colour 时使用该官方颜色；
2. 没有 system colour、但所有成员共享同一官方色时使用共同色；
3. 成员具有不同官方 route 色且共享 edge 只允许绘制一次时，不得平均、混色或任意选择；必须输出 `DATA_CONFLICT`，由明确产品决定选择官方 system/operator identity，或调整 NetworkDisplayGroup 边界；
4. 无官方颜色时标为 `UNVERIFIED`，只能使用显式标注的临时中性色 fallback，不能伪称官方色或让 fallback 进入最终 PASS。

每次构建必须输出 official-colour coverage：

```text
official_colour_coverage
= identities_with_valid_official_colour / all_in_scope_display_identities
```

最终验收要求覆盖率为 100%；`DATA_CONFLICT` 和 `UNVERIFIED` 不计入有效官方颜色。

### 15.3 宏观审查

```text
continuous
smooth
clean
natural
no unexplained visual gaps
no unstable lane swapping
no artificial spikes
no visible route teleport
```

Apple 可能在高缩放以 logo 替代圆点、显示蓝灰站区面，并按真实线位造成低缩放粘连；这些观察不能推翻下一节的项目产品契约。

---

## 16. 最终显示产品契约

本节在 **显示层问题** 上优先级最高；它不得用于改变物理拓扑、RailwayMembership 或 ServicePath。

### 16.1 车站 glyph

1. 可见车站只使用位于对应最终 DisplayPath 上的纯圆点；
2. 任何 zoom 都不得变成 JR、地铁、运营商或线路 logo/badge；
3. 单一 DisplayIdentity 车站为线路色实心圆；
4. 多 DisplayIdentity 换乘点为白心、对应线路色描边圆；
5. 是否换乘按独立显示铁路身份计算，不能按同一铁路上的 service 数量计算；
6. circle layer 或最终像素为纯圆的 symbol 均可；不为图层类型重写正确实现。

### 16.2 圆点锚定

每个可见圆点必须：

- 中心落在对应最终绘制 DisplayPath 的中心线上；
- 使用与该线相同的 signed lane、方向和 offset 公式；
- 多线换乘时分别锚定各自显示线；
- 不使用 stub、引线或伪造 segment 接回；
- 不因 LOD 改变站点身份；
- 不把显示位置写回 routable anchor。

### 16.3 不显示车站设施面

最终合成样式不得显示淡蓝/蓝灰 station facility、station area、concourse、platform polygon 或 halo。

必须检查项目 overlay 和底图层。若底图自带设施面，应按已知 source-layer/class 精确过滤，不得粗暴隐藏普通建筑、道路或 POI。换乘圆点的白心和必要描边不属于设施面。

验收范围必须绑定已知底图 source/style 版本；无法检查的外部动态样式标为 `UNVERIFIED`，不得宣称所有未来底图绝对不存在此类面。

### 16.4 不合并可见站点圆点

禁止：

- station source cluster；
- 按屏幕距离、网格或 zoom 合成新的 station feature；
- 数字聚合点、胶囊或跨 lane 共用 marker；
- 因名称相同而合并不同线路位置的可见圆点。

允许：

- semantic station group；
- transfer graph；
- 标签层去重；
- 每个 station feature 依据自身 `minz`/重要度独立省略。

测试必须区分 `independent_lod_omission` 与 `station_merge`。

### 16.5 平行显示走廊

- `displayRailwayId` 表示需要独立显示的铁路身份；
- route/service 数不自动增加 lane；
- 独立显示身份共享走廊时可使用 signed lane；
- 点和线必须共享 lane 计算；
- 支线离开共享走廊后回到正确中心线；
- 保留跨 zoom 归一化稳定和不换边契约；
- 不为复制 Apple 的低缩放粘连而删除本项目的可读性分道。

### 16.6 密集分支网络与交叉口

对有轨电车、轻轨等 `infrastructure_network`：

1. 默认显示该 NetworkDisplayGroup 中所有唯一轨道区间的并集；
2. 共线 route 的共享区间只绘制一次；
3. 同一路径的两个运行方向只绘制一次；
4. route 和方向不产生常驻平行 lane；
5. 平面 Junction 显示所有唯一方向臂，并在同一稳定节点连续相接；
6. 不绘制每一种 service 转向组合形成的扇形、辫状或多重转弯线；
7. 立体交叉或无合法连接的相交线保持视觉相交但拓扑断开；
8. 选中 service 的高亮层必须可撤销，且不能改变基础网络几何。

此规则优先于“独立 route 可分配 lane”；只有不同 NetworkDisplayGroup 的系统身份确实需要同时辨识时，才允许最少数量的稳定 lane。

### 16.7 全网层与已乘坐层同源

无论显示全部线路、已乘坐线路、单次已乘坐行程还是当前选中服务，都必须引用同一个版本的 CanonicalDisplayEdgeCatalog。

- 全部线路层是 catalog edge refs 的全量/网络并集视图；
- 已乘坐层是同一 catalog 上一个或多个行程有序 edge refs 的并集视图；
- 选中服务层是同一 catalog 上的单条有序 edge-ref 视图；
- 同一 edge 在各层的最终 geometry、Junction、lane、offset 和 LOD 必须一致；
- 图层只允许改变样式、filter、排序、交互和显隐；
- 禁止为已乘坐层维护、下载或派生第二套铁路路径几何；
- catalog 更新必须同时作用于所有视图，并对旧引用执行版本检查。

### 16.8 LOD

地图缩小时可以逐站省略不重要车站，但不得聚合。被决定显示的 feature 必须仍为独立圆点。

---

## 17. 次级 Apple 风格功能

主显示契约完成后再处理以下功能，不得阻塞核心正确性。

### 17.1 地下段虚线

仅在具有可靠逐 segment structure 字段时实现。共享走廊的虚线必须保持 lane、颜色、宽度和缩放比例。不得按线路名猜测整条线路地下，也不得复用无关 dash 语义。

覆盖不足时报告 `data_coverage_gap`。

### 17.2 线路名沿线显示

仅在可读且不遮挡车站圆点时显示；使用现有多语言字段、线路方向和 collision 机制。共享走廊不得堆叠不可读名称。证据或布局能力不足时记录为后续项。

---

## 18. Validation 状态、置信度和错误代码

统一状态：

```text
PASS
WARNING
ERROR
UNVERIFIED
NOT_APPLICABLE
DATA_CONFLICT
```

- `PASS`：足够证据验证且满足规则；
- `WARNING`：结果可用，但存在非致命异常或低风险启发式；
- `ERROR`：违反明确证据或不变量；
- `UNVERIFIED`：证据不足，不能判对错；
- `NOT_APPLICABLE`：规则不适用于该对象、国家或层级；
- `DATA_CONFLICT`：来源间存在未解决冲突。

置信度：

```text
high | medium | low | unknown
```

错误代码统一使用现有小写 `snake_case`。不得为本规范另建大写错误命名体系。

---

## 19. 自动验证清单

### 19.1 Physical

```text
missing_geometry
invalid_coordinate
zero_length_edge
duplicate_edge_representation
unexplained_gap
crossing_connected_without_evidence
parallel_edges_collapsed
invalid_structure_crossing
unexpected_component
self_intersection_candidate
```

### 19.2 Identity / Membership

```text
missing_railway_identity
missing_membership
unexpected_membership
wrong_official_boundary
unexplained_disconnected_component
homonymous_lines_merged
display_identity_confused_with_railway_identity
shape_classification_missing
shape_classification_mismatch
ordinary_line_has_branch_or_cycle
branch_merged_into_primary_vectorline
branch_edge_unassigned
display_edge_assigned_to_multiple_base_chains
loop_opened_into_false_termini
loop_edge_duplicated
rejoining_variant_missing_junction
reversal_event_missing
vectorline_edge_discontinuity
```

### 19.3 Junction / Transition

```text
junction_missing
junction_moved_to_station
unknown_transition_used
forbidden_transition_used
unexpected_reversal
branch_stops_before_next_service_anchor
wrong_direction_candidate
```

### 19.4 Shared / Parallel / Lane

```text
shared_edge_duplicated
shared_edge_geometry_mismatch
shared_edge_smoothed_more_than_once
parallel_edges_marked_shared
pre_junction_overlap_marked_connected
display_lane_written_into_physical_geometry
unstable_lane_order
```

### 19.5 Station / Terminus

```text
station_identity_missing
station_not_anchored
station_anchor_too_far
station_validation_record_missing
station_source_position_mismatch
station_wrong_railway_or_platform
station_wrong_parallel_track
station_order_inconsistent
station_candidate_ambiguous
station_anchor_tolerance_excess
station_polygon_centroid_misused
station_entry_not_smooth_or_continuous
physical_connector_invented
transfer_connector_used_as_track
wrong_physical_terminus
wrong_membership_terminus
service_crosses_terminus
smoothing_extends_terminus
```

### 19.6 Service

```text
station_event_order
track_continuity
route_jump
wrong_branch
wrong_line
wrong_operator
invalid_transition
unexpected_reversal
shared_edge_not_reused
service_date_mismatch
```

### 19.7 Render

```text
visible_gap
sharp_artificial_turn
unstable_zoom_geometry
station_dot_off_display_line
station_glyph_not_circle
station_glyph_morphed_to_logo
station_features_merged
station_source_clustered
station_facility_area_visible
shared_physical_edge_visual_drift
excessive_screen_deviation
label_or_symbol_contract_violation
rail_core_width_contract_mismatch
dense_network_route_explosion
service_direction_duplicated_as_lane
shared_network_edge_drawn_multiple_times
network_union_missing_branch_edge
junction_arm_drawn_multiple_times
junction_route_turn_fan_rendered
junction_visual_gap
grade_separated_crossing_visually_joined
all_and_ridden_path_catalog_diverged
ridden_geometry_recomputed_independently
ridden_path_geometry_mismatch
ridden_path_lane_or_offset_mismatch
ridden_path_lateral_drift
ridden_reverse_direction_duplicated_geometry
ridden_partial_edge_freehand_geometry
display_edge_catalog_version_mismatch
geometry_profile_missing
short_line_uses_long_line_thresholds
short_branch_removed_by_lod
short_line_corner_overshoot
short_line_junction_collapsed
official_colour_missing
official_colour_source_unverified
official_colour_scope_mismatch
official_colour_transform_untraceable
official_colour_conflict
apple_reference_tile_missing_result
apple_reference_tile_unchecked
apple_reference_tile_viewport_mismatch
apple_reference_tile_metadata_missing
apple_reference_inventory_changed_during_audit
```

---

## 20. 必须具备的回归测试

### 20.1 数据和拓扑

```text
test_scope_and_source_versions_recorded
test_all_in_scope_canonical_identities_accounted_for
test_no_unexplained_missing_components
test_physical_edge_continuity
test_crossings_do_not_auto_connect
test_parallel_edges_not_merged
test_duplicate_representations_collapsed_safely
test_allowed_transition_required
test_unknown_transition_cannot_pass
test_expected_reversal_is_allowed
test_unexpected_reversal_is_flagged
test_terminal_branch
test_rejoining_branch
test_loop
test_loop_with_tail
test_reversing_line
test_homonymous_independent_lines
test_every_line_has_evidence_backed_shape_class
test_ordinary_line_uses_one_continuous_nonrepeating_vectorline
test_branch_chains_are_separate_from_primary_vectorline
test_every_branch_edge_is_preserved
test_loop_remains_closed_without_duplicate_edge
test_loop_with_tail_has_one_explicit_connection
test_rejoining_variant_has_diverge_and_rejoin_junctions
test_reversing_service_has_explicit_reversal_event
test_complex_network_decomposes_to_maximal_nonbranching_chains
test_branch_service_continues_past_junction
test_railway_membership_may_end_at_junction
test_shared_physical_edge_identity
test_shared_edge_smoothed_once
test_display_lane_does_not_mutate_physical_edge
test_terminus_types_are_distinct
test_no_route_jump
test_no_transfer_connector_used_as_track
test_service_date_validity
test_every_station_membership_has_validation_record
test_every_station_routable_anchor_uses_correct_railway_edge
test_station_display_anchor_resolves_from_same_display_edge
test_station_order_is_continuous_on_each_chain
test_multiplatform_station_prefers_official_assignment
test_multiplatform_station_heuristic_only_scores_legal_candidates
test_through_station_prefers_smoother_continuous_candidate
test_terminal_station_prefers_valid_nearest_approach_anchor
test_ambiguous_station_candidate_cannot_pass
```

### 20.2 Geometry / LOD

```text
test_junction_preserved_after_lod
test_station_routable_anchor_preserved_after_lod
test_terminus_preserved_after_lod
test_zoom_stability
test_parallel_spread_is_scale_normalized
test_parallel_zoom_levels_include_3_and_5
test_every_display_identity_has_geometry_profile
test_short_line_does_not_inherit_long_line_thresholds
test_short_branch_survives_required_lod_levels
test_short_line_corner_radius_respects_protected_anchors
test_dense_tram_junctions_survive_simplification
test_geometry_profile_does_not_change_topology
```

### 20.3 Display contract

```text
test_station_glyph_is_circle_at_all_zooms
test_station_glyph_never_morphs_to_logo
test_station_source_has_no_clustering
test_station_features_are_not_screen_merged
test_station_minz_is_independent_lod
test_visible_station_center_matches_rendered_lane
test_interchange_is_open_circle
test_single_line_station_is_solid_circle
test_station_facility_area_is_not_visible
test_labels_may_dedupe_without_merging_markers
test_rail_core_full_weight_is_2_5_css_px
test_station_to_rail_core_ratio_is_2_4
test_parallel_centre_distance_uses_2_5_plus_1_2
test_dense_tram_network_uses_unique_edge_union
test_route_multiplicity_does_not_create_parallel_lanes
test_service_direction_does_not_duplicate_alignment
test_shared_network_edge_is_drawn_once
test_network_union_preserves_every_unique_branch
test_flat_junction_draws_each_unique_arm_once
test_flat_junction_has_one_stable_visible_node
test_junction_does_not_render_route_turn_fan
test_grade_separated_crossing_is_not_joined
test_spatially_separated_one_way_tracks_are_not_physically_collapsed
test_selected_service_overlay_does_not_mutate_base_network
test_all_and_ridden_layers_share_display_edge_catalog
test_all_and_ridden_same_edge_resolves_identical_geometry
test_ridden_layer_does_not_run_independent_geometry_pipeline
test_reverse_journey_reuses_same_display_edge
test_partial_ridden_edge_uses_measure_clip
test_ridden_overlay_has_no_lateral_offset
test_repeated_rides_change_attributes_not_geometry_count
test_catalog_update_reaches_all_render_views
test_stale_ridden_catalog_reference_is_not_silently_rendered
test_every_display_identity_has_current_official_colour
test_official_colour_source_is_traceable
test_dark_colour_transform_preserves_official_identity
test_shared_network_colour_conflict_cannot_silently_pick_or_blend
test_apple_reference_inventory_is_complete_and_frozen
test_every_apple_reference_tile_has_one_audit_result
test_every_valid_apple_tile_has_matching_project_viewport
test_no_valid_apple_reference_tile_is_unchecked
test_tile_status_totals_equal_inventory_count
test_apple_style_metrics
test_five_country_build_and_validation_are_executed
```

### 20.4 Hokuto

```text
test_hokuto_service_station_events
test_hokuto_service_branch_choice
test_hokuto_service_transitions
test_hokuto_service_route
```

现有测试名称不同但验证同一不变量时应复用，避免建立重复测试体系。

---

## 21. 执行流程

### 21.1 建立真实基线

至少阅读：

```text
app/public/railmap-style.js
app/public/rail/*.sources.md
app/scripts/validation/validate-railway-topology.mjs
app/scripts/validation/validate-station-render-anchoring.mjs
app/scripts/railway/lib/parallel-corridors.mjs
app/scripts/railway/build-parallel-corridors.mjs
app/scripts/railway/collapse-branch-services.mjs
app/test/railway-parallel-corridors.test.js
app/test/apple-maps-railway-contract.test.js
outputs/railway-audit/railway-audit.txt
outputs/railway-audit/railway-audit.json
```

并查找五国 compact package、station layer、`minz`、`stationLanes`、`line-offset`、`line-dasharray`、line labels、route graph 和 transfer connector。

### 21.2 修改前验证

从 `app` 目录运行脚本实际支持的命令，例如：

```bash
node scripts/validation/validate-railway-topology.mjs
node scripts/validation/validate-station-render-anchoring.mjs --all
node --test test/railway-parallel-corridors.test.js
node --test test/apple-maps-railway-contract.test.js
npm test
npm run lint
```

运行前必须核对 `--help` 或脚本源码；不得假设参数存在。拓扑验证器若默认覆盖五国，不要传不存在的 `--all`。机器可读输出只使用脚本真实支持的选项。

记录既有失败，不得删除断言或降低容差换取绿色。

### 21.3 数据和拓扑顺序

```text
1. Record scope and source versions
2. Canonicalise country-specific railway identities
3. Classify operating status and target scope
4. Build or adapt canonical PhysicalGraph
5. Compare canonical sources and OSM bidirectionally
6. Classify duplicate / shared / parallel / crossing
7. Enumerate station/platform candidates and validate every station membership
8. Select routable station edges using evidence, legality, proximity and continuity
9. Build RailwayMembership
10. Classify every line by topology shape
11. Decompose ordinary, branched and atypical lines into valid chains/cycles
12. Identify junction candidates and build AllowedTransition records
13. Mark unresolved stations/transitions UNVERIFIED
14. Build or validate ServicePaths
15. Validate branch / loop / reversal / rejoining / shared-edge cases
16. Validate Hokuto and other high-risk services
17. Classify display mode and build NetworkDisplayGroups
18. Assign geometry profiles by scale, shape and mode
19. Resolve and validate official colours for every display identity/group
20. Build the one versioned CanonicalDisplayEdgeCatalog
21. For infrastructure networks, union/deduplicate refs to catalog edges
22. Map service and ridden journeys to ordered refs in the same catalog
23. Generate route-identity views and maximal chains where required
24. Derive all render layers from catalog refs without recomputing geometry
25. Inventory and freeze every Apple Maps reference tile
26. Render and review every tile one-to-one; produce a zero-omission audit
```

### 21.4 Apple Maps 全量 tile 审计矩阵

```text
reference id | relative path | checksum | country | bbox/centre |
capture date | scale/zoom | viewport | project render |
station anchoring | line/branch/loop shape | official colour |
line width | lane behavior | facility area | labels |
automatic metrics | manual status | notes
```

先复用有效存档；缺项或过期才重采。清单中的每个有效 reference tile 都必须有一行和对应比较产物，不允许只选代表样本。Apple 观察只能判断视觉语言和发现差距。

### 21.5 修改原则

按根因和风险排序，不使用“视觉修改永远优先”或“已有 topology 永远不改”的固定顺序：

1. 先修违反物理/服务不变量且证据充分的问题；
2. 再修跨层污染，如 lane 写回物理几何、transfer connector 进入运行图；
3. 修正所有错误车站锚点和多轨站候选选择；
4. 修正普通、支线、loop、reversal、rejoining 等形状分解；
5. 应用短线路/路面电车专用 geometry profile；
6. 补齐全部官方颜色及来源；
7. 再修圆点、logo、设施面、聚合和显示锚定；
8. 对有轨电车/轻轨密集网络消除 route 和方向造成的重复平行线，并验证 Junction union；
9. 合并全网层和已乘坐层的路径来源，删除或迁移独立几何副本；
10. 补充缩放、五国和全部 Apple reference tile 测试；
11. 最后处理地下虚线和沿线名称。

现有机制通过相关验证时优先保持；但新证据或新不变量证明其错误时必须修复，并增加最小失败案例。

### 21.6 修改后验证

重新运行全部基线命令和受影响定向测试。若有本地地图预览，至少在日本、台湾、香港各检查：

- 一个高密度枢纽；
- 一个普通单线站；
- 一个共享/并行走廊；
- 区域、城市、街区、车站尺度。

上述代表地点检查是交互回归下限，不能替代以下全量检查：

- 每个 in-scope station/platform membership 的点位与边归属验证；
- 每条 RailwayIdentity 的 shape/vectorline 分解验证；
- 每个 DisplayIdentity/NetworkDisplayGroup 的官方颜色验证；
- reference inventory 中每个 Apple Maps screenshot tile 的一对一比较。

人工复核最终像素：圆点形状、圆心在线、实心/白心语义、无 logo、无设施面、无聚合、lane 不换边、短线路不丢支线、复杂线路不开环/不跳接、官方颜色正确。

---

## 22. Debug 图层

建议提供：

```text
debugRailwayTopology
debugRailwayMembership
debugServicePath
debugDisplayGeometry
```

点击对象时显示 layer、ids、memberships、incoming/outgoing edges、transitions、source、confidence 和 validation status。

建议颜色：PhysicalEdge 灰、DisplayPath 蓝/线路色、branch 橙、Junction 红点、routable anchor 绿点、display anchor 青点、terminus 紫点、unknown transition 黄、forbidden 红叉、DATA_CONFLICT 洋红。

---

## 23. 报告格式

### 23.1 总结

```text
Scope and versions:
Canonical identities:
In-scope / out-of-scope:

PASS:
WARNING:
ERROR:
UNVERIFIED:
NOT_APPLICABLE:
DATA_CONFLICT:

Physical nodes / edges:
Junctions:
Allowed / unknown transitions:
Shared / parallel edges:
Service paths checked:
Display identities checked:
Stations/platform memberships checked / ambiguous:
Shape classes / vectorline chains checked:
Geometry profiles by type:
Official-colour coverage / conflicts:
Canonical display edges / catalog version:
Ridden journeys mapped / stale refs:
Apple reference inventory / audited / unchecked:
Apple tile PASS / WARNING / ERROR / UNVERIFIED:
```

### 23.2 每条铁路

```text
Railway Identity:
Display Identity/Identities:
Operator / Country / Mode:
Shape Class / Operating Status:
Vectorline / chain decomposition:
Geometry Profile:
Official Colour / Source / Valid Period:
Source Vintage:

Canonical source:
OSM:
Official / timetable evidence:
Current project:
Apple visual observation:

Identity Completeness:
Physical Topology:
Membership:
Stations / Termini:
Services:
Display Geometry:

Status / Confidence:
Problems / Root causes:
Fixes applied:
Remaining decisions:
Files changed / Validation:
```

### 23.3 Station / Junction / service / display

每个 station/platform membership 报告 source anchor、候选 edges、合法性、前后站序、距离/转角/曲率评分、selected routable edge、display edge ref、状态和证据。大型站不得只报告 station group centroid。

每个 Junction 报告 coordinates、structure、incoming/outgoing edges、allowed/unknown transitions、membership boundaries、station anchors、service anchors、shared edges、证据和状态。

每个 Service 报告 service date、train number、direction、stops、pass-through events、railway sequence、directed edges、transitions、reversals、问题和状态。

每个 Apple reference tile 单独报告相对路径、checksum、bbox/zoom/viewport、project render、自动指标、人工状态、问题和比较产物路径。另报告 inventory hash 与零漏检校验。

### 23.4 问题根因

每个非 PASS 项必须包含：

```text
Problem:
Layer:
Root cause:
Current behaviour:
Expected behaviour:
Evidence:
Confidence:
Fix:
Files changed:
Validation performed:
Remaining manual decision:
```

不得只写“route incorrect”“line disconnected”或“needs review”。

---

## 24. 最终验收标准

### 24.1 范围和诚实性

- 来源、版本、时点和国家适配已记录；
- 所有 in-scope canonical identity 已核算；
- 排除项有状态和理由；
- `UNVERIFIED` 和 `DATA_CONFLICT` 未伪装为 PASS。

### 24.2 物理和服务

- 有向多重图语义成立；
- shared、parallel、duplicate、crossing 已区分；
- 未因距离或相交自动创建运行连接；
- 使用中的 transition 有状态；
- RailwayMembership 和 ServicePath 分离；
- 不存在 route jump、错误支线或 transfer connector 作为轨道；
- 合法折返与异常掉头已区分；
- 具体服务日期和车次已固定。

### 24.3 车站、终点和几何

- routable anchor 与 display anchor 分离；
- 每个 in-scope station/platform membership 都有验证记录，没有抽样遗漏；
- 每个车站锚定到正确 RailwayIdentity、合法 PhysicalEdge 和同源 CanonicalDisplayEdge；
- 多轨多月台车站先按官方/服务/转向证据筛选，再用进站距离和路径顺直度消歧；
- ambiguous station candidate 未被计为 PASS；
- 普通、支线和异形线路均完成 shape 分类和 chain/vectorline 映射；
- ordinary line 的单 vectorline 连续且不重复 edge；
- branch 独立成线并在真实 Junction 接入，没有融合进主线造成回头；
- loop、loop-with-tail、reversing 和 rejoining variant 的 cycle/Junction/reversal 均正确；
- semantic station group 未导致 marker merge；
- 四类 terminus 分离；
- protected anchor 在 LOD 中稳定；
- shared PhysicalEdge 只生成一次规范几何；
- lane 未污染物理层；
- 密集网络的 edge union 只影响显示去重，未抹除 service、方向或合法转向数据；
- 全网、已乘坐、选中服务和 debug 视图引用同一个版本的 CanonicalDisplayEdgeCatalog。

### 24.4 显示产品契约

- 当前可见 station marker 全部是对应显示线上的圆点；
- 任意 zoom 无 logo/badge 替换；
- 最终已知样式无淡蓝/蓝灰车站设施面；
- 无 cluster、屏幕合并、数字聚合或跨 lane 胶囊；
- 低缩放少点只能由独立 LOD 解释；
- 单线实心、换乘白心规则稳定；
- 默认全权重 railway core 为 `2.5 CSS px`，车站直径仍为 `6 CSS px`；
- 全权重平行中心距按 `2.5 + 1.2 = 3.7 CSS px` 计算；
- 非零 lane 的点和线使用同一 offset；
- 有轨电车/轻轨等密集网络没有按 route 或方向展开常驻平行线；
- NetworkDisplayGroup 的每条唯一支线均可见，共用 edge 只绘制一次；
- 平面 Junction 的每个唯一方向臂只绘制一次并在稳定节点连续相接；
- 无连接或立体交叉没有被错误画成可转向 Junction；
- 全网层和已乘坐层的同一 edge 具有完全相同的 geometry、Junction、lane、offset 和 LOD；
- 已乘坐/选中层只改变 edge 子集和样式，没有独立路径构建或自由坐标副本；
- 反向和部分区间乘坐通过 traversal direction 与 measure 引用同一 edge；
- 过期 catalog 引用不会被静默渲染；
- 每条线路/显示身份均有可追溯、处于有效期的官方颜色；
- dark theme 调整可逆向追溯官方原色，未任意改 hue；
- 不存在用混色、平均色或无来源默认色掩盖官方颜色冲突；
- 每条线路具有合适 geometry profile，短小线路/路面电车未套用长线路统一阈值；
- 短支线、街角、站点和 Junction 未被 LOD/圆角/简化吞掉；
- Apple reference inventory 中每个 tile 都有同视口项目 render 和独立人工结果；
- tile 清单覆盖率为 100%，`missing_result_count = 0` 且 `unchecked_valid_tile_count = 0`；
- z3、z5、z8–z18 的归一化比例稳定；
- 五国构建和验证均实际执行。

### 24.5 无伪修复

- 未伪造物理几何、隐藏错误、降低容差或删除断言；
- 通过旧验证器不被用作拒绝新证据的理由；
- 次级视觉功能只在数据可靠处实现；
- 所有人工判断进入明确队列。

---

## 25. 最终交付

输出：

1. 修改文件和目的；
2. 范围、来源、版本与五国限制；
3. 物理、归属、服务、站点和显示层的验证摘要；
4. 每站点位和多轨站候选选择报告；
5. 每条线路的 shape、vectorline/chain 分解和 geometry profile；
6. 全部线路官方颜色清单、来源、有效期和覆盖率；
7. Apple reference inventory hash、逐 tile CSV/JSON、比较产物索引和零漏检证明；
8. 第 24 节逐条状态，不限于 PASS/FAIL；
9. 修改前后命令、结果和新增测试；
10. 数据覆盖缺口与来源冲突；
11. 地下虚线和沿线名称状态；
12. 每个 ERROR/UNVERIFIED/DATA_CONFLICT 的可复现对象、位置、zoom、根因和最小证据。

如果任务要求修改实现，不能只交理论审计；必须在证据和权限边界内完成代码/数据修正、回归测试和视觉验证。如果某项已经正确，应给出证据并保持原样。
