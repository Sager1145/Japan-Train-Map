# iOS app 全量代码审计 — 分析与步骤

日期 2026-08-26。范围只有 `ios/`（app target `RailMap`、本地包 `RailKit`、
`RailMapUITests`、`tools`）。`app/` 的 JavaScript 不在整理范围内，但它是这个端
的**参考实现**，任何改动都不允许让两端的答案分叉。

本文只做 Phase 1（清点）、Phase 2（问题）、Phase 3（计划）。一行代码都还没改。

---

## Phase 0 · 基线（本次实测，不是推测）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| RailKit 编译 | `swift build --scratch-path <scratch>` | **PASS**，16.05 s，**0 warning** |
| RailKit 测试 | `swift test --scratch-path <scratch>` | **PASS** — 23 suites / 206 tests（含参数化共 243 个 ✔），36.3 s |
| app 编译 | `xcodebuild -scheme RailMap -sdk iphonesimulator build` | **PASS**，**0 warning** |
| formatter | — | **无**。仓库里没有 `.swiftformat` / `.swiftlint.yml`，机器上也没装 |
| type check | 同编译 | Swift 编译即类型检查，PASS |
| Runtime | — | **NOT VERIFIED**（见下方阻塞项） |
| UI tests / verify.sh 全量 | `./verify.sh` | **NOT VERIFIED** — 全量会先跑 `app/` 的 `npm test`＋`npm run lint`＋fixture `--check`，属于 JS 端，本次没跑 |

> 记：`xcodebuild` 提示 `Run script build phase 'Copy rail packages' will be run
> during every build because ... "Based on dependency analysis" is unchecked`。
> 这是**故意**的（脚本从 `app/public/rail` 与 `app/data` 拉最新数据），不是缺陷。

### 代码量

| 层 | 文件 | 行 |
| --- | ---: | ---: |
| app target `RailMap/` | 65 | 26,810 |
| `RailKit/Sources/RailCore/` | 25 | 20,706 |
| `RailKit/Sources/RailPresentation/` | 6 | 1,709 |
| `RailKit/Tests/` | 29 | 13,548 |
| `RailMapUITests/` | 5 | 603 |
| `tools/` | 4 | 1,030 |

---

## ⛔ 开工前必须先解决的两个阻塞项

### BLOCK-1 · 另一个会话正在改本次要动的那两个文件

`ListAgents` 报告本机有 **18 个并行会话**，其中两个是 16 分钟前起的。实测：

```
00:03  RailMap/ContentView.swift        被改
00:03  RailMap/BottomChrome.swift       被改
00:04  RailMap/RailMapView.swift        被改
00:17  RailMapUITests/ZZTempSheetMorphProbe.swift
00:18  RailMapUITests/ZZTempPresentationProbe.swift   ← 在我做这次清点期间新建的
```

`ContentView.swift` 与 `RailMapView.swift` 正好是本次重构工作量的 **60%**。在别
人手指还按在键盘上的时候拆这两个文件，冲突不是风险而是必然。

**要么**等那个会话落盘并提交，**要么**本轮把这两个文件整体排除、只做其余部分。
需要你决定。

### BLOCK-2 · 工作区有 54 个未提交改动，没有干净的回滚点

`git status` 在 `ios/` 下有 54 个 modified、4 个 untracked，最后一次提交是
08-22（四天前）。behavior-preserving 重构的前提是「出问题能一键退回」，现在没有
这个前提。

**建议**：动手前先把现有工作提交成一个 checkpoint（或至少 `git stash` 出一份），
否则重构的 diff 和四天的在途工作会搅在一起，谁都读不出来。

---

## Phase 1 · 清点

### 1.1 三层结构（编译器强制，不是约定）

```
RailMap.xcodeproj  (app target)          MapKit / SwiftUI / 存储 / UIKit
        ↓
RailPresentation   (RailKit)             Foundation + RailCore，只做「这个界面在讲哪件事」
        ↓
RailCore           (RailKit)             Foundation ONLY —— 逐函数对拍 JS 的纯逻辑层
```

