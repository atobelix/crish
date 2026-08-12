# A-BLK 进度抽样（W6-A-S · EL-01 未关闭）

> 本表 = **Skeleton 抽样**；**不是** W6-A Strict；**不是** EL-01 关闭。
> **权威定义**：`docs/block-workspace-architecture/round-D-stack/07-技术栈矩阵裁决.md` §5.1（A-BLK-01…14）
> **本波范围**：契约/属性 **抽样绿**（**W6-A-S**；旧称 W6-A0 / Round9·W6-A 已废作关闭号），**不是** EL-01 / A-BLK 全表关闭。
> **纪律**：W3-F / W5-B / W6-A-S **禁止**宣称块工作区完成；本表仅登记抽样状态。
> **调度**：包 ID 以 `plans/09` 为准；仪表盘见 [`EL-dashboard.md`](./EL-dashboard.md) 表 F。
> **包锚**：RS `conex_doc_collab::W6_A_S_PACKAGE_ID` = `"W6-A-S"`（必须带 `-S`）。

| 图例 | 含义                                                 |
| ---- | ---------------------------------------------------- |
| 绿   | 本波抽样契约/属性测已绿（仍可能缺 e2e/视觉全证据）   |
| 黄   | 半覆盖 / 实现缺口；见备注「W6-A-S 余量 / W6-A 未关」 |
| 红   | 本波未触及且无可用测                                 |

---

## A-BLK-01…09 状态表

