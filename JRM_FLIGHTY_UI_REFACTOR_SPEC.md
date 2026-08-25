# JRM × Flighty 界面重构规格与示例代码

> 文档状态：Architecture Draft 2.1 · 2026-08-23  
> 适用范围：JRM Web 与原生 iOS 客户端  
> 本阶段交付：规格与示例代码；**不修改产品代码、不新增数据字段、不改变 JSON 1.3 合约**

阅读顺序：第 0–2 节定义产品与完整信息架构，第 3–10 节定义各页面和行为，第 11–12 节是非生产补丁性质的参考代码，第 14 节是验收清单，第 15 节仅描述下一阶段可能的实施切片。出现冲突时，以产品边界、架构树、状态优先级和验收条件为准，示例代码为辅。

文档导航：

- 第 0–3 节：设计结论、边界、完整产品架构、任务状态机与信息优先级。
- 第 4–5 节：响应式空间架构与逐屏规格。
- 第 6–10 节：视觉、组件、操作、动效和可访问性。
- 第 11–12 节：SwiftUI 与 Web 示例代码。
- 第 13–17 节：状态文案、验收、后续切片与评审问题。

## 0. 结论先行

JRM 不应复制 Flighty 的截图、蓝色或卡片皮肤。JRM 应复制 Flighty 更有价值的部分：

1. 当前任务决定信息层级，而不是固定页面决定信息层级。
2. 一屏只回答一个主问题。
3. 地图回答“在哪里”，面板回答“这是什么、现在能做什么”。
4. 正常状态安静，异常状态改变层级，而不只是改变颜色。
5. 复杂路由、导入和统计结果先压缩成可信摘要，再逐层展开。
6. 系统导航和控件保持平台原生；品牌主要体现在行为、信息组织和铁路数据中。
7. 记录与编辑阶段保持克制；统计、回放和分享阶段可以更有纪念性与表现力。
8. 全局颜色使用 iOS 系统语义色与默认 Liquid Glass 色彩响应，不建立纯黑专用皮肤。
9. 窄屏采用一张不可下滑关闭的常驻系统 Sheet；Sheet 在底栏态、半屏、满屏之间拖动，并同时承担底部导航与内容面板。

### 0.1 已锁定的底部架构

本节优先级高于文档内的历史研究和示例。目标 iOS 界面必须满足：

```text
一张持续挂载的共享地图
└── 一张常驻系统 Sheet（不可关闭、无可见 Grabber）
    ├── 当前工作区的左上大标题与右上功能按钮（只在 Half/Full 显示）
    ├── 当前工作区内容
    └── [未来] [统计] [全部]    [系统 Search]
```

- Tab 1 是 `Upcoming / 未来行程`。
- Tab 2 是 `Passport / 统计`。
- Tab 3 是 `All Journeys / 全部行程`。
- 最右侧 `+` 是独立的加入线路按钮，不是第四个 Tab，也不持有选中状态。
- 系统 Sheet 自身就是收起时的底栏和展开时的内容面板；不得在 Sheet 外再放一条系统或自定义 Tab Bar。
- Sheet 隐藏系统 Drag Indicator，但整个非交互头部区域仍可直接拖动；iOS 不实现第二套 `DragGesture`。
- 三个 Tab 共用同一个地图 View、MapKit coordinator、相机状态和路网数据源。Tab 切换只更新图层投影、筛选、选中状态与面板内容，不销毁或重建地图。
- Passport 不得再创建或嵌入一张小地图。覆盖率、已乘线路和选中统计范围直接投影到三个 Tab 共用的底图。
- Network 不再是一级 Tab。完整路网浏览作为共享地图的 `Network mode`，从 All Journeys 的右上功能按钮和地图图层按钮进入；原有路网功能必须完整保留。

JRM 的目标公式是：

```text
presentation = resolve(
    workspace,
    currentTask,
    selection,
    routeState,
    persistenceState,
    playbackState,
    viewport,
    accessibilityPreferences
)
```

而不是：

```text
presentation = fixedScreen + moreCards + moreButtons
```

---

## 1. 规范用语与边界

本文使用以下约束词：

- **MUST / 必须**：验收条件，偏离即不符合本规格。
- **SHOULD / 应该**：默认实现；偏离时需要记录理由。
- **MAY / 可以**：允许的实现选择。

### 1.1 必须保留的产品定义

JRM 是铁路旅程记录、编辑、路网可视化、覆盖统计和回放工具，不是实时列车服务。

因此本轮重构：

- 必须保留 JSON schema 1.3 以及现有导入/导出语义。
- 必须保留日本、台湾、香港、澳门、韩国的独立数据域。
- 必须保留日期分组、列车搜索、编辑、显示/隐藏、路线求解、统计、数据管理和回放能力。
- 不得暗示提供实时发车、票价、延误、实时站台变更、订座或运营保证；仅可在记录中确有 `platform_number` 时显示静态站台编号，`null` 必须隐藏。
- 不得为了“像 Flighty”而虚构 `on time`、`delay`、`live`、`platform changed` 等状态。
- 不得以直线代替失败的铁路路线并伪装成成功结果。
- 不得把 `Color.black`、`#000000`、`#0B0B0F` 等固定纯黑值作为 App 主背景或 Flighty 风格捷径。
- iOS 默认跟随系统浅色/深色外观；所有 chrome、文字、填充、分隔线和状态优先使用系统语义角色。
- iOS 26/27 使用系统 Liquid Glass 的默认取色、折射与交互表现，不手绘一套假玻璃皮肤。

### 1.2 两个平台的关系

本规格是行为和信息架构的共同标准，不要求 Web 与 iOS 像素级一致。

- iOS 以 SwiftUI、MapKit、`NavigationStack`、`Toolbar`、`Form`、常驻系统 Sheet 和系统 `TabView` 为原生表达。`TabView` 位于 Sheet 内；iOS 26/27 使用 `Tab(role: .search)` 自动生成右侧分离的 Liquid Glass Search，禁止重画系统 Tab Bar。
- Web 复用同一套语义、状态名称、信息优先级和动效意图，使用 DOM、CSS、MapLibre 与现有 classic-script 模块边界实现。
- `RailCore` 继续只承载平台无关的业务逻辑，不得导入 SwiftUI、MapKit、UIKit 或 CoreLocation。
- 展示状态解析应位于平台展示层；可纯函数化的共同业务推导才进入 `RailCore`。

### 1.3 明确不做

本规格不包含：

- 实时列车 API、推送、Live Activity 或 Dynamic Island 的产品实现。
- 新的云同步服务。
- 新的行程规划、购票或导航功能。
- 地图铁路数据和路线求解算法重写。
- 对现有用户数据进行迁移。
- 用固定深黑背景、航空术语或机场符号替换 JRM 的铁路身份。

---

## 2. JRM 完整产品架构

### 2.1 目标导航树

Flighty 的结构价值在于把“当前任务”“历史回顾”“基础设施情报”和“账户/设置”分开。JRM 采用同样的职责分层，但只放入当前代码和数据模型真实支持的能力。

```text
JRM
│
├── Upcoming / 未来行程                         [Sheet Tab 1]
│   ├── Journey Map / 旅程地图
│   │   ├── 当前地区铁路网络
│   │   ├── 已乘路线与所选路线高亮
│   │   ├── 端点、停站、通过站、跨日标记
│   │   ├── 站名、双语/多语读音与站点弹窗
│   │   ├── 图层、定位路线、缩放、指南针、当前位置
│   │   └── 自动聚焦与所选日期地图过滤
│   ├── Upcoming Journey List
│   │   ├── 今天 / 未来日期筛选
│   │   ├── 新增日期 / 删除空日期
│   │   ├── 搜索车次、车站、车种、运营方或 ID
│   │   └── 示例数据 / 我的数据来源状态
│   ├── Search / Add Journey
│   │   ├── 新增旅程草稿
│   │   ├── 车站搜索与选择
│   │   └── 从 JSON 导入入口
│   └── Journey Detail / 旅程详情
│       ├── Route Status / Visibility
│       ├── Locate on Map
│       ├── Playback / Video Share
│       ├── Journey Metadata
│       ├── Service / Operator / Train Type
│       ├── Origin / Destination / Cross-day Time
│       ├── Detailed Stop Timetable
│       ├── Ridden / Not-ridden Segments
│       ├── Route Policy / Route Sections
│       ├── Rebuild Route / Resolution Updates
│       └── Edit / Duplicate / Reorder / Delete
│
├── Passport / 统计                              [Sheet Tab 2]
│   ├── All-Time / Day Scope
│   ├── Shared Map Coverage Mode（复用全局底图，不嵌入小地图）
│   ├── Mileage & Coverage Statistics
│   │   ├── 总里程、乘车时间、旅程数、出行日、停站数
│   │   ├── 新干线 / JR 在来线 / 地铁 / 私铁 / 路面电车
│   │   ├── 每类别覆盖率
│   │   ├── 每线路明细
│   │   └── 最常乘坐区间
│   ├── Journey Log / 按日期旅程记录
│   ├── Playback / Journey Replay
│   ├── Video Export
│   │   ├── 画幅
│   │   ├── 质量
│   │   ├── 码率
│   │   └── Share / Download
│   └── JSON Export 入口
│
├── All Journeys / 全部行程                      [Sheet Tab 3]
│   ├── All / By Date Journey List
│   ├── Past / Today / Future Scope
│   ├── Search / Filter / Select
│   ├── Journey Detail / Edit / Duplicate / Reorder / Delete
│   ├── Playback / Export / Share
│   └── Network Mode                              [Shared-map mode]
│       ├── National / Regional Network Map
│       ├── Country Switch: JP / TW / HK / MO / KR
│       ├── Zoom-tiered Lines / Display Parts
│       ├── Official Light / Dark Line Colours
│       ├── Station Dots / Role-tiered Labels
│       ├── Station Detail / Readings / Operator Badges
│       ├── Endpoint Labels / Collision Layout
│       ├── Basemap Opacity / No-basemap Degradation
│       └── Network Package Status / Diagnostics
│
├── Search / Add Journey / 搜索与加入线路          [系统 Search Tab]
│   ├── 新增旅程草稿
│   ├── 车站搜索与选择
│   ├── 停站 / 路线策略 / Route Sections
│   └── 从 JSON 导入入口
│
├── Data Library / 数据库                        [Toolbar destination]
│   ├── Current Source / Storage Status
│   ├── Import
│   │   ├── Open JSON File
│   │   ├── Paste JSON
│   │   ├── Replace / Append Mode
│   │   ├── Validation / Preflight
│   │   ├── Add / Replace / Keep / Rename Summary
│   │   ├── JSON-path Issues
│   │   └── Progressive Import / Cancel / Completion
│   ├── Export
│   │   ├── Export / Save JSON
│   │   ├── Copy JSON
│   │   ├── Download JSON (Web)
│   │   ├── Download Current HTML (Web only)
│   │   └── Raw JSON Preview
│   ├── Samples
│   │   ├── Country-specific Samples
│   │   ├── New Year Grand Loop
│   │   └── Tokyo Limited Express Loop
│   ├── My Data
│   │   ├── Save as My Data
│   │   ├── Restore My Data
│   │   └── Local / Server Persistence Status
│   ├── Recovery Backup
│   ├── Railway Package Availability
│   └── Danger Zone
│       ├── Delete Saved Data
│       ├── Delete All Journeys
│       ├── Reset to Sample
│       └── Clear Storage
│
└── Settings / 设置                              [Toolbar/Profile destination]
    ├── Region & Language
    ├── Station Name Readings
    │   ├── Kana
    │   ├── Romaji
    │   └── Chinese names
    ├── Appearance
    │   ├── System
    │   ├── Light
    │   └── Dark
    ├── Map Content
    │   ├── Complete Rail Network
    │   ├── Frame Loaded Network
    │   ├── Basemap Opacity
    │   └── Renderer Information
    ├── Journey Lines
    │   ├── Line Width
    │   └── Ridden Segment Opacity
    ├── Station Markers
    │   ├── Terminal Size
    │   ├── Stop Centre Size
    │   ├── Stop / Pass-through Outer Size
    │   └── Marker Border Width
    ├── Selection & Focus
    │   ├── Selection Width Boost
    │   ├── Off-date Dimming
    │   └── Full Cross-day Runs
    ├── Reset Display Defaults
    └── Diagnostics
```

### 2.2 一级入口规则

常驻系统 Sheet 的系统 TabView 放三个普通 Tab 和一个语义 Search，顺序固定：

```text
未来 / Upcoming    统计 / Passport    全部 / All Journeys    [Search]
```

原因：

- 三项分别回答“接下来乘什么”“我乘过多少”“查看全部记录”，是三个反复浏览的内容视角。
- Search 使用 `Tab(role: .search)`，由系统放在最右独立圆形中；加入线路/新增旅程是 Search/Add 页面的主操作。
- `Network` 是共享地图的显示模式，不再占一级 Tab；它从 All Journeys 右上功能按钮或地图图层按钮进入。
- `Data Library` 是数据所有权与迁移任务，从三个工作区右上方的数据库按钮进入。
- `Settings` 是全局偏好，从顶部头像/齿轮入口进入。
- 底部选择器不放 `Network`、`Editor`、`Playback`、`Import` 等模式或临时任务。

当前 `ios/RailMap/AppShell.swift` 的四个 Tab 是 `Rides / Statistics / Data / Settings`。目标重构映射为：

| 当前 | 目标 | 处理 |
| --- | --- | --- |
| Rides | Upcoming + All Journeys | 以当前日期为界拆成未来视角和全部记录视角；共享同一 store、详情、编辑与回放 |
| Statistics | Passport（Tab 2） | 改名并加入旅程日志、覆盖模式与分享入口；不创建统计小地图 |
| Data | Data Library | 从 Tab 移到 Toolbar destination，功能完整保留 |
| Settings | Settings | 从 Tab 移到全局 Toolbar/Profile destination |
| 当前 Rides 内完整路网 | Shared-map Network mode | 从 All Journeys 右上按钮/地图图层进入，保留全部路网能力但不占 Tab |

Web 在窄屏使用同一三项底栏；宽屏可以将三项作为 Sidebar 主导航，并把 Data/Settings 固定在 Sidebar 底部的 Utility 区。

### 2.3 Flighty 页面族到 JRM 的职责映射

| Flighty 页面族 | JRM 对应 | 说明 |
| --- | --- | --- |
| My Flights | Upcoming + All Journeys | 未来任务与完整日志两个视角，共用地图、搜索/新增和状态驱动详情 |
| Flight Detail | Journey Detail | 路线状态、时刻、服务、停站、回放、编辑 |
| Passport | Passport（统计） | 全时段/单日统计、共享地图覆盖模式、日志、回放与分享 |
| Airports | Shared-map Network mode | 基础设施情报从机场改为铁路网络、线路和车站，不占一级 Tab |
| Profile | Data Library + Settings | JRM 没有账户，按“数据所有权”和“偏好”拆开 |
| Imports | Data Library / Import | 只支持现有 JSON 文件、粘贴和本地/服务端路径 |
| Live Share | Playback Video Share | 只能分享回放视频/导出文件，不得称为实时分享 |
| Alternatives | Route Policy / Alternatives | 仅指求解器允许的路线候选与约束，不是替代车次推荐 |
| Where's My Plane? | Locate / Playback | 对应“这趟旅程在地图哪里”和逐段回放，不跟踪真实车辆 |
| Aircraft | Service Metadata | 仅展示现有车种、运营方、方向，不虚构车辆编组与车号 |
| Detailed Timetable | Stop Timeline | 到发时间、停站类型、乘坐状态、跨日时间 |
| Updates | Route / Import / Save Status | 只显示本地任务更新，不伪装实时运营 feed |

### 2.4 明确不映射的 Flighty 功能

以下 Flighty 分支在当前 JRM 代码、schema 1.3 或数据源中不存在。本轮架构不创建空入口：

| Flighty 功能 | JRM 处理 |
| --- | --- |
| Friends / Friend Flights / Friend Filter | 不映射；没有账户、所有权或社交模型 |
| Live flight status / delay / cancellation / diversion | 不映射；JRM 不是实时班次服务 |
| Delay Prediction / Airport Disruptions / Weather | 不映射；无实时运营和天气数据源 |
| Connection Assistant | 不映射；无换乘风险、国籍、行李、安检模型 |
| Physical aircraft assignment / tail number | 不映射；`train_type` 不是车辆实时实体 |
| Alternative departures / rebooking | 不映射；route alternatives 只用于铁路路径求解 |
| Alerts / notifications / Live Activities / Widgets | 不映射；当前项目无推送或 ActivityKit target |
| Calendar / TripIt / Email import | 不映射；当前导入合约是 JSON schema 1.3 |
| iCloud sync / account / subscription / Pro | 不映射；当前是本地文件、IndexedDB 或本地 server 数据 |
| Favorite airports/routes | 不映射；当前没有收藏数据模型 |

任何未来新增都必须先扩展产品与数据合约，不能只增加一个看起来可点击但没有可信数据的卡片。

### 2.5 现有代码功能覆盖表

