# 08 · 纸面列表 × Slash 浮层 · 可执行对照表（美学参考）

| 字段         | 内容                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------- |
| **角色**     | 美学参考 Agent（§4.2；**不占** ②/③ 实现轨）                                                  |
| **日期**     | 2026-08-12                                                                                   |
| **对象**     | 块纸面列表（paper list / 块行）+ 静默 chrome + slash 浮层                                    |
| **对齐标尺** | **主壳一体优先**（`tokens.css` + shell / dropdown / z-index）；竞品 = **完成度 / 节奏** 参考 |
| **禁止**     | fork `--affine-*` / AppFlowy 色板；视觉完成 = 关 EL；本文件 **只 analysis，不改业务实现**    |
| **读者**     | 下一刀 **设计 Agent**（可直接抄 token 配方写 CSS）                                           |

---

## 0. 纪律钉（先读）

| #      | 钉                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **R1** | 色与材质 **100% 主壳**；竞品只借「静默 L0、gutter 节奏、slash 尺寸感、标题级差」。                                                   |
| **R2** | **禁止**「视觉对齐完成 = 块工作区 / EL 关闭」。皮 ≠ A-BLK-02、≠ EL-01、≠ A-SIL 产品 e2e。                                            |
| **R3** | 字号基准保持 Conex **14**（`--font-size-base`）；勿为「更像 Notion」全局改 16。                                                      |
| **R4** | React 浮层与 DomHost `.bp-*` **同 token 公式**；禁止第三套魔法色 / 裸 `z-index: 9999`。                                              |
| **R5** | chat `TiptapSlashMenu` 是**材质锚**（elevated / 中性 hover），**域不同**可允许：块 slash **有** shadow-lg，chat slash **刻意无影**。 |

**证据真源**

| 层              | 路径                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| 主壳 token      | `apps/crish-desktop/src/styles/tokens.css`                                                   |
| z 阶真源        | `apps/crish-desktop/src/styles/z-index.css`（`--z-popover: 200`）                            |
| note-paper 皮   | `apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css`                     |
| chrome 皮       | `packages/block-paper/src/chrome/blockChrome.css`                                            |
| chat slash 样本 | `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css`                 |
| AFFiNE slash    | `reference/markdown_compare/AFFiNE/blocksuite/affine/widgets/slash-menu/src/styles.ts`       |
| AppFlowy 版式   | `reference/markdown_compare/AppFlowy/.../editor_style.dart`（padding / optionMenuWidth / H） |
| 前期对照        | 同目录 `01` 总表 · `04` 二期皮 · `06` 三期挂载清单                                           |

---

## 1. 可抄 Token 速查（设计 Agent 配方卡）

> 全部已在主壳定义；**禁止**在组件内再写死同值 px（密度档 `data-ui-size` 会缩 space）。

### 1.1 Spacing

| 用途                    | Token                               | 默认量级（comfortable） | 备注                                                                   |
| ----------------------- | ----------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| 块间 gap（连续纸）      | `--space-0_5`                       | 2px                     | 保持极小；大间距只给标题/code/quote                                    |
| 块行 pad                | `--space-1_5` × `--space-2`         | 6×8                     | 与 `.bp-block-row` / module 已对齐                                     |
| 块行内 gap（把手↔正文） | `--space-2`                         | 8px                     |                                                                        |
| 阅读列左 gutter         | `--space-6`                         | 24px                    | 对齐 AFFiNE side-pad 24 节奏；**非** 44                                |
| 阅读列右                | `--space-2`                         | 8px                     |                                                                        |
| body 纸面外 pad         | `--space-3` / `--space-5` / 底 4    | 12 / 20 / 16            | module `.body` 已用                                                    |
| slash 容器 pad          | `--dropdown-padding`                | space-1_5 = 6px         |                                                                        |
| slash 列 gap            | `--dropdown-gap`                    | space-0_5 = 2px         |                                                                        |
| slash 项 pad            | `--item-padding`                    | 8px 12px                | 密度档会变；勿写死 32px 行高                                           |
| slash 项圆角            | `--item-radius` → `--radius-sm`     | 5px                     | comfortable；compact/cozy 会变                                         |
| 分组标签 pad            | `--space-1` × `--space-2`           | 4×8                     | 非首组：top hairline + pad-top space-1_5                               |
| 落点线厚                | `--bp-drop-line-h`（chrome 作用域） | 2px                     | 定义在 `.bp-chrome-root`，非全局 :root                                 |
| 落点水平 inset（若画）  | `--space-2`                         | 8px                     | 与块行 pad 齐                                                          |
| 把手 hit pad-x          | `--bp-handle-hit-pad-x` / space-1   | 4px                     | chrome 别名；module 直接用 space-1                                     |
| slash 宽（域默认）      | `--bp-slash-width`                  | 280px                   | **仅** `.bp-chrome-root` 作用域；外层写 `var(--bp-slash-width, 280px)` |

