# 02 · note-paper 差距与建议（可执行）

| 字段         | 内容                                                                |
| ------------ | ------------------------------------------------------------------- |
| **对象**     | `apps/crish-desktop/src/components/note-paper/**` + chrome 静默观感 |
| **结构真源** | `packages/block-paper/src/chrome/**`（Model/DomHost；非皮肤）       |
| **已落地**   | 见同目录 `03-落地记录.md`（token 化面板/块 hover/把手/状态面）      |
| **对齐标尺** | **主壳 token 优先**；竞品完成度参考（`01`）                         |
| **禁止**     | 关 EL；宣称视觉完成=块工作区完成；全局 redesign 爆炸清单            |

---

## 1. 结构现状（面板 vs chrome）

```
NotePaperPanel / NotePaperStrictPanel   ← React 挂载壳（W5-B-S / W5-B）
  └── NotePaperPanel.module.css         ← 纸面皮肤（本文件主战场）
  └── BlockChromeModel + SlashMenuModel ← 状态可测；壳内把手装饰投影
  └── （可选）transport / hydrate 投影

BlockChromeDomHost（包内）              ← jsdom 可测 DOM 契约 data-bp-*
  └── 把手 / 多选框 / 落点线 / slash 宿主容器
  └── **尚未** = 桌面产品默认 React 树完整 chrome
```

| 层           | 有什么                                   | 缺什么（观感）                           |
| ------------ | ---------------------------------------- | ---------------------------------------- |
| CSS 壳       | card 纸、静默 hover、六点把手、body 行高 | 标题字阶、阅读列宽、隐 flavour、slash 皮 |
| Chrome Model | L0 hidden→hover/focus/multi              | —（逻辑已够用）                          |
| DomHost      | data-* 契约                              | 无与 module.css 统一的产品皮肤类         |
| 真编辑叶     | 非本美学包                               | PM/CM6 叶样式另波                        |

---

## 2. 差距表（当前 → 目标）

> 「当前」以 2026-08-11 `NotePaperPanel.module.css` + Panel TSX 为准（`03` 已改部分标 **已做**）。

| #   | 维度         | 当前                                                    | 目标（主壳一体）                                    | 竞品参考意图                                 | 优先级感*           |
| --- | ------------ | ------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------- | ------------------- |
| G1  | 标题字阶     | 所有块 `.text` 同 base 14；level 只写在 `.flavour` 文案 | heading 按 level 换 token 字阶 + margin             | AFFiNE h1–h6；AppFlowy base+N                | **最高**            |
| G2  | 阅读列宽     | `.body` 全宽 + 左右 pad 20                              | 内层 max-width 居中（720–760）                      | AFFiNE editor-width；AppFlowy min/max 文档宽 | **最高**            |
| G3  | flavour 标   | 每块 uppercase 元信息常驻                               | 默认隐藏；debug 才显                                | 竞品正文无 flavour 噪点                      | **最高**            |
| G4  | 左 gutter    | handle 16 在行内，未固定文档左栏                        | 纸面左预留稳定 gutter（space-5～6）                 | AFFiNE side-padding 24；AppFlowy option 44   | 高                  |
| G5  | 把手交互皮   | `pointer-events: none` 装饰                             | 可点热区（仍可 L0 隐）；样式 hover 抬 opacity       | AFFiNE grabber / AppFlowy `...`              | 高（交互真拖另包）  |
| G6  | `+` / 选项   | 无                                                      | 可选：hover 显 `+` 开 slash                         | 双端竞品三位一体                             | 中（依赖 slash UI） |
| G7  | Slash 浮层皮 | 仅 `data-slash-open`；无菜单 DOM 皮肤                   | elevated + shadow + 280 宽 + item 密度              | AFFiNE slash styles                          | 中                  |
| G8  | 落点线       | DomHost 有；React 壳无                                  | 2px 中性强调线 before/after                         | AppFlowy visual_drag_area                    | 中                  |
| G9  | 代码/引用块  | 纯文本行                                                | code：md-code-bg + mono；quote：左边条              | AFFiNE quote/code                            | 中                  |
| G10 | 顶栏调试感   | 标题含「预览壳」+ 多 badge                              | 产品态收敛 badge；调试轨可开                        | 壳 card-header 静默                          | 低–中               |
| G11 | 双轨 CSS     | Skeleton/Strict 共 module（好）                         | 保持；禁止 Strict 另起皮肤                          | —                                            | 保持                |
| G12 | DomHost 类名 | `.bp-block-row` 无全局 CSS                              | 可选共享 `note-paper-chrome.css` 或 CSS module 导出 | 避免两套 hover 色                            | 中                  |

