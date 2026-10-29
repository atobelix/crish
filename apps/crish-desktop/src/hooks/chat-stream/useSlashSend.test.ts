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
import { useSessionStore } from '../../store/sessionStore';
import { listSessions, replaceSessions } from '../../store/sessionIndex';
import type { SessionMessage, SessionState } from '../../store/types';
import { resetCompositionRoot } from '../../app/compositionRoot';
import { sessionStreams } from '../../api/sessionStreamManager';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import type { UseChatStreamOptions } from './types';
import { PENDING_DRAFT_SESSION_ID } from '../../store/draftSession';
import type { ErrorDomain } from '../../api/userFacingErrors';

const requestFollowUp = vi.fn(async () => true);

// R7 发送前就绪检查：mock 掉 ConnectionLifecycle 的实时查询（默认就绪放行），
// 就绪拦截用例单独覆盖 S1/S2/S3 域（vi.hoisted：mock 工厂在执行期可安全引用）
const { checkEngineReadyRealtime } = vi.hoisted(() => ({
  checkEngineReadyRealtime: vi.fn<
    [],
    Promise<{ ok: boolean; domain: ErrorDomain | null }>
  >(async () => ({ ok: true, domain: null })),
}));

vi.mock('../../api/chat-bridge/ConnectionLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../api/chat-bridge/ConnectionLifecycle')
    >();
  return {
    ...actual,
    checkEngineReadyRealtime,
  };
});

