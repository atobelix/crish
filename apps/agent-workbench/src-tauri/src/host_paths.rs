use std::{
    env,
    path::{Path, PathBuf},
};

/// Tauri 应用标识（与 tauri.conf.json `identifier` 一致；RUN-05 数据目录锚点）。
pub(crate) const APP_IDENTIFIER: &str = "io.github.conex-community.crish";

/// 迁移标记文件名（RUN-05：旧 exe 目录数据一次性迁入 app data dir 后落此标记，
/// 重复启动不再重复迁移）。
pub(crate) const LEGACY_MIGRATION_MARKER: &str = ".legacy-data-migrated";

/// release 形态的应用数据目录（RUN-05）：
/// - Windows: `%APPDATA%/<identifier>`
/// - macOS: `~/Library/Application Support/<identifier>`
/// - Linux: `$XDG_DATA_HOME/<identifier>`（缺省 `~/.local/share/<identifier>`）
///
/// 与 Tauri v2 `app.path().app_data_dir()` 的平台口径一致（dirs::data_dir），
/// 此处提前手算是因为 `app_dir()` 在 Tauri Builder 装配之前就要用（tracing
/// 初始化 / db_setup / auth / workspace 等十余个消费点，无 AppHandle 可依赖）。
pub(crate) fn release_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER))
}

/// 旧 release 形态的数据根（RUN-05 迁移源）：历史版本把 DB/日志/工作区放在
/// exe 所在目录——安装到 `Program Files` 时该目录不可写，且随版本升级残留
/// 用户数据。迁移后仅作为只读迁移源使用。
fn legacy_exe_dir() -> Option<PathBuf> {
    let exe_path = env::current_exe().ok()?;
    exe_path.parent().map(Path::to_path_buf)
}

pub(crate) fn app_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(parent) = manifest_dir.parent() {
            if parent.join("package.json").exists() {
                let repo_root = parent.parent().unwrap_or(parent);
                if let Ok(exe_path) = env::current_exe() {
                    if exe_path.starts_with(repo_root) {
                        return Ok(parent.to_path_buf());
                    }
                } else {
                    return Ok(parent.to_path_buf());
                }
            }
        }

        if let Ok(cwd) = env::current_dir() {
            if let Some(dir) = find_agent_workbench_dir(&cwd) {
                return Ok(dir);
            }
        }
    }

    // RUN-05：release 用平台标准 app data dir（原 exe 目录不可写，尤其
    // `Program Files` 场景）。data dir 不可得的极端环境按原兜底链退化：
    // exe 目录 → cwd。
    if let Some(data_dir) = release_data_dir() {
        return Ok(data_dir);
    }

    if let Some(exe_dir) = legacy_exe_dir() {
        return Ok(exe_dir);
    }

    env::current_dir().map_err(|e| e.to_string())
}

pub(crate) fn workspace_root(app_dir: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        if let Some(ws) = app_dir.parent().and_then(Path::parent) {
            if ws.join("package.json").exists() {
                return ws.to_path_buf();
            }
        }
    }
    app_dir.to_path_buf()
}

