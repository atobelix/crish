# 04 · Chrome 二期：Slash 皮 / 落点线 / 代码·引用 / 把手热区

| 字段         | 内容                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| **波次**     | 视觉对齐 **二期**（在 `02`/`03` 一期纸面之后）                                                     |
| **日期**     | 2026-08-11                                                                                         |
| **对象**     | note-paper 产品壳 CSS +（可选）共享 chrome 类名；结构真源仍在 `packages/block-paper/src/chrome/**` |
| **对齐标尺** | **主壳 `tokens.css` 优先**；AFFiNE / AppFlowy 仅完成度 / 节奏参考                                  |
| **禁止**     | fork 竞品色板；用视觉关 EL；宣称「slash 皮 = A-BLK-02 完成」；常驻半透明把手破坏 A-SIL L0          |

---

## 0. 与一期的边界

| 一期（`02`/`03`，已大体落地）                               | 二期（本文件）                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| 标题字阶、阅读列、flavour 默隐、面板 token、L0 六点装饰把手 | **Slash 浮层皮**、**落点线**、**code/quote 块皮**、**把手可点热区** |
| 块 hover/focus 中性 tint                                    | 不重做；复用 `--tint-*` / `--bg-hover`                              |

**诚实现状（2026-08-11 读盘）**

| 层                                   | 已有                                                                                 | 缺                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| React 壳 `NotePaperPanel.module.css` | 阅读列、标题 level、`.handle` 装饰（`pointer-events: none`）、`data-slash-open` 属性 | 无 slash DOM 皮；无 drop 线；无 code/quote 行样式；把手不可点 |
| `BlockChromeDomHost`                 | `data-bp-handle` / `data-bp-drop-line` / `data-bp-slash-host` 契约 + jsdom 测        | **无**与 module.css 统一的产品皮肤类（`.bp-*` 无全局 CSS）    |
| `SlashMenuModel`                     | open/filter/select → `slash_insert`；DEFAULT_SLASH_CATALOG 含 code/quote             | **≠** catalog 浮层 React UI                                   |

---

## 1. 对照总表（AFFiNE × AppFlowy × Conex 主壳 × 本仓现状）

### 1.1 Slash 菜单皮

| 维度     | AFFiNE                 | AppFlowy           | Conex 主壳 token                                         | 本仓现状                 | 目标映射（不 fork 皮）                                      |
| -------- | ---------------------- | ------------------ | -------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| 容器宽   | 固定 **280px**         | 场景裁剪           | —                                                        | 无菜单 DOM               | `width: min(280px, 100%)`                                   |
| 表面     | overlay 白/主题 + 阴影 | Material elevation | `--bg-elevated` + `--shadow-lg`                          | 仅 `data-slash-open`     | elevated + shadow-lg + hairline 边                          |
| 圆角     | ~8                     | 平台               | `--radius-lg` / `--dropdown-radius`                      | —                        | **`--radius-lg`**（与浮层一致；密度档可随 dropdown-radius） |
| 内边距   | 8 4 8 8 量级           | list tile          | `--dropdown-padding`、`--dropdown-gap`                   | —                        | 容器 pad = dropdown-padding；项间距 gap = dropdown-gap      |
| 分组标题 | xs + 次级色            | 分组               | `--font-size-xs` + `--text-tertiary`                     | catalog 有 `group` 字段  | 同 token；padding 水平 `--space-2`                          |
| 项       | 图标 28×28 + 标题/描述 | 图标+文案          | `--item-padding`、`--item-radius`、`--control-height-sm` | 模型有 title/description | item-padding；active/hover → `--bg-hover`                   |
| 高亮项   | hover-color            | selection          | `--bg-hover` / `--tint-hover`                            | —                        | **禁止** accent-blue 整行                                   |
| z 层     | popover                | elevation          | `z-index.css` 体系                                       | —                        | 走壳 z 阶，**禁止**裸 `z-index: 9999`                       |
| 触发逻辑 | `/` + IME 守卫         | `/` 白名单         | `SlashMenuModel` composing 拒开                          | 模型可测；壳未挂 UI      | **皮不管触发**；只绑 open 显隐                              |

