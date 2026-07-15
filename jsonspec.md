# N02 Limited Express Train JSON Specification

版本：`1.3`
文件名：`jsonspec.md`
适用范围：单 HTML N02 铁路地图、列车 JSON 导入/导出、JR-only 特急路线渲染、乘坐区间显示、停靠站/通过站管理。

> 本文档分为**两大部分**，各自独立编号：
> **第一部分（§1–§17）** 描述列车 JSON 的格式、字段、导入/导出与校验；
> **第二部分（§2–§23，数据源）** 描述底层 N02 / OSM 数据源及其字段语义。
> 引用「第 N 节」时按所在部分理解；跨部分引用会写明「数据源部分」。

---

## 目录

**第一部分 · 列车 JSON 规范**

1. 基本原则（含 1.1 导出 / 1.2 导入三种形态）
2. 顶层 Store 结构
3. Train 对象规范（字段 / ID 规则 / `date` / 3.4 `train_type` + `company` 与直通约定）
4. Style 对象规范
5. Route Policy 规范（含 `allowed_institution_type_codes`、`preferred_*`、`institution_filter_mode`）
6. Route Sections 规范（含 `line_names` / `operator_names`、6.4 支线分支限定）
7. Stops 规范
8. `ride_segment` 规则
9. 通过站处理规则
10. 时间字段规则
11. 导入行为
12. 导出行为
13. 地图渲染规则
14. matched_routes 规范
15. 校验规则摘要
16. 完整示例
17. 实现必须遵守的核心规则

**第二部分 · 数据源（N02 / OSM）规范**

2. 数据源说明　3. RailroadSection　4. Station　5. Station 显示点　6. N02_001　7. N02_002　8. N02_003　9. N02_004　10. N02_005　11. N02_005c　12. N02_005g　13. 字段映射（含 **13.4 站名对照表 `station-readings.json`**：汉字 / 假名 / 片假名 / 罗马字 / 简繁中文）　14. 数据质量与限制　15. 全量 / JR-only 模式　16. OSM 底图　17. 署名　18. 处理流程　19. 错误处理　20. 数据源与 JSON 边界　21. HTML 内嵌元信息　22. 核心要求摘要

---

# 第一部分 · 列车 JSON 规范

## 1. 基本原则

本系统的**权威（canonical）** JSON 顶层格式只有一种：

```json
{
  "schema_version": "1.3",
  "trains": []
}
```

> `schema_version` 为 `"1.3"`；每个 train 有可选的 `date` 字段（见 3.1 / 3.3）。
> 缺少 `date` 的 JSON 仍可导入，系统会按「JSON 内 date → 当前选中日期 → 从 id 解析 → undated」的顺序自动补全 `date`。

### 1.1 导出：永远是完整 store

导出 / 自动保存写出的永远是完整 store 对象（`{ schema_version, trains }`），即使只有一趟列车也包在 `trains` 数组内：

```json
{
  "schema_version": "1.3",
  "trains": [
    { "id": "odr_001" }
  ]
}
```

### 1.2 导入：宽松接受三种形态

为方便手工粘贴，导入解析（`parseImportedCanonicalStore`）额外接受两种简写，并在内部自动包装成完整 store：

| 顶层形态 | 处理方式 |
| ---- | ---- |
| `{ "schema_version": "1.3", "trains": [...] }` | 完整 store（必须含合法 `schema_version`，且不得含 `schema_version` / `trains` 以外的键） |
| `[ { ...train }, ... ]` | 裸列车数组 → 包装为 `{ schema_version:"1.3", trains:[...] }` |
| `{ "id": ..., "stops": [...] }` | 单个列车对象（同时含 `id` 与 `stops`）→ 包装为单元素 store |

导入始终是**追加**（见第 11 节），不会覆盖现有列车；`schema_version` 仅在完整 store 形态下校验。
裸数组 / 单列车形态会被赋予当前 `schema_version`（`1.3`）。

---

## 2. 顶层 Store 结构

### 2.1 必填字段

| 字段               | 类型     | 必填 | 说明            |
| ---------------- | ------ | -: | ------------- |
| `schema_version` | string |  是 | 必须为 `"1.3"` |
| `trains`         | array  |  是 | 列车数组          |

### 2.2 顶层示例

```json
{
  "schema_version": "1.3",
  "trains": [
    {
      "id": "odr_001",
      "date": "2026-07-03",
      "number": "踊り子9号",
      "train_type": "特急",
      "company": "JR東日本",
      "origin": "東京",
      "destination": "熱海",
      "direction": "down",
      "visible": true,
      "style": {
        "color": "#d9364f"
      },
      "route_policy": {
        "mode": "single_primary_route",
        "jr_only": true,
        "allow_alternatives": false,
        "allow_browser_straight_line_fallback": false,
        "allowed_institution_type_codes": ["2"]
      },
      "route_sections": [
        {
          "from": "東京",
          "to": "品川",
          "from_n02_station_code": "003770",
          "to_n02_station_code": "004095"
        }
      ],
      "stops": [
        {
          "name": "東京",
          "n02_station_code": "003770",
          "arrival": null,
          "departure": "12:00",
          "stop_type": "origin",
          "ride_segment": true
        },
        {
          "name": "熱海",
          "n02_station_code": "005685",
          "arrival": "13:18",
          "departure": null,
          "stop_type": "destination",
          "ride_segment": true
        }
      ]
    }
  ]
}
```

---

## 3. Train 对象规范

### 3.1 Train 字段

「必填」一栏指**导入校验**是否强制要求该字段。标记为「否」的字段可省略，导入时会被补成下表的默认值，而**导出时这些字段总是被写出**（已规范化）。

| 字段               | 类型      | 必填 | 缺省默认值 | 说明                              |
| ---------------- | ------- | -: | ---- | ------------------------------- |
| `id`             | string  |  是 | —    | 列车唯一 ID（见 3.2）                  |
| `number`         | string  |  是 | —    | 车次，例如 `踊り子9号`                   |
| `train_type`     | string  |  否 | `""` | 车辆类型，例如 `特急` / `普通` / `快速` / `新幹線`（见 3.4） |
| `company`        | string  |  否 | `""` | 车辆（运营）公司；直通车用 `/` 分隔多家公司（见 3.4）  |
| `origin`         | string  |  是 | —    | 列车运行起点                          |
| `destination`    | string  |  是 | —    | 列车运行终点                          |
| `stops`          | array   |  是 | —    | 完整停站/通过站数据，至少 2 项（见第 7 节）       |
| `date`           | string  |  否 | 见 3.3 | 运行/行程日期 `YYYY-MM-DD`（1.3 新增；缺省按 3.3 自动补全） |
| `direction`      | string  |  否 | `"down"` | 方向，推荐 `up` / `down` / `unknown` |
| `visible`        | boolean |  否 | `true` | 是否在地图上显示                        |
| `style`          | object  |  否 | 见第 4 节 | 样式设置（缺省时用默认样式）                  |
| `route_policy`   | object  |  否 | 见第 5 节 | 路线匹配策略（缺省时用默认策略）                |
| `route_sections` | array   |  否 | `[]` / 由 stops 推导 | 站间 route section（缺省时按相邻 stops 自动生成，见 6.3） |

> **严格白名单**：train 对象只允许上表中的键，出现任何其它键都会导致导入失败。注意：route_section 级的支线 `name`（见 6.1b）是不同字段，**不受影响**。

### 3.2 Train ID 规则

`id` 必须满足：

```text
^[a-zA-Z0-9_-]+$
```

推荐格式：

```text
odr_001
hitachi_010
shinano_001
```

导入时如果 `id` 与现有列车重复，系统可以自动改为：

```text
odr_001-2
odr_001-3
```

### 3.3 Train 日期字段（`date`，1.3 新增）

每个 train 可携带运行/行程日期字段：

```json
"date": "2026-07-03"
```

| 项目  | 说明                       |
| --- | ------------------------ |
| 字段名 | `date`                   |
| 类型  | string                   |
| 格式  | `YYYY-MM-DD`             |
| 含义  | 该列车所属运行日期 / 行程日期         |
| 示例  | `2026-07-03`、`2026-07-24` |

侧栏按 `date` 把列车分组：日期按钮区 + 当前日期列表 + `全部` 总清单。日期分组完全由
`trains[*].date` 派生，不维护独立的每日数组，避免每日清单与全部清单不同步。

导入/载入时 `date` 的解析优先级（`normalizeTrainDate`）：

```text
1. train.date 是合法 YYYY-MM-DD            -> 直接使用（即使与当前选中日期不同，也以 JSON 内 date 为准）
2. 当前 UI 选中了某个具体日期               -> 写入当前选中日期
3. 从 id 中解析 YYYYMMDD                    -> 例如 20260703_01_haruka -> 2026-07-03（取首个被非数字包围的 8 位日期）
4. 以上都没有                              -> "undated"
```

> 日期输入容错（`normalizeDateString`）：会先去除首尾空白、把 `/` 视作 `-`，再校验
> `YYYY-MM-DD`（月 1–12、日 1–31）。`undated` 是保留值，表示「无法确定日期」的桶。
> 校验（`validateTrain`）允许 `date` 缺省、为合法 `YYYY-MM-DD`、或恰为 `"undated"`。

排序规则（所有列表）：

```text
date ASC
departure ASC      # 取 stops[0].departure -> origin stop -> 第一个非空 departure
missing_time LAST  # 没有发车时间的列车排在该日期最后
id ASC             # 最终 tiebreaker
```

发车时间支持跨日标记（如 `10:00+1`），排序时按次日时间处理，且不会因此崩溃。
`全部` 总清单只汇总显示，不改变任何列车的 `date` 归属。

### 3.4 车辆类型 `train_type` 与车辆公司 `company`

两个字段均为**可选 string**（缺省 `""`），在导入时接受、导出时总是写出。

| 字段          | 示例值                                       |
| ------------ | -------------------------------------------- |
| `train_type` | `特急`、`普通`、`快速`、`新幹線`、`地下鉄`、`私鉄/準急` 等 |
| `company`    | `JR西日本`、`JR東海`、`東京メトロ`、`京急電鉄/都営地下鉄` |

**直通车约定**：跨公司直通运行的列车，在 `company` 中以 `/` 分隔写出**所有**参与公司（如 `京急電鉄/都営地下鉄`）。UI 检测到 `/` 即自动在显示处追加「直通」字样（清单、悬浮标签、popup），JSON 中**不需要**额外的直通字段。

