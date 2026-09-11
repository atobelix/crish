# 10 · PaperList 产品挂载 × 块行列表节奏 × 主壳一体（可执行对照）

| 字段         | 内容                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| **角色**     | 美学参考 Agent（§4.2；**不占** ②/③ 实现轨）                                                       |
| **日期**     | 2026-08-12                                                                                        |
| **对象**     | **W3-G PaperList** 产品挂载皮 + 块行列表节奏 + 与 note-paper / 主壳一体                           |
| **对齐标尺** | **主壳 token 优先**（`tokens.css` + `z-index.css` + shell/panels）；竞品 = **完成度 / 节奏** 参考 |
| **禁止**     | fork `--affine-*` / AppFlowy 色板；视觉完成 = 关 EL；本文件 **只 analysis，不改业务实现**         |
| **读者**     | 下一刀 **设计 Agent**（可直接抄 token 配方写 CSS）；实现轨读「嵌壳点」勿把挂载冒充交付            |
| **承接**     | `08` 纸面×slash 配方 · `09` 设计落地 CSS；本页补 **列表宿主 / 虚拟化 spacer / 产品嵌壳** 缺口     |

---

## 0. 纪律钉（先读）

| #      | 钉                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| **R1** | 色与材质 **100% 主壳**；竞品只借「连续纸块行节奏、阅读列 gutter、大文档滚动无闪缝」完成度。                            |
| **R2** | **禁止**「PaperList 挂上 + CSS 好看 = 块工作区 / EL-01 / A-PERF 关闭」。皮 ≠ 权威树 ≠ 数值门。                         |
| **R3** | 字号基准保持 Conex **14**（`--font-size-base`）；勿为「更像 Notion 文档」全局改 16。                                   |
| **R4** | PaperList 块行 ⟷ DomHost `.bp-block-row` ⟷ React module `.blockRow` **同 token 公式**；禁止第三套魔法色 / 裸 px 行高。 |
| **R5** | **挂载 ≠ 交付**（`plans/08` §0.2）：Workbench 可滚可点 ≠ EL 关；表 H「可关 EL」列对未关 EL **恒为否**。                |
| **R6** | spacer **仅撑高度**；禁止 `display:none` 挂全量 DOM 冒充虚拟化（引擎铁律）；美学侧禁止给 spacer 加底/边/hover 噪声。   |

**证据真源**

| 层               | 路径                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| 主壳 token       | `apps/crish-desktop/src/styles/tokens.css`                                                                         |
| z 阶真源         | `apps/crish-desktop/src/styles/z-index.css`（`--z-popover: 200` 等；列表本体停 base）                              |
| note-paper 皮    | `apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css`                                           |
| chrome 皮        | `packages/block-paper/src/chrome/blockChrome.css`                                                                  |
| PaperList DOM    | `packages/block-paper/src/list/PaperList.ts` + 皮 `paperList.css` → `@crish/block-paper/paper-list.css`（见 `11`） |
| 挂载契约 / 窗口  | `buildMountPlan.ts` · `editor-kit` `DEFAULT_OVERSCAN_BLOCKS=12` / `MAX_MOUNTED_DOM_BLOCKS=256`                     |
| 前期对照         | 同目录 `01` 总表 · `08` 可抄配方 · `09` 落地记录                                                                   |
| 竞品节奏（本地） | AFFiNE page-root / paragraph；AppFlowy `editor_style.dart` padding / H                                             |

---

## 1. 结构分轨（产品挂载观感前先分清）