\*优先级感 = 效果完整度/静默观感路径键，**不是**业务 P0 砍项权。

---

## 3. 可执行建议（设计 Agent 落地用）

### 3.1 标题字阶（G1）— **最优先 #1**

**TSX（示意，不强制本 Agent 改代码）**

- 对 `block.flavour === 'heading'`（或 level 有值）给行 `data-heading-level={level}` 或 class `textH1`…。
- 保持 `data-block-id` / testid 契约不变。

**CSS**

```css
/* 映射见 01 §4；仅示例意图 */
.textH1 {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-heavy);
  line-height: var(--line-height-tight);
  letter-spacing: var(--letter-spacing-tight);
  margin: var(--space-5) 0 var(--space-2);
}
.textH2 {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-content);
  line-height: var(--line-height-tight);
  margin: var(--space-4) 0 var(--space-2);
}
.textH3 {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-content);
  line-height: var(--line-height-ui);
  margin: var(--space-3) 0 var(--space-1_5);
}
/* H4→md；H5–6→base + content */
```

**验收**

- [ ] 假数据中 h1/h2 肉眼可辨级差
- [ ] 无裸 `font-size: 22px`（必须 token）
- [ ] 不关 EL；单测 data 契约不破

---

### 3.2 阅读列 + 左 gutter（G2 + G4）— **最优先 #2**

**CSS 结构建议**

```css
.body {
  /* 已有 pad；可改为仅纵向 pad，水平由内层承担 */
}
.paperCol {
  width: 100%;
  max-width: var(--note-paper-col-max, var(--chat-col-max, 760px));
  margin: 0 auto;
  /* 左：把手 gutter；右：对称或略小 */
  padding-left: var(--space-6); /* ~24 对标竞品意图 */
  padding-right: var(--space-5);
  box-sizing: border-box;
}
.blockRow {
  /* handle 绝对或 sticky 在 gutter 内，避免挤压正文 */
}
```

**Token**

- 优先 **复用** `--chat-col-max`，避免第三套列宽；若笔记需独立，在 `tokens.css` 增 `--note-paper-col-max: var(--chat-col-max)` 一处定义。
- **禁止** 在 module 写死 720px 而不挂变量。

**验收**

- [ ] 宽屏正文不拉满整面板
- [ ] 左缘把手区与正文不重叠抖动
- [ ] small/large `data-ui-size` 下 space 档跟着缩

---

### 3.3 默隐 flavour（G3）— **最优先 #3**

```css
.flavour {
  display: none;
}
.panel[data-debug='1'] .flavour,
.panel[data-show-flavour='1'] .flavour {
  display: block; /* 现有 xxs 样式 */
}
```

- 开发/单测可设 `data-debug`；产品默认无噪点。
- **不要**用 opacity:0 占位（仍占垂直空间）。

**验收**

- [ ] 默认截图无 PARAGRAPH/HEADING 字样
- [ ] debug 一开可回归

---

### 3.4 把手与 L0（G5，衔接已做）

| 项         | 建议                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 默认       | opacity 0；非 hover 不占注意力（已做）                                                                 |
| 显         | hover/focus/multi → 0.45～0.7（已做）                                                                  |
| 色         | `--text-tertiary` 点阵（已做）                                                                         |
| 下一步     | 去掉 `pointer-events: none` 时：热区 min 16×20，`:hover` 背景 `--tint-hover`，**仍不**引入 accent-blue |
| 与 DomHost | 统一 visibility 语义：`data-handle` / `data-handle-visibility`                                         |

**禁止**：为「好看」常驻半透明把手（破坏 A-SIL L0）。

---

### 3.5 Slash / 落点（G7–G8，可二期同包）

