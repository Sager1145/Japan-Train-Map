# `public/styles/` — 四层样式表：哪一层说了算

> 这份文档是**实测产物**：下面每一条「谁负责什么」都是从四个文件里逐个选择器查证
> 出来的，不是分层理论。数字来自 `b32570e` 时的源码，改动 CSS 后请重新核对。
>
> **本文档不改变任何 CSS。** 它只描述现状。

---

## 0. 一句话回答最常见的问题

> **「我想改 `.toolbar` 的背景色，该改哪一层？」**

`.toolbar` **本身在四层里都没有 `background`**——它是透明的，看到的底色来自它所在的
`.card-body`。真正给 `.toolbar` 上过背景的只有两处，都是编辑器底部那一排按钮：

| 文件 | 选择器 | 条件 |
| --- | --- | --- |
| `ios-presentation.css` | `#train-editor .card-body > .toolbar:last-child` | `@media (max-width: 599px)` |
| `device-layout.css` | `html[data-ui-mode="desktop"] #train-editor .card-body > .toolbar:last-child` | 无媒体查询 |

所以：

- 想改**所有** toolbar 的底色 → 它现在没有底色，你要**新增**，加在
  `railprint-base.css` 的 `.toolbar` 上（那里已经有 `display/gap/align-items/flex-wrap`）。
- 想改**编辑器底部那条 sticky toolbar** 的底色 → 窄屏改 `ios-presentation.css`，
  桌面模式改 `device-layout.css`；**只改一处会让另一种模式不跟随**。
- 想改的其实是卡片底色 → 目标是 `.card` / `.card-body`，见下面的逐选择器表。

这就是这份文档存在的理由：**「哪一层说了算」不是按文件名猜的，要按选择器查。**

---

## 1. 层叠顺序本身就是行为

`index.html` 里的加载顺序**是**行为契约，由
`test/stylesheet-architecture.test.js` 钉死（它同时断言 `styles.css` 不存在）：

```
1. styles/railprint-base.css      2723 行 / 424 条规则
2. styles/ios-presentation.css    1120 行 / 224 条规则
3. styles/solid-surfaces.css       670 行 / 184 条规则
4. styles/device-layout.css        731 行 / 119 条规则
```

注意**第 3、4 层的顺序**：`solid-surfaces` 在 `device-layout` **之前**。
（重构计划书里按文件大小排成 base / ios / device / solid，那是排错的；
以 `index.html` 与上面这个测试为准。）

四层的选择器特异度设计得**同量级**——`!important` 全仓只有 8 处（见 §4），
所以**同特异度时靠顺序决胜**：后面的文件赢。换句话说：

> **`device-layout.css` 是最后一句话**，只要它的选择器打得中。
> 而它绝大多数规则带 `html[data-ui-mode="mobile"|"desktop"]` 前缀，
> 特异度高一档，所以**只要 `<html>` 上有 `data-ui-mode`，device 层几乎总是赢**。

`data-ui-mode` 由 `index.html` 第 11 行那段**内联 `<head>` 脚本**写到 `<html>` 上
（UA-CH/UA + `maxTouchPoints` + `any-pointer/hover` + 599px 窄窗兜底
+ 用户在设置里的显式覆盖），并且写在**四个 `<link rel="stylesheet">`（第 69–72 行）
之前**。所以：**它一定存在，且第一帧就已存在**——不会有一瞬间的「无 device 层」状态。
「device 层不生效」因此通常不是层叠问题，而是那条属性根本没写在 device 层里。

---

## 2. 逐层职责边界（实测）

### 第 1 层 · `railprint-base.css` — 形状与全部设计令牌

**独占的职责，别的层一概不碰：**

- **所有设计令牌**。`:root`（第 7 行）+ `html[data-theme="dark"]`（第 116 行）里
  一共 **132 条自定义属性**。`ios-presentation.css` 与 `solid-surfaces.css`
  各自定义了 **0 条**；`device-layout.css` 定义 25 条，但**全是尺寸/密度**
  （`--font-*`、`--ios-control-height`、`--sidebar-size` 一族），**没有一条颜色**。
  → **改颜色永远在 base 层改令牌**，改完四层一起变。
