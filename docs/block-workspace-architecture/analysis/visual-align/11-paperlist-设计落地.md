# 11 · PaperList 设计落地（列表 / 滚动 / 块行 · 主壳一体）

| 字段       | 内容                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| **日期**   | 2026-08-12                                                                                           |
| **角色**   | 美学设计 Agent（§4.2；**不占** ②/③ 实现轨）                                                          |
| **配方源** | `10-paperlist-产品挂载对照.md`（P1–P4 / A1–A4）· `08`/`09` token 与双轨                              |
| **文件域** | `packages/block-paper/src/list/paperList.css` · `note-paper/NotePaperPanel.module.css` · 侧效 import |
| **边界**   | **≠ 关 EL-01 / A-BLK / A-SIL / A-PERF**；皮 ≠ 窗口虚拟化完成；无第三套魔法色 / 裸 `z-index:9999`     |

---

## 0. 纪律钉

| #   | 钉                                                                                          |
| --- | ------------------------------------------------------------------------------------------- |
| R1  | 色/间距/字阶 **100% 主壳 token**；竞品只借节奏                                              |
| R2  | 视觉完成 **≠** EL / A-BLK / 仅窗口 DOM 产品 e2e 关闭                                        |
| R3  | 字号基准保持 14（`--font-size-base`）                                                       |
| R4  | `.bp-paper-block` ↔ `.bp-block-row` ↔ module `.blockRow` **同 pad/gap/hover 公式**          |
| R5  | 滚动条 **禁止** 私有 `::-webkit-scrollbar` 块；继承 `shell-scrollbar.css` + `thin` / gutter |
| R6  | 落地以 `10` 验收句为准；不重开第三套对照轨                                                  |

---

## 1. 对齐了哪些 token（对照 08 §1）

### 1.1 列表 / gap / pad / gutter

| 用途               | Token / 公式                                     | 落点                                               |
| ------------------ | ------------------------------------------------ | -------------------------------------------------- |
| 块间 gap（连续纸） | `--space-0_5`（2px）                             | `.bp-paper-block-host` gap；与 `.body` / chrome 同 |
| 块行 pad           | `--space-1_5` × `--space-2`                      | `.bp-paper-block`                                  |
| 块行内 gap         | `--space-2`                                      | 行 flex gap（把手↔正文日后）                       |
| 行圆角 / min-h     | `--radius-md` / `--row-height-sm`                | ✅                                                 |
| 阅读列左 gutter    | `--space-6`                                      | `data-reading-column=1` **或** 父 `.readingColumn` |
| 阅读列右           | `--space-2`                                      | 同上                                               |
| 列宽               | `--note-paper-col-max` → `--chat-col-max`（720） | `data-reading-column=1`                            |
| body 外 pad        | space-3 / 5 / 4                                  | module `.body` 已有；本波不改量级                  |
| 挂载槽             | flex 1 + min 0                                   | module `.paperListHost`                            |

**作用域变量**（仅 `.bp-paper-list`，值全指向全局 token）：

| 别名                     | 指向           |
| ------------------------ | -------------- |
| `--bp-list-gap`          | `--space-0_5`  |
| `--bp-list-row-pad-y/x`  | `1_5` / `2`    |
| `--bp-list-gutter-start` | `--space-6`    |
| `--bp-list-gutter-end`   | `--space-2`    |
| `--bp-list-row-radius`   | `--radius-md`  |
| `--bp-list-drop-line-*`  | 2px + text 28% |

### 1.2 滚动条（主壳一体）

| 维度        | 配方                                                                    | 禁止                                  |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------- |
| 宽/形态     | `scrollbar-width: thin`                                                 | 私有 `::-webkit-scrollbar` 伪元素规则 |
| 色          | `scrollbar-color: var(--tint-strong) transparent`                       | 写死 `#ccc` / 品牌蓝 thumb            |
| gutter      | `scrollbar-gutter: stable`                                              | 内容跳动无预留                        |
| 全局 webkit | **仅** `apps/.../shell/shell-scrollbar.css`                             | package / module 再造一套             |
| 自滚开关    | 根节点 `data-scroll-host="1"` → overflow auto + overscroll contain      | 默认抢父 `.body` 滚动                 |
| 槽与子 list | `.paperListHost[data-scroll-host=1]{ overflow:hidden }` 让出 scrollport | 双滚动条嵌套                          |

