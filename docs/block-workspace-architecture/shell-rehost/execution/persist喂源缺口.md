# persist 喂源缺口

| 元数据 | 值 |
| --- | --- |
| **定位** | 产品 note 叶「最近一篇 persist」查询源。本页只记现码与未交付面，不关 EL、不宣称打开完成 |
| **日期** | 2026-08-18（第 14 轮：`fe40934f` 已登 rust handler） |
| **HEAD** | `fe40934f`（登记进 HEAD；指针可能被并行 reference 提交往前推） |
| **活码（HEAD 已有）** | 查询 + 命令体 + 前端 + 叶先空后切 + **rust `generate_handler` / rust manifest / workbench registry** |
| **结论** | handler **已进 HEAD**。无 persist 行 / 非 Tauri / 未重建壳仍合成空。**≠ 打开完成 ≠ 关 EL** |
| **EL** | 仍 **0/10**。本页零权限关 EL |

---

## 0. 已有 / 未交（先拆开）

| 侧 | 状态 | 证据 |
| --- | --- | --- |
| **已有（进 HEAD）** | store 查询、命令体、前端契约/API、叶先空后切、前端 TS 清单、**rust `generate_handler` / rust manifest / workbench registry** | `20aeb2f4` / `65c89850` / `commandManifest.ts:208` / **`fe40934f`** |
| **未交** | 真壳重建 + 有 persist 行 + 9222 像素 | 登记 ≠ 打开完成。工作区脏文件仍可能同时删 `computer_estop` / 改 computer_slot——那是 computer 战役，**不要**再当 persist 未交 |
| **仍否** | 打开完成；关 EL | 合成空成功 ≠ G-HYD。EL 仍 0/10 |

---

## 1. 总判

产品点「打开笔记」（`openToolInSession(sid, 'note')`，无 `params.docId` / 无 `note:<id>`）→ `NoteLeafHost` **先**以 `recent=null` 走 resolver（无 pre-open bind 则合成 `strict-${wsId}`）→ `useEffect` 调 `loadRecentPersistedDocId()` → `noteDocumentRecent()` invoke `note_document_recent`。

- 查到非空 `doc_id` → 再切 `binding: 'recent-persisted'`。
- 失败 / 非 Tauri / 命令缺失 / 无行 → 保持 `null` → **仍合成空**。

**合成空成功 ≠ 打开完成。** 有 Tauri 仍可标 `tauri-ipc` + 0 块；无 Tauri 仍 `fixture`。两边都不是 G-HYD 产品句。

HEAD rust `generate_handler` / rust `command_manifest` **已列** `note_document_recent`（`fe40934f`）。未重建的旧进程仍可能 missing；无行 / 非 Tauri / invoke 失败仍 `null` → 叶停在合成空。

旧页写「全仓无 list / recent 命令、`recentPersistedDocId` 恒 null、禁止编 IPC」——对照 **HEAD 已入库的查询/命令体/前端/handler** **已过时**。更旧半句「命令体在、handler 不在 HEAD」只对到 `34551356` 旧对照，**现时态已过时**（`fe40934f` 已登）。查询在既有 `doc_meta`+`blocks` / `note_document_*` 面上，不是平行账本。

---

## 2. 已落（HEAD 已有 · 不是脏文件）

下列面由提交进 `d1cb31a` 祖先，**现时态仍在 HEAD**（`fe40934f` 另登 handler）。§3 下表是 `34551356` **旧对照**，不是当前缺口。

| 面 | HEAD 证据 | 做什么 |
| --- | --- | --- |
| store 现表查询 | `20aeb2f4` `crates/conex-workspace-store/src/lib.rs` `recent_persisted_nonempty_doc_id`（现码 `:249`） | `doc_meta.rev > 0` 且 `blocks.plain_text` 去空白后非空；`ORDER BY updated_at DESC, rev DESC, doc_id DESC LIMIT 1`。无命中 → `None`。库即工作区（表无 workspace 列） |
| 命令体 | `65c89850` `note_commands_hydrate.rs` `note_document_recent`（现码 `:130`）；`note_commands.rs` re-export。该提交说明自钉当时 **未**登记 `generate_handler`（**旧对照**；现时态由 `fe40934f` 已登） | `#[tauri::command]`；`try_store_backend` → `spawn_blocking` 调上面查询；`{ ok:true, doc_id }` 或失败 outcome。无命中 `doc_id=null` |
| 前端契约 | `noteApiContracts.ts` `NOTE_CMD_DOCUMENT_RECENT = 'note_document_recent'`（`:32`） | 命令名常量。源码注释仍写「未登记时真壳走 missing」——那是旧对照；现时态 `fe40934f` 已登 |
| 前端 API | `noteApi.ts` `noteDocumentRecent`（`:353`） | 非 Tauri / invoke 非 ok / `ok:false` / 空 id → `null`。不抛、不编假 id |
| 叶喂口 | `productLeafBindings.ts` `loadRecentPersistedDocId` = `noteDocumentRecent()`（`:58`） | resolver 第 2 档 `recentPersistedDocId` |
| 叶时序 | `NoteLeafHost.tsx` `useState(null)` + `useEffect` 再 `setRecent`（`:28-43`） | **先合成空再切**。显式 `params.docId` / `note:<id>` 不查 recent。`22d02f82` 只搬家到扩展，时序未改 |
| 前端 TS 清单 | `apps/crish-desktop/src/api/transport/commandManifest.ts` `:208` | HEAD **已列** `note_document_recent`。现时态 rust `generate_handler` **也已列**（`fe40934f`）。旧半句「前端列名 ≠ rust handler」只对到 `34551356` |