**对轨道渲染（寻路）的影响 —— 软偏好**：`train_type` 与 `company` 共同决定路线倾向渲染在哪条轨道上，但均为**软偏置**、不会造成断线；显式的 `route_policy` 永远优先：

1. 当 `route_policy.allowed_institution_type_codes` 为缺省全量 `["1","2","3","4","5"]` 时，求解器按 `train_type` + `company` 推导出更窄的事业者种别偏好：含 `新幹線` → `["1"]`；JR 公司（非新干线）→ `["2"]`；`都営`/公营 → `["3"]`；地下鉄/私铁（メトロ、電鉄、京急、東急 等）→ `["4"]`；第三セクター → `["5"]`。推导出多个信号时取并集；无信号则保持全量。配合默认 `institution_filter_mode: "soft"`，非匹配轨道只是加罚、仍可借道。
2. `company` 中的每家公司（`/` 拆分后）映射为 N02_004 运营者名并并入 `preferred_operator_names` 软偏好；常用简称自动换算为正式名（`JR西日本`→`西日本旅客鉄道`、`東京メトロ`→`東京地下鉄`、`都営地下鉄`→`東京都` 等），未知名称原样使用。
3. 若 `route_policy` 已显式给出更窄的 `allowed_institution_type_codes`，或某区段带有 `route_sections[].line_names` / `operator_names` 硬约束，则以显式设置为准，本推导不生效。

```json
{
  "train_type": "特急",
  "company": "JR西日本"
}
```

```json
{
  "train_type": "普通",
  "company": "京急電鉄/都営地下鉄"   // UI 显示为「京急電鉄/都営地下鉄（直通）」
}
```

---

## 4. Style 对象规范

### 4.1 字段

`style` 对象及其字段均可省略。**每列车只有 `color` 一个字段**：线宽与淡色透明度是**全局显示设置、由网页统一控制，不写进 JSON**（见下方说明）。导出时 `style` 只写出 `color`。

| 字段      | 类型     | 必填 | 默认值       | 约束 / 说明                     |
| ------- | ------ | -: | --------- | --------------------------- |
| `color` | string |  否 | `#d9364f` | 正常乘坐区间颜色；**必须为 `#RRGGBB`（6 位十六进制）**，否则校验报错 |

> **`weight` / `unridden_opacity` 已移除（不再由 JSON 控制）**：线宽是**全局设置**，由网页「顯示調節 → 線路粗細」（`DISPLAY.routeWidthScale`）统一控制，所有列车等宽渲染（`DEFAULT_TRAIN_WEIGHT × routeWidthScale`）；非乘坐区间**整段隐藏**（透明度 0），故 `unridden_opacity` 无意义。导入时若 JSON 仍带这两个字段，会被**忽略丢弃**，导出时不再写出。

### 4.2 示例

```json
"style": {
  "color": "#d9364f"
}
```

---

## 5. Route Policy 规范

整个 `route_policy` 可省略；缺省时用下表默认值。导出时所有字段都会被写出（已规范化）。

### 5.1 字段

| 字段                                     | 类型      | 必填 | 固定/默认                      | 说明 / 校验                                                   |
| -------------------------------------- | ------- | -: | -------------------------- | ------------------------------------------------------- |
| `mode`                                 | string  |  否 | `"single_primary_route"`   | **必须**恰为 `single_primary_route`，每趟列车只允许一条主路线              |
| `jr_only`                              | boolean |  否 | `false`                    | 顾问性标记，必须为 boolean；实际过滤由 `allowed_institution_type_codes` 决定（见 5.4） |
| `allow_alternatives`                   | boolean |  否 | `false`                    | **必须**为 `false`，不允许候选路线并列显示                              |
| `allow_browser_straight_line_fallback` | boolean |  否 | `false`                    | **必须**为 `false`，禁止用直线伪装铁路线                               |
| `allowed_institution_type_codes`       | array   |  否 | `["1","2","3","4","5"]`    | 允许的 N02_002 事业者种别，**只能含 `1`/`2`/`3`/`4`/`5`**（见 5.2）     |
| `preferred_line_names`                 | array   |  否 | `[]`                       | 偏好路线名（`N02_003`），软偏置（见 5.3）；必须为字符串数组                     |
| `preferred_operator_names`             | array   |  否 | `[]`                       | 偏好运营公司（`N02_004`），软偏置（见 5.3）；必须为字符串数组                    |
| `institution_filter_mode`             | string  |  否 | `"soft"`                   | `soft` 或 `hard`（见 5.4）                                   |

### 5.2 `allowed_institution_type_codes` 取值

字段接受以下五个 `N02_002` 事业者种别码（详见数据源部分「N02_002 事业者种别代码」一节）；任何其它值都会导致校验失败：

| 值     | 含义     |
| ----- | ------ |
| `"1"` | JR 新幹線 |
| `"2"` | JR 在来線 |
| `"3"` | 公営鉄道  |
| `"4"` | 民営鉄道  |
| `"5"` | 第三セクター |

缺省（省略该字段）= **全量** `["1","2","3","4","5"]`。常用子集：

```json
"allowed_institution_type_codes": ["1", "2", "3", "4", "5"]   // 全量
"allowed_institution_type_codes": ["1", "2"]                   // JR-only（新干线 + 在来线）
"allowed_institution_type_codes": ["2"]                        // 仅 JR 在来线
```

### 5.3 偏好提示：`preferred_line_names` / `preferred_operator_names`

这两个数组是给 Dijkstra 寻路器的**软偏置**（不是硬约束）：偏离偏好线路/公司的边会被按距离比例加罚，使路线倾向于贴着指定线路/公司走，但当无可行偏好路径时仍可绕行。留空表示无偏好。

> 提示区别于硬约束：若要**强制**某段必须走某条线/某家公司，应使用 `route_sections[].line_names` / `operator_names`（见第 6 节）。

```json
"preferred_line_names": ["日豊線"],
"preferred_operator_names": ["九州旅客鉄道"]
```

### 5.4 `institution_filter_mode`：soft vs hard

| 值        | 行为                                                                 |
| -------- | ------------------------------------------------------------------ |
| `"soft"`（默认） | `allowed_institution_type_codes` 作为**偏好**：非许可种别的边按距离比例加大罚分，但在没有许可路径时仍可借道（避免机场/直通区段出现可见缺口）。 |
| `"hard"` | `allowed_institution_type_codes` 作为**硬白名单**：非许可种别的边被直接排除。仅在确实需要严格事业者白名单时使用。 |

### 5.5 示例

```json
"route_policy": {
  "mode": "single_primary_route",
  "jr_only": true,
  "allow_alternatives": false,
  "allow_browser_straight_line_fallback": false,
  "allowed_institution_type_codes": ["2"],
  "preferred_line_names": [],
  "preferred_operator_names": [],
  "institution_filter_mode": "soft"
}
```

---

## 6. Route Sections 规范

`route_sections` 表示相邻站之间的线路区间。它用于辅助前端和构建器匹配已计算的 N02 铁路线 geometry。

### 6.1 字段

每个 section 的起点必须**至少**有 `from` 或 `from_n02_station_code` 之一，终点同理（两者都缺会校验报错）。`line_names` / `operator_names` 为可选的**硬约束**提示。

| 字段                      | 类型          | 必填 | 说明                                          |
| ----------------------- | ----------- | -: | ------------------------------------------- |
| `from`                  | string      |  否* | 区间起点站名（与 `from_n02_station_code` 至少有一个）      |
| `to`                    | string      |  否* | 区间终点站名（与 `to_n02_station_code` 至少有一个）        |
| `from_n02_station_code` | string/null |  否* | 起点 N02 駅コード（`N02_005c`）                      |
| `to_n02_station_code`   | string/null |  否* | 终点 N02 駅コード（`N02_005c`）                      |
| `line_names`            | array       |  否 | 限定该段必须走的路线名（`N02_003`）；字符串数组，留空表示不限。**跨/邻接分歧站的区间必填**（见 6.4） |
| `operator_names`        | array       |  否 | 限定该段必须走的运营公司（`N02_004`）；字符串数组，留空表示不限         |

> `*` 起点/终点各自的「名称」与「码」二选一即可，并非同时必填。
>
> **`line_names` / `operator_names` 与第 5 节偏好的区别**：这里是该区间的**硬约束**（寻路时只走匹配的线/公司，配合在站内换乘连接边）；`route_policy.preferred_*` 是全列车范围的软偏好。仅在 `line_names` / `operator_names` 非空时才会写入导出 JSON。

> **canonical 形态省略可推导的 `from` / `to` 名**：站名是**每站常量**，已由 `from/to` 码经站名对照表（见 13.4）唯一确定，且每个车站的名字已在其 `stops[].name` 上保留一份。因此**导出 / 持久化的 route_section 默认只写 `from_n02_station_code` / `to_n02_station_code`（+ 线路/公司提示），不再重复 `from` / `to` 站名**——避免同一站名在 stops 和每个 section 里反复出现（当前存档约省 10%）。加载时前端按码从站表补回 `from` / `to`，所以站名匹配、§6.4 分歧检测、tooltip 等逻辑照常工作。**端点无码**（无法由码还原）或名字与码的权威站名**不一致**（别名）时，`from` / `to` 名会**保留**。

### 6.1b 支线车号 `number` / `name`（可选）

部分特急在某一区间会以**不同的车号 / 列车名**运行（典型如新干线併结后分割：はやぶさ↔こまち、こまち↔はやぶさ、しおかぜ↔いしづち；或在来线直通区间改号）。可在该区间所属的 route_section 上附加可选字段：

| 字段       | 类型     | 必填 | 说明                                       |
| -------- | ------ | -: | ---------------------------------------- |
| `number` | string |  否 | 该区间实际运行的车号（当与 train 顶层 `number` 不同时填写） |
| `name`   | string |  否 | 该区间的列车名（可选）                              |

设置后，地图上**该区间的 popup 与悬浮标签显示此支线车号**（而非列车顶层车号），并额外标注「支線車號 / Branch」。未设置时沿用列车顶层 `number`。导入/导出均保留此二字段（仅在非空时写出）；其余规则与 `line_names` / `operator_names` 一致（不影响寻路，仅用于显示）。

```json
"route_sections": [
  { "from": "仙台", "to": "盛岡", "number": "はやぶさ95号" },
  { "from": "盛岡", "to": "秋田", "number": "こまち95号" }
]
```

### 6.2 示例

