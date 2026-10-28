/**
 * 二叉树叶子标签视图解析适配器（Rule G-08 动态视图解析契约）。
 *
 * 架构职责：
 * - 将 UnifiedTab / LeafSessionTab 映射为 ViewRegistry 视图 ID 与对应参数；
 * - 纯函数设计，TreeLeafPanel.tsx 零静态 switch(kind) 与零字典；
 * - 顶栏终端为独立常规终端（StandaloneTerminalTab），默认注入 isStandalone: true，
 *   初始工作目录直通系统家目录，绝不强制调用或注入 getWorkspacePath()。
 */
import type { LeafSessionTab } from './treeLeafPanelModel';

export type TabKind = 'chat' | 'terminal' | 'browser';

export interface BaseTabLike {
  tabId: string;
  title?: string;
  workspaceKey?: string;
}

export interface ChatTabLike extends BaseTabLike {
  kind?: 'chat';
  sessionId?: string;
}

export interface TerminalTabLike extends BaseTabLike {
  kind: 'terminal';
  terminalKey: string;
  cwd?: string;
  sessionId?: string;
  isStandalone?: boolean;
}

export interface BrowserTabLike extends BaseTabLike {
  kind: 'browser';
  url?: string;
  sessionId?: string;
  isStandalone?: boolean;
}

export type UnifiedTab = ChatTabLike | TerminalTabLike | BrowserTabLike;

export interface TabViewResolution {
  viewId: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/**
 * 根据 activeTab 动态解析对应的视图 ID、参数及会话标识。
 *
 * 契约：
 * - terminal: { viewId: 'terminal', params: { terminalKey: tab.terminalKey, cwd: tab.cwd, isStandalone: true }, sessionId: tab.terminalKey }
 * - browser: { viewId: 'preview', params: { tabId: tab.tabId, url, initialUrl: url }, sessionId: undefined }
 * - chat/fallback: { viewId: 'chat', sessionId: tab?.sessionId }
 */
export function resolveTabView(
  tab?: UnifiedTab | LeafSessionTab | null
): TabViewResolution {
  if (!tab) {
    return {
      viewId: 'chat',
      sessionId: undefined,
    };
  }

  const kind = (tab as { kind?: string }).kind;

  if (kind === 'browser') {
    const browser = tab as {
      tabId?: string;
      url?: string;
      title?: string;
    };
    const url = browser.url?.trim() || 'about:blank';
    return {
      viewId: 'preview',
      params: {
        tabId: browser.tabId,
        url,
        initialUrl: url,
      },
      sessionId: undefined,
    };
  }

  if (kind === 'terminal') {
    const term = tab as {
      terminalKey?: string;
      cwd?: string;
      sessionId?: string;
      tabId?: string;
      isStandalone?: boolean;
    };
    const terminalKey = term.terminalKey || term.sessionId || term.tabId || '';
    // 独立常规终端模式下绝不读取 getWorkspacePath()，未指定时由底层解析为系统家目录
    const cwd =
      term.cwd && term.cwd.trim().length > 0 ? term.cwd.trim() : undefined;
    return {
      viewId: 'terminal',
      params: {
        terminalKey,
        cwd,
        isStandalone: true,
      },
      sessionId: terminalKey,
    };
  }

  // chat 或无 kind 的既有会话标签（向下兼容）
  const chat = tab as { sessionId?: string };
  return {
    viewId: 'chat',
    sessionId: chat.sessionId,
  };
}
