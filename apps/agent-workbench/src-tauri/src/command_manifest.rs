//! 命令清单（PE-03 T03.1）—— Rust 侧命令面唯一真源。
//!
//! 前端 `apps/crish-desktop/src/api/transport/commandManifest.ts` 的
//! `BUILTIN_COMMAND_MANIFEST` 是本文件的**内置快照镜像**（启动拉取失败 / 非 Tauri
//! 环境回退面），双端手工同步，条数由双端测试锁定：
//! - Rust 侧：本文件 `manifest_*` 测试（条数公式化 / 幽灵命令排除 / 新增命令登记）；
//! - 前端侧：`commandManifest.test.ts`（73 = 注册面 69 + 登记先行 4）。
//!
//! 维护规则：
//! - `registered = true` 子集 = main.rs `make_handlers!` 当前注册面（integration agent
//!   接线时以本清单为准对齐，任何不一致都是 bug）；
//! - 登记先行命令（`registered = false`，如 append_session_messages / workbench_* 待接线）
//!   由实现方各自负责，接线后翻 `true`；
//! - 幽灵命令（AA-02 W-5，9 条）**严禁**登记（`manifest_excludes_ghost_commands` 测试拦截）。
//!
//! `core_list_commands` 启动即可用、无状态依赖，返回完整 manifest JSON
//! （`{ contractVersion, commands: [{ name, family, surface, registered }] }`）。

use conex_types::CoreError;
use serde::Serialize;

/// 契约版本（semver，与前端 `COMMAND_MANIFEST_CONTRACT_VERSION` 同步；§2.5 约定）。
pub const COMMAND_MANIFEST_CONTRACT_VERSION: &str = "1.0.0";

/// 清单条目（对应前端 `CommandManifestEntry`，serde camelCase）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandManifestEntry {
    /// 命令名（invoke 用，必须与 `make_handlers!` 注册项一致）
    pub name: &'static str,
    /// 分组（core / config / session / md / perf / workbench）
    pub family: &'static str,
    /// 契约面：engine = 引擎契约面（三端共用）；gui = GUI 专属面
    pub surface: &'static str,
    /// 是否已挂入 Rust invoke_handler（登记先行命令为 false）
    pub registered: bool,
}

/// 命令清单（对应前端 `CommandManifest`，serde camelCase → `contractVersion`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandManifest {
    pub contract_version: &'static str,
    pub commands: &'static [CommandManifestEntry],
}

/// 条目构造 helper（const fn，编译期清单缩排用）。
const fn entry(
    name: &'static str,
    family: &'static str,
    surface: &'static str,
    registered: bool,
) -> CommandManifestEntry {
    CommandManifestEntry {
        name,
        family,
        surface,
        registered,
    }
}