```json
"route_sections": [
  {
    "from": "東京",
    "to": "品川",
    "from_n02_station_code": "003770",
    "to_n02_station_code": "004095"
  },
  {
    "from": "品川",
    "to": "横浜",
    "from_n02_station_code": "004095",
    "to_n02_station_code": "004634"
  }
]
```

### 6.3 生成规则

系统可以根据 `stops` 自动生成 `route_sections`：

```text
stops[0] → stops[1]
stops[1] → stops[2]
stops[2] → stops[3]
...
```

`route_sections` 不应因为 `ride_segment=false` 而被删除。
`ride_segment=false` 只影响显示样式，不影响是否保留区间数据。

### 6.4 支线分支限定（寻路只走列车真正经过的分支）

> 核心规则：在分歧站（支线分理处）寻路时，**只包含该班列车真正会去的那一条分支，绝不自动纳入该线经过点上的其它分支。**

N02 铁路网在很多车站会分叉（一条本线上挂着支线、绕行线、貨物支線、車庫線等）。Dijkstra 默认只求**最短路**，在分歧站会就近溜到错误的分支上，把别条线的车站当成通过站采集进来。这是绝对禁止的：

```text
错误：早岐 是 佐世保線 / 大村線 的分歧站
      → 求解器从 佐世保線 一路最短路冲过早岐，溜到 有田 方向（佐世保線早岐以远）
      → 又在另一头窜到 長崎本線長回り，采进 肥前浜 / 多良 / 肥前古賀
正确：列车只走 佐世保→早岐(佐世保線) + 早岐→諫早(大村線) + 諫早→長崎(長崎線)
      → 这些分支以外的任何车站、任何线段都不得出现在结果里
```

为此，凡是会经过分歧站的区间，**必须用硬约束把该段锁死在列车实际所走的那一条线上**：

1. **逐段 `line_names`（硬约束）必填化**：对任何跨越/邻接分歧站的 `route_section`，必须写 `line_names`（必要时配 `operator_names`），限定该段只能在这条线上寻路。求解器只走匹配 `N02_003` 的边，配合在分歧站处的**站内换乘边**完成换线；**不得**跨到未列出的线名上，即使那样更短。

2. **分支闭合，不得越过分歧站**：每一段在其两端站（含分歧站）处闭合求解；分歧站只作为换线锚点，路径不得越过它继续延伸到本段 `line_names` 以外的分支。

3. **折返（switchback）必须切分求解**：若列车在分歧站折返（如シーサイドライナー在「早岐」由佐世保線转入大村線需原路退出；こまち在「大曲」由田沢湖線转入奥羽線折返；あそぼーい！在「立野」三段式折返），则把折返站两侧的区间作为**两次独立求解**的端点——入腿锁在进线、出腿锁在出线——避免求解器"抄近道"穿过分歧站岔口的另一侧，连带把错误分支采进来。停站序列在折返站处自然拆成相邻两段（不同 `line_names`）即可表达。

4. **通过站只能来自实际分支**：自动补全通过站（见第 9 节）时，只能采集落在本段 `line_names` 所限定分支上的车站；任何不在该分支几何上的车站一律不得作为通过站写入。已写入的、不属于实际分支的通过站属于数据错误，须删除。

5. **校验**：跨/邻接分歧站的区间若缺 `line_names`，校验应给出 warning（建议补硬约束，实现见 `warnBranchLeak`）；若导出的通过站不在该段 `line_names` 对应的线名集合内，应报 warning 提示疑似错误分支泄漏。

> 与第 5 节 `preferred_*` 的关系：偏好是**软偏置**（无可行偏好路径时仍可绕行），分歧站限定要求的是**硬约束**，二者不可混用——分支限定只能靠 `route_sections[].line_names` / `operator_names`。

---

## 7. Stops 规范


`stops` 是最重要的数据。导出的 JSON 必须包含完整停站数据。

### 7.1 Stop 字段

导入时每个 stop **只强制要求 `name`**；其余字段缺省时按下表默认值补全。规范化 / 导出后每个 stop 都包含全部 6 个字段（这也是「完整 stops」的含义，见第 12 节）。stop 出现 6 个字段以外的键会导致导入失败。

| 字段                 | 类型          | 导入必填 | 缺省默认值              | 说明                        |
| ------------------ | ----------- | -: | ------------------ | ------------------------- |
| `name`             | string      |  是 | —                  | 站名                        |
| `n02_station_code` | string/null |  否 | `null`             | N02 駅コード，即 `N02_005c`     |
| `arrival`          | string/null |  否 | `null`             | 到达时间，格式见第 10 节，可为 `null`  |
| `departure`        | string/null |  否 | `null`             | 出发时间，格式见第 10 节，可为 `null`  |
| `stop_type`        | string      |  否 | `"passenger_stop"` | 站点类型（见 7.2）               |
| `ride_segment`     | boolean     |  否 | `false`            | 该站是否处于实际乘坐状态（导出时强制布尔）     |

> 校验（`validateTrain`）对已规范化的 store 更严格：`ride_segment` 必须是 boolean，`arrival`/`departure` 必须是字符串或 `null`，`name` 与 `stop_type` 必须非空。内部编辑时会临时写入 `n02_group_code`，但它**不在** stop 的导出/导入字段内，导出时被丢弃。

### 7.2 stop_type 允许值

| 值                  | 说明    |
| ------------------ | ----- |
| `origin`           | 始发站   |
| `destination`      | 终点站   |
| `passenger_stop`   | 客运停靠站 |
| `operational_stop` | 运转停靠站 |
| `pass_through`     | 通过站   |

### 7.3 Stop 示例

```json
{
  "name": "品川",
  "n02_station_code": "004095",
  "arrival": "12:08",
  "departure": "12:09",
  "stop_type": "passenger_stop",
  "ride_segment": true
}
```

---

## 8. ride_segment 规则

### 8.1 字段含义

`ride_segment` 表示该站是否处于实际乘坐区间内。

```json
"ride_segment": true
```

表示该站为实际乘坐站，正常颜色显示。

```json
"ride_segment": false
```

表示该站不处于实际乘坐状态，淡色显示。

### 8.2 toggle 规则（停靠站可切换，通过站不可单独切换）

**只有停靠站可以单独 toggle `ride_segment`**：`origin` / `destination` / `passenger_stop` / `operational_stop`。终点站也可以 toggle，不得强制 disabled。

**通过站（`pass_through`）不可单独 toggle。** 它的 `ride_segment` 由所在「停靠站→停靠站」区间派生：仅当它两侧最近的两个停靠站 `ride_segment` 同时为 `true` 时，该通过站才算乘坐（显示）；否则未乘坐（隐藏）。编辑器中通过站的 toggle 复选框为 disabled（只读，显示派生值）。

因此「隐藏某段区间」只通过切换停靠站完成：把区间一端（或两端）停靠站的 `ride_segment` 置为 `false`，**该区间内的全部通过站会自动随之隐藏**。

派生规则（实现 `effectiveStopRide`）：

```text
停靠站           ride = stop.ride_segment === true
通过站           ride = 前一停靠站.ride_segment === true
                        && 后一停靠站.ride_segment === true
区间(段) i→i+1    ride = effectiveRide(i) && effectiveRide(i+1)
```

### 8.3 区间显示规则

相邻两站之间的 route segment 显示规则：

```text
两端 station.ride_segment 都为 true
→ 区间使用正常颜色显示
```

```text
任意一端 station.ride_segment 为 false
→ 区间使用淡色显示
```

示例：

| from | from.ride_segment | to  | to.ride_segment | 显示   |
| ---- | ----------------: | --- | --------------: | ---- |
| 東京   |              true | 品川  |            true | 正常颜色 |
| 品川   |              true | 横浜  |           false | 淡色   |
| 横浜   |             false | 小田原 |            true | 淡色   |
| 小田原  |             false | 熱海  |           false | 淡色   |

### 8.4 route_sections 不按 ride_segment 删除

即使某站：

```json
"ride_segment": false
```

也必须继续保留相邻 `route_sections`。

错误做法：

```text
ride_segment=false
→ 删除该站到相邻站的 route section
```

正确做法：

```text
ride_segment=false
→ 保留 route section
→ 该站 marker 淡色
→ 与该站相邻的 route segment 淡色
```

### 8.5 指定乘坐区间时必须保留完整停站与通过站

如果某趟特急规定了乘坐区间（即只乘坐整条特急的其中一段），生成的 JSON 仍然必须包含该特急的**全部**停靠站和通过站，不得因为只乘坐一段而删除其余站点。

`ride_segment` 是“该站是否处于实际乘坐区间”的标记，**不是**“是否保留该站数据”的标记。整条特急的完整停站序列必须始终完整导出，乘坐与否只通过 `ride_segment` 的 `true` / `false` 体现。

正确做法：

```text
规定乘坐区间
→ 保留全部 stops（origin / passenger_stop / operational_stop / pass_through / destination 一个都不删）
→ 保留全部通过站
→ 保留全部 route_sections
→ 乘坐区间内的站点 ride_segment = true
→ 未乘坐区间两端及其之间的站点 ride_segment = false
```

错误做法：

```text
规定乘坐区间
→ 删除未乘坐的停靠站
→ 删除未乘坐的通过站
→ 删除未乘坐的 route_sections
→ stops 里只剩乘坐区间的站点
```

显示效果：

```text
乘坐区间内的站点 / 区间   → 正常颜色（ride_segment=true）
未乘坐区间的站点 / 区间   → 淡色（ride_segment=false）
```

区间淡色规则仍沿用 8.3：只要相邻两站任意一端 `ride_segment=false`，该 route segment 即淡色显示（见 8.3 表格与第 13 节渲染规则）。

示例：一趟从 `A` 跑到 `E` 的特急，用户只乘坐 `B→C` 一段，导出的 `stops` 仍须包含 `A、B、C、D、E` 以及之间的全部通过站，只是：

```text
A  ride_segment=false
B  ride_segment=true
C  ride_segment=true
D  ride_segment=false
E  ride_segment=false
A↔B / C↔D / D↔E 区间   → 淡色
B↔C 区间               → 正常颜色
```

---

## 8.6 特急全区间规范（支线列车 / 全区间写入、部分显示）

> 这是「搜索/录入 JSON 信息」时对**特急、新干线**类列车的硬性要求；普通/快速等区间列车可只写实际乘坐段。

### 8.6.1 必须写入列车的「全区间」

每一趟特急/新干线在 JSON 中必须按其**实际运行全程**录入：从该次列车的**始发终着站**到**终点终着站**的**全部停车站**，而不是只写乘客实际乘坐的一段。