- **暗色主题的取值**。`html[data-theme="dark"]` 的令牌块只在 base 层。
  另外三层里只剩 5 条 `html[data-theme="dark"]` 特例（MapLibre 控件与
  checkbox 勾号的描边色）。
- **布局骨架**：`display` / `grid-template-columns` / `position` / `inset` /
  `flex` 方向、`.card` 的存在与结构、表格的行列。
- **主题切换动画**：`html.theme-transitioning ...` 那一批
  `transition-property/duration/timing-function` 只在 base 层。

**媒体查询断点（7 个，全在 base）：**
`599px` / `520px` / `420px` / `900px` / `600–1023px` / `(pointer: coarse)` /
`599px and (pointer: coarse)`。

### 第 2 层 · `ios-presentation.css` — 材质与控件语法

把 base 层的形状**贴上 iOS 材质**：

- `background: var(--ios-material)` + `backdrop-filter: var(--ios-blur)`
  （毛玻璃）、`box-shadow` 浮起、`border-radius` 加大。
- 控件语法：`input[type="checkbox"]` 的 `appearance:none` 自绘勾（25 条 `input` 规则里
  大半在这里）、`.display-toggle` 的开关拨片、`input[type="range"]` 的
  runnable-track / thumb 三套厂商伪元素。
- `min-height` 的触摸目标基线（`--ios-touch-height`）。
- `.workspace-nav a:nth-of-type(N) > span:first-child` 那 12 条纯 CSS 图标
  （用 `::before`/`::after` 画的五个 tab 象形图）——**只有这一层有**。

**断点（3 个）：** `599px` / `600–1023px` / `(pointer: coarse)`。

### 第 3 层 · `solid-surfaces.css` — 不透明化 + 尺寸重述

主题只有一个：**把第 2 层的所有半透明材质全部换成不透明表面**。文件开头
一条 13 个选择器的清单用 `!important` 关掉 `backdrop-filter` 与 `box-shadow`
（**全仓 8 个 `!important` 里的 3 个在这里**），随后逐个组件把
`background` 改成实色 `var(--ios-*-background)`。

它还**重述**了一批 `min-height` / `font-size` / `padding` / `border-radius`。
这不是冗余：`solid-surfaces` 定义的是「iOS 27 组件比例」的**默认档**，
`device-layout` 再按终端模式覆盖成紧凑档。

**断点（3 个）：** `600–1023px`（平板：表格改卡片）/ `599px` / `340px`（极窄机）。

⚠️ **本层的 `!important` 有作用域限制**：那三条只写在文件开头那 13 个选择器上。
后来新增的浮层若想「一定不透明」，**必须把选择器加进那份清单**，
否则第 4 层的 `background` 会盖过来（`.map-layers-control` 就是这样，见 §3）。

### 第 4 层 · `device-layout.css` — 终端模式与密度

唯一职责：按 `html[data-ui-mode="mobile"|"desktop"]` 决定**抽屉轴向**与**密度**。

- `mobile`：侧栏是**底部三档抽屉**（`--panel-half`/`--panel-full` + `transform`），
  `.workspace-nav` 是固定底栏。
- `desktop`：侧栏是**左侧固定面板**，并整体换成紧凑档
  （`html[data-ui-mode="desktop"]` 那 12 条 `--font-*` + 4 条 `--ios-*-height`）。
- 它自己也有**少量无前缀规则**（`#sidebar` 的滚动属性、`.map-layers-control`
  与 `.map-layers-summary` 的整块重写、`.map-layers-subhead`、
  `#sidebar > section.card` / `> details.card`）——这些**无条件覆盖前三层**，
  是本层最容易踩的坑。