这个分层由 `verify.sh` 用 grep 守着：`RailCore` / `RailPresentation` 里出现
`import MapKit|SwiftUI|UIKit|CoreLocation` 直接 fail。**重构不得触碰这条线。**

app target 的 import 矩阵实测是干净的：65 个文件里没有一个 store/model 文件
`import SwiftUI` 去做界面的事（`DisplaySettings` import SwiftUI 只为 `@Observable`
的宿主类型），也没有反向依赖。

### 1.2 app target 的职责分组（65 个文件）

| 组 | 文件 |
| --- | --- |
| 壳与布局 | `RailMapApp` `AppShell` `ContentView` `BottomChrome` `RideSheet` `UtilityDestination` |
| 地图渲染 | `RailMapView` `RailMapController` `NetworkLOD` `RailStyle` `MapLabelStyle` `MapLayers` `MapLayersView` `MapControlBar` `MapInfoView` `MapNaming` `MapDateScope` `MapEndpointLabels` `MapRideMarkers` `AppleMapDatum` |
| 存储 / 数据流 | `ItineraryStore` `RideLibrary` `MergedStore` `RiddenRouteStore` `RailNetworkStore` `MileageStatisticsStore` `StationPlaceStore` `StationReadingsStore` `EdgeIndexCache` `RegionCatalog` |
| 行程界面 | `RideCard` `RideDetailView` `RideEditorView` `RideLibrary` `JourneyComponents` `JourneyPresentationBridge` `RideRouteStatus` `EditorValidation` |
| 统计 | `StatisticsView` `StatisticsComponents` `StatisticsFormatting` |
| Passport | `PassportWorkspaceView` `PassportCardStyle` `PassportJourneyLogView` |
| 导入导出 | `DataManagerView` `DataImportView` `ImportFlow` `ImportPreflight` `TrainStoreDocument` |
| 播放 / 视频 | `PlaybackController` `PlaybackVideoExporter` `VideoExportSettings` `VideoExportOptionsView` |
| 样式 token | `GlassStyle` `RailMotion` `RailType` `OperatorBadge` |
| 文案 | `AppLocalization` `DataStrings` `EditorStrings` `JourneyStrings`（＋`StatisticsStrings` 寄居在 `StatisticsFormatting`） |

**这一层的职责边界总体是清楚的**，而且每个 store 文件顶上都有一段说明它「拥有
什么、不拥有什么」的文档注释。真正的问题集中在两个文件（见 P1-1、P1-2），不是
散布全仓。

### 1.3 重复度实测

用 12 行归一化窗口扫全部 `RailMap` ＋ `RailKit/Sources`：

```
不同的重复窗口：9 个    跨文件的只有 2 处
```

**这个仓库没有 copy-paste 泛滥问题。** 存在的重复是**结构性**的，共三类，处理
方式完全不同（见 P2-1 / P2-2 / P0-A）。

---

## Phase 2 · 问题清单

### P0 —— 会改错东西的，一个都没有

编译 0 warning、测试 206/206 绿、没有空 `catch {}`、没有 timer 泄漏（全仓只有
`PlaybackController` 一个 `CADisplayLink`，`invalidate()` 成对）、没有
`addObserver` 未摘除、没有 `@ts-ignore` 式的静音。**没有 P0 缺陷。**

但有一个 P0 级别的**约束**，写在这里因为它决定了后面每一步能不能做：

#### P0-A · `RailCore` 里的「重复实现」多数不能合并 —— 合并即改数字

`RailCore` 是逐函数对拍 JavaScript 的移植层，JS 那边本来就有多份形态不同的同名
原语，移植忠实地保留了它们。实测：