| 架构节点 | Web 代码 | iOS 代码 | 当前状态 |
| --- | --- | --- | --- |
| Journeys Map | `railmap.js`, `app-map-*`, `app-route-render.js` | `RailMapView.swift`, `MapControlBar.swift`, `RiddenRouteStore.swift` | 两端可用 |
| Date/Search/List | `app-render.js`, `app-dates.js` | `ContentView.swift`, `ItineraryStore.swift` | 两端可用 |
| Journey Detail | `index.html`, `app-editor.js` | `RideCard.swift`, `RideDetailView.swift`, `JourneyComponents.swift` | 两端可用 |
| Journey Editor | `app-editor.js`, `app-store-ops.js` | `RideEditorView.swift`, `ItineraryStore.swift` | 两端可用；iOS 核心字段内联校验 |
| Route Solver | `app-route-*`, `rail-network.js` | `RailCore/RouteSolver.swift`, `RiddenRouteStore.swift` | 两端可用，无直线 fallback |
| Network | `rail-network.js`, `app-display-features.js` | `RailNetworkStore.swift`, `RailMapView.swift`, `DisplaySettings.swift` | 两端可用 |
| Passport Statistics | `app-stats.js`, `app-stats-render.js` | `StatisticsView.swift`, `MileageStatisticsStore.swift` | 两端可用 |
| Playback | `app-playback.js` | `PlaybackController.swift` | 两端可用 |
| Video Export | `app-playback-video.js` | `PlaybackVideoExporter.swift`, `VideoExportOptionsView.swift` | 两端可用，平台实现不同 |
| Data Import | `app-import.js`, `app-validation.js` | `DataImportView.swift`, `ImportFlow.swift` | 两端可用，含预检与分段进度 |
| Data Export/Recovery | `app-persistence.js`, `app-store-ops.js` | `DataManagerView.swift`, `RideLibrary.swift`, `TrainStoreDocument.swift` | 两端可用 |
| Settings/Localization | `app-display-settings.js`, `i18n-strings.js` | `SettingsView.swift`, `AppLocalization.swift`, `DisplaySettings.swift` | 两端可用 |

平台特有但必须保留：

- Web：Hover 行为、下载当前 HTML、server autosave/SSE live refresh、强制 UI mode。
- iOS：MapKit Compass、当前位置、原生文件选择器/分享、窗口形状自适应、AVAssetWriter 视频导出。
- iOS 不需要移植 Web 的 hover fan、下载 HTML、server SSE 和 UI-mode override。

### 2.6 JRM 的任务状态机

Flighty 的核心是航班状态机；JRM 的核心是任务状态机：

```text
loading
  ├─ failed
  └─ browsing
       ├─ filtering
       ├─ selected
       │    ├─ locating
       │    ├─ resolvingRoute
       │    ├─ playing
       │    └─ editing
       │          ├─ invalidDraft
       │          ├─ saving
       │          └─ selected
       ├─ importing
       │    ├─ preflight
       │    ├─ importFailed
       │    └─ selected | browsing
       ├─ calculatingPassport
       └─ empty
```

状态可以并行，但界面必须解析出唯一主任务。例如路线正在求解时，回放不能假装可用；`resolvingRoute` 的阻塞原因必须成为主状态。

### 2.7 一屏一问

| 工作区/状态 | 屏幕必须优先回答的问题 |
| --- | --- |
| Journeys | “我要找的是哪一次乘车，它在地图哪里？” |
| Journey Detail | “这趟车从哪里到哪里，记录是否完整？” |
| Network | “这个地区有哪些铁路、线路和车站？” |
| Passport | “我乘坐了多少，覆盖了哪些铁路？” |
| Data Library | “当前数据来自哪里，是否安全保存？” |
| Settings | “这些选项会改变地图、界面还是数据？” |
| 路线处理中 | “JRM 正在做什么，我是否需要操作？” |
| 路线失败 | “为什么没有画出来，下一步怎么修？” |
| 编辑器 | “哪些字段需要修正才能保存？” |
| 回放 | “现在走到哪里，接下来是哪一站？” |

任何元素如果不能帮助回答当前主问题，应下沉一级、进入菜单/Disclosure，或从当前状态隐藏。

---

## 3. 信息优先级模型

### 3.1 五层信息

| 层级 | JRM 内容 | 表现 |
| --- | --- | --- |
| L0 阻断/风险 | 导入失败、路线无法解析、未保存且将丢失、删除确认 | 占据 Hero 或紧邻 Hero；清楚说明原因和恢复操作 |
| L1 当前动作 | 定位、继续编辑、修复路线、播放/暂停、保存 | 每个状态最多一个 Prominent 主操作 |
| L2 旅程身份 | 车次、起终站、日期、出发/到达时间 | 首屏可扫读；数字使用等宽数字 |
| L3 运行上下文 | 停站时间线、运营方、车种、方向、乘坐区间 | 主内容；可滚动 |
| L4 高级元数据 | 记录 ID、route policy、route sections、原始 JSON、数据来源细节 | 二级页面、Disclosure 或高级设置 |

硬性规则：

- L4 不得压过 L1。
- 错误不得仅以 toast 呈现后消失；会阻断任务的错误必须留在对应内容旁。
- 颜色只能作为状态的第二编码，第一编码必须是文本或符号与文本组合。
- 同一表面最多出现一个填充强调的主按钮。

### 3.2 旅程摘要的扫描顺序

标准旅程摘要顺序：

```text
1. 车次 / 服务名称
2. 起站 → 终站
3. 出发 → 到达时间
4. 日期、车种、运营方
5. 路线/可见性状态
6. 高级记录信息
```

不得把记录 ID 放在车次之前，不得把运营方或路线约束做成比起终站更大的标题。

### 3.3 动态主操作

主操作不是固定的“播放”。它必须由状态决定：

| 状态 | 主操作 | 次要操作 |
| --- | --- | --- |
| 已选择且路线可用 | 定位路线 | 播放、编辑 |
| 正在回放 | 暂停/继续 | 停止、速度 |
| 记录被隐藏 | 在地图显示 | 编辑、更多 |
| 路线缺失或失败 | 检查并重建 | 编辑停站、查看原因 |
| 编辑草稿有效 | 保存 | 取消 |
| 编辑草稿无效 | 无 Prominent 按钮；保存禁用 | 首个错误字段获得焦点 |
| 导入预检通过 | 导入 | 取消、查看摘要 |
| 导入失败 | 修正输入/重新选择文件 | 查看详细错误 |

---

## 4. 导航与空间架构

### 4.1 顶层导航

iOS 26/27 使用一张常驻系统 Sheet。Sheet 内的系统 `TabView` 固定以下入口：

1. 未来行程 / Upcoming
2. 统计 / Passport
3. 全部行程 / All Journeys
4. Search / 搜索与加入线路（语义 `Tab(role: .search)`）

`Data Library` 与 `Settings` 使用各工作区右上角一致的 Utility 入口。Data 使用 `externaldrive`/`tray.full` 一类数据库语义符号，Settings 使用头像或 `gearshape`；两者打开独立 `NavigationStack`，不占底部选择器。

Web 窄屏使用同样的三工作区顺序与分离 Search/Add 入口；宽屏 Sidebar 顶部放 Upcoming/Passport/All Journeys/Search，底部 Utility 区放 Data/Settings。现有 Web 的 Trains/Editor/Statistics/Data/Display 导航按职责合并：Editor 进入 Journey Detail，Statistics 改为 Passport，Display/Network 成为共享地图模式与 Settings 分区。

顶层规则：

- Sheet 内的四个语义 Tab 负责内容视角切换，左上大标题说明当前视角，右上功能按钮负责当前视角的操作。
- 切换 Tab 必须保留每个工作区的导航、滚动和筛选状态。
- Data/Settings 被关闭后必须返回原 Tab、原导航路径与原滚动位置。
- 地图控件只控制地图，不得混入数据导入、删除或编辑操作。
- “定位所选路线”和“定位当前位置”必须是两个不同控件和两个不同可访问性标签。
- 常驻系统 Sheet 是最高功能层；Sheet 外只保留共享地图与地图控件。唯一的系统 Tab Bar 位于 Sheet 内。
- Sheet 收起时只露出缩小标题行与系统 Tab Bar；半屏和满屏时 Tab Bar 仍固定在 Sheet 底部。按钮、列表最后一行和滚动指示器必须避开这一区域与 Home Indicator。
- iOS 26/27 最右侧必须使用语义 `Tab(role: .search)`；系统负责将其与三个普通 Tab 分离。加入线路作为 Search/Add 页面的主操作及其 Half/Full 右上 `+`，不得伪装成第四个动作 Tab。

### 4.2 地图、信息面板、功能层

JRM 采用三层模型：

```text
┌──────────────────────────────┐
│ Functional layer             │  常驻系统 Sheet、右上按钮、地图按钮
├──────────────────────────────┤
│ Information layer            │  旅程列表、选中旅程、编辑与状态
├──────────────────────────────┤
│ Spatial layer                │  底图、铁路网络、乘坐路线、站点
└──────────────────────────────┘
```

规则：

- 地图是三个工作区共用的持续空间上下文，不是装饰性头图；生命周期必须独立于 Tab 选择。
- 信息面板覆盖地图时，地图仍应保留足够可辨认的空间。
- 地图上不得同时漂浮大量独立按钮；相关按钮必须组合。
- 上拉菜单外壳使用 iOS 26/27 默认 regular Liquid Glass；内容区域使用系统背景层级保证可读性，不自定义纯黑或强着色玻璃。
- Liquid Glass 或 Web translucent material 用于系统导航、悬浮功能层与菜单外壳，不逐张铺满内部内容卡片。
- 不得叠放两个浅色半透明大表面。

### 4.3 响应式布局

#### iPhone 竖屏 / Web 窄屏

```text
┌──────────────────────────┐
│ Shared Map               │
│                  [controls]
│                          │
│  ╭────────────────────╮  │  ← 12–16 pt/px edge margin
│  │ Large title  [actions]│
│  │ Hero/list/stats    │  │
│  │ [未来][统计][全部] [搜索]│
│  ╰────────────────────╯  │
└──────────────────────────┘
```

- 常驻系统 Sheet 必须有 Docked、Half、Full 三个语义停靠点；它们对应实现中的 Compact、Medium、Expanded。
- Docked（底栏态）只显示缩小的当前页标题、右侧功能按钮和系统 Tab Bar：三项普通 Tab 与右侧分离 Search；不得显示 Grabber、正文或被裁切的页面残影。高度由缩小标题行、系统 Tab Bar 标准区域与安全区组成，不测量或重画系统 Tab 内部控件。
- Half（半屏）默认占可用高度的 50–58%；辅助功能大字号可增至 68–76%。
- Full（满屏）使用系统 `.large` Detent；由系统 Sheet 连续放大并填满可用屏幕，不手写 margin/圆角插值。三档菜单内容区统一使用同一个实体 iOS 系统色，并固定按 base interface level 解析：亮色为 `systemBackground` 白色，暗色为 `secondarySystemBackground`（约 `#1C1C1E`）灰色；菜单 Sheet 不使用 Liquid Glass，只有系统 Tab Bar、选中镜片与分离 Search 保留 Liquid Glass。
- Full 状态可覆盖共享地图；返回 Half/Docked 后必须显露同一个地图实例和原相机状态。
- Sheet 底部选择器下方只保留 Home Indicator 所需安全区；滚动内容增加 `bottomSelectorHeight + safeAreaBottom + 12pt` 的净空。
- Z 顺序固定为 `persistent system Sheet > shared map controls > shared map`。
- Docked/Half 的 12–16 pt 外边距、悬浮圆角与 Full 的满屏过渡由 iOS 26/27 系统 Sheet 提供，项目不得用第二层卡片模拟。
- 面板把地图控件完全遮住前，应隐藏对应控件，而不是让按钮看起来可用却无法点击。
- Sheet 不显示 Pull Bar；系统 Sheet 的非交互头部、标题周围空白与内容背景仍可开始垂直拖动。右上按钮的点击区域不得被拖动热区覆盖。
- Half 与 Full 的正文滚动独立于 Sheet 高度：列表或 ScrollView 内的纵向手势必须优先滚动内容，不得先把 Half 推到 Full；拖动固定标题区仍可切换 Detent。

#### 三段式菜单状态表

| 状态 | 顶部位置/可见高度 | 首要内容 | 地图交互 |
| --- | --- | --- | --- |
| Docked / 底栏态 | 系统 compact Sheet；缩小标题行加系统 Tab Bar | 缩小标题、右侧功能按钮与 `[未来][统计][全部] [Search]`；无正文或 Grabber | 完整可用 |
| Half / 半屏 | 屏幕约 42–50% 处起始 | 左上大标题、右上功能按钮、Hero/统计/列表、底部选择器 | 未被遮挡区域可用 |
| Full / 满屏 | 系统 `.large` | 完整内容可滚动；标题与底部选择器常驻 | Sheet 覆盖地图；控件隐藏 |

`Half` 的百分比以窗口可用高度而非系统 Sheet 的内部可用高度计算，避免不同设备漂移。

#### iPhone 横屏 / iPad / Web 宽屏

```text
┌──────────────────┬──────────────────────────┐
│ Sidebar/panel    │ Map                      │
│ 360–480 pt/px   │                 [controls]
│                  │                          │
└──────────────────┴──────────────────────────┘
```

- 以窗口形状和可用空间决定布局，不以设备名称硬编码。
- 面板建议宽度：iOS 360–440 pt；Web 400–520 CSS px，可在安全范围内调整。
- 地图最小可用宽度建议 420 pt/px；低于该值转为覆盖式面板。
- Sidebar 内的列表和详情应使用原生/平台惯用导航，不堆叠两块半透明面板。

### 4.4 面板导航与状态保存

- 从列表打开旅程详情时，列表必须保留搜索词、日期、滚动位置和展开状态。
- 返回列表时应回到原旅程附近，而不是回到列表顶部。
- Half 与 Full 不应交换为两套完全不同的头部；左上大标题、右上功能按钮和当前内容身份应保持连续。
- 关闭选中旅程等于返回列表，不等于清空日期筛选。
- 点击地图空白的逐级行为：关闭弹层 → 清除旅程选择 → 如当前为单日筛选则回到全部。每次点击只退一级。

---

## 5. 架构页面规格

## 5.1 Upcoming / 未来行程（Tab 1）

Upcoming 是 Flighty `My Flights` 的未来任务视角，也是默认启动页。共享地图持续挂载，常驻系统 Sheet 在 Upcoming List 与 Journey Detail 之间切换。列表只纳入今天尚未结束和未来日期的记录；历史记录仍保存在同一 store，并在 Tab 3 的 All Journeys 中出现。

### 5.1.1 Journey Map + List

主问题：**我要找的是哪一次乘车？**

### Half / Full 首屏结构

```text
[未来行程]                 [搜索] [筛选/更多]
[今天] [2026-08-24] [2026-08-25] …
[Search journeys…]

12 upcoming journeys · 4 days

┌──────────────────────────────┐
│ 踊り子 1号              09:00 │
│ 東京 → 伊豆急下田             │
│ 2026-07-03 · 特急             │
└──────────────────────────────┘
```

Compact/Docked 状态留下缩小标题行与系统 `[未来][统计][全部] [Search]`，不挂载正文。Search/Add 在三档标题行的右上角提供 `+` 主操作；其他页面右上角只放筛选、播放、数据库或设置等当前页面功能。

### 规格

- 日期筛选和搜索是列表的一级控件；“新增日期”“删除空日期”等低频动作进入日期菜单。
- 日期筛选必须与共享地图同步：默认显示所有未来可见旅程，单日只强调该日记录；“在地图显示当前日期”沿用现有状态，不另造第二个筛选源。
- 统一目标搜索字段为记录 ID、车次/班次名称、日期、方向、起终站、途中站、车种与运营方；当前 iOS 已覆盖除日期/方向外的字段，Web 已覆盖全部，重构时补齐 iOS parity。搜索结果与地图选择使用同一记录 ID。
- 列表摘要必须显示车次、起终站和首个有效出发时间。
- Upcoming 的跨日列表必须显示日期；单日视图可降低日期权重。
- 隐藏记录使用文字 `已从地图隐藏` 或眼睛斜杠符号与可访问性标签，不降低整卡 opacity 到难以阅读。
- 无搜索结果时保留搜索输入，并提供“清除搜索”。
- 完全无记录时只提供一个主操作：`新增旅程` 或 `导入 JSON`，根据数据来源上下文决定；另一个作为次要链接。
- 列表不得在每行暴露删除、复制、上下移动等全部操作；使用 Swipe、Context Menu 或 More Menu。
- 现有新增、复制、删除、显示/隐藏与重排能力全部保留；破坏性操作不得因收进 More Menu 而失去确认或撤销语义。
- 日期可新增；空日期可删除；非空日期的删除必须明确说明对记录的影响，不以“整理日期”为名隐式删除旅程。
- 现有样例数据、My Data 与导入入口属于数据来源，不混进每张旅程卡；首屏空状态可给一次上下文入口，常规入口统一放 Data Library。

### 地图能力

Journeys 地图必须保留当前项目的完整能力，而不是缩减成 Flighty 式背景图：

- 显示所选国家/地区的铁路网络、乘坐路线、路线 casing、起终点与停站/通过站 marker。
- 支持按日期过滤的路线高亮、隐藏记录、选择增宽、非当前日期淡化，以及跨日完整运行显示设置。
- 保留 zoom LOD、Display Parts、官方浅色/深色线路色、站点圆点/站名、端点标签与底图透明度。
- 站点弹层同时容纳网络身份与所选旅程到发信息，并明确区分静态数据和旅程记录。
- 地图操作至少包含适配当前选择、适配完整网络、当前位置/罗盘等当前平台已有能力；“定位路线”和“定位当前位置”必须分开。
- Web 保留重叠线路 hover fan；iOS 遵循当前平台差异，不发明 hover 的触摸替身。
- 底图不可用时，本地铁路包与旅程路线仍可浏览；路网包不可用时给出诊断、重试与 Data Library 入口。

### 列表状态

