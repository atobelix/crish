//! outputs_config 测试（outputs_config.rs 拆分）：产出根解析与删除清理。

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
    // Unix 绝对路径由 resolve_rejects_outside_root_unless_allowed 覆盖；
    // 此处仅验证相对路径的 ParentDir 逃逸（跨平台一致）
    for evil in ["../evil", "a/../../b"] {
        let err = resolve_outputs_root(Some(Path::new(evil)), ws.path(), false).unwrap_err();
        assert!(
            err.contains("非法路径组件"),
            "{evil} 应因非法组件被拒：{err}"
        );
    }
    // Windows 绝对路径（盘符前缀）→ 走工作区内校验拒绝
    #[cfg(windows)]
    {
        let err = resolve_outputs_root(Some(Path::new("C:\\x")), ws.path(), false).unwrap_err();
        assert!(err.contains("工作区内"), "C:\\x 应因工作区外被拒：{err}");
    }
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

    let result = cleanup_session_outputs_at(trash.path(), ws.path(), "s1", None, None, None, false);
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
    let result =
        cleanup_session_outputs_at(trash.path(), ws.path(), "s1", Some(&rel), None, None, false);
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