**证据**

- 竞品节奏：`01` §2.5；AFFiNE `slash-menu` styles（reference）
- 结构：`packages/block-paper/src/chrome/SlashMenuModel.ts`（DEFAULT_SLASH_CATALOG ~103–112）
- DomHost：`BlockChromeDomHost.ts` `BP_SLASH_HOST` / `BP_SLASH_OPEN`（~74–75, 157–164）
- 主壳：`tokens.css` `--bg-elevated`、`--shadow-lg`、`--dropdown-*`、`--item-*`

### 1.2 落点线（drop indicator）

| 维度       | AFFiNE            | AppFlowy                              | Conex token | 本仓现状                                                                           | 目标映射                                                                         |
| ---------- | ----------------- | ------------------------------------- | ----------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 形态       | 拖放中间件 + 预览 | 水平/垂直指示条（`visual_drag_area`） | —           | DomHost 单例 `data-bp-drop-line` + `data-drop-side` before/after；**React 壳未画** | 水平 2px 线，贴目标行 top/bottom                                                 |
| 色         | 主题指示色        | 可配                                  | 中性优先    | 无 CSS                                                                             | `color-mix(in srgb, var(--text-primary) 35%, transparent)`；**勿**品牌亮蓝作默认 |
| 厚         | 细指示            | 可见条                                | —           | —                                                                                  | **2px**；`border-radius: 1px`                                                    |
| 水平 inset | 随编辑区          | 随列                                  | `--space-2` | —                                                                                  | 左右 inset 与块行 pad 对齐（space-2）                                            |
| 语义       | 真 DnD            | 真 DnD                                | —           | `setDropTarget` **纯呈现**，不产 Move Intent                                       | 皮可先做；真拖归 W3-F / A-BLK                                                    |

**证据**：`BlockChromeDomHost.ts` `DropLineSide` / `setDropTarget` / `BP_DROP_*`（~31–38, 71–73, 147–155, 187–197）；`01` §2.4。

### 1.3 代码块 / 引用块

| 维度        | AFFiNE         | AppFlowy         | Conex 主壳                                                                     | 本仓现状                            | 目标映射                                                                          |
| ----------- | -------------- | ---------------- | ------------------------------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------- |
| 代码底      | 主题 code 容器 | 编辑器 code 样式 | **`--md-code-bg`** / `--md-code-border` / `--md-code-fg`（chat-markdown 已用） | 块行纯 `.text`，flavour=code 无区分 | 容器 bg=md-code-bg；边 1px md-code-border 或 hairline；radius-sm                  |
| 代码字      | mono           | mono             | `--font-mono` + `--font-size-sm` + `--font-weight-code`                        | base 正文                           | 同 chat code 意图，略收 sm                                                        |
| 代码 pad    | 块内 padding   | —                | `--space-3`                                                                    | —                                   | padding space-3；块上下 margin space-2                                            |
| 引用条      | 左边条 quote   | 引用组件         | `--hairline-strong` / `--text-tertiary`                                        | 无                                  | `border-left: 2px solid var(--hairline-strong)`；pad-left space-3；字色 secondary |
| 列表 indent | list 包        | list             | `--space-4`                                                                    | 无专用                              | 二期可顺带：左 indent space-4；**真列表叶后置**                                   |

**证据**：`tokens.css` `--md-code-*`（~60–62 light / ~472–474 dark）；`chat-markdown.css` code 块；`01` §4 字阶表 code/quote 行；catalog 已有 `code`/`quote` id。

### 1.4 把手热区