| 状态 | 菜单内容 | 地图响应 |
| --- | --- | --- |
| Loading | 骨架只模拟真实行高；保留日期栏 | 保留已加载图层，不闪白 |
| Empty data | `新增旅程` 为主操作，导入为次操作 | 显示网络上下文 |
| Empty search | 搜索词、结果为零、`清除搜索` | 不清除当前日期 |
| Selected | 选中卡保持 selected trait，转入 Journey Hero | 路线增宽并可定位 |
| Route unavailable | 卡片保留记录并显示问题摘要 | 不画直线替代 |

### 日期 Hero

日期视图的摘要可显示：

```text
2026年7月3日
4 趟旅程 · 612.4 km
```

若距离尚未计算，只显示已知事实，不使用占位数字伪装结果。

### 5.1.2 Selected Journey Hero

主问题：**这趟车从哪里到哪里，地图上是哪一条？**

### Docked / 底栏态

Docked 状态显示缩小标题行、系统 Tab Bar 与分离 Search。用户将 Sheet 拉到 Half 后才显示选中旅程 Hero；地图上的选中路线在 Docked 时继续保留。

### Half / Full Hero

```text
[2026-07-03 · 特急]                […] [×]
踊り子 1号

東京                         伊豆急下田
09:00            →              11:40

[定位路线]       [播放]       [编辑]
```

### 规格

- `定位路线` 是路线可用时的默认主操作。
- 时间必须使用等宽数字；过夜时间 `25:10` 保持原始业务含义，不擅自格式化为另一日期而丢失上下文。
- 起终站名称允许换行，不能为了单行而缩小到不可读。
- 辅助功能大字号下，起终站改为上下布局，箭头改为向下。
- 车种、运营方、方向在 Hero 下方或详情，不与车次抢层级。
- 日期 Chip 是返回该日期列表的空间线索，不只是装饰标签。
- 更多菜单包含显示/隐藏、复制、排序与删除；删除放在最后且为 destructive role。

### 状态放大

正常时不显示“路线正常”绿色徽章。只有需要解释时显示状态：

```text
正在重建路线…  7 / 12 区间
```

```text
路线需要检查
未能在「大船 → 藤沢」之间找到符合约束的铁路路径。
[编辑停站] [查看路线约束]
```

```text
已从地图隐藏
[在地图显示]
```

### 5.1.3 Journey Detail

主问题：**这次乘车的完整记录是什么？**

顺序必须为：

1. 旅程身份
2. 起终站与时间
3. 停站时间线
4. 路线状态或需要处理的问题
5. 运营信息
6. 高级记录信息

建议结构：

```text
Identity hero
Route timing
Stop timeline
Ride coverage / route state
Operator and service metadata
Advanced record disclosure
```

不得默认把 `id`、`route_policy`、`route_sections` 展开在 Hero 附近。

### 详情功能与 Flighty 语义映射

Flighty 的详情模块只能按 JRM 的真实数据语义映射；同名但无数据支撑的模块不得出现空卡片：

| Flighty 模块 | JRM 详情中的对应能力 | 本阶段状态 |
| --- | --- | --- |
| Status / Route | 路线求解状态、起终站、时间、地图可见性 | 完整保留 |
| Live Share | 回放视频导出与系统分享；明确标注为非实时 | 替代映射 |
| My Flight / Metadata | 日期、车次、车种、运营方、方向、记录 ID | 完整保留 |
| Alternatives | 当前求解器明确禁用 route alternatives；仅展示/编辑现有路线约束 | 不伪造 |
| Delay / Prediction | 当前数据模型无实时延误与预测源 | 不显示 |
| Airport Disruptions | 铁路包加载/路线解析诊断，不冒充运营中断 | 仅语义替换 |
| Connection Assistant | 可从停站时间线读取换乘上下文，但无实时接驳判断 | 不显示助手 |
| Where's My Plane? | `定位路线`、回放当前位置与继续跟随 | 替代映射 |
| Aircraft | 车种、运营方、方向、车次/班次名称 | 替代映射 |
| Detailed Timetable | 完整停站序列、到达/出发、停站类型、乘坐区间 | 完整保留 |
| Route History | 已保存 route sections、路线策略与重建状态；不是历史运行轨迹 | 有限映射 |
| Updates | 保存、导入、求解、回放与导出任务状态；不是实时运营 feed | 有限映射 |

### 详情字段与操作

- 旅程身份：日期、车次/班次名称、车种、运营方、方向。
- 路线时间：起终站、首个有效出发、最后有效到达、24+ 小时跨日时间。
- 停站时间线：站名、station code（高级信息）、到达、出发、stop type、是否属于实际乘坐区间。
- 地图状态：显示/隐藏、定位路线、路线是否可用、路线重建进度和受影响区间。
- 记录维护：编辑、复制、重排、删除；删除为末项 destructive action。
- 高级信息：稳定记录 ID、route policy、route sections，仅在 Disclosure/高级页面展开。
- `编辑停站` 和 `重建路线` 是两个动作：前者改事实输入，后者根据已保存输入重新求解。

### 5.1.4 Search / Add / Journey Editor

主问题：**哪些字段需要修正才能保存？**

### 信息分组

1. 基本信息：日期、车次、车种、运营方、方向、地图可见性。
2. 起终站：必须与停站序列建立明确关系。
3. 停站：顺序、到发时间、类型、实际乘坐状态。
4. 路由：普通用户默认自动；线路/运营方约束进入高级页面。
5. 样式：路线颜色。
6. 记录信息：ID 等技术字段进入高级区域；新建时可自动生成。

### 当前字段覆盖

- 基本信息保留日期、编号/名称、车种、运营方、方向、地图可见性与路线颜色。
- 停站行保留站名、station code、到达、出发、stop type、`rideSegment`；支持新增、删除、Undo 与重排。
- 路线策略保留机构过滤模式（自动/软偏好/硬约束）、JR-only、允许的机构类型代码、偏好线路与偏好运营方。
- Route alternatives 与 straight-line fallback 在当前 schema/编辑器中均为禁用常量；界面要解释“已禁用”，不能做成可切换控件。
- 每个 route section 可编辑起点/终点、两端 station code、线路名约束、运营方约束、车次编号与显示名，并支持重排。

### 交互规则

- 编辑器持有完整草稿，保存时一次性提交；取消不得留下半条记录。
- 校验必须尽量在字段旁实时显示，不能只在表单底部给一个泛化错误。
- 保存禁用时必须让用户知道原因；点击不可用的视觉区域不应无反馈。
- 第一个错误字段应可被“查看错误”动作聚焦。
- 删除停站支持系统撤销或短时 Undo；仅在不可恢复的批量删除时使用确认。
- 拖拽排序必须 1:1 跟手、支持自动滚动，并在释放后继承速度或自然归位。
- 离开有修改的草稿时显示放弃确认；无修改时直接关闭。
- `route_sections` 重建应在成功保存停站后显式发生，状态可见，不得让用户猜测。

### 文案

使用具体动词：

- `保存旅程`，而不是 `完成`。
- `重建路线`，而不是 `处理`。
- `从地图隐藏`，而不是 `切换显示`。
- `放弃修改`，而不是 `确定`。

### 5.1.5 Route Resolution

主问题：**路线是否可信，用户是否需要参与？**

用户可见状态：

| 状态 | 文案 | Hero 行为 | 可用操作 |
| --- | --- | --- | --- |
| unknown | 准备路线 | 保持旅程身份，显示小型进度 | 取消选择 |
| resolving | 正在重建路线 | 进度上移，定位/播放禁用 | 继续浏览；必要时取消 |
| resolved | 不常驻显示成功徽章 | 回到普通 Hero | 定位、播放 |
| needsReview | 路线需要检查 | 原因和受影响区间上移 | 编辑停站、编辑约束 |
| unavailable | 无法绘制路线 | 失败成为 Hero | 重试、编辑、查看详情 |

原则：

- 路线求解失败不是 toast，也不是地图静默无内容。
- 已保存的列车数据必须保留；路线失败不得删除或覆盖记录。
- 若使用缓存或预计算路线，无需向普通用户暴露技术来源；只有来源影响可信度时才说明。
- “已解析”只表示系统生成了铁路路径，不表示运营真实路径已被官方确认。

### 5.1.6 Playback / Video Share

主问题：**现在走到哪里，接下来是哪一站？**

```text
踊り子 1号
横浜 → 大船
00:18 / 02:40
[上一段] [暂停] [下一段] [1×] [停止]
━━━━━━━━━━━━━━ 32%
```

规格：

- 回放启动后，回放状态取代普通旅程操作成为功能层 Hero。
- 当前站/区间、下一站、整体进度比导出选项重要。
- 导出视频是二级流程，打开后才显示画幅、质量和码率。
- 暂停/继续占主按钮；停止保持可发现但不与暂停同权。
- 速度变化必须立即反馈；速度数字使用等宽数字。
- 地图运动必须可中断；用户手动拖动地图时暂停自动聚焦，提供明确的“继续跟随”。
- Reduce Motion 开启时，路线进度仍可更新，但取消大幅飞行动画和弹性跟随。

视频导出完整功能：

| 功能 | Web | iOS |
| --- | --- | --- |
| 画幅选择 | `#playback-shape` | `VideoExportOptionsView` |
| 质量上限 | `#playback-quality` | `VideoExportOptionsView` |
| 码率 | `#playback-bitrate` | `VideoExportOptionsView` |
| 开始/取消/完成 | Web playback exporter | `PlaybackVideoExporter.State` |
| 成品操作 | 下载 | `ShareLink` 分享/保存 |

`Video Share` 是完成后的回放媒体，不是 Flighty Live Share。所有文案必须避免“实时追踪分享”。

## 5.2 Shared-map Network Mode / 铁路网络模式（非 Tab）

主问题：**这个地区有哪些铁路、线路和车站？**

Network 对应 Flighty 的 Airports 页面族，但它属于共享地图的浏览模式，不是第四个内容目的地。入口位于 All Journeys 右上角的地图/图层按钮，并可由所有工作区的地图控件进入；退出后返回原 Tab、原 Sheet Detent、筛选和地图相机。

### 5.2.1 Network 模式面板

```text
[铁路网络]                  [Data] [Settings] [完成]
[日本 ▼]

┌──────────────────────────────────────┐
│ Apple Maps / MapLibre                │
│ 完整铁路网络、线路颜色、站点与标签       │
│                           [map controls]
└──────────────────────────────────────┘

╭──────── Network information ────────╮
│ 652 lines · package ready · JP       │
│ [Lines/Stations] [Display] [Fit]     │
╰──────────────────────────────────────╯
```

页面必须包含：

- 日本、台湾、香港、澳门、韩国地区切换。
- 当前路网包加载、解码、失败与重试状态。
- 全国/地区范围适配与当前位置。
- 完整铁路网络开关与底图透明度。
- 官方浅色/深色线路颜色。
- 按 zoom、完整可见性 group 长度和 rank 决定的 LOD；iOS 在 app zoom 4/5/6/7
  额外使用 300/120/50/20 km 的低缩放长度门槛，zoom 8 恢复全部线路。
- Display Parts：干线与支线按现有算法拆分绘制。
- Station dots、角色分级站名与 endpoint labels。
- 无底图/底图失败时继续显示本地铁路包。

### 5.2.2 Station Detail

点击站点显示现有 C5 信息，不扩展不存在的实时站务：

```text
站名
Kana / Romaji / 中文读音（按地区与设置）
Operator badge
Line name + official colour swatch
Origin / stop / pass-through / destination role（如与旅程有关）
Arrival / departure time（如与所选旅程有关）
```

Station Detail 必须区分：

- 网络站点信息：来自地区铁路包与 station readings。
- 旅程停站信息：来自当前 `Train.stops`。
- 两者可组合显示，但不能把旅程时间伪装成实时站牌。

### 5.2.3 Line / Operator Detail

当前项目没有完整独立线路目录或收藏模型，因此第一阶段使用地图上下文详情：

- 线路名、运营方、官方颜色。
- 当前 zoom 可见原因与网络类别。
- 与 Passport 的该线路覆盖率明细建立导航链接。
- Web 的重叠线路鼠标 fan 保留；iOS 不创造 hover 替代手势。

全局线路搜索、线路收藏和运营状态属于未来能力，不在当前导航中放空入口。

### 5.2.4 Network Display

地图相关显示设置可以从 Network 的局部 Toolbar 快速进入，但设置状态仍由全局 Settings 单一拥有者保存：

- Complete rail network。
- Basemap opacity。
- Journey line width / ridden opacity。
- Terminal/stop/pass marker size 与 border width。
- Selection width boost、off-date dimming、full cross-day runs。
- Station kana/romaji/Chinese readings。

快速入口只导航到相应设置 Section，不复制一套状态。

## 5.3 Passport / 统计（Tab 2）

主问题：**我乘坐了多少，覆盖了哪些铁路？**

Passport 对应 Flighty 的历史回顾模式，合并当前 Statistics 工作区、日期旅程日志、共享地图覆盖模式与回放导出。它可以比编辑界面更有表现力，但数字仍应准确、克制。

Half / Full 顶部固定使用以下大标题头部；Docked 不显示头部：

```text
[乘车统计]                         [范围] [分享]
```

### 5.3.1 Scope

顶部 Scope：

```text
[ALL-TIME] [2026-07-03] [2026-07-04] …
```

现有数据模型按具体日期 bucket 工作，没有可靠的“年份 Passport”聚合 UI。第一阶段提供 All-Time 与具体日期；Year 只有在统计层正式支持后才能加入。

- `All-Time` 显示全局统计。
- 单日显示“当日统计”。
- 未选单日时，当日数值显示 `--`，不能显示 `0` 冒充答案。
- Passport 的日期 Scope 独立于 Journeys 筛选，切换后不扰动旅程列表。

### 5.3.2 Shared Map Coverage Mode

Passport 不得包含卡片内小地图、缩略地图或第二个 `Map` / `MKMapView`。切换到 Tab 2 时，同一张全屏共享地图改为 Coverage 投影并显示：

- 已乘坐铁路几何。
- 未乘路网作为低强调上下文。
- 线路官方颜色和选定类别强调。
- 按线路或类别进入对应统计明细。

当前代码没有 Flighty 式按频次改变线宽/站点大小的 heat map 合约，因此第一阶段名称使用 `Coverage Map`，不得称为 frequency heat map。

实现边界：

- `StatisticsView.swift` 不得实例化 `RailMapView`。
- 若现有 `PassportCoverageMapView.swift` 已存在，实施时必须退役其地图容器职责，改造成 `PassportMapOverlayProvider` / `MapProjection` 之类的纯配置或覆盖层提供者。
- Passport 的统计列表滚动不会创建、缩放或销毁另一张地图；只有明确的“适配覆盖范围”操作可以改变共享相机。
- 从 Passport 切回 Upcoming/All Journeys 时，只替换覆盖层和强调规则，不重建地图、不丢失用户手动相机位置。

### 5.3.3 Statistics

首屏顺序：

1. 总乘车里程 Hero。
2. 旅程数、出行日、停站数、乘车时间。
3. 网络覆盖率。
4. 车种组合。
5. 最常乘坐区间。
6. 按线路和类别的详细展开。

完整统计功能：

| 模块 | 内容 |
| --- | --- |
| Daily | 单日里程、乘车时间、旅程数、车种组合 |
| Mileage | 去重后的实际乘坐里程、未匹配里程 |
| Coverage | 新干线、JR 在来线、地铁、私铁、路面电车等类别百分比 |
| Lines | 每条线路的已乘/总里程、百分比；新干线可列出未乘线路 |
| Service mix | 当前统计引擎的 mutually-exclusive service groups |
| Top segments | 全部与各类别最常乘坐区间，最多显示产品规定数量 |

### 5.3.4 Journey Log

Passport 下部提供完成记录日志，复用 `ItineraryStore.Loaded.days`：

- 按日期分组。
- 车次、起终站、时间与车种摘要。
- 点击打开同一个 Journey Detail，不复制历史详情页面。
- 支持搜索与地区过滤。
- 可从日志启动单趟或当前 Scope 的回放。

JRM 没有“完成后自动从 Journeys 移入 Passport”的实时生命周期。Journeys 与 Passport 是同一批记录的两种视图，不移动或复制数据。

### 5.3.5 Replay & Share

- 单趟回放、前一段/下一段、暂停/继续、停止与速度。
- Auto-focus。
- Trail gradient/progress。
- Video export 画幅、质量、码率。
- Web 下载视频；iOS 完成后通过系统 Share Sheet 分享。
- JSON Export 作为数据分享入口跳转 Data Library。

规则：

- 不得用绿色表示纯粹的高数值；语义绿只表示成功/正向状态。
- 图表必须有文字数值与 VoiceOver/屏幕阅读器描述。
- 统计尚未完成时显示计算状态，不显示 `0` 冒充结果。
- 未匹配距离应以中性提示说明，不与严重数据错误使用相同红色。
- 路线官方色可作为统计的编辑性颜色，但相邻系列必须满足区分度要求。
- 回放和分享失败只影响相关任务，不清空统计或旅程记录。

## 5.4 All Journeys / 全部行程（Tab 3）

主问题：**我的完整乘车记录是什么，怎样找到其中一趟？**

All Journeys 复用 Upcoming 的 Journey Detail、编辑器、路线状态、回放与分享能力，但列表范围包含历史、今天和未来所有记录。它不是另一份数据，也不得创建第二个 `ItineraryStore`。

```text
[全部行程]                    [搜索] [筛选] [路网]
[全部] [过去] [今天] [未来]

201 journeys · 32 days
按日期分组的完整旅程列表
```

