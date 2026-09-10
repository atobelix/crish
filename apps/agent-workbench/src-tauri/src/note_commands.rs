//! Round7+ · Tauri 笔记命令面（前端 `noteApi.ts` / `noteHydrateIpc.ts` /
//! `noteMirrorIpc.ts` / `noteApplyOpsIpc.ts` IPC）
//!
//! 命令名（wire = 函数名）：
//! - `note_document_apply_md`
//! - `note_query_blocks`
//! - `note_send_to_note`
//! - `note_document_hydrate`（打开/加载投影 · 默认真 DocSession 路径）
//! - `note_document_recent`（最近一篇 persist 非空 doc_id · 读 `doc_meta`+`blocks`）
//! - `note_detect_mirror_drift`（A-INV-02 / W2-E · detect 可达前端）
//! - `note_import_mirror_proposal`（三路策略提案；**不** apply；X-05）
//! - `note_apply_ops`（CONN-B3 · collab wire JSON → DocSession::apply）
//!
//! 入参/出参 snake_case 线格式，对齐 `apps/crish-desktop/src/api/noteApi.ts`、
//! `noteHydrateIpc.ts` / `noteMirrorIpc.ts` / `noteApplyOpsIpc.ts` 与
//! `agent_tools::note_backend` 契约。
//!
//! 成功/业务失败均以 `{ ok: true|false, ... }` JSON 返回（Ok 包装），
//! 便于前端 `parseApplyOutcome` / `parseQueryOutcome` / `parseHydrateIpcOutcome` /
//! `parseDetectMirrorOutcome` / `parseImportMirrorOutcome` / `parseApplyOpsIpcOutcome`；
//! 仅 IPC 级故障走 `CoreError` reject。
//!
//! 纪律：
//! - 写路径：`apply_md_fragment` / send_to_note（intent 幂等）/
//!   **`note_apply_ops`**（collab wire → `DocSession::apply`）
//! - **不**静默流式写笔记
//! - 读路径走 store 投影；**不**默认读 MD mirror
//! - **hydrate 分轨**（禁止撒谎）：
//!   - 默认：`hydrate_path=doc-session`（`load_doc` → `DocSession::hydrate` → CDCS 树）
//!   - 旧：`hydrate_path=query-blocks`（`query_blocks` 派生索引；仅显式/回退）
//!   - `source` 仍为 IPC 通道 `tauri-ipc`（与 fixture 分轨）
//! - **mirror detect/import**：只提案、不 apply；unpushed 禁静默 DropUnacked（X-05）
//! - **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04 / EL-01 / EL-03**
//! - **≠** poll timer 双开 debounce；**≠** inotify 产品满关
//!
//! # SR-06f · 拆分门面（结构轮 · 2026-08-13-wave · ≠ 关闭任何 EL）
//!
//! 本文件为薄门面：共享失败面（`unwired_failure` / `err_outcome`）+ 测试助手
//! `apply_md_for_test` + 三模 `#[path]` 接线 + 公开符号 `pub use` 保持。
//! 实现按逻辑域拆（子模经 `super::` 引用共享面）：
//! - `note_commands_apply.rs`：写路径（apply_md / send_to_note / apply_ops）
//! - `note_commands_hydrate.rs`：投影/查询面（hydrate / query_blocks）
//! - `note_commands_mirror.rs`：mirror 面（detect / import 提案 + wire 转换）
//! - `note_commands_tests.rs`：测试旁挂（`#[cfg(test)] #[path] mod tests;`）
//!
//! 公开 API 不 break：main.rs `command_registry!` 的 `note_commands::*` 路径零改动。

#[cfg(test)]
use crate::note_runtime;
use agent_tools::note_backend::NoteBackendError;
#[cfg(test)]
use agent_tools::note_backend::{NoteApplyMdRequest, NoteApplyMdResult};
use serde_json::{json, Value as JsonValue};

// ── 共享失败面（三模共用；子模经 `super::` 引用）──────────────────────

/// 未接线时的结构化失败（对齐 noteApi `note.command_missing` 语义族）。
fn unwired_failure() -> JsonValue {
    json!({
        "ok": false,
        "code": "note.unwired",
        "reason": "note backend not wired (workspace.db 未打开 / NoteRuntime 未装配)",
    })
}

fn err_outcome(err: NoteBackendError) -> JsonValue {
    json!({
        "ok": false,
        "code": err.code(),
        "reason": err.message(),
    })
}

// ── SR-06f 拆分接线：apply / hydrate / mirror 三模（`#[path]` 显式）────

#[path = "note_commands_apply.rs"]
mod note_commands_apply;
#[path = "note_commands_document.rs"]
mod note_commands_document;
#[path = "note_commands_hydrate.rs"]
mod note_commands_hydrate;
#[path = "note_commands_mirror.rs"]
mod note_commands_mirror;

// 公开 API 保持：main.rs `command_registry!` 引用的命令路径不变
pub use note_commands_apply::{
    note_apply_ops, note_document_apply_md, note_redo_text, note_send_to_note, note_undo_text,
};
pub use note_commands_document::{
    note_document_create, note_document_delete, note_document_list, note_document_rename,
};
pub use note_commands_hydrate::{note_document_hydrate, note_document_recent, note_query_blocks};
pub use note_commands_mirror::{note_detect_mirror_drift, note_import_mirror_proposal};
// SR-06f 拆分补完：tauri 宏生成的 invoke 包装符号（`__cmd__*`）与命令名
// 常量（`__tauri_command_name_*`）随命令定义于三个子模块，`generate_handler!`
// 从注册路径（main.rs command_registry! 的 `note_commands::*`）所在模块
// 解析包装符号——门面必须透出，否则 bin 编译失败（de8e744e 欠验债，
// 此处补闭环；零逻辑改动）。
pub use note_commands_apply::{
    __cmd__note_apply_ops, __cmd__note_document_apply_md, __cmd__note_redo_text,
    __cmd__note_send_to_note, __cmd__note_undo_text, __tauri_command_name_note_apply_ops,
    __tauri_command_name_note_document_apply_md, __tauri_command_name_note_redo_text,
    __tauri_command_name_note_send_to_note, __tauri_command_name_note_undo_text,
};
pub use note_commands_document::{
    __cmd__note_document_create, __cmd__note_document_delete, __cmd__note_document_list,
    __cmd__note_document_rename, __tauri_command_name_note_document_create,
    __tauri_command_name_note_document_delete, __tauri_command_name_note_document_list,
    __tauri_command_name_note_document_rename,
};
pub use note_commands_hydrate::{
    __cmd__note_document_hydrate, __cmd__note_document_recent, __cmd__note_query_blocks,
    __tauri_command_name_note_document_hydrate, __tauri_command_name_note_document_recent,
    __tauri_command_name_note_query_blocks,
};
pub use note_commands_mirror::{
    __cmd__note_detect_mirror_drift, __cmd__note_import_mirror_proposal,
    __tauri_command_name_note_detect_mirror_drift,
    __tauri_command_name_note_import_mirror_proposal,
};

/// 命令层同步 smoke 助手（测试 / 非 Tauri 路径）：apply 后返回结果。
#[cfg(test)]
pub(crate) async fn apply_md_for_test(
    req: NoteApplyMdRequest,
) -> Result<NoteApplyMdResult, NoteBackendError> {
    let backend = note_runtime::try_backend().ok_or(NoteBackendError::Unwired)?;
    backend.apply_md_fragment(req).await
}

// 测试外置旁挂（父模接线；用例形状与拆分前一致，零删除）
#[cfg(test)]
#[path = "note_commands_tests.rs"]
mod tests;
