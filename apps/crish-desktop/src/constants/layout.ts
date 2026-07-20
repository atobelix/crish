// ── 侧栏（参考值，CSS token --sidebar-width 为权威来源）──
export const SIDEBAR_WIDTH_DEFAULT = 260; // 镜像 CSS token，修改时同步 tokens.css
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 360;
export const SIDEBAR_RESIZE_STEP = 12;
export const SIDEBAR_RESIZE_STEP_LARGE = 24;

// ── 列宽比例 ──
export const COLUMN_RATIO_MIN = 0.13;
export const COLUMN_RATIO_TOOL_DEFAULT = 0.34;
export const COLUMN_RATIO_CHAT_DEFAULT = 0.66;
export const COLUMN_RATIO_TOOL_COLLAPSED_DETECT = 0.04;
export const COLUMN_RATIO_TOOL_EXPANDED_DETECT = 0.08;
export const COLUMN_RATIO_PERSIST_MIN = 0.15;
export const COLUMN_RATIO_PERSIST_MAX = 0.7;

// ── 菜单/浮层 ──
export const DROPDOWN_HEIGHT_MAX = 360;
export const DROPDOWN_HEIGHT_MIN = 120;
export const DROPDOWN_WIDTH_MIN = 160;
export const DROPDOWN_WIDTH_MAX = 280;
export const CONTEXT_MENU_EST_W = 160;
export const CONTEXT_MENU_EST_H = 280;
export const FALLBACK_VIEWPORT_W = 1280;
export const FALLBACK_VIEWPORT_H = 800;

// ── DnD ──
export const SPLIT_EDGE_PADDING_X = 48;
export const SPLIT_EDGE_PADDING_Y = 36;
export const CHAT_COL_LEFT_ZONE = 0.45;
export const CHAT_COL_RIGHT_ZONE = 0.55;
export const DEFAULT_TAB_BAR_H = 36;

// ── 消息列表 ──
export const DEFAULT_RECENT_MESSAGE_COUNT = 80;
export const EXPAND_OLDER_STEP = 40;
export const MESSAGE_ESTIMATED_ROW_HEIGHT = 120;
export const MESSAGE_VIEWPORT_OVERSCAN = 6;
export const MESSAGE_VIEWPORT_THRESHOLD = 60;

// ── 侧栏会话列表 ──
export const SIDEBAR_SESSION_ROW_HEIGHT = 28;
export const SIDEBAR_WINDOW_THRESHOLD = 48;
export const SIDEBAR_WINDOW_OVERSCAN = 8;

// ── 终端 ──
export const TERMINAL_HARD_MAX = 800;
export const TERMINAL_TRIM_TO = 600;