### 1.2 字阶 / 行高 / 字重

| 块 / 元素        | font-size token         | weight                  | line-height               | margin-block（建议）                        |
| ---------------- | ----------------------- | ----------------------- | ------------------------- | ------------------------------------------- |
| paragraph / list | `--font-size-base` (14) | `--font-weight-normal`  | `--line-height-body` 1.55 | 0（靠行 gap）                               |
| heading 1        | `--font-size-2xl` (22)  | content / heavy         | `--line-height-tight`     | top ≥ space-3～5 / bottom space-2           |
| heading 2        | `--font-size-xl` (19)   | content                 | tight                     | top space-2～4 / bottom space-2             |
| heading 3        | `--font-size-lg` (17)   | content                 | ui 1.35                   | top space-2 / bottom space-1_5              |
| heading 4        | `--font-size-md` (15)   | content / medium        | ui                        | top space-1～3                              |
| heading 5–6      | base 或 md              | medium / content        | ui                        | top space-1                                 |
| code 块正文      | `--font-size-sm` + mono | code 400                | body                      | pad space-3；上下 space-2                   |
| slash 项标题     | `--font-size-base`      | medium                  | ui                        | chrome `.bp-slash-item-title` 已定          |
| slash 项描述     | `--font-size-xs`（12）  | normal                  | ui                        | 勿用 micro 除非密度档另议                   |
| slash 分组标签   | `--font-size-xs`        | medium                  | ui                        | `--letter-spacing-wide` 0.02em              |
| slash 空态       | `--font-size-sm`        | normal                  | ui                        | tertiary；pad space-4 × space-2             |
| flavour 调试标   | xxs                     | medium                  | tight                     | **默认 display:none**                       |
| heading 字重锚   | —                       | content=600 / heavy=700 | —                         | module 现用 semibold→content；H1 可抬 heavy |

**竞品节奏借法（数值已改写）**

| 来源          | 原值                                   | 本仓落点                                     |
| ------------- | -------------------------------------- | -------------------------------------------- |
| AppFlowy H    | base+16/+12/+8/+4/+2/0（默认 base≈16） | 2xl/xl/lg/md/base **token 档**，基准仍 14    |
| AppFlowy 行高 | 1.4                                    | body **1.55**（CJK 折中；勿改回 1.4 硬编码） |
| AFFiNE H1     | weight 700、letter-spacing -0.02em     | heavy + `--letter-spacing-tighter` **可选**  |
| chat-md h1    | ~1.2em                                 | 纸面 **故意更大**（主阅读面，用绝对 token）  |

### 1.3 表面 / 阴影 / 圆角 / z

