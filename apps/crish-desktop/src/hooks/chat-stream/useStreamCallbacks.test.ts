// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStreamCallbacks } from './useStreamCallbacks';
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
    const queryHelpers = {
      wsId: 'ws-test',
      setActiveDiffSource: vi.fn(),
      upsertSessionAgent: vi.fn(),
    };

    const { result } = renderHook(() =>
      useStreamCallbacks(
        mockOptions,
        refs,
        { pushRunNotice, dismissRunNotice },
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
    const queryHelpers = {
      wsId: 'ws-test',
      setActiveDiffSource: vi.fn(),
      upsertSessionAgent: vi.fn(),
    };

    const { result } = renderHook(() =>
      useStreamCallbacks(
        mockOptions,
        refs,
        { pushRunNotice, dismissRunNotice },
        queryHelpers
      )
    );

    expect(() => result.current.handleStopGeneration()).not.toThrow();
    expect(() => result.current.handleForceCancelGeneration()).not.toThrow();
  });
});
