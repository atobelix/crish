//! G03 产出根两级配置与清理（T-EG-12）：路径隔离 + 校验
//!
//! 两级配置（REQ-EG-现状分析.md 6.4-6.5 草案）：
//! - **会话级**：session_meta `"{session_id}:output_root"`（可覆盖，
//!   resolve_output_dir 下次调用生效，G01 工具侧消费）；
//! - **默认值**：`<workspace_root>/.agent-outputs`。
//!
//! 优先级：会话级 > 默认值。
//!
//! RUN-10 退役登记（2026-10-21 死代码清零）：全局级 OutputsRootConfig
//! 托管状态**物理切除**——其配置命令（`config_get/set_outputs_root` 等）
//! 已于 2026-09-15 退役且前端 `agentOutputsRoot` 设置面不存在，托管态
//! 永不可写（`try_state` 恒 None 兜底），属「已实现但永远不调用」的死代码。
//! 产出根**解析能力**（[resolve_outputs_root]）保留：清理链与工具侧消费。
//!
//! 校验红线：产出根必须仍在 workspace_root 内（`path_is_same_or_child`
//! 语义，fs_commands/types.rs:252；对齐 agent-tools tools/mod.rs:392
//! `path_within_root`），`allowOutputsOutsideWorkspace=false` 为不可覆盖的
//! 安全默认（REQ-EG-现状分析.md:701）。
//!
//! 会话删除清理（任务书 T-EG-12 第 3 项 + RUN-07 生产接线）：删除会话 →
//! 读取 session_meta 产出目录 → `.agent-outputs/<session_id>` 走 conex-fs
//! trash 删除接管（trash.rs:26-29 铁律，不直接 remove）→ 通知用户（清理
//! 结果 + 回收站位置）。链路入口 [cleanup_session_outputs]
//! （session_commands::cleanup_orphan_sessions 生产调用）。

use std::path::{Component, Path, PathBuf};

use conex_types::CoreError;

/// 默认产出根目录名（对齐 REQ-G03：`<workspace_root>/.agent-outputs/`）
pub(crate) const DEFAULT_OUTPUTS_DIR_NAME: &str = ".agent-outputs";

/// 会话级最终产出目录键（`{session_id}:output_dir`，G01 首次 resolve 落键）
///
/// T-F 06 退役登记：仅随 delete_session 清理链使用（测试直调保留），
/// 与命令一同保留待存储架构裁决后恢复。
pub(crate) const SESSION_META_KEY_OUTPUT_DIR: &str = "output_dir";
pub(crate) const SESSION_META_KEY_OUTPUT_ROOT: &str = "output_root"; // 会话级产出根覆盖键

/// 会话级键编码（`{session_id}:{key}`；空 session_id 退化字面键，
/// 对齐 explore_quota.rs:43-49 的 S7 接线模式）
pub(crate) fn session_meta_key_of(session_id: &str, key: &str) -> String {
    if session_id.is_empty() {
        key.to_string()
    } else {
        format!("{session_id}:{key}")
    }
}

/// 解析产出根（纯函数，可独立单测；G03 校验唯一实现）：
/// 1. 未配置（或空串）→ `<workspace_root>/.agent-outputs`（G03 默认约定）；
/// 2. 相对配置 → `workspace_root.join(configured)`，且仅允许普通路径组件
///    （`..` / 前缀 / 根等一律拒绝，防逃逸）；
/// 3. 绝对配置 → 仅当 `allow_outputs_outside_workspace = true` 或位于
///    工作区根内（`path_is_same_or_child`，对齐 tools/mod.rs:392）时放行。
///
/// 失败返回可读中文错误（上层映射为 InvalidInput）。
pub(crate) fn resolve_outputs_root(
    configured: Option<&Path>,
    workspace_root: &Path,
    allow_outputs_outside_workspace: bool,
) -> Result<PathBuf, String> {
    let Some(configured) = configured.filter(|p| !p.as_os_str().is_empty()) else {
        return Ok(workspace_root.join(DEFAULT_OUTPUTS_DIR_NAME));
    };
    if !configured.is_absolute() {
        // 相对路径：仅放行普通组件（`..`/`.`/根/盘符前缀一律拒绝）
        for comp in configured.components() {
            if !matches!(comp, Component::Normal(_)) {
                return Err(format!("产出根含非法路径组件：{}", configured.display()));
            }
        }
        return Ok(workspace_root.join(configured));
    }
    if allow_outputs_outside_workspace
        || crate::fs_commands::types::path_is_same_or_child(configured, workspace_root)
    {
        return Ok(configured.to_path_buf());
    }
    Err(format!(
        "产出根必须位于工作区内（allowOutputsOutsideWorkspace=false）：{}",
        configured.display()
    ))
}