- 左上使用大标题 `全部行程`；右上至少提供搜索/筛选，以及进入 Shared-map Network Mode 的地图或图层按钮。空间不足时合并为一个系统 `Menu`。
- 列表默认按日期分组并使用稳定记录 ID；可复用现有日期、车次、站点、车种、运营方和方向搜索。
- 选择记录后在同一 Sheet 内打开共用 Journey Detail；共享地图强调该路线。
- All Journeys 保留新增/删除日期、新增/复制/删除/重排旅程、显示/隐藏、编辑停站、路线约束、回放和视频导出全部能力。
- `过去 / 今天 / 未来` 是本视角筛选，不改变 Upcoming 的独立筛选，也不改变 Passport scope。
- 进入 Network Mode 只改变共享地图投影和 Sheet 内容层，不改变当前 Tab 选择；退出后恢复 All Journeys 的列表滚动、筛选、选择和 Detent。

## 5.5 Data Library / 数据库

主问题：**当前数据来自哪里，是否安全保存？**

Data Library 是全局 Utility destination，不是主 Tab。关闭后返回调用它的 Upcoming、Passport、All Journeys 或临时 Network Mode 原位置。

首屏必须先显示数据来源摘要：

```text
我的数据 · 日本
201 趟旅程 · 已保存在此设备
[保存副本] [导入]
```

或：

```text
示例数据 · 只读预览
[保存为我的数据]
```

### 5.5.1 Source & Availability

- 当前地区、示例/我的数据、旅程数量和存储说明。
- 路网包 loading/ready/failed 与重试。
- 数据加载失败、保存失败和正在进行的 Import 保持在屏幕上。
- 路网包失败只阻断地图，不阻断记录浏览、导出和恢复。

### 5.5.2 Import

```text
Open JSON / Paste JSON
→ Choose Replace or Append
→ Parse and Validate
→ Preflight
→ Commit
→ Progressive route work
→ Completion
```

Preflight 必须显示：

- 目标地区。
- Schema version。
- 文件内旅程数。
- Will Add / Will Replace / Will Keep / Will Rename。
- ID rename 示例与清单。
- JSON path、旅程 ID 或 row 级问题。
- 是否可以 Commit。

导入阶段必须支持取消；Commit 前不修改现有 store。Replace 与 Append 的模式说明不能只靠 Picker 标签。

### 5.5.3 Export

- Export/Save JSON。
- Copy JSON。
- Raw JSON Preview，默认折叠，长内容可截断但必须说明。
- Web Download JSON。
- Web Download Current HTML 保留为平台特有项，不出现在 iOS。

### 5.5.4 Samples & My Data

- 按当前地区列出可用样例；总目录与当前代码一致为七个：日本全部示例、跨年大回行程、东京特急大回行程、台湾示例、香港示例、澳门示例、韩国示例。
- 日本显示三个样例，其他地区各显示自己的一个样例；不得在当前地区下列出会与路网错配的跨地区样例。
- Save Current Rides / Save as My Data。
- Restore My Data。
- Static 站点使用 IndexedDB；本地 server 使用文件与 autosave/SSE；iOS 使用本地 document/library。
- 切换地区不得合并 store。

### 5.5.5 Recovery & Danger Zone

- Replace/Delete 前创建可恢复 backup（平台支持时）。
- Recovery Section 在 Danger Zone 前出现。
- Restore Backup 显示时间、旅程数与原因。
- Discard Backup 为 destructive。
- Delete Saved Data、Delete All Journeys、Reset to Sample、Clear Storage 必须确认影响地区、数量和恢复能力。
- Danger Zone 默认折叠并与普通任务留出明显空间。

规则：

- 导入前先做预检摘要：国家/地区、旅程数、替换或追加模式、错误数。
- `替换全部` 与 `追加/按 ID 更新` 必须在确认前明确。
- 进度显示当前阶段，例如“验证 12/201”“解析路线 47/201”，而不是单一不解释的百分比。
- 导出、下载、保存本地文件属于同一任务组；原始 JSON 预览默认折叠。
- 危险区默认折叠，并与普通数据操作有明显空间间隔。
- 删除全部数据必须说明影响范围和恢复可能性；有可恢复备份时优先提供恢复路径。

## 5.6 Settings / 设置

主问题：**这些选项会改变地图、界面，还是数据？**

设置按现有 `SettingsView.swift` / `app-display-settings.js` 能力分组：

### 5.6.1 Region & Language

- 地区：JP / TW / HK / MO / KR。
- UI 语言：繁中、简中、日文、英文。
- 地区切换刷新路网包、store、readings、route cache 与地图边界，但不跨地区合并记录。
- 国家/地区变体字符串继续通过现有 `tc()` / `countryText()` 规则解析。

### 5.6.2 Station Names

- Kana readings。
- Romaji readings。
- Chinese names。
- 在有官方本地化站名的地区直接使用对应名称。
- 未被用户固定前，三个 Toggle 跟随界面语言；第一次手动改变后独立持久化。

### 5.6.3 Appearance

- System / Light / Dark。
- 默认 System，iOS 26/27 使用系统 Liquid Glass 与语义色。
- 线路 overlay 使用数据包的 `color` / `colorDark`，不对所有线路做简单亮度反转。

### 5.6.4 Map Content

- Complete rail network。
- Frame loaded network。
- Basemap opacity `0...1`。
- Renderer 信息：Web MapLibre / iOS Apple Maps。

### 5.6.5 Journey Lines

- Line width scale `0.2...3×`。
- Ridden segment opacity `0...1`。

### 5.6.6 Station Markers

- Terminal origin/destination size。
- Intermediate stop centre-dot size。
- Stop/pass-through outer size。
- Marker border width scale。

### 5.6.7 Selection & Focus

- Selection width/zoom boost。
- Off-date dimming opacity。
- Show full cross-day runs；关闭时另一日部分使用虚线语义。
- Journeys 的 Auto-focus 与 Passport Playback Auto-focus 保持各自任务状态，不混成一个 Toggle。

### 5.6.8 Reset & Diagnostics

- Reset Display Defaults 只重置本页显示偏好，不修改旅程与导出 JSON。
- Railway package idle/loading/loaded/failed。
- Loaded 状态显示地区、线路数与解码耗时。
- Web UI mode override 只存在于 Web；iOS 按窗口形状自适应，不提供设备模式开关。

规则：

- 纯显示偏好不得暗示会修改导出 JSON。
- 会改变数据的操作不得放进显示设置。
- 每个 Toggle 就近说明影响对象；不要用一个通用帮助段落解释整页。

---

## 6. 视觉系统

## 6.1 两种视觉人格

### Operational JRM

用于列表、地图、详情、编辑、导入：

```text
calm / system-native / map-first / high-contrast /
compact / semantic / task-driven / trustworthy
```

### Memory JRM

用于统计、回放封面、分享图和年度回顾：

```text
expressive / railway-signage / route-colour /
ticket-and-map metaphors / editorial / souvenir-like
```

不得把 Memory 风格带进数据错误或删除确认等高压力状态。

## 6.2 色彩角色

iOS 全局必须使用系统语义色；Web 使用与 iOS 语义角色一一对应的变量，不在组件内散落十六进制。默认外观是系统 iOS 色彩与 Liquid Glass，不是 Flighty 式纯黑 cockpit。

iOS 允许的基础角色：

```swift
Color.primary
Color.secondary
Color(.systemBackground)
Color(.secondarySystemBackground)
Color(.tertiarySystemBackground)
Color(.systemGroupedBackground)
Color(.secondarySystemGroupedBackground)
Color(.separator)
Color.accentColor // 由根视图 .tint(...) 传播
Color.green
Color.orange
Color.red
```

硬性规则：

- App 根层不得强制 `.preferredColorScheme(.dark)`；默认跟随系统，用户选择浅色/深色时才覆盖。
- 不得用固定 `Color.black` 或纯黑十六进制作为主画布、菜单、卡片或 Tab Bar 背景。
- 系统深色模式可以自然产生深色表面，但必须由语义颜色和 Liquid Glass 环境采样得出。
- Liquid Glass 不设置固定黑 tint。Tint 仅用于明确选中、主操作或品牌动作，并使用系统 `tint` 传播。
- 铁路线数据自带颜色继续保留，它属于地图内容，不是 App chrome 色板。
- Web 的浅色/深色值集中定义在语义 Token 层；组件只能消费角色变量。

| 角色 | 用途 | 禁止用途 |
| --- | --- | --- |
| action/tint | 可点击、选中、当前路线 | 成功、延误或错误 |
| positive | 导入完成、保存完成、恢复成功 | 大里程、装饰背景 |
| caution | 需要检查、信息可能不完整 | 普通筛选选中 |
| critical | 无法继续、删除、数据错误 | 品牌主色 |
| route colour | 铁路线、行程路线、统计系列 | 按钮状态 |
| primary/secondary/tertiary | 文本层级 | 状态含义 |

状态必须始终有文字。例如：

```text
✓ 已保存
! 路线需要检查
× 导入失败
```

不能只给一个绿点、黄点或红点。

## 6.3 字体

iOS：

| 用途 | SwiftUI 语义字体 | 规则 |
| --- | --- | --- |
| 屏幕 Hero | `.largeTitle.bold()` 或按空间降为 `.title.bold()` | 不硬编码固定字号 |
| 车次 | `.title2.bold()` | 允许两行 |
| 站名 | `.title3.bold()` | Dynamic Type 下改垂直布局 |
| 时间/里程/百分比 | 对应层级 + `.monospacedDigit()` | 数字对齐 |
| 状态 | `.subheadline.weight(.semibold)` | 文字为第一编码 |
| 元数据 | `.subheadline` / `.caption` | secondary/tertiary |

Web：

- 使用 `system-ui` 字体栈。
- 正文基准不低于 `1rem`；注释一般不低于 `0.75rem`。
- 使用 `font-variant-numeric: tabular-nums` 显示时间、距离、百分比和进度。
- 大标题使用轻微负 tracking；小字号不得继承相同 tracking。
- 布局间距优先使用 `rem`，让浏览器字号设置能一起放大布局。

## 6.4 间距与圆角

共同建议 Token：

```text
spacing: 4 / 8 / 12 / 16 / 20 / 24 / 32
radius-control: 12
radius-card: 18–20
radius-sheet: 28–32
radius-pill: full
partial-sheet-edge-margin: system-provided, visually about 12–16
full-sheet-inset: system `.large`, fills available screen
```

规则：

- 同层组件只从 Token 取值，不临时发明 13、17、19 等随机间距。
- 卡片内边距一般 16–20；列表行最小可点击高度 44，地图边缘控件建议 48。
- 圆角表达层级：小控件 < 内容卡 < 面板；所有东西不能统一同一圆角。
- 常驻系统 Sheet 在 Docked/Half 保持系统内缩边距与圆角，并在进入 Full 时连续扩展至可用屏幕；不得手写第二套几何动画。
- Sheet 延伸至屏幕底部不等于内容贴底；滚动内容必须为 Sheet 内底部选择器和 Home Indicator 留出净空。

## 6.5 表面与材质

- 内容卡使用系统背景或轻量分组表面。
- 浮在地图上的按钮组使用系统 regular Liquid Glass，并通过 `GlassEffectContainer` 共享采样。
- 三段式常驻系统 Sheet 使用一个连续的系统表面；不显示抓手，左上标题、右上操作和底部选择器保持同一层级，不把每个内部区块各自 glass 化。
- 菜单内部长列表可在同一外壳中使用系统 grouped/secondary background 的可读内容层；内容层不得另叠一块相同强度的大玻璃。
- Sheet 内底部选择器使用系统 Button/Glass 能力，禁止重绘纯黑背景或再次包一层覆盖整行的假玻璃。
- 系统 `TabView` 位于同一 Sheet 内；三项普通 Tab 和 `Tab(role: .search)` 的分组、玻璃与间距全部交给 SwiftUI，不插入不透明挡板或第二条底栏。
- 粗重阴影仅用于把面板从地图中分离；普通内容卡使用边界/背景差异，不堆阴影。
- Sticky header 与内容交界优先使用短渐变/scroll edge effect，不使用持续存在的粗分割线。
- `prefers-reduced-transparency` 或 Increase Contrast 下，表面变得更实、更有边界。
- iOS 17–25 降级为 `.regularMaterial` + 系统语义背景；几何、margin、层级和三段式交互保持一致。

---

## 7. 组件规格

## 7.1 JourneySummary

输入：

```text
train number
origin / destination
departure / arrival
date
train type
visibility
route state
selection state
```

行为：

- 整行可选择，内部 More 不触发行选择。
- 选中使用 tint 边界/背景和 selected trait，不通过大幅缩放或强阴影。
- 支持列表、Docked panel 与 Spotlight/Search 三种密度，但保持字段顺序一致。

## 7.2 JourneyHero

输入除摘要外还包括当前任务状态。

变体：

```text
normal
hidden
resolving
needsReview
playing
```

每个变体最多一个 Prominent 主操作。

## 7.3 RouteTiming

- 左右显示起终站；大字号或窄宽时上下显示。
- 时间与站名分别成层，不能写成难扫读的一长串。
- 箭头只表达方向，不单独承担可访问性信息。
- 过夜时间保留 24+ 小时表示，并在详情中解释跨日。

## 7.4 StopTimeline

- Origin/Destination 使用实心端点；Passenger stop 使用空心点；Pass-through 使用虚线/点状符号。
- `ride_segment` 为 false 时使用文字或辅助标签说明，不能只降低透明度。
- 到达与出发的视觉顺序固定；所有时间使用等宽数字。
- 行高至少 44；长站名可换行，时间列保持尾对齐。
- VoiceOver/屏幕阅读器读法：`站名，类型，到达时间，出发时间，是否乘坐`。

## 7.5 StatusBadge

- 只在状态对决策有帮助时出现。
- 胶囊内部必须有文字。
- 背景使用语义色 10–14% 强度，前景使用可访问的语义色。
- `resolved`、`normal` 之类成功状态不应在每个卡片永久显示。

## 7.6 QuietActionGroup

- 主操作占唯一填充强调位。
- 其余操作使用次要填充、tinted 或 plain。
- 低频操作进入 More。
- destructive 操作永远不与主操作并排做成同样权重。

## 7.7 MapControlGroup

分组：

1. 完整路网与图层。
2. 定位所选路线与适配完整路网。
3. 放大与缩小。
4. 图例信息与当前位置分别使用独立圆形按钮。
5. Compass 使用地图框架原生控件。

规则：

- 单个可点击区域 iOS 至少 44×44 pt，建议视觉容器 48×48 pt。
- 全部按钮沿屏幕右侧单列竖向排列；每组两个按钮形成竖向胶囊，不使用两列网格。
- 相邻 glass 控件共享 GlassEffectContainer；不要给系统 Compass 再套一层 glass。
- 控制轨四周预留 8pt 仅用于 Liquid Glass 按压放大的绘制余量；不得关闭整个垂直 ScrollView 的裁剪，否则 Half 状态下滚出视口的控件会越界显示。
- “完整路网”只读取 `RailMapController.showsNetwork`；任何 Tab（包括统计）不得强制覆盖该值。
- 图标必须有明确可访问性标签；`paperplane` 不能被读成“纸飞机”而缺少“定位路线”的语义。

## 7.8 ProgressSummary

用于导入、路线求解、统计计算和视频导出。

必须包含：

```text
current stage
completed / total when known
whether interaction can continue
cancel action when safe
```

不得只显示旋转菊花超过数秒而无说明。

---

## 8. 操作逻辑

## 8.1 选择与取消

- 选择旅程立即在列表和地图同时反馈。
- 路线已就绪时可自动轻量聚焦；若用户关闭 Auto-focus，则仅高亮，不移动地图。
- 选择新旅程时，当前详情面板从现场值平滑更新，不先关闭再重新打开。
- 取消选择保留日期与搜索上下文。
- 选择在另一日期的旅程时，日期筛选可以更新，但必须让用户能预测并返回。

## 8.2 新增

- 新增使用完整草稿 Sheet/页面；取消不写入 store。
- 初始 ID 可以自动生成，技术 ID 不应成为新建流程的第一个问题。
- 最小必填路径：日期（可继承当前日期）→ 车次 → 起终站 → 至少一个有效停站序列。
- 保存后选择新旅程，并开始路线解析；解析状态留在旅程 Hero 中。

## 8.3 编辑与保存

- 草稿与 canonical record 分离。
- 保存是原子操作。
- ID 冲突不能静默覆盖另一条记录。
- 保存成功后回到同一旅程，不重置日期和地图上下文。
- 保存失败时保留草稿和输入焦点。

## 8.4 重建路线

- 重建前说明会依据停站与约束重新生成 route sections/geometry。
- 普通成功无需弹窗；在原位置显示完成状态，并让地图更新。
- 失败时明确受影响区间，优先给“编辑停站”而不是“重试”死循环。
- 求解中不得让用户启动依赖完整路线的回放或视频导出。

## 8.5 显示/隐藏

- 隐藏只影响地图展示，不影响记录和导出语义时，文案必须写清。
- 隐藏后的卡片仍保持正常可读性。
- 重新显示是隐藏状态下的主操作。

## 8.6 删除与撤销

- 删除单条旅程优先使用短时 Undo；若当前存储机制无法可靠恢复，再使用确认。
- 确认文案必须包含车次与起终站。
- 批量删除、清空本地数据、替换全部导入必须确认。
- 删除后选择相邻旅程或回到列表，不能留下空详情。

## 8.7 导入

```text
choose source
→ parse
→ validate
→ preview scope and mode
→ commit atomically
→ resolve routes progressively
→ completion summary
```

