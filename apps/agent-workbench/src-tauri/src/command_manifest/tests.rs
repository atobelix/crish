//! 命令清单登记断言（条数公式、唯一性、分族接线、序列化契约）。

use super::*;

/// 条数公式化：总数 = 注册面 + 登记先行（镜像前端 commandManifest.test.ts：
/// 变更时双端同步——T-F 06 退役 5 条后 95 → 90，浏览器域追加
/// browser_input / browser_start_frames / browser_stop_frames /
/// browser_frame_status 后 90 → 94；R1-07 多端互通四件套 + R1-08
/// 撤销/改名两件套后 94 → 100；browser_export/import_storage_state
/// 追加后 100 → 102；R1-09 multi_device_network_info 追加后 102 → 103；
/// R1-11 multi_device_set_enabled 追加后 103 → 104；G-4 书签/历史
/// 四命令（browser_import/list_bookmarks/history）追加后 104 → 108；
/// Round7 note_* 三命令追加后 108 → 111；D4a 五命令
/// （resume_subagent/kill_all/kill_subagent + core_resume_run/
/// core_compact_now 登记先行）追加后 111 → 116；
/// note_document_hydrate 追加后 116 → 117；
/// note_detect_mirror_drift + note_import_mirror_proposal 后 117 → 119；
/// note_apply_ops（CONN-B3）后 119 → 120；
/// 电脑操作四命令（computer_session_* / computer_estop / computer_status）
/// 追加后 120 → 124；E2 F4 core_compact_now 接线 114 → 119（登记先行 6 → 5）；
/// F-03（DM-07）core_read_run_events 恢复激活（注册面 119 → 120）；R1 撤回
/// core_session_retract 登记（统一输入流收敛战役）后总数 124 → 125（注册面 120 → 121）；
/// R7 收口 GUI fs 删除命令幽灵退役（R6-D5 后零消费）后总数 125 → 124（注册面 121 → 120）；
/// computer_estop 退役后 123；note_document_recent 追加后 124；
/// 模型字典真源三命令追加后 127；core_jsonl_append 退役（零消费）后 126；
/// workbench_window_ready（ACT-101 / CON-01）追加后 145 → 146。
///
/// 单轨收敛命令面清零（2026-09-15）：
/// - 出厂能力字典读面 `workbench_read_capability_dictionary` 登记（142 → 143）；
/// - 真漂移债务清零退役 8 条（workbench_select_folder / workbench_http_request /
///   config_get_outputs_root / config_set_outputs_root / set_session_output_root /
///   computer_session_enable / computer_session_disable / computer_status）
///   后 143 → **135**；b6 `core_generate_session_title` 追加后 135 → **136**；
///   Win11 贴靠布局热区 `workbench_set_snap_overlay_rect` 追加后 136 → **137**；
///   PE-07 工作区复授权与 Rust 原生目录选择五命令接线后 147 → **152**；
///   默认工作区激活命令追加后 152 → **153**；
/// - `core_read_run_events` 复核后**保留**（跨端契约面 tauri_command 映射 +
///   移动端 monitorCommands 映射真源 + 实现处「不得静默再退役」登记）——
///   在 command-contract-drift.test.ts 记为待裁决，不计入本次退役。
#[test]
fn manifest_count_matches_registered_surface() {
    let total = COMMAND_MANIFEST.commands.len();
    let registered = COMMAND_MANIFEST
        .commands
        .iter()
        .filter(|c| c.registered)
        .count();
    let pending = total - registered;
    assert_eq!(
        total, 174,
        "总数 147；PE-07 工作区授权五命令接线后 152，默认根激活命令追加后 153，原生子 Webview 七命令追加后 160，Hit-Test 能力命令后 161，Inspector 后 162，运行时权限切换后 163，Markdown 2.0 流式渲染命令后 164，外链命令后 165，multi_device_export_ca 后 166，auth_get_relay_ticket / auth_revoke_device 下线后 164，完整账号体系七命令（验证码 / 资料 / 头像 / 会话）后 171，注销 / 先码后密码三命令后 174"
    );
    assert_eq!(
        registered, 174,
        "注册面 174（全部为 registered=true 实装命令）"
    );
    assert_eq!(pending, 0, "登记先行 0");
}

/// 命令名唯一（重复名会破坏前端清单校验）。
#[test]
fn manifest_names_are_unique() {
    let mut names: Vec<&str> = COMMAND_MANIFEST.commands.iter().map(|c| c.name).collect();
    names.sort_unstable();
    let original = names.len();
    names.dedup();
    assert_eq!(names.len(), original);
}