| 函数 | 变体数 | 判定 |
| --- | ---: | --- |
| `distanceMeters` | **5** | `Geometry`=haversine；`Grooming`=等距圆柱 `localMetric`；`RouteFeature`=自己的 `local`；`DisplayParts` 已经复用 `Grooming.localMetric`；`Stations` 是 `[Double]` 版 | 
| `pathLength` | 3 | 各自建在不同的 `distanceMeters` 家族上，跟着上一行走 |
| `turnDegrees` | 2 | `DisplayParts` 已复用 `Grooming.localMetric`，两份可能已经逐位相同 —— **待测** |
| `jsSorted` | 3 | 三个**不同的比较器**（`JSNumber.stringLessOrEqual` 取反 / 裸 utf16 字典序 / `stableSorted`+`jsLess`）。看起来能合，其实不能 |
| `jsTrim` | 3 | 2 个真变体：utf16 版（`Stations`）vs unicodeScalars 版（`Train`、`Dates` **逐字相同**） |
| `quote` | 3 | 三种 JSON 转义写法（scalars / utf16 / 流式 `inout`），输出**应该**一致 —— 待测 |
| `stationCodeSystem` | 3 | `Train` 的两个是重载转发，`Stations` 的是独立一份 |
| `sameCodeUnits` | 1 | `StationDisplay` 与 `Stations` **逐字相同** |
| `CodeUnits` struct | 1 | `OperatorBranding` / `StationDisplay` / `Stations` 三份**逐字相同** |

判别式（仓库内已有结论，`test/railway-topology-audit.test.js` 的
`DELIBERATELY_SEPARATE` 名单）：**`(a-b)*k` 与 `a*k-b*k` 在 IEEE-754 下不是同一
个数**。所以「先投影再求差」和「先求差再缩放」是两种实现，合并会动数值，而
`DisplayParts` 夹具比的是**抽稀之前**的几何，未必抓得住。

**因此本次只允许合并纯字符串原语**（`CodeUnits`、`sameCodeUnits`，最多加上
`Train`/`Dates` 那对逐字相同的 `jsTrim`），**且必须先做位型对拍**，证据标准与
JS 端一致：从五国成品包取真实坐标跑 `Float64Array`→`BigUint64Array` 比 bitPattern。
浮点原语一律**不动**，改为在代码里写清「为什么不能合并」。

---

### P1 —— 结构性，工作量大但价值高

#### P1-1 · `ContentView.swift` 是一个 2,973 行的 God View

`struct RailWorkspaceView` 一个类型带 **33 个 `@State`/`@Binding`/`@Bindable`/
`@AppStorage`/`@Environment`**，约 110 个成员，`body` 本身 278 行，最大嵌套深度 8。

一个类型同时负责：sheet 呈现与 detent、tab 布局（modern/legacy 两套）、面板标题与
按钮、日期范围菜单、地区菜单、搜索、键盘快捷键、播放条与传输控制、视频导出、地图
选中与消歧、统计作用域、`UserDefaults` 里的 manual-dates 读写、新行程脚手架。

#### P1-2 · `RailMapView.swift` 是一个 3,002 行的 God File

`RailMapView.Surface.Coordinator` 是嵌套三层的 ~2,500 行类，其中
`rebuild(on:)` 一个函数 **555 行**（704–1258）。文件里另有 5 个 `MKAnnotation`
子类 ＋ 4 个 `MKAnnotationView` 子类，全部 `private` 嵌在 Coordinator 里。

**拆这个文件有两个额外约束，必须一起处理：**

1. `verify.sh` 有 **3 条按路径 grep 的文本契约**指向 `RailMap/RailMapView.swift`：
   `* RailStyle.simplifyTolerance`、`Geometry.douglasPeuckerIndices(...epsilonMeters: epsilon)`
   **计数必须等于 2**、`lines: [segment.sourceCoordinates]`。文件一拆，grep 就落空
   → 整个 gate fail。**拆分和改 `verify.sh` 必须在同一次提交里。**
