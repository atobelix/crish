/**
 * 命令类型 → 语义图标名最小映射（决策 12 · 最小映射，V1-γ）。
 * 经 AppIcon 渲染；不接安全判定、不做插件化注册表。
 */
import type { IconName } from '../../components/ui/icons';
import type { ToolCommandKind } from './toolCommandType';

/** kind → 语义图标名（每 kind 一个；与 toolCommandType 的 15 轴一一对应） */
export const TOOL_COMMAND_ICONS: Record<ToolCommandKind, IconName> = {
  shell: 'terminal',
  network: 'globe',
  mcp: 'plug',
  task: 'list-checks',
  read: 'file-search',
  write: 'file-plus',
  edit: 'file-edit',
  workspace: 'folder-cog',
  delete: 'trash',
  list: 'folder-open',
  search: 'search',
  subagent: 'bot',
  timer: 'timer',
  note: 'notebook-pen',
  misc: 'wrench',
};

/** kind → 语义图标名（misc 兜底） */
export function toolCommandIcon(kind: ToolCommandKind): IconName {
  return TOOL_COMMAND_ICONS[kind] ?? 'wrench';
}
