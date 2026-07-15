import { useLayoutStore } from '../store/layoutStore';
import type { SessionState, SessionMessage } from '../store/layoutStore';
import { streamViaDaemon } from './daemonChatBridge';
import { getDesktopDaemonClient } from './daemonClient';
import { isDemoMode } from './appMode';

// Initial long mock data for testing
const INITIAL_MOCK_SESSIONS: SessionState[] = [
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
        text: 'Let me try directly creating a test trigger to isolate the issue. We need to verify if the content scripts are correctly registered in the extension manifest and if there are any conflicting selectors injected by other chrome extensions in the window scope. This is a very long user message specifically designed to test the automatic folding and collapsible toggle layout implementation under the chat panel scroll viewport. In production environments, users often paste large chunks of stack traces, raw configuration settings, or multi-line error logs. Having a clean collapsible UI that fades the text gracefully is critical to preserving workspace aesthetics and preventing layout shifts or jitter. Let\'s make sure that expanding or collapsing this message updates the scroll boundaries without jumping, and that the copy and withdraw tools overlay properly at the bottom right corner without colliding with the text characters.',
        timestamp: Date.now() - 3600000
      },
      {
        id: 'msg-2',
        sender: 'assistant',
        text: '经过初步的代码审计与工作区检索，我已经发现了可能冲突的行内按钮标签。以下是具体的诊断步骤和检测日志：',
        timestamp: Date.now() - 3500000,
        toolCalls: [
          {
            id: 'tc-grep-1',
            name: 'grep_search',
            arguments: 'data-flowbit-inline="1"',
            status: 'success',
            explanation: '在工作区搜索冲突的行内按钮标签 data-flowbit-inline="1"',
            output: 'ripgrep searching pattern "data-flowbit-inline=\\"1\\"" in path "/c/Software/conex"...\n\nFound 3 matches across 2 files:\n\n1. apps/browser-extension/src/trigger-injector.ts:\n   Line 42: <button data-flowbit-inline="1" class="fab-trigger-btn">F</button>\n   Line 108: const target = document.querySelector("[data-flowbit-inline=\\"1\\"]");\n\n2. packages/shared-types/src/config.ts:\n   Line 15:   inlineSelector?: "[data-flowbit-inline=\\"1\\"]";\n\nSearch complete. 48 files analyzed, 3 matches found. Execution time: 42ms.'
          },
          {
            id: 'tc-read-1',
            name: 'read_file',
            arguments: 'trigger-injector.ts',
            status: 'success',
            explanation: '读取 trigger-injector.ts 以分析按钮挂载逻辑与生命周期',
            output: 'Reading file "trigger-injector.ts"...\nFile size: 2450 bytes.\nFile contents read successfully:\n\n=================== FILE START ===================\nimport { SVG_ICON } from "./icons";\nimport { getSharedConfig } from "@conex/shared-types";\n\nexport function acquireInlineBtn() {\n  // Attempt to locate an existing button injected into the DOM tree\n  let btn = document.querySelector("[data-flowbit-inline]");\n  \n  if (!btn) {\n    console.log("[Flowbit] Creating new action button element");\n    btn = document.createElement("button");\n    btn.setAttribute("data-flowbit-inline", "1");\n    btn.className = "fab-trigger-btn";\n  }\n  \n  // BUG HERE: We are returning the button instance directly without\n  // validating if another extension has hijacked the inner HTML or\n  // modified the SVG child elements.\n  return btn;\n}\n\nexport function mountTrigger(container: HTMLElement) {\n  const btn = acquireInlineBtn();\n  if (btn && !container.contains(btn)) {\n    container.appendChild(btn);\n    console.log("[Flowbit] Action trigger button mounted successfully");\n  }\n}\n=================== FILE END ==================='
          }
        ]
      },
      {
        id: 'msg-3',
        sender: 'assistant',
        text: '为了排除是否由于第三方扩展库命名的样式污染导致图标渲染失效，我执行了更广泛的 CSS 样式排查：',
        timestamp: Date.now() - 3400000,
        toolCalls: [
          {
            id: 'tc-grep-2',
            name: 'grep_search',
            arguments: 'flowbit-inline-style',
            status: 'success',
            explanation: '在整个工作区搜索 flowbit-inline-style 样式以排除命名冲突',
            output: 'Searching pattern "flowbit-inline-style" in all workspace modules...\n\nSearching... (excluding node_modules, dist, and .git)\n- apps/browser-extension/src/content-script.css: Line 85: .flowbit-inline-style-container { display: flex; }\n- apps/browser-extension/dist/assets/index.css: Line 412: .flowbit-inline-style-container{display:flex;}\n\nFound 2 matches in 2 files. No conflicting global styles or style selectors declared by external design systems.'
          }
        ]
      },
      {
        id: 'msg-4',
        sender: 'assistant',
        text: '找到根源了！由于其他一些浏览器插件（如 "All API Hub"）也向 DOM 注入了带有 `[data-flowbit-inline]` 属性的按钮，我们的 `acquireInlineBtn` 误以为它是我们自己创建的并直接复用。但由于它的 `innerHTML` 只有 "F" 并没有 SVG 图标，导致最终界面上呈现出了字符 "F" 的按钮。我已经修改了该逻辑，确保按钮被复用时自动覆盖并重置其 SVG 结构。',
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
                  { type: 'normal', content: 'export function acquireInlineBtn() {' },
                  { type: 'normal', content: '  let btn = document.querySelector("[data-flowbit-inline]");' },
                  { type: 'deletion', content: '  return btn;' },
                  { type: 'addition', content: '  if (btn) {' },
                  { type: 'addition', content: '    // Overwrite content if it has been mutated by other content scripts' },
                  { type: 'addition', content: '    if (btn.innerHTML !== SVG_ICON) {' },
                  { type: 'addition', content: '      btn.innerHTML = SVG_ICON;' },
                  { type: 'addition', content: '    }' },
                  { type: 'addition', content: '  } else {' },
                  { type: 'addition', content: '    btn = document.createElement("button");' },
                  { type: 'addition', content: '    btn.setAttribute("data-flowbit-inline", "1");' },
                  { type: 'addition', content: '    btn.className = "fab-trigger-btn";' },
                  { type: 'addition', content: '    btn.innerHTML = SVG_ICON;' },
                  { type: 'addition', content: '  }' },
                  { type: 'normal', content: '  return btn;' },
                  { type: 'normal', content: '}' }
                ]
              }
            ]
          }
        ]
      },
      {
        id: 'msg-5',
        sender: 'user',
        text: 'I see. Please perform a dry-run production build to check if the bundle size constraints and CSS extraction modules compile correctly after this refactoring. Also, let\'s run the unit tests inside apps/browser-extension to verify that no core triggers are broken by this SVG injector modification.',
        timestamp: Date.now() - 3100000
      },
      {
        id: 'msg-6',
        sender: 'assistant',
        text: '我已经启动了项目的完整构建管道和自动化单元测试，运行报告如下：',
        timestamp: Date.now() - 3000000,
        toolCalls: [
          {
            id: 'tc-build-1',
            name: 'run_command',
            arguments: 'npm run build',
            status: 'success',
            explanation: '运行打包编译命令 npm run build 验证构建是否通过',
            output: 'vite v8.0.16 building client environment for production...\n✓ 589 modules transformed.\nrendering chunks...\ncomputing gzip size...\n\n- dist/index.html                     0.46 kB │ gzip:  0.29 kB\n- dist/assets/index-2PqGUG_A.css     30.11 kB │ gzip:  5.57 kB\n- dist/assets/index-C068c687.js     270.20 kB │ gzip: 83.06 kB\n\n✓ built in 482ms\nBundle verification check: SUCCESS. All bundles are under the 300kB limit.'
          },
          {
            id: 'tc-test-1',
            name: 'run_command',
            arguments: 'npm run test:unit',
            status: 'success',
            explanation: '运行单元测试组件验证 acquireInlineBtn 和 SVG 按钮的行为',
            output: 'vitest v1.5.0\n\n✓ apps/browser-extension/src/__tests__/trigger.test.ts (3)\n  ✓ acquireInlineBtn() should return SVG icon content\n  ✓ acquireInlineBtn() should create new button if none exists\n  ✓ acquireInlineBtn() should reuse and overwrite non-SVG buttons\n\nTest Files: 1 passed (1 total)\nTests: 3 passed (3 total)\nSnapshots: 0 total\nTime: 1.15s (executing 3 tests in 18ms)\n\nAll unit tests passed successfully!'
          }
        ]
      },
      {
        id: 'msg-7',
        sender: 'assistant',
        text: '我已经追踪到并修复了这个问题的根源。以下是本次修改的全面总结：\n\n**1. 根源分析**\n- 我们的扩展在挂载触发器时，会调用 `acquireInlineBtn` 查找 DOM 中已有的 `[data-flowbit-inline]` 属性按钮。\n- 由于另一个第三方 Chrome 插件（如 "All API Hub"）往页面上注入了一个占位的 `<button data-flowbit-inline="1">F</button>`，我们的逻辑在查找到该元素后，直接将其复用，而没有清除或重写它的 innerHTML。\n- 结果导致原本应该显示 SVG 矢量图标的按钮只显示了字符 "F"，严重影响了界面的视觉品质与整体稳重感。\n\n**2. 解决方案实现**\n- 我在 [trigger-injector.ts](file:///c:/Software/conex/reference/crish-desktop/src/components/CardPanel.tsx) 中重构了 `acquireInlineBtn` 的复用检测。\n- 如果查找到已有按钮但它的 innerHTML 不是我们的标准 SVG 图标，将强制清空并注入 `SVG_ICON`，否则将全新创建按钮并注入图标。\n- 随后我运行了生产包构建，在 482ms 内顺利编译通过，且无任何语法警告。\n- 执行了 `npm run test:unit` 单元测试，3 项用例全部满分通过，证明逻辑没有任何回归问题。\n\n**3. 下步手动操作建议**\n- 您可以进入浏览器 `chrome://extensions` 页面，点击 "Chat Sync Bridge" 的 **重新加载** 按钮。\n- 重新打开 Claude 或 ChatGPT 会话页面，强制刷新 (Ctrl+F5) 以清空内容脚本缓存，即可看到美化后的 SVG 触发图标显示在行内。',
        timestamp: Date.now() - 2800000
      }
    ]
  },
  { 
    id: 'sess-3', 
    title: 'Fix voice playback timing and overlap', 
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

// In-memory mock database
let sessionDb: SessionState[] = populateBlocksForSessions(INITIAL_MOCK_SESSIONS);

export const fetchSessionsApi = async (): Promise<SessionState[]> => {
  // Simulate network fetch delay
  await new Promise(resolve => setTimeout(resolve, 400));
  return JSON.parse(JSON.stringify(sessionDb));
};

export const saveMessageToDb = (sessionId: string, message: SessionMessage) => {
  const sess = sessionDb.find(s => s.id === sessionId);
  if (sess) {
    if (!sess.messages) sess.messages = [];
    sess.messages.push(message);
  }
};

export const withdrawMessageFromDb = (sessionId: string, messageId: string) => {
  const sess = sessionDb.find(s => s.id === sessionId);
  if (sess && sess.messages) {
    const idx = sess.messages.findIndex(m => m.id === messageId);
    if (idx !== -1) {
      sess.messages = sess.messages.slice(0, idx);
    }
  }
};

export interface StreamCallbacks {
  onThought: (thought: string) => void;
  onToolStart: (toolId: string, name: string, args: string, explanation: string) => void;
  onToolSuccess: (toolId: string, output: string, diffs?: any[]) => void;
  onToolError: (toolId: string, error: string) => void;
  onChunk: (chunk: string) => void;
  onComplete: () => void;
  onToolPendingApproval?: (toolId: string, name: string, args: string, explanation: string) => void;
  onTerminalLine?: (line: string) => void;
  /** H3：暴露 runId 以便拉取 snapshot usage */
  onRunMeta?: (meta: { runId: string }) => void;
  /** 审批结果（含完全访问自动放行） */
  onApprovalResolved?: (toolCallId: string, decision: 'allow' | 'deny') => void;
  /** 协作子 agent 生命周期（侧栏列表 / 面板） */
  onSubagentStarted?: (info: {
    subagentId: string;
    subagentRunId: string;
    parentRunId: string;
    parentToolCallId?: string;
    description: string;
    mode: string;
  }) => void;
  onSubagentEvent?: (info: {
    subagentId: string;
    subagentRunId: string;
    event: Record<string, unknown>;
  }) => void;
  onSubagentEnded?: (info: {
    subagentId: string;
    subagentRunId: string;
    status: 'completed' | 'failed';
    summary?: string;
  }) => void;
}

const getMockModuleName = (idx: number): string => {
  const packages = ['react', 'react-dom', 'lucide-react', 'zustand', 'scheduler', 'prop-types', 'lodash', 'axios', 'classnames', 'immer', 'vite', 'esbuild', 'rollup'];
  const files = ['index.js', 'cjs/react.development.js', 'esm/index.js', 'utils.js', 'core.js', 'store.js', 'helpers.js', 'diff.js', 'parser.js', 'styles.css', 'index.css'];
  return packages[idx % packages.length] + '/src/' + files[(idx + 5) % files.length] + `?mod=${idx}`;
};

/**
 * Mock stream only in demo mode (or explicit slash / mock flag).
 * Production / normal mode always hits the real engine.
 */
function shouldUseMockStream(prompt: string): boolean {
  // Hard block: production never mocks
  if (import.meta.env.PROD && import.meta.env.VITE_ALLOW_DEMO !== '1') {
    return false;
  }
  if (!isDemoMode()) {
    // Even outside demo, allow explicit /mock only when demo tooling is allowed
    const p = prompt.trim().toLowerCase();
    if (
      (p.startsWith('/simulate') ||
        p.startsWith('/demo') ||
        p.startsWith('/workflow') ||
        p.startsWith('/mock')) &&
      import.meta.env.DEV
    ) {
      return true;
    }
    return false;
  }
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('crish_use_mock') === '1') {
      return true;
    }
  } catch {
    /* ignore */
  }
  // In demo mode, all messages can use mock stream (UI playground)
  return true;
}

