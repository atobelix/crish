// @vitest-environment jsdom
/**
 * useFrameStream hook 测试（P1-B1）：Channel 订阅 / 帧解码 / 状态迁移 / 退订。
 * invoke 走 test-setup 全局 mock；Channel 经 channelFactory 注入（真实
 * @tauri-apps/api/core 在测试环境被 mock 掉 Channel，故走注入面）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mockTauriCommand, mockTauriMissing } from '../../../test-setup';
import {
  BROWSER_START_FRAMES_CMD,
  BROWSER_STOP_FRAMES_CMD,
} from '../../../api/browserSessionApi';
import { useFrameStream } from './useFrameStream';
import { FRAME_HEADER_BYTES } from './frameProtocol';

/** 构造帧消息（小端头 + JPEG 负载，对齐 Rust encode_frame）。 */
function buildFrame(
  seq: number,
  width: number,
  height: number,
  payloadLen = 16
): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + payloadLen);
  const view = new DataView(buf);
  view.setUint32(0, seq, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  return buf;
}

interface FakeChannel {
  onmessage: ((message: ArrayBuffer) => void) | null;
}

describe('useFrameStream', () => {
  const stopFrames = vi.fn();
  const startFrames = vi.fn();

  beforeEach(() => {
    stopFrames.mockClear();
    startFrames.mockClear();
    mockTauriCommand(
      BROWSER_START_FRAMES_CMD,
      startFrames.mockResolvedValue({ state: 'starting' as const })
    );
    mockTauriCommand(
      BROWSER_STOP_FRAMES_CMD,
      stopFrames.mockResolvedValue({ state: 'stopped' as const })
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('active=false：不注册通道，状态 stopped（退订命令为幂等清理，至多一次）', async () => {
    const { result } = renderHook(() => useFrameStream({ active: false }));
    expect(result.current.frameState).toBe('stopped');
    expect(result.current.lastFrame).toBeNull();
    expect(startFrames).not.toHaveBeenCalled();
    await waitFor(() => expect(stopFrames).toHaveBeenCalled());
  });

  it('active=true：注册通道 → starting；帧消息 → 解码 + active + lastFrame', async () => {
    const channel: FakeChannel = { onmessage: null };
    const { result } = renderHook(() =>
      useFrameStream({ active: true, channelFactory: async () => channel })
    );
    await waitFor(() => expect(channel.onmessage).not.toBeNull());
    await waitFor(() => expect(startFrames).toHaveBeenCalledTimes(1));

    // 注入一帧（800×600，seq=7）
    act(() => {
      channel.onmessage!(buildFrame(7, 800, 600));
    });
    await waitFor(() => expect(result.current.frameState).toBe('active'));
    expect(result.current.lastFrame).toEqual({
      seq: 7,
      width: 800,
      height: 600,
    });
  });

  it('非法帧消息（长度不足）→ 防御忽略，状态不变', async () => {
    const channel: FakeChannel = { onmessage: null };
    const { result } = renderHook(() =>
      useFrameStream({ active: true, channelFactory: async () => channel })
    );
    await waitFor(() => expect(channel.onmessage).not.toBeNull());
    act(() => {
      channel.onmessage!(new ArrayBuffer(4));
    });
    await waitFor(() => expect(result.current.frameState).toBe('starting'));
    expect(result.current.lastFrame).toBeNull();
  });

  it('通道工厂返回 null（非 Tauri 降级）→ 保持 stopped 不注册', async () => {
    const { result } = renderHook(() =>
      useFrameStream({ active: true, channelFactory: async () => null })
    );
    await waitFor(() => expect(result.current.frameState).toBe('stopped'));
    expect(startFrames).not.toHaveBeenCalled();
  });

  it('active 翻转 false → 退订（browser_stop_frames）+ 状态 stopped', async () => {
    const channel: FakeChannel = { onmessage: null };
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useFrameStream({ active, channelFactory: async () => channel }),
      { initialProps: { active: true } }
    );
    await waitFor(() => expect(channel.onmessage).not.toBeNull());
    act(() => {
      rerender({ active: false });
    });
    await waitFor(() => expect(stopFrames).toHaveBeenCalled());
    expect(result.current.frameState).toBe('stopped');
  });

  it('卸载 → 退订（browser_stop_frames）+ 停止渲染循环', async () => {
    const channel: FakeChannel = { onmessage: null };
    const { unmount } = renderHook(() =>
      useFrameStream({ active: true, channelFactory: async () => channel })
    );
    await waitFor(() => expect(channel.onmessage).not.toBeNull());
    act(() => {
      unmount();
    });
    await waitFor(() => expect(stopFrames).toHaveBeenCalled());
  });

  it('invoke 失败（missing）→ 静默停流（stopped，不抛异常）', async () => {
    mockTauriMissing(BROWSER_START_FRAMES_CMD);
    const channel: FakeChannel = { onmessage: null };
    const { result } = renderHook(() =>
      useFrameStream({ active: true, channelFactory: async () => channel })
    );
    await waitFor(() => expect(result.current.frameState).toBe('stopped'));
  });
});