```text
列车全区间 = 该车次官方「始发站 → 终着站」的全部停车站（按 停车型态/时刻表）
乘坐区间   = 乘客实际「上车站 → 下车站」的子区间
```

例如：南風20号 实际运行 高知 → 岡山，乘客只乘 高知 → 阿波池田。
则 stops 必须写 高知…大歩危…阿波池田…琴平…多度津…宇多津…児島…岡山（全程），
而不是只写到 阿波池田。

### 8.6.2 只显示实际乘坐区间

- 乘坐区间内的停车站：`ride_segment = true`（正常显示）。
- 乘坐区间以外（上车前 / 下车后 的全部站点与通过站）：`ride_segment = false`，按 §13.4 **完全隐藏（不绘制）**。
- 因此地图上仍只看到乘客实际乘坐的一段，但 JSON 已保留该特急的完整运行区间，可随时改动乘坐范围而不必重新查询全程。
- `origin` / `destination` 顶层字段仍可记为「实际上/下车站」用于行程语义；`direction` 记为该车次的「行き先」终着站（见车号方向约定）。

### 8.6.3 支线列车（併结分割 / 直通改号）

部分特急在全区间内会**分段以不同车号运行**（新干线併结后在某站分割：はやぶさ↔こまち、こまち↔はやぶさ；在来线直通改号：かもめ↔リレーかもめ 等）。此时：

- 在对应区间的 `route_section` 上写 `number`（必要时 `name`）标明该段实际车号（见 §6.1b）。
- 列车顶层 `number` 可写併结名（如 `はやぶさ95号・こまち95号`）；各支线段用 section 的 `number` 覆盖显示。
- 地图该段 popup / 悬浮标签显示对应支线车号，并标注「支線車號 / Branch」。
- **寻路只走该车次真正经过的分支**：经过分歧站的各段必须按 §6.4 用 `line_names` 硬约束锁定实际分支，不得让求解器溜到本线在分歧站上挂着的其它支线（折返车次须按 §6.4 第 3 条切分求解）。

### 8.6.4 校验

- 特急/新干线 `stops` 应覆盖该车次全区间（首站=始发终着、末站=终点终着）。
- 至少一个停车站 `ride_segment=true`（即必须有实际乘坐区间）。
- 跨/邻接分歧站的区间须满足 §6.4（缺 `line_names` 给 warning；通过站泄漏到错误分支报 warning）。
- 其余规则沿用 §7 / §8 / §13。

---

## 9. 通过站处理规则

### 9.1 通过站定义

通过站可以有两种来源：

1. 用户在 `stops` 中手动写入：

```json
{
  "name": "横浜",
  "n02_station_code": "004634",
  "arrival": null,
  "departure": null,
  "stop_type": "pass_through",
  "ride_segment": true
}
```

2. 系统根据已匹配的线路 geometry 自动计算。

### 9.2 通过站缺失处理

如果无法在 N02 Station 数据中查找到通过站，必须跳过。

规则：

```text
stop_type = pass_through
且无法根据 name / n02_station_code 匹配到 N02 station
→ 跳过该通过站
→ 不显示 marker
→ 不阻止导入
→ 不阻止 route_sections 生成
→ 不阻止列车渲染
→ 在 report / console 中记录 warning
```

禁止行为：

```text
通过站找不到
→ 导入失败
```

```text
通过站找不到
→ 整趟列车不显示
```

```text
通过站找不到
→ 用站名直接画直线
```

### 9.3 通过站 warning 格式

建议 warning 结构：

```json
{
  "level": "warning",
  "type": "pass_through_station_not_found",
  "train_id": "odr_001",
  "station_name": "横浜",
  "message": "Pass-through station was not found in N02 station index and was skipped."
}
```

### 9.4 停靠站与通过站的错误等级区别

| stop_type          | 找不到 N02 station 时     |
| ------------------ | --------------------- |
| `origin`           | error                 |
| `destination`      | error                 |
| `passenger_stop`   | error                 |
| `operational_stop` | warning 或 error，由实现决定 |
| `pass_through`     | warning，跳过            |

### 9.5 自动计算通过站失败

如果系统无法计算某段 route 的通过站：

```text
无法计算通过站
→ 跳过通过站生成
→ 仍然显示 route segment
→ 仍然显示已匹配的 stops
→ 记录 warning
```

---

## 10. 时间字段规则

### 10.1 格式

`arrival` 和 `departure` 是 `"HH:MM"` 字符串或 `null`。系统支持**两种**跨日表示：

```text
24:10        # 直接用 >=24 的小时表示次日（推荐正则：^([01][0-9]|2[0-9]|3[0-9]):[0-5][0-9]$）
25:30
10:00+1      # 在时间后加 "+N" 表示第 N 天（解析器 parseTimeToMinutes 支持，排序按次日处理）
```

或：

```json
null
```

> 排序解析（`parseTimeToMinutes`）接受 `H:MM` / `HH:MM`，以及可选的 `+N` 次日偏移（如 `10:00+1`）。
> 无法解析或缺省的发车时间会让该列车在同日内排到最后，而不会报错（见 3.3 排序规则）。
> 注意：`validateTrain` 只检查 `arrival`/`departure` 为字符串或 `null`，并不强制上面的格式——
> 格式约定主要服务于显示与排序，请尽量遵循以获得正确的时间排序。

### 10.2 始发站

始发站允许：

```json
"arrival": null
```

但应有：

```json
"departure": "12:00"
```

### 10.3 终点站

终点站应有：

```json
"arrival": "13:18"
```

允许：

```json
"departure": null
```

### 10.4 通过站

通过站允许：

```json
"arrival": null,
"departure": null
```

如果系统估算通过时间，不应覆盖用户原始 JSON，可在运行时 report 中显示估算值。

---

## 11. 导入行为

### 11.1 接受的导入形态

导出永远是完整 store；导入则按第 1.2 节宽松接受三种形态（完整 store / 裸列车数组 / 单列车对象），内部统一包装为完整 store 后再处理。

### 11.2 导入时追加

导入时不得覆盖当前列车列表（逐条 progressive 追加）。

正确行为：

```text
解析导入 JSON（store / 数组 / 单列车）
→ 标准化每趟 train（补默认值、按 3.3 解析 date）
→ 追加到当前 trainStore.trains
→ 如果 id 重复，自动改为唯一 id（如 odr_001-2）
→ 自动保存到服务器 train-store.json（PUT /api/train-store，去抖）
→ 自动选中最后导入的列车
```

> 持久化说明：本系统以**服务器端 `data/train-store.json`** 作为唯一事实来源
> （`GET/PUT/DELETE /api/train-store`），编辑会去抖自动保存、启动时自动载入，
> 取代了早期的浏览器 localStorage 备份。仅有纯 UI 状态（当前选中日期 `selectedDate`、
> 手动新增的空日期 `manualDates`、地图跟随/聚焦开关）仍存放在 localStorage，
> **不**进入 canonical store。

### 11.3 导入后可编辑

导入后：

```text
点击列车列表中的列车项目
→ 设置 selectedTrainId
→ 编辑区加载该 train
→ 可以编辑基本字段、stops、ride_segment
→ 保存后去抖写入服务器 train-store.json 并刷新地图
```

---

## 12. 导出行为

### 12.1 只导出 canonical store

导出 JSON 永远是当前版本的完整 store（带缩进的美化 JSON；服务器自动保存时写紧凑 JSON）：

```json
{
  "schema_version": "1.3",
  "trains": []
}
```

### 12.2 每趟列车必须导出完整 stops

不得导出精简 stops。

必须保留：

```text
name
n02_station_code
arrival
departure
stop_type
ride_segment
```

即使某趟特急只乘坐其中一段，也必须导出该特急的全部停靠站与通过站（含 `ride_segment=false` 的站点），不得只导出乘坐区间内的站点。详见 8.5。

### 12.3 不允许导出 UI 临时字段

禁止导出：

```text
collapsed
favorite
selected
hovered
editing
layer_id
leaflet_id
computed_bounds
runtime_warning
```

### 12.4 不允许导出旧字段

禁止导出：

```text
station
station_code
group_code
operator_hint
line_name_hint
```

必须使用：

```text
name
n02_station_code
```

---

## 13. 地图渲染规则

### 13.1 正常站点

`ride_segment=true`：

```text
正常颜色
正常 opacity
正常 tooltip / popup
```

### 13.2 非乘坐站点

`ride_segment=false`：

```text
同色淡显
低 opacity
仍然可点击
仍然显示 tooltip / popup
```

### 13.3 正常区间

相邻两端 `ride_segment=true`：

```text
color = train.style.color
weight = DEFAULT_TRAIN_WEIGHT × DISPLAY.routeWidthScale（全局线宽，见 §4）
opacity = 0.92
dashArray = null
```

### 13.4 未乘坐区间 / 站点：完全隐藏

任意一端 `ride_segment=false`（区间不在乘坐范围内）时，该 route segment 以及其内的全部通过站、未乘坐停靠站 **完全不绘制（彻底隐藏）**，不再是淡色显示：

```text
未乘坐区间        opacity = 0，不加入渲染（SVG 不画、GPU 缓冲跳过）
未乘坐停靠站      不绘制 marker
区间内通过站      随区间一并隐藏，不绘制 marker
```

> 旧版「淡色＋虚线」（`unridden_opacity` / `dashArray "4 6"`）表示未乘坐区间的做法已废弃：现在未乘坐 = 彻底隐藏。`style.unridden_opacity` 与 `style.weight` 已从 canonical JSON **移除**（导入时忽略、导出时不写；线宽改由全局 `routeWidthScale` 控制，见第一部分 §4）。

### 13.5 禁止直线 fallback

无论任何情况，禁止在无法匹配 N02 route geometry 时使用两站坐标直接连线。

错误：

```text
from station point → to station point 直接连线
```

正确：

```text
无 matched route geometry
→ 不画 route segment
→ 显示 warning
```

---

## 14. matched_routes 规范

`matched_routes` 不属于导入/导出的 canonical train store，但属于构建结果。
它应按相邻停站区间拆分 feature。

### 14.1 每个 segment 一个 feature

```json
{
  "type": "Feature",
  "properties": {
    "train_id": "odr_001",
    "route_id": "odr_001-primary",
    "is_primary": true,
    "segment_index": 0,
    "from": "東京",
    "to": "品川",
    "from_n02_station_code": "003770",
    "to_n02_station_code": "004095"
  },
  "geometry": {
    "type": "LineString",
    "coordinates": []
  }
}
```