`d1cb31a`（第 9 轮收口）到 `34551356`（第 10 轮收口）之间（**旧对照**，不是现时态缺口）只有：

- `25691767` `test(workspace): drop duplicate EmptyState CTA detect paths`
- `34551356` `docs(shell-rehost): land round-9 audit and round-10 close`（`COMMIT_EDITMSG` 自钉「persist handler 仍未进 HEAD」——当时为真）

该窗口 **没有** rust persist 登记提交。`COMMIT_MSG_R9A`–`R9C` 与当时 `COMMIT_EDITMSG` 都不提把 `generate_handler` / rust `command_manifest` 并入。现时态登记在更后的 `fe40934f`。

优先级（`resolveProductStrictDocId` / `resolveNotePaperDoc`）未改：显式 → recent persist → pre-open bind → `strict-${wsId}` + `synthetic-unbound`。**从不**默认 `docId === ctx.sessionId`。

---

## 3. 登记已进 HEAD（第 14 轮）

`fe40934f` 只把 `note_document_recent` 加进 rust `command_registry!` / rust manifest / workbench registry，**留下** `computer_estop`，**没有** computer_slot 重写。提交后工作区那批脏文件已还回 computer 战役。

对照 **更早 HEAD=`34551356`** 的「未登记」叙述下面留作历史。**不要把工作区脏文件当未交 persist。**

以下 `git show` / 表是 **`34551356` 旧对照**，只说明当时「未登记 + 脏文件同时删 estop」。**不是现时态缺口。** 现时态：`fe40934f` 已登 `note_document_recent`，且 **留下** `computer_estop`。下一刀不是再登、不是等拆 estop 才算 persist 交付。

旧对照复核（当时读 `.git/refs/heads/refactor/architecture` 得 `34551356`；`.git/logs/HEAD` 走 `d1cb31a..34551356`；当时工作区对照 `apps/agent-workbench/src-tauri/src/main.rs`）：

- 入库树：`d1cb31a..34551356` **不碰** `main.rs` / rust `command_manifest.rs`。笔记段在 **当时 HEAD** 是 `note_document_hydrate` 后接 `note_detect_mirror_drift`，**无** `note_document_recent`。
- 当时 `.git/logs/HEAD` 对字面 `note_document_recent` 只指向命令体 `65c89850`，其后无 handler 登记提交（现时态其后有 `fe40934f`）。
- 第 6 / 7 轮审计对当时 HEAD 的 `git grep note_document_recent HEAD -- …/main.rs` 与 `…/command_manifest.rs` **空**；后续到 `34551356` 无反证提交。
- 第 10 轮收口文（`00-索引.md`）当时写「handler **仍未进 HEAD**，仍缠 `computer_estop`」（旧对照）。
- **当时**工作区脏文件已写 recent + 删了 `computer_estop`。那批脏文件后来还回 computer 战役，**不得再当 persist 未交**。

| 登记面 | **旧对照** HEAD `34551356` | **旧对照**当时工作区脏文件（当时不当交付） |
| --- | --- | --- |
| `apps/agent-workbench/src-tauri/src/main.rs` `command_registry!` → `generate_handler!` | 当时笔记段到 `note_document_hydrate` 后接 `note_detect_mirror_drift`。**无** `note_document_recent`。电脑段仍有 `computer_estop` | 当时写入 `"note_document_recent"` + `note_commands::note_document_recent`（当时脏文件 `:438-440`）。**同一表**里 `computer_estop` 字面已删（电脑段只剩 enable/disable/status） |
| rust `command_manifest.rs` | 当时 **无** `note_document_recent`。仍登记 `computer_estop`；总数口径 124 **不含** recent | 当时已加 `entry("note_document_recent", …)`（`:235`）。`computer_estop` **无 entry**。注释仍写「computer_estop 退役后 123；追加后 124」（`:71` / `:287` / `:299`） |
| workbench `tauri-command-registry.ts` | 当时 HEAD `note_*` **无** recent | 当时工作区已加 `note_document_recent`（`:598`）。测注释把「estop 退役 124→123」与「recent 123→124」绑在一起 |

**旧对照结论（当时）：** 脏 `main.rs` / rust `command_manifest.rs` 同时做两件事：退役 `computer_estop` + 追加 `note_document_recent`。当时拆不开、未进 HEAD。

**现时态：** `fe40934f` 已登 `note_document_recent`。rust **仍留** `computer_estop`（这不是 persist 未交）。未重建的旧进程仍可能 missing；无行 / 非 Tauri / invoke 失败仍 `null` → 叶停在合成空。下一刀不是再登、不是等拆 estop 才算 persist 交付。

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
- **≠** 关 EL（仍 0/10）
- **已登记** IPC（`fe40934f` 已登 rust handler / rust manifest / workbench registry）。下一刀不是再登
- rust **仍留** `computer_estop`（不是 persist 未交；不要等拆 estop 才算 persist 交付）
- 未连 9222，未跑真壳 invoke（未交：真壳重建 / 有 persist 行 / 9222 像素）
- 不改业务码、不碰 computer 战役脏文件、不提交

_2026-08-18 · 第 14 轮现时态订正 · `fe40934f` 已登 · `34551356` 表只当历史 · EL 仍 0/10_