```
┌─ 包轨 · W3-G PaperList（结构门可绿）─────────────────────────────┐
│ packages/block-paper/src/list/                                   │
│   PaperList          仅窗口∪pin 挂 DOM；窗外真 remove + spacer   │
│   类名               .bp-paper-list / .bp-paper-block-host       │
│                      .bp-paper-block / .bp-paper-spacer-*        │
│   data-*             data-bp-paper-list / data-bp-paper-block    │
│                      data-block-id / data-mounted-count …        │
│   paintBlock         目前 textContent + 可选 data-flavour        │
│   ★ CSS              paperList.css（落地见 11）                  │
└──────────────────────────────────────────────────────────────────┘
┌─ 包轨 · chrome 块行皮（DomHost）─────────────────────────────────┐
│ blockChrome.css      .bp-chrome-root · .bp-block-row · handle…   │
│ DomHost / DomMount   行结构 = handle + content 槽；≠ PaperList   │
└──────────────────────────────────────────────────────────────────┘
┌─ 桌面壳 · note-paper React 内容行────────────────────────────────┐
│ NotePaperPanel.module.css  .panel/.body/.readingColumn/.blockRow │
│ 阅读列 max-width + 左 gutter space-6；标题/code/quote 已贴 08/09 │
│ ★ 默认路径仍是 React 投影块行，**未**默认嵌 PaperList 宿主       │
└──────────────────────────────────────────────────────────────────┘
┌─ 主壳一体锚─────────────────────────────────────────────────────┐
│ tokens：bg-card / tint / space / font / shadow-sm                │
│ shell 卡片顶栏语言；chat-col-max 760 作阅读列上限后备            │
└──────────────────────────────────────────────────────────────────┘
```

| 层                      | 已有（2026-08-12 读盘）                                      | 产品挂载美学缺口                                             |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| PaperList DOM 契约      | 根/spacer/host/块节点；窗口 + overscan/pin；1 万块上界可证伪 | **零** 列表皮；块节点无 `.bp-block-row` 结构                 |
| note-paper module 块行  | 静默 L0、标题级差、落点伪元素、code/quote                    | 与 PaperList 节点 **未同宿主**；双轨时可能两套行温           |
| DomHost `.bp-block-row` | pad/gap/hover/focus/multi 与 module 已同温（09）             | 挂载轨若并列 React 行 + DomHost 行 + PaperList 行 → 三轨风险 |
| 阅读列 / 面板壳         | `.panel` card + hairline + shadow-sm；`.readingColumn` 居中  | PaperList 根 **未** 强制吃 readingColumn 配方                |
| spacer                  | 仅 `style.height = spacer*Px`                                | 缺「零噪声」CSS 契约（flex-shrink、pointer-events、选中）    |

**诚实句（钉死）**

- `paperList.w3g.test.ts` 绿 **≠** 用户看到 Notion 级连续纸列表。
- 给 `.bp-paper-block` 上色 **≠** EL-01 / A-PERF-01 数值门关闭。
- PaperList 产品挂载演示 **≠** 表 H 可关 EL（恒否，除非表 A 已关）。

---

## 2. 可抄 Token 配方卡（设计 Agent）

> 全部已在主壳或 `08`/`09` 定义；**禁止**组件内再写死同值 px（`data-ui-size` 会缩 space）。

### 2.1 列表宿主 / 阅读列嵌壳

| 用途                      | Token / 公式                                            | 默认量级（comfortable） | 备注                                                        |
| ------------------------- | ------------------------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| 列表根宽                  | `width: 100%`                                           | —                       | 不另起 max-width 岛                                         |
| 阅读列 max-width          | `var(--note-paper-col-max, var(--chat-col-max, 720px))` | 720～760                | 与 module `.readingColumn` **同一式**                       |
| 阅读列居中                | `margin-inline: auto`                                   | —                       |                                                             |
| 左 gutter（把手预留）     | `--space-6`                                             | 24px                    | AFFiNE side-pad 24 **节奏**；**非** AppFlowy 44 常驻栏      |
| 右 pad                    | `--space-2`                                             | 8px                     |                                                             |
| 列表内块 gap              | `--space-0_5`                                           | 2px                     | **连续纸**；大间距只给标题/code/quote                       |
| 纸面底                    | `--bg-card`                                             | 暖白                    | 继承 panel body；勿整页纯白通栏另起岛                       |
| 工作区底（对照）          | `--bg-workspace` / `--bg-primary`                       | 护眼暖灰                | 列表 **不** 直接铺 workspace，铺在 card 内                  |
| 字族 / 正文色             | `--font-sans` / `--text-primary`                        | —                       |                                                             |
| 面板壳（外层 note-paper） | `--bg-card` + hairline + `--radius-lg` + `--shadow-sm`  | 已有 module `.panel`    | PaperList **只填 body/readingColumn**，不重做第二层 card 影 |

