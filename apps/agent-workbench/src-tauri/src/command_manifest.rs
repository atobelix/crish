//! 命令清单（PE-03 T03.1）—— Rust 侧命令面唯一真源。
//!
//! 前端 `apps/crish-desktop/src/api/transport/commandManifest.ts` 的
//! `BUILTIN_COMMAND_MANIFEST` 是本文件的**内置快照镜像**（启动拉取失败 / 非 Tauri
//! 环境回退面），双端手工同步，条数由双端测试锁定：
//! - Rust 侧：本文件 `manifest_*` 测试（条数公式化 / 幽灵命令排除 / 新增命令登记）；
//! - 前端侧：`commandManifest.test.ts`（**135 = 注册面 135 + 登记先行 0**；
//!   条数与集合由该文件的动态对照断言直读本文件真源双向锁定）。
//!
//! 维护规则：
//! - `registered = true` 子集 = main.rs `command_registry!` 当前注册面（integration agent
//!   接线时以本清单为准对齐，任何不一致都是 bug）；
//! - 登记先行命令（`registered = false`，如 workbench_* 待接线）
//!   由实现方各自负责，接线后翻 `true`（**当前为 0 条**，全部实装）；
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

/// 命令清单（**135 条 = 全部 registered=true 实装命令**；与前端
/// `BUILTIN_COMMAND_MANIFEST` 双向镜像）。
///
/// 注册面（registered=true）必须与 main.rs `command_registry!` 注册一致；
/// 登记先行（registered=false）为「已登记未接线」：workbench_open_workspace /
/// workbench_list_workspaces / workbench_dev_mcp_enabled / core_resume_run（P2）。
/// F-03（DM-07）：core_read_run_events 恢复激活；R1 撤回 core_session_retract 登记
///（统一输入流收敛战役）后总数 125（注册面 120 → 121）；R7 收口 GUI fs 删除命令
/// 幽灵退役（R6-D5 后零消费）后总数 124（注册面 121 → 120）；
/// computer_estop 退役后 123；`note_document_recent` 追加后 124；
/// 模型字典真源三命令追加后 127；core_jsonl_append 退役（零消费）后 126；
/// 用量 / 笔记 / 账号 / 偏好 / 握手命令追加后 142（见 `manifest_count_matches_
/// registered_surface` 的逐次记账）。
///
/// **单轨收敛命令面清零（2026-09-15，本次）**：出厂能力字典读面
/// `workbench_read_capability_dictionary` 登记（142 → 143）；真漂移债务清零
/// 退役 8 条（workbench_select_folder / workbench_http_request /
/// config_get_outputs_root / config_set_outputs_root / set_session_output_root /
/// computer_session_enable / computer_session_disable / computer_status）
/// 后 143 → **135**。`core_read_run_events` 经复核**保留**（跨端契约面，
/// 见 command-contract-drift.test.ts DRIFT_DEBT 的待裁决登记）。
pub static COMMAND_MANIFEST: CommandManifest = CommandManifest {
    contract_version: COMMAND_MANIFEST_CONTRACT_VERSION,
    commands: &[
        // ── GUI 专属面（workbench_*，§2.3）──
        entry("workbench_run_shell", "workbench", "gui", true),
        // ACT-101 / CON-01：窗口首绘握手命令（workbench_window_ready）
        entry("workbench_window_ready", "workbench", "gui", true),
        // PE-07 T07.3（C-02/C-03/C-04）：git 参数数组执行 + 参数 schema 白名单
        entry("workbench_git_run", "workbench", "gui", true),
        entry("workbench_pty_create", "workbench", "gui", true),
        entry("workbench_pty_write", "workbench", "gui", true),
        entry("workbench_pty_resize", "workbench", "gui", true),
        entry("workbench_pty_detach", "workbench", "gui", true),
        entry("workbench_pty_attach", "workbench", "gui", true),
        entry("workbench_pty_ping", "workbench", "gui", true),
        entry("workbench_pty_kill", "workbench", "gui", true),
        entry("workbench_list_host_openers", "workbench", "gui", true),
        entry("workbench_open_host_target", "workbench", "gui", true),
        entry("workbench_open_path_default", "workbench", "gui", true),
        entry("workbench_list_file_openers", "workbench", "gui", true),
        // 模型字典真源（models.yaml）：读（缺则播种）/ 校验 / 原子保存
        entry("workbench_read_models_yaml", "workbench", "gui", true),
        entry("workbench_validate_models_yaml", "workbench", "gui", true),
        entry("workbench_save_models_yaml", "workbench", "gui", true),
        entry("workbench_apply_models_config", "workbench", "gui", true),
        // 出厂能力字典只读投影（替代已退役 catalog_get 的读面；纯只读）
        entry("workbench_read_capability_dictionary", "workbench", "gui", true),
        // F1（R-AB1 T-AB-08）：后台任务三条查询命令恢复（B01/B02 查询面）
        entry("workbench_list_background_tasks", "workbench", "gui", true),
        entry(
            "workbench_get_background_task_output",
            "workbench",
            "gui",
            true,
        ),
        entry("workbench_cancel_background_task", "workbench", "gui", true),
        // F3（T-AB-19 顺手接线）：send_input 命令面补齐（前端
        // sendBackgroundTaskInput 已接线等待，T-AB-20 操作面）
        entry("workbench_send_input", "workbench", "gui", true),
        // workbench_select_folder 已退役（前端目录选择统一走 plugin-dialog）
        entry("workbench_list_directory", "workbench", "gui", true),
        entry("workbench_read_file_content", "workbench", "gui", true),
        entry("workbench_write_file_content", "workbench", "gui", true),
        entry("workbench_discover_skills", "workbench", "gui", true),
        // workbench_http_request 已退役（唯一调用点在 Rust `#[cfg(test)]` 内）
        entry("workbench_apply_update", "workbench", "gui", true),
        // ── 多端互通配对面（R1-07 四件套 + R1-08 撤销/改名，registered=true，与前端同步）──
        entry("multi_device_pair_start", "multi_device", "engine", true),
        entry("multi_device_pair_status", "multi_device", "engine", true),
        entry("multi_device_pair_cancel", "multi_device", "engine", true),
        entry("multi_device_list_devices", "multi_device", "engine", true),
        entry("multi_device_revoke_device", "multi_device", "engine", true),
        entry("multi_device_rename_device", "multi_device", "engine", true),
        // R1-09 G-4：网络环境检测（注册表网络配置文件类别 + 可直连 IP + 引导文案）
        entry("multi_device_network_info", "multi_device", "engine", true),
        // R1-11 G-1：多端服务总开关（D5 D-01 红线 1——enabled=false 时
        // 不 bind 任何端口；状态衔接 multi_device_pair_status）
        entry("multi_device_set_enabled", "multi_device", "engine", true),
        // ── 用户账号与云端设备管理面 ──
        entry("auth_login", "auth", "engine", true),
        entry("auth_logout", "auth", "engine", true),
        entry("auth_get_session", "auth", "engine", true),
        entry("auth_refresh_token", "auth", "engine", true),
        entry("auth_list_devices", "auth", "engine", true),
        entry("auth_revoke_device", "auth", "engine", true),
        entry("auth_get_relay_ticket", "auth", "engine", true),
        // ── 配置族（统一配置树事务：config_secret_* 凭据边界 + workbench_apply_models_config）──
        // PE-07 T07.4（K-01/K-02）：密钥只经凭据命令落 DPAPI 槽，不进快照/事件/日志
        entry("config_secret_set", "config", "engine", true),
        entry("config_secret_get", "config", "engine", true),
        entry("config_secret_has", "config", "engine", true),
        entry("config_secret_clear", "config", "engine", true),
        entry("config_secret_reveal", "config", "engine", true),
        // ── 原生探活与模型扫描（Batch 1 · G3：provider_probe_ping / provider_probe_scan_models）──
        entry("provider_probe_ping", "config", "engine", true),
        entry("provider_probe_scan_models", "config", "engine", true),
        // ── G03 产出根：config_get_outputs_root / config_set_outputs_root
        //    已退役（四方同步移除，前端 agentOutputsRoot 设置面不存在）──
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
        entry("core_read_session_events", "core", "engine", true),
        // F-03（DM-07）：core_read_run_events IPC 面恢复激活（T-F 06 退役
        // 登记撤销——注册表恢复注册 + 本条目 registered=true，与 main.rs
        // make_handlers! 注册面一致；前端契约文档面同步见 DM-08 收口）
        entry("core_read_run_events", "core", "engine", true),
        entry("core_run_task", "core", "engine", true),
        entry("core_run_control", "core", "engine", true),
        // R1 撤回（统一输入流收敛战役）：复用 core_run_control L3 通道 +
        // 独立 retract 语义 wire（session 域，引擎面）
        entry("core_session_retract", "session", "engine", true),
        entry("core_cancel_run", "core", "engine", true),
        entry("core_approve_tool", "core", "engine", true),
        entry("core_deny_tool", "core", "engine", true),
        // ── 会话持久化（B，§2.2）──
        entry("list_sessions", "session", "engine", true),
        entry("load_session_body", "session", "engine", true),
        entry("save_session_body", "session", "engine", true),
        entry("load_session_agents", "session", "engine", true),
        entry("save_session_agents", "session", "engine", true),
        entry("get_session_meta", "session", "engine", true),
        entry("set_session_meta", "session", "engine", true),
        entry("cleanup_orphan_sessions", "session", "engine", true),
        entry("import_from_localstorage", "session", "engine", true),
        // F11b（T-D-12）：DAG 只读快照查询（flow_dag_visible 开关关闭时
        // 前端不调用本命令，只读通用面保留无害）
        entry("get_flow_snapshot", "session", "engine", true),
        // G03 会话级产出根：set_session_output_root 已退役（四方同步移除，
        // 前端无会话级产出根消费方；工具侧读取面保留）
        // ── Markdown（D，T03.4 更名 core_md_*，并入 core 族）──
        entry("core_md_render", "core", "engine", true),
        entry("core_md_render_batch", "core", "engine", true),
        // ── 工具 Worker 组（E，§2.2）──
        entry("core_hash_compute", "core", "engine", true),
        entry("core_base64_encode", "core", "engine", true),
        entry("core_base64_decode", "core", "engine", true),
        entry("core_detect_encoding", "core", "engine", true),
        entry("core_decode_text", "core", "engine", true),
        entry("core_parse_diff", "core", "engine", true),
        entry("core_messages_to_jsonl", "core", "engine", true),
        entry("core_jsonl_to_messages", "core", "engine", true),
        // ── 注册表单一化自身（T03.1）──
        entry("core_list_commands", "core", "engine", true),
        // ── 模型目录（P3 步骤 5：catalog_get / catalog_refresh；C7 三处登记 ①）──
        // ── 误删恢复（I2-S5：trash_list / trash_restore / trash_purge）──
        entry("trash_list", "core", "engine", true),
        entry("trash_restore", "core", "engine", true),
        entry("trash_purge", "core", "engine", true),
        // ── workflow 命令面（T-CF-14：六条实装，消除前端幽灵命令；
        //    wire 名 kebab-case，Rust 侧经 #[tauri::command(rename=...)] 对齐）──
        entry("create-workflow", "workflow", "engine", true),
        entry("list-workflows", "workflow", "engine", true),
        entry("update-workflow", "workflow", "engine", true),
        entry("delete-workflow", "workflow", "engine", true),
        entry("trigger-workflow", "workflow", "engine", true),
        entry("list-workflow-runs", "workflow", "engine", true),
        // ── 浏览器面板命令（27 方案 S6：browser_start/stop/status；代理到
        //    引擎浏览器会话槽，状态事件 browser://state-changed）──
        entry("browser_start", "browser", "engine", true),
        entry("browser_stop", "browser", "engine", true),
        entry("browser_status", "browser", "engine", true),
        entry("browser_input", "browser", "engine", true),
        entry("browser_start_frames", "browser", "engine", true),
        entry("browser_stop_frames", "browser", "engine", true),
        entry("browser_frame_status", "browser", "engine", true),
        entry("browser_export_storage_state", "browser", "engine", true),
        entry("browser_import_storage_state", "browser", "engine", true),
        // ── G-4 收尾：书签/历史导入（03-方案 §4.2 U4；conex-db 目标表
        //    imported_bookmarks/imported_history，落库编排见 browser_import_sinks）──
        entry("browser_import_bookmarks", "browser", "engine", true),
        entry("browser_import_history", "browser", "engine", true),
        entry("browser_list_bookmarks", "browser", "engine", true),
        entry("browser_list_history", "browser", "engine", true),
        // ── 电脑操作会话命令：computer_session_enable / computer_session_disable /
        //    computer_status 已退役（四方同步移除；computer-panel 前端面已
        //    物理删除，生产代码零消费）。ComputerSlot 托管状态与实现体保留，
        //    恢复接线时重新走四方登记 ──
        // ── Round7+：笔记双引擎 IPC（noteApi / noteHydrateIpc / noteMirrorIpc）──
        entry("note_document_apply_md", "note", "engine", true),
        entry("note_query_blocks", "note", "engine", true),
        entry("note_send_to_note", "note", "engine", true),
        // 真 hydrate / open 投影形状（B-09 延伸；≠ 打开完成 / ≠ EL）
        entry("note_document_hydrate", "note", "engine", true),
        // 最近一篇 persist 非空（doc_meta.updated_at + blocks.plain_text；≠ 平行账本）
        entry("note_document_recent", "note", "engine", true),
        // A-INV-02 / W2-E：mirror detect + import 提案（不 apply；X-05；≠ EL-03）
        entry("note_detect_mirror_drift", "note", "engine", true),
        entry("note_import_mirror_proposal", "note", "engine", true),
        // CONN-B3：collab wire → DocSession::apply（产品 slash 写锥；≠ EL-01）
        entry("note_apply_ops", "note", "engine", true),
        // CRDT-01/03：文本级 CRDT 因果撤销与重做
        entry("note_undo_text", "note", "engine", true),
        entry("note_redo_text", "note", "engine", true),
        // ── 多笔记综合管理体系 IPC（06-分维详案）──
        entry("note_document_list", "note", "engine", true),
        entry("note_document_create", "note", "engine", true),
        entry("note_document_rename", "note", "engine", true),
        entry("note_document_delete", "note", "engine", true),
        // ── D4a：子代理显式恢复与关闭命令面（D4 §3.1 双端四步登记；
        //    实现体 = main.rs lifecycle_commands 命令壳 + lifecycle 引擎侧）──
        entry("resume_subagent", "core", "engine", true),
        entry("kill_all", "core", "engine", true),
        entry("kill_subagent", "core", "engine", true),
        // E2 扩展：core_compact_now 实现体已落（E2 实现轮），registered=true
        // 子集 = make_handlers! 注册面不变量（红线 6 禁止假接线；main.rs
        // 同批注册，E0 裁决 4 的「5→6」口径与本实现一致）
        entry("core_compact_now", "core", "engine", true),
        // ── 用量监控与时序分析面（usage_*）──
        entry("usage_get_dashboard_data", "usage", "gui", true),
        entry("usage_get_activity_matrix", "usage", "gui", true),
        entry("usage_clear_history", "usage", "gui", true),
        entry("usage_record_delta", "usage", "gui", true),
        entry("usage_import_legacy_snapshot", "usage", "gui", true),
        // ── 偏好持久化（Token 与偏好 SSOT 战役 N3）──
        entry("prefs_get", "preferences", "engine", true),
        entry("prefs_set", "preferences", "engine", true),
        entry("prefs_delete", "preferences", "engine", true),
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
    ///   后 143 → **135**；
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
            total, 135,
            "总数 135（单轨收敛：能力字典读面 +1 → 143，真漂移退役 8 条 → 135；与前端 commandMap 同步）"
        );
        assert_eq!(
            registered, 135,
            "注册面 135（全部为 registered=true 实装命令）"
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
        ] {
            assert!(
                by_name.contains_key(name),
                "{name} 必须登记 manifest（PE-07 接线面）"
            );
            assert!(by_name[name].registered, "{name} 已接线应 registered=true");
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
            assert_eq!(entry.surface, "gui", "{name} 属 gui 契约面（WebView 直调读取）");
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
    }
}
