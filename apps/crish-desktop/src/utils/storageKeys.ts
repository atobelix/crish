/** @file 所有 localStorage / sessionStorage / IndexedDB / BroadcastChannel / Lock key 的命名导出常量 */

// ── crish_ 前缀 localStorage keys ──────────────────────────────────────────

/** Agent 配置列表（最近 24 条） */
export const AGENT_PROFILES_KEY = 'crish_agent_profiles_v1';
/** 应用模式：'demo' | 'normal' */
export const APP_MODE_KEY = 'crish_app_mode';
/** Composer 草稿 JSON（beforeunload 同步持久化） */
export const COMPOSER_DRAFTS_KEY = 'crish_composer_drafts_v1';
/** 命令权限白名单 */
export const COMMAND_PERMISSIONS_KEY = 'crish_command_permissions_v1';
/** Demo 定时任务列表 */
export const CRON_KEY = 'crish_cron';
/** Daemon WebSocket 地址（用户覆盖） */
export const DAEMON_WS_KEY = 'crish_daemon_ws';
/** 未发送错误队列 */
export const ERROR_QUEUE_KEY = 'crish_error_queue_v1';
/** 已安装扩展目录 id 集合 */
export const EXTENSION_CATALOG_INSTALLED_KEY = 'crish_extension_catalog_installed_v1';
/** 首次运行标记（createSsrGlobals 版） */
export const FIRST_RUN_DONE_KEY = 'crish_first_run_done';
/** 首次运行向导标记（组件版） */
export const FIRST_RUN_DONE_V1_KEY = 'crish_first_run_done_v1';
/** 字体偏好（独立 key，冷启动同步） */
export const FONTS_KEY = 'crish_fonts';
/** 字体大小微调值 */
export const FONT_SIZE_ADJUST_KEY = 'crish_font_size_adjust';
/** Demo MCP 服务器列表 */
export const MCP_KEY = 'crish_mcp';
/** MCP 工具禁用缓存 */
export const MCP_TOOL_DISABLED_CACHE_KEY = 'crish_mcp_tool_disabled_cache_v1';
/** 模型目录元数据 */
export const MODEL_META_KEY = 'crish_model_meta_v1';
/** 模型价格缓存 */
export const MODEL_PRICES_KEY = 'crish_model_prices_v1';
/** 当前打开的会话 tab id 列表 */
export const OPEN_SESSION_TABS_KEY = 'crish_open_session_tabs_v1';
/** 权限模式（契约：localStorage crish_permission_mode 供 ENGINE-RUN + LS 读） */
export const PERMISSION_MODE_KEY = 'crish_permission_mode';
/** 预览浏览器当前 URL */
export const PREVIEW_URL_KEY = 'crish_preview_url_v1';
/** 预览浏览器历史记录 */
export const PREVIEW_HISTORY_KEY = 'crish_preview_history_v1';
/** 预览浏览器书签 */
export const PREVIEW_BOOKMARKS_KEY = 'crish_preview_bookmarks_v1';
/** 是否 product shell 模式（Tauri） */
export const PRODUCT_SHELL_KEY = 'crish_product_shell';
/** 项目列表 */
export const PROJECTS_KEY = 'crish_projects_v1';
/** 当前激活项目 id */
export const ACTIVE_PROJECT_ID_KEY = 'crish_active_project_id';
/** 项目路径 → id 别名映射（幽灵项目恢复） */
export const PROJECT_FOLDER_ALIASES_KEY = 'crish_project_folder_aliases_v1';
/** 项目设置 JSON（cwd 维度） */
export function projectSettingsKey(cwd: string): string {
  return `crish_project_settings_${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`;
}
/** Demo provider 列表 */
export const PROVIDERS_KEY = 'crish_providers';
/** 最近选择模型 */
export const RECENT_MODELS_KEY = 'crish_recent_models';
/** 会话磁盘镜像元数据 */
export const SESSION_DISK_MIRROR_KEY = 'crish_session_disk_mirror_v1';
/** 会话搜索查询 */
export const SESSION_SEARCH_QUERY_KEY = 'crish_session_search_query';
/** 全局设置 JSON */
export const SETTINGS_KEY = 'crish_settings';
/** Shell Chrome 模式 */
export const SHELL_CHROME_KEY = 'crish_shell_chrome';
/** 快捷键覆盖 */
export const SHORTCUT_OVERRIDES_KEY = 'crish_shortcut_overrides';
/** 显示引擎设置标志 */
export const SHOW_ENGINE_SETTINGS_KEY = 'crish_show_engine_settings';
/** 侧栏折叠状态 */
export const SIDEBAR_COLLAPSED_KEY = 'crish_sidebar_collapsed';
/** 技能激活状态 */
export const SKILL_ACTIVATION_KEY = 'crish_skill_activation_v1';
/** 技能额外搜索目录 */
export const SKILL_EXTRA_DIRS_KEY = 'crish_skill_extra_dirs_v1';
/** Tab 模式（0=关闭，1=开启） */
export const TAB_MODE_KEY = 'crish_tab_mode';
/** 主题模式：'default' | 'dark' */
export const THEME_KEY = 'crish_theme';
/** 主题色板 */
export const THEME_SKIN_KEY = 'crish_theme_skin';
/** 主题自定义背景色 */
export const THEME_CUSTOM_BG_KEY = 'crish_theme_custom_bg';
/** 主题自定义前景色 */
export const THEME_CUSTOM_FG_KEY = 'crish_theme_custom_fg';
/** 主题亮度微调（-5 ~ +5） */
export const THEME_BRIGHTNESS_ADJUST_KEY = 'crish_theme_brightness_adjust';
/** 主题氛围色彩融合开关 */
export const THEME_BRIGHTNESS_VIBRANT_KEY = 'crish_theme_brightness_vibrant';
/** 主题智能时光温感过渡开关 */
export const THEME_BRIGHTNESS_AUTO_TIME_KEY = 'crish_theme_brightness_auto_time';
/** UI 密度：'small' | 'medium' | 'large' */
export const UI_SIZE_KEY = 'crish_ui_size';
/** 更新可用标记 */
export const UPDATE_AVAILABLE_KEY = 'crish_update_available';
/** 用量历史 JSON */
export const USAGE_HISTORY_KEY = 'crish_usage_history_v1';
/** 强制 mock 模式标志 */
export const USE_MOCK_KEY = 'crish_use_mock';
/** 当前工作区路径 */
export const WORKSPACE_KEY = 'crish_workspace';
/** 工作区布局快照（按项目路径索引） */
export const WORKSPACE_LAYOUT_KEY = 'crish_workspace_layout_v1';
/** 本会话已自定义布局的项目路径集合 */
export const WS_LAYOUT_CUSTOMIZED_KEY = 'crish_ws_layout_session_customized_v1';
/** 本会话已应用布局的项目路径 */
export const WS_LAYOUT_APPLIED_KEY = 'crish_ws_layout_session_applied_v1';