`.body` 本波补：`scrollbar-width: thin` + `scrollbar-color`（与 list 同温；原先仅 `scrollbar-gutter: stable`）。

### 1.3 块行状态 / 标题 / flavour（与 09 同温）

| 状态 / 种    | 皮                                                                                   |
| ------------ | ------------------------------------------------------------------------------------ |
| L0           | transparent；无 chrome 噪声（list 行无把手 DOM 时更干净）                            |
| hover        | `--bg-hover` / tint 4%                                                               |
| focus        | `data-handle=focus` / `data-bp-focus=1` / `:focus-visible` → active + hairline inset |
| multi        | `data-handle=multi` / `data-bp-multi=1` → tint-strong 12%                            |
| 拖中         | `data-dragging=1` opacity 0.72                                                       |
| 落点         | `data-drop-side` 伪元素 2px + text-primary 28%（皮就绪；挂载另轨）                   |
| H1–H6        | 同 09：2xl…base + margin-block token；首块 `margin-top:0`                            |
| code / quote | md-code 族 / 左 2px hairline-strong                                                  |
| 嵌套 chrome  | `:has(> .bp-block-row)` 外层去 pad，避免双层呼吸                                     |
| eco          | `data-perf-tier=eco` 下行过渡 none                                                   |

---

## 2. 改了什么（文件清单）

| 路径                                             | 变更摘要                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `packages/block-paper/src/list/paperList.css`    | **新建**：list / spacer / host / block / 滚动 / 标题 / flavour / eco |
| `packages/block-paper/package.json`              | export `./paper-list.css`                                            |
| `apps/.../NotePaperPanel.tsx`                    | side-effect `import '@crish/block-paper/paper-list.css'`             |
| `apps/.../NotePaperStrictPanel.tsx`              | 同上                                                                 |
| `apps/.../BlockChromeDomMount.tsx`               | 同上（与 chrome 同挂）                                               |
| `apps/.../NotePaperPanel.module.css`             | `.body` thin 滚动；`.paperListHost` 挂载槽                           |
| `docs/.../visual-align/11-paperlist-设计落地.md` | 本记录                                                               |

**未改**：`PaperList.ts` 窗口算法；② 已有 `PaperListDomMount`（本波仅皮 + 去 module 重复行样式）。

---

## 3. 10 · P1–P4 / A1–A4 勾选

| #   | 对齐点 / 验收句                     | 状态      | 备注                                                 |
| --- | ----------------------------------- | --------- | ---------------------------------------------------- |
| P1  | `.bp-paper-block` 与 block-row 同温 | ✅ CSS    | pad/gap/hover/focus/multi + 标题/flavour             |
| P2  | 嵌阅读列 / card 一体                | ✅ 皮     | transparent 根；`data-reading-column` 可选；无二层影 |
| P3  | Spacer 零噪声 + gap 0_5             | ✅        | pe none / 无底边影 / flex-shrink 0                   |
| P4  | L0 静默 + 滚动不闪 chrome           | ✅ 皮     | 行无默认把手；eco none；真 chrome 仍归 09            |
| A1  | 壳内一体                            | ✅ 配方   | 须 ② 嵌进 `.readingColumn` 才可目检产品路径          |
| A2  | 连续纸滚动                          | ✅ 皮     | spacer 零噪声；gap 2px 级                            |
| A3  | 三轨同温                            | ✅ 配方   | list ↔ chrome ↔ module 同 token                      |
| A4  | 静默不回退                          | ✅ 皮语义 | 默认无 chrome 噪声；挂载后回归归 ②                   |

---

## 4. DOM 类名 ↔ 样式映射

| DOM（`PaperList.ts`） | CSS 类 / 属性                             | 职责                        |
| --------------------- | ----------------------------------------- | --------------------------- |
| root                  | `.bp-paper-list` + `data-bp-paper-list`   | 列表根；可选 scroll/reading |
| spacer before/after   | `.bp-paper-spacer-before/after`           | 高度撑杆；pe none           |
| block host            | `.bp-paper-block-host`                    | 窗口块容器 + gap            |
| block                 | `.bp-paper-block` + `data-bp-paper-block` | 行皮（同 block-row）        |
| 可选                  | `data-scroll-host="1"`                    | list 自滚                   |
| 可选                  | `data-reading-column="1"`                 | 无父列时自带 gutter（10）   |
| 产品槽                | `.np-paper-list-mount` / `.paperListHost` | ② `PaperListDomMount` 槽    |