2. 那些 `private final class ...AnnotationView` 嵌在 `Coordinator` 内部。Swift 可以
   跨文件 `extension RailMapView.Surface.Coordinator { }`，但 `private` 嵌套类型
   一旦搬到别的文件，它对原文件里的使用者就不可见了 —— 访问级别必须从 `private`
   放宽到 `fileprivate`/`internal`。这是**可见性变更**，虽然不改行为，但要显式记录。

#### P1-3 · `RailKit` 有 36 个 `public func` 只在 `RailKit` 内部被调用

过宽的可见性。它们不是死代码（内部有调用者），但 `public` 让它们进了模块 ABI，
读者会以为 app 层在用。集中在 `RouteSolver`(9)、`RouteGraph`(7)、
`StationJoinSmoothing`(2)、`Train`(2)。

**注意**：这些函数**同时**被 parity 测试调用，降到 `internal` 需要测试侧
`@testable import`。实测测试文件的现状是混的：

```
18 × @testable import RailCore      1 × @testable import RailPresentation
 8 × import RailCore                4 × import RailPresentation
```

也就是说这一批的代价不是「29 个文件」，而是**把 12 个还在用裸 `import` 的测试
文件改成 `@testable import`** —— 大多数已经是了。比原先估的便宜。

---

### P2 —— 明确的、低风险的整理

#### P2-1 · 文案表：5 张表 ＋ 4 个几乎相同的取值函数

```
AppLocalization.table   109 keys   → text() / countryText()
DataStrings.table        86 keys   → dataText()
EditorStrings.table     115 keys   → editorText()
JourneyStrings.table     70 keys   → journeyText()
StatisticsStrings.table  21 keys   → statsText() / statsCategoryText()
```

四个取值函数的形状几乎一样，注释里也写明了原因 ——「`AppLocalization` 是另一个
port 的文件，从这里加会碰到在途的工作」。**那个原因现在已经不存在了**（各 port
都已落地）。

实测确认可以安全合并的前提：
- 五张表**没有任何 key 冲突**（跨表重复 key = 0）
- 五张表**没有一个 key 与已发布的 web catalog 重叠**（shadow = 0）

但四个函数**行为不完全相同**，合并必须逐个保留：
- `dataText` / `editorText`：`text(key, fallback: table[key] ?? key)`
- `journeyText`：走 `countryText`，且多一个外部 `fallback` 参数
- `statsText`：`fallback: table[key]`，**没有 `?? key`**（传 nil）
- `statsCategoryText`：`countryText(key, fallback: statsText(key))`

→ 目标形态：一个 `AppStrings` 注册表（表按 namespace 拼进一个 dictionary）＋
一个带 `countryVariant: Bool` 与 `fallback: String?` 的取值函数，四个旧名保留为
薄转发以免动 400+ 个调用点。

#### P2-2 · swipe actions 与 context menu 的按钮重复

`ContentView.swift:2086` 与 `:2445` —— 同一组「显示/隐藏、删除、复制」按钮写了
两遍（12 行完整重复窗口）。抽成两个 `@ViewBuilder` 即可。

#### P2-3 · 死代码（全仓搜过，确认只有声明，零引用）

| 符号 | 位置 |
| --- | --- |
| `struct PassportChip: View` | `RailMap/PassportCardStyle.swift:612` |
| `struct UtilityToolbar: ToolbarContent` | `RailMap/UtilityDestination.swift:53` |
| `private func groupedByDate(_:)` | `RailMap/ContentView.swift:1691` |
| `public static func dedupeStationFeatures(_:)` | `RailKit/Sources/RailCore/Stations.swift:594` |

外加两个自称临时的 UI test 探针：

- `RailMapUITests/ZZTempSheetMorphProbe.swift` — 文件头写着
  「**TEMPORARY diagnostic — delete before committing**」
