/**
 * layoutStore 纯辅助：不依赖 zustand set/get 闭包。
 * 可在 immer draft 上原地修改 WorkspaceState。
 */

import { isDemoMode } from '../api/appMode';
import { hydrateSessionsFromDisk } from '../api/sessionPersistence';
import { GENERAL_FOLDER } from '../api/projectStore';
import { normalizeAssistantTimeline } from '../api/toolPresentation';
import { fillDefaultSessionTitles } from '../api/sessionTitle';
import type {
  ColumnState,
  WorkspaceState,
  SessionState,
} from './types';

// ── Panel titles ────────────────────────────────────────────────────────────

/** togglePanel / 打开侧栏工具时的展示名 */
export const PANEL_TITLE_MAP: Record<string, string> = {
  agent: '协作 Agent',
  overview: '总览',
  files: '文件',
  preview: '浏览器',
  diff: '变更',
  terminal: '终端',
  tasks: '任务',
  runtime: '运行状态',
  chat: '对话',
  settings: '设置',
};

export function getPanelTitle(cardId: string): string {
  return PANEL_TITLE_MAP[cardId] || cardId;
}

// ── Column / group geometry ─────────────────────────────────────────────────

/** 将各列 widthRatio 归一化为和为 1 */
export function normalizeColumnWidths(ws: WorkspaceState): void {
  const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0) || 1;
  ws.columns.forEach((c) => {
    c.widthRatio /= sum;
  });
}

/** 将列内各组 heightRatio 均分 */
export function rebalanceGroupHeights(col: ColumnState): void {
  if (col.groups.length === 0) return;
  const evenHeight = 1 / col.groups.length;
  col.groups.forEach((g) => {
    g.heightRatio = evenHeight;
  });
}

/** 去掉空列，但始终保留 chat 列；可选再归一化宽度 */
export function filterEmptyColumnsKeepingChat(
  ws: WorkspaceState,
  normalize = true,
): void {
  ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
  if (normalize && ws.columns.length > 0) {
    normalizeColumnWidths(ws);
  }
}

// ── Chat column lock ────────────────────────────────────────────────────────

/** Chat column is always present and never removed. */
export function ensureChatColumn(ws: WorkspaceState): void {
  let chatCol = ws.columns.find((c) => c.id.includes('chat'));
  if (!chatCol) {
    chatCol = {
      id: `col-chat-${ws.id}`,
      widthRatio: 0.5,
      groups: [
        {
          id: `group-chat-${ws.id}`,
          activeCardId: 'chat',
          cards: [{ id: 'chat', title: '对话' }],
          heightRatio: 1,
        },
      ],
    };
    ws.columns.unshift(chatCol);
  } else {
    // Ensure a chat card exists in the chat column
    let hasChat = false;
    for (const g of chatCol.groups) {
      if (g.cards.some((c) => c.id === 'chat')) {
        hasChat = true;
        // Prefer chat as active when group is empty of other focus
        if (!g.cards.some((c) => c.id === g.activeCardId)) {
          g.activeCardId = 'chat';
        }
        break;
      }
    }
    if (!hasChat) {
      if (chatCol.groups.length === 0) {
        chatCol.groups.push({
          id: `group-chat-${ws.id}`,
          activeCardId: 'chat',
          cards: [{ id: 'chat', title: '对话' }],
          heightRatio: 1,
        });
      } else {
        chatCol.groups[0].cards.unshift({ id: 'chat', title: '对话' });
        chatCol.groups[0].activeCardId = 'chat';
      }
    }
  }
  // Never drop the chat column
  ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
  if (!ws.columns.some((c) => c.id.includes('chat'))) {
    ws.columns.unshift(chatCol);
  }
}

// ── Workspace factory ───────────────────────────────────────────────────────

export function createDefaultWorkspace(id: string): WorkspaceState {
  // Always start with a dedicated chat column. Side tools open beside it, never replace it.
  if (!isDemoMode()) {
    return {
      id,
      columns: [
        {
          id: `col-chat-${id}`,
          widthRatio: 1,
          groups: [
            {
              id: `group-chat-${id}`,
              activeCardId: 'chat',
              cards: [{ id: 'chat', title: '对话' }],
              heightRatio: 1,
            },
          ],
        },
      ],
    };
  }

  // Demo: multi-panel playground (chat still locked in first column)
  return {
    id,
    columns: [
      {
        id: `col-chat-${id}`,
        widthRatio: 0.42,
        groups: [
          {
            id: `group-chat-${id}`,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: '对话' }],
            heightRatio: 1.0,
          },
        ],
      },
      {
        id: `col-1-${id}`,
        widthRatio: 0.29,
        groups: [
          {
            id: `group-preview-${id}`,
            activeCardId: 'preview',
            cards: [{ id: 'preview', title: '预览' }],
            heightRatio: 1.0,
          },
        ],
      },
      {
        id: `col-2-${id}`,
        widthRatio: 0.29,
        groups: [
          {
            id: `group-diff-${id}`,
            activeCardId: 'diff',
            cards: [{ id: 'diff', title: '差异' }],
            heightRatio: 0.5,
          },
          {
            id: `group-tasks-${id}`,
            activeCardId: 'tasks',
            cards: [{ id: 'tasks', title: '任务' }],
            heightRatio: 0.5,
          },
        ],
      },
    ],
  };
}

