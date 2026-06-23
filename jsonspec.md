# N02 Limited Express Train JSON Specification

版本：`1.2`
文件建议名：`TRAIN_JSON_SPEC.md`
适用范围：单 HTML N02 铁路地图、列车 JSON 导入/导出、JR-only 特急路线渲染、乘坐区间显示、停靠站/通过站管理。

---

## 1. 基本原则

本系统只允许一种导入/导出 JSON 顶层格式：

```json
{
  "schema_version": "1.2",
  "trains": []
}
```

不允许导入或导出以下格式：

```json
[
  { "id": "odr_001" }
]
```

```json
{
  "id": "odr_001"
}
```

所有列车数据都必须包在顶层 `trains` 数组内。即使只导出一趟列车，也必须导出为：

```json
{
  "schema_version": "1.2",
  "trains": [
    {
      "id": "odr_001"
    }
  ]
}
```

---

## 2. 顶层 Store 结构

### 2.1 必填字段

| 字段               | 类型     | 必填 | 说明            |
| ---------------- | ------ | -: | ------------- |
| `schema_version` | string |  是 | 当前固定为 `"1.2"` |
| `trains`         | array  |  是 | 列车数组          |

### 2.2 顶层示例

```json
{
  "schema_version": "1.2",
  "trains": [
    {
      "id": "odr_001",
      "number": "踊り子9号",
      "name": "踊り子",
      "origin": "東京",
      "destination": "熱海",
      "direction": "down",
      "visible": true,
      "style": {
        "color": "#d9364f",
        "weight": 6,
        "unridden_opacity": 0.22
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

### 3.1 Train 必填字段

| 字段               | 类型      | 必填 | 说明                              |
| ---------------- | ------- | -: | ------------------------------- |
| `id`             | string  |  是 | 列车唯一 ID                         |
| `number`         | string  |  是 | 车次，例如 `踊り子9号`                   |
| `name`           | string  |  是 | 列车名，例如 `踊り子`                    |
| `origin`         | string  |  是 | 列车运行起点                          |
| `destination`    | string  |  是 | 列车运行终点                          |
| `direction`      | string  |  是 | 方向，推荐 `up` / `down` / `unknown` |
| `visible`        | boolean |  是 | 是否在地图上显示                        |
| `style`          | object  |  是 | 样式设置                            |
| `route_policy`   | object  |  是 | 路线匹配策略                          |
| `route_sections` | array   |  是 | 站间 route section                |
| `stops`          | array   |  是 | 完整停站/通过站数据                      |

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

---

## 4. Style 对象规范

### 4.1 字段

| 字段                 | 类型     | 必填 | 默认值       | 说明           |
| ------------------ | ------ | -: | --------- | ------------ |
| `color`            | string |  是 | `#d9364f` | 正常乘坐区间颜色     |
| `weight`           | number |  是 | `6`       | 正常线宽         |
| `unridden_opacity` | number |  否 | `0.22`    | 非乘坐站/区间淡色透明度 |

### 4.2 示例

```json
"style": {
  "color": "#d9364f",
  "weight": 6,
  "unridden_opacity": 0.22
}
```

---

## 5. Route Policy 规范

### 5.1 字段

| 字段                                     | 类型      | 必填 | 固定/默认                  | 说明                |
| -------------------------------------- | ------- | -: | ---------------------- | ----------------- |
| `mode`                                 | string  |  是 | `single_primary_route` | 每趟列车只允许一条主路线      |
| `jr_only`                              | boolean |  是 | `true`                 | 只使用 JR 数据         |
| `allow_alternatives`                   | boolean |  是 | `false`                | 不允许候选路线并列显示       |
| `allow_browser_straight_line_fallback` | boolean |  是 | `false`                | 禁止浏览器用直线伪装铁路线     |
| `allowed_institution_type_codes`       | array   |  是 | `["1","2"]` 或 `["2"]`  | 允许的 N02_002 事业者种别 |

### 5.2 JR-only 规则

`allowed_institution_type_codes` 只允许以下值：

| 值     | 含义     |
| ----- | ------ |
| `"1"` | JR 新幹線 |
| `"2"` | JR 在来線 |

如果只显示 JR 在来线特急，使用：

```json
"allowed_institution_type_codes": ["2"]
```

如果同时允许新干线和 JR 在来线，使用：

```json
"allowed_institution_type_codes": ["1", "2"]
```

### 5.3 示例

```json
"route_policy": {
  "mode": "single_primary_route",
  "jr_only": true,
  "allow_alternatives": false,
  "allow_browser_straight_line_fallback": false,
  "allowed_institution_type_codes": ["2"]
}
```

