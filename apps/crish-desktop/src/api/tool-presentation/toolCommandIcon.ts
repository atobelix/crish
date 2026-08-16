/**
 * 命令类型 → lucide 图标最小映射表（决策 12 · 最小映射，V1-γ）。
 *
 * 只做「toolDomainDescriptions 域的 kind→图标」一张最小表：
 * - 不接安全判定（安全判定归引擎权威，决策 4）；
 * - 不建插件化 icon 注册表；
 * - 不做数十种图标膨胀——每 kind 恰一个图标，misc 兜底。
 */

import {
  Bot,
  FileEdit,
  FilePlus,
  FileSearch,
  FolderCog,
  FolderOpen,
  Globe,
  ListChecks,
  NotebookPen,
  Plug,
  Search,
  Terminal,
  Timer,
  Trash2,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ToolCommandKind } from './toolCommandType';

/** kind → 图标最小表（每 kind 一个；与 toolCommandType 的 15 轴一一对应） */
export const TOOL_COMMAND_ICONS: Record<ToolCommandKind, LucideIcon> = {
  shell: Terminal,
  network: Globe,
  mcp: Plug,
  task: ListChecks,
  read: FileSearch,
  write: FilePlus,
  edit: FileEdit,
  workspace: FolderCog,
  delete: Trash2,
  list: FolderOpen,
  search: Search,
  subagent: Bot,
  timer: Timer,
  note: NotebookPen,
  misc: Wrench,
};

/** kind → 图标（misc/Wrench 兜底，识别不出 kind 时语义不冲突） */
export function toolCommandIcon(kind: ToolCommandKind): LucideIcon {
  return TOOL_COMMAND_ICONS[kind] ?? Wrench;
}