// ── Session seed ────────────────────────────────────────────────────────────

const DEFAULT_SESSIONS: SessionState[] = [
  {
    id: 'sess-1',
    title: '分析酒馆对话主界面问题',
    folder: '审计与代码分析',
    isPinned: false,
    isArchived: false,
    timestamp: '10分钟前',
    messages: [
      { id: 'm1-1', sender: 'assistant', text: '你好！有什么关于酒馆对话界面的问题我可以帮您分析的？', timestamp: Date.now() - 600000 }
    ]
  },
  {
    id: 'sess-2',
    title: '审计三个项目的代码统一性问题',
    folder: '审计与代码分析',
    isPinned: false,
    isArchived: false,
    timestamp: '1小时前',
    messages: [
      {
        id: 'msg-1',
        sender: 'user',
        text: 'Let me try directly creating a test trigger to isolate the issue.',
        timestamp: Date.now() - 3600000
      },
      {
        id: 'msg-2',
        sender: 'assistant',
        text: 'The inline button DOES exist (1 found)! Let me find where it is:',
        timestamp: Date.now() - 3500000,
        toolCalls: [
          {
            id: 'tc-grep-1',
            name: 'grep_search',
            arguments: 'data-flowbit-inline="1"',
            status: 'success',
            explanation: '在工作区搜索冲突的行内按钮标签 data-flowbit-inline="1"',
            output: 'Searching pattern "data-flowbit-inline=\\"1\\""...\nFound 1 match in trigger-injector.ts:\nLine 42: <button data-flowbit-inline="1">F</button>'
          },
          {
            id: 'tc-read-1',
            name: 'read_file',
            arguments: 'trigger-injector.ts',
            status: 'success',
            explanation: '读取 trigger-injector.ts 以分析按钮挂载逻辑',
            output: 'Reading file "trigger-injector.ts"...\nFile size: 1042 bytes.\nFile contents read successfully.'
          }
        ]
      },
      {
        id: 'msg-3',
        sender: 'assistant',
        text: 'Found the culprit! Another extension is creating `<button data-flowbit-inline="1">F</button>`, and our code reuses it. Let me find which extension:',
        timestamp: Date.now() - 3400000,
        toolCalls: [
          {
            id: 'tc-grep-2',
            name: 'grep_search',
            arguments: 'flowbit-inline-style',
            status: 'success',
            explanation: '在整个工作区搜索 flowbit-inline-style 样式以排除命名冲突',
            output: 'Searching pattern "flowbit-inline-style"...\nFound 0 matches in workspace.'
          }
        ]
      },
      {
        id: 'msg-4',
        sender: 'assistant',
        text: '找到根源了！另一个扩展创建了 `<button data-flowbit-inline="1">F</button>`，我们的 `acquireInlineBtn` 找到并重用它，但没有覆盖它的 `innerHTML`，所以按钮只显示 "F"，而非 SVG 图标。',
        timestamp: Date.now() - 3200000,
        toolCalls: [
          {
            id: 'tc-edit-1',
            name: 'write_to_file',
            arguments: 'trigger-injector.ts',
            status: 'success',
            explanation: '修改 trigger-injector.ts，在 acquireInlineBtn 中重新创建并注入 SVG 按钮内容',
            diffs: [
              {
                filePath: 'trigger-injector.ts',
                additions: 12,
                deletions: 5,
                changes: [
                  { type: 'normal', content: 'function acquireInlineBtn() {' },
                  { type: 'deletion', content: '  let btn = document.querySelector("[data-flowbit-inline]");' },
                  { type: 'deletion', content: '  return btn;' },
                  { type: 'addition', content: '  let btn = document.querySelector("[data-flowbit-inline]");' },
                  { type: 'addition', content: '  if (btn && btn.innerHTML !== SVG_ICON) {' },
                  { type: 'addition', content: '    btn.innerHTML = SVG_ICON;' },
                  { type: 'addition', content: '  }' },
                  { type: 'addition', content: '  return btn;' },
                  { type: 'normal', content: '}' }
                ]
              }
            ]
          }
        ]
      },
      {
        id: 'msg-5',
        sender: 'assistant',
        text: 'Now rebuild and reload:',
        timestamp: Date.now() - 3000000,
        toolCalls: [
          {
            id: 'tc-build-1',
            name: 'run_command',
            arguments: 'npm run dev',
            status: 'success',
            explanation: '运行打包命令 npm run dev 以验证编译与变更',
            output: 'vite v8.0.16 building client environment for production...\ntransforming...\nrendering chunks...\ncomputing gzip size...\ndist/index.html                   0.46 kB │ gzip:  0.29 kB\ndist/assets/index-2PqGUG_A.css   30.11 kB │ gzip:  5.57 kB\ndist/assets/index-C068c687.js   270.20 kB │ gzip: 83.06 kB\n\n✓ built in 389ms'
          }
        ]
      },
      {
        id: 'msg-6',
        sender: 'assistant',
        text: '我已经追踪到这个问题的根源了，总结一下发现：\n\n**当前状态：**\n- 扩展已加载，service worker 正常\n- 内容脚本已注入 (overlay 面板创建成功)\n  - 但 `mountTrigger()` 函数没有正常执行——`flowbit-inline-style` style 元素没有被创建，触发按钮也没有生成\n\n**根源：** 还有一个其他扩展（如 "All API Hub" 或 "HiSider"）在页面上注入了 `<button data-flowbit-inline="1">F</button>`，我们的 `acquireInlineBtn` 会找到并重用这个按钮，但不会覆盖它的 `innerHTML`，导致按钮只显示 "F" 而不是 SVG 图标。\n\n我已经修复了 `acquireInlineBtn` 让它检测到外部按钮时重新创建。\n\n但现在有一个更基础的问题：在新加载 of 页面上，`mountTrigger` 根本没有被触发（连 `<style>` 元素都没有），这说明内容脚本执行到 `showFlowbitFab()` 时可能抛出了异常，被 `bootstrap()` 的 `try-catch` 吞掉了。\n\n需要你手动做：\n1. 打开 `chrome://extensions`\n2. 找到 "Chat Sync Bridge"，点 移除\n3. 点击 **加载已解压的扩展程序** ➔ 选择 `C:\\Software\\codex_chatHistory\\apps\\browser-extension\\dist`\n4. 刷新 Claude 或 ChatGPT 页面\n\n这次移除再重新加载会触发全新的内容脚本注册，应该能解决 `mountTrigger` 不触发的问题。',
        timestamp: Date.now() - 2800000
      }
    ]
  },
  {
    id: 'sess-3',
    title: 'Fix voice playback timing and overla',
    folder: '语音与播控',
    isPinned: false,
    isArchived: false,
    timestamp: '3天前',
    messages: [
      { id: 'm3-1', sender: 'assistant', text: '你好！这里可以帮您调试和修复语音播控的相关延时问题。', timestamp: Date.now() - 250000000 }
    ]
  },
  {
    id: 'sess-4',
    title: '定制菜单与滚动区域优化',
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '5天前',
    messages: [
      { id: 'm4-1', sender: 'assistant', text: '你好！我可以协助您进行前端自定义菜单和隐藏滚动条样式的优化设计。', timestamp: Date.now() - 400000000 }
    ]
  },
  {
    id: 'sess-5',
    title: '添加终端与主题扩展',
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '1周前',
    messages: [
      { id: 'm5-1', sender: 'assistant', text: '你好！想了解如何为开发面板新增本地终端视图或实现主题切换配置吗？', timestamp: Date.now() - 600000000 }
    ]
  },
];