- Parse/validation 不改变当前数据。
- Commit 前显示将新增、替换和保留的数量。
- 发生错误时显示具体 JSON 路径、旅程 ID 或停站序号。
- 进行中的大导入允许继续看地图，但防止并发修改造成不明确结果。

## 8.8 离线与降级

JRM 的核心记录能力在本地可用时，网络故障不得显示为全屏错误。

| 故障 | UI 行为 |
| --- | --- |
| 底图不可用 | 保留铁路和旅程图层；显示“底图暂不可用”中性提示；可切换无底图 |
| 本地静态站点 | 正常工作；不要持续显示“离线”警告 |
| 后端/SSE 暂不可用 | 若本地保存可用，显示“本地修改已保留，同步暂停” |
| 路网包缺失 | 阻断该地区地图，保留记录浏览与导出；给出恢复操作 |
| 路线求解失败 | 只影响相关旅程，不让整个 App 进入失败态 |

---

## 9. 动效与手势

## 9.1 动效原则

动效必须解释状态变化：

| 变化 | 动效语义 |
| --- | --- |
| 选择旅程 | 列表身份连续进入面板 Hero |
| Docked → Half → Full | 底栏位置连续；Docked 保留缩小标题行，正文在空间足够时于 Half 出现，Compact 不泄漏页面内容 |
| 地图定位 | 从当前镜头平滑到目标，可被手势打断 |
| 路线求解完成 | 进度状态让位给路线，地图新增路径 |
| 数字更新 | numeric transition，保持对齐 |
| 状态替换 | 原位替换/移动，避免销毁整块布局 |
| 关闭面板 | 沿进入路径返回 |

## 9.2 参数

建议基线：

```text
default spring: response 0.32–0.40, damping 1.0
gesture/sheet spring: response 0.30–0.38, damping 0.82–0.90
press feedback: 80–100 ms, scale 0.97–0.98
small opacity replacement: 160–220 ms
large map camera move: 300–550 ms, distance-aware
```

- 普通菜单、状态徽章不得为了“活泼”而弹跳。
- 只有拖拽/甩动产生动量时才允许轻微 overshoot。
- 动画必须从当前屏幕值开始，可中途反向或抓取。
- 动画期间不得锁住无关输入。

## 9.3 面板拖拽

- 用户语义名称固定为 Docked / Half / Full；代码可以暂时映射为 `.compact / .medium / .expanded`，但不得出现第四个含义模糊的自由停靠状态。
- iOS 拖拽、方向判断、预测终点、速度交接、边界阻力和 Detent 吸附全部交给系统 Sheet；不得在 Sheet 内容上叠加自定义 `DragGesture` 与系统手势竞争。
- `.presentationDragIndicator(.hidden)` 只隐藏视觉 Grabber，不取消系统拖动。非交互头部和内容背景必须保留足够的可拖区域。
- 右上功能按钮、底部 Tab 和 `+` 的点击必须优先保持直接、可靠；不要用全屏透明手势层截获点击。
- Docked 与 Half 之间的快速上甩/下甩和跨 Detent 行为遵循系统物理，不在业务层硬编码速度阈值。
- 拖到 Full 时，Sheet 与底部选择器作为同一容器连续扩展；边距、圆角、阻力和 Liquid Glass 变化由系统负责。
- 无可见 Handle 时仍必须为 VoiceOver、Switch Control 和键盘提供“展开面板”“半屏显示”“收起面板”可访问性操作。

## 9.4 Reduce Motion

- 使用短 cross-fade 或原位替换代替大幅滑动、弹性和视差。
- 地图定位可以直接切换或使用更短、更柔和的移动。
- 保留按下反馈、颜色变化、进度变化和数字更新，因为它们有认知价值。
- 自动回放提供降低速度或静态逐段模式。

---

## 9.5 底栏与面板的融合边界

结论：JRM 不再组合独立 Tab Bar 与 Sheet。底部导航本身放进一张常驻系统 Sheet，由同一系统表面完成底栏态、半屏和满屏。

- 悬浮 Tab Bar + Bottom Accessory。
- 支持多个高度档位的 Sheet。

如果要求面板在收起、半屏时**包围**底部选择器，并在满屏时一起扩展到屏幕边缘，就不能把系统 Tab Bar 留在 Sheet 外面。正式结构因此是 `Shared Map + Persistent System Sheet`；9.5.1–9.5.5 仅解释平台边界和参考来源，9.5.6 是唯一实施决策。

### 9.5.1 Apple 官方能力核对

| 目标 | 系统支持 | Apple 官方方式 |
| --- | --- | --- |
| Liquid Glass 悬浮底栏 | 支持 | `TabView` / `UITabBarController` 自动采用 |
| 滚动时缩小底栏 | 支持 | `tabBarMinimizeBehavior(.onScrollDown)` |
| 底栏上方附加内容 | 支持 | `tabViewBottomAccessory` |
| 附加内容缩进底栏内部 | 部分支持 | 系统在 expanded / inline 两种 placement 间切换 |
| 底部面板拖动改变高度 | 支持 | `presentationDetents` |
| 收起 / 半屏 / 满屏三档 | 支持 | `.height(...)`、`.fraction(...)`、`.large` |
| 隐藏 Pull Bar | 支持 | `presentationDragIndicator(.hidden)` |
| 没有 Pull Bar 仍能拖动 | 支持 | 固定标题区拖动 + 可访问性 Detent actions |
| Half 内正文独立滚动 | 支持 | `presentationContentInteraction(.scrolls)` |
| 半屏状态四周留白 | iOS 26 默认支持 | Partial-height Sheet 默认采用 inset Liquid Glass |
| 满屏时扩展到边缘 | 支持 | Sheet 从 partial detent 过渡到 `.large` |
| Sheet 包围系统 Tab Bar | **不支持** | 两者属于不同系统层级 |
| Tab Bar 与 Sheet 一起连续缩放 | **不支持** | 需要自定义容器和手势 |

