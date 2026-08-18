# persist 喂源缺口

| 元数据 | 值 |
| --- | --- |
| **定位** | 产品 note 叶「最近一篇 persist」查询源。本页只记现码与未交付面，不关 EL、不宣称打开完成 |
| **日期** | 2026-08-18（第 10 轮：HEAD 与工作区脏文件拆开写） |
| **HEAD** | `d1cb31a`（`.git/refs/heads/refactor/architecture`） |
| **活码（HEAD 已有）** | `extensions/note-paper/productLeafBindings.ts` `loadRecentPersistedDocId` → `noteDocumentRecent`；叶 `NoteLeafHost` 先空后切 |
| **结论** | HEAD 未登记 ⇒ 真壳 invoke missing ⇒ 仍合成空。**≠ 打开完成 ≠ 关 EL** |

---

## 1. 总判

产品点「打开笔记」（`openToolInSession(sid, 'note')`，无 `params.docId` / 无 `note:<id>`）→ `NoteLeafHost` **先**以 `recent=null` 走 resolver（无 pre-open bind 则合成 `strict-${wsId}`）→ `useEffect` 调 `loadRecentPersistedDocId()` → `noteDocumentRecent()` invoke `note_document_recent`。

- 查到非空 `doc_id` → 再切 `binding: 'recent-persisted'`。
- 失败 / 非 Tauri / 命令缺失 / 无行 → 保持 `null` → **仍合成空**。

**合成空成功 ≠ 打开完成。** 有 Tauri 仍可标 `tauri-ipc` + 0 块；无 Tauri 仍 `fixture`。两边都不是 G-HYD-2 产品句。

HEAD rust `generate_handler` / rust `command_manifest` **未列** `note_document_recent`。真壳 invoke 走 missing → 前端收 `null` → 叶停在合成空。

旧页写「全仓无 list / recent 命令、`recentPersistedDocId` 恒 null、禁止编 IPC」——对照 **HEAD 已入库的查询/命令体/前端** **已过时**。旧路径仍对的半句：**命令体在、handler 不在 HEAD**。查询在既有 `doc_meta`+`blocks` / `note_document_*` 面上，不是平行账本。

---

## 2. 已落（HEAD 已有 · 不是脏文件）

下列面由提交进 `d1cb31a` 祖先，**仍在**。不要把 §3 脏登记写进本表。

| 面 | HEAD 证据 | 做什么 |
| --- | --- | --- |
| store 现表查询 | `20aeb2f4` `crates/conex-workspace-store/src/lib.rs` `recent_persisted_nonempty_doc_id`（现码 `:249`） | `doc_meta.rev > 0` 且 `blocks.plain_text` 去空白后非空；`ORDER BY updated_at DESC, rev DESC, doc_id DESC LIMIT 1`。无命中 → `None`。库即工作区（表无 workspace 列） |
| 命令体 | `65c89850` `note_commands_hydrate.rs` `note_document_recent`；`note_commands.rs` re-export。提交说明自钉 **未**登记 `generate_handler` | `#[tauri::command]`；`try_store_backend` → `spawn_blocking` 调上面查询；`{ ok:true, doc_id }` 或失败 outcome。无命中 `doc_id=null` |
| 前端契约 | `noteApiContracts.ts` `NOTE_CMD_DOCUMENT_RECENT = 'note_document_recent'`（`:30`） | 命令名常量。注释写「未接线 → `null`」 |
| 前端 API | `noteApi.ts` `noteDocumentRecent`（`:352`） | 非 Tauri / invoke 非 ok / `ok:false` / 空 id → `null`。不抛、不编假 id |
| 叶喂口 | `productLeafBindings.ts` `loadRecentPersistedDocId` = `noteDocumentRecent()`（`:54`） | resolver 第 2 档 `recentPersistedDocId` |
| 叶时序 | `NoteLeafHost.tsx` `useState(null)` + `useEffect` 再 `setRecent`（`:28-43`） | **先合成空再切**。显式 `params.docId` / `note:<id>` 不查 recent。`22d02f82` 只搬家到扩展，时序未改 |
| 前端 TS 清单 | `apps/crish-desktop/src/api/transport/commandManifest.ts` `:208` | HEAD **已列** `note_document_recent`。前端列名 **≠** rust `generate_handler` |