/// 命令清单（73 条 = 注册面 69 + 登记先行 4；与前端 `BUILTIN_COMMAND_MANIFEST` 双向镜像）。
///
/// 注册面（registered=true）必须与 main.rs `make_handlers!` 注册一致；
/// 登记先行（registered=false）为「已登记未接线」：append_session_messages /
/// workbench_open_workspace / workbench_list_workspaces / workbench_dev_mcp_enabled。
pub static COMMAND_MANIFEST: CommandManifest = CommandManifest {
    contract_version: COMMAND_MANIFEST_CONTRACT_VERSION,
    commands: &[
        // ── GUI 专属面（workbench_*，§2.3）──
        entry("workbench_run_shell", "workbench", "gui", true),
        // PE-07 T07.3（C-02/C-03/C-04）：git 参数数组执行 + 参数 schema 白名单
        entry("workbench_git_run", "workbench", "gui", true),
        entry("workbench_fs_delete_file", "workbench", "gui", true),
        entry("workbench_pty_create", "workbench", "gui", true),
        entry("workbench_pty_write", "workbench", "gui", true),
        entry("workbench_pty_resize", "workbench", "gui", true),
        entry("workbench_pty_kill", "workbench", "gui", true),
        entry("workbench_list_host_openers", "workbench", "gui", true),
        entry("workbench_open_host_target", "workbench", "gui", true),
        entry("workbench_open_path_default", "workbench", "gui", true),
        entry("workbench_list_file_openers", "workbench", "gui", true),
        entry("workbench_select_folder", "workbench", "gui", true),
        entry("workbench_list_directory", "workbench", "gui", true),
        entry("workbench_read_file_content", "workbench", "gui", true),
        entry("workbench_write_file_content", "workbench", "gui", true),
        entry("workbench_discover_skills", "workbench", "gui", true),
        entry("workbench_http_request", "workbench", "gui", true),
        entry("workbench_apply_update", "workbench", "gui", true),
        // ── 配置族（§2.2-C，F5 终态名：config_get/config_update/config_secret_*）──
        // PE-07 T07.4（K-01/K-02）：config_profile_apply / config_secret_reveal 已接线
        entry("config_get", "config", "engine", true),
        entry("config_update", "config", "engine", true),
        entry("config_secret_set", "config", "engine", true),
        entry("config_secret_get", "config", "engine", true),
        entry("config_secret_has", "config", "engine", true),
        entry("config_secret_clear", "config", "engine", true),
        entry("config_profile_apply", "config", "engine", true),
        entry("config_secret_reveal", "config", "engine", true),
        // ── 工具旧组（E1，§2.2-E）──
        entry("core_check_command", "core", "engine", true),
        entry("core_search_files", "core", "engine", true),
        entry("core_rebuild_search_index", "core", "engine", true),
        entry("core_compact_messages", "core", "engine", true),
        entry("core_count_tokens", "core", "engine", true),
        entry("core_compute_diff", "core", "engine", true),
        // ── 查询与运行（A/B，§2.2）──
        entry("core_get_status", "core", "engine", true),
        entry("core_get_run_snapshot", "core", "engine", true),
        entry("core_read_run_events", "core", "engine", true),
        entry("core_read_session_events", "core", "engine", true),
        entry("core_run_task", "core", "engine", true),
        entry("core_run_control", "core", "engine", true),
        entry("core_cancel_run", "core", "engine", true),
        entry("core_approve_tool", "core", "engine", true),
        entry("core_deny_tool", "core", "engine", true),
        // ── 会话持久化（B，§2.2；含 F3 冻结的 upsert_session_entry）──
        entry("list_sessions", "session", "engine", true),
        entry("load_session_body", "session", "engine", true),
        entry("save_session_body", "session", "engine", true),
        entry("delete_session", "session", "engine", true),
        entry("load_session_agents", "session", "engine", true),
        entry("save_session_agents", "session", "engine", true),
        entry("get_session_meta", "session", "engine", true),
        entry("set_session_meta", "session", "engine", true),
        entry("cleanup_orphan_sessions", "session", "engine", true),
        entry("import_from_localstorage", "session", "engine", true),
        entry("touch_session", "session", "engine", true),
        entry("upsert_session_entry", "session", "engine", true),
        // ── Markdown（D，T03.4 更名 core_md_*，并入 core 族）──
        entry("core_md_render", "core", "engine", true),
        entry("core_md_render_batch", "core", "engine", true),
        entry("core_md_render_stream", "core", "engine", true),
        entry("core_highlight_code", "core", "engine", true),
        entry("core_md_clear_cache", "core", "engine", true),
        // ── 工具 Worker 组（E，§2.2；core_jsonl_append 自 perf 迁移）──
        entry("core_hash_compute", "core", "engine", true),
        entry("core_base64_encode", "core", "engine", true),
        entry("core_base64_decode", "core", "engine", true),
        entry("core_detect_encoding", "core", "engine", true),
        entry("core_decode_text", "core", "engine", true),
        entry("core_parse_diff", "core", "engine", true),
        entry("core_messages_to_jsonl", "core", "engine", true),
        entry("core_jsonl_to_messages", "core", "engine", true),
        entry("core_text_encode", "core", "engine", true),
        entry("core_jsonl_append", "core", "engine", true),
        // ── 注册表单一化自身（T03.1）──
        entry("core_list_commands", "core", "engine", true),
        // ── 登记先行（§7.2 登记表，AU-04 F12-C13；实现方各自负责，接线后翻 true）──
        entry("append_session_messages", "session", "engine", false),
        entry("workbench_open_workspace", "workbench", "gui", false),
        entry("workbench_list_workspaces", "workbench", "gui", false),
        entry("workbench_dev_mcp_enabled", "workbench", "gui", false),
    ],
};