Apple 在 iOS 26 明确展示了悬浮 Tab Bar、Bottom Accessory，以及默认内缩的部分高度 Liquid Glass Sheet。[WWDC25：Build a SwiftUI app with the new design](https://developer.apple.com/videos/play/wwdc2025/323/)

Apple 的 Tab Bar HIG 也说明：底栏可以附带类似 Music MiniPlayer 的 accessory，但它主要用于跨页面持续存在的功能；模态页面覆盖 Tab Bar 是被允许的例外，并没有定义“Sheet 包裹 Tab Bar”的系统结构。[Apple HIG：Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)

iOS 27 当前官方更新主要是 Liquid Glass 外观调整、窗口适配、Prominent Tab 和 Toolbar 增强；WWDC26 没有新增“可拖动 Tab Bar Accessory”或“Sheet 与 Tab Bar 合并”的公开 API。这是根据 Apple 公布的 SwiftUI 27 API 范围作出的判断。[WWDC26：What's new in SwiftUI](https://developer.apple.com/videos/play/wwdc2026/269/)

### 9.5.2 JRM 推荐结构

> 按 9.5.6，`JRMBottomChrome` 最终是一张常驻系统 Sheet 的内容，不是手绘容器。本节的命名规则和状态定义照常适用；下面的容器规格表是**验收时用来核对系统表现的目标值**，不是拿来手绘的参数。

这个组件**不得**命名为 `Menu`。在 Apple 的术语里 `Menu` 是点击后出现的命令列表；此处应使用 `BottomPanel`、`BottomSheet`、`BottomChrome` 或 `MapPanel`。

```text
JRMRootView
├── Map / Page Content                 全屏内容层
└── JRMBottomChrome                    常驻系统 Sheet 内容
    ├── Workspace Header / Content
    └── [Upcoming] [Passport] [All]  [+]
```

三个状态定义为：

```swift
enum BottomChromeDetent {
    case collapsed
    case medium
    case expanded
}
```

对应规格：

| 状态 | 高度 | 水平 Margin | 圆角 | 背景 |
| --- | --- | --- | --- | --- |
| Collapsed | 118–136 pt | 12 pt | 30–34 pt | 实体系统白/Sheet 深灰；底栏 Glass |
| Medium | 屏幕可用高度约 52% | 12 pt | 30–34 pt | 实体系统白/Sheet 深灰；底栏 Glass |
| Expanded | 可用全屏高度 | 0 pt | 0 或贴合设备曲率 | 同一实体系统色；底栏保留 Glass |

Apple 对 Sheet 聚焦变化的描述与这个方向一致：面板被向上拖动时，玻璃会逐渐后退、提高不透明度并稍微扩大，表示用户进入了更深层级。[WWDC25：Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/)

满屏状态**不得**把整屏做成强烈的 Liquid Glass。Apple 将 Liquid Glass 定义为位于内容之上的“功能层”，并明确建议避免在内容层大量使用玻璃。[Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)

### 9.5.3 接受系统 Sheet 限制时的写法

下面的系统代码可以实现三档高度、无 Pull Bar、正文独立滚动，并从固定标题区拖动 Sheet：

```swift
struct MapRootView: View {
    private let collapsed = PresentationDetent.height(132)
    private let medium = PresentationDetent.fraction(0.52)
    @State private var isPresented = true
    @State private var selectedDetent: PresentationDetent = .height(132)
    var body: some View {
        MapContentView()
            .sheet(isPresented: $isPresented) {
                RailPanelContent()
                    .presentationDetents(
                        [collapsed, medium, .large],
                        selection: $selectedDetent
                    )
                    .presentationDragIndicator(.hidden)
                    .presentationContentInteraction(.scrolls)
                    .presentationBackgroundInteraction(
                        .enabled(upThrough: medium)
                    )
                    .interactiveDismissDisabled()
            }
    }
}
```

`presentationContentInteraction(.scrolls)` 让 Half/Full 内的列表先响应滚动；Sheet 高度改由固定标题区域的拖动与可访问性 Detent actions 控制。内容长度和滚动位置因此不依赖当前菜单高度。

隐藏指示器只是隐藏视觉 Grabber，不会取消 Detent 和拖动能力。[Apple：presentationDragIndicator](https://developer.apple.com/documentation/swiftui/view/presentationdragindicator%28_%3A%29)

但这个方案**不能**把系统 Tab Bar 收进 Sheet 外壳。9.5.6 绕过这一点的方式是不使用系统 Tab Bar，而不是把它装进 Sheet。

### 9.5.4 `JRMBottomChrome` 的必须规则

> 这些规则在 9.5.6 的路线下仍然全部成立，但其中 Margin 插值、圆角过渡、阻尼、吸附和预测终点由系统 Sheet 负责，JRM 只对 Sheet 内容负责。

- 收起和半屏状态必须把 Panel 与底部选择器放在同一张系统 Sheet 内。
- 背景地图必须继续绘制到容器和底栏下面。
- 外层 Margin 必须从 `12` 连续插值到 `0`，不得在到达满屏时突然跳变。
- 圆角必须从约 `32` 连续过渡到 `0` 或设备同心圆角。
- “稍稍放大”只能体现为容器扩展与间距舒展，不得放大 Tab 图标和文字。
- 不显示 Pull Bar，但顶部至少 `44 pt` 高度和空白区域都必须能开始拖动。
- Detent 的预测终点、速度吸附、中途反向和可打断动画必须使用系统 Sheet 行为（见 9.3），不得复制成业务手势。
- 必须为 VoiceOver 添加“展开面板”“收起面板”操作。
- Reduce Motion 下取消大范围形变；Reduce Transparency 下改用更实的系统背景。
- 多个玻璃组件必须使用 `GlassEffectContainer`，让形状合并和变形由 SwiftUI 协调。[Apple：Applying Liquid Glass to custom views](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views)

### 9.5.5 参考实现：Anitabi 的常驻 Sheet

在写自定义容器之前，先看一个已经做出这个效果的实现。Anitabi 的底栏和可展开面板看起来是融合的，但它没有自定义容器，也没有自写 `DragGesture`。

**1. Bottom Bar 本质上是 Compact Sheet。** 它定义三个阶段：

```swift
enum SheetStage {
    case compact
    case medium
    case expanded
}
```

最小高度不写死，而是测量当前紧凑标题栏/搜索栏的真实高度：

```swift
func minDetent(measured: CGFloat?) -> PresentationDetent {
    .height(measured ?? compactContentFallback)
}
```

它刻意把这个高度控制在 iOS 26 的迷你 Sheet 区间，约不超过 80 pt，于是系统会把一张普通浮动 Sheet 连续变形成类似胶囊底栏的样子（`SheetDesign.swift`）。

所以它的原理不是 `Tab Bar + Bottom Sheet`，而是：

```text
Bottom Sheet
  ↓ 收缩
Compact Bottom Bar
```

这就是它看起来融合得自然的主要原因：外边距、圆角、阴影、拖动阻尼和 Detent 吸附全部由系统 Sheet 负责。

**2. 三档高度。** 核心修饰器是：

```swift
.presentationDetents(
    top.layer.detents(
        measured: compactHeights[top.layer],
        fitted: fittedHeights[top.layer],
        screenHeight: DesignScale.screenHeight
    ),
    selection: $detent
)
```

它不用 `.medium` / `.large` 的默认组合，而是按内容给出自定义 `.height(...)`：首页 Medium 约 43.1% 屏高、作品 Medium 约 41.7%、地点 Medium 约 53.1%、普通 Expanded 约 92.2%，Compact 由标题栏真实高度动态计算。它也刻意不用 `.fraction()`，理由是 `.fraction()` 的基准是 Sheet 可用高度而非设备完整屏高，因此直接换成 `fraction * screenHeight + 8`。

**3. 外边距和圆角不是自己绘制的。** Compact/Medium 的外层 Margin 与圆角全部来自 iOS 26 的系统 Sheet，因此免费得到左右留白、底部悬浮感、连续圆角变化、从迷你条到卡片的系统 morph、拖动阻尼与吸附，以及接近满屏时的尺寸变化。它额外写了 `SheetShapeReader`，但那个组件只沿 responder chain 找到 `controller.presentationController?.presentedView` 并持续读取系统 Sheet 实际绘制出的 frame，供地图署名、浮动控件和内容对齐使用——它读 Sheet，不画 Sheet。

**4. 它目前有 Pull Bar。** Anitabi 用 `.presentationDragIndicator(.visible)`，与本节要求的“无 Pull Bar”不同，而且它的内部布局明确预留了系统 grabber 约 10 pt（`systemGrabberBottom`）。因此不能只把它改成 `.hidden`：那样虽然仍能拖动，Compact 标题栏却会多出一段顶部空白。同步要改的是 `systemGrabberBottom`、`topInset`、`StageHeaderFrame`、`CompactBarRow`，以及 Compact Detent 的测量逻辑。

**5. 底栏右侧的 `⋯` 只是普通 SwiftUI `Menu`**，与 Sheet 的拖动逻辑完全独立——这正是 9.5.2 要求 JRM 不要把面板叫做 `Menu` 的原因：同一个界面里两个东西都叫 Menu，其中只有一个是 Apple 说的那个。

**6. 内容为什么不会在拖动中突然跳变。** 绑定的 `PresentationDetent` 通常在吸附完成后才改变，反映不了拖动中的实时高度，所以它不只监听 Detent：

```swift
.onGeometryChange(for: SheetGeometry.self) { proxy in
    SheetGeometry(height: proxy.size.height, ...)
}
```

逐帧读到真实高度后，选当前最接近的阶段：

```swift
let targets: [(SheetStage, CGFloat)] = [
    (.compact, minHeight),
    (.medium, initialHeight),
    (.expanded, maxHeight)
]
return targets.min {
    abs($0.height - currentHeight) < abs($1.height - currentHeight)
}
```

于是用户拖到中间时，内部标题、缩略图和列表就提前开始变化，不必等 Sheet 吸附完成。外层拖动由系统负责；内部内容用 `Animation.spring(response: 0.35, dampingFraction: 0.85)`，阶段切换用更快、无明显反弹的 `Animation.smooth(duration: 0.25)`。

**7. 一张 Sheet，替换内容。** 导航不是不断叠加新 Sheet：

```swift
@State private var stack: [SheetContent] = [.home]
```

曾经打开的层都留在 `ZStack` 里，只有最上层可见（`.opacity(...)` + `.allowsHitTesting(...)`），因此搜索文本、列表滚动位置、折叠状态和每一层原来的 Detent 都被保留，返回上一层时 Detent 也会恢复。这与 4.1 对 JRM 的要求是同一条：切换和返回必须保留导航、滚动和筛选状态。

**8. Liquid Glass 的处理。** 外形交给系统，但它没有用默认透明玻璃背景，而是在 Sheet 上再叠一层 `Rectangle().fill(.regularMaterial)` 加一层卡片色，注释写明是为了避免地图的海洋、绿地和彩色标记过度透入 Sheet。真正的 `glassEffect(.regular.interactive(), in: .capsule)` 只用在胶囊按钮上，低于 iOS 26 时回退 `.regularMaterial`（`GlassCompat.swift`）。JRM 的对应结论见 4.2 与 6.5：玻璃属于功能层，内容区域用系统背景层级保证可读性。

### 9.5.6 决策

采用系统容器组合，不写自定义底栏：**一张常驻系统 Sheet 内放一个系统 `TabView`**。Compact 时显示缩小的当前页标题、右上功能按钮、系统生成的三项普通 Tab 与右侧分离 Search，不挂载正文；Medium/Expanded 时标题放大并显示当前 Tab 内容，系统 Tab Bar 保持常驻。根视图仍只有一个共享地图；`TabView` 只切换 Sheet 内容，不承载或复制地图。

```swift
SharedJourneyMap(projection: mapProjection)
    .sheet(isPresented: .constant(true)) {
        JRMBottomChrome(stage: stage)
            .presentationDetents(
                [compactDetent, mediumDetent, .large],
                selection: $detent
            )
            .presentationDragIndicator(.hidden)
            .presentationContentInteraction(.scrolls)
            .presentationBackgroundInteraction(
                .enabled(upThrough: mediumDetent)
            )
            .interactiveDismissDisabled()
    }
```

与 Anitabi 的差异，逐项：

| Anitabi | JRM 目标 |
| --- | --- |
| Compact Sheet 就是收缩菜单卡 | Compact Sheet 露出缩小标题行，以及系统 `TabView` 的三个普通 Tab 与 Search role |
| Pull Bar 可见 | Pull Bar 隐藏，并按 9.5.5 第 4 点重新计算顶部间距 |
| 最大高度 92.2% | 用 `.large` 进入真正满屏 |
| Sheet 内使用系统 Tab 导航 | `[未来][统计][全部]` 是普通 `Tab`；Search 使用 `Tab(role: .search)` 自动独立分组 |
| 自定义青绿色背景 | iOS 系统色与自适应 Liquid Glass（6.2、6.5） |
| Expanded 仍保留地图条带 | Expanded 填满屏幕 |
| 系统 Sheet 拖动 | 继续采用，不自写 `DragGesture` |

这条路线比自定义容器更容易拿到 iOS 26/27 原生的 Margin、圆角变化、拖动惯性和满屏过渡，因此 9.5.2 的容器规格表从“要实现的东西”降级为“要核对的结果”：那些数值是验收时用来对照系统 Sheet 实际表现的，不是拿来手绘的。9.5.4 的规则同样保留，但其中 Margin 插值、圆角过渡、阻尼与吸附由系统负责，JRM 只需对 Sheet 内容负责——预测终点与速度选停靠点（9.3）在这条路线上也是系统行为。

系统 Tab Bar 可以直接成为 Sheet 内容树的一部分：把 `TabView` 放在常驻 Sheet 内，而不是放在根视图 Sheet 之外。这样 Tab Bar 会随 Sheet 一起移动，同时其 Liquid Glass、选中态、Search 分离、Dynamic Type 与辅助功能均由 SwiftUI 管理。

这与 11.10 的现状实现不同，属于 15 节意义上的后续切片，不在本阶段执行。

---

## 10. 可访问性与本地化

### 10.1 Dynamic Type / 浏览器字号

- 所有主要信息必须支持至少系统 Accessibility 字号。
- 起终站横向布局在空间不足时改为纵向，不通过无限缩小字体解决。
- Docked 面板高度由实际内容测量。
- Web 使用相对单位，200% 文本缩放时无内容遮挡、丢失或水平强制滚动（停站表格等真正二维内容除外）。

### 10.2 VoiceOver / 屏幕阅读器

- 一张旅程卡读成一个有意义的摘要，再暴露内部操作。
- 状态变化使用 polite live region；会阻断保存/导入的错误可以 assertive，但避免重复朗读。
- 图表提供汇总和逐项数据。
- 地图标注必须可选择，重叠线路选择器可键盘操作。
- SF Symbol/图标隐藏自身重复名称，由按钮提供业务语义标签。

### 10.3 键盘与焦点

Web：

- Tab 顺序与视觉顺序一致。
- `Escape` 逐级关闭弹层/详情，不直接清除全部上下文。
- `Enter/Space` 激活选中行和按钮。
- Focus ring 不得被 `outline: none` 移除。
- 打开 Modal 后焦点进入标题或首个字段，关闭后回到触发控件。

iPad 键盘可提供：

```text
⌘F 搜索
⌘N 新增旅程
⌘S 保存编辑
Space 播放/暂停（焦点不在输入框时）
Escape 返回/关闭
```

### 10.4 多语言

- 支持繁体中文、简体中文、日文、英文。
- 不以英文字符长度设计固定宽度。
- 站名读取和国家/地区变体继续使用现有本地化规则。
- 日期、数字与单位由 locale 格式化；业务要求的 `25:10` 等扩展时间除外。
- “ride” 的翻译应保持“乘坐记录”语义，避免被理解为实时班次。

### 10.5 颜色与对比度

- 正文和重要数字满足 WCAG AA 对比度。
- 状态不能仅靠颜色。
- Increase Contrast 下减少透明度并增加边界。
- 地图路线选中态除颜色外增加 casing、线宽或端点变化。

---

## 11. SwiftUI 示例代码

> 以下代码展示目标架构和 API 形状，不是本阶段要直接粘贴进产品的补丁。实际实现必须适配现有 `RailCore.Train`、`ItineraryStore`、`RiddenRouteStore`、`PlaybackController` 和本地化接口。

## 11.1 展示状态模型

```swift
import Foundation

enum JourneyWorkspacePhase: Equatable {
    case loading
    case empty
    case browsing
    case selected
    case editing(isDirty: Bool, isValid: Bool)
    case resolving(completed: Int?, total: Int?)
    case playing(progress: Double, isPaused: Bool)
    case importing(completed: Int?, total: Int?)
    case failed(JourneyFailure)
}

enum JourneyRouteState: Equatable {
    case unknown
    case resolving(completed: Int?, total: Int?)
    case resolved
    case needsReview(reason: String)
    case unavailable(reason: String)
}

enum JourneyFailure: Equatable {
    case load(String)
    case importData(String)
    case route(trainID: String, section: String?, message: String)
    case save(String)
}

struct JourneyPresentation: Equatable {
    enum PrimaryAction: Hashable {
        case add
        case importData
        case locate
        case showOnMap
        case rebuildRoute
        case save
        case pause
        case resume
        case retry
    }

    var eyebrow: String?
    var title: String
    var subtitle: String?
    var status: StatusPresentation?
    var primaryAction: PrimaryAction?
    var secondaryActions: [SecondaryAction]
    var blocksPlayback: Bool
}

struct StatusPresentation: Equatable {
    enum Tone: Equatable { case neutral, positive, caution, critical }
    var title: String
    var detail: String?
    var tone: Tone
}

enum SecondaryAction: Hashable {
    case play, stop, edit, duplicate, hide, delete, inspectDetails
}
```

## 11.2 信息优先级解析器

```swift
import RailCore

enum JourneyPresentationResolver {
    static func selected(
        train: Train,
        route: JourneyRouteState,
        playback: JourneyWorkspacePhase?
    ) -> JourneyPresentation {
        if case .playing(_, let isPaused) = playback {
            return JourneyPresentation(
                eyebrow: train.number,
                title: isPaused ? "Playback paused" : "Playing journey",
                subtitle: "\(train.origin) → \(train.destination)",
                status: nil,
                primaryAction: isPaused ? .resume : .pause,
                secondaryActions: [.stop, .inspectDetails],
                blocksPlayback: false
            )
        }

        if train.visible == false {
            return JourneyPresentation(
                eyebrow: train.number,
                title: "Hidden from map",
                subtitle: "\(train.origin) → \(train.destination)",
                status: .init(
                    title: "Journey is still saved",
                    detail: "Showing it again does not change exported journey data.",
                    tone: .neutral
                ),
                primaryAction: .showOnMap,
                secondaryActions: [.edit, .duplicate, .delete],
                blocksPlayback: true
            )
        }

        switch route {
        case .unknown, .resolving:
            return JourneyPresentation(
                eyebrow: train.number,
                title: "Building railway route",
                subtitle: "\(train.origin) → \(train.destination)",
                status: .init(
                    title: "Route is not ready yet",
                    detail: nil,
                    tone: .neutral
                ),
                primaryAction: nil,
                secondaryActions: [.edit, .inspectDetails],
                blocksPlayback: true
            )

        case .needsReview(let reason):
            return JourneyPresentation(
                eyebrow: train.number,
                title: "Route needs review",
                subtitle: reason,
                status: .init(title: "Saved journey is unchanged", detail: nil, tone: .caution),
                primaryAction: .rebuildRoute,
                secondaryActions: [.edit, .inspectDetails],
                blocksPlayback: true
            )

        case .unavailable(let reason):
            return JourneyPresentation(
                eyebrow: train.number,
                title: "Route unavailable",
                subtitle: reason,
                status: .init(title: "No straight-line fallback was drawn", detail: nil, tone: .critical),
                primaryAction: .rebuildRoute,
                secondaryActions: [.edit, .inspectDetails],
                blocksPlayback: true
            )

        case .resolved:
            return JourneyPresentation(
                eyebrow: train.date,
                title: train.number,
                subtitle: "\(train.origin) → \(train.destination)",
                status: nil,
                primaryAction: .locate,
                secondaryActions: [.play, .edit, .duplicate, .hide, .delete],
                blocksPlayback: false
            )
        }
    }
}
```

解析器要求：

- 必须是纯逻辑或接近纯逻辑，View 不应散落重复的优先级 `if`。
- 文案最终由现有本地化系统提供；示例中的英文是结构占位。
- `resolved` 不生成常驻绿色成功徽章。
- `needsReview` 与 `unavailable` 必须保留记录且说明没有画假路线。

## 11.3 语义 Token

```swift
import SwiftUI

enum JRMDesign {
    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 20
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }

    enum Radius {
        static let control: CGFloat = 12
        static let card: CGFloat = 20
        static let sheet: CGFloat = 24
    }

    enum Motion {
        static let standard = Animation.spring(response: 0.34, dampingFraction: 1)
        static let gesture = Animation.interactiveSpring(
            response: 0.34,
            dampingFraction: 0.86,
            blendDuration: 0.08
        )
    }
}

extension StatusPresentation.Tone {
    var color: Color {
        switch self {
        case .neutral: .secondary
        case .positive: .green
        case .caution: .orange
        case .critical: .red
        }
    }
}
```

## 11.4 状态徽章

```swift
import SwiftUI

struct JRMStatusBadge: View {
    let status: StatusPresentation

    var body: some View {
        Label(status.title, systemImage: symbol)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(status.tone.color)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(status.tone.color.opacity(0.12), in: Capsule())
            .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch status.tone {
        case .neutral: "info.circle.fill"
        case .positive: "checkmark.circle.fill"
        case .caution: "exclamationmark.triangle.fill"
        case .critical: "xmark.circle.fill"
        }
    }
}
```

## 11.5 起终站 Hero

```swift
import RailCore
import SwiftUI

struct JourneyRouteTiming: View {
    let train: Train
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: JRMDesign.Spacing.sm) {
                station(train.origin, time: departure)
                Image(systemName: "arrow.down").foregroundStyle(.secondary)
                station(train.destination, time: arrival)
            }
        } else {
            HStack(alignment: .top, spacing: JRMDesign.Spacing.sm) {
                station(train.origin, time: departure)
                Spacer(minLength: 8)
                Image(systemName: "arrow.right")
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
                    .accessibilityHidden(true)
                Spacer(minLength: 8)
                station(train.destination, time: arrival, trailing: true)
            }
        }
    }

    private func station(_ name: String, time: String?, trailing: Bool = false) -> some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 4) {
            Text(name)
                .font(.title3.bold())
                .fixedSize(horizontal: false, vertical: true)
            if let time, !time.isEmpty {
                Text(time)
                    .font(.headline)
                    .monospacedDigit()
            }
        }
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
    }

    private var riddenStops: [Stop] { train.stops.filter(\.rideSegment) }
    private var first: Stop? { riddenStops.first ?? train.stops.first }
    private var last: Stop? { riddenStops.last ?? train.stops.last }
    private var departure: String? { first?.departure ?? first?.arrival }
    private var arrival: String? { last?.arrival ?? last?.departure }
}
```

## 11.6 动态主操作组

```swift
import SwiftUI

struct JourneyActionGroup: View {
    let presentation: JourneyPresentation
    let perform: (JourneyPresentation.PrimaryAction) -> Void
    let performSecondary: (SecondaryAction) -> Void

    var body: some View {
        HStack(spacing: 8) {
            if let primary = presentation.primaryAction {
                Button(actionTitle(primary), systemImage: actionSymbol(primary)) {
                    perform(primary)
                }
                .buttonStyle(.borderedProminent)
            }

            ForEach(visibleSecondary, id: \.self) { action in
                Button(actionTitle(action), systemImage: actionSymbol(action)) {
                    performSecondary(action)
                }
                .buttonStyle(.bordered)
            }

            if overflowActions.isEmpty == false {
                Menu("More", systemImage: "ellipsis") {
                    ForEach(overflowActions, id: \.self) { action in
                        Button(actionTitle(action), systemImage: actionSymbol(action)) {
                            performSecondary(action)
                        }
                    }
                }
            }
        }
    }

    private var visibleSecondary: [SecondaryAction] {
        Array(presentation.secondaryActions.filter { $0 != .delete }.prefix(2))
    }

    private var overflowActions: [SecondaryAction] {
        Array(presentation.secondaryActions.dropFirst(visibleSecondary.count))
    }

    // 正式实现把返回值替换为 AppLocalization key。
    private func actionTitle(_ action: JourneyPresentation.PrimaryAction) -> String {
        switch action {
        case .add: "Add journey"
        case .importData: "Import"
        case .locate: "Locate"
        case .showOnMap: "Show on map"
        case .rebuildRoute: "Rebuild route"
        case .save: "Save journey"
        case .pause: "Pause"
        case .resume: "Resume"
        case .retry: "Retry"
        }
    }

    private func actionSymbol(_ action: JourneyPresentation.PrimaryAction) -> String {
        switch action {
        case .add: "plus"
        case .importData: "square.and.arrow.down"
        case .locate: "scope"
        case .showOnMap: "eye"
        case .rebuildRoute: "arrow.trianglehead.2.clockwise.rotate.90"
        case .save: "checkmark"
        case .pause: "pause.fill"
        case .resume: "play.fill"
        case .retry: "arrow.clockwise"
        }
    }

    private func actionTitle(_ action: SecondaryAction) -> String {
        switch action {
        case .play: "Play"
        case .stop: "Stop"
        case .edit: "Edit"
        case .duplicate: "Duplicate"
        case .hide: "Hide from map"
        case .delete: "Delete"
        case .inspectDetails: "Details"
        }
    }

    private func actionSymbol(_ action: SecondaryAction) -> String {
        switch action {
        case .play: "play.fill"
        case .stop: "stop.fill"
        case .edit: "pencil"
        case .duplicate: "plus.square.on.square"
        case .hide: "eye.slash"
        case .delete: "trash"
        case .inspectDetails: "info.circle"
        }
    }
}
```

实际实现中 destructive action 必须使用 `role: .destructive`，并位于 Menu 最后。

## 11.7 Map + Information + Functional 三层结构

```swift
import SwiftUI

struct JourneyMapWorkspace: View {
    private let compact = PresentationDetent.height(88)
    private let half = PresentationDetent.fraction(0.52)

    @State private var sheetPresented = true
    @State private var detent: PresentationDetent = .height(88)
    @State private var workspace: PrimaryWorkspace = .upcoming
    @State private var mapState = SharedJourneyMapState()

    var body: some View {
        SharedJourneyMap(state: mapState, projection: projection(for: workspace))
            .ignoresSafeArea()
            .sheet(isPresented: $sheetPresented) {
                PersistentWorkspaceSheet(
                    workspace: $workspace,
                    detent: $detent,
                    compactDetent: compact,
                    addJourney: openAddJourney
                )
                .presentationDetents([compact, half, .large], selection: $detent)
                .presentationDragIndicator(.hidden)
                .presentationContentInteraction(.scrolls)
                .presentationBackgroundInteraction(.enabled(upThrough: half))
                .interactiveDismissDisabled()
            }
    }

    private func projection(for workspace: PrimaryWorkspace) -> MapProjection {
        switch workspace {
        case .upcoming: .upcomingJourneys
        case .passport: .riddenCoverage
        case .allJourneys: .allJourneys
        }
    }

    private func openAddJourney() { /* present existing editor flow */ }
}
```

`SharedJourneyMap` 必须只挂载一次；`MapProjection` 是图层与强调规则，不是另一个地图 View。正式实现可通过 `PreferenceKey` 或布局协议测量底部选择器的真实高度后生成 compact Detent，不得复制某一台设备的固定高度。iOS 拖拽完全由系统 Sheet 负责。

## 11.8 数字与状态替换动效

```swift
Text(distance, format: .number.precision(.fractionLength(1)))
    .font(.largeTitle.bold())
    .monospacedDigit()
    .contentTransition(.numericText())
    .animation(reduceMotion ? nil : .snappy, value: distance)

Text(routeStatusTitle)
    .contentTransition(.interpolate)
    .animation(reduceMotion ? nil : .smooth, value: routeStatusTitle)
```

## 11.9 Liquid Glass 用于功能层与菜单外壳

```swift
import SwiftUI

struct JRMMapActions: View {
    var body: some View {
        RailGlassGroup(spacing: 8) {
            VStack(spacing: 0) {
                Button("Rail network", systemImage: "tram.fill") { }
                Divider().frame(width: 28)
                Button("Locate journey", systemImage: "scope") { }
            }
            .railGlass(
                in: RoundedRectangle(cornerRadius: 22, style: .continuous),
                interactive: true
            )
        }
    }
}
```

常驻系统 Sheet 的外壳与底部 Tab Bar 都由系统提供；其内部内容卡、停站时间线和详情分组不得逐卡重复调用 `.glassEffect`。底栏不得再包第二层自绘玻璃背景。

## 11.10 iOS 26/27 常驻系统 Sheet、三工作区与系统 Search

```swift
import SwiftUI

enum PrimaryWorkspace: Hashable {
    case upcoming
    case passport
    case allJourneys
    case search
}

struct PersistentWorkspaceSheet: View {
    @Binding var workspace: PrimaryWorkspace
    @Binding var detent: PresentationDetent
    @Binding var query: String
    let compactDetent: PresentationDetent

    private var isCompact: Bool { detent == compactDetent }

    var body: some View {
        TabView(selection: $workspace) {
            Tab("未来", systemImage: "calendar", value: .upcoming) {
                WorkspacePage(isCompact: isCompact, workspace: .upcoming) {
                    UpcomingJourneysContent()
                }
            }

            Tab("统计", systemImage: "chart.bar.xaxis", value: .passport) {
                WorkspacePage(isCompact: isCompact, workspace: .passport) {
                    PassportStatisticsContent() // 不包含 Map
                }
            }

            Tab("全部", systemImage: "tram", value: .allJourneys) {
                WorkspacePage(isCompact: isCompact, workspace: .allJourneys) {
                    AllJourneysContent()
                }
            }

            // iOS 26/27 自动把它分离为右侧圆形 Liquid Glass。
            Tab(value: .search, role: .search) {
                WorkspacePage(isCompact: isCompact, workspace: .search) {
                    SearchAndAddJourneyContent()
                }
            }
        }
        .searchable(text: $query)
        .tabBarMinimizeBehavior(.never)
    }
}

private struct WorkspaceHeader: View {
    let workspace: PrimaryWorkspace
    let isCompact: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(headerTitle)
                .font(isCompact ? .title3.bold() : .largeTitle.bold())
                .frame(maxWidth: .infinity, alignment: .leading)

            // 按工作区提供搜索、筛选、范围、分享、路网、Data/Settings。
            WorkspaceActions(workspace: workspace)
        }
    }

    private var headerTitle: LocalizedStringKey {
        switch workspace {
        case .upcoming: "未来行程"
        case .passport: "乘车统计"
        case .allJourneys: "全部行程"
        case .search: "搜索与加入线路"
        }
    }
}
```

普通 Tab、选中态、Search 语义与 VoiceOver 全部由系统 `TabView` 提供。`WorkspaceHeader` 在 Compact 使用缩小字号和紧凑间距，在 Half/Full 使用大标题；Compact 不挂载正文，避免矮 Sheet 出现截断内容。加入线路放在 Search/Add 内容页，并在该页三档头部提供标准 `+` 按钮。

iOS 18–25 使用同一个语义 Search Tab，但由当代系统外观呈现；iOS 17 使用旧 `tabItem/tag` 拼法提供四个系统 Tab 作为兼容路径。Data Library 与 Settings 由各工作区一致的右上入口打开。关闭 Utility Sheet 时原工作区、导航路径、筛选、滚动和共享地图状态不得被重建。示例中的 Content 是目标架构占位名，实施时复用当前 `ContentView`、`StatisticsView`、`DataManagerView` 与 `SettingsView`，不得平行复制业务状态。

### 11.10.1 现有项目的具体修改位置

本轮文档基于现有 Swift 代码复核；后续实施不得另建一套平行 Shell：

| 文件 / Symbol | 当前代码状态 | 后续实施要求 |
| --- | --- | --- |
| `ios/RailMap/AppShell.swift` · `ContentView` | 一个 `PrimaryTab` 驱动 Sheet 内的系统 `TabView`；初始值为 `.upcoming` | 保留单一 store/controller 与共享地图；Search 是语义目的地，不得退回动作型假 Tab |
| `ios/RailMap/BottomChrome.swift` · `PrimaryTab` | 已定义 `.upcoming / .stats / .all / .search` | 前三项保持顺序；`.search` 只用于 `role: .search`，不增加 Network case |
| `ios/RailMap/BottomChrome.swift` · `BottomChromeMetrics` | Compact 使用缩小标题行加系统 Tab Bar 标准区域，并提供 Compact/Medium/`.large` | 继续使用系统 Detent；不要测量系统 Tab 内部控件，也不要自定义拖拽 |
| `ios/RailMap/BottomChrome.swift` · `residentBottomSheet` / `SystemSheetTabSurface` | 使用 `.presentationDragIndicator(.hidden)`、`.scrolls`、ShapeStyle 形式的 `.presentationBackground(Color)`、背景交互和 `.interactiveDismissDisabled()` | ShapeStyle 直接替换 iOS 26 partial Sheet 的默认玻璃背景；Compact/Half/Full 使用同一 base 层级实体色且 Sheet 无 Liquid Glass；正文滚动独立于 Half/Full 高度；固定标题区负责触摸拖动，标题提供可访问性 Detent actions；系统 TabView 保留 Liquid Glass |
| `ios/RailMap/BottomChrome.swift` · `PanelHeader` / `CompactPanelHeader` | Medium/Expanded 使用 `.largeTitle.bold()`；Compact 使用 `.title3.bold()` 与紧凑间距 | 右上 `actions` 必须按工作区变化；Compact 仅隐藏正文，不隐藏标题行 |
| `ios/RailMap/ContentView.swift` · `workspaceTabs(stage:)` | iOS 18+ 使用 `Tab` API；Search 使用 `Tab(value:role:.search)`；iOS 17 使用系统兼容 TabView | 不调用 `.glassEffect`、`matchedGeometryEffect` 或自绘 Capsule 模拟底栏；iOS 26+ 使用 `.tabBarMinimizeBehavior(.never)` |
| `ios/RailMap/ContentView.swift` · `mapLayout(in:)` | 已以一个 `RailMapView` 为根，并挂载 `.residentBottomSheet` | 保持唯一地图；工作区切换只更新 `mapRides`/显示投影，不创建三份地图 |
| `ios/RailMap/ContentView.swift` · `tabPage(_:stage:)` | 系统 TabView 切换 Upcoming/Stats/All/Search 内容 | Compact 挂载缩小头部但不挂载正文；Network 作为地图模式进入，不增加 Tab |
| `ios/RailMap/PassportWorkspaceView.swift` | 已组合统计、日志、回放与 `PassportCoverageNote` | 不得添加地图 View；覆盖范围直接由根地图表达 |
| `ios/RailMap/PassportCoverageMapView.swift` · `PassportCoverageNote` | 当前已不实例化 `MKMapView`，只提供覆盖说明与适配范围操作 | 可保留为说明/控制卡，或重命名以消除“小地图”误解；禁止恢复 280 pt 小地图 |
| `ios/RailMap/StatisticsView.swift` · `StatisticsDashboardContent` | 当前是纯统计内容，没有 `ScrollView` 外壳和地图 | 保持无地图、无第二导航标题，由 Sheet 统一提供头部 |
| `app/public/index.html` + `app/public/styles/device-layout.css` | Web 仍需模拟系统 Sheet 语义 | 三项与 Search/Add 放进同一个 `.pull-up-menu`；地图 DOM 只保留一份 |

系统 TabView 的目标结构应在 `ContentView.workspaceTabs(stage:)` 原位实现，示例：

```swift
struct WorkspaceTabs: View {
    @Binding var selection: PrimaryTab
    @Binding var query: String

    var body: some View {
        TabView(selection: $selection) {
            Tab("未来", systemImage: "calendar", value: .upcoming) {
                UpcomingContent()
            }

            Tab("统计", systemImage: "chart.bar.xaxis", value: .stats) {
                PassportContent()
            }

            Tab("全部", systemImage: "tram", value: .all) {
                AllJourneysContent()
            }

            Tab(value: .search, role: .search) {
                SearchAndAddJourneyContent()
            }
        }
        .searchable(text: $query)
        .tabBarMinimizeBehavior(.never)
    }
}
```

前三项的连续胶囊、选中 Lens、右侧 Search 圆形、玻璃采样和交互动画全部来自系统。底栏不得使用 `railGlass`、`.glassEffect`、自绘 `Capsule` 或 `matchedGeometryEffect`。Search/Add 页面的 `+` 是内容主操作，不是 Tab。

---

## 12. Web 示例代码

> Web 示例保持现有 classic-script 兼容思路：展示解析器可以作为纯函数加入专门模块，DOM 渲染继续通过现有 `app-render.js` / `app-editor.js` 路径调用。不要在 CSS 中改变现有 DOM id 作为行为 Hook 的契约。

## 12.1 展示解析器

```js
/**
 * @typedef {'unknown'|'resolving'|'resolved'|'needs-review'|'unavailable'} RouteState
 * @typedef {'normal'|'hidden'|'playing'|'paused'} JourneyMode
 */

/**
 * @param {{number:string, origin:string, destination:string, visible?:boolean}} train
 * @param {{routeState:RouteState, routeReason?:string, mode:JourneyMode}} context
 */
function resolveJourneyPresentation(train, context) {
  const route = `${train.origin} → ${train.destination}`;

  if (context.mode === "playing" || context.mode === "paused") {
    return {
      eyebrow: train.number,
      title: context.mode === "paused" ? "回放已暂停" : "正在回放",
      subtitle: route,
      tone: "neutral",
      primaryAction: context.mode === "paused" ? "resume" : "pause",
      secondaryActions: ["stop", "details"],
    };
  }

  if (train.visible === false) {
    return {
      eyebrow: train.number,
      title: "已从地图隐藏",
      subtitle: route,
      tone: "neutral",
      primaryAction: "show-on-map",
      secondaryActions: ["edit", "more"],
    };
  }

  if (context.routeState === "unavailable") {
    return {
      eyebrow: train.number,
      title: "无法绘制路线",
      subtitle: context.routeReason || route,
      tone: "critical",
      primaryAction: "rebuild-route",
      secondaryActions: ["edit-stops", "details"],
    };
  }

  if (context.routeState === "needs-review") {
    return {
      eyebrow: train.number,
      title: "路线需要检查",
      subtitle: context.routeReason || route,
      tone: "caution",
      primaryAction: "rebuild-route",
      secondaryActions: ["edit-stops", "details"],
    };
  }

  if (context.routeState !== "resolved") {
    return {
      eyebrow: train.number,
      title: "正在构建铁路路线",
      subtitle: route,
      tone: "neutral",
      primaryAction: null,
      secondaryActions: ["edit", "details"],
    };
  }

  return {
    eyebrow: null,
    title: train.number,
    subtitle: route,
    tone: "normal",
    primaryAction: "locate",
    secondaryActions: ["play", "edit", "more"],
  };
}
```

所有用户文案正式实现时必须通过 `I18N.t()`，不得把示例中文直接硬编码进生产模块。

## 12.2 语义 Token

```css
:root {
  --jrm-action: var(--ios-tint);
  --jrm-positive: var(--ios-green);
  --jrm-caution: var(--ios-orange);
  --jrm-critical: var(--ios-red);

  --jrm-label: var(--ios-label);
  --jrm-label-secondary: var(--ios-label-secondary);
  --jrm-surface: var(--ios-secondary-grouped-background);
  --jrm-surface-grouped: var(--ios-grouped-background);
  --jrm-separator: var(--ios-separator);

  --jrm-space-1: 0.25rem;
  --jrm-space-2: 0.5rem;
  --jrm-space-3: 0.75rem;
  --jrm-space-4: 1rem;
  --jrm-space-5: 1.25rem;
  --jrm-space-6: 1.5rem;
  --jrm-space-8: 2rem;

  --jrm-radius-control: 0.75rem;
  --jrm-radius-card: 1.25rem;
  --jrm-radius-sheet: 1.875rem;
  --jrm-screen-margin: 0.75rem;
  --jrm-tabbar-clearance: 5.5rem;

  --jrm-motion-fast: 100ms;
  --jrm-motion-replace: 180ms;
  --jrm-ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
}
```

这组变量应映射现有 `--ios-*` 语义变量，不要求立刻删除兼容旧选择器的 alias。Web 深色模式也只能重映射这些 iOS 语义角色，不能让组件切换到独立的纯黑 Flighty palette。

## 12.3 Journey Summary DOM

```html
<button class="journey-summary" type="button" aria-pressed="false">
  <span class="journey-summary__identity">
    <strong class="journey-summary__number">踊り子 1号</strong>
    <span class="journey-summary__route">東京 → 伊豆急下田</span>
  </span>
  <span class="journey-summary__timing">
    <time datetime="2026-07-03T09:00">09:00</time>
    <span class="journey-summary__date">2026-07-03</span>
  </span>
</button>
```

如果整行使用 `<button>`，内部 More 不能再嵌套 `<button>`；More 应作为并列 sibling，外层用 `role="group"` 组合。

## 12.4 Journey Summary CSS

```css
.journey-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--jrm-space-3);
  width: 100%;
  min-height: 4.5rem;
  padding: var(--jrm-space-3) var(--jrm-space-4);
  border: 1px solid transparent;
  border-radius: var(--jrm-radius-card);
  background: var(--jrm-surface);
  color: var(--jrm-label);
  text-align: start;
}

.journey-summary:active {
  transform: scale(0.98);
  transition: transform var(--jrm-motion-fast) ease-out;
}

.journey-summary[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--jrm-action) 42%, transparent);
  background: color-mix(in srgb, var(--jrm-action) 10%, var(--jrm-surface));
}

.journey-summary__identity,
.journey-summary__timing {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--jrm-space-1);
}

.journey-summary__number {
  overflow: hidden;
  font-size: 1rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.journey-summary__route,
.journey-summary__date {
  color: var(--jrm-label-secondary);
  font-size: 0.8125rem;
}

.journey-summary__timing {
  align-items: end;
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .journey-summary:active {
    transform: none;
    transition: background-color var(--jrm-motion-fast) linear;
  }
}
```

## 12.5 状态块

```html
<section class="task-status task-status--critical" role="alert">
  <div class="task-status__symbol" aria-hidden="true">×</div>
  <div>
    <h2>无法绘制路线</h2>
    <p>未能在“大船 → 藤沢”之间找到符合约束的铁路路径。</p>
    <div class="task-status__actions">
      <button class="primary">编辑停站</button>
      <button>查看路线约束</button>
    </div>
  </div>
</section>
```

状态块必须留在相关旅程内，直到原因消失或用户明确关闭；不要只发一个 3 秒 toast。

## 12.6 面板拖拽目标解析

```js
function nearestDetent(projectedHeight, detents) {
  return detents.reduce((best, next) =>
    Math.abs(next - projectedHeight) < Math.abs(best - projectedHeight)
      ? next
      : best
  );
}

function projectPosition(current, velocityPxPerSecond, rate = 0.998) {
  const projectedTravel = (velocityPxPerSecond / 1000) * rate / (1 - rate);
  return current + projectedTravel;
}

function rubberBand(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) /
    (dimension + constant * Math.abs(overshoot));
}
```

正式实现必须使用 Pointer Events 与 `setPointerCapture()`，并从 `pointerdown` 开始反馈；不要只监听最终 `swipe` 事件。

## 12.7 降低透明度与对比度

```css
@media (prefers-reduced-transparency: reduce) {
  .map-functional-layer,
  .journey-panel {
    background: var(--jrm-surface);
    backdrop-filter: none;
  }
}

@media (prefers-contrast: more) {
  .map-functional-layer,
  .journey-panel,
  .journey-summary {
    border: 1px solid CanvasText;
  }
}
```

浏览器支持不完整时，以高不透明实色为默认降级，不能依赖媒体查询一定存在。

## 12.8 Web 三段式悬浮菜单

Web 是常驻系统 Sheet 语义的近似降级：底部选择器必须位于 `.pull-up-menu` 内部，不再作为独立 fixed Tab Bar。DOM 顺序固定为：

```html
<aside class="pull-up-menu" data-detent="half">
  <header class="workspace-header">
    <h1>未来行程</h1>
    <div class="workspace-actions"><!-- contextual buttons --></div>
  </header>
  <main class="pull-up-menu__scroll"><!-- current workspace --></main>
  <footer class="workspace-bottom-row">
    <nav class="workspace-tabbar" aria-label="主要工作区">
      <button aria-selected="true">未来</button>
      <button aria-selected="false">统计</button>
      <button aria-selected="false">全部</button>
    </nav>
    <button class="add-journey-button" aria-label="加入线路">+</button>
  </footer>
</aside>
```

`.add-journey-button` 不是第四个 Tab；三个页面继续共用 `.map-spatial-layer`，Passport 不渲染第二个地图容器。

```css
.rides-workspace {
  position: relative;
  min-height: 100dvh;
  overflow: clip;
}

.map-spatial-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.pull-up-menu {
  position: absolute;
  z-index: 20;
  right: var(--jrm-screen-margin);
  bottom: 0;
  left: var(--jrm-screen-margin);
  box-sizing: border-box;
  height: var(--menu-height);
  overflow: clip;
  border: 1px solid color-mix(in srgb, var(--jrm-separator) 64%, transparent);
  border-radius: var(--jrm-radius-sheet);
  background:
    color-mix(in srgb, var(--ios-material-strong) 72%, transparent);
  box-shadow:
    0 -0.5rem 2rem color-mix(in srgb, var(--jrm-label) 14%, transparent);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  backdrop-filter: blur(28px) saturate(180%);
  transform: translate3d(0, var(--menu-drag-y, 0), 0);
  will-change: transform;
}

.pull-up-menu[data-detent="docked"] {
  --menu-height: var(--menu-docked-height);
}

.pull-up-menu[data-detent="half"] {
  --menu-height: 54dvh;
}

.pull-up-menu[data-detent="full"] {
  --menu-height: 100dvh;
  inset: 0;
  border-radius: 0;
}

.workspace-bottom-row {
  position: absolute;
  z-index: 2;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  gap: 0.625rem;
  align-items: center;
  padding:
    0.5rem 0.75rem
    max(0.5rem, env(safe-area-inset-bottom));
}

.workspace-tabbar {
  display: grid;
  flex: 1;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.add-journey-button {
  flex: 0 0 3rem;
  inline-size: 3rem;
  block-size: 3rem;
  border-radius: 50%;
}

.pull-up-menu__scroll {
  box-sizing: border-box;
  height: 100%;
  padding-bottom:
    calc(var(--jrm-tabbar-clearance) + env(safe-area-inset-bottom) + 0.75rem);
  overflow: auto;
  overscroll-behavior: contain;
  scroll-padding-bottom:
    calc(var(--jrm-tabbar-clearance) + env(safe-area-inset-bottom));
}

@media (min-width: 600px) {
  .pull-up-menu {
    --jrm-screen-margin: 1rem;
  }
}
```

Web 的 `backdrop-filter` 只是 iOS Liquid Glass 的近似降级，不应添加黑色遮罩模拟玻璃。浏览器不支持 blur 时，回退到 `--ios-material-strong` 对应的高不透明系统表面。

---

## 13. 空状态、加载态与错误文案

## 13.1 空状态

| 场景 | 标题 | 说明 | 主操作 |
| --- | --- | --- | --- |
| 无任何旅程 | 还没有乘车记录 | 新建一趟旅程，或导入已有 JSON | 新增旅程 |
| 日期无旅程 | 这一天没有旅程 | 当前日期筛选没有记录 | 新增到此日期 |
| 搜索无结果 | 没有匹配的旅程 | 尝试车次、车站或 ID | 清除搜索 |
| 地图无路线 | 这趟旅程尚无可绘制路线 | 记录仍然安全保存 | 检查路线 |

空状态不得同时放三个同权主按钮。

## 13.2 加载状态

- 小于约 400 ms 的操作无需闪烁进度 UI。
- 超过约 400 ms 显示阶段名称。
- 超过约 3 s 且总量已知时显示定量进度。
- 允许取消时必须有取消操作；取消后保留一致数据状态。

## 13.3 错误文案结构

```text
发生了什么
影响了什么
保留了什么
用户下一步可以做什么
```

示例：

```text
无法绘制这趟路线
“大船 → 藤沢”没有找到符合当前线路约束的路径。
旅程记录和停站没有改变。
[编辑停站] [查看约束]
```

禁止：

```text
Error 500
Something went wrong
OK
```

---

## 14. 验收矩阵

## 14.1 功能验收

- [ ] 顶层工作区顺序严格为 Upcoming、Passport、All Journeys；三项位于同一常驻系统 Sheet 底部，Network 不占 Tab。
- [ ] 最右 `+` 是与三项 Tab 分组分离的加入线路按钮，不是第四个 Tab，不显示 selected trait，并可完成现有新增旅程流程。
- [ ] 三个工作区只有一个持续挂载的地图实例；切换只改变投影/覆盖层/筛选，不重建地图、store、coordinator 或相机。
- [ ] Half/Full 的左上显示当前工作区大标题，右上显示上下文功能按钮；Docked 只显示底部选择器与 `+`，没有标题、正文、残影或多余空白。
- [ ] 从 Data Library/Settings 返回后，原 Tab、导航路径、日期/搜索筛选和滚动位置完整恢复。
- [ ] `ios/FEATURES.md` 列出的当前功能均可从新架构到达，没有因 Rides/Statistics/Data/Settings 重组而丢失。
- [ ] Friends、实时延误/预测、天气/运营中断、Connection Assistant、车辆实时位置、Calendar/TripIt/Email、iCloud/账户/Pro 等不存在的能力没有空入口或伪数据。
- [ ] 列表搜索、日期筛选、选择与地图高亮保持同步。
- [ ] 新增/删除日期、新增/复制/删除/重排旅程、显示/隐藏和编辑停站均可完成。
- [ ] 详情关闭后保留筛选、搜索与滚动位置。
- [ ] 每个状态只有一个 Prominent 主操作。
- [ ] 路线失败不会画直线、不会删除记录，并提供明确恢复动作。
- [ ] Route alternatives 与 straight-line fallback 保持禁用；路线策略和 route sections 的现有可编辑字段完整保留。
- [ ] 编辑取消不写入半成品；保存原子提交。
- [ ] 隐藏状态明确且可以一键恢复显示。
- [ ] 导入在提交前显示 replace/append 模式、目标、schema、数量、add/replace/keep/rename 影响与 JSON-path 问题。
- [ ] 文件/粘贴导入、仅验证、分段进度/取消、JSON 保存/复制/预览、样例、My Data、恢复备份和 Danger Zone 全部可达。
- [ ] 回放状态优先于普通详情操作，手动地图操作可中断自动跟随。
- [ ] 回放视频保留画幅、质量、码率、开始/取消/完成以及 Web 下载/iOS 分享；文案不称为 Live Share。
- [ ] Passport 保留全时段/单日、分类与去重里程、类别覆盖率、每线路明细、最常乘坐区间、旅程日志与共享地图覆盖模式。
- [ ] Passport/Statistics 内容中没有小地图、缩略地图或第二个 MapKit/MapLibre 容器；`PassportCoverageMapView` 不再拥有地图实例。
- [ ] Shared-map Network Mode 保留地区切换、zoom LOD、Display Parts、官方明暗线路色、站点/标签/弹层、端点标签、底图透明度与路网包诊断。
- [ ] Settings 保留语言/地区、站名读音、外观、地图、旅程线、marker、选择/聚焦、显示重置和诊断设置。
- [ ] 底图离线不阻断记录浏览、导出和可用的铁路图层。
- [ ] 常驻系统 Sheet 不可交互下滑关闭，可稳定停靠在 Docked、Half、Full，并可通过无 Grabber 拖拽与可访问性操作切换。
- [ ] Sheet 内最后一行内容和滚动指示器不被底部选择器/Home Indicator 遮挡。
- [ ] Half 状态无需先拉到 Full 即可滚动全部正文；正文滚动不会改变当前 Detent。

## 14.2 视觉验收

- [ ] 地图、信息层、功能层能一眼区分。
- [ ] 大型内容表面没有逐卡玻璃化。
- [ ] iOS chrome、菜单和内容只使用系统语义色；没有固定纯黑主背景或自定义黑色 Flighty palette。
- [ ] iOS 26/27 使用系统 Liquid Glass；iOS 17–25 使用 `.regularMaterial` 的一致降级。
- [ ] Docked/Half 由系统 Sheet 提供 12–16 pt 左右留白与连续圆角；Full 由系统 `.large` 连续扩展并填满可用屏幕。
- [ ] Docked/Half/Full 的菜单内容区始终为实体系统色：亮色白色、暗色 iOS 默认 Sheet 深灰；系统底栏在三档均保留 Liquid Glass。
- [ ] Sheet 的底部选择器和内容属于同一系统表面；界面中不存在 Sheet 外的第二条 Tab Bar。
- [ ] 状态色未用于装饰或统计数值高低。
- [ ] 时间、里程、百分比使用等宽数字。
- [ ] L4 元数据未出现在默认 Hero。
- [ ] Light/Dark/System 均可读，铁路色不会与底图丢失对比。
- [ ] 选中态除颜色外还有边界、casing 或 selected trait。

## 14.3 动效验收

- [ ] 按下瞬间有反馈，不等待 click/touch-up。
- [ ] 面板拖动 1:1 跟手，可中途反向。
- [ ] 释放时按速度/预测终点选择停靠点。
- [ ] Docked/Half/Full 之间底栏保持位置连续；Compact 露出缩小标题行但不泄漏正文，Half/Full 使用大标题。
- [ ] Sheet 拖到 Full 时由系统连续扩展，不出现自绘边距/圆角跳变；底部选择器随同一表面进入满屏。
- [ ] 地图镜头动画可被手势打断。
- [ ] Reduce Motion 下无大幅弹性、滑动和视差，但保留必要反馈。

## 14.4 可访问性验收

- [ ] iOS Accessibility 字号下无截断关键内容。
- [ ] Web 200% 文本缩放下主要任务可完成。
- [ ] 所有图标按钮有业务语义标签。
- [ ] 状态不只靠颜色。
- [ ] 旅程卡、停站时间线和统计图表有可理解的读屏顺序。
- [ ] 键盘可完成选择、编辑、保存、关闭和主要地图操作。
- [ ] 焦点在 Modal 打开/关闭后正确转移和恢复。

## 14.5 本地化验收

- [ ] 繁中、简中、日文、英文无固定英文宽度假设。
- [ ] 长站名与长车次名称可换行。
- [ ] 日期、数字、单位遵循 locale；24+ 小时业务时间保持正确。
- [ ] 国家/地区变体字符串继续生效。

---

## 15. 建议的实现切片（下一阶段，不在本阶段执行）

### Slice 1：展示状态层

目标：先建立 `JourneyPresentationResolver`，不改视觉。

涉及候选位置：

- iOS：`ios/RailMap/` 新增展示模型文件，接入 `ItineraryStore`、`RiddenRouteStore` 与 `PlaybackController`。
- Web：`app/public/` 新增纯展示解析模块，由 `app-render.js`、`app-editor.js` 调用。

验收：相同输入状态只产生一个主操作；失败/隐藏/回放优先级有单元测试。

### Slice 2：旅程首页与已选 Hero

目标：重构列表摘要、动态 Hero 和操作组，保留所有现有事件 Hook。

涉及候选位置：

- iOS：`ContentView.swift`、`RideCard.swift`、`RideDetailView.swift`、`RideSheet.swift`。
- Web：`index.html`、`app-render.js`、`styles/ios-presentation.css`、`styles/device-layout.css`。

### Slice 3：常驻系统 Sheet、三工作区与 Utility destination

目标：将当前 iOS `Rides / Statistics / Data / Settings` 与 Web 对应入口重组为 `Upcoming / Passport / All Journeys / Search`，在常驻系统 Sheet 内使用语义 Search Tab，并将 Data Library/Settings 改为可恢复上下文的 Utility Sheet/Route。

涉及候选位置：

- iOS：`ios/RailMap/AppShell.swift`（保留单一 Root store）、`ios/RailMap/BottomChrome.swift`（正式常驻 Sheet、Detent 与头部）、`ios/RailMap/ContentView.swift`（Sheet 内系统 `TabView`、语义 Search、共享地图与全部工作区内容）、`ios/RailMap/RideSheet.swift`（Sheet 内详情导航）、`ios/RailMap/StatisticsView.swift`（Tab 2 内容）、`ios/RailMap/DataManagerView.swift`、`ios/RailMap/SettingsView.swift`。
- Web：`index.html`、`app-events.js`、`app-state.js`、`app-render.js`、响应式导航 CSS。

验收：系统 TabView 显示 Upcoming/Passport/All Journeys，并自动把语义 Search 分离在右侧；加入线路位于 Search/Add 页面；Sheet 不可关闭且无可见 Grabber；关闭 Utility 后完整恢复原工作区状态；业务 store 不因视图搬迁而复制。

### Slice 4：编辑、路线状态与错误恢复

目标：字段就地校验、路线状态模型、明确失败恢复路径。

涉及候选位置：

- iOS：`RideEditorView.swift`、`ItineraryStore.swift`、`RiddenRouteStore.swift`。
- Web：`app-editor.js`、`app-route-features.js`、`app-route-service.js`、`app-modal.js`。

### Slice 5：共享地图、Network Mode 与 Passport

目标：让 Upcoming、Passport、All Journeys 始终复用同一地图；把完整路网保留为 Shared-map Network Mode；把现有 Statistics 扩成包含 scope、共享地图覆盖投影、旅程日志和回放分享入口的 Passport，并移除统计小地图。

涉及候选位置：

- iOS：`ios/RailMap/ContentView.swift` 的 `map` / `mapRides`（唯一地图实例与投影切换）、`ios/RailMap/RailMapView.swift`、`ios/RailMap/PassportWorkspaceView.swift`（组合 Passport 内容但不创建地图）、`ios/RailMap/PassportCoverageMapView.swift` 的 `PassportCoverageNote`（保持说明/控制职责，可重命名但禁止恢复地图容器）、`ios/RailMap/RailNetworkStore.swift`、`ios/RailMap/MapControlBar.swift`、`ios/RailMap/StatisticsView.swift`（不得创建 Map）、`ios/RailMap/MileageStatisticsStore.swift`、`ios/RailMap/PlaybackController.swift`。
- Web：`rail-network.js`、`app-display-features.js`、`app-stats.js`、`app-stats-render.js`、`app-playback.js`、`app-route-render.js`。

验收：三个工作区共用地图、路网配置、记录选择和相机；Passport 页面不存在第二张小地图；Network Mode 退出后恢复原工作区上下文；不存在第二份可漂移的数据源。

### Slice 6：Data Library、Settings 与离线降级

目标：移动入口但完整保留来源 Hero、导入预检、阶段进度、导出/样例/My Data/恢复/Danger Zone、显示设置、诊断与底图/同步降级。

涉及候选位置：

- iOS：`DataManagerView.swift`、`DataImportView.swift`、`ImportFlow.swift`、`SettingsView.swift`、`DisplaySettings.swift`、`RideLibrary.swift`、`TrainStoreDocument.swift`。
- Web：`app-import-controller.js`、`app-import.js`、`app-validation.js`、`app-persistence.js`、`app-store-ops.js`、`app-display-settings.js`。

### Slice 7：Passport 表现层

目标：统计和回放使用铁路路线色、票据/线路图隐喻与更有表现力的输出，但不改变准确性。

### Slice 8：动效、可访问性与 QA

目标：统一 spring/transition、Reduced Motion、Dynamic Type、键盘与读屏；以慢速录屏和逐帧检查面板/地图交接。

每个 Slice 都必须：

1. 不改变 JSON 1.3 语义。
2. 不破坏 Web/Swift 的纯逻辑 parity 边界。
3. 运行与风险相称的现有测试。
4. 新增展示状态的确定性测试与可访问性检查。

---

## 16. 文件级非目标与保护规则

- `ios/RailKit/Sources/RailCore/`：不得加入 SwiftUI/MapKit 展示状态。
- `app/public/app-state.js`：仍是主要 selection/date/store 状态所有者；重构前先明确新展示状态的唯一 owner。
- `app/public/index.html`：现有 DOM id 是事件绑定契约，实施阶段不能因改视觉随意重命名。
- `port-fixtures/`：本轮 UI 重构不应改变纯逻辑 fixture 答案。
- `jsonspec.md` / `jsonspec-values.*`：本轮不改 schema。
- 地图线路色与站点显示规则继续遵循现有铁路数据与 Apple Maps 对齐规范，不由 Flighty 风格覆盖。

---

## 17. 设计评审问题

每个重要界面进入实现前，至少回答：

1. 这一状态的一句话主问题是什么？
2. L0–L4 分别是什么？
3. 唯一主操作是什么？
4. 正常、处理中、失败、隐藏、离线分别如何变化？
5. 用户中途打断或返回时，哪些状态必须保留？
6. Dynamic Type/200% zoom 后，横向结构如何重排？
7. Reduce Motion 后，状态变化仍如何被理解？
8. 如果去掉颜色，状态是否仍可辨认？
9. 如果地图不可用，核心任务是否仍能完成？
10. 此设计是在复制 Flighty 的视觉，还是实现 JRM 的信息优先级函数？

重要状态应先探索多种信息结构，不要把“换 20 种颜色/圆角”算作 20 个方案。

---

## 18. 参考资料

本规格基于用户提供的两份 Flighty 研究材料（含截至 2026-08-22 的 Flighty 4.10.1 页面树、页面职责、交互状态与多代界面对照），并逐项对照当前 JRM 代码与 `ios/FEATURES.md` 重新映射。研究材料用于抽取设计规则，不作为 JRM 已具备实时航空能力的证据。主要外部依据：

- [Apple：Behind the Design — Flighty](https://developer.apple.com/news/?id=970ncww4)
- [Apple：Spotlight on the Dynamic Island](https://developer.apple.com/news/?id=mis6swzt)
- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Apple HIG：Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)
- [Apple HIG：Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple HIG：Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Apple HIG：Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple HIG：Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Apple HIG：Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Apple：Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
- [Apple：Applying Liquid Glass to custom views](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views)
- [Apple：presentationDragIndicator](https://developer.apple.com/documentation/swiftui/view/presentationdragindicator%28_%3A%29)
- [Apple：PresentationContentInteraction.resizes](https://developer.apple.com/documentation/swiftui/presentationcontentinteraction/resizes)
- [WWDC25：Build a SwiftUI app with the new design](https://developer.apple.com/videos/play/wwdc2025/323/)
- [WWDC25：Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/)
- [WWDC26：What's new in SwiftUI](https://developer.apple.com/videos/play/wwdc2026/269/)
- [Flighty：Offline mode](https://flighty.com/help/offline-mode)
- [Flighty：Connection Assistant](https://flighty.com/help/connection-assistant)
- [Flighty：Live Activities and Widgets](https://flighty.com/help/live-activities-widgets)

仓库内依据：

- `README.md`：JRM 产品边界与用户流程。
- `ios/README.md`：MapKit、响应式布局与平台架构。
- `ios/FEATURES.md`：Web 与 iOS 能力差异。
- `app/docs/frontend-architecture-baseline.md`：Web 状态所有权和渲染流程。
- `RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md`：铁路数据与地图显示规则。
- `jsonspec.md`：数据合约。

---

## 19. 最终原则

> 不要把 JRM 画成 Flighty。让 JRM 像 Flighty 一样，始终知道用户此刻最需要看见什么、最需要做什么，并在数据不确定或任务失败时仍然保持诚实、安静和可恢复。