vi.mock('../../api/runControlClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/runControlClient')>();
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
  messages?: Array<{
    id: string;
    sender: 'user' | 'assistant';
    text: string;
    status?: string;
  }>;
}) {
  const sess: SessionState = {
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
      status: (m.status as SessionMessage['status']) || 'completed',
    })),
  };
  useSessionStore.setState((st) => {
    const list = listSessions(st);
    const idx = list.findIndex((s) => s.id === SID);
    if (idx >= 0) list[idx] = sess;
    else list.push(sess);
    replaceSessions(st, list);
    st.activeSessionId = opts?.active ?? SID;
    st.composerDrafts[SID] = 'draft text';
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

describe('useSlashSend (OPT-G3 compositionRoot)', () => {
  beforeEach(() => {
    resetCompositionRoot();
    requestFollowUp.mockClear();
    checkEngineReadyRealtime.mockClear();
    checkEngineReadyRealtime.mockResolvedValue({ ok: true, domain: null });
    seedSession();
  });

  afterEach(() => {
    sessionStreams.clearSession(SID);
    vi.clearAllMocks();
    resetCompositionRoot();
  });

  it('idle send: clears composer draft via session facade + starts stream', async () => {
    const runStreamingAssistant = vi.fn();
    const options = makeOptions({ chatInput: 'ping' });

    const { result } = renderHook(() =>
      useSlashSend(options, runStreamingAssistant)
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
    expect(useSessionStore.getState().composerDrafts?.[SID] ?? '').toBe('');
    expect(options.setChatInput).toHaveBeenCalledWith('');
    expect(options.setSlashMenuOpen).toHaveBeenCalledWith(false);
    expect(requestFollowUp).not.toHaveBeenCalled();
  });

  it('busy send: L1 followUp via compositionRoot.runControl (no stream start)', async () => {
    const runStreamingAssistant = vi.fn();
    sessionStreams.register(SID, {
      cancel: vi.fn(),
      userMsgId: 'u-prev',
      assistantMsgId: 'a-prev',
      renderBuffer: new StreamRenderBuffer(),
      runId: 'run-live-1',
    });
    const options = makeOptions({ chatInput: 'while running' });

    const { result } = renderHook(() =>
      useSlashSend(options, runStreamingAssistant)
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
    const msgs = useSessionStore.getState().sessionsById?.[SID]?.messages ?? [];
    expect(
      msgs.some(
        (m: { status?: string; sender?: string }) =>
          m.sender === 'user' && m.status === 'queued'
      )
    ).toBe(true);
  });

  it('pending draft first send: commitDraftIfNeeded only (no createSession product mint)', async () => {
    const createSessionSpy = vi.spyOn(
      useSessionStore.getState(),
      'createSession'
    );
    // enter draft sentinel
    useSessionStore.setState((st) => {
      st.activeSessionId = PENDING_DRAFT_SESSION_ID;
      st.draftFolder = 'general';
    });

    const runStreamingAssistant = vi.fn();
    const options = makeOptions({ chatInput: 'first message' });

    const { result } = renderHook(() =>
      useSlashSend(options, runStreamingAssistant)
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

  it('R7 引擎未就绪（S1：initialized=false）→ 输入框单次提示，不产生 run', async () => {
    checkEngineReadyRealtime.mockResolvedValue({ ok: false, domain: 'S1' });
    const runStreamingAssistant = vi.fn();
    const options = makeOptions({ chatInput: 'engine starting' });

    const { result } = renderHook(() =>
      useSlashSend(options, runStreamingAssistant)
    );

    await act(async () => {
      await result.current.handleSendChat(false, 'engine starting');
    });

    expect(options.setPickerInlineError).toHaveBeenCalledWith(
      '软件服务正在启动，请稍候片刻。'
    );
    expect(runStreamingAssistant).not.toHaveBeenCalled();
    // 不产生失败 run：无 runControl 派发、无 follow-up
    expect(requestFollowUp).not.toHaveBeenCalled();
  });

  it('R7 配置缺失（S2：engineReady=false）→ S2 文案单次提示', async () => {
    checkEngineReadyRealtime.mockResolvedValue({ ok: false, domain: 'S2' });
    const runStreamingAssistant = vi.fn();
    const options = makeOptions({ chatInput: 'no provider' });

    const { result } = renderHook(() =>
      useSlashSend(options, runStreamingAssistant)
    );

    await act(async () => {
      await result.current.handleSendChat(false, 'no provider');
    });

    expect(options.setPickerInlineError).toHaveBeenCalledWith(
      '模型服务尚未配置，请打开 设置 → 模型 完成配置后再发送。'
    );
    expect(runStreamingAssistant).not.toHaveBeenCalled();
  });

  it('R7 restore 进行中（S3）→ S3 文案单次提示', async () => {
    checkEngineReadyRealtime.mockResolvedValue({ ok: false, domain: 'S3' });
    const runStreamingAssistant = vi.fn();
    const options = makeOptions({ chatInput: 'restoring' });

    const { result } = renderHook(() =>
      useSlashSend(options, runStreamingAssistant)
    );

    await act(async () => {
      await result.current.handleSendChat(false, 'restoring');
    });

    expect(options.setPickerInlineError).toHaveBeenCalledWith(
      '正在恢复上次的会话数据，稍后即可发送。'
    );
    expect(runStreamingAssistant).not.toHaveBeenCalled();
  });

  it('slashSendDraftManager: save snapshot, rollback optimistic message and restore draft', async () => {
    const {
      saveDraftSnapshot,
      restoreChatDraft,
      rollbackOptimisticMessage,
      clearDraftSnapshot,
    } = await import('./slashSendDraftManager');

    saveDraftSnapshot('s-test', 'draft text to save');
    const setInput = vi.fn();
    restoreChatDraft('s-test', setInput);
    expect(setInput).toHaveBeenCalledWith('draft text to save');

    // test optimistic rollback using seeded session
    seedSession({
      messages: [{ id: 'msg-opt', text: 'hello', sender: 'user' }],
    });
    rollbackOptimisticMessage('ws-1', SID, 'msg-opt');
    const sess = useSessionStore.getState().sessionsById?.[SID];
    expect(sess?.messages?.length ?? 0).toBe(0);

    clearDraftSnapshot('s-test', setInput);
    expect(setInput).toHaveBeenCalledWith('');
  });

  it('slashSendQueueHelper: checkSessionAiBusy and enqueueFollowUpMessage', async () => {
    const { checkSessionAiBusy, enqueueFollowUpMessage } =
      await import('./slashSendQueueHelper');

    expect(checkSessionAiBusy(true, SID)).toBe(true);
    expect(checkSessionAiBusy(false, SID)).toBe(false);

    const ok = enqueueFollowUpMessage({
      wsId: 'ws-1',
      sessionId: SID,
      userMsgId: 'u-fup',
      displayText: 'follow up text',
      liveHandleRunId: 'run-fup-1',
    });
    expect(ok).toBe(true);
    expect(requestFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-fup-1',
        sessionId: SID,
        text: 'follow up text',
      })
    );
  });
});