| 用途               | Token / 公式                                                       | 禁止                                                                    |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 工作区底           | `--bg-workspace` / `--bg-primary`                                  | 纸面整页纯白通栏另起岛                                                  |
| 纸面               | `--bg-card`                                                        | 竞品主题色底                                                            |
| slash / 浮层表面   | `--bg-elevated`                                                    | 裸 `#fff` / Material 纯白卡                                             |
| 块 hover           | `--bg-hover` 或 `--tint-hover`（text-primary **4%**）              | 高饱和蓝底                                                              |
| 块 focus           | `--bg-active` / tint-active **8%** + inset **中性** hairline       | accent-blue 描边                                                        |
| multi              | `--tint-strong` **12%** + hairline-strong inset                    | 品牌选区色常驻                                                          |
| slash 项 hover     | `--bg-hover` / tint-hover                                          | accent-blue 整行                                                        |
| slash 项 active    | `--bg-active` / tint-active                                        | 与 hover 同档闪回                                                       |
| 边线               | `--hairline` / `--hairline-width`                                  | 散落 `1px solid #eee`                                                   |
| 块行圆角           | `--radius-md` (6)                                                  |                                                                         |
| slash 圆角         | `--radius-lg` (8)                                                  | 与 AFFiNE 8px **节奏**同，token 不同                                    |
| slash 项圆角       | `--item-radius` → sm (5)                                           | 写死 8 与宿主同圆角会「卡片叠卡片」                                     |
| 面板壳阴影         | `--shadow-sm`                                                      |                                                                         |
| **块 slash 阴影**  | **`--shadow-lg`**（跟 shell dropdown / `[data-panel]`）            | 仿 AFFiNE 彩影；勿绑 chat 无影红线                                      |
| chat slash 阴影    | **none**（域内红线，仅对照）                                       | 误搬进 note 宣称「一体」                                                |
| slash z            | **`var(--z-popover)` = 200**（`z-index.css`）                      | 裸 9999；**勿**误用 `--z-dropdown`（1010）或 `--z-dropdown-menu`（400） |
| 拖拽 ghost（另轨） | `--z-drag-highlight` 1020 / `--z-drag-card` 1030 / `--shadow-drag` | 与 slash 抢层时再议；slash 仍停 popover                                 |
| 落点线色           | `--bp-drop-line-color` = text-primary **28%** mix                  | 默认亮品牌蓝；可加 0.5px 8% 外扩抗亚像素                                |
| focus 环（项）     | `--focus-ring`（键盘 focus-visible）                               | outline 自定义色 / accent 环                                            |

### 1.4 控件尺寸（把手 / 图标盒）

| 用途          | Token                 | 量级                      |
| ------------- | --------------------- | ------------------------- |
| 把手视觉宽    | `--icon-size`         | 16                        |
| 把手 min 高   | `--control-height-xs` | 24                        |
| 把手容器宽    | icon + 2× hit-pad     | ~24                       |
| slash 图标盒  | `--control-height-sm` | 28（对齐 AFFiNE 28 节奏） |
| 多选框        | `--icon-size-sm`      | 14                        |
| 行 min-height | `--row-height-sm`     | = control-height-sm       |

**AppFlowy option 栏 44**：只作「左栏可操作」完成度参考；本仓 **不** 默认占 44px 常驻栏（破坏静默与阅读列）。产品若加 `+`，用 **hover 显** + `control-height-xs` 热区。

---

## 2. 纸面列表（Paper List）对照总表