| 维度     | AFFiNE                   | AppFlowy         | Conex 结构                                   | 本仓现状                                             | 目标映射                                                               |
| -------- | ------------------------ | ---------------- | -------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| 形态     | grabber 4px / dots 14×26 | 拖图标 + `...`   | React 六点；DomHost `button.bp-block-handle` | 六点 radial；**opacity 0→0.45**                      | 保持六点中性，色 `--text-tertiary`                                     |
| 容器宽   | DRAG_HANDLE 16           | option 栏 **44** | `--icon-size` 16                             | flex 0 0 icon-size；阅读列已 `padding-left: space-6` | 热区 **min** 宽高：宽 ≥ icon-size，高 ≥ control-height-xs（24）        |
| 命中     | pointer 在 widget        | 真拖             | React **`pointer-events: none`**             | 装饰 only                                            | 产品可点：去掉 none；默认仍 opacity 0；hover 行抬起                    |
| hover 皮 | hover-color 底           | toolbarHover     | `--tint-hover`                               | 行有 tint，把手无独立底                              | 把手 `:hover` 可 `background: var(--tint-hover)`；**仍不** accent-blue |
| 显隐     | 非 hover 隐              | 相关             | `HandleVisibility` L0                        | 已对齐 data-handle                                   | **禁止**常驻 0.3 opacity「好看」                                       |
| 真拖     | 有                       | 有               | Intent move                                  | 未接                                                 | 热区可点 ≠ 关 EL；真拖另轨                                             |

**证据**：`NotePaperPanel.module.css` `.handle` ~230–266（`pointer-events: none`）；`BlockChrome.ts` `getHandleVisibility`；`01` §2.4。

---

## 2. 结构接线（皮挂哪里）

```
NotePaperPanel / Strict
  └── data-slash-open（已有）
  └── .handle（装饰 → 二期可点热区）
  └── （待）slash 浮层 DOM：可先 React portal / 绝对定位宿主
  └── （待）drop 线：按 data-drop-side 或 chrome sync 投影

BlockChromeDomHost（jsdom / 日后挂载）
  └── .bp-block-handle[data-handle-visibility]
  └── .bp-drop-line[data-bp-drop-line][data-drop-side][data-drop-target]
  └── .bp-slash-host[data-bp-slash-host][data-slash-open]
```

**推荐皮肤落点（主壳优先）**

1. **短线**：全部写在 `NotePaperPanel.module.css`（与一期一体；双轨 Skeleton/Strict 共享）。
2. **中线**（`02` G12）：抽出 `note-paper-chrome.module.css` 或全局 `styles/note-paper-chrome.css`，类名同时服务 React 与 `.bp-*`，避免两套 hover 色。
3. **禁止**：在 `block-paper` 包内写死竞品 hex；包内保持结构/data-*，皮在桌面壳消费 token。

---

## 3. 可执行落地建议（≤6 条 · token 名优先）

> 给设计/实现 Agent；**不**要求本美学文档 Agent 改代码。验收句可勾选。

### S1 · Slash 宿主容器皮（最优先之一）

```css
/* 示意：挂 .slashHost 或 [data-bp-slash-host][data-slash-open='1'] */
.slashHost {
  width: min(280px, 100%);
  box-sizing: border-box;
  padding: var(--dropdown-padding);
  display: flex;
  flex-direction: column;
  gap: var(--dropdown-gap);
  background: var(--bg-elevated);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  /* z：用壳统一阶，勿裸数字散落 */
}
.slashHost[hidden],
.slashHost[data-slash-open='0'] {
  display: none;
}
```

- 功能未接全时：宿主可 hidden 默认；**打开态才有皮**，避免空壳误导「slash 已产品完成」。
- **≠** A-BLK-02 e2e 关闭。

**验收**

- [ ] light/dark 下 elevated 浮于纸面，阴影与设置下拉同族
- [ ] 无 `--affine-*` / 裸品牌蓝底
- [ ] open=0 不占布局

---

### S2 · Slash 分组 + 项密度（接 S1）

