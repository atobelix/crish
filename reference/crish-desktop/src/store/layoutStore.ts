import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { piClientApi } from '../api/piClientApi';
import type { Settings, CronJob, McpServer, ProviderInfo } from '../api/piClientApi';

export interface CardState {
  id: string; // 'plan' | 'preview' | 'diff' | 'tasks' | 'terminal'
  title: string;
}

export interface CardGroupState {
  id: string;
  activeCardId: string;
  cards: CardState[];
  heightRatio: number; // relative height ratio within the column
}

export interface ColumnState {
  id: string;
  widthRatio: number; // relative width ratio within the workspace
  groups: CardGroupState[];
}

export interface WorkspaceState {
  id: string;
  columns: ColumnState[];
}

export interface DiffChange {
  type: 'addition' | 'deletion' | 'normal';
  lineNum?: number;
  content: string;
}

export interface FileDiff {
  filePath: string;
  additions: number;
  deletions: number;
  changes: DiffChange[];
}

export interface MessageToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'running' | 'success' | 'error' | 'pending_approval';
  output?: string;
  diffs?: FileDiff[];
  explanation?: string;
}

export interface SessionMessage {
  id: string;
  sender: 'user' | 'assistant';
  text?: string;
  timestamp: number;
  toolCalls?: MessageToolCall[];
  status?: 'queued' | 'processing' | 'completed';
  blocks?: { type: 'text' | 'tool_call'; id?: string; content?: string }[];
  thinkingTime?: number;
}

export interface SessionState {
  id: string;
  title: string;
  folder: string;
  isPinned: boolean;
  isArchived: boolean;
  branchParentId?: string;
  timestamp: string;
  messages: SessionMessage[];
}

export interface DropPreviewState {
  colIdx: number;
  groupIdx: number;
  direction: 'top' | 'bottom' | 'left' | 'right' | 'merge';
}

interface DraggedTabState {
  cardId: string;
  sourceGroupId: string;
  workspaceId: string;
  isTabDrag?: boolean;
}

interface LayoutStore {
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  tabModeEnabled: boolean;
  uiSize: 'small' | 'medium' | 'large';
  sidebarCollapsed: boolean;
  sessions: SessionState[];
  folderOrder: string[];
  activeSessionId: string;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
  panelsDropdownCoords: { x: number; y: number } | null;
  showSettingsOverlay: boolean;

  // UI Settings Actions
  setDropPreview: (preview: DropPreviewState | null) => void;
  setUiSize: (size: 'small' | 'medium' | 'large') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setActiveSessionId: (id: string) => void;
  setPanelsDropdownCoords: (coords: { x: number; y: number } | null) => void;
  setShowSettingsOverlay: (show: boolean) => void;

  // Workspace Actions
  togglePanel: (wsId: string, key: string, isVisible: boolean) => void;
  resizeColumns: (wsId: string, colIdx: number, dx: number, containerWidth: number) => void;
  resizeGroups: (wsId: string, colIdx: number, groupIdx: number, dy: number, containerHeight: number) => void;
  
  // Drag and Drop Tab Actions
  setDraggedTab: (dragged: DraggedTabState | null) => void;
  mergeTab: (wsId: string, cardId: string, sourceGroupId: string, targetGroupId: string, targetIndex?: number) => void;
  detachTabToStandalone: (wsId: string, cardId: string, sourceGroupId: string, colIdx: number, direction: 'top' | 'bottom' | 'new-col', targetGroupIdx?: number) => void;
  moveTabOrGroupRealtime: (wsId: string, cardId: string, sourceGroupId: string, targetColIdx: number, targetGroupIdx: number) => void;
  closeTabInGroup: (wsId: string, groupId: string, cardId: string) => void;

  // Sidebar Actions
  createSession: (opts?: { title?: string; folder?: string }) => string;
  pinSession: (sessionId: string) => void;
  unpinSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (sessionId: string) => void;
  branchSession: (sessionId: string, newTitle: string) => void;
  splitScreenWorkspace: (sessionId: string) => void;
  closeWorkspace: (wsId: string) => void;
  moveSessionRealtime: (sessionId: string, targetSessionId: string | null, targetFolder: string, isPinned: boolean) => void;
  moveFolderRealtime: (folderName: string, targetFolderName: string | null) => void;
  pinFolderSessions: (folderName: string) => void;
  unpinFolderSessions: (folderName: string) => void;

