// @vitest-environment jsdom
/**
 * ComputerPanel 组件测试：开关状态机渲染 / 启用风险确认流 /
 * 三态会话指示 / 未接线（missing）降级徽标。
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
import {
  mockTauriCommand,
  mockTauriError,
  mockTauriMissing,
} from '../../../test-setup';
import { ComputerPanel } from './ComputerPanel';
import {
  COMPUTER_SESSION_DISABLE_CMD,
  COMPUTER_SESSION_ENABLE_CMD,
  COMPUTER_STATUS_CMD,
} from '../../../api/computerSessionApi';

type TauriEventHandler = (e: { payload?: unknown }) => void;

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: new Map<string, TauriEventHandler>(),
}));

const toastMock = vi.hoisted(() => ({
  show: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

vi.mock('../../../services/toast/ToastContext', () => ({
  toast: toastMock,
  useToast: () => toastMock,
}));

function emitComputerEvent(payload: unknown): void {
  for (const handler of eventMock.handlers.values()) {
    handler({ payload });
  }
}

/** 默认接线态：status 查询 ok（enabled=false, mode=idle）。 */
function setupDefaultStatus() {
  mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
    enabled: false,
    mode: 'idle' as const,
  }));
}

function renderPanel() {
  toastMock.show.mockClear();
  toastMock.error.mockClear();
  render(<ComputerPanel />);
  return toastMock.show;
}

const enableBtn = () => screen.getByRole('button', { name: '启用电脑操作' });
const disableBtn = () => screen.getByRole('button', { name: '停用电脑操作' });

describe('ComputerPanel 会话指示与三态渲染', () => {
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
    setupDefaultStatus();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('默认态：未开启文案 + 三态指示呈现（idle 当前，browser/desktop muted）', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/电脑操作未开启/)).toBeInTheDocument()
    );
    const mode = screen.getByRole('status', { name: '会话激活模式' });
    expect(withinItem(mode, '待机')).toBeTruthy();
    const browserItem = withinItem(mode, '浏览器活跃');
    const desktopItem = withinItem(mode, '桌面活跃');
    expect(browserItem.getAttribute('data-mode')).toBe('browser');
    expect(desktopItem.getAttribute('data-mode')).toBe('desktop');
    expect(enableBtn()).toBeEnabled();
  });

  it('三态渲染：事件驱动后 desktop 态高亮并展示活跃文案', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/电脑操作未开启/)).toBeInTheDocument()
    );

    act(() => emitComputerEvent({ enabled: true, mode: 'desktop' }));
    await waitFor(() =>
      expect(
        screen.getByText(/电脑操作会话已开启，AI 可注入本机输入/)
      ).toBeInTheDocument()
    );
    const mode = screen.getByRole('status', { name: '会话激活模式' });
    const desktopItem = withinItem(mode, '桌面活跃');
    expect(desktopItem.getAttribute('aria-current')).toBe('true');
    const idleItem = withinItem(mode, '待机');
    expect(idleItem.getAttribute('aria-current')).toBeNull();
    expect(disableBtn()).toBeEnabled();
  });

  it('三态渲染：browser 态（互斥中）文案', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/电脑操作未开启/)).toBeInTheDocument()
    );

    act(() => emitComputerEvent({ enabled: true, mode: 'browser' }));
    await waitFor(() =>
      expect(
        screen.getByText(/当前为浏览器会话活跃（互斥中）/)
      ).toBeInTheDocument()
    );
    const mode = screen.getByRole('status', { name: '会话激活模式' });
    expect(withinItem(mode, '浏览器活跃').getAttribute('aria-current')).toBe(
      'true'
    );
  });

  it('未接线降级：status missing → 「引擎未接线」徽标 + 降级说明', async () => {
    mockTauriMissing(COMPUTER_STATUS_CMD);
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText('引擎未接线')).toBeInTheDocument()
    );
    expect(
      screen.getByText(/开关为本地记录，不会落盘持久化/)
    ).toBeInTheDocument();
  });

  it('未接线降级：status error → 徽标 + 错误 toast 诊断', async () => {
    mockTauriError(COMPUTER_STATUS_CMD, new Error('boom'));
    const toast = renderPanel();
    await waitFor(() =>
      expect(screen.getByText('引擎未接线')).toBeInTheDocument()
    );
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/查询电脑操作状态失败/)
    );
  });
});

describe('ComputerPanel 启用/停用确认流', () => {
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
    setupDefaultStatus();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('启用确认流：确认对话框出现 → 取消不 invoke；确认后 invoke enable', async () => {
    mockTauriCommand(COMPUTER_SESSION_ENABLE_CMD, async () => ({
      enabled: true,
    }));
    renderPanel();
    await waitFor(() => expect(enableBtn()).toBeEnabled());

    fireEvent.click(enableBtn());
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    // 风险说明在 <strong> 独立元素内（description 文本被节点分割）
    expect(screen.getByText('注入本机全部输入')).toBeInTheDocument();

    // 取消：不 invoke，状态不变
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    );
    expect(screen.getByText(/电脑操作未开启/)).toBeInTheDocument();

    // 再次打开并确认：invoke enable → 状态切换为已开启
    fireEvent.click(enableBtn());
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }));
    await waitFor(() =>
      expect(screen.getByText(/电脑操作会话已开启，待机中/)).toBeInTheDocument()
    );
    expect(disableBtn()).toBeInTheDocument();
  });

  it('停用：直接 invoke disable（无独立确认流）', async () => {
    mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
      enabled: true,
      mode: 'idle' as const,
    }));
    const disableImpl = vi.fn(async () => ({ enabled: false }));
    mockTauriCommand(COMPUTER_SESSION_DISABLE_CMD, disableImpl);
    renderPanel();
    await waitFor(() => expect(disableBtn()).toBeEnabled());

    fireEvent.click(disableBtn());
    await waitFor(() =>
      expect(screen.getByText(/电脑操作未开启/)).toBeInTheDocument()
    );
    expect(disableImpl).toHaveBeenCalledTimes(1);
  });

  it('未接线时启用：确认后本地化置位 + 降级 toast', async () => {
    const toast = renderPanel();
    await waitFor(() => expect(enableBtn()).toBeEnabled());

    fireEvent.click(enableBtn());
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }));
    await waitFor(() =>
      expect(screen.getByText(/电脑操作会话已开启，待机中/)).toBeInTheDocument()
    );
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/启用电脑操作已本地记录/)
    );
  });
});

/** 在三态指示条内按文本定位条目（返回该条目元素）。 */
function withinItem(mode: HTMLElement, text: string): HTMLElement {
  const items = Array.from(mode.querySelectorAll('[data-mode]'));
  const found = items.find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`三态条目「${text}」未找到`);
  return found as HTMLElement;
}