| 维度            | AFFiNE                            | AppFlowy                | Conex 主壳 / 已落地                                 | **目标配方（抄）**                                                                     | 状态（2026-08-12）              |
| --------------- | --------------------------------- | ----------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| 纸面底          | 文档白/主题；画布 note 可彩       | onBackground            | `--bg-card` 浮于 workspace                          | 保持 card；dark 只跟 token                                                             | ✅ module                       |
| 阅读列宽        | `--affine-editor-width` 居中      | min 480 / max 480×4     | `--chat-col-max` 760；`--note-paper-col-max` 可覆盖 | `max-width: var(--note-paper-col-max, var(--chat-col-max, 720px)); margin-inline:auto` | ✅                              |
| 水平边距/gutter | DOC pad 24；side-padding          | left 40 + option **44** | panel-pad 12；space-5/6                             | 左 **space-6** gutter + 行内把手；**非** 44 常驻                                       | ✅ 左 gutter                    |
| 块间 gap        | 段落 margin 节奏                  | 块 builder              | space-0_5                                           | **保持 2px 级**连续纸                                                                  | ✅                              |
| 块行 pad        | hover rect 额外 ~4                | node padding            | 1_5 × 2                                             | 勿加大到「卡片堆」                                                                     | ✅                              |
| 默认 chrome     | 无常驻把手                        | 左 + / … 相关           | HandleVisibility **hidden** L0                      | 非 hover **opacity 0**；禁止常驻 0.3「好看」                                           | ✅ 语义；React 把手仍装饰       |
| Hover 底        | `--affine-hover-color` r6         | toolbarHover            | tint-hover 4%                                       | **仅** tint/bg-hover                                                                   | ✅                              |
| Focus           | 选区叠加                          | selectionColor          | bg-active + 中性 hairline inset                     | **勿回** accent-blue 描边                                                              | ✅                              |
| Multi           | 框选                              | 多节点                  | tint-strong                                         | 与 model multi 一致                                                                    | ✅ 皮；几何另轨                 |
| 把手形态        | grabber 4 / dots 14×26；容器宽 16 | 拖图标 + option 44      | 六点 radial；tertiary                               | 继续六点；色 text-tertiary；hover 0.45 / multi 0.7                                     | ✅ 双轨皮；React `pe:none`      |
| 标题级差        | h1–h6 CSS var                     | base+N w600             | 2xl→base token 族                                   | 见 §1.2；H1 可用 heavy                                                                 | ✅ 基本；margin 可再抬          |
| flavour 噪点    | 正文无 type 标                    | 无                      | 曾 uppercase 常驻                                   | **display:none**；仅 `data-debug`                                                      | ✅                              |
| code / quote    | 主题 code/quote                   | 组件样式                | `--md-code-*`；quote 左 2px hairline-strong         | 与 chat-md **同族**                                                                    | ✅ module 轻量                  |
| 落点线          | DnD 中间件                        | visual_drag_area 条     | DomHost + css 2px 中性 28%                          | React 投影须同色同厚                                                                   | ⚠ DomHost 有 / React 内容行未画 |
| 字族            | AFFiNE sans                       | 可配 Google Fonts       | `--font-sans` CJK 优先                              | **必须** font-sans / mono                                                              | ✅                              |

---

## 3. Slash 浮层对照总表（可执行）

| 维度         | AFFiNE（styles.ts）            | AppFlowy           | 主壳样本（chat / dropdown）                            | **块 slash 目标（抄）**                                                 | 状态                        |
| ------------ | ------------------------------ | ------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------- |
| 宽           | **280px** 固定                 | 场景裁剪           | chat **256**；dropdown ~220                            | `width: min(var(--bp-slash-width, 280px), 100%)`                        | css ✅；React catalog DOM ⚠ |
| max-height   | 视口内滚动                     | list               | chat `min(320px, 40vh)`                                | `max-height: min(360px, 70vh)` + overflow auto（`.bp-slash-host` 已写） | css ✅                      |
| 表面         | overlayPanel 背景              | Material elevation | elevated                                               | **仅** `--bg-elevated`                                                  | ✅ 配方                     |
| 边           | 主题 border                    | divider            | hairline / border-color                                | `var(--hairline-width) solid var(--hairline)`                           | ✅                          |
| 圆角         | **8px**                        | 平台               | panel lg；chat md                                      | **`--radius-lg`**                                                       | ✅                          |
| 阴影         | overlayPanelShadow             | elevation          | shell dropdown **shadow-lg**；chat **none !important** | 块域 **`--shadow-lg`**（文档写明与 chat 域差）                          | ✅ 配方                     |
| 内边距       | **8 4 8 8**                    | list tile          | dropdown-padding；chat space-1                         | `--dropdown-padding` + gap `--dropdown-gap`                             | ✅                          |
| 分组         | font-xs + 次级；pad 2×8        | 分组标题           | （chat 少分组）                                        | xs + tertiary；`.bp-slash-group-label`；非首组 top hairline             | css ✅                      |
| 项           | 图标 **28×28** + 文案；pad 2×8 | 图标+文案          | item-padding；icon 28                                  | icon=`control-height-sm`；pad=`item-padding`；radius=`item-radius`      | css ✅                      |
| hover/active | hover-color                    | selection          | tint-active / bg-hover                                 | hover→bg-hover；active→bg-active；**禁** accent 整行                    | css ✅                      |
| z            | popover                        | elevation          | `--z-popover` 200                                      | **`z-index: var(--z-popover)`**                                         | css ✅                      |
| 打开策略     | widget 显隐 + IME 守卫         | `/` 白名单         | Radix Portal；SlashMenuModel composing 拒开            | 皮：`data-slash-open=0` / `[hidden]` → `display:none`；**默认零噪声**   | 模型 ✅；React 列表 ⚠       |
| 动效         | 主题                           | 平台               | chat 仅 opacity 入场；eco 停转                         | `--transition-micro` 或 opacity；`data-perf-tier=eco` 无过渡            | 建议                        |
| 数据源       | config items                   | 节点菜单           | chat 自有 commands                                     | **`SlashMenuModel.getSnapshot().items`**（id/title/description/group）  | 模型 ✅                     |
| 触发逻辑     | `/` + composition              | `/`                | 模型可测                                               | **皮不管触发**；交互/IME 归引擎轨                                       | —                           |