### 2.2 块行（`.bp-paper-block` → 对齐 `.bp-block-row` / `.blockRow`）

| 用途          | Token / 公式                                   | 量级        | 禁止                          |
| ------------- | ---------------------------------------------- | ----------- | ----------------------------- |
| 行 display    | flex；align flex-start；gap `--space-2`        | 8           | 卡片堆叠感（过大 gap）        |
| 行 pad        | `--space-1_5` × `--space-2`                    | 6×8         | 写死 12/16 绕过密度档         |
| 行圆角        | `--radius-md`（或 chrome `--bp-row-radius`）   | 6           |                               |
| 行 min-height | `--row-height-sm` → control-height-sm          | 28          | 写死 32/44 冒充 AppFlowy 栏   |
| L0 底         | `transparent`                                  | —           | 常驻 hover 色 / 条纹斑马线    |
| hover         | `--bg-hover` / `--tint-hover` **4%**           | —           | 高饱和蓝底 / `--affine-hover` |
| focus         | `--bg-active` 8% + inset hairline-strong       | —           | accent-blue 描边              |
| multi         | `--tint-strong` 12% + hairline inset           | —           | 品牌选区色常驻                |
| 正文          | `--font-size-base` + `--line-height-body` 1.55 | 14 / 1.55   | 全局改 16                     |
| 标题级差      | 同 `08` §1.2 / module `data-heading-level`     | 2xl…base    | 裸 `22px` / 竞品 var 名       |
| code / quote  | `--md-code-*`；quote 左 2px hairline-strong    | 已有 module | 第三套 code 主题              |
| 过渡          | `--transition-micro`；eco → `none`             | 100ms       | 窗口 remount 长动画闪白       |

### 2.3 Spacer（虚拟化高度楔）

| 用途   | 配方                                                                 | 禁止                                     |
| ------ | -------------------------------------------------------------------- | ---------------------------------------- |
| 尺寸   | 仅 `height`（引擎写 px）；`width: 100%`；`flex-shrink: 0`            | min-height 与 height 双写冲突            |
| 可见性 | 无 background / border / box-shadow / outline                        | 调试条纹默认进产品                       |
| 交互   | `pointer-events: none`；`user-select: none`；`aria-hidden="true"`    | 可聚焦 / 可 hover 染                     |
| 布局   | `overflow: hidden`（防子节点泄漏）；**勿** `display:none` 当「折叠」 | 用 hidden 藏全量块冒充虚拟化（引擎铁律） |
| 滚动缝 | 与 block-host **同背景**（透明即可，露出 card）                      | spacer 与行不同底导致「灰缝闪动」        |

### 2.4 控件 / chrome 叠层（挂载后若行内长把手）

| 用途         | Token                    | 备注                                    |
| ------------ | ------------------------ | --------------------------------------- |
| 把手视觉宽   | `--icon-size` 16         | 与 `08`/`09` 六点皮一致                 |
| 把手 min 高  | `--control-height-xs` 24 |                                         |
| 把手默认     | opacity **0**            | L0；hover 行 0.45 / multi 0.7           |
| slash 浮层 z | `--z-popover` **200**    | **勿** 9999；勿误用 `--z-dropdown` 1010 |
| 拖 ghost z   | `--z-drag-card` 1030     | 与 slash 分阶；列表滚动条勿抬 z 抢浮层  |
| 列表本体 z   | 默认 / `--z-base`        | PaperList 根 **不** 自抬 popover        |

### 2.5 可直接粘贴的列表皮骨架（与 08/09 同温）