// ── crish_ 前缀 sessionStorage keys ───────────────────────────────────────

/** Composer 种子文案 */
export const COMPOSER_SEED_KEY = 'crish_composer_seed_v1';
/** 工具列状态快照（宽度 + 激活卡 id，session 内可恢复） */
export function toolColStateKey(wsId: string): string {
  return `crish_tool_col_state_v1:${wsId}`;
}
/** 兼容旧版仅宽度 key */
export function toolColWidthKey(wsId: string): string {
  return `crish_tool_col_w_v1:${wsId}`;
}

// ── conex_ 前缀（旧版 Pi 体系）legacy keys ────────────────────────────────

/** 旧版设置 JSON（迁移用） */
export const SETTINGS_KEY_LEGACY = 'conex_pi_settings';
/** 旧版 provider 列表（迁移用） */
export const PROVIDERS_KEY_LEGACY = 'conex_pi_providers';
/** 旧版定时任务（迁移用） */
export const CRON_KEY_LEGACY = 'conex_pi_cron';
/** 旧版 MCP 列表（迁移用） */
export const MCP_KEY_LEGACY = 'conex_pi_mcp';
/** 自定义快捷键绑定 */
export const CUSTOM_SHORTCUTS_KEY = 'conex_custom_shortcuts';

// ── __crish_ 前缀（IndexedDB 临时库名，仅基准测试用）──────────────────────

export function storageBenchDbName(): string {
  return '__crish_storage_bench_' + Date.now();
}
export function latencyBenchDbName(): string {
  return '__crish_latency_' + Date.now();
}

// ── 非 localStorage 存储标识 ───────────────────────────────────────────────

/** IndexedDB 同步库名 */
export const SYNC_DB_NAME = 'crish-sync' as const;
/** Sync DB 版本号 */
export const SYNC_DB_VERSION = 1;
/** BroadcastChannel 跨标签通信频道名 */
export const CROSS_TAB_CHANNEL_NAME = 'crish-cross-tab' as const;
/** 设置写入互斥锁名 */
export const SETTINGS_LOCK_NAME = 'crish-settings-write' as const;
/** 跨标签页 Leader 选举 key（localStorage） */
export const CROSS_TAB_LEADER_KEY = 'crish_cross_tab_leader';