- `RailMapUITests/ZZTempPresentationProbe.swift` — 同族，**00:18 刚被另一个会话建出来**

→ `ZZTemp*` 两个属于 BLOCK-1 覆盖范围，**不要碰**，问清楚归属再说。

#### P2-4 · 文件名与主类型对不上（而且正好对调）

```
RailMap/AppShell.swift      →  struct ContentView
RailMap/ContentView.swift   →  struct RailWorkspaceView
```

读者按文件名找类型必然找错。改法：`AppShell.swift` → `ContentView.swift`，
`ContentView.swift` → `RailWorkspaceView.swift`（正好和 P1-1 的拆分一起做）。

项目用的是 Xcode 16 的 `PBXFileSystemSynchronizedRootGroup`，**改文件名不需要动
`project.pbxproj`** —— 这一点已确认，65 个 swift 文件没有一个被单独列进 pbxproj。

#### P2-5 · `@AppStorage("appearance")` 声明了两遍

`RailMap/RailMapApp.swift:12` 与 `RailMap/ContentView.swift:75`。两处 default 都是
`"system"`，行为一致，但同一个 key 的两个宿主是将来漂移的入口。

#### P2-6 · `UserDefaults` key 散落 8 处，没有登记处

`"appearance"`、`"statistics-region"`、`"map-follows-selected-date"`、
`"auto-focus-zoom"`、`"manual-dates"`、`RideLibrary.loadedSamplesKey`、
`AppLocalization.preferenceKey`/`variantKey`，加上 `DisplaySettings` 与
`VideoExportSettings` 各自的一批。

其中 `ContentView.swift:2339/2343` 的 manual-dates 是直接 `UserDefaults.standard`
裸读裸写，绕过了 `DisplaySettings`/`VideoExportSettings` 那种「一个类型拥有一组值」
的既有写法 —— 这一处应该跟着 P1-1 的拆分收进一个 owner 里。

---

### P3 —— 收尾

#### P3-1 · 文档漂移（2 处，其余都是有意的墓碑注释）

- `RailMap/MileageStatisticsStore.swift:79` 提到 `JourneysWorkspaceView.selectedDate`
  —— 该类型已改名为 `RailWorkspaceView`
- `RailMap/PassportCardStyle.swift:463` 提到 ``StatisticsMetricGrid``
  —— 实际类型叫 `PassportMetricGrid`

（`RideSheet.swift` 里 `SheetHandle` / `RideSheetMetrics` / `SheetCompactHeightKey`
那几处是**故意**留的「这些东西已经删掉了」的记录，不要改。）

#### P3-2 · 没有 formatter 契约

仓库无 `.swiftformat`/`.swiftlint.yml`，`verify.sh` 也不跑格式检查 —— 它靠的是
「0 warning」。风格目前实际上是统一的（同一批作者＋同一份 `PORTING.md`），
但没有机器守着。

**建议：本轮不引入。** 引入 SwiftFormat 会在 26,810 行 app 代码上产生一个巨大的
纯格式 diff，正好压过重构本身的 diff，而且 `verify.sh` 里那 12 条按文本 grep 的
契约（`awk` 匹配多行调用、`grep -c` 计数）会被重排打断。要引入就单独一轮，
且必须先把 `verify.sh` 的文本契约改成对格式不敏感的写法。

#### P3-3 · 117 个 `public func` 只有测试在调，app 从没调过

这**不是缺陷**，是这个 port 的形态：`FEATURES.md` §0 已经逐条说明
`OverlapLanes` 的拟合曲线与 `StationJoinSmoothing` 是**故意不接**的（接上会让两端
画出不同的线）。但目前这个「已移植 / 未接线」的账只存在于 `FEATURES.md` 的散文里。

建议产出一张机器可读的清单（哪些是故意的、哪些是真的还没接），而不是删代码。

---

## Phase 3 · 执行步骤