```css
/* 设计落地建议：paperList.css 或并入 blockChrome.css 作用域
 * 值全部 var()；禁止第三套 hex / 裸 z-index */

.bp-paper-list {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  /* 嵌在 note-paper .readingColumn 内时：勿再套 max-width，由列容器管 */
  font-family: var(--font-sans, system-ui, sans-serif);
  color: var(--text-primary, #111111);
  background: transparent; /* 露出 .body / .panel 的 --bg-card */
}

/* 若 PaperList 自带阅读列（产品未外包 readingColumn 时） */
.bp-paper-list[data-reading-column='1'] {
  max-width: var(--note-paper-col-max, var(--chat-col-max, 720px));
  margin-inline: auto;
  padding-left: var(--space-6, 24px);
  padding-right: var(--space-2, 8px);
  box-sizing: border-box;
}

.bp-paper-block-host {
  display: flex;
  flex-direction: column;
  gap: var(--space-0_5, 2px);
  min-width: 0;
}

.bp-paper-spacer-before,
.bp-paper-spacer-after {
  flex-shrink: 0;
  width: 100%;
  pointer-events: none;
  user-select: none;
  overflow: hidden;
  background: transparent;
  border: none;
  margin: 0;
  padding: 0;
}

/* 块行：与 .bp-block-row / module .blockRow 1:1 */
.bp-paper-block {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2, 8px);
  padding: var(--space-1_5, 6px) var(--space-2, 8px);
  border-radius: var(--radius-md, 6px);
  min-height: var(--row-height-sm, 28px);
  background: transparent;
  font-size: var(--font-size-base, 14px);
  font-weight: var(--font-weight-normal, 400);
  line-height: var(--line-height-body, 1.55);
  color: var(--text-primary, #111111);
  white-space: pre-wrap;
  word-break: break-word;
  transition:
    background var(--transition-micro, 100ms ease-out),
    box-shadow var(--transition-micro, 100ms ease-out);
}

.bp-paper-block:hover {
  background: var(
    --bg-hover,
    var(
      --tint-hover,
      color-mix(in srgb, var(--text-primary, #111) 4%, transparent)
    )
  );
}

/* 焦点/multi：挂载轨写 data-handle 或 :has(.bp-block-handle[…]) 时同 09 */
.bp-paper-block[data-handle='focus'],
.bp-paper-block:focus-visible {
  background: var(
    --bg-active,
    var(
      --tint-active,
      color-mix(in srgb, var(--text-primary, #111) 8%, transparent)
    )
  );
  box-shadow: inset 0 0 0 1px
    var(--hairline-strong, var(--border-color, hsl(35, 10%, 86%)));
  outline: none;
}

.bp-paper-block[data-handle='multi'] {
  background: var(
    --tint-strong,
    color-mix(in srgb, var(--text-primary, #111) 12%, transparent)
  );
  box-shadow: inset 0 0 0 1px
    var(--hairline-strong, var(--border-color, hsl(35, 10%, 86%)));
}

html[data-perf-tier='eco'] .bp-paper-block {
  transition: none;
}
```

**行内 chrome（产品把 PaperList 行升级为 handle+content 时）**

- **优先**：行根同时带 `bp-block-row`（或复用 DomHost 行结构），吃现成 `blockChrome.css`，**禁止** 复制第三份把手 radial-gradient。
- 若必须独立类名：把手 / 落点 / slash **公式 1:1 抄 `08` §1 / `09` §1.2**，类名别名即可。

---

## 3. 竞品完成度 × 主壳一体（借 / 不借）

### 3.1 列表节奏总表

