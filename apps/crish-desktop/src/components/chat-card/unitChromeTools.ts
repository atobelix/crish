/**
 * 会话工具清单（总览 / 文件 / 差异 / 终端 / 笔记）。
 * 对话顶快捷行与坞头共用；双表面可以，不能只留坞头。
 */
import {
  FolderTree,
  GitBranch,
  Terminal,
  LayoutDashboard,
  FileText,
} from 'lucide-react';

export const UNIT_TOOL_PANELS = [
  {
    id: 'overview',
    label: '打开总览',
    testId: 'chat-open-overview',
    Icon: LayoutDashboard,
  },
  {
    id: 'files',
    label: '打开文件',
    testId: 'chat-open-files',
    Icon: FolderTree,
  },
  {
    id: 'diff',
    label: '打开差异',
    testId: 'chat-open-diff',
    Icon: GitBranch,
  },
  {
    id: 'terminal',
    label: '打开终端',
    testId: 'chat-open-terminal',
    Icon: Terminal,
  },
  {
    id: 'note',
    label: '打开笔记',
    testId: 'chat-open-note',
    Icon: FileText,
  },
] as const;

export type UnitToolPanelId = (typeof UNIT_TOOL_PANELS)[number]['id'];