/// `core_list_commands`：返回完整命令清单（启动即可用，无状态依赖，PE-03 T03.1）。
///
/// 前端启动时经 `invokeTyped('core_list_commands')` 拉取真源并缓存；失败回退内置快照。
#[tauri::command]
pub fn core_list_commands() -> Result<CommandManifest, CoreError> {
    Ok(COMMAND_MANIFEST)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 条数公式化：总数 = 注册面 + 登记先行（镜像前端 commandManifest.test.ts：
    /// 73 = 注册面 69 + 登记先行 4；变更时双端同步）。
    #[test]
    fn manifest_count_matches_registered_surface() {
        let total = COMMAND_MANIFEST.commands.len();
        let registered = COMMAND_MANIFEST
            .commands
            .iter()
            .filter(|c| c.registered)
            .count();
        let pending = total - registered;
        assert!(pending > 0, "登记先行必须 > 0");
        assert_eq!(total, 73, "总数 73（与前端 BUILTIN_COMMAND_MANIFEST 同步）");
        assert_eq!(registered, 69, "注册面 69");
        assert_eq!(pending, 4, "登记先行 4");
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

    /// 9 条新增命令登记齐备（§7.2 登记表；PE-07 T07.3/T07.4 已接线部分 registered=true，
    /// 与前端 commandManifest.test.ts 的 9 条登记断言保持同步）。
    #[test]
    fn manifest_registers_all_nine_new_commands() {
        let by_name: std::collections::HashMap<&str, &CommandManifestEntry> = COMMAND_MANIFEST
            .commands
            .iter()
            .map(|c| (c.name, c))
            .collect();
        for name in [
            "upsert_session_entry",
            "append_session_messages",
            "config_profile_apply",
            "config_secret_reveal",
            "workbench_git_run",
            "workbench_fs_delete_file",
            "workbench_open_workspace",
            "workbench_list_workspaces",
            "workbench_dev_mcp_enabled",
        ] {
            assert!(
                by_name.contains_key(name),
                "{name} 必须登记 manifest（§7.2 登记表）"
            );
        }
        for name in [
            "upsert_session_entry",
            "workbench_git_run",
            "workbench_fs_delete_file",
            "config_profile_apply",
            "config_secret_reveal",
        ] {
            assert!(by_name[name].registered, "{name} 已接线应 registered=true");
        }
        for name in [
            "append_session_messages",
            "workbench_open_workspace",
            "workbench_list_workspaces",
            "workbench_dev_mcp_enabled",
        ] {
            assert!(!by_name[name].registered, "{name} 未接线应 registered=false");
        }
    }

    /// 幽灵命令排除（AA-02 W-5，9 条）：不得登记 manifest（真源侧拦截，
    /// 与前端 commandMap.test.ts 的映射 null 断言构成双重守门）。
    #[test]
    fn manifest_excludes_ghost_commands() {
        let ghosts = [
            "workbench_git_status",
            "workbench_git_diff",
            "workbench_list_mcp_servers",
            "workbench_start_mcp_server",
            "workbench_stop_mcp_server",
            "workbench_preview_conversation_rewind",
            "workbench_apply_conversation_rewind",
            "workbench_send_to_subagent",
            "workbench_get_subagent_status",
        ];
        for ghost in ghosts {
            assert!(
                !COMMAND_MANIFEST
                    .commands
                    .iter()
                    .any(|c| c.name == ghost),
                "幽灵命令 {ghost} 严禁登记 manifest"
            );
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

    /// core_list_commands：无状态返回完整清单（启动即可用）。
    #[test]
    fn core_list_commands_returns_full_manifest() {
        let manifest = core_list_commands().unwrap();
        assert_eq!(manifest.commands.len(), 73);
        assert_eq!(manifest.contract_version, "1.0.0");
    }
}
