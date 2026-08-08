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