| 维度             | AFFiNE                                | AppFlowy               | Conex 主壳 / 已有                    | **PaperList 产品目标（抄）**                                | 状态（美学）          |
| ---------------- | ------------------------------------- | ---------------------- | ------------------------------------ | ----------------------------------------------------------- | --------------------- |
| 文档滚动模型     | 全量/局部块 DOM；无本仓式 spacer 窗口 | 编辑器列表 builder     | W3-G **仅窗口∪pin** + spacer         | 观感上仍是「一张连续纸」；spacer 不可见                     | 结构 ✅ / 皮 ⚠ 无 CSS |
| 阅读列           | editor-width 居中                     | min480 / max 480×4     | chat-col-max 760；note-paper-col-max | 嵌 `.readingColumn` 或 `data-reading-column=1`              | 配方 ✅；挂载 ⚠       |
| 左栏             | hover 把手；DOC pad 24                | option **44** 常驻倾向 | space-6 gutter + L0 把手             | **非** 44 常驻；静默 L0                                     | 配方 ✅               |
| 块间             | 段落 margin 节奏                      | 块 padding             | gap space-0_5                        | **保持 2px 级**；标题自 margin-block                        | module ✅；List ⚠     |
| 块行 pad / hover | hover rect r6                         | toolbarHover           | 1_5×2；tint 4%                       | 与 `.bp-block-row` 同温                                     | 双轨 ✅；List 待贴    |
| 大文档滚动       | 性能风险点（round-A）                 | 原生列表               | overscan 12；DOM 上界 256            | 滚动时 **无** 斑马闪缝、无 remount 白闪、无 chrome 常驻闪现 | 需挂载后目检          |
| 字阶 / 行高      | h1–h6 var；约 15–16 base 感           | base≈16 +N；行高 1.4   | base **14**；body **1.55**           | 继续 14/1.55；标题 token 档                                 | 配方 ✅               |
| 虚拟化楔         | —                                     | —                      | spacerBefore/After height px         | 零噪声 CSS §2.3                                             | ⚠ 待落                |
| 与壳一体         | 独立 AFFiNE 主题岛                    | Flutter Material 岛    | 暖灰 workspace + card 纸             | **必须**像 Crish 工作区里的纸，不是外来编辑器 iframe        | 目标                  |

### 3.2 借 / 不借

| 借（节奏 / 完成度）                                  | 不借                                         |
| ---------------------------------------------------- | -------------------------------------------- |
| 非 hover 零 chrome；hover 出把手                     | 整套 `--affine-*` / AF 主题变量              |
| 左 gutter ~24 预留、阅读列 max-width 居中            | AppFlowy **44** 常驻 option 栏               |
| 标题级差 + 段 margin 拉开「文档感」                  | Flutter 字体栈 / Google Fonts / base=16 全局 |
| 大文档「滚得像一张纸」完成度（无闪缝、无操作条噪声） | 像素级 grabber 动画 / edgeless 画布视觉      |
| 块 hover 矩形圆角 ~6 节奏                            | 高饱和 hover 蓝 / 选区品牌色常驻             |

### 3.3 与主壳其它列表的域差（防混）

| 域                    | 行高 / 密度           | 用途       | 与 PaperList                  |
| --------------------- | --------------------- | ---------- | ----------------------------- |
| 侧栏 / settings 列表  | `--row-height` 控件密 | 导航与配置 | **勿** 把纸面行压成 32 工具行 |
| chat 消息虚拟列表     | 气泡 + overscan-px 档 | 对话流     | 材质不同；纸面是 card 连续块  |
| note-paper PaperList  | 阅读正文 body 1.55    | 块文档     | **本页对象**                  |
| chat slash / 块 slash | 见 `08` 域差表        | 浮层       | 列表本体不抬 z-popover        |

---

## 4. 产品嵌壳点（设计 + 挂载轨协作，美学验收）

> 实现细节归 ②；此处只钉 **观感契约** 与 **token 落点**。

### 4.1 推荐 DOM 嵌套（一体感）