---

## 6. Route Sections 规范

`route_sections` 表示相邻站之间的线路区间。它用于辅助前端和构建器匹配已计算的 N02 铁路线 geometry。

### 6.1 字段

| 字段                      | 类型          | 必填 | 说明          |
| ----------------------- | ----------- | -: | ----------- |
| `from`                  | string      |  是 | 区间起点站名      |
| `to`                    | string      |  是 | 区间终点站名      |
| `from_n02_station_code` | string/null |  是 | 起点 N02 駅コード |
| `to_n02_station_code`   | string/null |  是 | 终点 N02 駅コード |

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

---

## 7. Stops 规范

`stops` 是最重要的数据。导出的 JSON 必须包含完整停站数据。

### 7.1 Stop 字段

| 字段                 | 类型          | 必填 | 说明                        |
| ------------------ | ----------- | -: | ------------------------- |
| `name`             | string      |  是 | 站名                        |
| `n02_station_code` | string/null |  是 | N02 駅コード，即 `N02_005c`     |
| `arrival`          | string/null |  是 | 到达时间，格式 `HH:MM`，可为 `null` |
| `departure`        | string/null |  是 | 出发时间，格式 `HH:MM`，可为 `null` |
| `stop_type`        | string      |  是 | 站点类型                      |
| `ride_segment`     | boolean     |  是 | 该站是否处于实际乘坐状态              |

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

### 8.2 每一站都可以 toggle

所有站点都可以设置：

```json
"ride_segment": true
```

或：

```json
"ride_segment": false
```

包括：

```text
origin
destination
passenger_stop
operational_stop
pass_through
```

终点站也可以 toggle，不得强制 disabled。

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

`arrival` 和 `departure` 必须是：

```text
HH:MM
```

或：

```json
null
```

允许跨午夜时间：

```text
24:10
25:30
```

推荐正则：

```text
^([01][0-9]|2[0-9]|3[0-9]):[0-5][0-9]$
```

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

### 11.1 只接受完整 Store

导入 JSON 必须是：

```json
{
  "schema_version": "1.2",
  "trains": []
}
```

### 11.2 导入时追加

导入时不得覆盖当前列车列表。

正确行为：

```text
读取 importedStore.trains
→ 标准化每趟 train
→ 追加到当前 trainStore.trains
→ 如果 id 重复，自动改为唯一 id
→ 保存到 localStorage
→ 自动选中最后导入的列车
```

### 11.3 导入后可编辑

导入后：

```text
点击列车列表中的列车项目
→ 设置 selectedTrainId
→ 编辑区加载该 train
→ 可以编辑基本字段、stops、ride_segment
→ 保存后更新 localStorage 和地图
```

---

## 12. 导出行为

### 12.1 只导出 canonical store

导出 JSON 永远必须是：

```json
{
  "schema_version": "1.2",
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
weight = train.style.weight
opacity = 0.92
dashArray = null
```

### 13.4 淡色区间

任意一端 `ride_segment=false`：

```text
color = train.style.color
weight = max(2, train.style.weight - 1)
opacity = train.style.unridden_opacity || 0.22
dashArray = "4 6"
```

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
schema_version === "1.2"
trains 是 array
trains.length >= 1
```

### 15.2 Train 校验

每趟 train 必须满足：

```text
id 非空
number 非空
name 非空
origin 非空
destination 非空
visible 是 boolean
style 是 object
route_policy 是 object
route_sections 是 array
stops 是 array
stops.length >= 2
```

### 15.3 Stop 校验

每个 stop 必须满足：

```text
name 字段存在
n02_station_code 字段存在，允许 null
arrival 字段存在，允许 null
departure 字段存在，允许 null
stop_type 字段存在
ride_segment 字段存在且必须是 boolean
```

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
  "schema_version": "1.2",
  "trains": [
    {
      "id": "odr_001",
      "number": "踊り子9号",
      "name": "踊り子",
      "origin": "東京",
      "destination": "熱海",
      "direction": "down",
      "visible": true,
      "style": {
        "color": "#d9364f",
        "weight": 6,
        "unridden_opacity": 0.22
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

1. JSON 顶层只能是 `{ "schema_version": "1.2", "trains": [...] }`。
2. 导入时 append，不覆盖现有 trains。
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

### 16.3 离线底图模式

如果需要离线底图，必须使用：

```text
自托管瓦片
合法授权的离线瓦片
明确允许离线使用的瓦片服务
本地 tiles/{z}/{x}/{y}.png
PMTiles
MBTiles 转换结果
```

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
保存 localStorage
根据 ride_segment 调整站点和路线颜色
显示 warnings
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
