# 08 · CONN-06 · G-HYD 打开完成全条件核对表（单点会计落账）

| 元数据       | 值                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **任务**     | 2026-08-13-wave 修复战役 · 轮 7 · 单元 CONN-06（A 链 G-HYD 逐项核对表落账）                      |
| **角色**     | 执行 Agent（只读 + 写被分配文档；禁 git；禁派生子 Agent；禁改业务代码）                          |
| **权威副本** | `docs/block-workspace-architecture/plans/acceptance/EL-dashboard.md`（表 B 追加 · G-HYD 核对表） |
| **详案依据** | `docs/review-md-audit/2026-08-13-wave/plans/D-07-维度详案-连通余量.md` §1.7 / §3                 |
| **核验方式** | 只读核验（rg / read / git status-log 只读）；**未真跑** vitest / cargo / playwright              |
| **落账日期** | 2026-08-13                                                                                       |

---

## 1. 色判口径（白名单）

| 色     | 语义                                                                                |
| ------ | ----------------------------------------------------------------------------------- |
| **绿** | 已交可点：测名/探针在提交态存在（源码形状核验通过）。**≠ 真跑绿**；「绿」≠ 该行关闭 |
| **黄** | 部分：面不全（如仅 jsdom 面已交、真 WebView 面依赖 CONN-01 未交）                   |
| **红** | 未交：测名/探针不存在                                                               |

> 诚实边界：本账为只读核验，全部「绿」均为「**未真跑，测名可点**」；真跑落账须执行轮（vitest/cargo）确认后另记。

---

## 2. G-HYD 逐项核对表（6 条）

| #   | G-HYD 条件项                                                  | 测名/探针（可点）                                                                                                                                                                                                                                                      | 色判   | 证据 path:line                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **G-HYD-1** 可逆 encode + hydrate（W1-H 心侧）                | `g_hyd_01_structure_encode_not_rev_placeholder` / `g_hyd_02_apply_persist_hydrate_tree_isomorphic` / `g_hyd_03_text_snapshot_readable_after_hydrate` / `g_hyd_02_workspace_store_apply_persist_hydrate_isomorphic`                                                     | **绿** | `crates/conex-doc-collab/src/session_tests_hydrate.rs:10/:75/:171`；`crates/conex-workspace-store/src/projection_tests_hydrate.rs:11`；EL-dashboard 表 C W1-H 轨（2026-08-11 记「心侧 G-HYD-1/2 测绿」）                                                                                                                                                                   |
| 2   | **G-HYD-2** 打开投影（doc-session 真路径）                    | `note_document_hydrate_projection_shape` / `note_document_hydrate_query_path_is_labeled` / `conn_a1_mock_ipc_default_hydrate_path_doc_session_observable` / `conn_a1_strict_dom_exposes_hydrate_path_from_mock_ipc`；探针 `data-hydrate-path=doc-session`              | **绿** | 真注册 `main.rs:290` / `command_manifest.rs:217`；实现 `note_commands_hydrate.rs:70-98`（默认 doc-session 分支 :83-94、`debug_assert_eq!(proj.hydrate_path, HYDRATE_PATH_DOC_SESSION)` :89）；store 面 `store_hydrate.rs:132/:158`；Rust 测 `note_commands_tests.rs:184/:250`；前端 `hydrateProjection.test.ts:190` / `NotePaperStrictPanel.test.tsx:308` / `w5b` :207-211 |
| 3   | **产品默认 transport**（Tauri→tauri-ipc）                     | `w5b_product_empty_accepts_tauri_ipc_product_transport_when_injected` / `product_strict_transport_tauri_uses_ipc_source_success` / `product_strict_transport_tauri_empty_success_still_tauri_ipc` / `product_strict_transport_tauri_failure_does_not_fallback_fixture` | **绿** | `hydrateProjection.product.ts:77-87`（tauri→adapt ipc :82-84；无 Tauri→fixture :86）；`resolveProductStrictHydrateSource` :42-50；`noteApi.ts:93-105`（isNoteTauriRuntime）；`w5b` :168-211（source=tauri-ipc / not fixture / path=doc-session）；`WorkspaceEmptyState.lr-h1.test.tsx:58-104`；`hydrateProjection.test.ts:263/:292/:307`                                   |
| 4   | **fixture 诚实回落**（无 Tauri，禁伪装 tauri-ipc）            | `w5b_product_empty_opens_strict_panel_with_fixture_hydrate` / `product_strict_resolve_source_tauri_false_is_fixture` / `product_strict_transport_no_tauri_uses_fixture_demo_not_ipc` / `product_strict_fixture_never_labels_source_as_tauri_ipc`                       | **绿** | `hydrateProjection.product.ts:86`（→ `createEmptyStateStrictDemoTransport`）；`w5b` :46（断言 :93-94 `data-hydrate-source=fixture` ＋ `not.toHaveAttribute('tauri-ipc')`、:96 无 path 不冒充）；`hydrateProjection.test.ts:242/:250-261/:337`；`NotePaperStrictPanel.test.tsx:61`                                                                                          |
| 5   | **data-hydrate-source/path 透传诚实**（仅 IPC 成功体有 path） | `conn_a1_strict_dom_exposes_hydrate_path_from_mock_ipc` / `conn_a1_mock_ipc_default_hydrate_path_doc_session_observable`；探针 `data-hydrate-source` / `data-hydrate-path`                                                                                             | **绿** | `notePaperStrictAssembly.ts:137-139`（source/status/path 探针字典）；`NotePaperStrictPanel.test.tsx:308-343`（:339 source=tauri-ipc、:340 path=doc-session、:341 not fixture）；`hydrateProjection.test.ts:190`；`w5b` :96                                                                                                                                                 |
| 6   | **三态可观测**（loading/ready/empty/error）                   | `w5b_strict_loading_state_visible_before_resolve` / `w5b_strict_empty_state_after_successful_hydrate` / `w5b_strict_error_state_on_hydrate_failure`；ready 断言 `w5b` :201 / `lr-h1` :86                                                                               | **黄** | jsdom 面：探针 `notePaperStrictAssembly.ts:138`（`data-hydrate-status`）；`NotePaperStrictPanel.test.tsx:67/:89（loading）/:106/:117（empty）/:124/:141（error）`。**真 WebView 面未交**：`conn_a_e2e_*` 零命中（rg 无结果；依赖 CONN-01 载体）                                                                                                                            |