```
.panel（module · bg-card · hairline · radius-lg · shadow-sm）
  .header（card-header 语言）
  .body（overflow auto · pad space-3/5/4 · gap 0_5 · bg-card）
    .readingColumn（max-width · gutter space-6 · position relative）
      ┌─ .bp-paper-list[data-bp-paper-list] ─────────────────┐
      │  .bp-paper-spacer-before（height 动态 · 零噪声）       │
      │  .bp-paper-block-host（gap space-0_5）                 │
      │     .bp-paper-block × N（≈ .bp-block-row 皮）        │
      │  .bp-paper-spacer-after                               │
      └───────────────────────────────────────────────────────┘
      （可选）SlashMenuOverlay / DomHost chrome 槽 · 勿双浮层
  .footer（secondary 底 · tertiary 字）
```

| 勾  | 嵌壳断言                                                                                 |
| --- | ---------------------------------------------------------------------------------------- |
| ☐   | PaperList **在** `.body` 滚动容器内；列表根自身 **不** 再套一层 card 影                  |
| ☐   | 阅读列 max-width / gutter 只出现 **一次**（列容器或 list `data-reading-column`，二选一） |
| ☐   | 滚动条样式跟主壳 scrollbar token / body `scrollbar-gutter: stable` 语言                  |
| ☐   | dark / density 切换后列表与顶栏/footer **同温**，无写死 hex 行底                         |
| ☐   | Skeleton 与 Strict 同皮；假数据绿 **不** 写成产品完成                                    |

### 4.2 三轨同温（防「挂载后变丑」）

| 轨             | 选择器 / 宿主                   | 必须同公式的属性                                      |
| -------------- | ------------------------------- | ----------------------------------------------------- |
| A React 内容行 | module `.blockRow`              | pad / gap / hover / focus / multi / 标题 / code·quote |
| B DomHost 行   | `.bp-block-row`                 | 同上 + 把手 / 落点 / multi-check                      |
| C PaperList 行 | `.bp-paper-block`（产品升级后） | **至少** pad/gap/hover/正文；chrome 优先复用 B        |

**失败信号**：一边 6×8 pad 一边 8×12；一边 tint 4% 一边半透明蓝；PaperList 默认正文 16px 硬编码。

### 4.3 虚拟化观感验收句

| 场景           | 期望                                                              | 失败信号                                     |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| 默认打开短文   | 干净连续纸；无六点/无菜单/无 flavour；spacer 高度 0 或不可见      | spacer 灰条、块缝斑马                        |
| 长文快速滚动   | 正文连贯；无整页白闪；无把手集体闪现                              | remount 闪 L0 破坏、估计高度跳动导致「弹簧」 |
| 滚到中部停下   | 可见块 hover 仅本行抬 chrome；窗外块 **不在** DOM（结构门）       | 用 hidden 堆上千节点仍「能检到」             |
| pin / focus 块 | 焦点块可在窗口外仍挂 DOM（引擎 pin）；**观感**仍 L0 除非 focus 态 | pin 块常驻半透明把手                         |
| density / eco  | 行 pad 与 gap 随 token 缩；eco 无过渡抖                           | 写死 item 行高绕过档位                       |

### 4.4 Height 估计与视觉（诚实边界）

| 可做（美学）                                                       | 不可宣称                     |
| ------------------------------------------------------------------ | ---------------------------- |
| 默认 estimate 与「单行 paragraph + pad」视觉量级接近，减少滚动跳动 | A-PERF 数值门标定完成        |
| 标题/code 块实测后回写 HeightMap（实现轨）→ 观感更稳               | 视觉对齐 = 1 万块 TTI 达标   |
| spacer 零噪声 + 同底                                               | spacer 美学 = 虚拟化算法正确 |

建议视觉锚（**仍用 token，勿写死进组件除非 estimate 常量已有**）：

- 单行 paragraph 视觉高 ≈ `line-height-body × font-size-base` + 2× pad-y（约 14×1.55 + 12 ≈ 34 量级）
- `DEFAULT_ESTIMATE_PX` 以 editor-kit 真值为准；美学只要求 **估计与实高别差到「弹簧滚动」肉眼不可接受**，标定归 W6-C / perf-baseline。

---

