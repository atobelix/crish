//! F5 配置命令终态名冻结契约测试（AU-04 F5 / PE-03 T03.4 / PE-07 T07.4）
//!
//! 本文件经 `#[path]` 独立编译 `src/command_manifest.rs`（命令面唯一真源，
//! 零 crate:: 内部引用，可独立编译），锚定 F5 终态命名表（v1）：
//! - `config_*` 终态名 8 条全部登记且已接线（registered=true）；
//! - 旧名（update_daemon_config / get_api_config / save_api_config /
//!   workbench_profile_secret_* / workbench_profile_apply /
//!   workbench_profile_secret_reveal / syncActiveProfileToEngine）**严禁**
//!   登记 manifest（单终态：更名即弃名，F5 处置表）。
//!
//! 与内联测试的关系：command_manifest.rs 内联测试锚定「条数公式化 / 9 条
//! 新增命令登记 / 幽灵命令排除」；本文件补 F5 独有的**终态名与旧名对照**
//! （旧名排除此前无独立断言）。
//!
//! 运行：`cargo test -p agent-workbench --test config_command_names_contract`

#![allow(dead_code)]

#[path = "../src/command_manifest.rs"]
mod command_manifest;

use command_manifest::COMMAND_MANIFEST;

/// 取 manifest 全量命令名（去重校验由内联测试锚定，此处直接收集）
fn manifest_names() -> Vec<&'static str> {
    COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| c.name)
        .collect()
}

/// F5 终态名（冻结 v1）：config 族 8 条全部登记且已接线
#[test]
fn f5_final_config_command_names_registered() {
    for name in [
        "config_get",
        "config_update",
        "config_secret_set",
        "config_secret_get",
        "config_secret_has",
        "config_secret_clear",
        "config_profile_apply",
        "config_secret_reveal",
    ] {
        let entry = COMMAND_MANIFEST
            .commands
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("F5 终态名 {name} 必须登记 manifest"));
        assert!(entry.registered, "{name} 已接线应 registered=true");
        assert_eq!(entry.family, "config", "{name} 归属 config 族");
        assert_eq!(entry.surface, "engine", "{name} 属引擎契约面");
    }
}

/// 旧名排除（F5 处置：更名 / 删除，不得保留原名）
#[test]
fn f5_legacy_config_command_names_excluded() {
    let names = manifest_names();
    for legacy in [
        // 更名（签名不变，sentToDaemon 删除）：update_daemon_config → config_update
        "update_daemon_config",
        // 更名 + 接线：get_api_config → config_get
        "get_api_config",
        // 删除（写路径并入 config_update）：save_api_config
        "save_api_config",
        // 更名 + 接线：workbench_profile_secret_set/get/has/clear → config_secret_*
        "workbench_profile_secret_set",
        "workbench_profile_secret_get",
        "workbench_profile_secret_has",
        "workbench_profile_secret_clear",
        // 更名：workbench_profile_apply → config_profile_apply（PE-07 T07.4）
        "workbench_profile_apply",
        // 更名：workbench_profile_secret_reveal → config_secret_reveal（PE-07 T07.4-C）
        "workbench_profile_secret_reveal",
        // 删除：syncActiveProfileToEngine（C6/D13，函数 + 启动调用）
        "sync_active_profile_to_engine",
    ] {
        assert!(
            !names.contains(&legacy),
            "旧命令名 {legacy} 严禁登记 manifest（F5 单终态命名体系）"
        );
    }
}

/// F3/F4 冻结命令登记（session 族：upsert_session_entry / cleanup_orphan_sessions）
#[test]
fn f3_f4_session_commands_registered() {
    for name in ["upsert_session_entry", "cleanup_orphan_sessions"] {
        let entry = COMMAND_MANIFEST
            .commands
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("F3/F4 命令 {name} 必须登记 manifest"));
        assert!(entry.registered, "{name} 应已接线");
        assert_eq!(entry.family, "session");
    }
}

/// F5 保留项：workbench_dev_mcp_enabled 属 GUI 面（workbench_*），不改名
#[test]
fn f5_gui_face_command_keeps_workbench_prefix() {
    let entry = COMMAND_MANIFEST
        .commands
        .iter()
        .find(|c| c.name == "workbench_dev_mcp_enabled")
        .expect("workbench_dev_mcp_enabled 必须登记（F5 保留项）");
    assert_eq!(entry.surface, "gui", "GUI 面命令保留 workbench_ 前缀");
}
