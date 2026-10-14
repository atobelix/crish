/** @file 所有 localStorage / sessionStorage / IndexedDB / BroadcastChannel / Lock key 的命名导出常量 */

// ── crish_ 前缀 localStorage keys（当前有消费方的）─────────────────────────

/** 显示引擎设置标志 */
export const SHOW_ENGINE_SETTINGS_KEY = 'crish_show_engine_settings';
/** Dev 角落 controlMetrics 健康条（D2-3）；值为 '1' 时启用 */
export const DEV_HEALTH_LS_KEY = 'crish_dev_health';
/** 外部会话导入：自定义 Claude Code 配置根目录（非默认 ~/.claude） */
export const IMPORT_CLAUDE_ROOT_KEY = 'crish_import_claude_root';
/** 外部会话导入：自定义 Codex 配置根目录（非默认 ~/.codex） */
export const IMPORT_CODEX_ROOT_KEY = 'crish_import_codex_root';

/** 检测到外部长对话后自动接续开关（读取/写入统一经 api/import/importRootSettings） */
export const IMPORT_AUTO_SYNC_ENABLED_KEY = 'crish_auto_sync_external_sessions';

// ── 运行期临时缓存与非偏好状态 keys ──────────────────────────────────────────

/** 首次运行向导完成标志 */
export const FIRST_RUN_DONE_KEY = 'crish_first_run_done_v1';
/** 系统字体全量扫描瘦身缓存 */
export const LOCAL_FONTS_CACHE_KEY = 'crish_local_fonts_cache_v1';
/** 定时任务/工作流列表离线缓存 */
export const WORKFLOWS_CACHE_KEY = 'crish_workflows_cache_v1';
/** 工作流运行记录离线缓存 */
export const WORKFLOW_RUNS_CACHE_KEY = 'crish_workflow_runs_cache_v1';
/** 插件启停状态集合 */
export const PLUGIN_ENABLED_KEY = 'crish_plugin_enabled_v1';
/** MCP 服务列表缓存 */
export const MCP_SERVERS_CACHE_KEY = 'crish_mcp_servers_cache_v1';
/** Skills 技能列表缓存 */
export const SKILLS_CACHE_KEY = 'crish_skills_cache_v1';
/** 已识别技能 ID 集合 */
export const SKILL_KNOWN_IDS_KEY = 'crish_skill_known_ids_v1';
/** Note 页面应急草稿暂存前缀 */
export const NOTE_EMERGENCY_DRAFT_PREFIX = 'crish_note_emergency_draft_';
