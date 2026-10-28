// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import {
  useNativeBrowserGeometry,
  type LogicalRect,
} from './nativeBrowserGeometry';
import { logger } from '../../services/LoggerService';

const {
  setBoundsMock,
  setVisibleMock,
  setHitTestMock,
  observeMock,
  unobserveMock,
} = vi.hoisted(() => ({
  setBoundsMock: vi.fn(),
  setVisibleMock: vi.fn(),
  setHitTestMock: vi.fn(),
  observeMock: vi.fn(),
  unobserveMock: vi.fn(),
}));

vi.mock('../../api/nativeBrowserApi', () => ({
  browserWebviewSetBounds: setBoundsMock,
  browserWebviewSetVisible: setVisibleMock,
  browserWebviewSetHitTest: setHitTestMock,
}));

vi.mock('../../utils/ResizeObserverManager', () => ({
  ResizeObserverManager: {
    getInstance: () => ({
      observe: observeMock,
      unobserve: unobserveMock,
    }),
  },
}));

function makeRect(left = 20): DOMRect {
  return {
    left,
    top: 30,
    right: left + 400,
    bottom: 330,
    width: 400,
    height: 300,
    x: left,
    y: 30,
    toJSON: () => ({}),
  } as DOMRect;
}

function makeSurfaceRef(rect: DOMRect) {
  const surface = document.createElement('div');
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect);
  return { current: surface } as RefObject<HTMLDivElement | null>;
}

function getLastBounds(): LogicalRect | undefined {
  return setBoundsMock.mock.calls.at(-1)?.[1] as LogicalRect | undefined;
}

describe('useNativeBrowserGeometry 失败重试与队列顺序', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBoundsMock.mockResolvedValue(undefined);
    setVisibleMock.mockResolvedValue(undefined);
    setHitTestMock.mockResolvedValue({
      status: 'unsupported',
      reason: 'Native browser hit-test is not implemented',
    });
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bounds IPC 失败后相同几何目标仍会重试', async () => {
    const surfaceRef = makeSurfaceRef(makeRect());
    setBoundsMock.mockRejectedValueOnce(new Error('temporary bounds failure'));

    const { result, rerender } = renderHook(
      ({ isReady }: { isReady: boolean }) =>
        useNativeBrowserGeometry({
          tabId: 'bounds-retry',
          surfaceRef,
          isReady,
        }),
      { initialProps: { isReady: false } }
    );
    await act(async () => rerender({ isReady: true }));
    await waitFor(() => expect(setBoundsMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await Promise.resolve();
      result.current.syncImmediate();
    });
    await waitFor(() => expect(setBoundsMock).toHaveBeenCalledTimes(2));
    expect(getLastBounds()).toEqual({
      x: 20,
      y: 30,
      width: 400,
      height: 300,
    });
  });

  it('visible IPC 失败后相同显隐目标仍会重试', async () => {
    const surfaceRef = makeSurfaceRef(makeRect());
    setVisibleMock.mockImplementation((_tabId: string, visible: boolean) =>
      visible
        ? Promise.resolve()
        : Promise.reject(new Error('temporary hide failure'))
    );

    const { result, rerender } = renderHook(
      ({ isActive, isReady }: { isActive: boolean; isReady: boolean }) =>
        useNativeBrowserGeometry({
          tabId: 'visible-retry',
          surfaceRef,
          isActive,
          isReady,
        }),
      { initialProps: { isActive: true, isReady: false } }
    );
    await act(async () => rerender({ isActive: true, isReady: true }));
    await waitFor(() => expect(setBoundsMock).toHaveBeenCalled());

    await act(async () => {
      rerender({ isActive: false, isReady: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(setVisibleMock).toHaveBeenCalledWith('visible-retry', false)
    );
    await act(async () => {
      await Promise.resolve();
      result.current.syncImmediate();
    });
    await waitFor(() =>
      expect(
        setVisibleMock.mock.calls.filter(([, visible]) => visible === false)
      ).toHaveLength(2)
    );
  });

  it('在途显隐目标完成后会应用较新的目标', async () => {
    const surfaceRef = makeSurfaceRef(makeRect());
    const visibilityOrder: boolean[] = [];
    let holdNextHide = false;
    let releaseHide!: () => void;
    let signalHideStarted!: () => void;
    const hideStarted = new Promise<void>((resolve) => {
      signalHideStarted = resolve;
    });
    setVisibleMock.mockImplementation((_tabId: string, visible: boolean) => {
      visibilityOrder.push(visible);
      if (!visible && holdNextHide) {
        holdNextHide = false;
        signalHideStarted();
        return new Promise((resolve) => {
          releaseHide = () => resolve(undefined);
        });
      }
      return Promise.resolve();
    });

    const { rerender } = renderHook(
      ({ isActive, isReady }: { isActive: boolean; isReady: boolean }) =>
        useNativeBrowserGeometry({
          tabId: 'visible-order',
          surfaceRef,
          isActive,
          isReady,
        }),
      { initialProps: { isActive: true, isReady: false } }
    );
    await act(async () => rerender({ isActive: true, isReady: true }));
    await waitFor(() => expect(setBoundsMock).toHaveBeenCalled());
    await waitFor(() => expect(visibilityOrder).toContain(true));

    holdNextHide = true;
    await act(async () => {
      rerender({ isActive: false, isReady: true });
    });
    await act(async () => hideStarted);
    rerender({ isActive: true, isReady: true });
    expect(visibilityOrder.at(-1)).toBe(false);

    await act(async () => {
      releaseHide();
    });
    await waitFor(() =>
      expect(visibilityOrder.slice(-2)).toEqual([false, true])
    );
  });
});
