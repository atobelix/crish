// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  isActionableErrorKind,
  resolveRunErrorSurface,
  useStreamCallbacks,
} from './useStreamCallbacks';
import type { UseChatStreamOptions } from './types';
import type { StreamBatcherRefs, StreamToolCallPatch } from './useStreamBatchers';
import { SessionStreamManager } from '../../api/sessionStreamManager';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import { StreamTextBatcher, StreamValueBatcher } from '../../api/streamTextBatcher';

describe('useStreamCallbacks', () => {
  const mockOptions: UseChatStreamOptions = {
    wsId: 'ws-test',
    onShowToast: vi.fn(),
    handleGlobalTabClick: vi.fn(),
    chatInput: '',
    setChatInput: vi.fn(),
    setSlashMenuOpen: vi.fn(),
    attachments: [],
    setAttachments: vi.fn(),
    skillCommandsEnabled: true,
    needsKeySetup: false,
    setPickerInlineError: vi.fn(),
  };

  const createMockRefs = (): StreamBatcherRefs => {
    const streamManagerRef = { current: new SessionStreamManager() };
    const textBatcherRef = {
      current: new StreamTextBatcher(() => {}, { intervalMs: 1000 }),
    };
    const thinkingBatcherRef = {
      current: new StreamTextBatcher(() => {}, { intervalMs: 1000 }),
    };
    const toolBatcherRef = {
      current: new StreamValueBatcher<StreamToolCallPatch>(() => {}, { intervalMs: 1000 }),
    };
    const renderBufferRef = { current: new StreamRenderBuffer() };
    const openSidePanelOnceRef = { current: { terminal: false, diff: false } };
    const flushStreamBatchers = vi.fn();

    return {
      streamManagerRef,
      textBatcherRef,
      thinkingBatcherRef,
      toolBatcherRef,
      renderBufferRef,
      openSidePanelOnceRef,
      flushStreamBatchers,
    };
  };

  it('returns runStreamingAssistant / handleStopGeneration / handleForceCancelGeneration', () => {
    const refs = createMockRefs();
    const pushRunNotice = vi.fn();
    const dismissRunNotice = vi.fn();
    const dismissTransientRunNotice = vi.fn();
    const queryHelpers = {
      wsId: 'ws-test',
      setActiveDiffSource: vi.fn(),
      upsertSessionAgent: vi.fn(),
    };

    const { result } = renderHook(() =>
      useStreamCallbacks(
        mockOptions,
        refs,
        { pushRunNotice, dismissRunNotice, dismissTransientRunNotice },
        queryHelpers
      )
    );

    expect(typeof result.current.runStreamingAssistant).toBe('function');
    expect(typeof result.current.handleStopGeneration).toBe('function');
    expect(typeof result.current.handleForceCancelGeneration).toBe('function');
  });

  it('handleStopGeneration no-ops when active session has no live stream', () => {
    const refs = createMockRefs();
    const pushRunNotice = vi.fn();
    const dismissRunNotice = vi.fn();
    const dismissTransientRunNotice = vi.fn();
    const queryHelpers = {
      wsId: 'ws-test',
      setActiveDiffSource: vi.fn(),
      upsertSessionAgent: vi.fn(),
    };

    const { result } = renderHook(() =>
      useStreamCallbacks(
        mockOptions,
        refs,
        { pushRunNotice, dismissRunNotice, dismissTransientRunNotice },
        queryHelpers
      )
    );

    expect(() => result.current.handleStopGeneration()).not.toThrow();
    expect(() => result.current.handleForceCancelGeneration()).not.toThrow();
  });
});

describe('onRunError 分级分发裁决（resolveRunErrorSurface / isActionableErrorKind）', () => {
  it('network/恢复类 → persistent（无论是否有正文）', () => {
    expect(resolveRunErrorSurface('network', false)).toBe('persistent');
    expect(resolveRunErrorSurface('network', true)).toBe('persistent');
  });

  it('可行动错误（blocked/auth/no_key/no_project）→ banner-toast（无论是否有正文）', () => {
    for (const kind of ['blocked', 'auth', 'no_key', 'no_project']) {
      expect(resolveRunErrorSurface(kind, false)).toBe('banner-toast');
      expect(resolveRunErrorSurface(kind, true)).toBe('banner-toast');
      expect(isActionableErrorKind(kind)).toBe(true);
    }
  });

  it('ended / 未知 kind / null：有正文 → bubble，无正文 → banner', () => {
    expect(resolveRunErrorSurface('ended', true)).toBe('bubble');
    expect(resolveRunErrorSurface('ended', false)).toBe('banner');
    expect(resolveRunErrorSurface(undefined, true)).toBe('bubble');
    expect(resolveRunErrorSurface(undefined, false)).toBe('banner');
    expect(resolveRunErrorSurface(null, false)).toBe('banner');
    expect(isActionableErrorKind('ended')).toBe(false);
    expect(isActionableErrorKind(undefined)).toBe(false);
    expect(isActionableErrorKind(null)).toBe(false);
  });
});