### 14.2 segment_index 对应关系

```text
segment_index = 0 → stops[0] 到 stops[1]
segment_index = 1 → stops[1] 到 stops[2]
segment_index = 2 → stops[2] 到 stops[3]
```

### 14.3 区间状态读取

前端渲染时：

```text
fromStop = stops[segment_index]
toStop = stops[segment_index + 1]
```

```text
fromStop.ride_segment && toStop.ride_segment
→ 正常颜色
```

```text
!(fromStop.ride_segment && toStop.ride_segment)
→ 淡色
```

---

## 15. 校验规则摘要

### 15.1 Store 校验

必须满足：

```text
顶层是对象（非数组）
只含 schema_version 与 trains 两个键（多余键报错）
schema_version = "1.3"
trains 是 array
trains[*].id 不重复
```

> 说明：导入时要求 `trains.length >= 1`（空 store 无可导入内容会报错）；但服务器保存 /
> 导出允许空 `trains`（例如「全部删除」后保存的就是空 store）。

### 15.2 Train 校验

每趟 train 必须满足（`validateTrain`）：

```text
id / number / origin / destination  都是非空字符串
id 在 store 内唯一（不得重复）
train_type / company 若出现：必须是字符串（可为空串）
stops 是 array 且 length >= 2
首站不应同时有 arrival 和 departure；末站同理
date 若出现：必须是合法 YYYY-MM-DD 或 "undated"
```

下列字段为**可选**；只有在出现时才按规则校验（缺省时由规范化补默认值，见第 3/4/5/6 节）：

```text
style.color            若出现：必须匹配 ^#[0-9a-fA-F]{6}$
route_sections         若出现：必须是 array；每段起点 from|from_n02_station_code 至少其一，
                       终点同理；line_names / operator_names 若出现须为字符串数组
route_policy.mode                                 须恰为 "single_primary_route"
route_policy.jr_only                              须为 boolean
route_policy.allow_alternatives                   须为 false
route_policy.allow_browser_straight_line_fallback 须为 false
route_policy.allowed_institution_type_codes       只能含 "1"/"2"/"3"/"4"/"5"
route_policy.preferred_line_names / preferred_operator_names  须为字符串数组
route_policy.institution_filter_mode              若出现须为 "soft" 或 "hard"
```

> 注意：`visible` 由导入规范化为布尔默认值，但 `validateTrain` 并不单独强校验其类型。

### 15.3 Stop 校验

已规范化 store 中每个 stop 必须满足：

```text
name 非空
stop_type 非空
ride_segment 是 boolean
arrival 是字符串或 null
departure 是字符串或 null
n02_station_code 允许 null
```

（导入阶段更宽松：只要求 `name` 存在，其余按 7.1 补默认值。）

### 15.4 通过站校验

```text
stop_type=pass_through 且 N02 匹配失败
→ warning
→ skip
```

其它关键站：

```text
origin / destination / passenger_stop 匹配失败
→ error
```

---

## 16. 完整示例

```json
{
  "schema_version": "1.3",
  "trains": [
    {
      "id": "odr_001",
      "date": "2026-07-03",
      "number": "踊り子9号",
      "train_type": "特急",
      "company": "JR東日本",
      "origin": "東京",
      "destination": "熱海",
      "direction": "down",
      "visible": true,
      "style": {
        "color": "#d9364f"
      },
      "route_policy": {
        "mode": "single_primary_route",
        "jr_only": true,
        "allow_alternatives": false,
        "allow_browser_straight_line_fallback": false,
        "allowed_institution_type_codes": ["2"],
        "preferred_line_names": [],
        "preferred_operator_names": [],
        "institution_filter_mode": "soft"
      },
      "route_sections": [
        {
          "from": "東京",
          "to": "品川",
          "from_n02_station_code": "003770",
          "to_n02_station_code": "004095"
        },
        {
          "from": "品川",
          "to": "横浜",
          "from_n02_station_code": "004095",
          "to_n02_station_code": "004634"
        },
        {
          "from": "横浜",
          "to": "熱海",
          "from_n02_station_code": "004634",
          "to_n02_station_code": "005685"
        }
      ],
      "stops": [
        {
          "name": "東京",
          "n02_station_code": "003770",
          "arrival": null,
          "departure": "12:00",
          "stop_type": "origin",
          "ride_segment": true
        },
        {
          "name": "品川",
          "n02_station_code": "004095",
          "arrival": "12:08",
          "departure": "12:09",
          "stop_type": "passenger_stop",
          "ride_segment": true
        },
        {
          "name": "横浜",
          "n02_station_code": "004634",
          "arrival": null,
          "departure": null,
          "stop_type": "pass_through",
          "ride_segment": false
        },
        {
          "name": "熱海",
          "n02_station_code": "005685",
          "arrival": "13:18",
          "departure": null,
          "stop_type": "destination",
          "ride_segment": true
        }
      ]
    }
  ]
}
```

在上例中：

```text
東京 → 品川
两端 ride_segment=true
→ 正常颜色
```

```text
品川 → 横浜
横浜 ride_segment=false
→ 淡色
```

```text
横浜 → 熱海
横浜 ride_segment=false
→ 淡色
```

如果 `横浜` 作为 `pass_through` 无法在 N02 站点数据中找到：

```text
跳过横浜通过站 marker
不中断导入
不中断東京/品川/熱海的显示
记录 warning
```

---

## 17. 实现必须遵守的核心规则

1. 导出顶层永远是 `{ "schema_version": "1.3", "trains": [...] }`；导入另宽松接受裸数组与单列车对象（见 1.2）。
2. 导入时 append，不覆盖现有 trains；持久化到服务器 `train-store.json`（非 localStorage）。
3. 导出时必须包含完整 stops。
4. 每个 stop 必须包含 `ride_segment`。
5. 每一站的 `ride_segment` 都可 toggle。
6. `ride_segment=false` 的站点必须淡色显示。
7. 与 `ride_segment=false` 站点相邻的区间必须淡色显示。
8. `ride_segment=false` 不得删除 `route_sections`。
8a. 规定乘坐区间时必须保留该特急的全部停靠站与通过站，仅把未乘坐区间的站点 `ride_segment` 置为 `false`，不得删除任何站点。
9. 找不到通过站时跳过，通过站缺失不得导致导入失败。
10. 找不到 origin / destination / passenger_stop 时应报错。
11. 禁止使用站点直线 fallback 伪装铁路线。
12. 每趟列车只允许一条 primary route。
13. matched route 应按相邻停站拆成 segment features。
14. JR-only 匹配必须只允许 `N02_002=["1","2"]` 或 `["2"]`。
15. 寻路只走列车真正经过的支线分支：分歧站处必须用 `route_sections[].line_names` 硬约束锁定实际分支，绝不自动纳入该线在分歧站上挂着的其它分支；折返车次须切分求解；通过站只能来自实际分支（见 §6.4）。

---

# 第二部分 · 数据源（N02 / OSM）规范

> 以下章节自成一套编号（§2–§23），描述列车 JSON 背后的 N02 铁路数据与 OSM 底图。
> 这些是「构建器 / 数据源」层面的约定，与第一部分的列车 JSON 字段相互配合。

## 2. 数据源说明 / Data Sources

本系统使用两类数据源：

1. **国土交通省「国土数値情報 鉄道データ N02」**
   用于铁路线路、车站、路线匹配、车站搜索、特急路线 overlay。
2. **OpenStreetMap / OSM 风格底图**
   仅作为地图底图使用，不参与铁路拓扑、站点匹配、特急路线计算。

其中，铁路计算与 JSON 规范的主数据源是 **N02**。OSM 只作为视觉底图。

---

### 2.1 N02 数据源总览

| 项目     | 内容                            |
| ------ | ----------------------------- |
| 数据名称   | 国土数値情報 鉄道データ                  |
| 数据 ID  | `N02`                         |
| 发布机构   | 国土交通省                         |
| 当前使用年度 | 2025年度 / 令和7年度                |
| 下载包名称  | `N02-25_GML.zip`              |
| 数据基准日  | 2025-12-31                    |
| 覆盖范围   | 日本全国                          |
| 数据对象   | 全国旅客铁路・轨道的线路与车站               |
| 数据形状   | 线数据                           |
| 坐标系    | JGD2011 / `(B, L)`            |
| 主要用途   | 铁路线路显示、站点显示、站间路线匹配、通过站计算      |
| 数据格式   | GML、Shapefile、GeoJSON         |
| 推荐读取格式 | UTF-8 GeoJSON                 |
| 使用许可   | 2020 年以后为 CC BY 4.0 / オープンデータ |
| 出典要求   | 必须注明国土交通省国土数值情報，并说明本系统是加工创建   |

---

### 2.2 N02 数据内容

N02 铁路数据包含：

```text
全国旅客铁路・轨道的路线和车站
铁路线路几何
车站几何
铁路区分
事业者种别
路线名
运营公司
车站名
N02 駅コード
N02 グループコード
```

N02 不应理解为“列车运行数据库”或“时刻表数据库”。
它只提供铁路基础设施与车站的 GIS 数据，不提供：

```text
特急列车名
列车号
列车时刻
列车停靠站顺序
列车实际运行区间
某趟列车是否通过某站
某趟列车是否停靠某站
```

因此，本系统的特急列车 JSON 中的以下内容都必须由用户手动提供：

```text
列车 ID
列车名
车次
运行起点
运行终点
停靠站
通过站
到达时间
出发时间
实际乘坐站
ride_segment
```

---

### 2.3 N02 原典资料

N02 铁路数据并不是直接从本系统生成，而是国土交通省根据多个原典资料整备。

官方说明中的主要原典资料包括：

```text
国土地理院「数値地図25000（空間データ基盤）」
国土地理院「電子地形図（タイル）」
電気車研究会・鉄道図書刊行会「鉄道要覧」
各鉄道事業者の公式 HP 等
```

N02 的制作方式大意是：

```text
参考鉄道要覧等资料，
截至数据基准日，
对已开通线路、新设车站、名称变更车站等进行更新，
并从原典资料取得路线形状和位置。
```

因此，N02 适合用于铁路线路和车站的 GIS overlay，但不保证能替代运营公司的实时运行资料或实际运行时刻表。

---

### 2.4 上传包实际结构

本项目当前使用的上传包为：

```text
N02-25_GML.zip
```

解压后的主要目录结构如下：