/// PE-07 命令登记齐备（§7.2 登记表；已接线部分 registered=true）。
#[test]
fn manifest_registers_pe07_commands() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    for name in [
        "workbench_apply_models_config",
        "config_secret_reveal",
        "workbench_git_run",
        "workbench_open_workspace",
        "workbench_open_workspaces",
        "workbench_activate_default_workspace",
        "workbench_list_workspaces",
        "workbench_pick_workspace_folder",
        "workbench_pick_workspace_folders",
    ] {
        assert!(
            by_name.contains_key(name),
            "{name} 必须登记 manifest（PE-07 接线面）"
        );
        assert!(by_name[name].registered, "{name} 已接线应 registered=true");
    }
}

/// 幽灵命令排除：不得登记 manifest（真源侧拦截，
/// 与前端 commandMap.test.ts 的映射 null 断言构成双重守门）。
#[test]
fn manifest_excludes_ghost_commands() {
    let ghosts = [
        "workbench_git_status",
        "workbench_git_diff",
        "workbench_preview_conversation_rewind",
        "workbench_apply_conversation_rewind",
        "workbench_send_to_subagent",
        "workbench_get_subagent_status",
    ];
    for ghost in ghosts {
        assert!(
            !COMMAND_MANIFEST.commands.iter().any(|c| c.name == ghost),
            "幽灵命令 {ghost} 严禁登记 manifest"
        );
    }
}

/// workflow 命令六条强制登记（T-CF-14：消除前端幽灵命令；注册面
/// 必须含全部六条且 registered=true，与 main.rs 注册逐项一致）。
#[test]
fn workflow_commands_registered_in_manifest() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    for name in [
        "create-workflow",
        "list-workflows",
        "update-workflow",
        "delete-workflow",
        "trigger-workflow",
        "list-workflow-runs",
    ] {
        let entry = by_name
            .get(name)
            .unwrap_or_else(|| panic!("{name} 必须登记 manifest（T-CF-14）"));
        assert!(entry.registered, "{name} 已接线应 registered=true");
        assert_eq!(entry.family, "workflow", "{name} 属 workflow 族");
        // create-workflow 由引擎（engine runtime）执行（209 行登记为
        // engine 契约面——workflow 持久化/触发在内核侧）
        assert_eq!(entry.surface, "engine", "{name} 属引擎契约面");
    }
}

/// 序列化契约：serde camelCase（contractVersion / family / surface / registered）。
#[test]
fn manifest_serializes_to_camel_case() {
    let json = serde_json::to_value(COMMAND_MANIFEST).unwrap();
    assert_eq!(json["contractVersion"], "1.0.0");
    let first = &json["commands"][0];
    assert!(first.get("name").is_some());
    assert!(first.get("family").is_some());
    assert!(first.get("surface").is_some());
    assert!(first.get("registered").is_some());
    // 不得出现 snake_case 键
    assert!(json.get("contract_version").is_none());
}

/// 模型目录命令登记（P3 步骤 5 / C7 三处登记 ①）：catalog_get / catalog_refresh
/// 必须登记且 registered=true（与 main.rs 注册面、mock 引擎快照同步）。
#[test]
fn manifest_registers_catalog_commands() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    for name in [
        "workbench_read_models_yaml",
        "workbench_save_models_yaml",
        "workbench_apply_models_config",
        // 出厂能力字典只读投影（替代已退役 catalog_get 的读面；纯只读）
        "workbench_read_capability_dictionary",
    ] {
        let entry = by_name
            .get(name)
            .unwrap_or_else(|| panic!("{name} 必须登记 manifest（C7 ①）"));
        assert_eq!(entry.family, "workbench", "{name} 属 workbench 族");
        // read 走 Tauri gui 面（WebView 直调），apply/save 走引擎事务
        assert_eq!(
            entry.surface, "gui",
            "{name} 属 gui 契约面（WebView 直调读取）"
        );
        assert!(entry.registered, "{name} 已接线应 registered=true");
    }
}

/// core_list_commands：无状态返回完整清单（启动即可用）。
#[test]
fn core_list_commands_returns_full_manifest() {
    let manifest = core_list_commands().unwrap();
    assert_eq!(manifest.commands.len(), COMMAND_MANIFEST.commands.len());
    assert_eq!(manifest.contract_version, "1.0.0");
}

/// 偏好持久化三命令登记且 registered=true
#[test]
fn manifest_registers_preferences_commands() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    for name in ["prefs_get", "prefs_set", "prefs_delete"] {
        let entry = by_name
            .get(name)
            .unwrap_or_else(|| panic!("{name} 必须登记 manifest（Token与偏好SSOT战役 N3）"));
        assert_eq!(entry.family, "preferences", "{name} 属 preferences 族");
        assert_eq!(entry.surface, "engine", "{name} 属引擎契约面");
        assert!(entry.registered, "{name} 已接线应 registered=true");
    }
}