## 5. 静默 Chrome 状态机（列表挂载后仍生效）

| 状态     | 把手 opacity | 块底                     | slash | 落点线       | 验收句                                 |
| -------- | ------------ | ------------------------ | ----- | ------------ | -------------------------------------- |
| L0 默认  | **0**        | transparent              | 关    | hidden       | 截图只有正文与纸面                     |
| hover 行 | **0.45**     | tint-hover 4%            | 关    | hidden       | 仅本行                                 |
| focus    | 0.45         | tint-active + 中性 inset | 关    | hidden       | 无 accent 蓝描边                       |
| multi    | **0.7**      | tint-strong              | 关    | 可有         | 多选不抢阅读                           |
| 滚动中   | 保持行态     | 不因滚动改全表底         | 关    | hidden       | **禁止** 滚动时全局抬 chrome「方便点」 |
| 拖中     | grab         | 可选 ghost               | 关    | **2px 中性** | 线色 text-primary 28%；pe none         |

完整 slash 浮层配方仍以 **`08` §3** 为准；本页不重复粘贴，挂载时 **z=`--z-popover`**、宽 min(280,100%)、elevated+shadow-lg。

---

## 6. 最高优先对齐点（≤4 · 给设计 Agent）

> 路径键：效果完整度 → 与已锁契约一致 → 可验证。**不是**业务 P0 砍项。
> 落地后按 **§7 A1–A4** 硬验收。

| #      | 对齐点                                                             | 可抄 token / 公式                                                              | 落点文件（建议）                                                  | 验收（勾选）                                               | ≠ 关 EL / 门          |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------- | --------------------- |
| **P1** | **`.bp-paper-block` 与 `.bp-block-row` / module `.blockRow` 同温** | §2.2：pad 1_5×2、gap-2、tint hover/focus/multi、base+body 1.55                 | 新建 list 皮或并入 `blockChrome.css`；挂载后行可兼 `bp-block-row` | **A3**；三轨并看无第三套色；dark 无写死 hex                | ≠ EL-01               |
| **P2** | **列表嵌阅读列 / 主壳 card 一体**                                  | §2.1：col-max + gutter space-6；根 transparent 露 bg-card；不二次 card 影      | note-paper 嵌套契约 + 可选 `data-reading-column`                  | **A1**；侧栏+纸面截图是「壳内一等公民」不是外来白岛        | ≠ W5-B 交付 / 挂载≠关 |
| **P3** | **Spacer 零噪声 + 连续纸 gap**                                     | §2.3；host `gap: space-0_5`；spacer pe none / 无底边                           | paperList 皮                                                      | **A2**；快速滚动无灰缝、无选中高亮楔；短文 spacer=0 不可见 | ≠ A-PERF 数值门       |
| **P4** | **挂载后 L0 静默 + 滚动不闪 chrome**                               | 把手默认 0；禁止滚动态全局显把手；eco transition none；remount 勿默认 hover 态 | 与 `08` A1 / `09` P2 同向                                         | **A4**；默认截图干净；滚停后仅 hover 行抬起                | ≠ A-SIL 产品 e2e      |

**扩展（不占本页 Top4，挂载深化时勾）**

| 勾  | 项              | 断言                                                                           |
| --- | --------------- | ------------------------------------------------------------------------------ |
| ☐   | 标题/code/quote | PaperList 投影带 heading/flavour 时 margin 与 module §1.2 / 09 一致            |
| ☐   | 落点线          | 2px + text-primary 28%；与 `.bp-drop-line` 同公式                              |
| ☐   | 双浮层          | React slash 与 DomHost catalog **二选一**（见 DomMount `projectSlashCatalog`） |
| ☐   | 密度档          | `data-ui-size` 切换后列表与 slash 同档                                         |
| ☐   | 首块标题        | `margin-top: 0` 防顶空白（module 已有；List 首子同）                           |

---

## 7. 设计 Agent 验收清单（落地勾选）

