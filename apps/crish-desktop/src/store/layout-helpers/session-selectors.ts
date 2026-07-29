import { isDemoMode } from '../../api/appMode';
import { hydrateSessionsFromDisk } from '../../api/sessionPersistence';
import { GENERAL_FOLDER } from '../../api/projectStore';
import { normalizeAssistantTimeline } from '../../api/toolPresentation';
import { fillDefaultSessionTitles, pruneEmptyShellSessions } from '../../api/sessionTitle';
import type { SessionState } from '../types';

export const DEFAULT_SESSIONS: SessionState[] = [
  {
    id: 'sess-1', title: '分析酒馆对话主界面问题', folder: '审计与代码分析',
    isPinned: false, isArchived: false, timestamp: '10分钟前',
    messages: [{ id: 'm1-1', sender: 'assistant', text: '你好！有什么关于酒馆对话界面的问题我可以帮您分析的？', timestamp: Date.now() - 600000 }],
  },
  {
    id: 'sess-2', title: '审计三个项目的代码统一性问题', folder: '审计与代码分析',
    isPinned: false, isArchived: false, timestamp: '1小时前',
    messages: [
      { id: 'msg-1', sender: 'user', text: 'Let me try directly creating a test trigger to isolate the issue.', timestamp: Date.now() - 3600000 },
      { id: 'msg-2', sender: 'assistant', text: 'The inline button DOES exist (1 found)! Let me find where it is:', timestamp: Date.now() - 3500000, toolCalls: [{ id: 'tc-grep-1', name: 'grep_search', arguments: 'data-crish-inline="1"', status: 'success', explanation: '在工作区搜索冲突的行内按钮标签 data-crish-inline="1"', output: 'Searching pattern "data-crish-inline=\\"1\\""...\nFound 1 match in trigger-injector.ts:\nLine 42: <button data-crish-inline="1">F</button>' }] },
      { id: 'msg-3', sender: 'assistant', text: 'Found the culprit!', timestamp: Date.now() - 3400000, toolCalls: [{ id: 'tc-grep-2', name: 'grep_search', arguments: 'crish-inline-style', status: 'success', explanation: '在整个工作区搜索 crish-inline-style 样式以排除命名冲突', output: 'Searching pattern "crish-inline-style"...\nFound 0 matches in workspace.' }] },
      { id: 'msg-4', sender: 'assistant', text: '找到根源了！', timestamp: Date.now() - 3200000, toolCalls: [{ id: 'tc-edit-1', name: 'write_to_file', arguments: 'trigger-injector.ts', status: 'success', explanation: '修改 trigger-injector.ts' }] },
      { id: 'msg-5', sender: 'assistant', text: 'Now rebuild and reload:', timestamp: Date.now() - 3000000, toolCalls: [{ id: 'tc-build-1', name: 'run_command', arguments: 'npm run dev', status: 'success', explanation: '运行打包命令 npm run dev 以验证编译与变更', output: 'vite building...' }] },
      { id: 'msg-6', sender: 'assistant', text: '我已经追踪到这个问题的根源了', timestamp: Date.now() - 2800000 },
    ],
  },
  {
    id: 'sess-3', title: 'Fix voice playback timing and overla', folder: '语音与播控',
    isPinned: false, isArchived: false, timestamp: '3天前',
    messages: [{ id: 'm3-1', sender: 'assistant', text: '你好！这里可以帮您调试和修复语音播控的相关延时问题。', timestamp: Date.now() - 250000000 }],
  },
  {
    id: 'sess-4', title: '定制菜单与滚动区域优化', folder: '常规会话',
    isPinned: false, isArchived: false, timestamp: '5天前',
    messages: [{ id: 'm4-1', sender: 'assistant', text: '你好！我可以协助您进行前端自定义菜单和隐藏滚动条样式的优化设计。', timestamp: Date.now() - 400000000 }],
  },
  {
    id: 'sess-5', title: '添加终端与主题扩展', folder: '常规会话',
    isPinned: false, isArchived: false, timestamp: '1周前',
    messages: [{ id: 'm5-1', sender: 'assistant', text: '你好！想了解如何为开发面板新增本地终端视图或实现主题切换配置吗？', timestamp: Date.now() - 600000000 }],
  },
];

export function populateBlocksForSessions(sessions: SessionState[], opts?: { keepSessionIds?: Iterable<string> | null }): SessionState[] {
  const normalized = sessions.map((sess) => ({
    ...sess, messages: (sess.messages || []).map((msg) => msg.sender === 'assistant' ? normalizeAssistantTimeline(msg) : msg),
  }));
  const titled = fillDefaultSessionTitles(normalized);
  return pruneEmptyShellSessions(titled, { ...(opts?.keepSessionIds != null ? { keepIds: opts.keepSessionIds } : {}) });
}

export function seedSessions(): { sessions: SessionState[]; activeSessionId: string; folderOrder: string[] } {
  if (isDemoMode()) {
    return {
      sessions: populateBlocksForSessions(DEFAULT_SESSIONS),
      activeSessionId: 'sess-2',
      folderOrder: ['审计与代码分析', '语音与播控', '常规会话'],
    };
  }
  const disk = hydrateSessionsFromDisk();
  if (disk.sessions.length > 0) {
    const activeCandidate = disk.activeSessionId && disk.sessions.some((s) => s.id === disk.activeSessionId) ? disk.activeSessionId : '';
    const sessions = populateBlocksForSessions(disk.sessions, { keepSessionIds: activeCandidate ? [activeCandidate] : [] });
    const active = activeCandidate && sessions.some((s) => s.id === activeCandidate) ? activeCandidate : '';
    const fromSessions = Array.from(new Set(sessions.map((s) => s.folder)));
    const folders = disk.folderOrder && disk.folderOrder.length > 0
      ? Array.from(new Set([...disk.folderOrder, ...fromSessions, GENERAL_FOLDER]))
      : [GENERAL_FOLDER, ...fromSessions.filter((f) => f !== GENERAL_FOLDER)];
    return { sessions, activeSessionId: active, folderOrder: folders };
  }
  return { sessions: [], activeSessionId: '', folderOrder: [GENERAL_FOLDER] };
}