`d1cb31a` 为止的后续提交（叶搬家 / H1·B3·D2 改挂 / 第 8 轮审计 + 第 9 轮收口）**没有** rust persist 登记。`COMMIT_MSG_R9A`–`R9C` 与 `COMMIT_EDITMSG` 都不提 `generate_handler` / `command_manifest`。

优先级（`resolveProductStrictDocId` / `resolveNotePaperDoc`）未改：显式 → recent persist → pre-open bind → `strict-${wsId}` + `synthetic-unbound`。**从不**默认 `docId === ctx.sessionId`。

---

## 3. 未交付：HEAD Tauri 登记

对照 **HEAD=`d1cb31a`**。**不要把工作区脏文件当已提交。**

还原依据（本会话无 shell，未新跑 `git show` / `git grep`）：

- `.git/logs/HEAD`：`20aeb2f4` 查询、`65c89850` 命令体、`806e9d26` 叶测；其后到 `d1cb31a` 无 rust 登记提交
- `65c89850` 自钉未登记 handler（与 `computer_estop` 缠同文件）
- 第 6 / 7 轮审计对当时 HEAD 的 `git grep note_document_recent HEAD -- …/main.rs` 与 `…/command_manifest.rs` **空**
- HEAD 收口文（`00-索引.md` 第 9 轮，`d1cb31a` 主题）仍写「persist 登记仍缠 `computer_estop`，**未**并入」

| 登记面 | HEAD `d1cb31a` | 工作区脏文件（不当交付） |
| --- | --- | --- |
| `apps/agent-workbench/src-tauri/src/main.rs` `command_registry!` → `generate_handler!` | 笔记段到 `note_document_hydrate` 后接 `note_detect_mirror_drift`。**无** `note_document_recent`。电脑段仍有 `computer_estop` | 已写入 `"note_document_recent"` + `note_commands::note_document_recent`（现码 `:438-440`）。**同一表**里 `computer_estop` 字面已删（电脑段只剩 enable/disable/status） |
| rust `command_manifest.rs` | **无** `note_document_recent`。仍登记 `computer_estop`；总数口径 124 **不含** recent | 已加 `entry("note_document_recent", …)`（`:235`）。`computer_estop` **无 entry**。注释仍写「computer_estop 退役后 123；追加后 124」（`:71` / `:287` / `:299`） |
| workbench `tauri-command-registry.ts` | HEAD `note_*` **无** recent | 工作区已加 `note_document_recent`（`:598`）。测注释把「estop 退役 124→123」与「recent 123→124」绑在一起 |

**仍缠在同一文件。** 脏 `main.rs` / rust `command_manifest.rs` 同时做两件事：退役 `computer_estop` + 追加 `note_document_recent`。拆不开、未进 HEAD。本页不把它写成产品已接线。

命令体在、handler 不在 HEAD：真壳 invoke 走 missing → `noteDocumentRecent()` 回 `null` → 叶停在合成空。这是登记缺口，不是「还没写查询」。

---

## 4. 无行仍合成空

无 persist 非空行、或查询/invoke 失败时：

1. `ctx.params.docId` / `note:<docId>` 仍赢（显式档）
2. 否则 recent 保持 `null`
3. resolver 第 3 档仍读 `bindWorkspacePersistedStrictDoc`（进程内夹具登记，**不是** persist 查询）
4. 否则 `strict-${wsId}` + `synthetic-unbound`

用户点工具钮走短 id `'note'` → 无显式 → 先空 → 无行则不切。H2 夹具句（打开前 apply 同一 id / URI / pre-open bind）**不**证明产品默认打开句。

---

## 5. 本页边界

- **≠** 打开完成（03 八条锁 / G-HYD 全条件未验）
- **≠** 关 EL
- **≠** 已登记 IPC（HEAD rust handler / rust manifest 未列）
- 未连 9222，未跑真壳 invoke
- 不改业务码、不碰缠文件、不提交
- 工作区脏登记 **≠** HEAD 已登记

_2026-08-18 · 第 10 轮文档追真 · HEAD=`d1cb31a` 与脏文件拆开写_