每一批都是 **small / atomic / behavior-preserving**，每批结束跑一次
`./verify.sh --swift`（RailKit build + test + app build + 全部文本契约），
最后一批才跑 `./verify.sh` 全量。

### 批次 0 — 解锁（不改代码）
1. 确认 BLOCK-1 的归属：`ContentView.swift` / `RailMapView.swift` / `ZZTemp*` 谁在改，等它落盘。
2. 把现有 54 个未提交改动做成一个 checkpoint commit。
3. 记录基线：`./verify.sh` 全量跑一次（含 JS 侧），把通过数字抄下来。

### 批次 1 — 死代码（最低风险，先拿掉噪音）
- 删 `PassportChip`、`UtilityToolbar`、`groupedByDate`、`dedupeStationFeatures`。
- `ZZTemp*` 两个探针：**只在 BLOCK-1 澄清后**删。
- 验收：`--swift` 绿；`Stations` 的 parity 测试没有引用被删函数（已确认零引用）。

### 批次 2 — 命名与小重复
- `AppShell.swift` ↔ `ContentView.swift` 改名（P2-4）。
- 合并 `@AppStorage("appearance")`（P2-5）。
- 抽出 swipe/context menu 的共用 `@ViewBuilder`（P2-2）。
- 修 2 处文档漂移（P3-1）。
- 验收：`--swift` 绿。改名后全仓搜旧文件名（含 `verify.sh`、`*.md`、`copy-rail-packages.sh`）。

### 批次 3 — 文案表合并（P2-1）
- 新建 `AppStrings.swift`：一张按 namespace 拼装的表 ＋ 一个取值函数。
- 四个旧函数 `dataText`/`editorText`/`journeyText`/`statsText` 保留为薄转发，
  **逐个保住各自的 fallback 语义差异**（尤其 `statsText` 的 `?? key` 缺失）。
- 验收：写一个一次性的对拍脚本，对 401 个 key × 4 种语言比对合并前后的输出，
  必须逐字相同。跑完删掉脚本。

### 批次 4 — `RailCore` 纯字符串原语去重（P0-A 允许的那一小块）
- `CodeUnits` 三份 → `RailCore` 内部一份（放在 `JSNumber`/`JSMath` 旁边，
  建议叫 `JSString.swift`，跟已有命名一致）。
- `sameCodeUnits` 两份 → 一份。
- 先测再动 `jsTrim`（`Train` vs `Dates` 逐字相同，可合；`Stations` 那份**不动**）。
- **不碰** `distanceMeters` / `pathLength` / `jsSorted` / `quote` / `turnDegrees`；
  改为在每处加一段注释，写清它属于哪个家族、为什么不能并。
- 验收：206 个 parity 测试全绿；并且对 `turnDegrees` / `quote` 各写一次性的位型
  对拍（真实五国坐标），把结论写进注释 —— **这一步的产出是证据，不是合并**。

### 批次 5 — 拆 `RailMapView.swift`（P1-2，最大的一块）
按现有 `// MARK:` 边界拆，**只搬运，不改一行逻辑**：

```
RailMapView.swift            struct RailMapView + DisplayValues + RenderStats + Surface   (1–321)
RailMapCoordinator.swift     Coordinator 主体：update / MKMapViewDelegate                (322–693)
RailMapBuild.swift           rebuild(on:) 与建图                                         (694–1609)
RailMapAnnotations.swift     5 个 MKAnnotation 子类                                      (1866–2073)
RailMapAnnotationViews.swift 4 个 MKAnnotationView 子类                                  (2074–2576)
RailMapSelection.swift       选中与消歧                                                  (2577–2738)
RailMapPlayback.swift        播放渲染                                                    (2739–2869)
RailMapGeometry.swift        几何 helper                                                 (2870–3002)
```

同一次提交里必须做的：
- 改 `verify.sh` 那 3 条 grep 的目标路径（`* RailStyle.simplifyTolerance`、
  `douglasPeuckerIndices` 计数=2、`lines: [segment.sourceCoordinates]`）；
