/**
 * 设置 tab 元数据数据文件：10 个侧栏 tab 的中文标签 / 图标 / 分组 / 搜索别名。
 * 纯数据 + 搜索匹配纯函数；从 SettingsPanel.tsx TAB_META（L115-217）抽出。
 */
import * as Lucide from 'lucide-react';
import type { SettingsTabType } from '../store/types';

export type TabType = SettingsTabType;

export type TabMeta = {
  id: TabType;
  /** 中文侧栏标签 */
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  /** 中文分组 */
  group: string;
  /** 搜索别名：中文同义词 + 常见英文缩写，便于键盘/搜索定位 */
  keywords: string[];
  demoOnly?: boolean;
};

/**
 * 侧栏可见 formal tabs。
 * 技能 / MCP / 插件仅在「扩展」一页；旧 id skills|mcp 仍合法，解析时归入 plugins。
 */
const FORMAL_TAB_IDS: TabType[] = [
  'profile',
  'appearance',
  'personalize',
  'models',
  'usage',
  'rules',
  'schedule',
  'plugins',
  'shortcuts',
  'security',
];

export function allowedTabIds(_mcpAvailable: boolean): TabType[] {
  return [...FORMAL_TAB_IDS];
}

/** 深链/旧入口：skills|mcp → 扩展中心 */
export function normalizeSettingsTabId(raw: string | null | undefined): TabType | null {
  if (!raw) return null;
  if (raw === 'skills' || raw === 'mcp') return 'plugins';
  if ((FORMAL_TAB_IDS as readonly string[]).includes(raw)) return raw as TabType;
  // 兼容：仍允许内部挂载 skills/mcp（扩展内嵌），但不在侧栏展示
  if (raw === 'plugins') return 'plugins';
  return null;
}

export const TAB_META: TabMeta[] = [
  {
    id: 'profile',
    label: '账户',
    icon: Lucide.User,
    group: '个人',
    keywords: [
      '账户',
      '账号',
      '个人资料',
      '工作区',
      '导出',
      '导入',
      '外部对话',
      'Claude',
      'Codex',
      'profile',
      'account',
      'UserView',
      '投影',
      'debug',
      '调试',
    ],
  },
  {
    id: 'appearance',
    label: '外观',
    icon: Lucide.Palette,
    group: '个人',
    keywords: ['外观', '主题', '深色', '浅色', '字体', '密度', 'theme', 'appearance', 'font'],
  },
  {
    id: 'personalize',
    label: '通用设置',
    icon: Lucide.SlidersHorizontal,
    group: '个人',
    keywords: ['通用设置', '偏好', '交互', '标签页', 'personalize', 'preference', 'general'],
  },
  {
    id: 'models',
    label: '模型',
    icon: Lucide.Orbit,
    group: '智能',
    keywords: ['模型', '供应商', '密钥', 'API', 'llm', 'model', 'provider', 'openai', 'claude'],
  },
  {
    id: 'usage',
    label: '用量',
    icon: Lucide.PieChart,
    group: '智能',
    keywords: ['用量', '用量统计', 'token', '费用', 'usage', 'quota'],
  },
  {
    id: 'rules',
    label: '规则',
    icon: Lucide.FileText,
    group: '智能',
    keywords: ['规则', '指令', '系统提示', 'rules', 'prompt', 'agent'],
  },
  {
    id: 'schedule',
    label: '定时任务',
    icon: Lucide.Clock,
    group: '工作',
    keywords: ['定时', '定时任务', '计划', 'cron', 'schedule', '任务'],
  },
  {
    id: 'plugins',
    label: '扩展',
    icon: Lucide.Puzzle,
    group: '工作',
    keywords: [
      '扩展',
      '插件',
      'MCP',
      'mcp',
      '技能',
      'skill',
      'skills',
      '商店',
      '官方',
      '三方',
      'package',
      'plugin',
      'marketplace',
      '能力包',
    ],
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    icon: Lucide.Command,
    group: '工作',
    keywords: ['快捷键', '键盘', '热键', 'shortcuts', 'hotkey', 'keymap'],
  },
  {
    id: 'security',
    label: '安全',
    icon: Lucide.Lock,
    group: '安全',
    keywords: ['安全', '权限', '白名单', '信任', 'security', 'permission', 'allowlist'],
  },
];

export const FALLBACK_TAB_META: TabMeta = {
  id: 'profile',
  label: '账户',
  icon: Lucide.User,
  group: '个人',
  keywords: ['账户'],
};

export function tabMatchesQuery(tab: TabMeta, q: string): boolean {
  if (!q) return true;
  if (tab.label.toLowerCase().includes(q)) return true;
  if (tab.group.toLowerCase().includes(q)) return true;
  if (tab.id.toLowerCase().includes(q)) return true;
  return tab.keywords.some((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase()));
}