---

## 5. 验收句（观感 · 可点；对齐 10 §7）

| #   | 验收句                                                                                       | 怎么验                           | ≠ 关 EL       |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------- | ------------- |
| L1  | 块间 **2px 级**连续纸；行 pad **1_5×2**；左 gutter **space-6**（列内或 data-reading-column） | DevTools 计算样式 / 密度档切换   | 否            |
| L2  | 滚动条 **thin**、色跟 `--tint-strong`、gutter stable；无私有 webkit 块、无第三套 thumb 色    | list 自滚或 .body 滚长文档       | 否            |
| L3  | 行 hover/focus/multi 与 DomHost `.bp-block-row`、React `.blockRow` **同温**                  | 并看三轨（或 list+DomHost 嵌套） | ≠ A3 产品 e2e |
| L4  | 默认无 chrome 噪声；spacer 不可点、无底色                                                    | L0 截图                          | ≠ A-SIL       |
| L5  | 嵌套 `.bp-block-row` 时外层无双 pad                                                          | DomHost 塞进 paper-block 时      | 否            |

---

## 6. 给 ② 挂载轨的最小约定（皮已就绪 · 对齐 10 §4）

| 约定              | 说明                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| import            | 壳已 side-effect `paper-list.css`；挂载组件无需再 import 一遍                                                             |
| 槽 class          | 已有 `PaperListDomMount` → `.np-paper-list-mount`；亦可用 `.paperListHost`                                                |
| 嵌套              | **推荐** `.body > .readingColumn > [data-bp-paper-list-mount]`（10 §4.1）                                                 |
| 滚动归属          | **优先** 沿用 `.body` 滚；仅当虚拟列表需独立 scrollport 时写 `data-scroll-host=1` 于 list 根，槽同步 `data-scroll-host=1` |
| gutter            | list 挂在 `.readingColumn` 内 → **不要** `data-reading-column`                                                            |
| chrome 嵌套       | 块内若挂 DomHost 行，CSS 已去外层 pad；优先行兼 `bp-block-row`                                                            |
| 标题 / focus 属性 | 投影层写 `data-heading-level` / `data-bp-focus` 即可吃皮                                                                  |

---

## 7. ≠ EL / 不可宣称

| 可宣称                                                           | 不可宣称                                      |
| ---------------------------------------------------------------- | --------------------------------------------- |
| PaperList DOM 类有主壳 token 皮；gap/pad/gutter/滚动与壳一致可点 | EL-01 / 仅窗口 DOM 产品 e2e / A-PERF 数值门   |
| 三轨同温配方（list 行 ↔ chrome 行 ↔ React 行）                   | Notion 级列表完成 / 真虚拟化产品验收关闭      |
| 滚动条契约服从 shell-scrollbar；spacer 零噪声                    | 本波「关」任何 EL 或 W3-G 以外的包            |
| 皮 import 已挂 note-paper；10 P1–P4 CSS 可勾                     | 用户默认路径已切到 PaperList 窗口 DOM（② 事） |

---

## 8. 测试

```text
npx vitest run --config vitest.config.ts \
  packages/block-paper/src/chrome \
  packages/block-paper/src/list \
  apps/crish-desktop/src/components/note-paper
# 期望：chrome.w3f_* / paperList.w3g / note-paper 相关绿
# 本波仅 CSS + import；不改 PaperList 结构门语义
```

---

## 9. 与 08/09/10 关系

| 文档 | 关系                                                         |
| ---- | ------------------------------------------------------------ |
| `08` | 可抄 token 真源；行态/slash 配方                             |
| `09` | slash / chrome / 标题已落；本波不回退                        |
| `10` | **产品挂载对照真源**（P1–P4 / A1–A4）；本页 = 按 10 落地记录 |
| `00` | 索引挂六期对照 `10` + 落地 `11`                              |

---

## 10. 修订

| 日期       | 说明                                                                |
| ---------- | ------------------------------------------------------------------- |
| 2026-08-12 | 初版：按 10 配方落 paperList.css + module 槽；P1–P4 皮勾选；≠ 关 EL |
