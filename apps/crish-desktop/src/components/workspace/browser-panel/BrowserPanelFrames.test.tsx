/**
 * BrowserPanel 帧舞台测试（P1-B1）：running 态帧流订阅 / 指示条状态 /
 * 帧消息驱动「帧流已激活」/ 输入层挂载。
 * invoke 走 test-setup 全局 mock；事件订阅 mock @tauri-apps/api/event。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockTauriCommand } from '../../../test-setup';
import { BrowserPanel } from '../BrowserPanel';
import {
  BROWSER_START_FRAMES_CMD,
  BROWSER_STATUS_CMD,
  BROWSER_STOP_FRAMES_CMD,
} from '../../../api/browserSessionApi';
import { FRAME_HEADER_BYTES } from './frameProtocol';

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

function buildFrame(seq: number, width: number, height: number): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + 8);
  const view = new DataView(buf);
  view.setUint32(0, seq, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  return buf;
}

interface FakeChannel {
  onmessage: ((message: ArrayBuffer) => void) | null;
}

describe('BrowserPanel 帧舞台', () => {
  beforeEach(() => {
    eventMock.handlers.clear();
    eventMock.listen.mockImplementation(
      async (event: string, handler: TauriEventHandler): Promise<() => void> => {
        eventMock.handlers.set(event, handler);
        return () => {
          eventMock.handlers.delete(event);
        };
      },
    );
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({ state: 'idle' as const }));
    mockTauriCommand(BROWSER_START_FRAMES_CMD, async () => ({
      state: 'starting' as const,
    }));
    mockTauriCommand(BROWSER_STOP_FRAMES_CMD, async () => ({ state: 'stopped' as const }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('running 态：帧流舞台出现，订阅发起 → 「帧流启动中…」', async () => {
    const channel: FakeChannel = { onmessage: null };
    render(
      <BrowserPanel
        onShowToast={vi.fn()}
        frameChannelFactory={async () => channel}
      />,
    );
    // 先等初始查询落定（监听器就绪后再发事件，防挂载竞态丢事件）
    await waitFor(() => expect(screen.getByText('未启动')).toBeTruthy());
    act(() => emitBrowserEvent({ state: 'running' }));
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy());
    // 引擎订阅返回 starting（startScreencast 在途，首帧未到）
    await waitFor(() => expect(screen.getAllByText('帧流启动中…')[0]).toBeTruthy());
    // 输入层挂载（受管浏览器输入层）
    expect(screen.getByRole('application', { name: '受管浏览器输入层' })).toBeTruthy();
  });

  it('非 running 态：无帧流舞台（idle 不渲染画布/输入层）', async () => {
    render(<BrowserPanel onShowToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('未启动')).toBeTruthy());
    expect(screen.queryByText('帧流未激活')).toBeNull();
    expect(screen.queryByText('帧流启动中…')).toBeNull();
    expect(screen.queryByRole('application')).toBeNull();
  });

  it('帧消息到达 → 指示条「帧流已激活」+ 画布 aria 标注', async () => {
    const channel: FakeChannel = { onmessage: null };
    render(
      <BrowserPanel
        onShowToast={vi.fn()}
        frameChannelFactory={async () => channel}
      />,
    );
    await waitFor(() => expect(screen.getByText('未启动')).toBeTruthy());
    act(() => emitBrowserEvent({ state: 'running' }));
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy());
    await waitFor(() => expect(channel.onmessage).not.toBeNull());
    act(() => {
      channel.onmessage!(buildFrame(1, 800, 600));
    });
    await waitFor(() => expect(screen.getByText('帧流已激活')).toBeTruthy());
    expect(screen.getByRole('img', { name: '受管浏览器画面' })).toBeTruthy();
  });

  it('停止浏览器（事件驱动 stopped）→ 帧舞台卸载', async () => {
    const channel: FakeChannel = { onmessage: null };
    render(
      <BrowserPanel
        onShowToast={vi.fn()}
        frameChannelFactory={async () => channel}
      />,
    );
    await waitFor(() => expect(screen.getByText('未启动')).toBeTruthy());
    act(() => emitBrowserEvent({ state: 'running' }));
    await waitFor(() => expect(screen.getAllByText('帧流启动中…')[0]).toBeTruthy());
    act(() => emitBrowserEvent({ state: 'stopped' }));
    await waitFor(() => expect(screen.getByText('已停止')).toBeTruthy());
    expect(screen.queryByText('帧流启动中…')).toBeNull();
    expect(screen.queryByText('帧流未激活')).toBeNull();
  });

  it('帧流命令未接线（missing）→ 静默停流：面板仍可用，无 toast', async () => {
    // 覆盖为 missing（引擎未接线帧流命令）
    mockTauriCommand(BROWSER_START_FRAMES_CMD, async () => {
      throw new Error('command browser_start_frames not found');
    });
    const onShowToast = vi.fn();
    const channel: FakeChannel = { onmessage: null };
    render(
      <BrowserPanel
        onShowToast={onShowToast}
        frameChannelFactory={async () => channel}
      />,
    );
    await waitFor(() => expect(screen.getByText('未启动')).toBeTruthy());
    act(() => emitBrowserEvent({ state: 'running' }));
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText('帧流未激活')[0]).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(onShowToast).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '停止浏览器' })).toBeEnabled();
  });
});