| 元素       | token 皮                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| slash 容器 | `background: var(--bg-elevated); box-shadow: var(--shadow-lg); border-radius: var(--radius-lg); border: 1px solid var(--hairline); width: min(280px, 100%); padding: var(--dropdown-padding);` |
| 分组标题   | `font-size: var(--font-size-xs); color: var(--text-tertiary);`                                                                                                                                 |
| 项         | `padding: var(--item-padding); border-radius: var(--item-radius);` hover → `--bg-hover`                                                                                                        |
| 落点线     | `height: 2px; background: color-mix(in srgb, var(--text-primary) 35%, transparent); border-radius: 1px;`                                                                                       |

功能未接全时：可只做 **宿主可见皮** + hidden 默认，避免空壳误导「slash 已产品完成」。

---

### 3.6 代码 / 引用块（G9）

| flavour       | 建议                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| code          | 容器 `--md-code-bg`、`--radius-sm`、padding `--space-3`、字 `--font-mono` + `--font-size-sm`                |
| quote（若有） | `border-left: 2px solid var(--hairline-strong); padding-left: var(--space-3); color: var(--text-secondary)` |
| list          | 左 indent `--space-4`；标记色 tertiary（真列表叶后置）                                                      |

---

### 3.7 顶栏产品态（G10）

| 态            | 建议                                                |
| ------------- | --------------------------------------------------- |
| Skeleton 调试 | 保留 silent/rev/count badge（开发友好）             |
| 产品嵌入      | 标题仅文档名；badge 收入 overflow 菜单；footer 可关 |
| 共用          | 继续 `--card-header-min-height` / `--panel-pad-x`   |

---

### 3.8 DomHost 与 React 壳皮肤合一（G12）

- 中期：抽出 `note-paper-chrome.module.css` 或 `styles/note-paper-chrome.css`，类名同时服务 React 行与 `bp-*`。
- 短线：React 壳先满分；DomHost 单测不依赖像素色。

---

## 4. 建议 CSS 变量局部表（仅 note-paper 作用域）

在 `.panel` 上定义别名，**值全部指向全局 token**：

```css
.panel {
  --np-col-max: var(--chat-col-max, 760px);
  --np-gutter: var(--space-6);
  --np-block-pad-y: var(--space-1_5);
  --np-block-pad-x: var(--space-2);
  --np-handle-size: var(--icon-size);
  --np-handle-opacity: 0.45;
  --np-row-radius: var(--radius-md);
}
```

便于日后调密度而不散落魔法数。

---

## 5. 明确非目标（本美学波）

| 不做                              | 原因                       |
| --------------------------------- | -------------------------- |
| 关 EL-01/02/08                    | 纪律 R2；视觉 ≠ 工作区完成 |
| Fork `--affine-*` 色板            | 破坏主壳一体               |
| 实现真拖拽 / 框选几何             | 属 W3-F / A-BLK 引擎轨     |
| 全局改 `--font-size-base`→16      | 拖垮整个 UI 密度           |
| 删除 note-paper 测试 / data-track | 测试资产铁律               |
| 把 Skeleton 标成 Strict           | 包轨纪律                   |

---

## 6. 与 `03-落地记录` 的衔接

| 03 已做                             | 本文件余量        |
| ----------------------------------- | ----------------- |
| bg-card / hairline / shadow-sm 面板 | G2 列宽           |
| tint hover / 中性 focus             | G1 标题           |
| 六点把手 L0                         | G5 可点热区、G6 + |
| line-height-body                    | G9 块种皮         |
| 状态 loading/empty/error            | G3 flavour 默隐   |
| token 徽章 / focus-ring             | G7 slash 皮       |

落地后请 **追加** `03` 修订段或新 `04-…`，勿静默改 CSS 不留记录。

---

## 7. 回归检查清单（改 CSS 后）

- [ ] light / dark 各看一眼纸面
- [ ] `data-ui-size=small|large` 密度
- [ ] `data-perf-tier=eco` 无卡死动画
- [ ] `npm`/`vitest` note-paper 相关单测
- [ ] 无新增裸 hex 主色（fallback 仅 light 中性）
- [ ] 文档仍写明 **≠ EL 关闭**

---

## 8. 三条最优先落地（复述）

1. **标题字阶 token 化投影到块行**（G1）
2. **阅读列 max-width + 左 gutter**（G2+G4）
3. **默认隐藏 flavour 调试标**（G3）

---

## 9. 修订

| 日期       | 说明                                             |
| ---------- | ------------------------------------------------ |
| 2026-08-11 | 初版差距表 + 可执行 CSS/TSX 建议；对齐 03 已做项 |
