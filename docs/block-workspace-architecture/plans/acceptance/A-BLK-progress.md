# A-BLK 进度抽样（Round9 · W6-A）

> **权威定义**：`docs/block-workspace-architecture/round-D-stack/07-技术栈矩阵裁决.md` §5.1（A-BLK-01…14）  
> **本波范围**：契约/属性 **抽样绿**（W6-A），**不是** EL-01 / A-BLK 全表关闭。  
> **纪律**：W3-F / W5-B **禁止**宣称块工作区完成；本表仅登记抽样状态。

| 图例 | 含义                                               |
| ---- | -------------------------------------------------- |
| 绿   | 本波抽样契约/属性测已绿（仍可能缺 e2e/视觉全证据） |
| 黄   | 半覆盖 / 实现缺口；见备注「W6-A 余量」             |
| 红   | 本波未触及且无可用测                               |

---

## A-BLK-01…09 状态表

| ID           | 断言（摘要）                                             | 状态                                                  | 测路径                                                                                                         | 备注                                                                                                                                                            |
| ------------ | -------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-BLK-01** | 稳定 `block_id`：创建/移动/删除/撤销/合并后引用可解析    | **绿**（create/move/delete/同批合并）/ **黄**（撤销） | `crates/conex-doc-collab/tests/a_blk_contract.rs` · `a_blk_01_*`                                               | create/move/delete 后 id 稳定已钉。**结构 undo API 未暴露** → 撤销路径为 **W6-A 余量**。                                                                        |
| **A-BLK-02** | Slash 插入块（含 IME 不误触，见 A-SIL）                  | **黄**（Intent 形状半）                               | `packages/block-paper/src/chrome/chrome.a_blk.test.ts` · `a_blk_02*`；既有 `chrome.w3f.test.ts` slash→sink     | slash → `slash_insert` StructureIntent 形状 + mock sink 绿。**e2e / IME 不误触全路径** → **W6-A 余量**（composing 拒绝见 A-IME-02 既有测，不关 A-BLK-02 e2e）。 |
| **A-BLK-03** | 块把手悬停可见（L0 静默下按需）                          | **黄**（模型半）                                      | `packages/block-paper/src/chrome/chrome.a_blk.test.ts` · `a_blk_03*`；`chrome.asil.test.ts` 多选/hover         | `BlockChromeModel` L0 默认 hidden、hover/focus/multi 按需绿。**e2e/视觉 DOM** → **W6-A 余量**。                                                                 |
| **A-BLK-04** | 单块拖拽重排 + 落点线                                    | **黄**（Op 半）                                       | `crates/conex-doc-collab/tests/a_blk_contract.rs` · `a_blk_04_move_single_reorder_order`；既有 `session` MV-01 | 单次 `Op::Move` 兄弟 order 全序正确已钉。**拖拽 UI / 落点线 e2e** → **W6-A 余量**。                                                                             |
| **A-BLK-05** | 多选框选 + 批量转类型 / 批量删除                         | **黄**（删除 Intent 半）                              | `packages/block-paper/src/chrome/chrome.a_blk.test.ts` · `a_blk_05*`；`chrome.w3f.test.ts` 多选删除            | 多选 → `delete_blocks` 形状 + sink 绿。**框选 e2e / 批量转类型** → **W6-A 余量**。                                                                              |
| **A-BLK-06** | 缩进 / 嵌套列表语义与 schema 一致                        | **黄**（Move nest 半）                                | `crates/conex-doc-collab/tests/a_blk_contract.rs` · `a_blk_06_indent_nest_via_move_parent`                     | 无独立 Indent Op；nest = `Op::Move` 改 parent 已测。**列表 schema / MD 缩进级 / BulletItem 语义** → **W6-A 余量**。                                             |
| **A-BLK-07** | 跨块拖放预览；跨文档拖入 **重生 id**                     | **黄**                                                | —                                                                                                              | 本波未抽样实现测。跨文档重生 id 契约未落。**W6-A 余量**。                                                                                                       |
| **A-BLK-08** | turn into（paragraph↔heading/list/quote…）**保逻辑选区** | **黄**                                                | —                                                                                                              | 本波未抽样。`UpdateProps`/turn-into + 选区保真未测。**W6-A 余量**。                                                                                             |
| **A-BLK-09** | MD 前缀快路径（`# `、`- `、任务等）；composing 禁止      | **黄**                                                | —（composing 结构禁见 A-IME-02 / intentBridge）                                                                | 本波未抽样 MD 前缀转换。**W6-A 余量**。                                                                                                                         |

> A-BLK-10…14 不在本波交付表内；索引见 `A-assert-index.md`。

---

## 本波可执行门禁（抽样）

```bash
# Rust 契约/属性（名称过滤 a_blk）
cargo test -p conex-doc-collab a_blk

# TS 契约（describe/it 含 a_blk）
npx vitest run packages/block-paper -t a_blk
# 或全量 block-paper
npm run test -w @crish/block-paper
```

---

## 实现锚点

| 层            | 路径                                                                                 | 角色                    |
| ------------- | ------------------------------------------------------------------------------------ | ----------------------- |
| 树 Op 权威    | `crates/conex-doc-collab`（`Op::{Insert,Move,Delete}` / `DocSession::apply`）        | A-BLK-01 / 04 / 06 抽样 |
| chrome Intent | `packages/block-paper`（`structureIntents` / `SlashMenuModel` / `BlockChromeModel`） | A-BLK-02 / 03 / 05 抽样 |

---

## 明确不宣称

- **不**写「EL-01 关闭」
- **不**写「A-BLK 全表通过」或「块工作区完成」
- 本表更新仅反映 W6-A 抽样；后续波次补 e2e/视觉/undo/列表 schema 后再抬状态
