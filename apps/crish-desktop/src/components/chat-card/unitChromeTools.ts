/**
 * 坞头工具清单（总览 / 文件 / 差异 / 终端 / 笔记）。
 * 属于右坞 / 工具叶 chrome，不属于对话顶快捷行。
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