### 3.1 可直接粘贴的宿主皮（与 `04` S1 / `blockChrome.css` 一致）

```css
/* 设计落地时：优先复用 .bp-slash-host 类名，或 module 1:1 同公式 */
.slashHost {
  box-sizing: border-box;
  position: absolute; /* 或 Portal fixed；勿挤阅读列流式布局 */
  z-index: var(--z-popover);
  width: min(var(--bp-slash-width, 280px), 100%);
  min-width: min(200px, 100%);
  max-height: min(360px, 70vh);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--dropdown-gap);
  padding: var(--dropdown-padding);
  background: var(--bg-elevated);
  border: var(--hairline-width, 1px) solid var(--hairline);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  line-height: var(--line-height-ui);
}
.slashHost[hidden],
.slashHost[data-slash-open='0'] {
  display: none !important;
}
```

### 3.2 分组 + 项（抄）

```css
.slashGroupLabel {
  padding: var(--space-1) var(--space-2) var(--space-0_5);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--text-tertiary);
  line-height: var(--line-height-ui);
  letter-spacing: var(--letter-spacing-wide);
  pointer-events: none;
  user-select: none;
}
.slashItem {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--control-height-sm);
  padding: var(--item-padding);
  border: none;
  border-radius: var(--item-radius);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-micro);
}
.slashItem:hover {
  background: var(--bg-hover, var(--tint-hover));
}
.slashItem[data-active='1'],
.slashItem[aria-selected='true'] {
  background: var(--bg-active, var(--tint-active));
}
.slashItemIcon {
  flex: 0 0 var(--control-height-sm);
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--hairline-width, 1px) solid var(--hairline);
  border-radius: var(--radius-xs);
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.slashItemTitle {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-ui);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slashItemDesc {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: var(--line-height-ui);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

---

## 4. 静默 Chrome 状态机（观感验收句）

| 状态     | 把手 opacity | 块底                 | slash 浮层       | 落点线         | 验收句                                      |
| -------- | ------------ | -------------------- | ---------------- | -------------- | ------------------------------------------- |
| L0 默认  | **0**        | transparent          | 无 / open=0      | hidden         | 截图像「干净纸」，无六点、无菜单、无 `+` 条 |
| hover 行 | **0.45**     | tint-hover 4%        | 仍关（除非 `/`） | hidden         | 仅本行抬 chrome                             |
| focus 行 | 0.45         | tint-active + 中性环 | 关               | hidden         | 无 accent 蓝描边                            |
| multi    | **0.7**      | tint-strong          | 关               | 可有           | 多选不抢阅读                                |
| slash 开 | 保持行态     | 不因菜单改全树底     | elevated 浮层    | hidden         | 打开才有 DOM 可见；关后零残留               |
| 拖中     | grab 态      | 可选 drag 预览       | 关               | **2px 中性线** | 线色非品牌蓝；pointer-events none           |

**诚实边界**

| 可宣称                       | 不可宣称                                    |
| ---------------------------- | ------------------------------------------- |
| 皮 token 对齐主壳            | EL-01 / A-SIL / A-BLK-02 关闭               |
| DomHost + chrome.css 契约绿  | 桌面用户已看到完整 Notion 级 slash 产品体验 |
| React `data-slash-open` 同步 | catalog 列表已产品挂载（若 DOM 仍无项）     |
| React `.handle` 热区放大     | 真拖拽完成（`pointer-events: none` 仍在）   |

---

## 5. 与主壳一体 vs 竞品完成度（借/不借）

| 借（节奏 / 完成度）                              | 不借                                   |
| ------------------------------------------------ | -------------------------------------- |
| 非 hover 零 chrome；hover 出把手                 | 整套 `--affine-*` 色板                 |
| slash 宽 **280**、图标盒 **28**、圆角 **8** 节奏 | AFFiNE overlay 变量名 / 彩影           |
| 左 gutter 预留、阅读列 max-width 居中            | AppFlowy **44** 常驻 option 栏         |
| 标题级差 + 段 margin 拉开                        | Flutter 字体栈 / Google Fonts          |
| 分组 slash、项密度、键盘 active 皮               | slash **功能全集** / 引擎 catalog 业务 |
| 落点细线、code/quote 轻量区分                    | 画布 edgeless / note slicer 视觉       |

**域差写明（防混红线）**

| 域             | 宽      | 阴影          | 用途           |
| -------------- | ------- | ------------- | -------------- |
| chat slash     | 256     | **none**      | 对话作曲，克制 |
| 块 slash       | **280** | **shadow-lg** | 纸面插入面板族 |
| shell dropdown | ~220    | shadow-lg     | 应用菜单       |

三者 **同 elevated + 中性 hover 语言** 即「一体」；宽/影允许按域不同。

---

## 6. 下一刀设计 Agent · 最高优先级对齐点（≤6）

> 路径键：效果完整度 → 与已锁契约一致 → 可验证。**不是**业务 P0 砍项。  
> 落地后按 **§9 A1–A3** 硬验收；扩展勾选见 §9.2。

| #      | 对齐点                                                   | 可抄 token / 公式                                               | 落点文件（建议）                                | 验收（勾选）                                                           | ≠ 关 EL          |
| ------ | -------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- | ---------------- |
| **P1** | **React slash catalog 浮层吃 `.bp-slash-*` 同公式**      | §3.1–3.2；z=`--z-popover`；宽 min(280,100%)；elevated+shadow-lg | note-paper React portal 或 DomHost 填子节点     | **A2**；open 可见分组/项；hover 中性；dark 无写死 hex；open=0 不占布局 | ≠ A-BLK-02       |
| **P2** | **静默 L0 不回退**（挂载后回归）                         | 把手默认 opacity 0；slash 默认 hidden                           | `06` §3–4 清单                                  | **A1**；默认截图无 chrome 噪声                                         | ≠ A-SIL 产品 e2e |
| **P3** | **双轨同皮**（module 内容行 ↔ DomHost `.bp-*`）          | 同行 pad/gap/hover/落点色 1:1                                   | `NotePaperPanel.module.css` + `blockChrome.css` | **A3**；Skeleton/Strict 同温；无第三套色                               | ≠ EL-01          |
| **P4** | **标题 margin 再贴 01 §4**（H1 top space-5 级）          | 2xl/xl/lg + tight + content/heavy                               | module `[data-heading-level]`                   | h1/h2 肉眼级差；无裸 px                                                | 否               |
| **P5** | **React 把手可点时仍 L0**（若去 `pointer-events: none`） | min 高 `control-height-xs`；色 tertiary；hover 行 0.45          | module `.handle`                                | 可点 ≠ 常驻半透明；真拖另轨                                            | ≠ 真拖 EL        |
| **P6** | **落点线 React 投影**（before/after）                    | 2px；`color-mix(text-primary 28%)`；pe none                     | 挂载轨 / module                                 | dark 可读；非品牌蓝                                                    | ≠ 真 DnD 完成    |

---

## 7. 密度档注意（`data-ui-size`）

主壳 compact 会缩小 `--space-*` / control-height。设计落地时：

- **全部**用 token，禁止写死 `padding: 8px 12px` 绕过 `--item-padding`。
- slash 项 `min-height: var(--control-height-sm)` 随档收缩。
- 验收须点一次 density 切换：纸面与 slash **同档**，无「纸面缩、菜单仍大」。

---

## 8. 与既有 visual-align 文档关系

| 文档      | 关系                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| `00`      | 索引；本页挂入「四期可执行对照」；摘要链 §6 P1–P6 + **§9 验收清单**          |
| `01`      | 三方总表真源；本页 **压缩为可抄配方**                                        |
| `02`/`03` | 一期纸面差距与落地；本页不重开 G1–G3 叙事                                    |
| `04`/`05` | 二期 chrome 皮；§3 示意 CSS 与其 S1/S2 **同向**                              |
| `06`/`07` | 三期 React 挂载检查 / slash 可见皮记录；本页 **P1–P6 + §9 A1–A3 承接下一刀** |

---

## 9. 设计 Agent 验收清单（落地勾选）

> 写 CSS / 挂 React 浮层后按表自检。**通过本清单 ≠ 关 EL / A-SIL / A-BLK-02**（见 §0 R2、§4 诚实边界）。

### 9.1 三条硬验收句（最低交付）

| #                 | 验收句                                                                                                                                                           | 怎么验                                               | 失败信号                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| **A1 · 静默纸**   | **默认态截图只有正文与纸面，无六点把手、无 slash 浮层、无 flavour 大写标、无常驻 `+` 条。**                                                                      | L0 打开 note-paper；不 hover                         | 把手 opacity>0；`[data-slash-open]` 可见空壳；`.flavour` 常显 |
| **A2 · 浮层一体** | **块 slash 打开时：表面 elevated、边 hairline、圆角 radius-lg、影 shadow-lg、z=popover(200)、宽 min(280,100%)；项 hover/active 仅为中性 tint，无 accent 整行。** | open catalog；light+dark 各一眼；DevTools 算计算样式 | 裸 `#fff` / `z-index:9999` / 宽 256 误搬 chat / 蓝底选中      |
| **A3 · 双轨同温** | **同一文档：React module 块行与 DomHost `.bp-block-row` 的 pad/gap/hover 染/落点线色肉眼同温；无第三套魔法色。**                                                 | Skeleton 与 Strict（或 DomHost 挂载）并看            | 一边 8px pad 一边 12px；落点一边蓝一边灰                      |

