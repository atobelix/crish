/** @file 所有 `crish-*` DOM CustomEvent 命名导出常量，按迁移状态分组 */

// ── 已迁移到 UiEventMap（通过 emitUiEvent / onUiEvent 类型化总线）────────
// 派发时自动加 crish- 前缀，与下方裸事件双向兼容。
// 见 src/api/uiEvents.ts → UiEventMap / UI_EVENT_NAMES

/** 当前项目已切换（载荷：void） */
export const EVENT_PROJECT_CHANGED = 'crish-project-changed';
/** 打开项目选择器 */
export const EVENT_OPEN_PROJECT_PICKER = 'crish-open-project-picker';
/** 打开定时任务面板 */
export const EVENT_OPEN_SCHEDULED = 'crish-open-scheduled';
/** 打开对话面板 */
export const EVENT_OPEN_CHAT = 'crish-open-chat';
/** 打开总览面板 */
export const EVENT_OPEN_OVERVIEW = 'crish-open-overview';
/** 打开任务面板 */
export const EVENT_OPEN_TASKS = 'crish-open-tasks';
/** 选取工作区 */
export const EVENT_PICK_WORKSPACE = 'crish-pick-workspace';
/** 打开 Agent 侧栏（载荷：{ agentId?: string }） */
export const EVENT_OPEN_AGENT_PANEL = 'crish-open-agent-panel';
/** 更新可用状态变更 */
export const EVENT_UPDATE_CHANGED = 'crish-update-changed';
/** 切换消息过滤条 */
export const EVENT_TOGGLE_MSG_FILTER = 'crish-toggle-msg-filter';
/** 导出当前会话为 Markdown */
export const EVENT_EXPORT_SESSION_MD = 'crish-export-session-md';
/** 活动模型已切换（载荷：{ profileId: string; model: string }） */
export const EVENT_MODEL_CHANGED = 'crish-model-changed';
/** 服务商列表/密钥/模型表变更 */
export const EVENT_PROFILES_CHANGED = 'crish-profiles-changed';
/** 聚焦主对话输入框 */
export const EVENT_FOCUS_COMPOSER = 'crish-focus-composer';
/** 中断当前生成 */
export const EVENT_STOP_GENERATION = 'crish-stop-generation';

// ── 未迁移的裸 CustomEvent（直接 window.addEventListener/dispatchEvent）───
// 这些事件尚未纳入 UiEventMap，使用原始 DOM API。

/** 当前项目已切换（冗余，部分旧组件直接监听此事件而非总线） */
export const EVENT_PROJECT_CHANGED_LEGACY = 'crish-project-changed';
/** 打开终端面板 */
export const EVENT_OPEN_TERMINAL = 'crish-open-terminal';
/** 打开指定文件（载荷：{ path: string }） */
export const EVENT_OPEN_FILE = 'crish-open-file';
/** 终端追加行（载荷：{ text: string; sessionId?: string }） */
export const EVENT_TERMINAL_APPEND = 'crish-terminal-append';
/** 文件标注变更 */
export const EVENT_FILE_ANNOTATIONS_CHANGED = 'crish-file-annotations-changed';
/** Git 状态变更 */
export const EVENT_GIT_STATUS_CHANGED = 'crish-git-status-changed';
/** 预览 URL 更新 */
export const EVENT_PREVIEW_URL = 'crish-preview-url';
/** 预览书签更新 */
export const EVENT_PREVIEW_BOOKMARKS = 'crish-preview-bookmarks';
/** 预览历史更新 */
export const EVENT_PREVIEW_HISTORY = 'crish-preview-history';
/** 主题已切换（载荷：{ theme: UiTheme }） */
export const EVENT_THEME_CHANGED = 'crish-theme-changed';
/** 字体偏好已更新（载荷：FontPreferences） */
export const EVENT_FONTS_CHANGED = 'crish-fonts-changed';
/** 技能列表已变更 */
export const EVENT_SKILLS_CHANGED = 'crish-skills-changed';
/** 侧栏宽度已调整 */
export const EVENT_SIDEBAR_RESIZE = 'crish-sidebar-resize';
/** 聚焦对话面板（载荷：{ sessionId: string }） */
export const EVENT_FOCUS_CHAT = 'crish-focus-chat';
/** Composer 种子文案就绪（载荷：{ text: string }；sessionStorage 通道） */
export const EVENT_COMPOSER_SEED = 'crish-composer-seed';
/** 打开 Agent 面板（冗余，部分旧入口直接派发此事件） */
export const EVENT_OPEN_AGENT_PANEL_LEGACY = 'crish-open-agent-panel';

// ── 分组索引 ───────────────────────────────────────────────────────────────

/** 已迁移到 UiEventMap 的事件名列表（15 个） */
export const MIGRATED_EVENT_NAMES = [
  EVENT_PROJECT_CHANGED,
  EVENT_OPEN_PROJECT_PICKER,
  EVENT_OPEN_SCHEDULED,
  EVENT_OPEN_CHAT,
  EVENT_OPEN_OVERVIEW,
  EVENT_OPEN_TASKS,
  EVENT_PICK_WORKSPACE,
  EVENT_OPEN_AGENT_PANEL,
  EVENT_UPDATE_CHANGED,
  EVENT_TOGGLE_MSG_FILTER,
  EVENT_EXPORT_SESSION_MD,
  EVENT_MODEL_CHANGED,
  EVENT_PROFILES_CHANGED,
  EVENT_FOCUS_COMPOSER,
  EVENT_STOP_GENERATION,
] as const;

/** 未迁移的裸事件名列表（16 个） */
export const LEGACY_EVENT_NAMES = [
  EVENT_OPEN_TERMINAL,
  EVENT_OPEN_FILE,
  EVENT_TERMINAL_APPEND,
  EVENT_FILE_ANNOTATIONS_CHANGED,
  EVENT_GIT_STATUS_CHANGED,
  EVENT_PREVIEW_URL,
  EVENT_PREVIEW_BOOKMARKS,
  EVENT_PREVIEW_HISTORY,
  EVENT_THEME_CHANGED,
  EVENT_FONTS_CHANGED,
  EVENT_SKILLS_CHANGED,
  EVENT_SIDEBAR_RESIZE,
  EVENT_FOCUS_CHAT,
  EVENT_COMPOSER_SEED,
  EVENT_OPEN_AGENT_PANEL_LEGACY,
  EVENT_PROJECT_CHANGED_LEGACY,
] as const;

/** 全部 crish-* 事件名 */
export const ALL_EVENT_NAMES = [
  ...MIGRATED_EVENT_NAMES,
  ...LEGACY_EVENT_NAMES.filter((n) => !MIGRATED_EVENT_NAMES.includes(n as any)),
] as const;
