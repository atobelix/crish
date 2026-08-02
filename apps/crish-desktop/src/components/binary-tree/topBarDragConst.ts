/**
 * useTopBarDrag 拖拽常量：body 拖拽态类名 / 会话 ghost 的占位 panelId。
 * 从 useTopBarDrag.ts 抽出，供壳 hook 与规划层共用。
 */

/** 拖拽期间挂在 body 上的类名（隐藏全局指针事件干扰） */
export const TOP_BAR_DRAG_BODY_CLASS = 'topbar-dragging';

/** 会话标签拖拽用特殊 draggedSource：panelId='chat' 让 DropZoneOverlay 能渲染 ghost */
export const SESSION_DRAG_GHOST_PANEL_ID = 'chat';

/** 会话 ghost 标签 DOM 类名（命中测试时临时隐藏） */
export const TOP_BAR_GHOST_CLASS = 'topbar-drag-ghost';