```css
.slashGroupLabel {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  padding: var(--space-1) var(--space-2);
  line-height: var(--line-height-ui);
}
.slashItem {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--item-padding);
  border-radius: var(--item-radius);
  cursor: default;
  color: var(--text-primary);
}
.slashItem:hover,
.slashItem[data-active='1'] {
  background: var(--bg-hover, var(--tint-hover));
}
.slashItemIcon {
  flex: 0 0 var(--control-height-sm);
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  border-radius: var(--radius-xs);
  border: 1px solid var(--hairline);
  background: var(--bg-secondary);
}
.slashItemDesc {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}
```

- 数据源：`SlashMenuModel.getSnapshot().items`（id/title/description/group）。
- 键盘 activeIndex 与 `data-active` 同步属交互轨；皮只认属性。

**验收**

- [ ] 项高随 `data-ui-size` 的 item-padding 变，不写死 32px
- [ ] active 中性 tint，非 accent-blue

---

### S3 · 落点线 2px 中性指示

```css
.dropLine,
[data-bp-drop-line] {
  position: absolute; /* 或 sticky 于行；实现可选 */
  left: var(--space-2);
  right: var(--space-2);
  height: 2px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--text-primary) 35%, transparent);
  pointer-events: none;
  z-index: 1; /* 若必须，改为 token/阶名 */
}
[data-bp-drop-line][hidden] {
  display: none;
}
/* side：before → 行顶；after → 行底（由布局/JS 定位，CSS 可配 data-drop-side） */
```

- 备选强调（仍主壳）：`color-mix(..., var(--accent-color) 40%, transparent)`——**暖炭 accent**，不是 accent-blue。
- React 壳无 DomHost 时：可用 `data-drop-target` + 伪元素在 `.blockRow` 上先画。

**验收**

- [ ] before/after 各一帧可见、线不闪全页
- [ ] dark 下 35% 混合仍可辨
- [ ] 文档写明 **≠** 真拖拽 / Move Intent 完成

---

### S4 · 代码块皮（flavour=code / catalog code）

```css
.blockRow[data-flavour='code'] .text,
.blockRow[data-block-kind='code'] .text {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-code);
  line-height: var(--line-height-body);
  color: var(--md-code-fg, var(--text-primary));
}
.blockRow[data-flavour='code'] .blockContent,
.blockRow[data-block-kind='code'] .blockContent {
  background: var(--md-code-bg);
  border: 1px solid var(--md-code-border, var(--hairline));
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  margin-block: var(--space-2);
}
```

- 与 chat-markdown **同 token 族**，避免笔记代码一块色、聊天另一块色。
- 语法高亮后置；二期只做容器+mono。

**验收**

- [ ] light：md-code-bg 浅底；dark：走 dark 段 token
- [ ] 无裸 `#1e1e1e` / VSCode 蓝

---

### S5 · 引用块皮（flavour=quote）

```css
.blockRow[data-flavour='quote'] .blockContent,
.blockRow[data-block-kind='quote'] .blockContent {
  border-left: 2px solid var(--hairline-strong);
  padding-left: var(--space-3);
  margin-block: var(--space-1_5);
}
.blockRow[data-flavour='quote'] .text {
  color: var(--text-secondary);
  line-height: var(--line-height-body);
}
```

- 左边条用 **hairline-strong**（结构线），不用 accent-violet 仿 AFFiNE 品牌。

**验收**

- [ ] 引用与正文级差一眼可辨
- [ ] 多行引用左边条连续（在 content 盒上，不在每字）

---

### S6 · 把手热区（可点 · 仍 L0 静默）