  // Chat Actions
  activeDiffSource: FileDiff | null;
  setActiveDiffSource: (diff: FileDiff | null) => void;
  addMessage: (wsId: string, sessionId: string, message: SessionMessage) => void;
  withdrawMessage: (wsId: string, sessionId: string, messageId: string) => void;
  respondToApproval: (wsId: string, sessionId: string, messageId: string, toolCallId: string, status: 'success' | 'error') => void;
  setSessions: (sessions: SessionState[]) => void;
  updateMessageText: (sessionId: string, messageId: string, text: string) => void;
  addMessageToolCall: (sessionId: string, messageId: string, toolCall: MessageToolCall) => void;
  updateMessageToolCall: (sessionId: string, messageId: string, toolCallId: string, updates: Partial<MessageToolCall>) => void;
  setSessionMessageStatus: (sessionId: string, messageId: string, status: 'queued' | 'processing' | 'completed', thinkingTime?: number) => void;


  // Plan Mode & Permissions
  planModeEnabled: boolean;
  setPlanModeEnabled: (enabled: boolean) => void;
  planApproved: boolean;
  setPlanApproved: (approved: boolean) => void;
  commandPermissions: string[];
  addCommandPermission: (cmd: string) => void;

  // Pi Settings & Telemetry
  piSettings: Settings | null;
  scheduledTasks: CronJob[];
  mcpServers: McpServer[];
  trustedFolders: string[];
  currentProjectTrusted: boolean;
  activeWorkers: { id: string; taskName: string; elapsedSeconds: number }[];
  tokenUsage: { input: number; inputMax: number; output: number; outputMax: number; cost: number };
  killedWorkerIds: string[];
  providers: ProviderInfo[];
  setProviders: (providers: ProviderInfo[]) => void;
  setPiSettings: (settings: Settings | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  checkFolderTrust: (cwd: string) => Promise<void>;
  setFolderTrust: (cwd: string, decision: 'always' | 'session' | 'never') => Promise<void>;
  syncTelemetryData: (data: any) => void;

  // New Primitives & Linkages
  terminalLines: string[];
  addTerminalLine: (line: string) => void;
  clearTerminalLines: () => void;
  manuallyTriggeredWorkers: { id: string; taskName: string; elapsedSeconds: number }[];
  triggerCronJobNow: (prompt: string) => void;
  killWorker: (id: string, taskName: string) => void;
  applyLayoutPreset: (preset: 'developer-split' | 'full-chat' | 'telemetry-focus') => void;
}

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

function createDefaultWorkspace(id: string): WorkspaceState {
  return {
    id,
    columns: [
      {
        id: `col-chat-${id}`,
        widthRatio: 0.38,
        groups: [
          {
            id: `group-chat-${id}`,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: 'Chat' }],
            heightRatio: 1.0,
          },
        ],
      },
      {
        id: `col-1-${id}`,
        widthRatio: 0.31,
        groups: [
          {
            id: `group-preview-${id}`,
            activeCardId: 'preview',
            cards: [{ id: 'preview', title: 'Preview' }],
            heightRatio: 1.0,
          },
        ],
      },
      {
        id: `col-2-${id}`,
        widthRatio: 0.31,
        groups: [
          {
            id: `group-diff-${id}`,
            activeCardId: 'diff',
            cards: [{ id: 'diff', title: 'Diff' }],
            heightRatio: 1.0,
          },
        ],
      },
    ],
  };
}

function populateBlocksForSessions(sessions: SessionState[]): SessionState[] {
  return sessions.map(sess => ({
    ...sess,
    messages: sess.messages.map(msg => {
      if (msg.sender === 'assistant' && !msg.blocks) {
        const blocks: { type: 'text' | 'tool_call'; id?: string; content?: string }[] = [];
        if (msg.text) {
          blocks.push({ type: 'text', content: msg.text });
        }
        if (msg.toolCalls) {
          msg.toolCalls.forEach(tc => {
            blocks.push({ type: 'tool_call', id: tc.id });
          });
        }
        return { ...msg, blocks };
      }
      return msg;
    })
  }));
}