/// 会话删除清理结果（T-EG-12：清理通知载荷）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionOutputsCleanup {
    /// 是否清理了产出目录（false = 未发现产出目录，或越界被安全跳过）
    pub cleaned: bool,
    /// 已移入回收站的产出目录清单（绝对路径，按路径排序）
    pub trashed_dirs: Vec<String>,
    /// 产出根或产出目录目标越界被安全跳过（安全红线：不清理工作区外内容）
    pub skipped_outside: bool,
    /// 回收站根位置（清理兜底根，供用户恢复入口）
    pub trash_root: String,
    /// 通知文案（清理结果 + 回收站位置，供前端展示）
    pub notice: String,
}

/// 会话删除清理入口（RUN-07 生产接线：session_commands::cleanup_orphan_sessions
/// 调用；AppHandle 依赖面）
///
/// 链路（任务书 T-EG-12 第 3 项）：
/// 删除会话 → 库层删除事务捕获 session_meta 产出目录 →
/// `.agent-outputs/<session_id>` 走 conex-fs trash 删除接管（trash.rs:26-29
/// 铁律，不直接 remove）→ 通知用户（清理结果 + 回收站位置）。
pub(crate) fn cleanup_session_outputs(
    app: &tauri::AppHandle,
    session_id: &str,
    output_dir_meta: Option<&str>,
    output_root_meta: Option<&str>,
) -> Result<SessionOutputsCleanup, CoreError> {
    let trash_root = crate::run_ipc::trash_root_for(app)?;
    let guard = crate::workspace::resolve_guard(app, "").map_err(|e| {
        CoreError::Internal(format!(
            "工作区不可用（产出目录清理）：{}: {}",
            e.code, e.message
        ))
    })?;
    // RUN-10：全局产出根托管态已切除（配置命令退役、前端设置面不存在），
    // 清理链恒用默认解析（会话级 meta 覆盖仍生效）+ 工作区内安全限制。
    Ok(cleanup_session_outputs_at(
        &trash_root,
        guard.root(),
        session_id,
        output_dir_meta,
        output_root_meta,
        None,
        false,
    ))
}

