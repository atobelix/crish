import { describe, expect, it } from 'vitest';
import { resolveTabView } from './tabViewAdapter';

describe('tabViewAdapter 顶栏标签视图解析适配器', () => {
  it('正确解析会话标签 (ChatTab)', () => {
    const res = resolveTabView({
      kind: 'chat',
      tabId: 'tab_chat_1',
      sessionId: 'sess_abc123',
    });

    expect(res).toEqual({
      viewId: 'chat',
      sessionId: 'sess_abc123',
    });
  });

  it('正确解析独立常规终端 (StandaloneTerminalTab)，注入 isStandalone: true 且无工作区路径泄漏', () => {
    const res = resolveTabView({
      kind: 'terminal',
      tabId: 'tab_term_1',
      terminalKey: 'standalone:term_tab_term_1',
      isStandalone: true,
    });

    expect(res).toEqual({
      viewId: 'terminal',
      params: {
        terminalKey: 'standalone:term_tab_term_1',
        cwd: undefined,
        isStandalone: true,
      },
      sessionId: 'standalone:term_tab_term_1',
    });
  });

  it('独立常规终端若显式传入自定义 cwd，正确透传而不覆盖', () => {
    const res = resolveTabView({
      kind: 'terminal',
      tabId: 'tab_term_custom',
      terminalKey: 'standalone:term_custom',
      cwd: 'C:/Users/orange',
      isStandalone: true,
    });

    expect(res).toEqual({
      viewId: 'terminal',
      params: {
        terminalKey: 'standalone:term_custom',
        cwd: 'C:/Users/orange',
        isStandalone: true,
      },
      sessionId: 'standalone:term_custom',
    });
  });

  it('正确解析独立浏览器标签 (BrowserTabLike)，映射为 preview 视图且 sessionId 为 undefined', () => {
    const res = resolveTabView({
      kind: 'browser',
      tabId: 'tab_browser_1',
      url: 'https://github.com',
      title: 'GitHub',
    });

    expect(res).toEqual({
      viewId: 'preview',
      params: {
        tabId: 'tab_browser_1',
        url: 'https://github.com',
        initialUrl: 'https://github.com',
      },
      sessionId: undefined,
    });
  });

  it('独立浏览器标签若未指定 url 或为空字符串，默认回退到 about:blank', () => {
    const res1 = resolveTabView({
      kind: 'browser',
      tabId: 'tab_browser_empty',
      url: '',
    });

    expect(res1).toEqual({
      viewId: 'preview',
      params: {
        tabId: 'tab_browser_empty',
        url: 'about:blank',
        initialUrl: 'about:blank',
      },
      sessionId: undefined,
    });

    const res2 = resolveTabView({
      kind: 'browser',
      tabId: 'tab_browser_undef',
    });

    expect(res2).toEqual({
      viewId: 'preview',
      params: {
        tabId: 'tab_browser_undef',
        url: 'about:blank',
        initialUrl: 'about:blank',
      },
      sessionId: undefined,
    });
  });

  it('未提供 activeTab 或空对象时安全回退到 chat 视图', () => {
    expect(resolveTabView(null)).toEqual({
      viewId: 'chat',
      sessionId: undefined,
    });
    expect(resolveTabView(undefined)).toEqual({
      viewId: 'chat',
      sessionId: undefined,
    });
  });
});