> **通过本清单 ≠ 关 EL-01 / A-PERF / A-SIL / A-BLK**（见 §0 R2、R5）。

### 7.1 四条硬验收句（最低交付）

| #                   | 验收句                                                                                                                  | 怎么验                                           | 失败信号                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| **A1 · 壳内一体**   | **PaperList 嵌在 note-paper card 阅读列内：暖灰工作区 + 暖白纸 + 顶栏 secondary；无外来纯白通栏岛、无第二层抢眼阴影。** | 工作区打开笔记；light 一眼                       | 列表自带 Material 白卡；max-width 双边嵌套挤窄 |
| **A2 · 连续纸滚动** | **块间 2px 级 gap；spacer 不可见；快速滚动无灰缝/条纹楔/选中高亮空白。**                                                | 长 order 假数据滚动；DevTools 看 spacer 计算样式 | spacer 有 background；gap 变成 12px「卡片堆」  |
| **A3 · 三轨同温**   | **同一文档观感：React `.blockRow`、DomHost `.bp-block-row`、PaperList `.bp-paper-block` 的 pad/gap/hover 肉眼同温。**   | 并看或切换宿主                                   | 一边 6px pad 一边 12px；一边中性 tint 一边蓝底 |
| **A4 · 静默不回退** | **默认无六点/无 slash/无 flavour 大写标；滚动过程不集体抬 chrome；关 slash 后零残留。**                                 | L0 截图 + 滚动中录屏一眼                         | 把手常驻 0.3「好看」；滚动时整列 opacity 闪    |

### 7.2 设计落地最小 diff 范围（建议）

| 允许改                                                                   | 禁止                                        |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| 新增 `packages/block-paper/src/list/paperList.css`（或并入 chrome 导出） | fork `--affine-*` / 新主题色板              |
| note-paper 嵌套 class 接线 **仅样式**（实现轨另 PR）                     | 为「好看」取消窗口化 / 用 hidden 挂全量 DOM |
| 行 class 兼挂 `bp-block-row` 复用现皮                                    | 第三套把手 radial 魔法色                    |
| 标题/flavour 皮与 module 对齐                                            | 全局改 `--font-size-base` 到 16             |
| 记录入本树落地笔记（仿 `09`）                                            | 宣称 EL / A-PERF / 产品 e2e 关闭            |

### 7.3 可宣称 / 不可宣称

| 可宣称                                         | 不可宣称                         |
| ---------------------------------------------- | -------------------------------- |
| 列表皮 token 对齐主壳；嵌壳一体；spacer 零噪声 | EL-01 / A-SIL / A-BLK-02 关闭    |
| 三轨块行同温                                   | PaperList 挂载 = 块工作区完成    |
| 滚动观感「像一张纸」                           | A-PERF-01 数值门 / 100k TTI 达标 |
| 与 `08`/`09` slash·chrome 配方兼容             | slash 皮 = 真 `/` 全链 e2e       |

---

## 8. 与既有 visual-align 文档关系

| 文档      | 关系                                                                               |
| --------- | ---------------------------------------------------------------------------------- |
| `00`      | 索引；本页挂入 **六期** PaperList 产品挂载对照                                     |
| `01`      | 三方总表真源；本页列表维度压缩为可抄                                               |
| `02`/`03` | 一期纸面；阅读列/gutter 已落地意图 → 本页要求 List **继承** 而非重开               |
| `04`/`05` | chrome 皮；List 行升级 chrome 时复用                                               |
| `06`/`07` | 桌面 chrome / slash 挂载检查；List 挂载后仍须跑静默与双浮层约束                    |
| `08`/`09` | 纸面×slash 配方与 CSS 落地；本页 **补列表宿主 / spacer / 嵌壳**，不重写 slash 全文 |

---

## 9. 修订

| 日期       | 说明                                                              |
| ---------- | ----------------------------------------------------------------- |
| 2026-08-12 | 初版：PaperList 产品挂载对照；token 配方 + P1–P4 + A1–A4；≠ 关 EL |
