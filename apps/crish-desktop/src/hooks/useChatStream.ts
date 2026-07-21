import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionMessage } from '../store/layoutStore';
import { getSessionById } from '../store/sessionStore';
import { isPendingDraft } from '../store/draftSession';
import {
  commitDraftIfNeeded,
  createSession as createSessionCmd,
  getActiveSessionId,
  openSettings,
  patchSession,
  setPermissionMode,
  syncTelemetryData,
  updateMessageText,
  updateMessageThinking,
} from '../api/storeAccess';
import {
  streamAssistantResponseApi,
  type ChatContentPart,
  type StreamAttachmentMeta,
  type StreamRequestOptions,
} from '../api/chatApi';
import {
  isShellToolName,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../api/toolFeedback';
import { stripThoughtPlaceholders } from '../api/markdownRenderLite';
import { parseMarkdownToHtmlAsync } from '../api/markdownRenderAsync';
import { normalizeAssistantTimeline } from '../api/toolPresentation';
import { recordStreamDiag } from '../api/streamDiag';
import { deriveSessionTitle, isDefaultSessionTitle } from '../api/sessionTitle';
import {
  formatAnnotationsForModel,
  takePendingFileAnnotations,
} from '../api/workspaceFsApi';
import {
  applyUsageDelta,
  fetchRunSnapshotUsage,
} from '../api/sessionEventHydrate';
import { applySubagentEventToMessages } from '../api/subagentTimeline';
import { getActiveModelId } from '../api/providerProfiles';
import { StreamRenderBuffer } from '../api/StreamRenderBuffer';
import {
  StreamTextBatcher,
  StreamValueBatcher,
  streamBatchKey,
  streamToolBatchKey,
  parseStreamToolBatchKey,
  mergeToolCallPatch,
  isImmediateToolStatus,
  type StreamToolCallPatch,
} from '../api/streamTextBatcher';
import { clientApi } from '../api/clientApi';
import { getWorkspacePath } from '../api/projectStore';
import {
  buildGoalModePrefix,
  createInitialGoalMode,
  decideGoalContinuation,
  GOAL_DEFAULT_MAX_ITERATIONS,
  goalStopAllowsToast,
  mergeGoalTasksFromAssistantText,
} from '../api/goalModeController';
import { SessionStreamManager } from '../api/sessionStreamManager';
import {
  isNavigationSlash,
  resolveSlashCommand,
  slashMissingArg,
} from '../api/resolveSlashCommand';
import { emitUiEvent } from '../api/uiEvents';
import type {
  MessageToolApprovalMeta,
  MessageToolCall,
  SessionAgent,
  SessionGoalMode,
} from '../store/types';
// StreamRecovery：stream 热路径（register / heartbeat / backpressure）同步使用，保留静态；
// bootstrap-services 也会挂载，切惰性收益有限。
import { streamRecovery } from '../services/StreamRecovery';

// ── 冷路径模块：惰性加载，切断对重模块的静态依赖 ───────────────────────────
// publishToolDiffs：工具成功后推 diff；stream start 时 preload，未就绪则 async fallback
type PublishToolDiffsFn =
  typeof import('../api/publishToolDiffs').publishToolDiffs;
let _publishToolDiffs: PublishToolDiffsFn | null = null;
let _publishToolDiffsLoading: Promise<PublishToolDiffsFn> | null = null;

function preloadPublishToolDiffs(): void {
  if (_publishToolDiffs || _publishToolDiffsLoading) return;
  _publishToolDiffsLoading = import('../api/publishToolDiffs')
    .then((m) => {
      _publishToolDiffs = m.publishToolDiffs;
      return m.publishToolDiffs;
    })
    .catch(() => {
      _publishToolDiffsLoading = null;
      return null as unknown as PublishToolDiffsFn;
    });
}

function publishToolDiffsLazy(files: Parameters<PublishToolDiffsFn>[0]): void {
  if (_publishToolDiffs) {
    _publishToolDiffs(files);
    return;
  }
  void import('../api/publishToolDiffs')
    .then((m) => {
      _publishToolDiffs = m.publishToolDiffs;
      m.publishToolDiffs(files);
    })
    .catch(() => {
      /* ignore */
    });
}

/**
 * 终态：Worker 异步 markdown → 写回 precomputedHtml。
 * 竞态：messageId 仍存在且正文未漂移为完全不同内容时才写。
 * 流式热路径禁止调用（仅 complete / stop / isFinal / supersede）。
 */
export function scheduleFinalMarkdownHtml(
  sessionId: string,
  messageId: string,
  fullText: string
): void {
  const cleaned = stripThoughtPlaceholders(fullText || '');
  if (!cleaned.trim()) return;
  void parseMarkdownToHtmlAsync(cleaned)
    .then((html) => {
      if (!html) return;
      const msg = getSessionById(sessionId)?.messages?.find(
        (m: SessionMessage) => m.id === messageId
      );
      if (!msg) return;
      // 正文被整段替换（极罕见 id 复用）则放弃；允许 strip 后的等价文本
      const now = msg.text || '';
      const nowClean = stripThoughtPlaceholders(now);
      if (nowClean !== cleaned && now !== cleaned && now !== fullText) {
        return;
      }
      const textToKeep = nowClean === cleaned ? now || cleaned : cleaned;
      updateMessageText(sessionId, messageId, textToKeep, html);
    })
    .catch(() => {
      /* Worker 失败：行组件走 AsyncMarkdown 同步 fallback */
    });
}

// ── Pure helpers (exported for unit tests; stream residual safety) ───────────

/**
 * 解析流式会话 id：override 优先，否则 active。
 * 空串 / 空白 → null，**绝不** invent 远程 `sess-${Date.now()}` 壳。
 */
export function resolveStreamSessionId(
  override?: string | null,
  activeId?: string | null
): string | null {
  const pick = (v?: string | null): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    // 草稿哨兵无真实 session 条目，流式路径不得把它当 sid
    if (!t || isPendingDraft(t)) return null;
    return t;
  };
  return pick(override) ?? pick(activeId);
}

/** 当前 manager 句柄是否仍对应本轮 assistant 消息（stop / 切流后为 false） */
export function isLiveStreamRun(
  entry: { assistantMsgId: string } | null | undefined,
  assistantMsgId: string
): boolean {
  return (
    !!entry &&
    typeof assistantMsgId === 'string' &&
    assistantMsgId.length > 0 &&
    entry.assistantMsgId === assistantMsgId
  );
}

/** cancel 永不抛：stop / 切流热路径 */
export function safeCancelStream(
  cancel: (() => void) | null | undefined
): boolean {
  if (typeof cancel !== 'function') return false;
  try {
    cancel();
    return true;
  } catch {
    return false;
  }
}

/** 仅当本地已有会话时才允许开流（防 void id / 幽灵远程） */
export function canStreamLocalSession(
  sessionId: string | null | undefined,
  sessionExists: boolean
): boolean {
  const id = resolveStreamSessionId(sessionId, null);
  return !!id && sessionExists === true;
}

/** 用户停止且助手尚无正文时的占位（有正文则 null，不覆盖） */
export function stopAssistantPlaceholderText(
  text: string | null | undefined
): string | null {
  return (text || '').trim() ? null : '已停止。';
}

export type TerminalToolReason = 'stop' | 'complete' | 'error';

export type TerminalToolPatch = {
  id: string;
  status: 'error';
  output: string;
};

/**
 * 回合终态：未完成工具收成 error（不伪造 success）。
 * stop / complete / error 文案区分，便于 UI 诚实展示。
 */
