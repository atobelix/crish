/**
 * browserSessionLib 纯函数层测试：状态归一化 / payload 校验 / 按钮可用性矩阵。
 * 零 React 依赖，覆盖 BrowserPanel MVP 的状态机契约。
 */
import { describe, expect, it } from 'vitest';
import {
  BROWSER_AI_READY_TEXT,
  BROWSER_SESSION_STATES,
  BROWSER_STATE_DESC,
  BROWSER_STATE_LABEL,
  canKillBrowserSession,
  canStartBrowserSession,
  canStopBrowserSession,
  isBrowserSessionState,
  normalizeBrowserState,
  parseBrowserStatePayload,
} from './browserSessionLib';

describe('normalizeBrowserState（状态机归一化）', () => {
  it('browser_start 的 starting 归一为 launching', () => {
    expect(normalizeBrowserState('starting')).toBe('launching');
  });

  it('七个合法状态原样透传', () => {
    for (const s of BROWSER_SESSION_STATES) {
      expect(normalizeBrowserState(s)).toBe(s);
    }
  });

  it('未知 / 非法值返回 null', () => {
    expect(normalizeBrowserState('unknown')).toBeNull();
    expect(normalizeBrowserState('')).toBeNull();
    expect(normalizeBrowserState(undefined)).toBeNull();
    expect(normalizeBrowserState(null)).toBeNull();
    expect(normalizeBrowserState(42)).toBeNull();
    expect(normalizeBrowserState({})).toBeNull();
  });

  it('isBrowserSessionState 与归一化一致', () => {
    expect(isBrowserSessionState('running')).toBe(true);
    expect(isBrowserSessionState('starting')).toBe(false);
    expect(isBrowserSessionState('pending')).toBe(false);
  });
});

describe('parseBrowserStatePayload（status / 事件载荷校验）', () => {
  it('合法载荷：状态 + 可选 url', () => {
    expect(parseBrowserStatePayload({ state: 'running', url: 'https://a.b' })).toEqual({
      state: 'running',
      url: 'https://a.b',
    });
    expect(parseBrowserStatePayload({ state: 'stopped' })).toEqual({ state: 'stopped' });
  });

  it('starting 归一为 launching', () => {
    expect(parseBrowserStatePayload({ state: 'starting' })).toEqual({
      state: 'launching',
    });
  });

  it('url 非字符串 / 空串时忽略', () => {
    expect(parseBrowserStatePayload({ state: 'running', url: 123 })).toEqual({
      state: 'running',
    });
    expect(parseBrowserStatePayload({ state: 'running', url: '' })).toEqual({
      state: 'running',
    });
  });

  it('非法载荷返回 null（防御引擎异常载荷）', () => {
    expect(parseBrowserStatePayload(null)).toBeNull();
    expect(parseBrowserStatePayload(undefined)).toBeNull();
    expect(parseBrowserStatePayload('running')).toBeNull();
    expect(parseBrowserStatePayload(42)).toBeNull();
    expect(parseBrowserStatePayload({})).toBeNull();
    expect(parseBrowserStatePayload({ state: 'unknown' })).toBeNull();
    expect(parseBrowserStatePayload({ url: 'https://a.b' })).toBeNull();
  });
});

describe('按钮可用性矩阵', () => {
  it('启动：idle / stopped / crashed / error 可用', () => {
    for (const s of ['idle', 'stopped', 'crashed', 'error'] as const) {
      expect(canStartBrowserSession(s)).toBe(true);
    }
  });

  it('启动：launching / running / stopping 不可用', () => {
    for (const s of ['launching', 'running', 'stopping'] as const) {
      expect(canStartBrowserSession(s)).toBe(false);
    }
  });

  it('停止：仅 running 可用', () => {
    expect(canStopBrowserSession('running')).toBe(true);
    for (const s of BROWSER_SESSION_STATES) {
      if (s !== 'running') expect(canStopBrowserSession(s)).toBe(false);
    }
  });

  it('急停：running / launching 可用（其余不可用）', () => {
    expect(canKillBrowserSession('running')).toBe(true);
    expect(canKillBrowserSession('launching')).toBe(true);
    for (const s of ['idle', 'stopping', 'stopped', 'crashed', 'error'] as const) {
      expect(canKillBrowserSession(s)).toBe(false);
    }
  });

  it('每个状态恰好有一个可用入口（idle 仅启动；running 停止+急停）', () => {
    const entryCount = (s: (typeof BROWSER_SESSION_STATES)[number]) =>
      [canStartBrowserSession(s), canStopBrowserSession(s), canKillBrowserSession(s)].filter(Boolean).length;
    expect(entryCount('idle')).toBe(1);
    expect(entryCount('running')).toBe(2);
    expect(entryCount('stopped')).toBe(1);
    expect(entryCount('crashed')).toBe(1);
    expect(entryCount('error')).toBe(1);
    expect(entryCount('launching')).toBe(1);
    expect(entryCount('stopping')).toBe(0);
  });
});

describe('状态文案 / AI 指示', () => {
  it('七个状态均有标题与描述', () => {
    for (const s of BROWSER_SESSION_STATES) {
      expect(BROWSER_STATE_LABEL[s]).toBeTruthy();
      expect(BROWSER_STATE_DESC[s]).toBeTruthy();
    }
  });

  it('运行态就绪指示文案固定', () => {
    expect(BROWSER_AI_READY_TEXT).toBe('AI 浏览器会话已就绪');
  });
});