/**
 * Stream assistant response.
 * Prefer daemon WebSocket when available; mock only for demo commands or crish_use_mock=1.
 */
export const streamAssistantResponseApi = (
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId?: string,
  assistantMsgId?: string
) => {
  if (!shouldUseMockStream(prompt)) {
    const sid = sessionId || `sess-${Date.now()}`;
    const aid = assistantMsgId || `asst-${Date.now()}`;
    // Prefer real backend for desktop product path
    void getDesktopDaemonClient();
    return streamViaDaemon(prompt, callbacks, sid, aid);
  }
  return streamMockAssistantResponse(prompt, callbacks, sessionId, assistantMsgId);
};

/** UI / demo mock stream (not used for real agent runs). */
const streamMockAssistantResponse = (
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId?: string,
  assistantMsgId?: string,
) => {
  let isCancelled = false;

  const run = async () => {
    // 1. Initial thought block
    if (isCancelled) return;
    
    if (prompt.toLowerCase().startsWith('/simulate') || prompt.toLowerCase().startsWith('/demo') || prompt.toLowerCase().startsWith('/workflow') || prompt.toLowerCase().startsWith('/mock')) {
      if (isCancelled) return;
      callbacks.onThought('我已收到您的工作流仿真指令。接下来，我将启动 Conex 自动化流水线。该演示是一个长达 1 分钟的多阶段交互流程，将动态分析、重构代码并执行构建与单元测试。当前阶段：启动工作区模块依赖关系分析...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (isCancelled) return;
      // Step 1: grep_search
      callbacks.onThought('【阶段 1/6：全局搜索】正在使用 `grep_search` 搜索与状态树 `useLayoutStore` 和消息队列挂载相关的接口声明，以绘制模块调用关系拓扑。');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const grepId = `tc-sim-grep-${Date.now()}`;
      callbacks.onToolStart(grepId, 'grep_search', 'useLayoutStore.getState()', '搜索工作区中所有对 layoutStore 状态库的直接引用');
      await new Promise(resolve => setTimeout(resolve, 1500));

      let grepResults = `ripgrep searching pattern "useLayoutStore.getState()" in path "c:/Software/conex"...\n\n`;
      const filesList = [
        'src/components/CardPanel.tsx',
        'src/components/Sidebar.tsx',
        'src/components/Workspace.tsx',
        'src/store/layoutStore.ts',
        'src/main.tsx',
        'src/api/chatApi.ts'
      ];
      filesList.forEach((file, fileIdx) => {
        grepResults += `${fileIdx + 1}. ${file}:\n`;
        for (let l = 1; l <= 5; l++) {
          grepResults += `   Line ${l * 42 + fileIdx * 15}: const state = useLayoutStore.getState(); // Retrieve active layout coordinates\n`;
        }
        grepResults += `\n`;
      });
      grepResults += `Search complete. 12 files scanned, 30 matches found in 38ms.`;
      
      if (isCancelled) return;
      callbacks.onToolSuccess(grepId, grepResults);
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Step 2: read_file
      if (isCancelled) return;
      callbacks.onThought('【阶段 2/6：阅读源码】根据全局搜索结果，核心状态分发位于 `src/store/layoutStore.ts`。接下来，我将读取该状态文件的动作和接口声明，分析并发批处理协议的可扩展性。');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const readId = `tc-sim-read-${Date.now()}`;
      callbacks.onToolStart(readId, 'read_file', 'src/store/layoutStore.ts', '读取 layoutStore.ts 的数据类型声明与动作管道接口');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const mockStoreCode = `import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface CardState {
  id: string; // 'plan' | 'preview' | 'diff' | 'tasks' | 'terminal'
  title: string;
}

export interface CardGroupState {
  id: string;
  activeCardId: string;
  cards: CardState[];
  heightRatio: number;
}

export interface ColumnState {
  id: string;
  widthRatio: number;
  groups: CardGroupState[];
}

export interface WorkspaceState {
  id: string;
  columns: ColumnState[];
}

export interface MessageToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'running' | 'success' | 'error' | 'pending_approval';
  output?: string;
  diffs?: FileDiff[];
}

export interface LayoutStoreState {
  workspaces: WorkspaceState[];
  activeSessionId: string;
  commandPermissions: string[];
  respondToApproval: (wsId: string, sessionId: string, messageId: string, toolCallId: string, status: 'success' | 'error') => void;
  // State reducer core is fully defined below...
}`;
      if (isCancelled) return;
      callbacks.onToolSuccess(readId, mockStoreCode);
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Step 3: write_to_file
      if (isCancelled) return;
      callbacks.onThought('【阶段 3/6：执行重构】分析完毕。我将在 `layoutStore.ts` 中注入一个新的并发状态钩子 `concurrencyWorkerState`，以监控流水线的实时执行负载。正在将代码写入本地文件...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const writeId = `tc-sim-write-${Date.now()}`;
      callbacks.onToolStart(writeId, 'write_to_file', 'src/store/layoutStore.ts', '在 layoutStore.ts 中写入并发监控接口和动作逻辑');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const mockDiff = [
        {
          filePath: 'src/store/layoutStore.ts',
          additions: 12,
          deletions: 2,
          changes: [
            { type: 'normal' as const, content: 'export interface LayoutStoreState {' },
            { type: 'normal' as const, content: '  workspaces: WorkspaceState[];' },
            { type: 'addition' as const, content: '  /* Add concurrency worker state telemetry */' },
            { type: 'addition' as const, content: '  concurrencyWorkerState?: {' },
            { type: 'addition' as const, content: '    activeWorkersCount: number;' },
            { type: 'addition' as const, content: '    pendingApprovalsCount: number;' },
            { type: 'addition' as const, content: '    telemetryTimestamp: number;' },
            { type: 'addition' as const, content: '  };' },
            { type: 'addition' as const, content: '  setWorkerState: (workers: number, approvals: number) => void;' },
            { type: 'deletion' as const, content: '  debug?: boolean;' },
            { type: 'addition' as const, content: '  debug?: boolean;' },
            { type: 'normal' as const, content: '  commandPermissions: string[];' }
          ]
        }
      ];
      if (isCancelled) return;
      callbacks.onToolSuccess(writeId, 'File src/store/layoutStore.ts written successfully. Local workspace canvas updated.', mockDiff);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 4: Sensitive command — full 自动；ask/auto 等待；plan 在正式路径由引擎拒绝
      if (isCancelled) return;
      const approveToolId = `tc-sim-approve-${Date.now()}`;
      const sensitiveCmd = 'npm run build:prod --dry-run';
      const permMode = useLayoutStore.getState().permissionMode;
      const autoOk =
        permMode === 'full' ||
        useLayoutStore.getState().commandPermissions.some(
          (allowed) => sensitiveCmd.startsWith(allowed) || allowed.startsWith(sensitiveCmd),
        );
      // plan：跳过敏感命令；full：自动；ask/auto：等审批
      if (permMode === 'plan') {
        callbacks.onThought(
          '【阶段 4/6：计划模式】当前为只读规划，跳过会改状态的命令。',
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
      } else if (autoOk) {
        callbacks.onThought(
          '【阶段 4/6：执行敏感命令】当前为「完全访问」模式，将直接运行生产构建校验，不再弹确认。',
        );
        await new Promise((resolve) => setTimeout(resolve, 1200));
        callbacks.onToolStart(
          approveToolId,
          'run_command',
          sensitiveCmd,
          '运行打包编译器 npm run build:prod 校验整站依赖树和体积预算',
        );
      } else {
        callbacks.onThought(
          '【阶段 4/6：敏感操作审批】本地重构完成。当前模式需确认后才会执行敏感命令。',
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const startTool = callbacks.onToolPendingApproval || callbacks.onToolStart;
        startTool(
          approveToolId,
          'run_command',
          sensitiveCmd,
          '运行打包编译器 npm run build:prod 校验整站依赖树和体积预算',
        );

        let isApproved = false;
        while (!isCancelled) {
          const sess = useLayoutStore.getState().sessions.find((s) => s.id === sessionId);
          const msg = sess?.messages.find((m) => m.id === assistantMsgId);
          const tc = msg?.toolCalls?.find((t) => t.id === approveToolId);
          if (tc) {
            if (tc.status === 'success') {
              isApproved = true;
              break;
            } else if (tc.status === 'error') {
              isApproved = false;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (isCancelled) return;
        if (!isApproved) {
          callbacks.onThought('审批被拒绝。已终止自动化演示流程。');
          callbacks.onComplete();
          return;
        }
      }

      if (isCancelled) return;

      // 计划模式：只读规划结束，不模拟写操作后续流水线
      if (permMode === 'plan') {
        const planSummary =
          '### 计划模式\n\n当前为只读规划：已分析相关代码与结构，**不会**执行改文件或构建命令。\n\n' +
          '如需落地修改，请将权限切换为「需确认 / 自动 / 完全访问」后再继续。';
        let planText = '';
        for (let i = 0; i < planSummary.length; i += 6) {
          if (isCancelled) return;
          planText += planSummary.slice(i, i + 6);
          callbacks.onChunk(planText);
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      } else {
      // Step 5: Vite Build Command Streaming
      callbacks.onThought('【审批已批准】正在初始化打包环境并注入静态资源编译器，执行 `npm run build:prod --dry-run`...');
      await new Promise(resolve => setTimeout(resolve, 2500));

      let currentBuildLogs = 'vite v8.0.16 building client environment for production...\n';
      callbacks.onTerminalLine?.('vite v8.0.16 building client environment for production...');
      useLayoutStore.getState().updateMessageToolCall(sessionId || '', assistantMsgId || '', approveToolId, { output: currentBuildLogs });

      const totalModules = 589;
      const buildChunkSize = 40;
      for (let m = 1; m <= totalModules; m += buildChunkSize) {
        if (isCancelled) return;
        let linesChunk = '';
        for (let idx = m; idx < m + buildChunkSize && idx <= totalModules; idx++) {
          const logLine = `✓ ${idx}/589 modules transformed - node_modules/` + getMockModuleName(idx);
          linesChunk += logLine + '\n';
          callbacks.onTerminalLine?.(logLine);
        }
        currentBuildLogs += linesChunk;
        useLayoutStore.getState().updateMessageToolCall(sessionId || '', assistantMsgId || '', approveToolId, { output: currentBuildLogs });
        await new Promise(resolve => setTimeout(resolve, 600));
      }

      const buildDoneLog = '\n✓ built in 482ms\n' +
        'dist/index.html                     0.46 kB │ gzip:  0.29 kB\n' +
        'dist/assets/index-2PqGUG_A.css     30.11 kB │ gzip:  5.57 kB\n' +
        'dist/assets/index-C068c687.js     270.20 kB │ gzip: 83.06 kB\n\n' +
        'Bundle size verification: SUCCESS. All bundles are under the 300kB limit.';
      currentBuildLogs += buildDoneLog;
      callbacks.onTerminalLine?.('✓ built in 482ms');
      callbacks.onTerminalLine?.('dist/index.html                     0.46 kB │ gzip:  0.29 kB');
      callbacks.onTerminalLine?.('dist/assets/index-2PqGUG_A.css     30.11 kB │ gzip:  5.57 kB');
      callbacks.onTerminalLine?.('dist/assets/index-C068c687.js     270.20 kB │ gzip: 83.06 kB');
      callbacks.onTerminalLine?.('Bundle size verification: SUCCESS. All bundles are under the 300kB limit.');
      
      if (isCancelled) return;
      callbacks.onToolSuccess(approveToolId, currentBuildLogs);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 6: ESLint check streaming
      if (isCancelled) return;
      callbacks.onThought('【阶段 5/6：静态代码质量审计】编译打包无死区或编译错误。为核对重构后的变量生命周期，我将启动 ESLint 静态代码分析：`npm run lint`...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const lintToolId = `tc-sim-lint-${Date.now()}`;
      callbacks.onToolStart(lintToolId, 'run_command', 'npm run lint', '执行 ESLint 整站静态代码审计');
      await new Promise(resolve => setTimeout(resolve, 1500));

      let currentLintLogs = 'eslint --ext .ts,.tsx src --max-warnings 0\n';
      callbacks.onTerminalLine?.('eslint --ext .ts,.tsx src --max-warnings 0');
      useLayoutStore.getState().updateMessageToolCall(sessionId || '', assistantMsgId || '', lintToolId, { output: currentLintLogs });

      const totalFiles = 120;
      const lintChunkSize = 20;
      for (let f = 1; f <= totalFiles; f += lintChunkSize) {
        if (isCancelled) return;
        let linesChunk = '';
        for (let idx = f; idx < f + lintChunkSize && idx <= totalFiles; idx++) {
          const logLine = `Scanning src/file_${idx}.tsx... [OK]`;
          linesChunk += logLine + '\n';
          callbacks.onTerminalLine?.(logLine);
        }
        currentLintLogs += linesChunk;
        useLayoutStore.getState().updateMessageToolCall(sessionId || '', assistantMsgId || '', lintToolId, { output: currentLintLogs });
        await new Promise(resolve => setTimeout(resolve, 600));
      }

      const lintDoneLog = '\nLint analysis completed: 0 errors, 0 warnings. Code quality check: PASSED.';
      currentLintLogs += lintDoneLog;
      callbacks.onTerminalLine?.('Lint analysis completed: 0 errors, 0 warnings. Code quality check: PASSED.');
      
      if (isCancelled) return;
      callbacks.onToolSuccess(lintToolId, currentLintLogs);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 7: Vitest Unit Test streaming
      if (isCancelled) return;
      callbacks.onThought('【阶段 6/6：回归测试套件】静态代码质量审计通过。最后，我将启动 Vitest 单元与集成测试套件 `npm run test:unit` 对新增的状态逻辑与 Timeline 队列进行回归校验。');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const testToolId = `tc-sim-test-${Date.now()}`;
      callbacks.onToolStart(testToolId, 'run_command', 'npm run test:unit', '运行 vitest 回归测试套件');
      await new Promise(resolve => setTimeout(resolve, 1500));

      let currentTestLogs = 'vitest v1.5.0\n';
      callbacks.onTerminalLine?.('vitest v1.5.0');
      useLayoutStore.getState().updateMessageToolCall(sessionId || '', assistantMsgId || '', testToolId, { output: currentTestLogs });

      const suites = ['components/CardPanel', 'components/Sidebar', 'store/layoutStore', 'api/chatApi', 'utils/markdown', 'components/Workspace'];
      const testNames = ['renders correctly', 'handles user clicks', 'resets state on close', 'validates inputs', 'updates layout on drag', 'supports collapsible bubbles', 'renders tooltips with centered arrow'];

      for (let s = 0; s < suites.length; s++) {
        if (isCancelled) return;
        let suiteLog = `\nRUNNING  src/${suites[s]}.test.tsx\n`;
        callbacks.onTerminalLine?.(`RUNNING  src/${suites[s]}.test.tsx`);
        currentTestLogs += suiteLog;
        useLayoutStore.getState().updateMessageToolCall(sessionId || '', assistantMsgId || '', testToolId, { output: currentTestLogs });
        await new Promise(resolve => setTimeout(resolve, 500));

        let caseLogs = '';
        for (let t = 0; t < 6; t++) {
          const testLine = `  ✓ ${suites[s]} > ${testNames[(t + s) % testNames.length]} (${Math.floor(Math.random() * 40) + 10}ms)`;
          caseLogs += testLine + '\n';
          callbacks.onTerminalLine?.(testLine);
        }
        currentTestLogs += caseLogs;
        useLayoutStore.getState().updateMessageToolCall(sessionId || '', assistantMsgId || '', testToolId, { output: currentTestLogs });
        await new Promise(resolve => setTimeout(resolve, 600));
      }

      const testDoneLog = '\nTest Files: 6 passed (6 total)\nTests: 36 passed (36 total)\nSnapshots: 0 total\nTime: 7.82s\n\nAll test checkpoints verified successfully!';
      currentTestLogs += testDoneLog;
      callbacks.onTerminalLine?.('Test Files: 6 passed (6 total)');
      callbacks.onTerminalLine?.('Tests: 36 passed (36 total)');
      callbacks.onTerminalLine?.('Time: 7.82s');
      callbacks.onTerminalLine?.('All test checkpoints verified successfully!');
      
      if (isCancelled) return;
      callbacks.onToolSuccess(testToolId, currentTestLogs);
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Final summary message chunk streaming
      if (isCancelled) return;
      callbacks.onThought('自动化流水线演示完毕！编译、Lint 质量规范以及 vitest Regression 测试套件全部绿灯通过。现在为您生成完整的总结报告...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      const summaryText = '### 🚀 Conex 自动化重构与校验流水线执行完毕！\n\n' +
        '**1. 执行阶段统计**：\n' +
        '- **全局模块检索**：Grep 检索到 30 处状态库调用点，确定重构点。\n' +
        '- **源码信息读取**：对 `layoutStore.ts` 的接口协议与 reduce reducer 进行了阅读分析。\n' +
        '- **重构代码写入**：向 `layoutStore.ts` 增写了并发任务监控接口 `concurrencyWorkerState`，已实时回填至工作区。\n' +
        '- **生产构建检验**：经敏感操作安全审批后，启动 Vite 生产环境打包，在 482ms 内完成 589 个模块构建，体积符合预算。\n' +
        '- **规范静态审计**：ESLint 对 120 个源文件进行了扫描校验，0 错误 0 警告。\n' +
        '- **自动化单元测试**：Vitest 启动 6 项回归测试文件套件，36 个测试用例全部满分通过。\n\n' +
        '**2. 交互与功能验证总结**：\n' +
        '- 在流水线连续运行一分多钟的过程中，控制台与 Timeline 中的一千多行构建日志实时滚动渲染，展示了极致的流式处理性能。\n' +
        '- 中途成功触发了操作授权审批 Banner，经过您的手工点击确认后继续运行，验证了我们开发环境的安全防卫机制。';

      let currentText = '';
      for (let i = 0; i < summaryText.length; i += 6) {
        if (isCancelled) return;
        currentText += summaryText.slice(i, i + 6);
        callbacks.onChunk(currentText);
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      } // end non-plan pipeline
    } else {
      callbacks.onThought('正在分析您的问题，查找与您的指令 `' + prompt + '` 相关的代码路径与项目文件结构...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (prompt.toLowerCase().includes('grep') || prompt.includes('搜索') || prompt.includes('查找')) {
      // 1. First search step
      if (isCancelled) return;
      callbacks.onThought('正在分析您的搜索指令 `' + prompt + '`... 我将第一步执行 `grep_search` 在工作区的 `apps/` 目录下搜索 `acquireInlineBtn` 的定义与调用点，分析其依赖拓扑。');
      await new Promise(resolve => setTimeout(resolve, 1000));

      const toolId1 = `tc-stream-grep-1-${Date.now()}`;
      callbacks.onToolStart(toolId1, 'grep_search', 'acquireInlineBtn', '在工作区搜索 acquireInlineBtn 的定义与所有导入位置');
      await new Promise(resolve => setTimeout(resolve, 1500));

      if (isCancelled) return;
      callbacks.onToolSuccess(
        toolId1, 
        'ripgrep searching pattern "acquireInlineBtn" in path "c:/Software/conex"...\n\n' +
        'Found 3 matches across 2 files:\n\n' +
        '1. apps/browser-extension/src/content-script.ts:\n' +
        '   Line 120: const btn = acquireInlineBtn();\n' +
        '   Line 145: // Verify if trigger needs reload\n' +
        '   Line 146: const triggerElement = acquireInlineBtn();\n\n' +
        '2. apps/browser-extension/src/trigger-injector.ts:\n' +
        '   Line 14: export function acquireInlineBtn() {\n\n' +
        'Search operation completed in 184ms. 3 matches found.'
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 2. Read file step
      if (isCancelled) return;
      callbacks.onThought('第一步搜索完毕，确定了该按钮由 `trigger-injector.ts` 导出并被 `content-script.ts` 使用。第二步，我需要使用 `read_file` 深入阅读 `trigger-injector.ts` 的内部实现，以查找按钮复用和挂载冲突的根源。');
      await new Promise(resolve => setTimeout(resolve, 1200));

      const toolId2 = `tc-stream-read-1-${Date.now()}`;
      callbacks.onToolStart(toolId2, 'read_file', 'apps/browser-extension/src/trigger-injector.ts', '读取 trigger-injector.ts 详细解析按钮注入逻辑');
      await new Promise(resolve => setTimeout(resolve, 1600));

      if (isCancelled) return;
      callbacks.onToolSuccess(
        toolId2,
        'Reading file "apps/browser-extension/src/trigger-injector.ts"...\n' +
        'File size: 2450 bytes.\n' +
        'File contents read successfully:\n\n' +
        '=================== FILE START ===================\n' +
        'import { SVG_ICON } from "./icons";\n' +
        'import { getSharedConfig } from "@conex/shared-types";\n\n' +
        'export function acquireInlineBtn() {\n' +
        '  // Attempt to locate an existing button injected into the DOM tree\n' +
        '  let btn = document.querySelector("[data-flowbit-inline]");\n' +
        '  \n' +
        '  if (!btn) {\n' +
        '    console.log("[Flowbit] Creating new action button element");\n' +
        '    btn = document.createElement("button");\n' +
        '    btn.setAttribute("data-flowbit-inline", "1");\n' +
        '    btn.className = "fab-trigger-btn";\n' +
        '  }\n' +
        '  \n' +
        '  // BUG HERE: We are returning the button instance directly without\n' +
        '  // validating if another extension has hijacked the inner HTML or\n' +
        '  // modified the SVG child elements.\n' +
        '  return btn;\n' +
        '}\n\n' +
        'export function mountTrigger(container: HTMLElement) {\n' +
        '  const btn = acquireInlineBtn();\n' +
        '  if (btn && !container.contains(btn)) {\n' +
        '    container.appendChild(btn);\n' +
        '    console.log("[Flowbit] Action trigger button mounted successfully");\n' +
        '  }\n' +
        '}\n' +
        '=================== FILE END ==================='
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 3. Third search step for upstream type imports
      if (isCancelled) return;
      callbacks.onThought('我发现 `acquireInlineBtn` 依赖了 `@conex/shared-types`。为了排除因为接口类型重构带来的上游编译隐患，我将执行第三轮搜索，在 `packages/` 模块下查找是否有对它的相关参数配置。');
      await new Promise(resolve => setTimeout(resolve, 1200));

      const toolId3 = `tc-stream-grep-2-${Date.now()}`;
      callbacks.onToolStart(toolId3, 'grep_search', 'inlineSelector', '在共享包中搜索按钮选择器定义');
      await new Promise(resolve => setTimeout(resolve, 1500));

      if (isCancelled) return;
      callbacks.onToolSuccess(
        toolId3,
        'ripgrep searching pattern "inlineSelector" in path "c:/Software/conex/packages"...\n\n' +
        'Found 1 match in packages/shared-types/src/config.ts:\n' +
        'Line 15:   inlineSelector?: "[data-flowbit-inline=\\"1\\"]";\n\n' +
        'Search operation completed in 62ms.'
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Final summary message chunk streaming
      if (isCancelled) return;
      callbacks.onThought('已经获取到文件的完整依赖结构，现在为您总结我的诊断结果。');
      await new Promise(resolve => setTimeout(resolve, 800));

      const summaryText = '我已经追踪到这个问题的根源了，总结一下发现：\n\n' +
        '**问题原因**：\n' +
        '- 在 `trigger-injector.ts` 中，`acquireInlineBtn` 会优先寻找页面上是否已有 `[data-flowbit-inline]` 属性的按钮，若有则进行复用。\n' +
        '- 页面上由于被其他 Chrome 插件注入了一个空按钮标签 `<button data-flowbit-inline="1">F</button>`，导致我们的内容脚本直接复用了它。\n' +
        '- 但我们在复用时并没有对其 innerHTML 进行 SVG 覆盖重置，因此按钮只显示了一个字符 "F" 并没有显示图标，导致了界面排版的降级。\n\n' +
        '**修改方案**：\n' +
        '- 重构 `acquireInlineBtn`，使其在复用按钮时，若发现内部未挂载 SVG，则自动擦除并注入标准的 `SVG_ICON` 图标。\n' +
        '- 此修改已经在 `packages/shared-types` 和本地包校验中通过，保持了软件组件的高度稳重与一致性。';

      let currentText = '';
      for (let i = 0; i < summaryText.length; i += 6) {
        if (isCancelled) return;
        currentText += summaryText.slice(i, i + 6);
        callbacks.onChunk(currentText);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } 
    else if (prompt.toLowerCase().includes('build') || prompt.includes('编译') || prompt.includes('打包') || prompt.includes('dev')) {
      // 1. Build
      if (isCancelled) return;
      callbacks.onThought('开始启动整个工作区的生产包打包流程，执行 `npm run build`，我们将核对所有静态资源的体积预算与输出结果...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      const toolId1 = `tc-stream-build-${Date.now()}`;
      callbacks.onToolStart(toolId1, 'run_command', 'npm run build', '运行打包编译命令 npm run build 验证构建是否通过');
      await new Promise(resolve => setTimeout(resolve, 1800));

      if (isCancelled) return;
      callbacks.onToolSuccess(
        toolId1,
        'vite v8.0.16 building client environment for production...\n' +
        'transforming...\n' +
        '✓ 589 modules transformed.\n' +
        'rendering chunks...\n' +
        'computing gzip size...\n\n' +
        'dist/index.html                   0.46 kB │ gzip:  0.29 kB\n' +
        'dist/assets/index-2PqGUG_A.css   30.11 kB │ gzip:  5.57 kB\n' +
        'dist/assets/index-C068c687.js   270.20 kB │ gzip: 83.06 kB\n\n' +
        '✓ built in 482ms\n' +
        'Bundle size verification: SUCCESS. Output is well within boundaries.'
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 2. Lint
      if (isCancelled) return;
      callbacks.onThought('构建本身未发生语法错误。为了规范项目代码质量，我接着将执行 `npm run lint` 来排查是否存在多余的导入变量或废弃的代码块...');
      await new Promise(resolve => setTimeout(resolve, 1200));

      const toolId2 = `tc-stream-lint-${Date.now()}`;
      callbacks.onToolStart(toolId2, 'run_command', 'npm run lint', '运行静态代码规范审计命令 npm run lint');
      await new Promise(resolve => setTimeout(resolve, 1600));

      if (isCancelled) return;
      callbacks.onToolSuccess(
        toolId2,
        'eslint --ext .ts,.tsx src --max-warnings 0\n\n' +
        '- apps/browser-extension/src/trigger-injector.ts: Line 15: Warning: Unused variable \'getSharedConfig\' (eslint/no-unused-vars)\n' +
        '- apps/browser-extension/src/content-script.ts: Line 45: Warning: Prefer const over let for variable \'target\' (eslint/prefer-const)\n\n' +
        'Lint analysis completed: 0 errors, 2 warning items (warnings do not block build pipeline).'
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 3. Test
      if (isCancelled) return;
      callbacks.onThought('最后，为了保证我们的重构逻辑没有破坏旧有的功能，我将启动 `npm run test:unit` 对触发器注入器进行回归测试。');
      await new Promise(resolve => setTimeout(resolve, 1200));

      const toolId3 = `tc-stream-test-${Date.now()}`;
      callbacks.onToolStart(toolId3, 'run_command', 'npm run test:unit', '运行单元测试套件进行功能一致性回归校验');
      await new Promise(resolve => setTimeout(resolve, 1800));

      if (isCancelled) return;
      callbacks.onToolSuccess(
        toolId3,
        'vitest v1.5.0\n\n' +
        '✓ apps/browser-extension/src/__tests__/trigger.test.ts (3)\n' +
        '  ✓ acquireInlineBtn() should return SVG icon content ... PASS\n' +
        '  ✓ acquireInlineBtn() should create new button if none exists ... PASS\n' +
        '  ✓ acquireInlineBtn() should reuse and overwrite non-SVG buttons ... PASS\n\n' +
        'Test Files: 1 passed (1 total)\n' +
        'Tests: 3 passed (3 total)\n' +
        'Time: 1.12s\n\n' +
        'All test checkpoints verified successfully!'
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (isCancelled) return;
      callbacks.onThought('编译、Lint规范审计和单元测试的检查全部绿灯通过。现在为您汇报结果。');
      await new Promise(resolve => setTimeout(resolve, 800));

      const summaryText = '编译验证与质量检测均已完成，没有任何构建与功能错误。\n\n' +
        '- **生产环境构建**：打包体积符合预期，没有发现死代码或冗余模块。\n' +
        '- **语法与规范校验**：ESLint 检测通过，仅包含 2 个非阻塞的警告，不影响实际部署。\n' +
        '- **单元测试**：针对触发器劫持与注入的 3 项自动化测试全部绿灯，回归无风险。\n\n' +
        '本地开发环境目前处于最健康的状态，你可以继续进行部署或联调。';

      let currentText = '';
      for (let i = 0; i < summaryText.length; i += 5) {
        if (isCancelled) return;
        currentText += summaryText.slice(i, i + 5);
        callbacks.onChunk(currentText);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } 
    else if (prompt.toLowerCase().includes('write') || prompt.includes('写入') || prompt.includes('修改')) {
      if (isCancelled) return;
      callbacks.onThought('准备将修改写入本地代码。首先我将重载 `trigger-injector.ts`，在 `acquireInlineBtn` 中增加 SVG 图标强制擦除重置逻辑。');
      await new Promise(resolve => setTimeout(resolve, 1000));

      const toolId1 = `tc-stream-write-1-${Date.now()}`;
      callbacks.onToolStart(toolId1, 'write_to_file', 'trigger-injector.ts', '修改 trigger-injector.ts 以重新创建 SVG 按钮内容');
      await new Promise(resolve => setTimeout(resolve, 1600));

      if (isCancelled) return;
      callbacks.onToolSuccess(
        toolId1,
        'File "trigger-injector.ts" modified successfully.',
        [
          {
            filePath: 'trigger-injector.ts',
            additions: 12,
            deletions: 5,
            changes: [
              { type: 'normal', content: 'export function acquireInlineBtn() {' },
              { type: 'normal', content: '  let btn = document.querySelector("[data-flowbit-inline]");' },
              { type: 'deletion', content: '  return btn;' },
              { type: 'addition', content: '  if (btn) {' },
              { type: 'addition', content: '    if (btn.innerHTML !== SVG_ICON) {' },
              { type: 'addition', content: '      btn.innerHTML = SVG_ICON;' },
              { type: 'addition', content: '    }' },
              { type: 'addition', content: '  } else {' },
              { type: 'addition', content: '    btn = document.createElement("button");' },
              { type: 'addition', content: '    btn.setAttribute("data-flowbit-inline", "1");' },
              { type: 'addition', content: '    btn.className = "fab-trigger-btn";' },
              { type: 'addition', content: '    btn.innerHTML = SVG_ICON;' },
              { type: 'addition', content: '  }' },
              { type: 'normal', content: '  return btn;' },
              { type: 'normal', content: '}' }
            ]
          }
        ]
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 2. Write packages/shared-types/src/config.ts
      if (isCancelled) return;
      callbacks.onThought('代码写入成功。为了在多组件间配置该注入行为，我需要同时在共享类型配置文件 `packages/shared-types/src/config.ts` 中添加新的配置字段。');
      await new Promise(resolve => setTimeout(resolve, 1200));

      const toolId2 = `tc-stream-write-2-${Date.now()}`;
      callbacks.onToolStart(toolId2, 'write_to_file', 'packages/shared-types/src/config.ts', '更新共享配置接口以支持 inlineOverride 控制字段');
      await new Promise(resolve => setTimeout(resolve, 1600));

      if (isCancelled) return;
      callbacks.onToolSuccess(
        toolId2,
        'File "packages/shared-types/src/config.ts" modified successfully.',
        [
          {
            filePath: 'packages/shared-types/src/config.ts',
            additions: 4,
            deletions: 1,
            changes: [
              { type: 'normal', content: 'export interface TriggerConfig {' },
              { type: 'normal', content: '  inlineSelector?: string;' },
              { type: 'deletion', content: '  debug?: boolean;' },
              { type: 'addition', content: '  debug?: boolean;' },
              { type: 'addition', content: '  /* Force overwrite external button inner HTML */' },
              { type: 'addition', content: '  inlineOverride?: boolean;' },
              { type: 'normal', content: '}' }
            ]
          }
        ]
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (isCancelled) return;
      callbacks.onThought('文件写入修改成功完成！右侧 Diff 面板已同步更新了两处文件改动。正在生成总结。');
      await new Promise(resolve => setTimeout(resolve, 800));

      const summaryText = '文件写入修改成功完成！\n\n' +
        '已经将 `acquireInlineBtn` 修改为每次自动覆盖 `innerHTML`，确保 SVG 图标始终保持可见状态，成功消除了被其他第三方扩展冲突重写的隐患。\n\n' +
        '同时我们在 `shared-types` 的 `TriggerConfig` 中扩展了 `inlineOverride` 属性定义，以便在生产运行时对该复用擦除行为进行动态开关配置。';

      let currentText = '';
      for (let i = 0; i < summaryText.length; i += 6) {
        if (isCancelled) return;
        currentText += summaryText.slice(i, i + 6);
        callbacks.onChunk(currentText);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    else {
      // Default conversational streaming
      const summaryText = `收到！针对您输入的："${prompt}"，AI 正通过流式模拟引擎提供实时响应测试。\n\n` +
        `为了支持交互调试与长工作流的展示，我们内置了以下几个特殊指令：\n` +
        `- 输入 **\`grep\`** 或 **\`搜索\`**：触发包含 3 轮 grep_search / read_file 的复杂 AI 分析与 timeline 排版，各级工具调用均返回大量高仿真文本信息。\n` +
        `- 输入 **\`build\`** 或 **\`编译\`**：触发 npm run build / lint / test 连环任务的流式模拟，在右栏终端配合展示庞大丰富的构建日志。\n` +
        `- 输入 **\`write\`** 或 **\`写入\`**：触发两处文件改动的模拟，在右侧 Diff 面板同步渲染两块独立的实时差异卡片。\n\n` +
        `在 AI 流式输出的过程中，您可以自由地点击右侧卡片、切换菜单、重构组件，甚至在输入框内继续操作，界面保持 100% 流畅，不影响您的任何交互！`;

      let currentText = '';
      for (let i = 0; i < summaryText.length; i += 5) {
        if (isCancelled) return;
        currentText += summaryText.slice(i, i + 5);
        callbacks.onChunk(currentText);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }

    callbacks.onComplete();
  };

  run();

  return () => {
    isCancelled = true;
  };
};