**断点（2 个）：** `599px` / `prefers-reduced-motion`（余下 2 个 `!important` 在这里）。

---

## 3. 20 个「四层都写过」的选择器 —— 逐层职责表

判据：该 class/id 令牌**出现在四个文件各自至少一条选择器里**（不要求整条选择器
字面相同）。实测结果是 **20 个**（计划书估的「至少 15 个」偏保守）。
若按「四个文件里出现**字面完全相同**的选择器」的严格判据，则只有 5 条：
`#sidebar`、`#sidebar > section.card`、`.map-layers-control`、
`.map-layers-summary`、`.map-layers-subhead`。

| # | 选择器 | base（形） | ios（材质） | solid（不透明） | device（断点/密度） |
| --- | --- | --- | --- | --- | --- |
| 1 | `#sidebar` | 定位/宽度/`transform` 抽屉、`overflow`、`overscroll-behavior`、7 个断点下的 padding 与触摸目标 | `background: var(--ios-material)` + `backdrop-filter`、`border-right-color`、窄屏圆角+阴影 | 关掉毛玻璃与阴影、实色底、`padding`、平板/窄屏各自的实色底 | **滚动属性无前缀**（`overflow-y`/`-webkit-overflow-scrolling`）+ mobile 底抽屉 / desktop 左面板两套完整几何 |
| 2 | `.workspace-nav` | 位置/网格/间距、tab 链接的形与配色、520px 下改竖排 | **12 条纯 CSS 图标**（`::before`/`::after`）、材质底、`a:active` 位移 | 实色底栏、逐 tab 状态色（含 `#sidebar` 加权版）、340px 极窄机字号 | mobile/desktop 两套 `--workspace-nav-height` + 底栏几何 + 折叠时 `pointer-events` |
| 3 | `.map-layers-control` | 绝对定位/`z-index`/`max-width`、`summary` 箭头、900px 收窄 | 材质底 + `backdrop-filter`、`label` 触摸高度 | 关毛玻璃、实色底、`label` 分隔线与行高 | **无前缀整块重写**（宽度/边框/圆角/背景）+ 自绘 checkbox + `.map-basemap-field` 网格 + 两模式密度 |
| 4 | `#app` | `--sidebar-open-size`/`--sidebar-size` 的**默认值**、`sidebar-collapsed`/`dragging` 的 `transform` | `[data-panel="peek"]` 窄屏材质 | `[data-panel="peek"]` 窄屏实色 | mobile/desktop 各一套抽屉尺寸令牌 + 折叠/拖拽 `transform` |
| 5 | `.sidebar-edge-tab` | 位置/尺寸/`touch-action`/`transform`/焦点环、窄屏改底把手 | 材质底 + 阴影 + hover/focus 配色 | 关毛玻璃、实色底、三态配色 | mobile/desktop 各三条（含 hover/focus）完整几何重写 |
| 6 | `.map-layers-summary` | `display`/`gap`/列表标记清除、`::before` 图标、`::after` 箭头 | 高度/字号/颜色、`::before` 的 `content` | 高度/内边距/字号、展开态边框色 | **无前缀整块重写**（含边框/背景/`::after` 改成 CSS 三角）+ desktop 密度 |
| 7 | `.train-item` | 网格布局、`transition`、`.train-title` 省略号 | 高度/内边距/圆角/材质底、hover/selected/focused 配色 | 实色底 + 三态配色 + 尺寸重述 | 仅 desktop 一条：`min-height`/`padding`/`border-radius` 紧凑档 |
| 8 | `.rp-modal-choice` | `appearance:none` 归零、布局、三态 | 高度/圆角/材质配色 | 实色 + 三态（6 条，最多） | 仅 desktop：高度/字号/内边距/圆角 |
| 9 | `.card` | `position`/`margin`/`scroll-margin-top`/边框/阴影、`.tab-hidden` | `margin-top`/圆角/材质底/阴影、599px 减圆角 | 实色底 + 无阴影 | **经 `#sidebar > section.card` / `> details.card` 无前缀覆盖** |
| 10 | `.map-info-summary` | 圆形按钮的形、`::-webkit-details-marker` 清除、三态 | 材质底 + 尺寸 + 三态 | 关毛玻璃、实色、尺寸与圆角 | 仅 desktop：`width`/`height` |
| 11 | `.maplibregl-ctrl-group` | 主题过渡 + `data-theme="dark"` 特例 | 材质底 + 圆角 + `backdrop-filter` | 关毛玻璃、实色、圆角、按钮尺寸与分隔线 | 仅 desktop：按钮 `width`/`height` |
| 12 | `.date-btn` | 完整外观 + `.date-count` | 高度/内边距/材质配色 + 599px 高度 | 实色底 + active 配色 | 仅 desktop：`min-height` |
| 13 | `.map-info-panel` | 定位/尺寸/`overscroll-behavior`/900px 收窄 | 材质底 + 圆角 + 599px `max-height` | 关毛玻璃、实色、圆角 | mobile/desktop 各一条 `max-height` |
| 14 | `.rp-modal-btn` | `appearance` 归零 + 完整外观 + 焦点环 | 高度/边框/材质配色 + coarse 指针高度 | 实色 + 尺寸重述 + hover | 仅 desktop：高度/字号/内边距/圆角 |
| 15 | `.toolbar` | `display:flex`/`gap`/`wrap`、520px 下按钮撑满 | `gap`、**编辑器底部 toolbar 的 `background`（599px）** | 599px 下按钮撑满 | mobile/desktop 按钮撑满策略 + **desktop 版编辑器 toolbar `background`** |
| 16 | `.card-body` | `padding`/`display`/`gap`、520px 收内边距 | `gap`/`padding` + 599px 收内边距 | `gap`/`padding` | 仅 desktop：`gap`/`padding` 紧凑档 |
| 17 | `.map-layers-subhead` | 分隔线 + 排版 + `span::before` 图标 | 颜色/字号/字重、`::before` 的 `content` | 颜色/字号/行高 | **无前缀**：外边距/内边距/上边框/**背景**/排版全套 |
| 18 | `.form-grid` | `grid-template-columns` + 520px 改单列 | `gap` + 599px 改单列 | 599px 改单列 | mobile 改单列 |
| 19 | `button.icon` | 方形图标按钮的形 + coarse 指针最小宽 | 尺寸 + 圆角 | 尺寸 | 仅 desktop：尺寸 |
| 20 | `.inline-check` | 布局 + 排版 + `input` 的 `accent-color` | `min-height`/`gap`/颜色 | `min-height` | 仅 desktop：`min-height` |

