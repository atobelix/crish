# 05 · block-paper chrome 视觉二期落地记录

| 字段       | 内容                                                            |
| ---------- | --------------------------------------------------------------- |
| **日期**   | 2026-08-11                                                      |
| **角色**   | 美学设计 Agent（CSS / 轻 DOM）                                  |
| **文件域** | `packages/block-paper/src/chrome/**` + `note-paper/*.css` 窄改  |
| **参考**   | visual-align `01`/`02`；主壳 `tokens.css`；AFFiNE 式静默 chrome |
| **边界**   | **≠ 视觉完成关 EL-01**；不破 `chrome.w3f*` 行为测               |

## 改了什么

1. **落点线 token 化**：新增 `blockChrome.css` 中 `.bp-drop-line`——厚 2px、色为 `text-primary` ~28% 混合，清晰不刺眼，禁止亮蓝品牌。
2. **slash 宿主最小皮**：`.bp-slash-host` 走 `--bg-elevated` / `--shadow-lg` / `--radius-lg` / 宽 min(280px)；预留 group/item class，catalog DOM 后置。
3. **把手热区略放大**：DomHost `.bp-block-handle` 与 note-paper `.handle` 均 `min-height: control-height-xs` + 横向 padding；L0 默认仍 opacity 0 / hidden。
4. **code/quote flavour**：note-paper 块行按 `data-flavour` 轻量区分（`--md-code-*`、左边条引用）；DomHost 可选 `spec.flavour` → `data-flavour`。
5. **导出**：`@crish/block-paper/chrome.css`；Skeleton/Strict 面板 side-effect import。

## 非目标

- 未关 EL-01 / A-BLK e2e；未改 agent-tools / store；未做真拖拽或 slash catalog 产品完成宣称。
