# persist 喂源缺口

| 元数据 | 值 |
| --- | --- |
| **定位** | 产品 note 叶「最近一篇 persist」查询源。本页只记缺口，不关 EL、不宣称打开完成 |
| **日期** | 2026-08-18 |
| **活码** | `extensions/note-paper/productLeafBindings.ts` 的 `recentPersistedDocId: null` |
| **结论** | 全仓无 list / recent persist **命令**，也无接到活宿主的 store 投影。禁止编 IPC。产品默认打开仍合成空。H2 只能夹具句 |

---

## 1. 总判

产品点「打开笔记」（`openToolInSession(sid, 'note')`，无 `params.docId` / 无 `note:<id>`）→ resolver 第 2 档 `recentPersistedDocId` **恒空** → 无 pre-open bind 则合成 `strict-${wsId}` 诚实空。

**合成空成功 ≠ 打开完成。** 有 Tauri 仍可标 `tauri-ipc` + 0 块；无 Tauri 仍 `fixture`。两边都不是 G-HYD-2 产品句。

---

## 2. 搜过哪些符号（均无「最近一篇 persist」查询面）

| 面 | 搜过 | 实有 | 为何不能当 recent |
| --- | --- | --- | --- |
| 前端契约 | `NOTE_CMD_*` / `NOTE_COMMANDS`（`noteApiContracts.ts`） | apply_md / query_blocks / send_to_note / hydrate / detect_mirror / import_mirror / apply_ops / undo / redo | 全部 **要求已有 docId**；无 list |
| 壳命令 | `note_commands.rs` / `command_manifest.rs` `note_*` / `main.rs` 注册 | 同上 9 条 | 无 `note_document_list` / `list_doc` |
| 工具 | `agent-tools` `note_document_*` / `note_query_blocks` / `NoteBackend` | outline / get_md / apply / query / block_* | schema **必填 doc_id** |
| store | `WorkspaceStore` / `persist_plugin` / `doc_meta` | `load_doc(id)` / `load_rev(id)`；`doc_meta` 仅 `WHERE doc_id=?` | **无** `SELECT doc_id FROM doc_meta ORDER BY updated_at` |
| 前端投影 | `recentPersistedDocId` / `bindWorkspacePersistedStrictDoc` / PaperList | resolver prop；进程内 Map；块虚拟列表 | 不是 persist 索引；Host 已不在活路径 |
| 会话表 | `list_sessions` / `ORDER BY updated_at` | **聊天会话**（conex-db） | 会话 id ≠ persist docId |

`rg` 全仓：`list_doc` / `list_documents` / `listDocuments` / `recentPersisted` 生产命中 **仅** resolver / EmptyState prop / 02 factory 的 `null`。

---

## 3. 为什么不能编命令

03 §6 / §12.1、02 §12.2：现码无 `list_doc` 类 IPC——诚实记缺口，**禁止**本包发明平行账本或新 wire。`doc_meta` 有 `updated_at` **不等于**已有查询面；把 `SELECT … ORDER BY updated_at LIMIT 1` 挂成新命令 = 新造 IPC。localStorage / 会话 id / Host prop **不是** persist。

`query_blocks` / `hydrate` / `load_doc` 都是「已知 id 再读」，不能倒推出最近一篇。

---

## 4. 产品默认仍合成空

02 factory 已接 `resolveProductStrictDocId`。本轮显式档写清：

1. `ctx.params.docId`（URI 经 ViewRegistry 投影，或 open 写入）
2. 否则 `panelId` 为 `note:<docId>`
3. `recentPersistedDocId` **保持 null**（无源可喂）
4. resolver 第 3 档仍读 `bindWorkspacePersistedStrictDoc`（进程内夹具登记，**不是** persist 查询）
5. 否则 `strict-${wsId}` + `synthetic-unbound`
6. **从不**默认 `docId === ctx.sessionId`

用户点工具钮走短 id `'note'` → 无显式 → recent 空 → 撞合成空。

---

## 5. H2 只能夹具句

H2 spec 可用「打开前 apply+commit **同一 id**」或 URI `note:<该 id>` / `params.docId` / pre-open bind 证明 **夹具句**（锁 #4 对指定 id）。

那 **不**证明产品默认打开句。默认打开在补上既有命令/投影之前，永远合成空。

本页 **≠** 打开完成，**≠** 关 EL。