export function buildTerminalToolPatches(
  toolCalls:
    Array<{ id: string; status?: string; output?: string }> | null | undefined,
  reason: TerminalToolReason
): TerminalToolPatch[] {
  if (!toolCalls?.length) return [];
  const out: TerminalToolPatch[] = [];
  for (const tc of toolCalls) {
    if (!tc?.id) continue;
    if (tc.status !== 'running' && tc.status !== 'pending_approval') continue;
    const existing = (tc.output || '').trim();
    if (reason === 'stop') {
      out.push({
        id: tc.id,
        status: 'error',
        output: existing || '已停止',
      });
      continue;
    }
    if (tc.status === 'pending_approval') {
      out.push({
        id: tc.id,
        status: 'error',
        output:
          existing ||
          (reason === 'error' ? '运行失败时仍待确认' : '回合结束时仍待确认'),
      });
      continue;
    }
    const placeholder = !existing || /^(执行中|运行中)…?$/.test(existing);
    const fallback =
      reason === 'error'
        ? '运行失败时工具未返回结果'
        : '回合结束时工具未返回结果';
    out.push({
      id: tc.id,
      status: 'error',
      output: placeholder ? fallback : existing,
    });
  }
  return out;
}

/**
 * 确保 session.messages 为数组（缺省时就地初始化）。
 * @returns false 表示 session 不存在，调用方不得 invent 远程壳。
 */
export function ensureSessionMessages(
  sess: { messages?: SessionMessage[] | null } | null | undefined
): sess is { messages: SessionMessage[] } {
  if (!sess) return false;
  if (!Array.isArray(sess.messages)) {
    sess.messages = [];
  }
  return true;
}

/** 从助手正文解析 checklist 并写回 session.goalMode.tasks */
function syncGoalTasksFromAssistantText(
  sid: string,
  assistantText: string,
  gm: SessionGoalMode
): SessionGoalMode {
  const next = mergeGoalTasksFromAssistantText(gm, assistantText);
  if (next === gm) return gm;
  patchSession(sid, { goalMode: next });
  return next;
}

/**
 * 从附件构建 OpenAI-style content parts + 文本兜底块 + 元数据。
 * 图片：结构化 image_url；文本协议仍在 prompt 中保留 dataUrl 备援。
 */
function buildMultimodalFromAttachments(
  modelText: string,
  attachments: ChatAttachment[]
): {
  promptAttachBlock: string;
  streamOptions: StreamRequestOptions | undefined;
} {
  if (!attachments.length) {
    return { promptAttachBlock: '', streamOptions: undefined };
  }

  const content: ChatContentPart[] = [];
  const meta: StreamAttachmentMeta[] = [];
  const promptChunks: string[] = [];
  let hasImages = false;

  const baseText = (modelText || '').trim();
  if (baseText) {
    content.push({ type: 'text', text: baseText });
  }

  for (const a of attachments) {
    if (a.dataUrl) {
      hasImages = true;
      const mime = a.mime || guessMimeFromDataUrl(a.dataUrl) || 'image/png';
      meta.push({ name: a.name, mime, kind: 'image' });
      content.push({
        type: 'image_url',
        image_url: { url: a.dataUrl, detail: 'auto' },
        name: a.name,
        mime,
      });
      // 文本协议备援：保留 dataUrl，兼容尚不读 content 的引擎
      const note = `用户粘贴了截图 ${a.name}，请结合 OCR/视觉理解分析（structured image_url 已一并下发）`;
      promptChunks.push(
        `[图片附件: ${a.name}]\ndataUrl: ${a.dataUrl}\n${note}\n![${a.name}](${a.dataUrl})`
      );
    } else if (a.text) {
      meta.push({ name: a.name, kind: 'text' });
      const body = `${a.text.slice(0, 80_000)}${a.text.length > 80_000 ? '\n…(截断)' : ''}`;
      content.push({ type: 'text', text: `--- ${a.name} ---\n${body}` });
      promptChunks.push(`--- ${a.name} ---\n${body}`);
    } else {
      meta.push({ name: a.name, kind: 'file' });
      content.push({ type: 'text', text: `- ${a.name}` });
      promptChunks.push(`- ${a.name}`);
    }
  }

  const promptAttachBlock = `\n\n[附件]\n${promptChunks.join('\n\n')}`;
  const streamOptions: StreamRequestOptions = {
    content,
    hasImages,
    attachments: meta,
  };
  return { promptAttachBlock, streamOptions };
}

function guessMimeFromDataUrl(dataUrl: string): string | undefined {
  const m = /^data:([^;,]+)/i.exec(dataUrl || '');
  return m?.[1] || undefined;
}

const GRILL_ME_PREFIX = [
  '[对齐模式 · 系统指令]',
  '你是产品/技术对齐助手。针对用户主题只提问澄清（最多 5 个关键问题），暂不写代码、不改文件。',
  '等用户确认方案后再实施。问题应具体、可回答，避免一次抛出过多细节。',
  '---',
  '',
].join('\n');

export type ChatAttachment = {
  name: string;
  text?: string;
  /** data URL for images */
  dataUrl?: string;
  mime?: string;
};

export type RunNotice = {
  text: string;
  kind?: string;
  /** 可选诊断第二行（中断原因 / 引擎 scope） */
  detail?: string;
};

export interface UseChatStreamOptions {
  wsId: string;
  onShowToast: (message: string) => void;
  handleGlobalTabClick: (cardId: string) => void;
  chatInput: string;
  setChatInput: (value: string) => void;
  setSlashMenuOpen: (open: boolean) => void;
  attachments: ChatAttachment[];
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  skillCommandsEnabled: boolean;
  needsKeySetup: boolean;
  /** 有密钥但尚无活动模型（需手填/选择） */
  needsModelSetup?: boolean;
  setPickerInlineError: (msg: string) => void;
  /** 打开底栏模型选择（手填路径）；不 toast */
  onOpenModelPicker?: () => void;
}