### 9.2 扩展勾选（P1–P6 落地后）

| 勾  | 项              | 断言                                                                                            |
| --- | --------------- | ----------------------------------------------------------------------------------------------- |
| ☐   | **catalog DOM** | open 后可见 group-label + item（title±desc±icon）；绑 `SlashMenuModel` snapshot，非硬编码假菜单 |
| ☐   | **关即零**      | `hidden` 或 `data-slash-open=0` → `display:none`，不占布局、无残留 portal 挡点击                |
| ☐   | **标题级差**    | H1=`2xl`+tight+content/heavy；H2=`xl`；H3=`lg`；margin-block 仅 token；无裸 `22px`              |
| ☐   | **落点线**      | 2px + text-primary 28% mix；`pointer-events:none`；React 投影与 `.bp-drop-line` 同公式          |
| ☐   | **把手 L0**     | 默 opacity 0；hover 行 0.45；multi 0.7；可点时仍非常驻半透明                                    |
| ☐   | **密度档**      | 切换 `data-ui-size` 后 slash 与纸面同档收缩（靠 token，无写死 item 行高）                       |
| ☐   | **eco**         | `data-perf-tier=eco` 下块行/把手/slash 项无过渡抖动                                             |
| ☐   | **域差不混**    | 块 slash **有** shadow-lg；**不**为「对齐 chat」删影；chat 256/无影 **不**回写进块域            |

### 9.3 设计落地最小 diff 范围（建议）

| 允许改                                                         | 禁止                                   |
| -------------------------------------------------------------- | -------------------------------------- |
| `NotePaperPanel.module.css` 同行 token 对齐                    | fork `--affine-*` / 新主题色板         |
| React slash portal **复用** `.bp-slash-*` 或 1:1 同公式 module | 第三套 `SlashMenu.module.css` 魔法 hex |
| 标题 `margin-block` 抬到 §1.2 建议档                           | 全局改 `--font-size-base` 到 16        |
| 落点 before/after 投影类                                       | 宣称 EL / 真 DnD / A-SIL e2e 关闭      |

---

## 10. 修订

| 日期       | 说明                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-08-12 | 初版：纸面列表 + slash 可执行对照；token 速查 + P1–P6 给设计 Agent                                            |
| 2026-08-12 | 校对 token 表（item-radius / bp 作用域 / z 阶真值 / 空态）；补 **§9 设计 Agent 验收清单**（A1–A3 + 扩展勾选） |