/// 多笔记四命令登记且 registered=true
#[test]
fn manifest_registers_all_four_note_document_commands() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    for name in [
        "note_document_list",
        "note_document_create",
        "note_document_rename",
        "note_document_delete",
    ] {
        let entry = by_name
            .get(name)
            .unwrap_or_else(|| panic!("{name} 必须登记 manifest"));
        assert_eq!(entry.family, "note", "{name} 属 note 族");
        assert_eq!(entry.surface, "engine", "{name} 属引擎契约面");
        assert!(entry.registered, "{name} 已接线应 registered=true");
    }
}

/// 用量监控五命令登记且 registered=true
#[test]
fn manifest_registers_usage_commands() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    for name in [
        "usage_get_dashboard_data",
        "usage_get_activity_matrix",
        "usage_clear_history",
        "usage_record_delta",
        "usage_import_legacy_snapshot",
    ] {
        let entry = by_name
            .get(name)
            .unwrap_or_else(|| panic!("{name} 必须登记 manifest"));
        assert_eq!(entry.family, "usage", "{name} 属 usage 族");
        assert_eq!(entry.surface, "gui", "{name} 属 gui 专属面");
        assert!(entry.registered, "{name} 已接线应 registered=true");
    }
}

/// Round7+：笔记 IPC 十命令登记且 registered=true（含 hydrate / recent / mirror / apply_ops / undo_text / redo_text）。
#[test]
fn manifest_registers_note_commands() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    for name in [
        "note_document_apply_md",
        "note_query_blocks",
        "note_send_to_note",
        "note_document_hydrate",
        "note_document_recent",
        "note_detect_mirror_drift",
        "note_import_mirror_proposal",
        "note_apply_ops",
        "note_undo_text",
        "note_redo_text",
    ] {
        let entry = by_name
            .get(name)
            .unwrap_or_else(|| panic!("{name} 必须登记 manifest（Round7+）"));
        assert_eq!(entry.family, "note", "{name} 属 note 族");
        assert_eq!(entry.surface, "engine", "{name} 属引擎契约面");
        assert!(entry.registered, "{name} 已接线应 registered=true");
    }
}

/// get_flow_snapshot 登记断言（F11b T-D-12 联动）：会话族只读查询命令
/// 必须登记且 registered=true（与 main.rs make_handlers! 注册逐项一致）。
#[test]
fn manifest_registers_get_flow_snapshot() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    let entry = by_name
        .get("get_flow_snapshot")
        .unwrap_or_else(|| panic!("get_flow_snapshot 必须登记 manifest（T-D-12）"));
    assert_eq!(entry.family, "session", "get_flow_snapshot 属 session 族");
    assert_eq!(entry.surface, "engine", "get_flow_snapshot 属引擎契约面");
    assert!(
        entry.registered,
        "get_flow_snapshot 已接线应 registered=true"
    );
}

/// D4a：子代理显式恢复与关闭命令双端登记（D4 §1.2 A5）——三条命令
/// registered=true（与 main.rs 注册面一致）；core_compact_now（E2 F4）已接线 registered=true。
#[test]
fn manifest_registers_d4a_subagent_commands() {
    let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
        .commands
        .iter()
        .map(|c| (c.name, c))
        .collect();
    for name in ["resume_subagent", "kill_all", "kill_subagent"] {
        let entry = by_name
            .get(name)
            .unwrap_or_else(|| panic!("{name} 必须登记 manifest（D4 §3.1）"));
        assert_eq!(entry.family, "core", "{name} 属 core 族");
        assert_eq!(entry.surface, "engine", "{name} 属引擎契约面");
        assert!(entry.registered, "{name} 已接线应 registered=true");
    }
    // E2 F4：core_compact_now 实现体 + make_handlers! 注册已落 → true
    let compact = by_name
        .get("core_compact_now")
        .unwrap_or_else(|| panic!("core_compact_now 必须登记 manifest（E2 扩展）"));
    assert!(
        compact.registered,
        "core_compact_now 已接线应 registered=true"
    );
    let title = by_name
        .get("core_generate_session_title")
        .unwrap_or_else(|| panic!("core_generate_session_title 必须登记 manifest（b6）"));
    assert_eq!(title.family, "core");
    assert_eq!(title.surface, "engine");
    assert!(
        title.registered,
        "core_generate_session_title 已接线应 registered=true"
    );
}