export function populateBlocksForSessions(sessions: SessionState[]): SessionState[] {
  const normalized = sessions.map((sess) => ({
    ...sess,
    messages: sess.messages.map((msg) =>
      msg.sender === 'assistant' ? normalizeAssistantTimeline(msg) : msg,
    ),
  }));
  // 磁盘/演示种子：默认标题且已有用户消息 → 补短标题
  return fillDefaultSessionTitles(normalized);
}

export function seedSessions(): {
  sessions: SessionState[];
  activeSessionId: string;
  folderOrder: string[];
} {
  if (isDemoMode()) {
    return {
      sessions: populateBlocksForSessions(DEFAULT_SESSIONS),
      activeSessionId: 'sess-2',
      folderOrder: ['审计与代码分析', '语音与播控', '常规会话'],
    };
  }

  // 正式版：从本地索引 + JSONL 恢复；不自动新建会话
  const disk = hydrateSessionsFromDisk();
  if (disk.sessions.length > 0) {
    // 有历史时恢复上次活动会话；若无效则不强制选中（空态可新建）
    const active =
      disk.activeSessionId && disk.sessions.some((s) => s.id === disk.activeSessionId)
        ? disk.activeSessionId
        : '';
    const fromSessions = Array.from(new Set(disk.sessions.map((s) => s.folder)));
    const folders =
      disk.folderOrder && disk.folderOrder.length > 0
        ? Array.from(new Set([...disk.folderOrder, ...fromSessions, GENERAL_FOLDER]))
        : [GENERAL_FOLDER, ...fromSessions.filter((f) => f !== GENERAL_FOLDER)];
    return {
      sessions: populateBlocksForSessions(disk.sessions),
      activeSessionId: active,
      folderOrder: folders,
    };
  }

  return {
    sessions: [],
    activeSessionId: '',
    folderOrder: [GENERAL_FOLDER],
  };
}