fn find_agent_workbench_dir(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join("apps").join("agent-workbench");
        if candidate.join("package.json").exists() {
            return Some(candidate);
        }
        if dir.ends_with(Path::new("apps").join("agent-workbench"))
            && dir.join("package.json").exists()
        {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

// ===== RUN-05：旧 exe 目录数据一次性迁移（release 形态） =====

/// 一次迁移的结果（启动日志/测试断言用）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LegacyMigration {
    /// dev 形态 / 目录缺失 / 已迁移过 / 目标已有库——无事可做。
    Skipped(&'static str),
    /// 迁移成功，`files` 为已复制的相对路径（启动日志证据）。
    Migrated { files: Vec<String> },
    /// 迁移失败：半成品已清理，原数据完好留在旧目录（下次启动可重试）。
    Failed { reason: String },
}

/// release 启动期入口：把旧 exe 目录的用户数据一次性复制进当前 app data dir。
///
/// dev（debug_assertions）恒 no-op——dev 仍用 monorepo 路径，无迁移语义。
/// 复制语义（非移动）：旧目录可能是只读安装位（`Program Files`），删源会失败；
/// 原数据永不动 = 天然满足「迁移失败可回滚且不丢原数据」。
#[allow(unused_variables)]
pub(crate) fn migrate_legacy_release_data(current_app_dir: &Path) -> LegacyMigration {
    #[cfg(debug_assertions)]
    {
        return LegacyMigration::Skipped("dev 形态不迁移");
    }
    #[cfg(not(debug_assertions))]
    {
        let Some(legacy) = legacy_exe_dir() else {
            return LegacyMigration::Skipped("无法定位 exe 目录");
        };
        migrate_legacy_data(&legacy, current_app_dir)
    }
}

/// 迁移核心（legacy → current；平台无关，测试直调）。
///
/// 执行条件（三者同时满足）：
/// 1. legacy 存在且与 current 不同；
/// 2. current 下尚无 `sessions.db`（用户未在新区用过）；
/// 3. 未落迁移标记（重复启动幂等短路）。
///
/// 迁移清单：`sessions.db`（含 `-wal`/`-shm`）、`orchestrator-snapshot.json`、
/// `auth/`、`.agent-outputs/`。`logs/` 不迁（历史日志留在旧位，新日志写新区）。
/// 失败时清理 current 下的半成品 `sessions.db*`（防止下次启动误判已迁移后
/// 打开损坏库），并返回 [LegacyMigration::Failed]。
#[cfg(any(test, not(debug_assertions)))]
pub(crate) fn migrate_legacy_data(legacy: &Path, current: &Path) -> LegacyMigration {
    if legacy == current {
        return LegacyMigration::Skipped("迁移源与目标相同");
    }
    if !legacy.exists() {
        return LegacyMigration::Skipped("旧 exe 目录不存在");
    }
    if current.join("sessions.db").exists() {
        return LegacyMigration::Skipped("目标已有 sessions.db（跳过覆盖）");
    }
    if current.join(LEGACY_MIGRATION_MARKER).exists() {
        return LegacyMigration::Skipped("已迁移（标记存在）");
    }

    let mut copied: Vec<String> = Vec::new();
    // 目标根目录必须先存在（首启动时 app data dir 尚未创建）
    if let Err(e) = std::fs::create_dir_all(current) {
        return LegacyMigration::Failed {
            reason: format!("创建目标目录失败: {e}"),
        };
    }

    let copy_file = |rel: &str, copied: &mut Vec<String>| -> Result<(), String> {
        let src = legacy.join(rel);
        if !src.exists() {
            return Ok(());
        }
        let dst = current.join(rel);
        std::fs::copy(&src, &dst).map_err(|e| format!("复制 {rel} 失败: {e}"))?;
        copied.push(rel.to_string());
        Ok(())
    };
    let copy_tree = |rel: &str, copied: &mut Vec<String>| -> Result<(), String> {
        let src = legacy.join(rel);
        if !src.is_dir() {
            return Ok(());
        }
        copy_dir_recursive(&src, &current.join(rel), rel, copied)
    };

    let run = |copied: &mut Vec<String>| -> Result<(), String> {
        for rel in ["sessions.db", "sessions.db-wal", "sessions.db-shm"] {
            copy_file(rel, copied)?;
        }
        copy_file("orchestrator-snapshot.json", copied)?;
        copy_tree("auth", copied)?;
        copy_tree(".agent-outputs", copied)?;
        Ok(())
    };

    // WAL 残留一致性：若主库与 -wal/-shm 部分复制失败，整体作废回滚
    if let Err(reason) = run(&mut copied) {
        for rel in ["sessions.db", "sessions.db-wal", "sessions.db-shm"] {
            let _ = std::fs::remove_file(current.join(rel));
        }
        return LegacyMigration::Failed { reason };
    }

    // 无可迁数据（旧目录存在但无任何清单内文件）：不算迁移、不落标记，
    // 避免把「空目录误迁」记成已迁移状态。
    if copied.is_empty() {
        return LegacyMigration::Skipped("旧目录无可迁数据");
    }

    // 标记最后落（成功路径专属）：写入失败仅告警不影响迁移结果——
    // 下次启动 sessions.db 已存在，同样短路。
    if let Err(e) = std::fs::write(current.join(LEGACY_MIGRATION_MARKER), b"v1") {
        tracing::warn!(target: "host_paths", error = %e, "迁移标记写入失败（不影响本次迁移）");
    }
    LegacyMigration::Migrated { files: copied }
}

/// 递归复制目录，`rel_prefix` 用于失败定位与相对路径记账。
#[cfg(any(test, not(debug_assertions)))]
fn copy_dir_recursive(
    src: &Path,
    dst: &Path,
    rel_prefix: &str,
    copied: &mut Vec<String>,
) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录 {rel_prefix} 失败: {e}"))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("读取目录 {rel_prefix} 失败: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("遍历 {rel_prefix} 失败: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = format!("{rel_prefix}/{name}");
        let ty = entry.file_type().map_err(|e| format!("stat {rel} 失败: {e}"))?;
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst.join(&name), &rel, copied)?;
        } else {
            std::fs::copy(entry.path(), dst.join(&name))
                .map_err(|e| format!("复制 {rel} 失败: {e}"))?;
            copied.push(rel);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uniq_dir(tag: &str) -> PathBuf {
        let base = env::temp_dir().join(format!(
            "host-paths-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    /// legacy 有旧库/快照/产出 → 迁移成功：文件复制到目标 + 标记落盘
    #[test]
    fn migrates_legacy_files_and_writes_marker() {
        let legacy = uniq_dir("legacy1");
        let current = uniq_dir("cur1");
        std::fs::write(legacy.join("sessions.db"), b"old-db").unwrap();
        std::fs::write(legacy.join("sessions.db-wal"), b"old-wal").unwrap();
        std::fs::write(legacy.join("orchestrator-snapshot.json"), b"{}").unwrap();
        std::fs::create_dir_all(legacy.join(".agent-outputs/s1")).unwrap();
        std::fs::write(legacy.join(".agent-outputs/s1/out.txt"), b"data").unwrap();
        std::fs::create_dir_all(legacy.join("auth")).unwrap();
        std::fs::write(legacy.join("auth/token.json"), b"t").unwrap();
        // logs 不在迁移清单：造一个，迁移后不应出现在目标
        std::fs::create_dir_all(legacy.join("logs")).unwrap();
        std::fs::write(legacy.join("logs/old.log"), b"log").unwrap();

        let result = migrate_legacy_data(&legacy, &current);

        match &result {
            LegacyMigration::Migrated { files } => {
                assert!(files.contains(&"sessions.db".to_string()), "files={files:?}");
                assert!(
                    files.contains(&"sessions.db-wal".to_string()),
                    "WAL 应一并迁移（否则库可能损坏），files={files:?}"
                );
            }
            other => panic!("应迁移成功，实际 {other:?}"),
        }
        assert_eq!(std::fs::read(current.join("sessions.db")).unwrap(), b"old-db");
        assert_eq!(
            std::fs::read(current.join(".agent-outputs/s1/out.txt")).unwrap(),
            b"data"
        );
        assert_eq!(std::fs::read(current.join("auth/token.json")).unwrap(), b"t");
        assert!(
            current.join(LEGACY_MIGRATION_MARKER).exists(),
            "迁移标记应落盘"
        );
        assert!(!current.join("logs").exists(), "logs 不在迁移清单");
        // 复制语义：源完好（回滚不丢原数据）
        assert!(legacy.join("sessions.db").exists());
        assert!(legacy.join(".agent-outputs/s1/out.txt").exists());
    }

    /// 重复启动不重复迁移：标记存在 → Skipped；目标已有 sessions.db → Skipped
    #[test]
    fn reruns_are_idempotent_short_circuits() {
        let legacy = uniq_dir("legacy2");
        let current = uniq_dir("cur2");
        // 用非 DB 文件造非空迁移（目标不落 sessions.db，第二次才能命中标记短路）
        std::fs::create_dir_all(legacy.join("auth")).unwrap();
        std::fs::write(legacy.join("auth/token.json"), b"t").unwrap();
        assert!(matches!(
            migrate_legacy_data(&legacy, &current),
            LegacyMigration::Migrated { .. }
        ));
        assert!(current.join(LEGACY_MIGRATION_MARKER).exists());
        // 标记短路
        assert_eq!(
            migrate_legacy_data(&legacy, &current),
            LegacyMigration::Skipped("已迁移（标记存在）")
        );
        // 目标已有库短路（另一组目录，手工预置 sessions.db）
        let current2 = uniq_dir("cur2b");
        std::fs::write(current2.join("sessions.db"), b"new").unwrap();
        assert_eq!(
            migrate_legacy_data(&legacy, &current2),
            LegacyMigration::Skipped("目标已有 sessions.db（跳过覆盖）")
        );
        // 幂等短路后目标库未被覆盖
        assert_eq!(std::fs::read(current2.join("sessions.db")).unwrap(), b"new");
    }

    /// 迁移失败（快照文件为目录、copy 打开失败）→ Failed + 半成品 sessions.db* 清理 +
    /// 原数据完好；且失败后下次重试（修复源后）可成功
    #[test]
    fn failure_cleans_partial_db_and_keeps_legacy_intact() {
        let legacy = uniq_dir("legacy3");
        let current = uniq_dir("cur3");
        std::fs::write(legacy.join("sessions.db"), b"old-db").unwrap();
        // 源快照文件必须存在（否则 !src.exists() 直接跳过，复制永不失败）
        std::fs::write(legacy.join("orchestrator-snapshot.json"), b"{}").unwrap();
        // 复制必然失败：目标是同名**目录**
        std::fs::create_dir_all(current.join("orchestrator-snapshot.json")).unwrap();

        let result = migrate_legacy_data(&legacy, &current);
        let reason = match &result {
            LegacyMigration::Failed { reason } => reason.clone(),
            other => panic!("应迁移失败，实际 {other:?}"),
        };
        assert!(reason.contains("orchestrator-snapshot.json"), "reason={reason}");
        // 半成品清理：目标库文件不留残骸（防下次误判已迁移打开坏库）
        assert!(!current.join("sessions.db").exists());
        assert!(!current.join(LEGACY_MIGRATION_MARKER).exists());
        // 原数据完好
        assert_eq!(std::fs::read(legacy.join("sessions.db")).unwrap(), b"old-db");

        // 修复源（移除冲突制造物）后重试成功
        std::fs::remove_dir_all(current.join("orchestrator-snapshot.json")).unwrap();
        assert!(matches!(
            migrate_legacy_data(&legacy, &current),
            LegacyMigration::Migrated { .. }
        ));
        assert_eq!(std::fs::read(current.join("sessions.db")).unwrap(), b"old-db");
    }

    /// 无旧库 / 同目录 / 空旧目录：Skipped，不产生副作用
    #[test]
    fn skips_when_nothing_to_migrate() {
        // legacy 路径不预创建（uniq_dir 会建目录，这里手拼不存在的路径）
        let legacy = env::temp_dir().join(format!(
            "host-paths-nonexistent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let current = uniq_dir("cur4");
        assert_eq!(
            migrate_legacy_data(&legacy, &current),
            LegacyMigration::Skipped("旧 exe 目录不存在")
        );
        // 同目录防自迁
        assert_eq!(
            migrate_legacy_data(&current, &current),
            LegacyMigration::Skipped("迁移源与目标相同")
        );
        // 空旧目录（存在但无清单内文件）：Skipped 且不落标记
        let empty_legacy = uniq_dir("legacy4e");
        assert_eq!(
            migrate_legacy_data(&empty_legacy, &current),
            LegacyMigration::Skipped("旧目录无可迁数据")
        );
        assert!(!current.join(LEGACY_MIGRATION_MARKER).exists());
    }

    /// release_data_dir 携带 identifier（app data dir 锚定正确）
    #[test]
    fn release_data_dir_ends_with_identifier() {
        let dir = release_data_dir().expect("测试环境必有 data_dir");
        assert!(dir.ends_with(APP_IDENTIFIER), "dir={dir:?}");
    }
}