export const useLayoutStore = create<LayoutStore>()(
  immer((set) => ({
    workspaces: [createDefaultWorkspace('ws-0')],
    activeWorkspaceIndex: 0,
    tabModeEnabled: false,
    uiSize: 'medium',
    sidebarCollapsed: false,
    sessions: populateBlocksForSessions(DEFAULT_SESSIONS),
    folderOrder: ['审计与代码分析', '语音与播控', '常规会话'],
    activeSessionId: 'sess-2',
    draggedTab: null,
    dropPreview: null,
    panelsDropdownCoords: null,
    showSettingsOverlay: false,

    activeDiffSource: null,
    setActiveDiffSource: (diff) => set((state) => {
      state.activeDiffSource = diff;
    }),
    planModeEnabled: false,
    setPlanModeEnabled: (enabled) => set((state) => {
      state.planModeEnabled = enabled;
    }),
    planApproved: false,
    setPlanApproved: (approved) => set((state) => {
      state.planApproved = approved;
    }),
    commandPermissions: [],
    addCommandPermission: (cmd) => set((state) => {
      if (!state.commandPermissions.includes(cmd)) {
        state.commandPermissions.push(cmd);
      }
    }),
    piSettings: null,
    providers: [],
    scheduledTasks: [],
    mcpServers: [],
    trustedFolders: [],
    currentProjectTrusted: true,
    activeWorkers: [],
    tokenUsage: { input: 115482, inputMax: 160000, output: 24930, outputMax: 40000, cost: 0.345 },
    killedWorkerIds: [],
    
    // New Initial States
    terminalLines: [
      'orange@Windows-PC MINGW64 /c/Software/conex',
      '$ npm run dev',
      '> zennav-server@1.0.0 dev',
      '> node server.js',
      '',
      '[ready] Server started on http://localhost:3000',
      '[ready] Database connection established.'
    ],
    manuallyTriggeredWorkers: [],

    setProviders: (providers) => set((state) => {
      state.providers = providers;
    }),
    setPiSettings: (settings) => set((state) => {
      state.piSettings = settings;
    }),
    setScheduledTasks: (tasks) => set((state) => {
      state.scheduledTasks = tasks;
    }),
    setMcpServers: (servers) => set((state) => {
      state.mcpServers = servers;
    }),
    checkFolderTrust: async (cwd: string) => {
      const list = await piClientApi.getTrustedFolders();
      const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
      const isTrusted = list.some(p => p.replace(/\\/g, '/').toLowerCase() === normalizedCwd);
      set((state) => {
        state.trustedFolders = list;
        state.currentProjectTrusted = isTrusted;
      });
    },
    setFolderTrust: async (cwd: string, decision: 'always' | 'session' | 'never') => {
      const normalizedCwd = cwd.replace(/\\/g, '/');
      if (decision === 'always') {
        const list = await piClientApi.addTrustedFolder(normalizedCwd);
        set((state) => {
          state.trustedFolders = list;
          state.currentProjectTrusted = true;
        });
      } else if (decision === 'session') {
        set((state) => {
          const lowerList = state.trustedFolders.map(f => f.toLowerCase());
          if (!lowerList.includes(normalizedCwd.toLowerCase())) {
            state.trustedFolders.push(normalizedCwd);
          }
          state.currentProjectTrusted = true;
        });
      } else {
        const list = await piClientApi.removeTrustedFolder(normalizedCwd);
        set((state) => {
          state.trustedFolders = list;
          state.currentProjectTrusted = false;
        });
      }
    },
    syncTelemetryData: (data: any) => set((state) => {
      if (data.tokenUsage) {
        state.tokenUsage = data.tokenUsage;
      }
      
      // Increment elapsedSeconds for manual workers by 2 seconds on every sync
      state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.map(w => ({
        ...w,
        elapsedSeconds: w.elapsedSeconds + 2
      }));

      if (data.activeWorkers) {
        state.activeWorkers = [
          ...data.activeWorkers.filter((w: any) => !state.killedWorkerIds.includes(w.id)),
          ...state.manuallyTriggeredWorkers
        ];
      }
      if (data.mcpServers) {
        state.mcpServers = data.mcpServers;
      }
      if (data.cronJobs) {
        state.scheduledTasks = data.cronJobs;
      }
    }),
    addTerminalLine: (line: string) => set((state) => {
      state.terminalLines.push(line);
    }),
    clearTerminalLines: () => set((state) => {
      state.terminalLines = [];
    }),
    triggerCronJobNow: (prompt: string) => set((state) => {
      const newWorker = {
        id: `worker-manual-${Date.now()}`,
        taskName: `Cron: ${prompt}`,
        elapsedSeconds: 0
      };
      state.manuallyTriggeredWorkers.push(newWorker);
      state.activeWorkers.push(newWorker);
    }),
    killWorker: (id: string, _taskName: string) => set((state) => {
      state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.filter(w => w.id !== id);
      state.activeWorkers = state.activeWorkers.filter(w => w.id !== id);
      if (!state.killedWorkerIds.includes(id)) {
        state.killedWorkerIds.push(id);
      }
      // Deduct token usage as a simulated result of termination
      state.tokenUsage.input = Math.max(0, state.tokenUsage.input - 1500);
      state.tokenUsage.cost = Math.max(0, parseFloat((state.tokenUsage.cost - 0.0045).toFixed(4)));
    }),
    addMessage: (_wsId, sessionId, message) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess) {
        if (!sess.messages) sess.messages = [];
        
        // Auto-approve whitelisted commands
        if (message.toolCalls) {
          message.toolCalls.forEach((tc) => {
            if (tc.status === 'pending_approval') {
              const isWhitelisted = state.commandPermissions.some(allowed => 
                tc.arguments.startsWith(allowed) || allowed.startsWith(tc.arguments)
              );
              if (isWhitelisted) {
                tc.status = 'success';
                tc.output = `[自动授权成功] 正在执行命令:\n$ ${tc.arguments}\nvite v8.0.16 building client environment for production...\ntransforming...\n✓ built in 389ms`;
              }
            }
          });
        }
        
        const newMsg = {
          ...message,
          blocks: message.blocks || []
        };
        if (newMsg.blocks.length === 0) {
          if (newMsg.text) {
            newMsg.blocks.push({ type: 'text' as const, content: newMsg.text });
          }
          if (newMsg.toolCalls) {
            newMsg.toolCalls.forEach(tc => {
              newMsg.blocks.push({ type: 'tool_call' as const, id: tc.id });
            });
          }
        }
        
        sess.messages.push(newMsg);
      }
    }),
    withdrawMessage: (_wsId, sessionId, messageId) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const idx = sess.messages.findIndex(m => m.id === messageId);
        if (idx !== -1) {
          sess.messages = sess.messages.slice(0, idx);
        }
      }
    }),
    respondToApproval: (_wsId, sessionId, messageId, toolCallId, status) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg && msg.toolCalls) {
          const tc = msg.toolCalls.find(t => t.id === toolCallId);
          if (tc) {
            tc.status = status;
            if (status === 'success') {
              tc.output = "权限已批准。正在执行命令:\n$ npm run build\nvite v8.0.16 building client environment for production...\ntransforming...\nrendering chunks...\n✓ built in 389ms";
            } else {
              tc.output = "权限被拒绝。\nError: Command permission rejected by user.";
            }
          }
        }
      }
    }),
    setSessions: (sessions) => set((state) => {
      state.sessions = sessions;
    }),
    updateMessageText: (sessionId, messageId, text) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg) {
          msg.text = text;
          if (!msg.blocks) msg.blocks = [];
          
          const lastBlock = msg.blocks[msg.blocks.length - 1];
          if (lastBlock && lastBlock.type === 'text' && text.startsWith(lastBlock.content || '')) {
            lastBlock.content = text;
          } else {
            msg.blocks.push({ type: 'text' as const, content: text });
          }
        }
      }
    }),
    addMessageToolCall: (sessionId, messageId, toolCall) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg) {
          if (!msg.toolCalls) msg.toolCalls = [];
          msg.toolCalls.push(toolCall);
          if (!msg.blocks) msg.blocks = [];
          msg.blocks.push({ type: 'tool_call' as const, id: toolCall.id });
        }
      }
    }),
    updateMessageToolCall: (sessionId, messageId, toolCallId, updates) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg && msg.toolCalls) {
          const tc = msg.toolCalls.find(t => t.id === toolCallId);
          if (tc) {
            Object.assign(tc, updates);
          }
        }
      }
    }),
    setSessionMessageStatus: (sessionId, messageId, status, thinkingTime) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg) {
          msg.status = status;
          if (thinkingTime !== undefined) {
            msg.thinkingTime = thinkingTime;
          }
        }
      }
    }),

    setDropPreview: (preview) => set((state) => { state.dropPreview = preview; }),
    setUiSize: (size) => set((state) => { state.uiSize = size; }),
    setSidebarCollapsed: (collapsed) => set((state) => { state.sidebarCollapsed = collapsed; }),
    setTabModeEnabled: (enabled) => set((state) => { state.tabModeEnabled = enabled; }),
    setActiveSessionId: (id) => set((state) => { state.activeSessionId = id; }),
    setPanelsDropdownCoords: (coords) => set((state) => { state.panelsDropdownCoords = coords; }),
    setShowSettingsOverlay: (show) => set((state) => { state.showSettingsOverlay = show; }),

    createSession: (opts) => {
      const id = `sess-${Date.now()}`;
      set((state) => {
        const sess: SessionState = {
          id,
          title: opts?.title || '新会话',
          folder: opts?.folder || '常规会话',
          isPinned: false,
          isArchived: false,
          timestamp: '刚刚',
          messages: [],
        };
        state.sessions.unshift(sess);
        if (!state.folderOrder.includes(sess.folder)) {
          state.folderOrder.push(sess.folder);
        }
        state.activeSessionId = id;
      });
      return id;
    },

    togglePanel: (wsId, key, isVisible) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      const cardId = key;
      const titleMap: Record<string, string> = {
        preview: '预览',
        diff: '变更',
        terminal: '终端',
        tasks: '任务',
        'pi-runtime': '运行状态',
        chat: '对话',
        settings: '设置',
      };
      const cardTitle = titleMap[key] || key;

      if (isVisible) {
        // Check if card already exists anywhere in this workspace
        let alreadyExists = false;
        ws.columns.forEach((col) => {
          col.groups.forEach((g) => {
            if (g.cards.some((c) => c.id === cardId)) {
              alreadyExists = true;
            }
          });
        });
        if (alreadyExists) return;

        // If tab mode is enabled, try to merge it into the first active non-chat card group
        if (state.tabModeEnabled) {
          let targetGroup: CardGroupState | null = null;
          for (let i = 1; i < ws.columns.length; i++) {
            if (ws.columns[i].groups.length > 0) {
              targetGroup = ws.columns[i].groups[0];
              break;
            }
          }

          if (targetGroup) {
            targetGroup.cards.push({ id: cardId, title: cardTitle });
            targetGroup.activeCardId = cardId;
            return;
          }
        }

        // Otherwise, open as a standalone card group.
        // Determine default column index (0 = Chat (locked), 1 = Plan/Preview, 2 = Diff/Tasks/Terminal)
        let defaultColIdx = 1;
        if (key === 'tasks' || key === 'terminal') defaultColIdx = 2;

        const targetColIdx = Math.min(defaultColIdx, ws.columns.length);

        while (ws.columns.length <= targetColIdx) {
          ws.columns.push({
            id: `col-${ws.columns.length}-${ws.id}`,
            widthRatio: 0.3,
            groups: [],
          });
        }

        const col = ws.columns[targetColIdx];
        const evenHeight = 1 / (col.groups.length + 1);
        col.groups.forEach((g) => {
          g.heightRatio = evenHeight;
        });

        col.groups.push({
          id: `group-${cardId}-${Date.now()}-${ws.id}`,
          activeCardId: cardId,
          cards: [{ id: cardId, title: cardTitle }],
          heightRatio: evenHeight,
        });

        // Filter empty columns
        ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);

        // Always re-normalize column widths so the new column is visible
        {
          const total = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
          ws.columns.forEach((c) => { c.widthRatio /= total; });
        }

      } else {
        // Hide panel: Find and remove it from whichever group it's inside
        ws.columns.forEach((col) => {
          col.groups.forEach((group) => {
            const cardIdx = group.cards.findIndex((c) => c.id === cardId);
            if (cardIdx !== -1) {
              group.cards.splice(cardIdx, 1);
              // If we removed the active card, switch active
              if (group.activeCardId === cardId && group.cards.length > 0) {
                group.activeCardId = group.cards[0].id;
              }
            }
          });

          // Filter out groups that have no cards left
          const oldGroupsLength = col.groups.length;
          col.groups = col.groups.filter((g) => g.cards.length > 0);
          if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
            // Equalize remaining heights
            const evenHeight = 1 / col.groups.length;
            col.groups.forEach((g) => { g.heightRatio = evenHeight; });
          }
        });

        // Filter out empty columns (except Chat column)
        ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
        
        // Re-normalize column widths
        const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
        ws.columns.forEach((c) => { c.widthRatio /= sum; });
      }
    }),

    resizeColumns: (wsId, colIdx, dx, containerWidth) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws || colIdx < 0 || colIdx >= ws.columns.length - 1) return;

      const colLeft = ws.columns[colIdx];
      const colRight = ws.columns[colIdx + 1];

      const ratioDelta = dx / containerWidth;
      const newLeft = colLeft.widthRatio + ratioDelta;
      const newRight = colRight.widthRatio - ratioDelta;

      if (newLeft > 0.1 && newRight > 0.1) {
        colLeft.widthRatio = newLeft;
        colRight.widthRatio = newRight;
      }
    }),

    resizeGroups: (wsId, colIdx, groupIdx, dy, containerHeight) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws || colIdx < 0 || colIdx >= ws.columns.length) return;

      const col = ws.columns[colIdx];
      if (groupIdx < 0 || groupIdx >= col.groups.length - 1) return;

      const groupTop = col.groups[groupIdx];
      const groupBottom = col.groups[groupIdx + 1];

      const ratioDelta = dy / containerHeight;
      const newTop = groupTop.heightRatio + ratioDelta;
      const newBottom = groupBottom.heightRatio - ratioDelta;

      if (newTop > 0.1 && newBottom > 0.1) {
        groupTop.heightRatio = newTop;
        groupBottom.heightRatio = newBottom;
      }
    }),

    setDraggedTab: (dragged) => set((state) => {
      state.draggedTab = dragged;
    }),

    mergeTab: (wsId, cardId, sourceGroupId, targetGroupId, targetIndex) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      // ── Same-group reorder (tab drag within same card) ──────────────────
      if (sourceGroupId === targetGroupId) {
        let group: any = null;
        ws.columns.forEach((col) => col.groups.forEach((g) => {
          if (g.id === sourceGroupId) group = g;
        }));
        if (!group) return;
        const fromIdx = group.cards.findIndex((c: CardState) => c.id === cardId);
        if (fromIdx === -1) return;
        const [card] = group.cards.splice(fromIdx, 1);
        // Adjust index for the gap created by removal
        let toIdx = targetIndex !== undefined ? targetIndex : group.cards.length;
        if (toIdx > fromIdx) toIdx = Math.max(0, toIdx - 1);
        toIdx = Math.min(toIdx, group.cards.length);
        group.cards.splice(toIdx, 0, card);
        group.activeCardId = cardId;
        return;
      }

      // ── Cross-group merge ───────────────────────────────────────────────
      let sourceGroup: any = null;
      let targetGroup: any = null;
      let draggedCard: CardState | null = null;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
          if (g.id === targetGroupId) {
            targetGroup = g;
          }
        });
      });

      if (!targetGroup || !draggedCard) return;

      // Add to target at specific index if provided, otherwise append
      if (targetIndex !== undefined && targetIndex >= 0 && targetIndex <= targetGroup.cards.length) {
        targetGroup.cards.splice(targetIndex, 0, draggedCard);
      } else {
        targetGroup.cards.push(draggedCard);
      }
      targetGroup.activeCardId = cardId;

      // Clean up source group if empty
      if (sourceGroup && (sourceGroup as CardGroupState).cards.length === 0) {
        ws.columns.forEach((col) => {
          const oldGroupsLength = col.groups.length;
          col.groups = col.groups.filter((g) => g.id !== sourceGroupId);
          if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
            const evenHeight = 1 / col.groups.length;
            col.groups.forEach((g) => { g.heightRatio = evenHeight; });
          }
        });

        // Filter out empty columns
        ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
        const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
        ws.columns.forEach((c) => { c.widthRatio /= sum; });
      } else if (sourceGroup) {
        // Switch active tab of source if the removed tab was active
        if ((sourceGroup as CardGroupState).activeCardId === cardId && (sourceGroup as CardGroupState).cards.length > 0) {
          (sourceGroup as CardGroupState).activeCardId = (sourceGroup as CardGroupState).cards[0].id;
        }
      }

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId && state.draggedTab.sourceGroupId === sourceGroupId) {
        state.draggedTab.sourceGroupId = targetGroupId;
      }
    }),

    detachTabToStandalone: (wsId, cardId, sourceGroupId, colIdx, direction, targetGroupIdx) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      const sourceCol = ws.columns.find((col) => col.groups.some((g) => g.id === sourceGroupId));

      let sourceGroup: any = null;
      let draggedCard: CardState | null = null;

      // Extract card from source group
      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
        });
      });

      if (!draggedCard) return;

      const cardTitle = cardId.charAt(0).toUpperCase() + cardId.slice(1);

      // Check if the source column only has 1 group, and that group is now empty (meaning it will be deleted)
      const isSourceColGoingToBeDeleted = sourceCol && 
        sourceCol.groups.length === 1 && 
        sourceCol.groups[0].cards.length === 0;

      const inheritedWidth = (isSourceColGoingToBeDeleted && sourceCol) ? sourceCol.widthRatio : 0.3;

      const newGroupId = `group-det-${cardId}-${Date.now()}-${Math.floor(Math.random() * 1000)}-${ws.id}`;

      if (direction === 'new-col') {
        // Create new column at colIdx
        const newCol: ColumnState = {
          id: `col-new-${Date.now()}-${ws.id}`,
          widthRatio: inheritedWidth,
          groups: [
            {
              id: newGroupId,
              activeCardId: cardId,
              cards: [{ id: cardId, title: cardTitle }],
              heightRatio: 1.0,
            },
          ],
        };
        ws.columns.splice(colIdx, 0, newCol);
      } else {
        // Add to existing column as a split group (top or bottom relative to targetGroupIdx)
        const col = ws.columns[colIdx];
        const numGroups = col.groups.length + 1;
        const evenHeight = 1 / numGroups;
        col.groups.forEach((g) => { g.heightRatio = evenHeight; });

        const newGroup: CardGroupState = {
          id: newGroupId,
          activeCardId: cardId,
          cards: [{ id: cardId, title: cardTitle }],
          heightRatio: evenHeight,
        };

        if (targetGroupIdx !== undefined && targetGroupIdx >= 0 && targetGroupIdx <= col.groups.length) {
          const insertIdx = direction === 'top' ? targetGroupIdx : targetGroupIdx + 1;
          col.groups.splice(insertIdx, 0, newGroup);
        } else {
          if (direction === 'top') {
            col.groups.unshift(newGroup);
          } else {
            col.groups.push(newGroup);
          }
        }
      }

      // Clean up source group if empty
      if (sourceGroup && (sourceGroup as CardGroupState).cards.length === 0) {
        ws.columns.forEach((col) => {
          const oldGroupsLength = col.groups.length;
          col.groups = col.groups.filter((g) => g.id !== sourceGroupId);
          if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
            const evenHeight = 1 / col.groups.length;
            col.groups.forEach((g) => { g.heightRatio = evenHeight; });
          }
        });
      } else if (sourceGroup) {
        if ((sourceGroup as CardGroupState).activeCardId === cardId && (sourceGroup as CardGroupState).cards.length > 0) {
          (sourceGroup as CardGroupState).activeCardId = (sourceGroup as CardGroupState).cards[0].id;
        }
      }

      // Clean up empty columns (except Chat column)
      ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);

      // Normalize all widths
      const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
      ws.columns.forEach((c) => { c.widthRatio /= sum; });

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId && state.draggedTab.sourceGroupId === sourceGroupId) {
        state.draggedTab.sourceGroupId = newGroupId;
      }
    }),

    moveTabOrGroupRealtime: (wsId, cardId, sourceGroupId, targetColIdx, targetGroupIdx) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      // Find source group and card
      let sourceCol: any = null;
      let sourceGroup: any = null;
      let draggedCard: any = null;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceCol = col;
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
        });
      });

      if (!draggedCard || !sourceCol || !sourceGroup) return;

      const cardTitle = cardId.charAt(0).toUpperCase() + cardId.slice(1);

      // Clean up source group if empty
      if (sourceGroup.cards.length === 0) {
        sourceCol.groups = sourceCol.groups.filter((g: any) => g.id !== sourceGroupId);
        if (sourceCol.groups.length > 0) {
          const sum = sourceCol.groups.reduce((a: number, b: any) => a + b.heightRatio, 0);
          sourceCol.groups.forEach((g: any) => { g.heightRatio /= sum; });
        }
      } else {
        if (sourceGroup.activeCardId === cardId) {
          sourceGroup.activeCardId = sourceGroup.cards[0].id;
        }
      }

      // Clean up empty columns (except Chat column)
      const oldColCount = ws.columns.length;
      ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
      if (ws.columns.length !== oldColCount) {
        const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
        ws.columns.forEach((c) => { c.widthRatio /= sum; });
      }

      // Bound targetColIdx
      const colIdx = Math.min(Math.max(targetColIdx, 1), ws.columns.length - 1);
      const col = ws.columns[colIdx];

      // Create new group
      const newGroupId = `group-det-${cardId}-${Date.now()}-${Math.floor(Math.random() * 1000)}-${ws.id}`;
      const newGroup: CardGroupState = {
        id: newGroupId,
        activeCardId: cardId,
        cards: [{ id: cardId, title: cardTitle }],
        heightRatio: 1.0,
      };

      // Insert group at targetGroupIdx
      const insertIdx = Math.min(Math.max(targetGroupIdx, 0), col.groups.length);
      col.groups.splice(insertIdx, 0, newGroup);

      // Equidistribute heights in target column
      const evenHeight = 1 / col.groups.length;
      col.groups.forEach((g) => { g.heightRatio = evenHeight; });

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId) {
        state.draggedTab.sourceGroupId = newGroupId;
      }
    }),

    closeTabInGroup: (wsId, groupId, cardId) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === groupId) {
            g.cards = g.cards.filter((c) => c.id !== cardId);
            if (g.activeCardId === cardId && g.cards.length > 0) {
              g.activeCardId = g.cards[0].id;
            }
          }
        });

        // Filter empty groups
        const oldGroupsLength = col.groups.length;
        col.groups = col.groups.filter((g) => g.cards.length > 0);
        if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
          const evenHeight = 1 / col.groups.length;
          col.groups.forEach((g) => { g.heightRatio = evenHeight; });
        }
      });

      // Filter empty columns
      ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
      const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
      ws.columns.forEach((c) => { c.widthRatio /= sum; });
    }),

    pinSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isPinned = true;
    }),

    unpinSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isPinned = false;
    }),

    archiveSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isArchived = true;
    }),

    unarchiveSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isArchived = false;
    }),

    branchSession: (sessionId, newTitle) => set((state) => {
      const original = state.sessions.find((s) => s.id === sessionId);
      if (!original) return;

      const newSess: SessionState = {
        id: `sess-branch-${Date.now()}`,
        title: newTitle,
        folder: original.folder,
        isPinned: false,
        isArchived: false,
        branchParentId: sessionId,
        timestamp: '刚刚',
        messages: original.messages ? JSON.parse(JSON.stringify(original.messages)) : [],
      };
      // Insert branch right after the original session
      const idx = state.sessions.findIndex((s) => s.id === sessionId);
      state.sessions.splice(idx + 1, 0, newSess);
      state.activeSessionId = newSess.id; // Auto focus newly branched session
    }),

    splitScreenWorkspace: (_sessionId) => set((state) => {
      const newWsId = `ws-${Date.now()}`;
      state.workspaces.push(createDefaultWorkspace(newWsId));
      state.activeWorkspaceIndex = state.workspaces.length - 1;
    }),

    closeWorkspace: (wsId) => set((state) => {
      if (state.workspaces.length <= 1) return; // Keep at least one workspace
      const idx = state.workspaces.findIndex((w) => w.id === wsId);
      if (idx !== -1) {
        state.workspaces.splice(idx, 1);
        state.activeWorkspaceIndex = Math.max(0, idx - 1);
      }
    }),

    moveSessionRealtime: (sessionId, targetSessionId, targetFolder, isPinned) => set((state) => {
      const sessIdx = state.sessions.findIndex((s) => s.id === sessionId);
      if (sessIdx === -1) return;

      const [sess] = state.sessions.splice(sessIdx, 1);
      sess.isPinned = isPinned;
      sess.folder = targetFolder;

      if (targetSessionId) {
        const tIdx = state.sessions.findIndex((s) => s.id === targetSessionId);
        if (tIdx !== -1) {
          state.sessions.splice(tIdx, 0, sess);
        } else {
          state.sessions.push(sess);
        }
      } else {
        state.sessions.push(sess);
      }
    }),

    moveFolderRealtime: (folderName, targetFolderName) => set((state) => {
      const idx = state.folderOrder.indexOf(folderName);
      if (idx === -1) return;
      state.folderOrder.splice(idx, 1);
      if (targetFolderName) {
        const tIdx = state.folderOrder.indexOf(targetFolderName);
        if (tIdx !== -1) {
          state.folderOrder.splice(tIdx, 0, folderName);
        } else {
          state.folderOrder.push(folderName);
        }
      } else {
        state.folderOrder.push(folderName);
      }
    }),

    pinFolderSessions: (folderName) => set((state) => {
      state.sessions.forEach((s) => {
        if (s.folder === folderName) {
          s.isPinned = true;
        }
      });
    }),

    unpinFolderSessions: (folderName) => set((state) => {
      state.sessions.forEach((s) => {
        if (s.folder === folderName) {
          s.isPinned = false;
        }
      });
    }),

    applyLayoutPreset: (preset) => set((state) => {
      const ws = state.workspaces[state.activeWorkspaceIndex];
      if (!ws) return;

      if (preset === 'developer-split') {
        ws.columns = [
          {
            id: `col-chat-${ws.id}`,
            widthRatio: 0.38,
            groups: [
              {
                id: `group-chat-${ws.id}`,
                activeCardId: 'chat',
                cards: [{ id: 'chat', title: 'Chat' }],
                heightRatio: 1.0,
              },
            ],
          },
          {
            id: `col-1-${ws.id}`,
            widthRatio: 0.31,
            groups: [
              {
                id: `group-preview-${ws.id}`,
                activeCardId: 'preview',
                cards: [{ id: 'preview', title: 'Preview' }],
                heightRatio: 1.0,
              },
            ],
          },
          {
            id: `col-2-${ws.id}`,
            widthRatio: 0.31,
            groups: [
              {
                id: `group-diff-${ws.id}`,
                activeCardId: 'diff',
                cards: [{ id: 'diff', title: 'Diff' }],
                heightRatio: 1.0,
              },
            ],
          },
        ];
      } else if (preset === 'full-chat') {
        ws.columns = [
          {
            id: `col-chat-${ws.id}`,
            widthRatio: 1.0,
            groups: [
              {
                id: `group-chat-${ws.id}`,
                activeCardId: 'chat',
                cards: [{ id: 'chat', title: 'Chat' }],
                heightRatio: 1.0,
              },
            ],
          },
        ];
      } else if (preset === 'telemetry-focus') {
        ws.columns = [
          {
            id: `col-chat-${ws.id}`,
            widthRatio: 0.5,
            groups: [
              {
                id: `group-chat-${ws.id}`,
                activeCardId: 'chat',
                cards: [{ id: 'chat', title: 'Chat' }],
                heightRatio: 1.0,
              },
            ],
          },
          {
            id: `col-runtime-${ws.id}`,
            widthRatio: 0.5,
            groups: [
              {
                id: `group-runtime-${ws.id}`,
                activeCardId: 'pi-runtime',
                cards: [{ id: 'pi-runtime', title: 'Pi Telemetry' }],
                heightRatio: 1.0,
              },
            ],
          },
        ];
      }
    }),
  }))
);

if (typeof window !== 'undefined') {
  (window as any).useLayoutStore = useLayoutStore;
}
