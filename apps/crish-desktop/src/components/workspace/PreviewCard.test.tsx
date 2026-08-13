// @vitest-environment jsdom
/**
 * PreviewCard 装配测试（R1-3 面板装配收口）：AI 受管视图（aiBrowser 切换）下
 * BrowserPanel 与 ComputerPanel 并列挂载断言 + 互斥状态展示 + 未接线降级徽标。
 *
 * - 默认（非 aiBrowser）：仅内嵌预览，两面板不挂载；
 * - 点击工具栏 Monitor 按钮切换 → 两面板同时挂载（浏览器会话 + 电脑操作会话）；
 * - 状态互斥语义：UI 上两面板共存，三态互斥由引擎 ActivationGate 承担（04 §2 S3），
 *   装配层验证各自状态指示独立渲染、互不覆盖；
 * - computer 命令注册面已确认（command_manifest.rs / main.rs 已挂载），missing
 *   降级保留为防御分支（注册回退时仍展示「引擎未接线」徽标，不 toast）。
 *
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
import { mockTauriCommand, mockTauriMissing } from '../../test-setup';
import { PreviewCard } from './PreviewCard';
import { BROWSER_STATUS_CMD } from '../../api/browserSessionApi';
import { COMPUTER_STATUS_CMD } from '../../api/computerSessionApi';

type TauriEventHandler = (e: { payload?: unknown }) => void;

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: new Map<string, TauriEventHandler>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

const TOGGLE_LABEL = 'AI 浏览器（受管窗口）';
const TOGGLE_BACK_LABEL = '返回内嵌预览';

function renderCard() {
  const onShowToast = vi.fn();
  render(<PreviewCard wsId="default" onShowToast={onShowToast} />);
  return onShowToast;
}

describe('PreviewCard 装配（BrowserPanel + ComputerPanel）', () => {
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
    // 默认接线态：browser idle + computer idle（注册面已确认，ok 为主路径）
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'idle' as const,
    }));
    mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
      enabled: false,
      mode: 'idle' as const,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('默认（内嵌预览）：两面板均不挂载', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('预览浏览器')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '启动浏览器' })).toBeNull();
    expect(screen.queryByText('电脑操作')).toBeNull();
  });

  it('切换 AI 受管视图：BrowserPanel 与 ComputerPanel 并列挂载', async () => {
    renderCard();
    await waitFor(() =>
      expect(screen.getByLabelText(TOGGLE_LABEL)).toBeTruthy()
    );
    fireEvent.click(screen.getByLabelText(TOGGLE_LABEL));

    // BrowserPanel：状态指示 + 启动按钮 + 导入区
    await waitFor(() => expect(screen.getByText('未启动')).toBeTruthy());
    expect(screen.getByRole('button', { name: '启动浏览器' })).toBeEnabled();
    expect(screen.getByText('数据导入')).toBeTruthy();

    // ComputerPanel：标题 + 三态会话指示 + 开关
    expect(screen.getByText('电脑操作')).toBeTruthy();
    expect(screen.getByText('会话指示')).toBeTruthy();
    expect(screen.getByRole('button', { name: /启用电脑操作/ })).toBeTruthy();
    expect(screen.getByText('待机')).toBeTruthy();
    expect(screen.getByText('浏览器活跃')).toBeTruthy();
    expect(screen.getByText('桌面活跃')).toBeTruthy();
    expect(screen.queryByText('引擎未接线')).toBeNull();
  });

  it('互斥状态展示：browser running 与 computer desktop 各自独立呈现（互斥由引擎承担）', async () => {
    // 浏览器会话 running + 电脑操作 desktop 激活：UI 共存，状态独立
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'running' as const,
      url: 'https://example.com',
    }));
    mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
      enabled: true,
      mode: 'desktop' as const,
    }));
    renderCard();
    await waitFor(() =>
      expect(screen.getByLabelText(TOGGLE_LABEL)).toBeTruthy()
    );
    fireEvent.click(screen.getByLabelText(TOGGLE_LABEL));

    // BrowserPanel：运行中 + AI 就绪
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy());
    expect(screen.getByText('AI 浏览器会话已就绪')).toBeTruthy();

    // ComputerPanel：desktop 激活（aria-current），browser 项不激活
    const desktopItem = screen.getByText('桌面活跃');
    expect(desktopItem.closest('[data-mode="desktop"]')).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(
      screen.getByText('浏览器活跃').closest('[data-mode="browser"]')
    ).not.toHaveAttribute('aria-current');
    // 会话统计行呈现电脑操作会话开启（desktop 语义）
    expect(
      screen.getByText(/电脑操作会话已开启，AI 可注入本机输入/)
    ).toBeTruthy();
  });

  it('missing 防御分支：computer 命令注册回退时展示「引擎未接线」徽标（不 toast）', async () => {
    mockTauriMissing(COMPUTER_STATUS_CMD);
    renderCard();
    await waitFor(() =>
      expect(screen.getByLabelText(TOGGLE_LABEL)).toBeTruthy()
    );
    fireEvent.click(screen.getByLabelText(TOGGLE_LABEL));

    await waitFor(() => expect(screen.getByText('引擎未接线')).toBeTruthy());
    // BrowserPanel 不受影响
    expect(screen.getByRole('button', { name: '启动浏览器' })).toBeEnabled();
  });

  it('返回内嵌预览：两面板卸载，预览恢复', async () => {
    renderCard();
    await waitFor(() =>
      expect(screen.getByLabelText(TOGGLE_LABEL)).toBeTruthy()
    );
    fireEvent.click(screen.getByLabelText(TOGGLE_LABEL));
    await waitFor(() => expect(screen.getByText('未启动')).toBeTruthy());

    act(() => fireEvent.click(screen.getByLabelText(TOGGLE_BACK_LABEL)));
    await waitFor(() => expect(screen.getByText('预览浏览器')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '启动浏览器' })).toBeNull();
    expect(screen.queryByText('电脑操作')).toBeNull();
  });
});