/// 清理纯函数核心（全参数注入，单测直测；对齐 trash_list_at 先例）
///
/// 目标收集规则：
/// 1. **精确命中**：session_meta `{session_id}:output_dir`（G01 首次 resolve
///    落键）指向的目录存在 → trash（相对/绝对路径同口径先过工作区校验：
///    相对基于工作区根解析 + 词法展开 `..`，防 meta 逃逸）；
/// 2. **根下扫描兜底**：按产出根（会话级覆盖 > 全局 > 默认 `.agent-outputs`）
///    扫描，目录名 == `session_id` 或以 `-{session_id}` 结尾（日期前缀命名，
///    调研-可视化与扩展点.md §4.2）→ 逐个 trash；
/// 3. 产出根越界（校验失败）→ 跳过清理并在 notice 说明（安全红线）。
pub(crate) fn cleanup_session_outputs_at(
    trash_root: &Path,
    workspace_root: &Path,
    session_id: &str,
    output_dir_meta: Option<&str>,
    output_root_meta: Option<&str>,
    global_root: Option<&Path>,
    allow_outputs_outside_workspace: bool,
) -> SessionOutputsCleanup {
    let trash_root_str = trash_root.to_string_lossy().into_owned();
    // 产出根解析（会话级 > 全局 > 默认；越界 = 安全红线，跳过清理）
    let configured_root = output_root_meta
        .map(Path::new)
        .filter(|p| !p.as_os_str().is_empty())
        .or(global_root);
    let outputs_root = match resolve_outputs_root(
        configured_root,
        workspace_root,
        allow_outputs_outside_workspace,
    ) {
        Ok(root) => root,
        Err(err) => {
            tracing::warn!(
                target: "outputs",
                session_id,
                error = %err,
                "会话删除：产出根越界，跳过清理（安全红线）"
            );
            return SessionOutputsCleanup {
                cleaned: false,
                trashed_dirs: Vec::new(),
                skipped_outside: true,
                trash_root: trash_root_str.clone(),
                notice: format!(
                    "会话产出根配置越界（{err}），已跳过清理（安全红线）；回收站位置：{trash_root_str}"
                ),
            };
        }
    };
    // 目标收集：output_dir 精确命中（相对/绝对同口径先校验，防 session_meta 逃逸）
    let mut targets: Vec<PathBuf> = Vec::new();
    let mut skipped_targets: Vec<String> = Vec::new();
    if let Some(dir) = output_dir_meta.filter(|d| !d.trim().is_empty()) {
        let p = Path::new(dir);
        // 相对路径：基于工作区根解析并词法展开 `..`/`.`（复用
        // fs_commands/types.rs lexically_normalize）后，与绝对分支同口径
        // 过包含性校验（F5-02：相对分支原先零校验直接 join，`..` 可逃逸）
        let resolved = if p.is_absolute() {
            p.to_path_buf()
        } else {
            crate::fs_commands::types::lexically_normalize(&workspace_root.join(p))
        };
        if allow_outputs_outside_workspace
            || crate::fs_commands::types::path_is_same_or_child(&resolved, workspace_root)
        {
            targets.push(resolved);
        } else {
            skipped_targets.push(resolved.to_string_lossy().into_owned());
        }
    }
    // 根下扫描兜底（日期前缀命名 `<YYYY-MM-DD>-<session_id>` / 纯 `<session_id>`）
    let dir_suffix = format!("-{session_id}");
    if let Ok(entries) = std::fs::read_dir(&outputs_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if (name == session_id || name.ends_with(&dir_suffix)) && entry.path().is_dir() {
                targets.push(entry.path());
            }
        }
    }
    targets.sort();
    targets.dedup();
    // trash 删除接管（trash.rs:26-29 铁律：删除唯一物理删除点）
    let service = conex_fs::trash::TrashService::new(trash_root);
    let mut trashed: Vec<String> = Vec::new();
    for target in &targets {
        if !target.exists() {
            continue;
        }
        match service.trash_file(target, false) {
            Ok(_) => trashed.push(target.to_string_lossy().into_owned()),
            Err(e) => {
                tracing::warn!(
                    target: "outputs",
                    session_id,
                    path = %target.display(),
                    error = %e,
                    "会话产出目录进回收站失败"
                );
            }
        }
    }
    let mut notice_parts: Vec<String> = Vec::new();
    if !trashed.is_empty() {
        notice_parts.push(format!(
            "已将会话产出目录 {} 个移入回收站（{}）",
            trashed.len(),
            trashed.join("、")
        ));
    } else if skipped_targets.is_empty() {
        notice_parts.push("未发现会话产出目录，无需清理".to_string());
    }
    if !skipped_targets.is_empty() {
        notice_parts.push(format!(
            "产出目录配置越界（{}），已跳过清理（安全红线）",
            skipped_targets.join("、")
        ));
    }
    let notice = format!("{}；回收站位置：{trash_root_str}", notice_parts.join("；"));
    tracing::info!(
        target: "outputs",
        session_id,
        cleaned = trashed.len(),
        "会话删除：产出目录清理完成（trash 接管）"
    );
    SessionOutputsCleanup {
        cleaned: !trashed.is_empty(),
        trashed_dirs: trashed,
        skipped_outside: !skipped_targets.is_empty(),
        trash_root: trash_root_str,
        notice,
    }
}

#[cfg(test)]
mod tests;
