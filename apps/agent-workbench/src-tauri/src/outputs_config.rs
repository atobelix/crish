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
/// 会话级产出根覆盖键（`{session_id}:output_root`，G03 会话级配置）
pub(crate) const SESSION_META_KEY_OUTPUT_ROOT: &str = "output_root";

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
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 测试用临时目录（独立命名，drop 自动清理）
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "conex_outputs_cfg_{prefix}_{}_{seq}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.0.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&p, content).unwrap();
            p
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // ── 配置解析（resolve_outputs_root）──

    #[test]
    fn resolve_defaults_to_dot_agent_outputs() {
        let ws = TempDir::new("ws");
        let root = resolve_outputs_root(None, ws.path(), false).unwrap();
        assert_eq!(root, ws.0.join(DEFAULT_OUTPUTS_DIR_NAME));
        // 空串等价未配置
        let root2 = resolve_outputs_root(Some(Path::new("")), ws.path(), false).unwrap();
        assert_eq!(root2, ws.0.join(DEFAULT_OUTPUTS_DIR_NAME));
    }

    #[test]
    fn resolve_relative_root_joins_workspace() {
        let ws = TempDir::new("ws");
        let root =
            resolve_outputs_root(Some(Path::new("docs/.agent-outputs")), ws.path(), false).unwrap();
        assert_eq!(root, ws.0.join("docs/.agent-outputs"));
    }

    #[test]
    fn resolve_absolute_root_inside_workspace_allowed() {
        let ws = TempDir::new("ws");
        let inside = ws.write("sub", "");
        let root = resolve_outputs_root(Some(&inside), ws.path(), false).unwrap();
        assert_eq!(root, inside);
    }

    #[test]
    fn resolve_rejects_outside_root_unless_allowed() {
        let ws = TempDir::new("ws");
        let outside = TempDir::new("outside");
        // 安全红线：默认拒绝工作区外产出根
        let err = resolve_outputs_root(Some(outside.path()), ws.path(), false).unwrap_err();
        assert!(err.contains("工作区内"), "错误文案应说明工作区限制：{err}");
        // 显式放行（allowOutputsOutsideWorkspace=true）
        let ok = resolve_outputs_root(Some(outside.path()), ws.path(), true).unwrap();
        assert_eq!(ok, outside.0);
    }

    #[test]
    fn resolve_rejects_parent_traversal_components() {
        let ws = TempDir::new("ws");
        // 相对路径含逃逸/根组件 → 非法组件拒绝
        for evil in ["../evil", "a/../../b", "/abs"] {
            let err = resolve_outputs_root(Some(Path::new(evil)), ws.path(), false).unwrap_err();
            assert!(
                err.contains("非法路径组件"),
                "{evil} 应因非法组件被拒：{err}"
            );
        }
        // Windows 绝对路径（盘符前缀）→ 走工作区内校验拒绝
        let err = resolve_outputs_root(Some(Path::new("C:\\x")), ws.path(), false).unwrap_err();
        assert!(err.contains("工作区内"), "C:\\x 应因工作区外被拒：{err}");
    }

    // ── 会话级键编码 ──

    #[test]
    fn session_meta_key_encodes_with_colon() {
        assert_eq!(
            session_meta_key_of("s1", SESSION_META_KEY_OUTPUT_ROOT),
            "s1:output_root"
        );
        assert_eq!(
            session_meta_key_of("s1", SESSION_META_KEY_OUTPUT_DIR),
            "s1:output_dir"
        );
        assert_eq!(session_meta_key_of("", "output_root"), "output_root");
    }

    // ── 会话删除清理（cleanup_session_outputs_at）──

    /// 构造回收站与产出目录场景，返回 (trash, ws)
    fn cleanup_fixture() -> (TempDir, TempDir) {
        (TempDir::new("trash"), TempDir::new("ws"))
    }

    #[test]
    fn cleanup_trashes_output_dir_meta_target() {
        let (trash, ws) = cleanup_fixture();
        // G01 落键的精确产出目录
        let out_dir = ws.0.join(".agent-outputs/2026-08-05-s1");
        std::fs::create_dir_all(out_dir.join("sub")).unwrap();
        std::fs::write(out_dir.join("sub/a.md"), "x").unwrap();

        let result = cleanup_session_outputs_at(
            trash.path(),
            ws.path(),
            "s1",
            Some(out_dir.to_str().unwrap()),
            None,
            None,
            false,
        );
        assert!(result.cleaned, "notice: {}", result.notice);
        assert_eq!(
            result.trashed_dirs,
            vec![out_dir.to_string_lossy().into_owned()]
        );
        assert!(!result.skipped_outside);
        assert!(!out_dir.exists(), "删除后产出目录应消失");
        assert!(result.notice.contains("回收站位置"));
        // trash 注册断言：条目可见、类型为目录、原路径 = 产出目录
        let service = conex_fs::trash::TrashService::new(trash.path());
        let entries = service.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original_path, out_dir);
        assert_eq!(entries[0].kind, conex_fs::trash::TrashKind::Dir);
    }

    #[test]
    fn cleanup_scans_output_root_for_session_dirs() {
        let (trash, ws) = cleanup_fixture();
        // 无 output_dir 落键：按默认根扫描日期前缀目录
        let out_root = ws.0.join(".agent-outputs");
        let d1 = out_root.join("2026-08-04-s1");
        let d2 = out_root.join("2026-08-05-s1");
        let other = out_root.join("2026-08-05-s2");
        for d in [&d1, &d2, &other] {
            std::fs::create_dir_all(d).unwrap();
        }

        let result =
            cleanup_session_outputs_at(trash.path(), ws.path(), "s1", None, None, None, false);
        assert!(result.cleaned);
        assert_eq!(result.trashed_dirs.len(), 2, "s1 两个日期目录都进回收站");
        assert!(!d1.exists() && !d2.exists());
        assert!(other.exists(), "其它会话目录不受影响");
        assert_eq!(
            conex_fs::trash::TrashService::new(trash.path())
                .list()
                .len(),
            2
        );
    }

    #[test]
    fn cleanup_respects_session_root_override() {
        let (trash, ws) = cleanup_fixture();
        // 会话级覆盖根：自定义产出根下的目录
        let custom = ws.0.join("docs/custom-outputs");
        let dir = custom.join("2026-08-05-s1");
        std::fs::create_dir_all(&dir).unwrap();

        let result = cleanup_session_outputs_at(
            trash.path(),
            ws.path(),
            "s1",
            None,
            Some("docs/custom-outputs"),
            None,
            false,
        );
        assert!(result.cleaned);
        assert!(!dir.exists(), "覆盖根下的会话目录应进回收站");
        assert_eq!(
            conex_fs::trash::TrashService::new(trash.path())
                .list()
                .len(),
            1
        );
    }

    #[test]
    fn cleanup_skips_outside_root_without_trashing() {
        let (trash, ws) = cleanup_fixture();
        // 会话级覆盖根越界（安全红线）→ 跳过清理，不 trash 任何内容
        let outside = TempDir::new("outside");
        let result = cleanup_session_outputs_at(
            trash.path(),
            ws.path(),
            "s1",
            None,
            Some(outside.path().to_str().unwrap()),
            None,
            false,
        );
        assert!(!result.cleaned);
        assert!(result.skipped_outside, "越界应标记安全跳过");
        assert!(result.notice.contains("已跳过清理"));
        assert!(
            conex_fs::trash::TrashService::new(trash.path())
                .list()
                .is_empty(),
            "越界跳过时不得产生回收站条目"
        );
    }

    #[test]
    fn cleanup_no_outputs_is_clean_noop() {
        let (trash, ws) = cleanup_fixture();
        let result =
            cleanup_session_outputs_at(trash.path(), ws.path(), "ghost", None, None, None, false);
        assert!(!result.cleaned);
        assert!(!result.skipped_outside);
        assert!(result.trashed_dirs.is_empty());
        assert!(result.notice.contains("未发现会话产出目录"));
        assert!(result.notice.contains("回收站位置"));
        assert!(conex_fs::trash::TrashService::new(trash.path())
            .list()
            .is_empty());
    }

    #[test]
    fn cleanup_meta_target_outside_workspace_is_ignored() {
        let (trash, ws) = cleanup_fixture();
        // session_meta output_dir 被篡改为工作区外路径 → 拒绝清理（防逃逸）
        let outside = TempDir::new("outside");
        std::fs::create_dir_all(outside.0.join("sub")).unwrap();
        let result = cleanup_session_outputs_at(
            trash.path(),
            ws.path(),
            "s1",
            Some(outside.path().to_str().unwrap()),
            None,
            None,
            false,
        );
        assert!(!result.cleaned, "工作区外 meta 目标不得清理");
        assert!(outside.0.exists(), "工作区外目录必须原样保留");
        assert!(conex_fs::trash::TrashService::new(trash.path())
            .list()
            .is_empty());
    }

    #[test]
    fn cleanup_meta_relative_traversal_skipped() {
        let (trash, ws) = cleanup_fixture();
        // session_meta output_dir 相对路径含 `..` 逃逸（F5-02 缺口：相对分支
        // 零校验直接 join，`..` 可越出工作区根）→ 拒绝清理，与绝对分支同口径
        let outside = TempDir::new("outside");
        let victim = outside.0.join("Documents/x");
        std::fs::create_dir_all(&victim).unwrap();
        // ws 与 outside 同处 temp_dir：一级 `..` 即越出工作区根
        let rel_escape = format!(
            "../{}/Documents/x",
            outside.0.file_name().unwrap().to_string_lossy()
        );
        let result = cleanup_session_outputs_at(
            trash.path(),
            ws.path(),
            "s1",
            Some(&rel_escape),
            None,
            None,
            false,
        );
        assert!(!result.cleaned, "相对逃逸 meta 目标不得清理");
        assert!(victim.exists(), "工作区外目录必须原样保留");
        assert!(result.skipped_outside, "相对逃逸应标记安全跳过");
        assert!(
            result.notice.contains("已跳过清理"),
            "notice: {}",
            result.notice
        );
        assert!(
            conex_fs::trash::TrashService::new(trash.path())
                .list()
                .is_empty(),
            "相对逃逸目标不得进回收站"
        );
    }

    #[test]
    fn cleanup_meta_relative_target_inside_workspace_trashed() {
        let (trash, ws) = cleanup_fixture();
        // 相对路径正常形态（G01 落键相对值）：基于工作区根解析后正常 trash
        let out_dir = ws.0.join(".agent-outputs/2026-08-05-s1");
        std::fs::create_dir_all(out_dir.join("sub")).unwrap();
        let rel = out_dir
            .strip_prefix(ws.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let result = cleanup_session_outputs_at(
            trash.path(),
            ws.path(),
            "s1",
            Some(&rel),
            None,
            None,
            false,
        );
        assert!(result.cleaned, "notice: {}", result.notice);
        assert_eq!(result.trashed_dirs.len(), 1);
        assert_eq!(
            Path::new(&result.trashed_dirs[0]),
            &out_dir,
            "工作区内相对目标按工作区根解析后进回收站"
        );
        assert!(!out_dir.exists(), "工作区内相对目标应进回收站");
        assert!(!result.skipped_outside);
        assert!(
            conex_fs::trash::TrashService::new(trash.path())
                .list()
                .len()
                == 1
        );
    }
}
