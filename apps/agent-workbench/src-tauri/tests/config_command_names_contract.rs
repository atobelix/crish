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
    COMMAND_MANIFEST.commands.iter().map(|c| c.name).collect()
}

/// F5 终态名（冻结 v1）：config 族 8 条全部登记且已接线
#[test]
fn f5_final_config_command_names_registered() {
    for name in [
        "config_secret_set",
        "config_secret_get",
        "config_secret_has",
        "config_secret_clear",
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
        "config_get",
        "config_update",
        "config_profile_apply",
        "catalog_get",
        "catalog_refresh",
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

/// F3/F4 冻结命令登记（session 族：cleanup_orphan_sessions）
#[test]
fn f3_f4_session_commands_registered() {
    for name in ["cleanup_orphan_sessions"] {
        let entry = COMMAND_MANIFEST
            .commands
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("F3/F4 命令 {name} 必须登记 manifest"));
        assert!(entry.registered, "{name} 应已接线");
        assert_eq!(entry.family, "session");
    }
}
#[test]
fn models_read_save_apply_have_real_primary_registration() {
    let main = include_str!("../src/main.rs");
    for name in [
        "workbench_read_models_yaml",
        "workbench_save_models_yaml",
        "workbench_apply_models_config",
    ] {
        assert!(manifest_names().contains(&name));
        assert!(main.contains(&format!("models_yaml::{name}")));
    }
}

/// 出厂能力字典读面注册契约（单轨收敛阶段 3，2026-09-15）：
/// 命令名 = **语义名**（「能力字典」的只读投影），不是实现细节名
/// （`workbench_read_bundled_catalog`）；且必须**真实注册**进 main.rs
/// `command_registry!`——防「`#[tauri::command]` 已定义但未注册」的假接线回归
/// （注册面盲区：D11 只对齐四方清单，不检宏外命令函数）。
#[test]
fn capability_dictionary_read_face_is_registered() {
    const NAME: &str = "workbench_read_capability_dictionary";
    let main = include_str!("../src/main.rs");
    assert!(
        manifest_names().contains(&NAME),
        "{NAME} 必须登记 manifest（四方权威 ①）"
    );
    assert!(
        main.contains(&format!("\"{NAME}\"")),
        "{NAME} 必须注册进 main.rs command_registry!（四方权威 ②）"
    );
    assert!(
        main.contains(&format!("models_yaml::{NAME}")),
        "{NAME} 的实现路径必须指向 models_yaml 真源"
    );
    // 改名即弃名：旧实现细节名不得在任何注册面残留
    assert!(
        !main.contains("workbench_read_bundled_catalog"),
        "旧名 workbench_read_bundled_catalog 严禁残留（改名即弃名）"
    );
}

/// 真漂移退役面（2026-09-15 债务清零）：已退役的 8 条命令**严禁**在
/// manifest 重新登记（防「退役后又悄悄复活」），也不得出现在 main.rs 注册面。
#[test]
fn retired_drift_debt_commands_are_not_registered() {
    let main = include_str!("../src/main.rs");
    let names = manifest_names();
    for retired in [
        "workbench_select_folder",
        "workbench_http_request",
        "config_get_outputs_root",
        "config_set_outputs_root",
        "set_session_output_root",
        "computer_session_enable",
        "computer_session_disable",
        "computer_status",
    ] {
        assert!(
            !names.contains(&retired),
            "已退役命令 {retired} 严禁登记 manifest（真漂移债务清零后不得复活）"
        );
        assert!(
            !main.contains(&format!("\"{retired}\",")),
            "已退役命令 {retired} 严禁出现在 main.rs command_registry! 注册面"
        );
    }
}