```css
.handle {
  flex: 0 0 var(--icon-size);
  width: var(--icon-size);
  min-width: var(--icon-size);
  min-height: var(--control-height-xs);
  /* 扩大命中：透明 pad 可用 pseudo，或固定 hit 盒 */
  margin-top: var(--space-0_5);
  border-radius: var(--radius-xs);
  opacity: 0;
  cursor: grab;
  pointer-events: auto; /* 相对现状：去掉 none */
  border: none;
  padding: 0;
  /* 六点纹理保持现有 radial；色 --text-tertiary */
  transition:
    opacity var(--transition-micro),
    background var(--transition-micro);
}
.blockRow:hover .handle,
.blockRow[data-handle='hover'] .handle,
.blockRow[data-handle='focus'] .handle,
.blockRow[data-handle='multi'] .handle {
  opacity: 0.45;
}
.handle:hover {
  background: var(--tint-hover);
  opacity: 0.7;
}
.handle:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  opacity: 0.7;
}
/* 非 hover/focus/multi 行：把手不接事件也可 — 用行级 visibility 时保持 hidden 语义 */
.blockRow[data-handle='hidden'] .handle {
  opacity: 0;
  /* 可选：pointer-events: none 仅 hidden，避免隐形挡点击 */
  pointer-events: none;
}
```

- 与 DomHost 对齐属性：`data-handle`（React）↔ `data-handle-visibility`（DomHost）。
- **点击/拖拽行为**可先 no-op 或只 `console`/测锚；**不要**为接通假拖而关 EL。
- 可选二期+：旁侧 `+` 热区 `min-size: var(--control-height-xs)`，色 tertiary，click → 请求 slash（逻辑另包）。

**验收**

- [ ] hidden 行把手不拦截正文选区
- [ ] hover 行可 focus 把手（tabIndex 产品定；DomHost 现 -1）
- [ ] 无常驻可见把手（A-SIL L0）
- [ ] 相关 vitest data-handle 契约不破

---

## 4. 建议局部 CSS 变量（接 `02` §4，二期增补）

在 `.panel` 上别名，**值只指向全局 token**：

```css
.panel {
  /* 一期已建议 */
  --np-col-max: var(--chat-col-max, 760px);
  --np-gutter: var(--space-6);
  --np-handle-size: var(--icon-size);
  --np-handle-opacity: 0.45;
  /* 二期增补 */
  --np-slash-width: 280px;
  --np-drop-line-thickness: 2px;
  --np-drop-line-color: color-mix(
    in srgb,
    var(--text-primary) 35%,
    transparent
  );
  --np-quote-bar: 2px solid var(--hairline-strong);
  --np-code-pad: var(--space-3);
  --np-handle-hit-min: var(--control-height-xs);
}
```

---

## 5. 明确非目标

| 不做                                     | 原因                   |
| ---------------------------------------- | ---------------------- |
| 关 EL-01 / A-BLK-02/04/05                | 皮 ≠ 产品 e2e；纪律 R2 |
| Fork AFFiNE slash 阴影色 / 蓝紫 item     | 破坏主壳一体           |
| 实现完整 slash catalog 交互 + IME 全路径 | 模型已有；UI/引擎另波  |
| 真拖拽几何、多列落点、拖影               | W3-F / A-BLK           |
| 代码语法高亮主题包                       | 后置；先 md-code token |
| 把手常驻半透明「始终可发现」             | 破坏静默 L0            |
| 删除 note-paper / chrome 测试            | 测试资产铁律           |

---

## 6. 落地后登记

- 改 CSS/接线后 **追加** `03-落地记录.md` 二期段，或在本文件修订表打勾。
- 回归：`02` §7 清单 + light/dark + `data-ui-size` + note-paper vitest。
- **≠ EL 关闭** 须在 PR/记录中明示。

---

## 7. 三条最优先（给下一棒）

1. **S1+S2 Slash 浮层皮**：`--bg-elevated` + `--shadow-lg` + `--dropdown-*` / `--item-*`，宽 min(280px,100%)。
2. **S6 把手热区**：去掉装饰-only `pointer-events: none`（hidden 行除外）；min 热区 `--control-height-xs`；L0 显隐不变。
3. **S3+S4（并列）落点线 2px 中性线 + code 走 `--md-code-*`**：引用 S5 可同 PR 顺带。

---

## 8. 修订

| 日期       | 说明                                                                 |
| ---------- | -------------------------------------------------------------------- |
| 2026-08-11 | 二期初版：slash / drop / code·quote / 把手热区对照 + ≤6 条可执行建议 |