| ID           | 断言（摘要）                                             | 状态                                                | 测路径                                                                                                     | 备注                                                                                                                                                                               |
| ------------ | -------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-BLK-01** | 稳定 `block_id`：创建/移动/删除/撤销/合并后引用可解析    | **绿**（create/move/delete/同批合并/**undo 库侧**） | `crates/conex-doc-collab/tests/a_blk_contract.rs` · `a_blk_01_*`                                           | create/move/delete + **`a_blk_01_undo_restores_block_id_after_delete`**（W1-U `DocSession::undo`）已钉。**产品 undo 快捷键 / redo / UI** → **W6-A-S 余量（W6-A 未关）**。          |
| **A-BLK-02** | Slash 插入块（含 IME 不误触，见 A-SIL）                  | **黄**（Intent 形状半）                             | `packages/block-paper/src/chrome/chrome.a_blk.test.ts` · `a_blk_02*`；既有 `chrome.w3f.test.ts` slash→sink | slash → `slash_insert` StructureIntent 形状 + mock sink 绿。**e2e / IME 不误触全路径** → **W6-A-S 余量（W6-A 未关）**（composing 拒绝见 A-IME-02 既有测，不关 A-BLK-02 e2e）。     |
| **A-BLK-03** | 块把手悬停可见（L0 静默下按需）                          | **黄**（模型+jsdom DOM 半）                         | `chrome.a_blk.test.ts` · `a_blk_03*`；`chrome.w3f_dom.test.ts` · `w3f_dom_handle_visibility`               | model + jsdom `data-handle-visibility` 绿。**产品 e2e/视觉** → **W6-A-S 余量（W6-A 未关）**；**≠ EL-01**。                                                                         |
| **A-BLK-04** | 单块拖拽重排 + 落点线                                    | **黄**（Op + jsdom 落点半）                         | `a_blk_contract.rs` · `a_blk_04_*`；`chrome.w3f_dom.test.ts` · `w3f_dom_drop_line`                         | Move Op + jsdom 落点线契约绿。**拖拽 UI / 预览 / 产品 e2e** → **W6-A-S 余量（W6-A 未关）**；**DOM ≠ EL-01**。                                                                      |
| **A-BLK-05** | 多选框选 + 批量转类型 / 批量删除                         | **黄**（删除 Intent + jsdom 多选框半）              | `a_blk_05*`；`chrome.w3f.test.ts`；`w3f_dom_multi_checkbox*`；`w3f_dom_collab_path_intact`                 | 多选 Intent + collab + jsdom 多选框绿。**框选 e2e / 批量转类型** → **W6-A-S 余量（W6-A 未关）**。                                                                                  |
| **A-BLK-06** | 缩进 / 嵌套列表语义与 schema 一致                        | **黄**（Move nest 半）                              | `crates/conex-doc-collab/tests/a_blk_contract.rs` · `a_blk_06_indent_nest_via_move_parent`                 | 无独立 Indent Op；nest = `Op::Move` 改 parent 已测。**列表 schema / MD 缩进级 / BulletItem 语义** → **W6-A-S 余量（W6-A 未关）**。                                                 |
| **A-BLK-07** | 跨块拖放预览；跨文档拖入 **重生 id**                     | **黄**（重生 id 策略半）                            | `a_blk_contract.rs` · `a_blk_07_cross_doc_import_must_regen_block_ids`                                     | 双 `DocSession` 导入策略：目标新 id ≠ 源 id，源 id 不得入目标树。**拖放预览 UI / 产品 e2e** → **W6-A-S 余量（W6-A 未关）**。                                                       |
| **A-BLK-08** | turn into（paragraph↔heading/list/quote…）**保逻辑选区** | **黄**（心+Intent 半）                              | `a_blk_contract.rs` · `a_blk_08_*`；`chrome.a_blk.test.ts` · `a_blk_08*`                                   | **W6-A-S 余量加深**：RS `Op::TurnInto` 保 `block_id`+文本+parent/order；TS Intent 携带 `logicalSelection` + `clampLogicalSelection`。**产品菜单 / 选区投影 e2e** → **W6-A 未关**。 |
| **A-BLK-09** | MD 前缀快路径（`# `、`- `、任务等）；composing 禁止      | **黄**                                              | —（composing 结构禁见 A-IME-02 / intentBridge）                                                            | 本波未抽样 MD 前缀转换。**W6-A-S 余量（W6-A 未关）**。                                                                                                                             |

---

## A-BLK-10…14 状态表（W6-A-S 扩展抽样）

> 全表 e2e 仍仅 **W6-A Strict**；下列为 Skeleton 可点名契约，**不贡献 EL-01 关闭**。

| ID           | 断言（摘要）                                           | 状态                                      | 测路径                                                                        | 备注                                                                                                                                                                      |
| ------------ | ------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-BLK-10** | 块引用 / 反向链接跳转稳定 id                           | **红**                                    | —                                                                             | 本波未触及 refs/backlinks。**W6-A-S 余量（W6-A 未关）**。                                                                                                                 |
| **A-BLK-11** | 未知 flavour → 占位块可恢复，不丢数据                  | **绿**（心+wire 半）/ **黄**（占位 View） | `a_blk_contract.rs` · `a_blk_11_*`；`chrome.a_blk.test.ts` · `a_blk_11*`      | RS `BlockKind::Unknown` + TextEdit + structure encode/decode；**余量加深** `a_blk_11_unknown_turn_into_recovery_*`（Unknown→TurnInto 保 id/text）。**占位 UI e2e** 未关。 |
| **A-BLK-12** | **禁止**纯 textarea / 单行级编辑器冒充块工作区通过门禁 | **黄**（A-SURF 旁证）                     | `packages/block-paper/src/surface.isolation.test.ts`（A-SURF，非本 ID 专名）  | 架构隔离测存在；**无** `a_blk_12_*` 专名门禁。**W6-A-S 余量（W6-A 未关）**。                                                                                              |
| **A-BLK-13** | 折叠/展开与窗口高度图一致；选区钳制策略显式            | **黄**（Intent 形状半）                   | `chrome.a_blk.test.ts` · `a_blk_13*`                                          | `toggle_collapse` 形状 + mock sink。**HeightMap / 选区钳制 e2e** → **W6-A-S 余量（W6-A 未关）**。                                                                         |
| **A-BLK-14** | 代码块叶子 CM6（或等价）可聚焦编辑                     | **黄**（EditorState 骨架半）              | `chrome.a_blk.test.ts` · `a_blk_14*`；既有 `leaves/code/code.cm6.w3e.test.ts` | CM6 状态/导出契约可点名。**产品 focus e2e / 全语言** → **W6-A-S 余量（W6-A 未关）**。                                                                                     |

---

## 本波可执行门禁（抽样）

```bash
# Rust 契约/属性（名称过滤 a_blk）
cargo test -p conex-doc-collab a_blk

# 包锚
cargo test -p conex-doc-collab w6_a_s

# TS 契约（describe/it 含 a_blk）
npx vitest run packages/block-paper -t a_blk
# 或全量 block-paper
npm run test -w @crish/block-paper
```

### 本波可点名测（W6-A-S 增量 · 含余量加深）

| 测名                                                         | 层   | 挂 ID    |
| ------------------------------------------------------------ | ---- | -------- |
| `a_blk_01_undo_restores_block_id_after_delete`               | rust | A-BLK-01 |
| `a_blk_07_cross_doc_import_must_regen_block_ids`             | rust | A-BLK-07 |
| **`a_blk_08_turn_into_preserves_block_id_and_text`**         | rust | A-BLK-08 |
| **`a_blk_08: clampLogicalSelection 转类型后 offset…`**       | ts   | A-BLK-08 |
| `a_blk_11_unknown_flavour_placeholder_preserves_text_and_id` | rust | A-BLK-11 |
| **`a_blk_11_unknown_turn_into_recovery_keeps_id_and_text`**  | rust | A-BLK-11 |
| `a_blk_11: flavourToCollabKind 未识别 → { unknown… }`        | ts   | A-BLK-11 |
| `a_blk_13: buildToggleCollapseIntent 字段钉死…`              | ts   | A-BLK-13 |
| `a_blk_14: createCm6EditorState 可构造可写 doc…`             | ts   | A-BLK-14 |
| `w6_a_s_package_track_is_skeleton_not_el01`                  | rust | 包轨     |

---

## 实现锚点

| 层            | 路径                                                                                            | 角色                                       |
| ------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 树 Op 权威    | `crates/conex-doc-collab`（`Op::{Insert,Move,Delete,TurnInto}` / `DocSession::apply` / `undo`） | A-BLK-01 / 04 / 06 / 07 / **08** / 11 抽样 |
| 包锚          | `crates/conex-doc-collab/src/w6_a_s.rs`（`W6_A_S_PACKAGE_ID`）                                  | **W6-A-S** 轨可点名                        |
| chrome Intent | `packages/block-paper`（`structureIntents` / `SlashMenuModel` / `BlockChromeModel`）            | A-BLK-02 / 03 / 05 / 13 抽样               |
| turn-into     | `packages/block-paper/src/leaves/turnInto.ts`                                                   | A-BLK-08 抽样（Intent + clamp）            |
| 代码叶        | `packages/block-paper/src/leaves/code`（CM6 host）                                              | A-BLK-14 抽样                              |

---

## 明确不宣称

- **不**写「EL-01 关闭」
- **不**写「A-BLK 全表通过」或「块工作区完成」
- **不**将本表 **W6-A-S** 抽样抬为 **W6-A** Strict
- 本表更新仅反映 **W6-A-S** 抽样；后续波次补 e2e/视觉/列表 schema/turn-into UI/refs 后再抬状态
