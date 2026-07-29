// @vitest-environment jsdom
/**
 * OPT-G3: useSlashSend command paths via compositionRoot.session|runControl.
 * - draft mint: commitDraftIfNeeded only（禁止 createSession 产品路径）
 * - setComposerDraft / setActiveSessionId → session facade
 * - busy send → L1 followUp via root.runControl（不 abort）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSlashSend } from './useSlashSend';
import { useLayoutStore } from '../../store/layoutStore';
import { resetCompositionRoot } from '../../app/compositionRoot';
import { SessionStreamManager } from '../../api/sessionStreamManager';
import type { UseChatStreamOptions } from './types';
import type { StreamBatcherRefs } from './useStreamBatchers';
import { PENDING_DRAFT_SESSION_ID } from '../../store/draftSession';

const requestFollowUp = vi.fn(async () => true);

vi.mock('../../api/runControlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/runControlClient')>();
  return {
    ...actual,
    requestFollowUp: (...args: unknown[]) => requestFollowUp(...args),
  };
});

vi.mock('../../api/appMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/appMode')>();
  return {
    ...actual,
    isDemoMode: () => true,
  };
});

const SID = 'sess-slash-send-1';

function seedSession(opts?: {
  title?: string;
  active?: string;
  messages?: Array<{ id: string; sender: 'user' | 'assistant'; text: string; status?: string }>;
}) {
  const sess = {
    id: SID,
    title: opts?.title ?? '已有会话',
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages: (opts?.messages ?? []).map((m) => ({
      id: m.id,
      sender: m.sender,
      text: m.text,
      timestamp: Date.now(),
      status: (m.status as 'completed' | 'processing' | 'queued') || 'completed',
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  useLayoutStore.setState((st) => {
    (st as any).sessionsById = {
      ...(st as any).sessionsById,
      [SID]: sess,
    };
    const list = Array.isArray((st as any).sessions) ? [...(st as any).sessions] : [];
    const idx = list.findIndex((s: { id: string }) => s.id === SID);
    if (idx >= 0) list[idx] = sess;
    else list.push(sess);
    (st as any).sessions = list;
    (st as any).activeSessionId = opts?.active ?? SID;
    (st as any).composerDrafts = { ...(st as any).composerDrafts, [SID]: 'draft text' };
  });
}

function makeOptions(
  overrides: Partial<UseChatStreamOptions> = {}
): UseChatStreamOptions {
  return {
    wsId: 'ws-1',
    onShowToast: vi.fn(),
    handleGlobalTabClick: vi.fn(),
    chatInput: 'hello world',
    setChatInput: vi.fn(),
    setSlashMenuOpen: vi.fn(),
    attachments: [],
    setAttachments: vi.fn(),
    skillCommandsEnabled: true,
    needsKeySetup: false,
    needsModelSetup: false,
    setPickerInlineError: vi.fn(),
    ...overrides,
  };
}

function makeRefs(manager?: SessionStreamManager): StreamBatcherRefs {
  return {
    streamManagerRef: { current: manager ?? new SessionStreamManager() },
    textBatcherRef: { current: null as any },
    thinkingBatcherRef: { current: null as any },
    toolBatcherRef: { current: null as any },
    renderBufferRef: { current: null as any },
    openSidePanelOnceRef: { current: { terminal: false, diff: false } },
    flushStreamBatchers: vi.fn(),
  };
}

describe('useSlashSend (OPT-G3 compositionRoot)', () => {
  beforeEach(() => {
    resetCompositionRoot();
    requestFollowUp.mockClear();
    seedSession();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetCompositionRoot();
  });

  it('idle send: clears composer draft via session facade + starts stream', async () => {
    const runStreamingAssistant = vi.fn();
    const options = makeOptions({ chatInput: 'ping' });
    const refs = makeRefs();

    const { result } = renderHook(() =>
      useSlashSend(options, refs, runStreamingAssistant)
    );

    await act(async () => {
      await result.current.handleSendChat(false, 'ping');
    });

    expect(runStreamingAssistant).toHaveBeenCalledTimes(1);
    expect(runStreamingAssistant).toHaveBeenCalledWith(
      expect.stringContaining('ping'),
      expect.any(String),
      SID,
      expect.objectContaining({ clientMessageId: expect.any(String) })
    );
    // setComposerDraft cleared on session facade (compositionRoot.session)
    expect(useLayoutStore.getState().composerDrafts?.[SID] ?? '').toBe('');
    expect(options.setChatInput).toHaveBeenCalledWith('');
    expect(options.setSlashMenuOpen).toHaveBeenCalledWith(false);
    expect(requestFollowUp).not.toHaveBeenCalled();
  });

  it('busy send: L1 followUp via compositionRoot.runControl (no stream start)', async () => {
    const runStreamingAssistant = vi.fn();
    const manager = new SessionStreamManager();
    manager.set(SID, {
      cancel: vi.fn(),
      userMsgId: 'u-prev',
      assistantMsgId: 'a-prev',
      runId: 'run-live-1',
    });
    const options = makeOptions({ chatInput: 'while running' });
    const refs = makeRefs(manager);

    const { result } = renderHook(() =>
      useSlashSend(options, refs, runStreamingAssistant)
    );

    await act(async () => {
      await result.current.handleSendChat(false, 'while running');
    });

    expect(runStreamingAssistant).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(requestFollowUp).toHaveBeenCalledTimes(1);
    });
    expect(requestFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-live-1',
        sessionId: SID,
        text: 'while running',
        reason: 'ui-send-while-running',
      })
    );
    // queued user message present
    const msgs = useLayoutStore.getState().sessionsById?.[SID]?.messages ?? [];
    expect(msgs.some((m: { status?: string; sender?: string }) => m.sender === 'user' && m.status === 'queued')).toBe(
      true
    );
  });

  it('pending draft first send: commitDraftIfNeeded only (no createSession product mint)', async () => {
    const createSessionSpy = vi.spyOn(useLayoutStore.getState(), 'createSession');
    // enter draft sentinel
    useLayoutStore.setState((st) => {
      (st as any).activeSessionId = PENDING_DRAFT_SESSION_ID;
      (st as any).draftFolder = 'general';
    });

    const runStreamingAssistant = vi.fn();
    const options = makeOptions({ chatInput: 'first message' });
    const refs = makeRefs();

    const { result } = renderHook(() =>
      useSlashSend(options, refs, runStreamingAssistant)
    );

    await act(async () => {
      await result.current.handleSendChat(false, 'first message');
    });

    // Product path must not call createSession for empty shell mint
    expect(createSessionSpy).not.toHaveBeenCalled();
    // Stream started with a real (non-draft) session id
    expect(runStreamingAssistant).toHaveBeenCalledTimes(1);
    const sidArg = runStreamingAssistant.mock.calls[0]?.[2] as string;
    expect(sidArg).toBeTruthy();
    expect(sidArg).not.toBe(PENDING_DRAFT_SESSION_ID);
    expect(sidArg.startsWith('__pending')).toBe(false);

    createSessionSpy.mockRestore();
  });
});