```text
N02-25_GML/
  KS-META-N02-25.xml
  KsjAppSchema-N02-v3_1.xsd

  Shift-JIS/
    N02-25_RailroadSection.dbf
    N02-25_RailroadSection.prj
    N02-25_RailroadSection.shp
    N02-25_RailroadSection.shx
    N02-25_Station.dbf
    N02-25_Station.prj
    N02-25_Station.shp
    N02-25_Station.shx

  UTF-8/
    N02-25.xml
    N02-25_RailroadSection.dbf
    N02-25_RailroadSection.geojson
    N02-25_RailroadSection.prj
    N02-25_RailroadSection.shp
    N02-25_RailroadSection.shx
    N02-25_Station.dbf
    N02-25_Station.geojson
    N02-25_Station.prj
    N02-25_Station.shp
    N02-25_Station.shx
```

本系统推荐优先读取：

```text
N02-25_GML/UTF-8/N02-25_RailroadSection.geojson
N02-25_GML/UTF-8/N02-25_Station.geojson
```

如果 GeoJSON 不存在，再 fallback 到：

```text
N02-25_GML/UTF-8/N02-25_RailroadSection.shp
N02-25_GML/UTF-8/N02-25_Station.shp
```

不推荐优先读取 `Shift-JIS` 目录，除非处理旧系统兼容问题。

---

### 2.5 N02 文件角色

| 文件                               | 作用              |
| -------------------------------- | --------------- |
| `N02-25_RailroadSection.geojson` | 铁路区间线数据         |
| `N02-25_Station.geojson`         | 车站线数据           |
| `N02-25.xml`                     | JPGIS / GML 主数据 |
| `KS-META-N02-25.xml`             | 元数据             |
| `KsjAppSchema-N02-v3_1.xsd`      | XML schema      |
| `.shp/.shx/.dbf/.prj`            | Shapefile 版本    |

本系统中的铁路 overlay 和路线匹配主要依赖：

```text
RailroadSection.geojson
Station.geojson
```

---

### 2.6 当前 N02-25 数据量

本项目检查的 `N02-25_GML.zip` 中，UTF-8 GeoJSON 数据量如下：

| 数据文件                             | Feature 数量 | Geometry 类型  |
| -------------------------------- | ---------: | ------------ |
| `N02-25_RailroadSection.geojson` |     21,933 | `LineString` |
| `N02-25_Station.geojson`         |     10,234 | `LineString` |

注意：

```text
Station 也是 LineString。
Station 不是 Point。
```

因此，前端显示站点圆圈时，必须从 Station 的线形 geometry 计算显示点。

---

## 3. RailroadSection 数据说明

`RailroadSection` 是铁路区间数据，用于表示铁路线路的线形。

### 3.1 RailroadSection Geometry

| 项目          | 内容                                     |
| ----------- | -------------------------------------- |
| Geometry 类型 | `LineString`                           |
| 坐标顺序        | GeoJSON 中为 `[longitude, latitude]`     |
| 原始坐标系       | JGD2011 / `(B, L)`                     |
| 前端显示        | 可直接作为 Leaflet GeoJSON polyline overlay |
| 路线匹配        | 应用于构建铁路 graph / edge                   |

### 3.2 RailroadSection 属性字段

| 字段        | 类型     | 含义      | 是否必需 |
| --------- | ------ | ------- | ---: |
| `N02_001` | string | 铁道区分代码  |    是 |
| `N02_002` | string | 事业者种别代码 |    是 |
| `N02_003` | string | 路线名     |    是 |
| `N02_004` | string | 运营公司    |    是 |

### 3.3 RailroadSection 示例

```json
{
  "type": "Feature",
  "properties": {
    "N02_001": "11",
    "N02_002": "2",
    "N02_003": "東海道線",
    "N02_004": "東日本旅客鉄道"
  },
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [139.000000, 35.000000],
      [139.100000, 35.100000]
    ]
  }
}
```

---

## 4. Station 数据说明

`Station` 是车站数据，但在 N02 中，车站也作为铁路线路的一部分整备，因此 geometry 也是线。

### 4.1 Station Geometry

| 项目          | 内容                                 |
| ----------- | ---------------------------------- |
| Geometry 类型 | `LineString`                       |
| 坐标顺序        | GeoJSON 中为 `[longitude, latitude]` |
| 原始含义        | 车站所在的铁路线路部分                        |
| 前端显示        | 需要计算 display point                 |
| 路线匹配        | 应用于 station-to-graph snapping      |

### 4.2 Station 属性字段

| 字段         | 类型     | 含义          | 是否必需 |
| ---------- | ------ | ----------- | ---: |
| `N02_001`  | string | 铁道区分代码      |    是 |
| `N02_002`  | string | 事业者种别代码     |    是 |
| `N02_003`  | string | 路线名         |    是 |
| `N02_004`  | string | 运营公司        |    是 |
| `N02_005`  | string | 站名          |    是 |
| `N02_005c` | string | N02 駅コード    |    是 |
| `N02_005g` | string | N02 グループコード |    是 |

### 4.3 Station 示例

```json
{
  "type": "Feature",
  "properties": {
    "N02_001": "11",
    "N02_002": "2",
    "N02_003": "東海道線",
    "N02_004": "東日本旅客鉄道",
    "N02_005": "東京",
    "N02_005c": "003770",
    "N02_005g": "003770"
  },
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [139.765000, 35.681000],
      [139.766000, 35.682000]
    ]
  }
}
```

---

## 5. Station 显示点处理规则

因为 N02 Station 是线，不是点，所以前端或构建器必须生成显示点。

推荐处理规则：

```text
Station LineString
→ 取线段 normalized midpoint
→ 作为 display_point
```

如果未来遇到 MultiLineString，推荐规则：

```text
Station MultiLineString
→ 选择最长 LineString
→ 取最长线的 normalized midpoint
→ 作为 display_point
```

如果遇到 Point，视为兼容情况：

```text
Station Point
→ 直接作为 display_point
```

输出给前端的 station display feature 可以使用：

```json
{
  "type": "Feature",
  "properties": {
    "station_name": "東京",
    "n02_station_code": "003770",
    "n02_group_code": "003770",
    "line_name": "東海道線",
    "operator": "東日本旅客鉄道",
    "railway_class_code": "11",
    "institution_type_code": "2",
    "original_geometry_type": "LineString"
  },
  "geometry": {
    "type": "Point",
    "coordinates": [139.7655, 35.6815]
  }
}
```

原始 Station LineString 不应丢弃。
显示点只用于地图 marker 和搜索定位，路线匹配仍应尽可能使用原始线形 geometry 与铁路 graph 进行 snapping。

---

## 6. N02_001 铁道区分代码

`N02_001` 表示铁道路线的种类。
它不是运营公司分类，也不是 JR/私铁分类。

### 6.1 代码表

| `N02_001` | 含义       |
| --------- | -------- |
| `11`      | 普通鉄道JR   |
| `12`      | 普通鉄道     |
| `13`      | 鋼索鉄道     |
| `14`      | 懸垂式鉄道    |
| `15`      | 跨座式鉄道    |
| `16`      | 案内軌条式鉄道  |
| `17`      | 無軌条鉄道    |
| `21`      | 軌道       |
| `22`      | 懸垂式モノレール |
| `23`      | 跨座式モノレール |
| `24`      | 案内軌条式    |
| `25`      | 浮上式      |

### 6.2 当前 N02-25 RailroadSection 计数

| `N02_001` | 含义       | RailroadSection 数量 |
| --------- | -------- | -----------------: |
| `11`      | 普通鉄道JR   |             10,762 |
| `12`      | 普通鉄道     |              9,041 |
| `13`      | 鋼索鉄道     |                 86 |
| `14`      | 懸垂式鉄道    |                 16 |
| `15`      | 跨座式鉄道    |                 31 |
| `16`      | 案内軌条式鉄道  |                164 |
| `21`      | 軌道       |              1,464 |
| `22`      | 懸垂式モノレール |                 38 |
| `23`      | 跨座式モノレール |                138 |
| `24`      | 案内軌条式    |                176 |
| `25`      | 浮上式      |                 17 |

### 6.3 当前 N02-25 Station 计数

| `N02_001` | 含义       | Station 数量 |
| --------- | -------- | ---------: |
| `11`      | 普通鉄道JR   |      4,738 |
| `12`      | 普通鉄道     |      4,424 |
| `13`      | 鋼索鉄道     |         54 |
| `14`      | 懸垂式鉄道    |          8 |
| `15`      | 跨座式鉄道    |         15 |
| `16`      | 案内軌条式鉄道  |         83 |
| `21`      | 軌道       |        724 |
| `22`      | 懸垂式モノレール |         19 |
| `23`      | 跨座式モノレール |         70 |
| `24`      | 案内軌条式    |         90 |
| `25`      | 浮上式      |          9 |

---

## 7. N02_002 事业者种别代码

`N02_002` 表示铁道路线的事业者类别。
它用于区分 JR、新干线、公营、民营、第三部门。

### 7.1 代码表

| `N02_002` | 含义     |
| --------- | ------ |
| `1`       | JRの新幹線 |
| `2`       | JR在来線  |
| `3`       | 公営鉄道   |
| `4`       | 民営鉄道   |
| `5`       | 第三セクター |

### 7.2 当前 N02-25 RailroadSection 计数

| `N02_002` | 含义     | RailroadSection 数量 |
| --------- | ------ | -----------------: |
| `1`       | JRの新幹線 |                245 |
| `2`       | JR在来線  |             10,517 |
| `3`       | 公営鉄道   |              1,169 |
| `4`       | 民営鉄道   |              7,170 |
| `5`       | 第三セクター |              2,832 |
| **合计**    |        |         **21,933** |

### 7.3 当前 N02-25 Station 计数

| `N02_002` | 含义     | Station 数量 |
| --------- | ------ | ---------: |
| `1`       | JRの新幹線 |        112 |
| `2`       | JR在来線  |      4,626 |
| `3`       | 公営鉄道   |        580 |
| `4`       | 民営鉄道   |      3,533 |
| `5`       | 第三セクター |      1,383 |
| **合计**    |        | **10,234** |

### 7.4 本系统中的使用规则

如果地图需要显示全部铁路数据：

```json
"allowed_institution_type_codes": ["1", "2", "3", "4", "5"]
```

如果只允许 JR 数据：

```json
"allowed_institution_type_codes": ["1", "2"]
```

如果只允许 JR 在来线：

```json
"allowed_institution_type_codes": ["2"]
```

