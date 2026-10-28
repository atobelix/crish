/**
 * 快捷键注册表。
 *
 * 定义所有内置快捷键的元数据（ShortcutMeta）以及平台覆盖支持。
 */

export interface ShortcutMeta {
  id: string;
  defaultBinding: string; // 如 "Ctrl + N", "Escape Escape"
  category: 'navigation' | 'editor' | 'panel' | 'session' | 'system';
  label: string; // 中文标签
  keywords: string[]; // 搜索关键词
  platforms?: { mac?: string; win?: string }; // 平台覆盖
  context?: 'global' | 'chat' | 'settings' | 'sidebar' | 'diff';
  priority?: number; // higher = wins when multiple bindings match (default 0)
}

/**
 * 全部内置快捷键注册表（快捷键的唯一默认真源）。
 *
 * 消费方约定：
 * - AppShortcuts.ts 的 onMatch 执行面必须与本表一一对应（T2-5 有 fs 契约断言双向覆盖）；
 * - 设置页 SettingsShortcutsTab 的展示数据从此表派生，禁止静态副本；
 * - 退役登记：本表无『注册但无执行面』的键——曾有的 toggle_runtime（无 handler）
 *   与 command_palette（无 handler）已按 U-6 原则从本表移除；恢复前必须先在 AppShortcuts 接线。
 */
export const BUILTIN_SHORTCUTS: ShortcutMeta[] = [
  {
    id: 'toggle_settings',
    defaultBinding: 'Ctrl + ,',
    category: 'navigation',
    label: '打开设置',
    keywords: ['设置', '偏好'],
  },
  {
    id: 'new_session',
    defaultBinding: 'Ctrl + N',
    category: 'session',
    label: '新建对话',
    keywords: ['新对话', '新建'],
  },
  {
    id: 'focus_composer',
    defaultBinding: 'Ctrl + L',
    category: 'editor',
    label: '聚焦输入框',
    keywords: ['输入', '聚焦'],
  },
  {
    id: 'stop_generation',
    defaultBinding: 'Ctrl + Shift + Backspace',
    category: 'editor',
    label: '停止生成',
    keywords: ['停止', '中断'],
  },
  {
    id: 'branch_session',
    defaultBinding: 'Ctrl + Shift + F',
    category: 'session',
    label: '分支对话',
    keywords: ['分叉', '分支'],
  },
  {
    id: 'toggle_sidebar',
    defaultBinding: 'Ctrl + B',
    category: 'navigation',
    label: '切换侧栏',
    keywords: ['侧栏', '侧边栏'],
  },
  {
    id: 'open_models',
    defaultBinding: 'Ctrl + Shift + M',
    category: 'panel',
    label: '模型设置',
    keywords: ['模型', 'AI'],
  },
  {
    id: 'open_usage',
    defaultBinding: 'Ctrl + Shift + U',
    category: 'panel',
    label: '用量统计',
    keywords: ['用量', '统计'],
  },
  {
    id: 'open_security',
    defaultBinding: 'Ctrl + Shift + S',
    category: 'panel',
    label: '安全设置',
    keywords: ['安全', '权限'],
  },
  {
    id: 'open_shortcuts',
    defaultBinding: 'Ctrl + Shift + K',
    category: 'panel',
    label: '快捷键设置',
    keywords: ['快捷键', '键盘'],
  },
  {
    id: 'open_extensions',
    defaultBinding: 'Ctrl + Shift + X',
    category: 'panel',
    label: '扩展设置',
    keywords: ['扩展', '插件', 'MCP', '技能'],
  },
  {
    id: 'open_schedule',
    defaultBinding: 'Ctrl + Shift + J',
    category: 'panel',
    label: '定时任务',
    keywords: ['定时', '计划', 'cron'],
  },
  {
    id: 'export_logs',
    defaultBinding: 'Ctrl + Shift + L',
    category: 'system',
    label: '导出诊断日志',
    keywords: ['日志', '诊断', '导出', 'telemetry'],
  },
];