### 从这张表读出来的三条规律

1. **颜色几乎总在第 2/3 层，尺寸几乎总在第 1/3/4 层。**
   base 说「它是什么形状」，ios 说「它是什么材质」，solid 说「它不透明、
   这是标准档尺寸」，device 说「这台机器上它多密」。
2. **`solid` 的实色底能被 `device` 的无前缀规则盖掉。**
   实测有三处：`.map-layers-control`、`.map-layers-summary`、`.map-layers-subhead`
   的 `background` 最终由 `device-layout.css` 决定，
   因为它们**不在** `solid-surfaces.css` 开头那 13 个 `!important` 清单里
   （清单只关 `backdrop-filter` 和 `box-shadow`，不关 `background`）。
   → **改地图图层面板的底色，改 `device-layout.css`。**
3. **只在 `device` 的 `desktop` 分支出现的规则（表里第 7/10/11/12/14/19/20 行），
   在 `mobile` 模式下等于不存在**——那时生效的是 `solid` 的标准档。
   改「桌面太松/太紧」只需动 device；改「两种模式都不对」要动 solid。

---

## 4. `!important` 全清单（8 处，别再加）

| 文件:行 | 声明 | 为什么 |
| --- | --- | --- |
| `railprint-base.css:539` | `display: none !important` | 结构性隐藏 |
| `railprint-base.css:661` | `display: none !important` | 结构性隐藏 |
| `solid-surfaces.css:16–18` | `-webkit-backdrop-filter` / `backdrop-filter` / `box-shadow: none` | 关掉全部 iOS 材质（13 个选择器的清单） |
| `device-layout.css:705–707` | `animation-duration` / `animation-iteration-count` / `transition-duration` | `prefers-reduced-motion: reduce` |

