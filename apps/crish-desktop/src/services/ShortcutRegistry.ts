/**
 * 快捷键注册表。
 *
 * 定义所有内置快捷键的元数据（ShortcutMeta）以及平台覆盖支持。
 */

export interface ShortcutMeta {
  id: string;
  defaultBinding: string;      // 如 "Ctrl + N", "Escape Escape"
  category: 'navigation' | 'editor' | 'panel' | 'session' | 'system';
  label: string;                // 中文标签
  keywords: string[];           // 搜索关键词
  platforms?: { mac?: string; win?: string }; // 平台覆盖
}

/** 全部内置快捷键注册表 */
export const BUILTIN_SHORTCUTS: ShortcutMeta[] = [
  { id: 'toggle_settings',   defaultBinding: 'Ctrl + ,',          category: 'navigation', label: '打开设置',        keywords: ['设置', '偏好'] },
  { id: 'new_session',       defaultBinding: 'Ctrl + N',          category: 'session',    label: '新建会话',        keywords: ['新会话', '新建'] },
  { id: 'focus_composer',    defaultBinding: 'Ctrl + L',          category: 'editor',     label: '聚焦输入框',      keywords: ['输入', '聚焦'] },
  { id: 'stop_generation',   defaultBinding: 'Ctrl + Shift + Backspace', category: 'editor', label: '停止生成',   keywords: ['停止', '中断'] },
  { id: 'branch_session',    defaultBinding: 'Escape Escape',     category: 'session',    label: '分叉会话',        keywords: ['分叉', '分支'] },
  { id: 'toggle_sidebar',    defaultBinding: 'Ctrl + B',          category: 'navigation', label: '切换侧栏',        keywords: ['侧栏', '侧边栏'] },
  { id: 'cheatsheet',        defaultBinding: 'Ctrl + Shift + /',  category: 'navigation', label: '快捷键帮助',      keywords: ['帮助', '快捷键'] },
  { id: 'open_models',       defaultBinding: 'Ctrl + Shift + M',  category: 'panel',      label: '模型设置',        keywords: ['模型', 'AI'] },
  { id: 'open_usage',        defaultBinding: 'Ctrl + Shift + U',  category: 'panel',      label: '用量统计',        keywords: ['用量', '统计'] },
  { id: 'open_security',     defaultBinding: 'Ctrl + Shift + S',  category: 'panel',      label: '安全设置',        keywords: ['安全', '权限'] },
  { id: 'open_shortcuts',    defaultBinding: 'Ctrl + Shift + K',  category: 'panel',      label: '快捷键设置',      keywords: ['快捷键', '键盘'] },
  { id: 'command_palette',   defaultBinding: '/',                 category: 'editor',     label: '命令面板',        keywords: ['命令', '命令行'] },
  { id: 'toggle_plan_mode',  defaultBinding: 'Ctrl + Shift + P',  category: 'system',     label: '切换计划模式',    keywords: ['计划', '规划'] },
  { id: 'toggle_runtime',    defaultBinding: 'Ctrl + Shift + R',  category: 'panel',      label: '运行面板',        keywords: ['运行', '状态'] },
];