export interface UseChatStreamResult {
  runNotice: RunNotice | null;
  setRunNotice: Dispatch<SetStateAction<RunNotice | null>>;
  runStreamingAssistant: (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => void;
  /**
   * 发送当前 composer；可选 textOverride 用于后续引导「直发」
   * （不依赖 React 异步 setState，避免填入后再发丢字）。
   */
  handleSendChat: (isInsert?: boolean, textOverride?: string) => Promise<void>;
  handleStopGeneration: () => void;
}

/**
 * 主对话发送 / 流式回复 / 停止：按会话隔离 cancel，支持排队 drain。
 * UI 状态（输入框、附件等）由调用方持有，经 options 注入。
 */
export function useChatStream(
  options: UseChatStreamOptions
): UseChatStreamResult {
  const {
    wsId,
    onShowToast,
    handleGlobalTabClick,
    chatInput,
    setChatInput,
    setSlashMenuOpen,
    attachments,
    setAttachments,
    skillCommandsEnabled,
    needsKeySetup,
    needsModelSetup = false,
    setPickerInlineError,
    onOpenModelPicker,
  } = options;

  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const setActiveDiffSource = useLayoutStore((s) => s.setActiveDiffSource);
  const addTerminalLine = useLayoutStore((s) => s.addTerminalLine);
  const upsertSessionAgent = useLayoutStore((s) => s.upsertSessionAgent);
  const renameSession = useLayoutStore((s) => s.renameSession);

  /** 流生命周期：cancel / drain / goal-cancel / 续写调度（单一 manager，替代多 ref 隐式状态机） */
  const streamManagerRef = useRef<SessionStreamManager | null>(null);
  if (!streamManagerRef.current) {
    streamManagerRef.current = new SessionStreamManager();
  }
  /** 本轮 run 内是否已自动打开过侧栏，避免每个工具都抢焦点 */
  const openSidePanelOnceRef = useRef({ terminal: false, diff: false });

  /**
   * 流式正文批合并：onChunk 高频覆盖，~48ms 刷一次 updateMessageText。
   * complete/stop 必须 flushNow，保证终态不丢。
   */
  const textBatcherRef = useRef<StreamTextBatcher | null>(null);
  if (!textBatcherRef.current) {
    textBatcherRef.current = new StreamTextBatcher(
      (key, text) => {
        const sep = key.indexOf('::');
        if (sep < 0) return;
        const sessionId = key.slice(0, sep);
        const messageId = key.slice(sep + 2);
        updateMessageText(sessionId, messageId, text);
      },
      { intervalMs: 48, maxBufferedChars: 8000 }
    );
  }

  /** 思考过程同样 48ms 批合并，避免 onThought 高于正文频率时打爆 store */
  const thinkingBatcherRef = useRef<StreamTextBatcher | null>(null);
  if (!thinkingBatcherRef.current) {
    thinkingBatcherRef.current = new StreamTextBatcher(
      (key, thinking) => {
        const sep = key.indexOf('::');
        if (sep < 0) return;
        const sessionId = key.slice(0, sep);
        const messageId = key.slice(sep + 2);
        updateMessageThinking(sessionId, messageId, thinking);
      },
      { intervalMs: 48, maxBufferedChars: 4000 }
    );
  }

  /**
   * 工具事件批合并：同 toolId 合并最新 patch，~48ms flush；
   * success/error/pending_approval 等终态立即 flushNow。
   */
  const toolBatcherRef = useRef<StreamValueBatcher<StreamToolCallPatch> | null>(
    null
  );
  if (!toolBatcherRef.current) {
    toolBatcherRef.current = new StreamValueBatcher(
      (key, patch) => {
        const parsed = parseStreamToolBatchKey(key);
        if (!parsed) return;
        const { sessionId, messageId, toolId } = parsed;
        const live = useLayoutStore.getState();
        const existing = getSessionById(sessionId)
          ?.messages?.find((m) => m.id === messageId)
          ?.toolCalls?.find((t) => t.id === toolId);
        const updates = { ...patch };
        delete updates.id;
        if (existing) {
          live.updateMessageToolCall(sessionId, messageId, toolId, updates);
        } else {
          live.addMessageToolCall(sessionId, messageId, {
            id: toolId,
            name: patch.name || 'tool',
            arguments: patch.arguments || '',
            explanation: patch.explanation,
            status: patch.status || 'running',
            output: patch.output,
            diffs: patch.diffs,
            approvalMeta: patch.approvalMeta,
          });
        }
      },
      { intervalMs: 48, merge: mergeToolCallPatch }
    );
  }

  /** 流式帧渲染缓冲区（per-run），替代定时批合并 → onFrame 中 updateMessageText */
  const renderBufferRef = useRef<StreamRenderBuffer | null>(null);

  /**
   * complete/stop/切流/错误：正文 + thinking + 工具统一 flushNow。
   * 各 batcher 独立 try，避免一个抛错拖死终态。
   */
  const flushStreamBatchers = () => {
    try {
      textBatcherRef.current?.flushNow();
    } catch {
      /* ignore */
    }
    try {
      thinkingBatcherRef.current?.flushNow();
    } catch {
      /* ignore */
    }
    try {
      toolBatcherRef.current?.flushNow();
    } catch {
      /* ignore */
    }
  };

  /** 运行级错误横幅（不进 AI 正文）；有实质输出或超时后自动关闭 */
  const [runNotice, setRunNotice] = useState<RunNotice | null>(null);
  const runNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRunNoticeTimer = useCallback(() => {
    if (runNoticeTimerRef.current != null) {
      clearTimeout(runNoticeTimerRef.current);
      runNoticeTimerRef.current = null;
    }
  }, []);

  const dismissRunNotice = useCallback(() => {
    clearRunNoticeTimer();
    setRunNotice(null);
  }, [clearRunNoticeTimer]);

  /** 展示系统提示；ttlMs≤0 不自动关；默认 8s */
  const pushRunNotice = useCallback(
    (notice: RunNotice, ttlMs = 8000) => {
      clearRunNoticeTimer();
      setRunNotice(notice);
      const delay = Math.floor(Number(ttlMs));
      if (!Number.isFinite(delay) || delay <= 0) return;
      runNoticeTimerRef.current = setTimeout(() => {
        runNoticeTimerRef.current = null;
        setRunNotice(null);
      }, delay);
    },
    [clearRunNoticeTimer]
  );

  useEffect(() => {
    return () => {
      clearRunNoticeTimer();
      renderBufferRef.current?.stop();
    };
  }, [clearRunNoticeTimer]);

  /**
   * /goal 自动续写：无排队消息时，若 goalMode 仍 active 且未 DONE，则注入续写提示。
   * @returns true 表示已启动续写，调用方勿再 drain 排队
   */
  const maybeContinueGoalMode = (
    sid: string,
    assistantMsgId: string
  ): boolean => {
    const mgr = streamManagerRef.current!;
    const cancelled = mgr.consumeGoalCancelled(sid);
    const sess = getSessionById(sid);
    const asstText =
      sess?.messages.find((m: SessionMessage) => m.id === assistantMsgId)
        ?.text || '';
    if (sess?.goalMode?.active) {
      syncGoalTasksFromAssistantText(sid, asstText, sess.goalMode);
    }
    const liveSess = getSessionById(sid);
    const decision = decideGoalContinuation({
      cancelled,
      session: liveSess,
      assistantText: asstText,
    });

    if (decision.action === 'stop') {
      // done：收口 tasks 与 ribbon；max_iter：保留缺口 tasks；均写 store
      if (decision.reason === 'done' || decision.reason === 'max_iter') {
        patchSession(sid, { goalMode: decision.goalMode });
      }
      // 成功完成 / 取消 / 排队：不 toast；仅异常上限可 toast
      if (decision.toast && goalStopAllowsToast(decision.reason)) {
        onShowToast(decision.toast);
      }
      return false;
    }

    patchSession(sid, { goalMode: decision.goalMode });
    const userMsgId = `user-msg-goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    useLayoutStore.setState((state) => {
      const s = state.sessionsById[sid];
      if (!s) return;
      if (!s.messages) s.messages = [];
      s.messages.push({
        id: userMsgId,
        sender: 'user',
        text: decision.displayText,
        timestamp: Date.now(),
        status: 'processing',
      });
    });

    // queueMicrotask + bindStarter：不依赖 setTimeout(0)+ref 竞态
    mgr.scheduleStart(sid, decision.modelText, userMsgId);
    return true;
  };

  const drainQueuedAfterComplete = (sid: string) => {
    const mgr = streamManagerRef.current!;
    if (!mgr.beginDrain(sid)) return;
    try {
      const st = useLayoutStore.getState();
      const sess = getSessionById(sid);
      const stillBusy = sess?.messages?.some(
        (m: SessionMessage) =>
          m.sender === 'assistant' && m.status === 'processing'
      );
      if (stillBusy) return;
      const next = sess?.messages.find(
        (m: SessionMessage) => m.sender === 'user' && m.status === 'queued'
      );
      if (next?.text) {
        st.setSessionMessageStatus(sid, next.id, 'processing');
        let prompt = next.text;
        const gm = sess?.goalMode;
        if (gm?.active && gm.goal) {
          const maxIter = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
          prompt = `${buildGoalModePrefix(gm.goal, gm.iteration ?? 0, maxIter, gm.tasks)}${next.text}`;
        }
        mgr.scheduleStart(sid, prompt, next.id);
      }
    } finally {
      mgr.endDrainNextTick(sid);
    }
  };

  // Real-time AI response streaming helper
  const runStreamingAssistant = (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => {
    // 空会话 / 空白 id：拒绝开流，绝不让 chatApi invent 远程 sess-* 壳
    const sid = resolveStreamSessionId(sessionIdOverride, getActiveSessionId());
    if (!sid || !canStreamLocalSession(sid, !!getSessionById(sid))) {
      return;
    }

    // 同会话已有流：先摘句柄 + flush + safe cancel，避免幽灵 run / 旧 onComplete 抢 drain
    const prevStream = streamManagerRef.current!.get(sid);
    if (prevStream) {
      streamManagerRef.current!.delete(sid);
      // 刷出旧流 pending 正文（含 render buffer），再 cancel
      const prevBuf = renderBufferRef.current;
      prevBuf?.markFinal();
      prevBuf?.flush(true);
      prevBuf?.stop();
      flushStreamBatchers();
      const prevText =
        getSessionById(sid)?.messages?.find(
          (m: SessionMessage) => m.id === prevStream.assistantMsgId
        )?.text ||
        prevBuf?.currentText() ||
        '';
      if ((prevText || '').trim()) {
        scheduleFinalMarkdownHtml(sid, prevStream.assistantMsgId, prevText);
      }
      safeCancelStream(prevStream.cancel);
    }

    const assistantMsgId = `assistant-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const store = useLayoutStore.getState();
    const toolNames: Record<string, string> = {};
    const startTime = Date.now();
    // 新一轮开始：收起上一轮系统提示
    dismissRunNotice();
    let gotRealText = false;
    let localRunId: string | null = null;
    /** 本轮已收口（complete/stop 竞态）：回调一律 no-op */
    let runClosed = false;
    /** fallback batcher 路径的累计全文（batcher 是覆盖语义，禁止塞 delta） */
    let streamedFullText = '';
    /** 终态 Worker 是否已调度（防 complete 与 isFinal 双路径重复） */
    let finalHtmlScheduled = false;

    const scheduleRunFinalHtml = (fullText: string) => {
      if (finalHtmlScheduled) return;
      if (!(fullText || '').trim()) return;
      finalHtmlScheduled = true;
      scheduleFinalMarkdownHtml(sid, assistantMsgId, fullText);
    };

    // StreamRenderBuffer 实例（per-run），驱动 rAF 分帧写入 store
    const buffer = new StreamRenderBuffer();
    renderBufferRef.current = buffer;
    buffer.reset();
    buffer.onFrame = (frame) => {
      if (runClosed && !frame.isFinal) return;
      // 流式/终态帧：只写正文，不传 html（HTML 由 complete/stop Worker 路径写回）
      updateMessageText(sid, assistantMsgId, frame.full);
      // 帧消费后复查水位：可能从 pause 降到 resume
      streamRecovery.noteRenderBuffer(sid, buffer.bufferedLength());
    };
    buffer.start();
    // 冷路径 preload：工具 diff 发布可能在 onToolSuccess 同步路径触发
    preloadPublishToolDiffs();
    // 仅当前查看会话时清 diff 焦点，避免后台会话抢右侧
    if (useLayoutStore.getState().activeSessionId === sid) {
      openSidePanelOnceRef.current = { terminal: false, diff: false };
      setActiveDiffSource(null);
    }

    // 先占位注册句柄，保证同步回调 isLive 为真；真实 cancel 在 API 返回后挂上
    let cancelFn: () => void = () => {
      /* set after stream starts */
    };
    streamManagerRef.current!.set(sid, {
      cancel: () => cancelFn(),
      userMsgId,
      assistantMsgId,
      runId: null,
    });

    /** stop/切流后 manager 无本轮句柄 → false；本轮 closed → false */
    const assertLive = (): boolean => {
      if (runClosed) return false;
      return isLiveStreamRun(
        streamManagerRef.current!.get(sid),
        assistantMsgId
      );
    };

    store.addMessage(wsId, sid, {
      id: assistantMsgId,
      sender: 'assistant',
      text: '',
      thinking: '正在处理…',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [],
    });

    // find-or-add tool call：工具 patch 批合并（按 toolId）+ O(1) 会话查找
    const queueToolCallPatch = (
      toolId: string,
      patch: StreamToolCallPatch,
      immediate = false
    ) => {
      if (!assertLive()) return;
      const key = streamToolBatchKey(sid, assistantMsgId, toolId);
      toolBatcherRef.current?.push(key, patch);
      if (immediate || isImmediateToolStatus(patch.status)) {
        try {
          toolBatcherRef.current?.flushNow();
        } catch {
          /* ignore */
        }
      }
    };

    const upsertToolCall = (
      toolId: string,
      name: string,
      args: string | undefined,
      explanation: string | undefined,
      status: 'running' | 'pending_approval',
      approvalMeta?: MessageToolApprovalMeta
    ) => {
      toolNames[toolId] = name;
      queueToolCallPatch(
        toolId,
        {
          id: toolId,
          name,
          arguments: args,
          explanation,
          status,
          ...(approvalMeta ? { approvalMeta } : {}),
        },
        // pending_approval 立刻露出审批 UI；running 可批合并
        status === 'pending_approval'
      );
      if (isShellToolName(name) && args) {
        // 镜像到终端面板，但不自动抢开侧栏
        addTerminalLine(`$ ${args}`, sid);
      }
    };

    cancelFn = streamAssistantResponseApi(
      input,
      {
        onRunMeta: ({ runId }) => {
          if (!assertLive()) return;
          localRunId = runId;
          const entry = streamManagerRef.current!.get(sid);
          if (entry && entry.assistantMsgId === assistantMsgId) {
            entry.runId = runId;
          }
          // 主路径：拿到真实 runId 即 register（bridge 也会 register；幂等覆盖）
          streamRecovery.registerStream(sid, runId);
          // 记在会话上，便于 H3 事后拉 usage
          useLayoutStore.setState((state) => {
            const s = state.sessionsById[sid];
            if (s) s.engineLastRunId = runId;
          });
        },
        onThought: (thought) => {
          if (!assertLive()) return;
          thinkingBatcherRef.current?.push(
            streamBatchKey(sid, assistantMsgId),
            thought
          );
        },
        onToolStart: (toolId, name, args, explanation) => {
          if (!assertLive()) return;
          upsertToolCall(toolId, name, args, explanation, 'running');
        },
        onToolPendingApproval: (
          toolId,
          name,
          args,
          explanation,
          approvalMeta
        ) => {
          if (!assertLive()) return;
          upsertToolCall(
            toolId,
            name,
            args,
            explanation,
            'pending_approval',
            approvalMeta
          );
        },
        onApprovalResolved: (toolId, decision) => {
          if (!assertLive()) return;
          toolNames[toolId] = toolNames[toolId] || 'tool';
          if (decision === 'allow') {
            // 审批刚过，立刻反映 running，避免 UI 仍停在待确认
            queueToolCallPatch(
              toolId,
              { id: toolId, status: 'running', output: '执行中…' },
              true
            );
          } else {
            queueToolCallPatch(
              toolId,
              { id: toolId, status: 'error', output: '未获批准' },
              true
            );
          }
        },
        onSubagentStarted: (info) => {
          if (!assertLive()) return;
          if (!info.subagentId) return;
          const taskLabel =
            (info.description || '协作任务').trim() || '协作任务';
          upsertSessionAgent(sid, {
            id: info.subagentId,
            subagentRunId: info.subagentRunId,
            parentSessionId: sid,
            parentRunId: info.parentRunId,
            parentToolCallId: info.parentToolCallId,
            description: taskLabel,
            mode: info.mode || 'research',
            status: 'running',
            // 不再塞「主 agent 已拉起…」系统句进消息列表，减少噪音
            messages: [],
            startedAt: Date.now(),
          });
          // 父工具行标为进行中，便于时间线与子 agent 对齐
          if (info.parentToolCallId) {
            queueToolCallPatch(
              info.parentToolCallId,
              {
                id: info.parentToolCallId,
                status: 'running',
                output: '协作进行中…',
              },
              true
            );
          }
        },
        onSubagentEvent: (info) => {
          if (!assertLive()) return;
          if (!info.subagentId) return;
          useLayoutStore.setState((state) => {
            const sess = state.sessionsById[sid];
            const ag = sess?.agents?.find(
              (a: SessionAgent) => a.id === info.subagentId
            );
            if (!ag) return;
            ag.messages = applySubagentEventToMessages(
              ag.messages || [],
              info.event
            );
          });
        },
        onSubagentEnded: (info) => {
          if (!assertLive()) return;
          if (!info.subagentId) return;
          let parentToolCallId: string | undefined;
          let summary = info.summary || '';
          useLayoutStore.setState((state) => {
            const sess = state.sessionsById[sid];
            const ag = sess?.agents?.find(
              (a: SessionAgent) => a.id === info.subagentId
            );
            if (!ag) return;
            ag.status = info.status;
            if (info.summary) ag.summary = info.summary;
            ag.endedAt = Date.now();
            parentToolCallId = ag.parentToolCallId;
            if (!summary) summary = ag.summary || '';
            for (const m of ag.messages || []) {
              if (m.status === 'processing') m.status = 'completed';
            }
            // 把结论写回父工具调用，主时间线可见协作结果
            const toolId = ag.parentToolCallId;
            if (toolId && sess?.messages) {
              for (const m of sess.messages) {
                const tc = m.toolCalls?.find(
                  (t: MessageToolCall) => t.id === toolId
                );
                if (!tc) continue;
                const st = String(info.status || '');
                const failed = /fail|error/i.test(st);
                const stopped =
                  st === 'stopped' || /cancel|stopp?ed|abort/i.test(st);
                tc.status = failed || stopped ? 'error' : 'success';
                const body =
                  summary.trim() ||
                  (failed
                    ? '协作未完成'
                    : stopped
                      ? '协作已停止'
                      : '协作已完成');
                tc.output =
                  body.length > 1200 ? body.slice(0, 1199) + '…' : body;
              }
            }
          });
          void parentToolCallId;
        },
        onTerminalLine: (line) => {
          if (!assertLive()) return;
          addTerminalLine(line, sid);
        },
        onToolSuccess: (toolId, output, diffs) => {
          if (!assertLive()) return;
          const name = toolNames[toolId] || '';
          // 热路径：O(1) getSessionById，避免 sessions.find
          const args =
            getSessionById(sid)
              ?.messages?.find((m: SessionMessage) => m.id === assistantMsgId)
              ?.toolCalls?.find((t: MessageToolCall) => t.id === toolId)
              ?.arguments || '';

          // 展示用清洗；diff：有引擎结构化结果就保留，否则仅 edit / unified diff 才解析
          const displayOut = sanitizeToolDisplayOutput(output || '');
          const resolvedDiffs = resolveToolDiffs({
            name,
            args,
            output: displayOut,
            structuredDiffs: diffs,
          });

          // 终态 success：合并写 store 并立即 flushNow
          queueToolCallPatch(
            toolId,
            {
              id: toolId,
              status: 'success',
              output: displayOut || output || '完成',
              diffs: resolvedDiffs.length ? resolvedDiffs : undefined,
            },
            true
          );

          // shell：仅镜像到终端缓冲区，不自动 openSidePanel / crish-open-terminal（避免每条命令抢焦点）
          if (isShellToolName(name) && displayOut) {
            displayOut
              .split('\n')
              .slice(0, 80)
              .forEach((line: string) => addTerminalLine(line, sid));
          }

          // 有可展示 diff 才推右侧变更（set 外调用，避免 immer 嵌套丢弃）
          // publishToolDiffs 惰性：stream start 已 preload；未就绪则 async fallback
          if (resolvedDiffs.length > 0) {
            publishToolDiffsLazy(resolvedDiffs);
          }
        },
        onToolError: (toolId, error) => {
          if (!assertLive()) return;
          const clean = sanitizeToolDisplayOutput(error || '');
          queueToolCallPatch(
            toolId,
            {
              id: toolId,
              status: 'error',
              output: clean || error || '失败',
            },
            true
          );
          const name = toolNames[toolId];
          if (name && isShellToolName(name) && clean) {
            addTerminalLine(clean, sid);
          }
        },
        onChunk: (chunk) => {
          if (!assertLive()) return;
          gotRealText = true;
          // 有实质正文 → 问题已过，收起系统提示
          dismissRunNotice();
          // 累计全文：batcher 是「全文覆盖」语义，禁止把 delta 当全文塞入
          streamedFullText += chunk;
          streamRecovery.updateHeartbeat(sid, { bytes: chunk.length });
          // 优先通过 StreamRenderBuffer 分帧写入 store（fallback 到定时批合并）
          if (renderBufferRef.current) {
            renderBufferRef.current.push(chunk);
            // 64KB 背压：未消费字符超高水位 → stream-pause；低于低水位 → stream-resume
            // 禁止丢 token：仅信号 + 本地缓冲，不丢弃 chunk
            streamRecovery.noteRenderBuffer(
              sid,
              renderBufferRef.current.bufferedLength()
            );
          } else {
            textBatcherRef.current?.push(
              streamBatchKey(sid, assistantMsgId),
              streamedFullText
            );
          }
          // 有正文后清空占位思考，避免与正式输出叠在一起
          const cur = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === assistantMsgId
          );
          if (cur?.thinking === '正在处理…') {
            thinkingBatcherRef.current?.drop(
              streamBatchKey(sid, assistantMsgId)
            );
            store.updateMessageThinking(sid, assistantMsgId, '');
          }
        },
        onRunError: (message, kind, detail) => {
          // stop/切流后忽略；系统级提示不进助手气泡
          if (!assertLive()) return;
          streamRecovery.markFailed(sid, message || kind || 'error');
          const asstErr = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === assistantMsgId
          );
          const lastToolErr = (asstErr?.toolCalls || []).findLast(Boolean);
          recordStreamDiag({
            sessionId: sid,
            runId: localRunId || undefined,
            scope: kind || 'run-error',
            kind: kind || 'error',
            message,
            raw: detail || message,
            context: {
              lastTool: lastToolErr?.name ?? null,
              lastToolStatus: lastToolErr?.status ?? null,
              toolCount: asstErr?.toolCalls?.length ?? 0,
            },
          });
          pushRunNotice(
            {
              text: message,
              kind,
              detail: detail || undefined,
            },
            14000
          );
          onShowToast(message);
          // 若助手消息尚无文本，将错误消息写入助手气泡与状态，保证消息可见并可一键重试
          if (asstErr && !(asstErr.text || '').trim()) {
            store.updateMessageText(sid, assistantMsgId, message);
            store.setSessionMessageStatus(sid, assistantMsgId, 'error');
          }
          // 错误路径也刷出 pending，避免横幅已出但正文还卡在 batcher
          flushStreamBatchers();
        },
        onComplete: () => {
          // 已收口 / 被 stop 或切流 supersede：整段 no-op，禁止幽灵 drain / goal 续写
          if (runClosed) return;
          if (
            !isLiveStreamRun(streamManagerRef.current!.get(sid), assistantMsgId)
          ) {
            runClosed = true;
            return;
          }
          runClosed = true;
          streamRecovery.markCompleted(sid);

          // 终态前强制 flush 分帧缓冲区 + 批合并正文 / thinking / 工具
          buffer.markFinal();
          buffer.flush(true);
          flushStreamBatchers();
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const st = useLayoutStore.getState();
          const asst = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === assistantMsgId
          );
          // 正常收口也记一条轻量诊断，方便对照「检查点后突然停」
          const lastTool = (asst?.toolCalls || []).findLast(Boolean);
          const runningLeft = (asst?.toolCalls || []).filter(
            (t: MessageToolCall) => t.status === 'running'
          ).length;
          recordStreamDiag({
            sessionId: sid,
            runId: localRunId || undefined,
            scope: 'run-complete',
            kind: 'complete',
            message: runningLeft
              ? `流已收口，但仍有 ${runningLeft} 个工具显示运行中`
              : '流正常收口',
            context: {
              lastTool: lastTool?.name ?? null,
              lastToolStatus: lastTool?.status ?? null,
              toolCount: asst?.toolCalls?.length ?? 0,
              gotRealText,
              elapsedSec: elapsed,
            },
          });
          // 禁止伪造「已结束。」进正文：会污染会话展示，也被用户当成模型失忆/胡说
          // 有工具无正文时保持空文案，时间线已有工具行；无工具则给一句诚实说明
          if (asst && !gotRealText && !(asst.text || '').trim()) {
            const hasTools = (asst.toolCalls || []).some(
              (t: MessageToolCall) =>
                t.status === 'success' ||
                t.status === 'error' ||
                t.status === 'running'
            );
            if (!hasTools) {
              const tip =
                '这一轮没有文字回复。若刚改过配置，请检查模型与网络。';
              // 仅横幅，不双刷 toast；短时自动消失
              pushRunNotice({ text: tip, kind: 'empty' }, 6000);
            } else {
              // 有工具成功推进 → 不挂空提示
              dismissRunNotice();
            }
          } else if (gotRealText || (asst?.text || '').trim()) {
            dismissRunNotice();
          }
          // 收口诚实：未完成工具标 error，不伪造 success
          const toolPatches = buildTerminalToolPatches(
            asst?.toolCalls,
            'complete'
          );
          for (const p of toolPatches) {
            st.updateMessageToolCall(sid, assistantMsgId, p.id, {
              status: p.status,
              output: p.output,
            });
          }
          // 清理正文里的思考占位，避免与思考行重复；对齐 blocks 时间线
          let finalTextForHtml = '';
          try {
            const latest = getSessionById(sid)?.messages.find(
              (m: SessionMessage) => m.id === assistantMsgId
            );
            const raw = latest?.text || streamedFullText || '';
            const cleaned = stripThoughtPlaceholders(raw);
            if (cleaned !== raw)
              st.updateMessageText(sid, assistantMsgId, cleaned);
            finalTextForHtml = cleaned || raw;
            // 保留非占位思考内容供折叠查看
            const th = latest?.thinking || '';
            if (th === '正在处理…' || th === '正在思考中...') {
              thinkingBatcherRef.current?.drop(
                streamBatchKey(sid, assistantMsgId)
              );
              st.updateMessageThinking(sid, assistantMsgId, '');
            }
            // 收口时规范化时间线，保证持久化/重渲染与 live 一致
            useLayoutStore.setState((state) => {
              const sess = state.sessionsById[sid];
              const msg = sess?.messages.find(
                (m: SessionMessage) => m.id === assistantMsgId
              );
              if (!msg || msg.sender !== 'assistant') return;
              const n = normalizeAssistantTimeline({ ...msg });
              msg.blocks = n.blocks;
              msg.toolCalls = n.toolCalls;
            });
          } catch {
            /* ignore */
          }
          // Worker 终态 HTML（流式期间未算 markdown）；与 onFrame isFinal 去重
          scheduleRunFinalHtml(finalTextForHtml);
          st.setSessionMessageStatus(sid, userMsgId, 'completed');
          st.setSessionMessageStatus(sid, assistantMsgId, 'completed', elapsed);
          const curStream = streamManagerRef.current!.get(sid);
          if (curStream?.assistantMsgId === assistantMsgId) {
            streamManagerRef.current!.delete(sid);
          }
          // H3：优先 run snapshot 真实 usage；无样本再字数估算
          void (async () => {
            try {
              const runId = localRunId;
              let applied = false;
              // pricingStore 冷路径：算费用时再 import
              const { estimateCostUsd } = await import('../api/pricingStore');
              if (runId) {
                // 稍等引擎落盘 snapshot
                await new Promise((r) => setTimeout(r, 400));
                const usage = await fetchRunSnapshotUsage(runId);
                if (
                  usage &&
                  (usage.sampleCount ?? 0) > 0 &&
                  (usage.promptTokens || usage.completionTokens)
                ) {
                  const model = getActiveModelId() || 'unknown';
                  const cur = useLayoutStore.getState().tokenUsage;
                  const next = applyUsageDelta(
                    cur,
                    usage,
                    (i: number, o: number) => estimateCostUsd(model, i, o)
                  );
                  const dIn = Math.max(0, (next.input || 0) - (cur.input || 0));
                  const dOut = Math.max(
                    0,
                    (next.output || 0) - (cur.output || 0)
                  );
                  const dCost = Math.max(0, (next.cost || 0) - (cur.cost || 0));
                  syncTelemetryData({ tokenUsage: next });
                  try {
                    const { recordUsageDelta } =
                      await import('../api/usageStore');
                    recordUsageDelta({
                      input: dIn,
                      output: dOut,
                      cost: dCost,
                      model,
                    });
                  } catch {
                    /* ignore */
                  }
                  applied = true;
                }
              }
              if (!applied) {
                const sess = getSessionById(sid);
                const userText =
                  sess?.messages.find((m: SessionMessage) => m.id === userMsgId)
                    ?.text || '';
                const asstText =
                  sess?.messages.find(
                    (m: SessionMessage) => m.id === assistantMsgId
                  )?.text || '';
                const approxIn = Math.max(1, Math.ceil(userText.length / 4));
                const approxOut = Math.max(0, Math.ceil(asstText.length / 4));
                const model = getActiveModelId() || 'unknown';
                const cur = useLayoutStore.getState().tokenUsage;
                const dCost = estimateCostUsd(model, approxIn, approxOut);
                syncTelemetryData({
                  tokenUsage: {
                    ...cur,
                    input: cur.input + approxIn,
                    output: cur.output + approxOut,
                    cost: cur.cost + dCost,
                  },
                });
                try {
                  const { recordUsageDelta } =
                    await import('../api/usageStore');
                  recordUsageDelta({
                    input: approxIn,
                    output: approxOut,
                    cost: dCost,
                    model,
                  });
                } catch {
                  /* ignore */
                }
              }
            } catch {
              /* ignore */
            }
          })();
          // 目标模式：即使不续写也尝试从本轮 checklist 同步进度
          {
            const live = getSessionById(sid);
            const liveGm = live?.goalMode;
            if (liveGm?.active) {
              const t =
                live?.messages.find(
                  (m: SessionMessage) => m.id === assistantMsgId
                )?.text || '';
              syncGoalTasksFromAssistantText(sid, t, liveGm);
            }
          }
          // 目标模式自动续写优先；否则 drain 排队
          if (!maybeContinueGoalMode(sid, assistantMsgId)) {
            drainQueuedAfterComplete(sid);
          }
        },
      },
      sid,
      assistantMsgId,
      streamOptions
    );

    // 若开流期间被同步 supersede（极罕见），立刻收掉本轮句柄
    const stillMine = streamManagerRef.current!.get(sid);
    if (stillMine?.assistantMsgId === assistantMsgId) {
      stillMine.cancel = () => cancelFn();
      if (localRunId) stillMine.runId = localRunId;
    }
  };
  // 每轮渲染绑定最新 starter，续写/drain 经 manager.scheduleStart 调用
  streamManagerRef.current!.bindStarter(runStreamingAssistant);

  const handleStopGeneration = () => {
    // 只停当前会话，其它会话的并行 run 继续
    const sid = resolveStreamSessionId(null, activeSessionId);
    if (!sid) return;
    const cur = streamManagerRef.current!.get(sid);
    if (!cur) return;
    streamRecovery.markFailed(sid, 'cancelled');
    // 先摘句柄：后续 cancel→onComplete 见 !isLive 整段 no-op，避免二次 drain
    streamManagerRef.current!.delete(sid);
    // 停止前刷出分帧缓冲区 + 批合并中的正文 / thinking / 工具
    const stopBuf = renderBufferRef.current;
    stopBuf?.markFinal();
    stopBuf?.flush(true);
    stopBuf?.stop();
    flushStreamBatchers();
    const st = useLayoutStore.getState();
    // 停止生成时中断目标自动续写
    if (getSessionById(sid)?.goalMode?.active) {
      streamManagerRef.current!.markGoalCancelled(sid);
      patchSession(sid, { goalMode: null });
    }
    const asst = getSessionById(sid)?.messages.find(
      (m: SessionMessage) => m.id === cur.assistantMsgId
    );
    const placeholder = stopAssistantPlaceholderText(asst?.text);
    if (placeholder) {
      st.updateMessageText(sid, cur.assistantMsgId, placeholder);
      st.updateMessageThinking(sid, cur.assistantMsgId, '');
    }
    // 立刻收成终态，避免 cancel 竞态下 UI 永久 processing
    st.setSessionMessageStatus(sid, cur.userMsgId, 'completed');
    st.setSessionMessageStatus(sid, cur.assistantMsgId, 'completed');
    // 有正文时终态 Worker 渲染（占位「已停止。」也可走 markdown，成本可忽略）
    const stopText = placeholder || asst?.text || stopBuf?.currentText() || '';
    if ((stopText || '').trim()) {
      scheduleFinalMarkdownHtml(sid, cur.assistantMsgId, stopText);
    }
    // 运行中工具收成中断（不伪造 success）
    const stopPatches = buildTerminalToolPatches(asst?.toolCalls, 'stop');
    if (stopPatches.length) {
      useLayoutStore.setState((state) => {
        const msg = state.sessionsById[sid]?.messages.find(
          (m: SessionMessage) => m.id === cur.assistantMsgId
        );
        if (!msg?.toolCalls) return;
        for (const p of stopPatches) {
          const tc = msg.toolCalls.find((t: MessageToolCall) => t.id === p.id);
          if (!tc) continue;
          tc.status = p.status;
          tc.output = p.output;
        }
      });
    }
    // safe cancel：引擎 cancel 同步 onComplete 已因 delete 而 no-op
    safeCancelStream(cur.cancel);
  };

  const handleSendChat = async (
    isInsert: boolean = false,
    textOverride?: string
  ) => {
    void isInsert;
    // 引导芯片直发：用 override 文本，不绑 composer 异步 state，也不附带当前附件
    const fromOverride = typeof textOverride === 'string';
    const rawInput = (fromOverride ? textOverride : chatInput).trim();
    const activeAttachments = fromOverride ? [] : attachments;
    // 允许仅发附件（截图/图片），不要求必须有文字；override 路径必须有字
    if (!rawInput && activeAttachments.length === 0) return;

    // 未配置密钥时软拦截：页内错误 + 打开设置，不 toast 引导
    if (needsKeySetup) {
      setPickerInlineError('请先在设置中配置服务商密钥与模型');
      openSettings('models');
      return;
    }
    // 有密钥无模型：页内错误 + 打开底栏选择器（可手填），不 toast
    if (needsModelSetup) {
      setPickerInlineError('请手填或选择模型 id 后再发送');
      onOpenModelPicker?.();
      return;
    }

    const slash = resolveSlashCommand(rawInput);

    // ── 纯导航 slash：绝不 createSession、不进对话流、成功不 toast（UI 即反馈）──
    if (isNavigationSlash(slash.kind)) {
      setChatInput('');
      setSlashMenuOpen(false);
      if (slash.kind === 'schedule') {
        emitUiEvent('open-scheduled');
        return;
      }
      if (slash.kind === 'teamwork-preview') {
        // 唯一入口：只开侧栏 Agent 浏览；不 toast、不 setActiveAgentId 盖主列
        void import('../api/openAgentPanel').then(
          ({ openAgentPanelBrowse }) => {
            openAgentPanelBrowse({
              sessionId: activeSessionId || undefined,
            });
          }
        );
        return;
      }
      // browser
      handleGlobalTabClick('preview');
      if (slash.kind === 'browser' && slash.url) {
        void import('../api/previewBrowserStore').then(
          ({ normalizeBrowseUrl, setPreviewUrl }) => {
            setPreviewUrl(normalizeBrowseUrl(slash.url));
          }
        );
      }
      return;
    }

    // ── 缺参：toast 用法后 return，且不建会话（防幽灵空壳）──
    if (slashMissingArg(slash)) {
      setChatInput('');
      setSlashMenuOpen(false);
      if (slash.kind === 'learn') onShowToast('用法：/learn <要记住的规则>');
      else if (slash.kind === 'goal') onShowToast('用法：/goal <要完成的目标>');
      else if (slash.kind === 'grill-me')
        onShowToast('用法：/grill-me <要对齐的主题>');
      return;
    }

    // skill：关开关 / 解析失败均在建会话前处理，避免幽灵会话
    let modelText = rawInput;
    let displayText = rawInput;
    if (slash.kind === 'skill') {
      if (!skillCommandsEnabled) {
        setChatInput('');
        setSlashMenuOpen(false);
        onShowToast('技能斜杠命令已关闭（设置 → 技能）');
        return;
      }
      try {
        // skillsApi 冷路径：仅技能 slash 时 import
        const { resolveSkillSlash, formatSkillInjection } =
          await import('../api/skillsApi');
        const resolved = await resolveSkillSlash(slash.raw);
        if (!resolved) {
          setChatInput('');
          setSlashMenuOpen(false);
          onShowToast('未找到该技能，请在设置 → 技能 中确认名称与启用状态');
          return;
        }
        modelText = formatSkillInjection(resolved.skill, resolved.rest);
        displayText = resolved.rest
          ? `/skill:${resolved.skill.name} ${resolved.rest}`
          : `使用技能：${resolved.skill.name}`;
        // 技能注入成功：展示文案已变，不 toast
      } catch (e) {
        setChatInput('');
        setSlashMenuOpen(false);
        onShowToast(
          `加载技能失败：${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
    }

    // /learn：仅成功写入时间线时才 ensure 会话；重复/失败不刷幽灵空壳，成功不 toast
    if (slash.kind === 'learn') {
      setChatInput('');
      setSlashMenuOpen(false);
      const ruleText = slash.rule;
      if (!ruleText) {
        onShowToast('用法：/learn <要记住的规则>');
        return;
      }
      try {
        const cwd = getWorkspacePath() || '__global__';
        const sets = await clientApi.getSettingsEx(cwd);
        const prev = Array.isArray(sets.customRules) ? sets.customRules : [];
        if (prev.includes(ruleText)) {
          onShowToast('该规则已存在');
          return;
        }
        const next = [...prev, ruleText];
        await clientApi.saveSettingsEx(cwd, 'global', { customRules: next });
        // rulesApi 冷路径：同步 rules 时 import
        const { rulesLinesToText, syncRulesToDaemon } =
          await import('../api/rulesApi');
        const globalText = rulesLinesToText(next, '# 全局规则');
        void syncRulesToDaemon({ globalText });

        // 草稿则 commit；否则解析 active；仍无则 mint。绝不 invent 远程 id 写时间线
        let learnSid = '';
        if (isPendingDraft(activeSessionId)) {
          learnSid =
            commitDraftIfNeeded({
              title: rawInput ? deriveSessionTitle(rawInput) : undefined,
            }) || '';
        } else {
          learnSid = resolveStreamSessionId(null, activeSessionId) || '';
          if (!learnSid) {
            learnSid =
              commitDraftIfNeeded() ||
              createSessionCmd({ title: '新会话' }) ||
              '';
          }
        }
        learnSid = resolveStreamSessionId(learnSid, null) || '';
        if (
          !learnSid ||
          !canStreamLocalSession(learnSid, !!getSessionById(learnSid))
        ) {
          onShowToast('会话不可用，规则已保存但未写入时间线');
          return;
        }
        const validLearnSid = learnSid;
        const userMsgId = `user-msg-${Date.now()}`;
        const asstMsgId = `assistant-msg-${Date.now()}-learn`;
        useLayoutStore.setState((state) => {
          const sess = state.sessionsById[validLearnSid];
          if (!ensureSessionMessages(sess)) return;
          sess.messages.push({
            id: userMsgId,
            sender: 'user',
            text: `/learn ${ruleText}`,
            timestamp: Date.now(),
            status: 'completed',
          });
          sess.messages.push({
            id: asstMsgId,
            sender: 'assistant',
            text: `已记录用户偏好：${ruleText}`,
            timestamp: Date.now() + 1,
            status: 'completed',
          });
        });
      } catch (e) {
        onShowToast(
          `记住规则失败：${e instanceof Error ? e.message : String(e)}`
        );
      }
      return;
    }

    // 对话流路径才创建会话（导航 / 缺参 / skill 失败 / learn 已全部 return）
    // pending draft → commit mint；无活动 → commit 或 createSession；不 invent 远程壳
    let sessionId = '';
    if (isPendingDraft(activeSessionId)) {
      sessionId =
        commitDraftIfNeeded({
          title: rawInput ? deriveSessionTitle(rawInput) : undefined,
        }) || '';
    } else {
      sessionId = resolveStreamSessionId(null, activeSessionId) || '';
      if (!sessionId) {
        // 无活动会话：先草稿再提交，或直接 createSession mint
        sessionId =
          commitDraftIfNeeded() || createSessionCmd({ title: '新会话' }) || '';
      }
    }
    if (
      !sessionId ||
      !canStreamLocalSession(sessionId, !!getSessionById(sessionId))
    ) {
      setPickerInlineError('会话不可用，请新建会话后重试');
      return;
    }

    if (slash.kind === 'goal') {
      const goalText = slash.goal;
      streamManagerRef.current!.clearGoalCancelled(sessionId);
      const gm = createInitialGoalMode(goalText, GOAL_DEFAULT_MAX_ITERATIONS);
      patchSession(sessionId, { goalMode: gm });
      displayText = `/goal ${goalText}`;
      modelText = `${buildGoalModePrefix(goalText, 0, gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS, gm.tasks)}${goalText}`;
      // 目标模式：Tasks 卡 / goal ribbon 同源反馈，成功不 toast
    }

    if (slash.kind === 'grill-me') {
      setPermissionMode('plan');
      displayText = `/grill-me ${slash.topic}`;
      modelText = `${GRILL_ME_PREFIX}主题：${slash.topic}`;
      // 计划权限 pill 即反馈，不 toast
    }

    // 若已在目标模式且本条不是 /goal 命令本身：仍为后续普通消息注入前缀
    if (rawInput && slash.kind !== 'goal') {
      const liveGm = getSessionById(sessionId)?.goalMode;
      if (liveGm?.active && liveGm.goal) {
        const maxIter = liveGm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
        modelText = `${buildGoalModePrefix(liveGm.goal, liveGm.iteration ?? 0, maxIter, liveGm.tasks)}${modelText}`;
      }
    }

    // 附件 → 结构化 content parts + 文本 prompt 备援（override 直发不带附件）
    const { promptAttachBlock, streamOptions } = buildMultimodalFromAttachments(
      modelText,
      activeAttachments
    );
    // 文件面板选区批注：注入模型上下文；气泡只展示用户原文 + 轻量提示
    const fileAnns = takePendingFileAnnotations();
    const annBlock = formatAnnotationsForModel(fileAnns);
    const input =
      (annBlock ? `${annBlock}\n\n` : '') + modelText + promptAttachBlock;
    // 批注并入 content text part（若有多模态）
    let finalStreamOptions = streamOptions;
    if (finalStreamOptions?.content?.length && annBlock) {
      const parts = [...finalStreamOptions.content];
      const firstText = parts.findIndex(
        (p: ChatContentPart) => p.type === 'text'
      );
      const head = firstText >= 0 ? parts[firstText] : undefined;
      if (head && head.type === 'text') {
        parts[firstText] = {
          type: 'text',
          text: `${annBlock}\n\n${head.text}`,
        };
      } else {
        parts.unshift({ type: 'text', text: annBlock });
      }
      finalStreamOptions = { ...finalStreamOptions, content: parts };
    } else if (!finalStreamOptions && annBlock) {
      finalStreamOptions = {
        content: [{ type: 'text', text: `${annBlock}\n\n${modelText}` }],
        hasImages: false,
      };
    }
    if (fileAnns.length) {
      displayText = displayText
        ? `${displayText}\n\n（含 ${fileAnns.length} 条文件批注）`
        : `（${fileAnns.length} 条文件批注）`;
    }
    if (activeAttachments.length > 0) {
      // 气泡仅轻量展示附件名（图片不把 dataUrl 塞进消息正文）
      displayText = `${displayText}${displayText ? '\n\n' : ''}📎 ${activeAttachments.map((a: ChatAttachment) => a.name).join('、')}`;
    }

    const userMsgId = `user-msg-${Date.now()}`;
    const sessLookup = getSessionById(sessionId);
    // 二次校验：create 与发送之间壳被 prune 则中止，不 void 开流
    if (!sessLookup) {
      setPickerInlineError('会话不可用，请新建会话后重试');
      return;
    }
    const sessMsgs = Array.isArray(sessLookup.messages)
      ? sessLookup.messages
      : [];
    const isAiBusy = sessMsgs.some(
      (m: SessionMessage) => m.status === 'processing'
    );

    // 标题仍为默认时自动命名（首条优先；不覆盖用户手动 rename）
    {
      const sess = sessLookup;
      if (sess && isDefaultSessionTitle(sess.title)) {
        const priorUser = sessMsgs.find(
          (m: SessionMessage) => m.sender === 'user' && (m.text || '').trim()
        );
        const seed = (priorUser?.text || rawInput).trim();
        const nextTitle = deriveSessionTitle(seed);
        if (!isDefaultSessionTitle(nextTitle)) {
          renameSession(sessionId, nextTitle);
        }
      }
    }

    let enqueued = false;
    try {
      useLayoutStore.setState((state) => {
        const sess = state.sessionsById[sessionId];
        // messages 缺省时就地初始化；session 已不存在则跳过（不 invent）
        if (!ensureSessionMessages(sess)) return;
        const newMsg: SessionMessage = {
          id: userMsgId,
          sender: 'user',
          text: displayText,
          timestamp: Date.now(),
          status: isAiBusy ? 'queued' : 'processing',
        };
        // 正式版：统一入队或立即发送
        // 侧栏时间由消息 timestamp 推算，不写死「刚刚」
        sess.messages.push(newMsg);
        enqueued = true;
      });
    } catch (err) {
      console.error('Failed to enqueue user message:', err);
    }

    if (!enqueued) {
      setPickerInlineError('会话消息发送失败，已为您保留输入内容');
      return;
    }

    // 消息已确定写入 Store 后方可重置输入框与草稿
    setChatInput('');
    useLayoutStore.getState().setComposerDraft(sessionId, '');
    setSlashMenuOpen(false);
    if (!fromOverride) setAttachments([]);
    setPickerInlineError('');

    if (!isAiBusy) {
      const store = useLayoutStore.getState();
      if (store.activeSessionId !== sessionId) {
        store.setActiveSessionId(sessionId);
      }
      runStreamingAssistant(input, userMsgId, sessionId, finalStreamOptions);
    }
  };

  // setRunNotice：手动关时清 timer；外部仍可用
  const setRunNoticePublic: Dispatch<SetStateAction<RunNotice | null>> =
    useCallback(
      (action) => {
        setRunNotice((prev) => {
          const next = typeof action === 'function' ? action(prev) : action;
          if (next == null) clearRunNoticeTimer();
          return next;
        });
      },
      [clearRunNoticeTimer]
    );

  return {
    runNotice,
    setRunNotice: setRunNoticePublic,
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
  };
}
