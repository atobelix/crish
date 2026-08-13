// @vitest-environment jsdom
/**
 * BrowserPanel 组件测试：状态渲染 / 按钮可用性矩阵 / 操作 invoke / 错误 toast。
 * invoke 走 test-setup 全局 mock；事件订阅 mock @tauri-apps/api/event。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { mockTauriCommand, mockTauriError } from '../../test-setup';
import { BrowserPanel } from './BrowserPanel';
import {
  BROWSER_START_CMD,
  BROWSER_STATUS_CMD,
  BROWSER_STOP_CMD,
} from '../../api/browserSessionApi';

type TauriEventHandler = (e: { payload?: unknown }) => void;

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: new Map<string, TauriEventHandler>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

function emitBrowserEvent(payload: unknown): void {
  for (const handler of eventMock.handlers.values()) {
    handler({ payload });
  }
}

function renderPanel() {
  const onShowToast = vi.fn();
  render(<BrowserPanel onShowToast={onShowToast} />);
  return onShowToast;
}

describe('BrowserPanel', () => {
  const startBtn = () => screen.getByRole('button', { name: '启动浏览器' });
  const stopBtn = () => screen.getByRole('button', { name: '停止浏览器' });
  const killBtn = () =>
    screen.getByRole('button', { name: '急停浏览器（强制）' });

  beforeEach(() => {
    eventMock.handlers.clear();
    eventMock.listen.mockImplementation(
      async (
        event: string,
        handler: TauriEventHandler
      ): Promise<() => void> => {
        eventMock.handlers.set(event, handler);
        return () => {
          eventMock.handlers.delete(event);
        };
      }
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('idle：显示「未启动」，启动可用，停止/急停禁用', async () => {
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'idle' as const,
    }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('未启动')).toBeTruthy());
    expect(startBtn()).toBeEnabled();
    expect(stopBtn()).toBeDisabled();
    expect(killBtn()).toBeDisabled();
  });

  it('running：显示「运行中」+ AI 就绪指示 + url，启动禁用，停止/急停可用', async () => {
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'running' as const,
      url: 'https://example.com',
    }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy());
    expect(screen.getByText('AI 浏览器会话已就绪')).toBeTruthy();
    expect(screen.getByText('https://example.com')).toBeTruthy();
    expect(startBtn()).toBeDisabled();
    expect(stopBtn()).toBeEnabled();
    expect(killBtn()).toBeEnabled();
  });

  it('launching：启动按钮禁用（操作中）', async () => {
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'launching' as const,
    }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('启动中')).toBeTruthy());
    expect(startBtn()).toBeDisabled();
    expect(killBtn()).toBeEnabled();
  });

  it('stopped：重新启动可用', async () => {
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'stopped' as const,
    }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('已停止')).toBeTruthy());
    expect(startBtn()).toBeEnabled();
    expect(stopBtn()).toBeDisabled();
  });

  it('crashed / error：展示异常文案并允许重新启动', async () => {
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'crashed' as const,
    }));
    const { unmount } = render(<BrowserPanel onShowToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('已崩溃')).toBeTruthy());
    expect(startBtn()).toBeEnabled();
    unmount();
    cleanup();

    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'error' as const,
    }));
    render(<BrowserPanel onShowToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('异常')).toBeTruthy());
    expect(startBtn()).toBeEnabled();
  });

  it('点击启动 → invoke browser_start，状态迁移 launching → running（事件驱动）', async () => {
    mockTauriCommand(BROWSER_START_CMD, async () => ({
      state: 'running' as const,
    }));
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'idle' as const,
    }));
    renderPanel();
    await waitFor(() => expect(startBtn()).toBeEnabled());

    fireEvent.click(startBtn());
    await waitFor(() => expect(startBtn()).toBeDisabled());
    // 事件驱动 running（引擎 state-changed）
    act(() => emitBrowserEvent({ state: 'running' }));
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy());
    expect(screen.getByText('AI 浏览器会话已就绪')).toBeTruthy();
  });

  it('点击停止 → invoke browser_stop，事件驱动 stopped', async () => {
    const impl = vi.fn(async () => ({ state: 'stopped' as const }));
    mockTauriCommand(BROWSER_STOP_CMD, impl);
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'running' as const,
    }));
    renderPanel();
    await waitFor(() => expect(stopBtn()).toBeEnabled());

    fireEvent.click(stopBtn());
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(1));
    act(() => emitBrowserEvent({ state: 'stopped' }));
    await waitFor(() => expect(screen.getByText('已停止')).toBeTruthy());
  });

  it('点击急停（launching 态）→ invoke browser_stop（与停止同一命令）', async () => {
    const impl = vi.fn(async () => ({ state: 'stopped' as const }));
    mockTauriCommand(BROWSER_STOP_CMD, impl);
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'launching' as const,
    }));
    renderPanel();
    await waitFor(() => expect(killBtn()).toBeEnabled());

    fireEvent.click(killBtn());
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(1));
  });

  it('启动失败（invoke error）→ 错误状态 + toast', async () => {
    mockTauriError(BROWSER_START_CMD, new Error('chrome spawn failed'));
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'idle' as const,
    }));
    const onShowToast = renderPanel();
    await waitFor(() => expect(startBtn()).toBeEnabled());

    fireEvent.click(startBtn());
    await waitFor(() => expect(screen.getByText('异常')).toBeTruthy());
    expect(onShowToast).toHaveBeenCalledWith(
      expect.stringMatching(/启动浏览器失败：chrome spawn failed/)
    );
  });

  it('初始查询失败 → 错误状态 + toast（引擎未接线诊断）', async () => {
    mockTauriError(BROWSER_STATUS_CMD, new Error('command not found'));
    const onShowToast = renderPanel();
    await waitFor(() => expect(screen.getByText('异常')).toBeTruthy());
    expect(onShowToast).toHaveBeenCalledWith(
      expect.stringMatching(/查询浏览器状态失败/)
    );
  });
});
