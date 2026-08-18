# UX Readiness — 「功能有了」到「好用」

> **日期**：2026-08-03  
> **状态**：**审查页就绪** — 软编 · 定界符邻域+成对删 · 行号/折叠/语言菜单 · 表 align · 动效接线 · 灯箱 · slash H4–H6  
> **愿景对照**：[09-FEATURE-GAP-VS-VISION.md](./09-FEATURE-GAP-VS-VISION.md)  
> **试玩**：`markdown-editor.html`（完整 SAMPLE + 侧栏 TOC + 审查速记）  
> **逐步核对**：[10-showcase-review-checklist.md](./10-showcase-review-checklist.md)  
> **仍欠**：字符级跨块 · 包迁移 · AI 宿主接入 · 视频/音频

## 读法

| 顺序 | 文档 | 约行 | 内容 |
|------|------|------|------|
| 1 | [00-MASTER-READINESS.md](./00-MASTER-READINESS.md) | ~300 | **总纲**：已交付 vs 金标准、硬需求、U1–U6、调度口令 |
| 2 | [01-unfinished-inventory.md](./01-unfinished-inventory.md) | ~580 | 未完成/半成品总盘点、W 波次诚实分 |
| 3 | [02-multi-block-selection-analysis.md](./02-multi-block-selection-analysis.md) | ~850 | **跨行多选**根因与方案 C（混合） |
| 4 | [03-inline-marks-source-ux.md](./03-inline-marks-source-ux.md) | ~470 | 行内 `**` 邻域显源策略 |
| 5 | [04-user-workflows-and-friction.md](./04-user-workflows-and-friction.md) | ~770 | 15 条日常流程摩擦 |
| 6 | [05-architecture-and-implementation-plan.md](./05-architecture-and-implementation-plan.md) | ~990 | 拆 `editor.js`、U1–U6、agent 表 |
| 7 | [06-clipboard-undo-find.md](./06-clipboard-undo-find.md) | ~300 | 剪贴板 / 撤销 / 查找归属 |
| 8 | [07-format-surfaces-residual.md](./07-format-surfaces-residual.md) | ~320 | 表/代码/图/公式残留 |
| 9 | [08-decision-log.md](./08-decision-log.md) | ~250 | 决策默认：D1/D2/D3 |
| 10 | [09-FEATURE-GAP-VS-VISION.md](./09-FEATURE-GAP-VS-VISION.md) | — | **愿景对照 + 覆盖率诚实盘点** |
| 11 | [10-showcase-review-checklist.md](./10-showcase-review-checklist.md) | — | **打开 markdown-editor.html 逐步核对清单** |
| 12 | [11-SYSTEMIC-REFACTOR-PLAN.md](./11-SYSTEMIC-REFACTOR-PLAN.md) | — | 重构方向摘要（否决块岛） |
| 13 | [12-FUSED-EDITOR-REFACTOR-SPEC.md](./12-FUSED-EDITOR-REFACTOR-SPEC.md) | **~2k 行** | **融合编辑重构执行真源（多 Agent 派单）** |

**合计约 5k+ 行**分析与方案（不含历史 feature-catalog / v3-complete）。

## 一句话结论

**审查页可完整走查**：软编辑、定界符邻域 + 成对 Backspace、代码行号/折叠/语言菜单、表 align、slash/cmd 动效、块入场、图片灯箱、H4–H6 slash。  
**仍未金标准**：字符级跨块、editor.js 体量、包迁移、视频音频、AI 宿主。

## 已落地（近期）

| 项 | 模块 |
|----|------|
| **软编辑默认表面** | `ui/line-source.js` `renderSoftEditSurface`；`editor.js` `enterEdit` |
| **完整行源码（调试）** | `renderFullSourceSurface` — 仅 `fullSourceEdit` |
| **ux-D2 邻域灰定界符** | `inline/marks-model.js` + `live-marks.js` |
| **成对 Backspace 拆格式** | `inline/delim-edit.js` + `tryPairUnwrapMd` |
| **代码行号 / 折叠 / 语言菜单** | `code-read.js` + `code-lang-menu.js` + editor 接线 |
| **表 GFM align parse** | `parse.js` `parseAlignRow` |
| **动效接线** | `MdxMotion.runEnter/Leave`；slash/cmd `is-closing` |
| **图片灯箱** | `blocks/image.js` `openLightbox` |
| **Slash H4–H6** | `slash-menu.js` |
| **Showcase SAMPLE + TOC** | `demo/showcase-sample.js` · `markdown-editor.html` |
| Callout 读态 inline + 软编卡片 | `editor.js` readContentHtml · line-source callout 分支 |
| 多选 chrome-only | `selection/chrome.js`（`forceSourceOnMulti` 可选源码） |
| 拖选阈值 | `selection/controller.js` `DRAG_THRESHOLD_PX` |
| 多选 + 复制 MD | `selection/*` + `edit/clipboard/copy.js` |
| 粘贴 MD/HTML/plain | `edit/clipboard/paste.js` |
| demote/promote 阶梯 + soft 回归 | `edit/demotion.js` · w5 harness |
| 打字撤销合并 | `model.js` `mergeKey` |
| 主应用脚本对齐 | `index.html` 与 demo 同序加载 |

## 硬政策

- 运行时 **禁止 mock AI**；见 `../feature-catalog/AI-HOST-POLICY.md`
- 新逻辑进 `edit/*`、`selection/*`、`inline/*`，**禁止**继续堆 `editor.js`
- 动效：**禁止** `box-shadow` transition；**禁止**激活行 border/描边动画（D16）
- 样本 MD 可由 sample agent 写真实文件，不进库逻辑

## 下一刀（架构转向 · 2026-08-03）

> **block-per-row 换壳已否决为终局。**  
> **执行真源（约 2000 行）**：[12-FUSED-EDITOR-REFACTOR-SPEC.md](./12-FUSED-EDITOR-REFACTOR-SPEC.md)  
> 方向摘要：[11-SYSTEMIC-REFACTOR-PLAN.md](./11-SYSTEMIC-REFACTOR-PLAN.md) · 禁令：[BANNED-VISUAL-UX.md](../BANNED-VISUAL-UX.md)

1. **R0 止血**：零全行激活 chrome；旧岛只修崩溃  
2. **R1**：按 12 号 §16 工单 AGEN-R1-01…10（PM 文档流 + 跨选 + `**`）  
3. **R2** NodeView：task / code / math / callout  
4. **R4** 退役 `editor.js` 换壳主路径