`N02_002` 不应和 `N02_001` 混用。
例如：

```text
N02_001 = 11 表示普通鉄道JR
N02_002 = 2 表示 JR在来線
```

两者语义不同，应分别作为筛选条件。

---

## 8. N02_003 路线名

`N02_003` 是铁路线路名称。

示例：

```text
東海道線
中央線
山陽線
鹿児島線
吉都線
本線
```

注意：

```text
N02_003 不是列车名。
N02_003 不是运营公司。
N02_003 不是唯一线路 ID。
```

同一个 `N02_003` 可能在不同运营公司或不同地区重复出现。
路线匹配时应同时参考：

```text
N02_003 路线名
N02_004 运营公司
N02_001 铁道区分
N02_002 事业者种别
station code
stop order
```

---

## 9. N02_004 运营公司

`N02_004` 是运营公司名称。

示例：

```text
東日本旅客鉄道
西日本旅客鉄道
東海旅客鉄道
九州旅客鉄道
北海道旅客鉄道
近畿日本鉄道
東京地下鉄
```

注意：

```text
N02_004 是运营公司，不是事业者种别。
N02_004 应作为路线匹配 hint，而不是唯一条件。
```

例如，同一条长距离线路可能跨多个 JR 公司，不能强制只允许一个运营公司，除非用户在 JSON 中明确规定。

---

## 10. N02_005 站名

`N02_005` 是站名。

在本系统 canonical JSON 中，对应字段为：

```json
"name": "東京"
```

不使用旧字段：

```json
"station": "東京"
```

站名匹配应支持：

```text
完全匹配
全角/半角归一化
去除前后空白
必要时通过 alias 表补充
```

但不应自动把不同名称的换乘站视为同一个站。
例如：

```text
船橋
京成船橋
```

二者名称不同，不应仅靠 N02 group code 自动合并。
如需合并，应使用手动 transfer group 或 alias 规则。

> N02 只有汉字站名，**没有假名 / 罗马字**。站名的平假名读音与罗马字不写进列车 JSON，
> 集中存于按 `N02_005c` 索引的 `station-readings.json`（见第二部分 13.4 站名读音表）。

---

## 11. N02_005c 駅コード

`N02_005c` 是 N02 内部的駅コード。

在本系统 canonical JSON 中，对应字段为：

```json
"n02_station_code": "003770"
```

必须注意：

```text
N02_005c 不是 JR 官方站号。
N02_005c 不是私铁官方站号。
N02_005c 不是车站三字母代码。
N02_005c 不是乘车券系统中的站号。
```

它是 N02 数据内部为 station feature 赋予的唯一编号。
官方说明是按车站纬度降序排列后赋予的唯一编号。

因此：

```text
可以用 N02_005c 做 N02 数据内部精确匹配。
不应把 N02_005c 显示为“官方站号”。
不应拿 N02_005c 和 JR/私铁站号混用。
```

---

## 12. N02_005g グループコード

`N02_005g` 是 N02 内部的グループコード。

在系统内部可以命名为：

```text
n02_group_code
```

官方含义：

```text
300m 以内
且同名的车站
归为一个组
组代码使用最接近组重心的駅コード
```

必须注意：

```text
N02_005g 只处理 300m 内同名站。
N02_005g 不是完整换乘站 ID。
N02_005g 不能覆盖不同名称但现实可换乘的站。
```

例如：

```text
大阪
梅田
東梅田
西梅田
```

这些现实中可能可换乘，但名称不同，不应仅靠 `N02_005g` 自动合并。

---

## 13. 数据源与 JSON 字段映射

### 13.1 Station 到 JSON Stop

| N02 Station 字段 | JSON 字段                    | 说明             |
| -------------- | -------------------------- | -------------- |
| `N02_005`      | `stops[].name`             | 站名             |
| `N02_005c`     | `stops[].n02_station_code` | N02 駅コード       |
| `N02_005g`     | 内部 `n02_group_code`        | 可用于候选消歧，但默认不导出 |
| `N02_003`      | 匹配 hint                    | 路线名            |
| `N02_004`      | 匹配 hint                    | 运营公司           |
| `N02_001`      | 匹配 filter                  | 铁道区分           |
| `N02_002`      | 匹配 filter                  | 事业者种别          |

> 站名的假名 / 罗马字**不进入** Stop 字段；另见 13.4 的 `station-readings.json`（前端 `placeName` 按 `n02_station_code` 查表，站名兜底）。

### 13.2 RailroadSection 到 Route Segment

| N02 RailroadSection 字段 | 用途                       |
| ---------------------- | ------------------------ |
| `N02_001`              | 铁道类型筛选 / penalty         |
| `N02_002`              | 事业者种别筛选 / JR-only / 全量模式 |
| `N02_003`              | 路线名 hint                 |
| `N02_004`              | 运营公司 hint                |
| geometry               | 真实铁路线形                   |

### 13.3 JSON 不直接保存 N02 geometry

canonical train JSON 不直接保存 N02 geometry。

也就是说，以下内容不进入导出的 canonical JSON：

```text
RailroadSection coordinates
Station LineString coordinates
matched route coordinates
Leaflet layer id
runtime bounds
computed pass-through geometry
```

这些属于构建结果或运行时状态，不属于手写列车 JSON。

### 13.4 站名对照表 `station-readings.json`（汉字 / 假名 / 片假名 / 罗马字 / 简繁中文）

N02 数据只提供汉字站名（`N02_005`），**不含任何假名、罗马字或中文译名**（见第 4 / 10 节）。因此站名的全部表记既不写进列车 JSON，也不硬编码在前端字典里，而是集中放在一张**按站 ID 索引的对照表** `app/data/station-readings.json`，通过 `GET /api/station-readings` 提供。**本表是站名的唯一权威来源**：一条记录同时给出汉字原名、平假名、片假名、罗马字、繁体中文、简体中文六种表记。

**为什么按站 ID 而不是站名**：N02 里存在大量同名不同站（当前在用车站中就有 54 个站名对应多个 `N02_005c`），且同名站偶有不同读音；以 `N02_005c`（駅コード，见第 11 节）为主键可精确区分，站名仅作兜底。主键天生免疫「同一车站多公司 / 多线路」——那种情况本就是多个不同的 `N02_005c`，各自独立、读音一致，不会冲突。

#### 文件结构

```json
{
  "note": "Station name table keyed by N02 station code (N02_005c). ...",
  "byCode": {
    "007958": { "name": "関西空港", "kana": "かんさいくうこう", "katakana": "カンサイクウコウ", "romaji": "Kansai-Kūkō", "zh_Hant": "關西空港", "zh_Hans": "关西空港" },
    "003987": { "name": "三田",     "kana": "みた",             "katakana": "ミタ",             "romaji": "Mita",        "zh_Hant": "三田",     "zh_Hans": "三田" }
  },
  "byName": {
    "関西空港": { "kana": "かんさいくうこう", "katakana": "カンサイクウコウ", "romaji": "Kansai-Kūkō", "zh_Hant": "關西空港", "zh_Hans": "关西空港" }
  }
}
```

| 字段                 | 类型     | 说明                                                             |
| ------------------ | ------ | -------------------------------------------------------------- |
| `byCode`           | object | 主表。键为 `N02_005c`，值为 `{ name, kana, katakana, romaji, zh_Hant, zh_Hans }` |
| `byCode[].name`    | string | 汉字站名（等于该码的 `N02_005`），日文原名                                      |
| `byCode[].kana`    | string | 平假名读音（只用平假名，长音不写「ー」）                                            |
| `byCode[].katakana`| string | 片假名读音（由 `kana` 机械转写而来）                                          |
| `byCode[].romaji`  | string | 修正 Hepburn 罗马字，长音用长音符（`ō` / `ū`），方位·地区前缀用连字符分隔（`Minami-`、`Iyo-`） |
| `byCode[].zh_Hant` | string | 繁体中文名                                                          |
| `byCode[].zh_Hans` | string | 简体中文名                                                          |
| `byName`           | object | 兜底表。键为**归一化站名**，值为 `{ kana, katakana, romaji, zh_Hant, zh_Hans }`；**不含 id**（原数据无 id 者不补 id） |

**归一化站名**（`byName` 的键，与前端 `normReadingKey` / `normalizeStationName` 一致）：

```text
NFKC 规整 → 去首尾空白 → ヶ→ケ → ヵ→カ
```

#### 覆盖范围（当前 N02-25 + 当前 store）

```text
byCode：793 条（覆盖当前所有列车实际停靠 / 经过的 N02_005c）
byName：774 条（同名归一化兜底）
缺失读音：0
```

对照表只需覆盖**在用**车站；新增列车若引入新站，需为其站码补一条 `byCode`（拿不到码时至少补 `byName`）。

#### 查表顺序（前端 `I18N.placeName(jp, code)`）

```text
1. byCode[code]                —— 有站码时优先，精确
2. byName[normReadingKey(jp)]  —— 无码或未命中时按归一化站名兜底
3. 服务名字典 KANA / NAMES     —— 只剩列车名 / 线名（如 あずさ、京浜東北線）
4. 原文                         —— 全未命中则原样返回站名
```

显示形态（与既有 `placeName` 一致）：

```text
zh-Hant / zh-Hans → 東京（とうきょう）   （汉字 ＋ 平假名）
en                → 東京 (Tōkyō)        （汉字 ＋ 罗马字）
ja                → 東京                 （仅汉字）
```

#### 与列车 JSON 的边界（重要）

```text
读音 / 片假名 / 中文永不写入 train-store.json：stop 只保留 name + n02_station_code
  （每站名字在其 stop 上保留唯一一份），其余表记全部按码来本表取。
route_sections 只保留 from/to 码：其 from/to 站名与 stops 重复、可由码经本表还原，
  故导出 / 持久化时省略（见 6.1），加载时按码补回；无码端点或别名则保留名字。
读音不再硬编码在 i18n.js：站名注音已整体移入本表，
  i18n.js 的 KANA / NAMES 只保留列车服务名与线名。
无 n02_station_code 的大站（東京 / 新宿 / 札幌 等），生成时已按最近锚点
  补齐 N02_005c 写回 stops，故本表可统一按码命中；byName 仍作兜底。
```

#### 数据来源与生成