三类都是「**跨层一票否决**」的合法用法。要改某个组件的普通属性，
**永远先靠层叠顺序解决**（写到更后面的层、或提高一级特异度），不要加第 9 个。

---

## 5. 改样式的决策流程

1. **是颜色吗？** → 先看能不能改 `railprint-base.css` 的令牌。能，就到此为止：
   四层与暗色主题一起跟进。
2. **是某个组件的实色底/毛玻璃吗？** → `solid-surfaces.css`。
   若改完不生效，去 `device-layout.css` 找**无前缀**的同名规则（§3 规律 2）。
3. **是尺寸/密度，且只在一种终端模式下不对？** → `device-layout.css` 的对应分支。
4. **是尺寸/密度，两种模式都不对？** → `solid-surfaces.css`（标准档），
   必要时同步 `device-layout.css` 的 `desktop` 分支。
5. **是布局骨架 / 新组件？** → `railprint-base.css`，然后按需在后三层补
   材质、实色、密度。
6. **动之前先逐层查证**：`grep -n "<选择器>" *.css`——**四个文件都要看**，
   而且要看清每个文件里的**媒体查询上下文**和 `html[data-ui-mode=…]` 前缀，
   否则很容易改到一个在当前终端模式下根本不生效的分支。

---

## 6. 关于「合并这四层」

**现在不要合并。** 这份文档是合并的前置条件，不是合并的第一步。

合并的真实代价，从上面的实测能直接读出来：

- `solid-surfaces.css` 的整个存在理由是**成体系地否定** `ios-presentation.css`。
  两层合并 = 要在每个组件上手工判定「最终该是毛玻璃还是实色」——
  184 条规则乘以四个主题/模式组合。
- `device-layout.css` 里那批**无前缀规则**（`.map-layers-*` 三个、
  `#sidebar` 滚动、`#sidebar > section.card`）现在靠**位于最后**才赢。
  一旦合并成一个文件、规则重排，这些覆盖关系全部失效且**不会报错**，
  只会静默变样。
- 层叠顺序是被测试钉住的行为（`test/stylesheet-architecture.test.js`），
  合并必然要改那个测试——**改它之前必须有等价的视觉回归证据**。

先做的应该是**削减重复**而不是合并文件：把 §3 表里
「三/四层都只是在重述同一个 `min-height`」的那些（第 12/14/19/20 行）
收敛到令牌上，让它们从表里消失。那是可逐条验证的，合并不是。

---

## 7. 这份文件本身放在这里安不安全

放在 `app/public/styles/` 里是安全的，已核实三条：

- 「`public/` 必须扁平、app 家族文件名以 `app` 开头」这条契约**只约束
  `<script src>`**（`app-family-sandbox.mjs: readOrderedAppScripts()` 的过滤器
  `!src.includes("/") && src.startsWith("app")`）。`.md` 根本不进那个列表。
- `scripts/build/build-static-site.mjs` 用 `fs.cp(publicDir, …, { recursive: true })`
  拷贝整个 `public/`，只排除 `.gz`。所以本文件会原样出现在
  `_site/styles/README.md`——无害，`public/rail/operator-logos/README.md` 与
  `public/rail/line-logos/README.md` 早就是同样的情况。
- `scripts/validation/check-source.mjs` 只检查 `.js` / `.mjs` / `.json`
  与 HTML 里的本地引用，`.md` 不在扫描范围内（lint 前后同为
  「157 JavaScript files, 79 JSON files, 56 local HTML references」）。