- 把跨文件用到的 `private` 嵌套类型放宽到 `fileprivate`/`internal`，并在
  `AUDIT_PLAN.md` 的「可见性变更」一节逐个记账。

**不在这一批做的**：拆 `rebuild(on:)` 那 555 行。搬运和切函数混在一个 diff 里
就没法 review 了 —— 单独一批。

### 批次 6 — 切 `rebuild(on:)`
按它内部已有的段落切成 `buildNetworkOverlays` / `buildRideOverlays` /
`buildStationAnnotations` / `publishRenderStats`。每切一段跑一次
`--swift`，并对同一个视口截一次 `RenderStats`（overlays / vertices /
buildMilliseconds）比对，数字必须一致。

### 批次 7 — 拆 `ContentView.swift`（P1-1）
**分两步，第二步可选：**

7a（安全）：类型不动，只按 `// MARK:` 把 `RailWorkspaceView` 拆成多个
`extension RailWorkspaceView` 文件 —— `RailWorkspaceView+Panel.swift`、
`+Playback.swift`、`+Search.swift`、`+Tabs.swift`、`+MapSelection.swift`、
`+Dates.swift`。SwiftUI 的更新语义**完全不变**。

7b（要单独批准）：把 33 个 state 里真正成组的几块（播放条、搜索、日期范围）
提成独立 `View` 子结构。这会改 SwiftUI 的 invalidation 粒度 —— 是**行为可能变**
的改动（多半是变好，但不是零风险），不属于 behavior-preserving，需要你点头。

顺带在 7a 里把 manual-dates 的裸 `UserDefaults` 收进一个 owner（P2-6）。

### 批次 8 — 可见性收紧（P1-3，可选）
把 36 个只在 `RailKit` 内部被调的 `public func` 降成 `internal`，同时把 12 个
还在用裸 `import RailCore` / `import RailPresentation` 的测试文件改成
`@testable import`（另外 19 个已经是了）。
收益是模块表面变干净、读者不再误以为 app 层在用；代价是 12 个 import 行。
可做，但排在最后。

### 批次 9 — 复扫与报告
从零重新扫一遍：重复窗口、死符号、跨文件引用、`verify.sh` 全量（含 JS 侧）、
模拟器上跑一次真机流程（导入 → 画线 → 播放 → 统计 → Passport）。
按你 prompt 的十二节格式出最终报告，含 `NOT VERIFIED` 清单。

---

## 明确不做的事

| 不做 | 为什么 |
| --- | --- |
| 合并 `distanceMeters` / `pathLength` / `jsSorted` / `quote` 家族 | P0-A：合并即改数字，`DisplayParts` 夹具比的是抽稀之前的几何，抓不住 |
| 引入 SwiftFormat / SwiftLint | P3-2：26,810 行的纯格式 diff 会盖过重构本身，并打断 `verify.sh` 的 12 条文本契约 |
| 删「只有测试调」的 117 个 public func | P3-3：`FEATURES.md` §0 已说明是**故意不接**，删了就是把两端画的线弄成不一样 |
| 把 `lanes` 相关的东西接起来 | R14 已於 `38cf0a8` 廢止，web 端整体拆除过 |
| 改任何 `verify.sh` 契约的**语义** | 只允许在文件拆分时改**路径**；改判据要单独提出来讨论 |
| 动 `app/` 的 JavaScript | 不在本次范围。JS 一动，全部 fixture 与 206 个 parity 测试的含义就变了 |

---

## 待你决定的三件事

1. **BLOCK-1**：等另一个会话，还是本轮排除 `ContentView.swift` / `RailMapView.swift`？
2. **批次 7b**（把 `RailWorkspaceView` 的 state 提成子 View）做不做？它不是
   behavior-preserving。
3. **批次 8**（`public` → `internal`）做不做？代价是 29 个测试文件改 import。