---

## 3. 诚实判定（总判）

- **总判 ≠ 打开完成**：6 项中 **5 绿 / 1 黄**；黄项（三态真 WebView 面）依赖 CONN-01 载体未交；且全部「绿」仅**测名可点**（未真跑 vitest/cargo）。
- **≠ EL-01/04/08**：表 A 状态列 10 行全「未关闭」（0/10 保持；`rg -c "未关闭" docs/block-workspace-architecture/plans/acceptance/EL-dashboard.md` ≥ 10 可复核）；本账不产生任何 EL 关闭行。
- **≠ inotify 满关**；**≠ A-BLK e2e**。
- 纪律句保留：`data-hydrate-path` 字符串 / path 透传 ≠ 打开完成；fixture 回落是特性不是洞；「已验·绿」≠ 该行关闭。

---

## 4. 核验记录（只读 · 本会话实测）

- **测名可点**：w5b 组 5 测（`WorkspaceEmptyState.w5b.test.tsx:46/:118/:132/:168/:215`）；`conn_a_*` 组 2 测（`hydrateProjection.test.ts:190` / `NotePaperStrictPanel.test.tsx:308`）；Rust `g_hyd_01/02/03` 与 workspace-store 联测（见上表证据列）。
- **注册核验**：`main.rs:290` `("note_document_hydrate", note_commands::note_document_hydrate)`；`command_manifest.rs:217` `entry("note_document_hydrate", "note", "engine", true)`。
- **transport 核验**：`hydrateProjection.product.ts:77-87` 工厂（默认 `hydrate_path=doc-session`；Tauri→tauri-ipc / 无→fixture 分轨注释与赋值均在）。
- **探针核验**：`notePaperStrictAssembly.ts:137-139`（`data-hydrate-source` / `data-hydrate-status` / `data-hydrate-path`）。
- **未做**：未改业务代码；无 git 写操作（status/log 只读）；未派生子 Agent；未关任何 EL；未真跑任何测试。

---

_2026-08-13 · 轮 7 · CONN-06 执行 Agent · 只写本文件与 EL-dashboard 表 B 追加 · 未改业务代码 · 无 git 写操作 · 未派生子 Agent · 未关任何 EL-01…10_