```text
平假名：依据权威网络资料（各站维基 / 官方読み仮名等）确定，
  难读站（大楽毛=おたのしけ、撫牛子=ないじょうし、五十川=いらがわ 等）逐一核对。
片假名：由平假名机械转写（ひらがな→カタカナ，1:1），确定性生成。
罗马字：修正 Hepburn，长音 ō / ū，方位·地区前缀
  （Kita- / Minami- / Higashi- / Nishi- / Shin- / Iyo- / Tosa- / Uzen- / Ugo- 等）连字符分隔。
简繁中文：参考官方译名。纯汉字站名用运营商通行的简 / 繁写法
  （OpenCC jp2t→t2s，并修正 jp2t 的过度繁化：予≠豫、余≠餘、渋→澀/涩、岳≠嶽、仙台=台 等）；
  含假名 / ヶ / ノ / ツ 的站名用官方或既定译名（みなとみらい=港未來 / 港未来、
  りんくうタウン=臨空城 / 临空城、ハウステンボス=豪斯登堡、トマム=苫鵡 / 苫鹉、
  越前たけふ=越前武生、ひばりヶ丘=雲雀丘 / 云雀丘；ノ→之、ツ / ヶ 脱落）。
本表为构建产物，可整表重建；应随在用车站集变化保持同步。
```

---

## 14. 数据源质量与限制

官方 N02 页面列出主要质量信息：

```text
完整性 / 过剩・遗漏：误率 0%
位置准确度 / 绝对准确度：误率 0%
```

但本系统仍需处理以下实际问题：

### 14.1 车站不是点

N02 Station 是线数据，不能直接当作点。

系统必须：

```text
保留原始 Station LineString
计算 display point
用于 marker 显示
```

### 14.2 N02 不是时刻表

N02 不提供列车运行时刻。
因此：

```text
arrival
departure
stop_type
pass_through
ride_segment
```

都必须由用户 JSON 指定，或由系统根据用户指定的站序和 N02 geometry 辅助计算。

### 14.3 通过站可能无法匹配

如果 `stop_type = pass_through` 的站在 N02 Station 中无法匹配：

```text
跳过该通过站
不阻止导入
不阻止列车显示
不阻止 route section 渲染
记录 warning
```

通过站缺失不应导致整趟列车失败。

### 14.4 关键停靠站匹配失败

如果以下 stop 无法匹配：

```text
origin
destination
passenger_stop
```

应视为错误，因为无法可靠确定列车路线。

### 14.5 同名站歧义

多个 station feature 可能同名。
匹配时优先级应为：

```text
n02_station_code
→ n02_group_code + line/operator hint
→ station name + N02_003 + N02_004
→ station name + nearest route section
```

如果仍无法唯一确定，应记录 warning 或要求用户补充 `n02_station_code`。

---

## 15. 全量数据模式与 JR-only 模式

本系统支持两种模式：

### 15.1 全量 N02 模式

显示和匹配所有 `N02_002`：

```json
"allowed_institution_type_codes": ["1", "2", "3", "4", "5"]
```

包含：

```text
JR 新干线
JR 在来线
公营铁道
民营铁道
第三部门
```

适合：

```text
全国全部铁路 overlay
私铁/第三部门特急
跨公司线路显示
非 JR 路线搜索
```

### 15.2 JR-only 模式

只显示或只匹配：

```json
"allowed_institution_type_codes": ["1", "2"]
```

适合：

```text
JR Pass 行程
JR 特急路线
JR 新干线 + JR 在来线
```

### 15.3 JR 在来线 only 模式

只匹配：

```json
"allowed_institution_type_codes": ["2"]
```

适合：

```text
JR 在来线特急
不希望新干线参与匹配
```

### 15.4 注意

全量 overlay 和 route matching filter 是两个概念。

```text
地图可以显示全量 N02
某趟列车可以只允许 JR 数据
另一趟列车可以允许私铁或第三部门
```

因此，推荐：

```text
HTML 内嵌全量 N02 数据
每趟 train 通过 route_policy 控制匹配范围
```

---

## 16. OSM 底图数据源

OSM 只作为底图，不参与铁路数据计算。

### 16.1 在线 OSM 模式

在线模式可以使用：

```text
https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

此模式要求联网，并且只允许正常交互式浏览。

### 16.2 禁止批量下载

不得从 OSM 官方 tile server 批量下载瓦片用于离线。

禁止行为：

```text
预下载全国瓦片
预下载城市/区域瓦片
后台爬取 z/x/y tiles
生成 MBTiles/zip 离线包
把 tile.openstreetmap.org 当离线瓦片源
```

### 16.3 不提供离线底图

系统不包含本地瓦片、PMTiles、MBTiles 或其他离线底图加载功能。底图只允许使用
在线服务；在线底图不可用时，自动进入无底图模式。

### 16.4 无底图模式

如果没有网络，也没有合法本地瓦片，系统必须仍然可用：

```text
浅灰背景
N02 铁路 overlay
N02 station overlay
特急 route overlay
stop / pass-through marker
```

---

## 17. 数据来源署名要求

HTML、README、规范文档、导出图像或发布成果中必须包含 N02 出典。

推荐署名：

```text
出典：国土交通省 国土数値情報（鉄道データ N02）
「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成
```

如果使用 OSM 底图，还必须显示：

```text
Map data © OpenStreetMap contributors
```

如果使用自托管 OSM 派生底图，也必须保留 OSM attribution，并按瓦片提供方要求补充署名。

---

## 18. 数据源处理流程

推荐完整处理流程：

```text
1. 读取 N02-25_GML.zip
2. 优先读取 UTF-8 GeoJSON
3. 读取 RailroadSection.geojson
4. 读取 Station.geojson
5. 校验必要字段
6. 保留原始 LineString geometry
7. 为 Station 计算 display point
8. 建立 station index
9. 建立 railroad graph
10. 读取 canonical train JSON
11. 按 train.route_policy 过滤可用 railway edge
12. 按 stops 顺序求解相邻站之间的真实铁路路径
13. 输出 matched_routes segment features
14. 自动计算通过站
15. 找不到 pass_through 时跳过并 warning
16. 生成单 HTML
17. 在 HTML 中显示全量 N02 overlay
18. 按每趟 train 的 route_policy 和 ride_segment 渲染特急路线
```

---

## 19. 数据源错误处理规则

### 19.1 N02 文件缺失

如果缺少 `RailroadSection`：

```text
error
无法构建铁路线路 overlay
无法计算路线
```

如果缺少 `Station`：

```text
error
无法构建站点 overlay
无法可靠匹配停靠站
```

### 19.2 字段缺失

如果 `RailroadSection` 缺少以下字段，应报错：

```text
N02_001
N02_002
N02_003
N02_004
```

如果 `Station` 缺少以下字段，应报错：

```text
N02_001
N02_002
N02_003
N02_004
N02_005
N02_005c
N02_005g
```

### 19.3 geometry 类型异常

如果 `RailroadSection` 不是 LineString 或 MultiLineString：

```text
warning
跳过该 feature
```

如果 `Station` 不是 LineString / MultiLineString / Point：

```text
warning
跳过该 station display point
```

### 19.4 通过站缺失

如果用户提供的通过站无法匹配：

```text
warning
skip pass-through station
```

不得：

```text
阻止导入
阻止列车渲染
用两站直线代替真实路线
```

### 19.5 关键停靠站缺失

如果以下类型无法匹配：

```text
origin
destination
passenger_stop
```

应报错并要求用户补充：

```text
n02_station_code
line name hint
operator hint
```

---

## 20. 数据源与 JSON 的边界

### 20.1 N02 负责什么

N02 负责：

```text
铁路线路 geometry
车站 geometry
铁路类型
事业者类型
路线名
运营公司
站名
N02 station code
N02 group code
```

### 20.2 JSON 负责什么

JSON 负责：

```text
列车 ID
列车名
车次
运行方向
起点
终点
停靠站顺序
通过站顺序
到达时间
出发时间
是否显示
样式
乘坐状态 ride_segment
route_policy
```

### 20.3 构建器负责什么

构建器负责：

```text
读取 N02
匹配 station
构建 rail graph
按 stops 顺序求路径
生成 matched_routes
计算 pass-through stations
生成 report
输出单 HTML
```

### 20.4 前端负责什么

前端负责：

```text
显示 OSM / 无底图 / 本地底图
显示 N02 overlay
显示列车列表
编辑 JSON
导入/导出 canonical store
自动保存到服务器 train-store.json（仅 UI 状态用 localStorage）
根据 ride_segment 调整站点和路线颜色
显示 warnings
根据 station-readings.json 显示站名假名 / 罗马字（placeName 按 n02_station_code 查表，见第二部分 13.4 站名读音表）
```

---

## 21. 推荐在 HTML 中内嵌的数据源元信息

单 HTML 中应保留以下 metadata，便于后续追踪：

```json
{
  "n02_dataset": {
    "id": "N02",
    "name": "国土数値情報 鉄道データ",
    "year": "2025",
    "era_year": "令和7年度",
    "file": "N02-25_GML.zip",
    "reference_date": "2025-12-31",
    "source_agency": "国土交通省",
    "coordinate_system": "JGD2011 / (B, L)",
    "geometry_shape": "line",
    "license": "CC BY 4.0 / オープンデータ",
    "railroad_section_feature_count": 21933,
    "station_feature_count": 10234,
    "formats": ["GML", "Shapefile", "GeoJSON"],
    "preferred_format": "UTF-8 GeoJSON",
    "attribution": "「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成"
  }
}
```

---

## 22. 数据源章节核心要求摘要

1. N02 是铁路基础设施 GIS 数据，不是列车时刻表。
2. N02 铁路线路和车站都是线数据。
3. Station marker 必须由 Station LineString 计算 display point。
4. `N02_001` 是铁道区分。
5. `N02_002` 是事业者种别。
6. `N02_003` 是路线名。
7. `N02_004` 是运营公司。
8. `N02_005` 是站名。
9. `N02_005c` 是 N02 内部駅コード。
10. `N02_005g` 是 300m 内同名站组代码。
11. 全量 N02 模式必须保留 `N02_002 = 1/2/3/4/5`。
12. JR-only 模式只允许 `N02_002 = 1/2`。
13. JSON 不保存 N02 geometry，只保存列车语义数据。
14. matched route geometry 是构建结果，不是 canonical JSON 的一部分。
15. 找不到通过站时跳过并 warning。
16. 找不到关键停靠站时应报错。
17. 禁止使用站点直线 fallback 伪装铁路线。
18. 使用 N02 必须显示国土交通省国土数值情報出典。
19. 使用 OSM 底图必须显示 OpenStreetMap contributors。
20. 不得从 OSM 官方瓦片服务器批量下载离线瓦片。
