import { useRef } from 'react';
import { getSessionById } from '../../store/sessionStore';
import { streamAssistantResponseApi } from '../../api/chatApi';
import type { StreamRequestOptions } from '../../api/chatApi';
import {
  isShellToolName,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../../api/toolFeedback';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { checkAndAlertSilentComplete } from '../../api/silentComplete';
import { recordStreamDiag } from '../../api/streamDiag';
import {
  applyUsageDelta,
  fetchRunSnapshotUsage,
} from '../../api/sessionEventHydrate';
import { getActiveModelId } from '../../api/providerProfiles';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import {
  streamBatchKey,
  streamToolBatchKey,
  isImmediateToolStatus,
} from '../../api/streamTextBatcher';
import type { StreamToolCallPatch } from '../../api/streamTextBatcher';
import { buildGoalRunTaskFields } from '../../api/goalModeController';
import {
  addTerminalLine,
  addTerminalLines,
  accumulateTokenUsage,
  patchSession,
} from '../../api/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { getSettingsState } from '../../store/storeAccess';
import {
  clearStream,
  getStreamText,
  getStreamTool,
  setStreamText,
} from '../../store/streamingStore';
import { generateMessageId } from '../../utils/generateMessageId';
import type {
  MessageToolApprovalMeta,
  MessageToolCall,
  SessionAgent,
} from '../../store/types';
import type { FileDiff } from '../../store/types';
import type { SessionMessage } from '../../store/layoutStore';
import type { UseChatStreamOptions, RunNotice } from './types';
import type { StreamBatcherRefs } from './useStreamBatchers';
import {
  resolveStreamSessionId,
  canStreamLocalSession,
  isLiveStreamRun,
  buildTerminalToolPatches,
  scheduleFinalMarkdownHtml,
  preloadPublishToolDiffs,
  publishToolDiffsLazy,
  commitStreamToSession,
  commitStreamToolsToSession,
  snapshotStreamTextToSession,
} from './helpers';
import {
  dispatchStreamStopCancel,
  markStreamingActive,
} from '../../api/streamStop';
import { useGoalMode } from './useGoalMode';

/**
 * T-47：run usage 成本估算器选择（纯函数，供单测；4D 回退规则）。
 *
 * - 缓存字段已上报（cacheRead / cacheWrite 任一 > 0）→ 4D：
 *   `estimateCostUsd4d` + `estimateSavingsUsd`（savedCost = 2D 全价 - 4D 实际价）；
 * - 否则回退 2D：`estimateCostUsd`（缓存缺失不虚报节省，不假装有命中）。
 *
 * 估算器实现由调用方注入（pricingStore 动态 import），本函数不依赖
 * localStorage / 定价数据，保持可单测。
 */
function pickUsageCostEstimators(
  usage: { cacheReadTokens?: number; cacheWriteTokens?: number },
  estimators: {
    estimateCostUsd: (model: string, input: number, output: number) => number;
    estimateCostUsd4d: (
      model: string,
      prompt: number,
      completion: number,
      cacheRead: number,
      cacheWrite: number
    ) => number;
    estimateSavingsUsd: (
      model: string,
      prompt: number,
      completion: number,
      cacheRead: number,
      cacheWrite: number
    ) => number;
  },
  model: string
): {
  estimateCost: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number
  ) => number;
  estimateSavings?: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number
  ) => number;
} {
  const hasCache =
    (usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0;
  if (hasCache) {
    return {
      estimateCost: (i, o, cr, cw) =>
        estimators.estimateCostUsd4d(model, i, o, cr ?? 0, cw ?? 0),
      estimateSavings: (i, o, cr, cw) =>
        estimators.estimateSavingsUsd(model, i, o, cr ?? 0, cw ?? 0),
    };
  }
  return {
    estimateCost: (i, o) => estimators.estimateCostUsd(model, i, o),
  };
}

/**
 * 可行动错误 kind（需用户处理：补密钥/改地址/选工作区等）→ 横幅 + 一次性 toast。
 * 对齐 userFacingErrors.SoftFailureKind 分类；network/ended 不在此列。
 */
const ACTIONABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  'blocked',
  'auth',
  'no_key',
  'no_project',
]);

export type RunErrorSurface =
  /** network/恢复类：仅输入框上方持久条（无 TTL、恢复即消失），不进 toast、不写气泡 */
  | 'persistent'
  /** 有正文的失败：仅气泡错误卡（不弹横幅、不弹 toast） */
  | 'bubble'
  /** 无正文的失败：仅横幅（14s TTL），无 toast */
  | 'banner'
  /** 可行动错误：横幅 + 一次性 toast */
  | 'banner-toast';

/** 是否可行动错误 kind（blocked / auth / no_key / no_project）。 */
export function isActionableErrorKind(
  kind: string | undefined | null
): boolean {
  return kind != null && ACTIONABLE_ERROR_KINDS.has(kind);
}

/**
 * onRunError 分级分发裁决（展示唯一性，通道 E-B）：
 * - network/恢复类 → 持久条（无论是否有正文，错误不写气泡）；
 * - 可行动错误 → 横幅 + toast（有正文时气泡 errorDetail 一并保留，由调用方处理）；
 * - 其余有正文 → 仅气泡错误卡；
 * - 其余无正文 → 仅横幅。
 */
export function resolveRunErrorSurface(
  kind: string | undefined | null,
  hadText: boolean
): RunErrorSurface {
  if (kind === 'network') return 'persistent';
  if (isActionableErrorKind(kind)) return 'banner-toast';
  if (hadText) return 'bubble';
  return 'banner';
}

export function useStreamCallbacks(
  options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  noticeHelpers: {
    pushRunNotice: (notice: RunNotice, ttlMs?: number) => void;
    dismissRunNotice: () => void;
    /** 仅清 TTL 横幅，持久条保持显示（发送 / onChunk / onComplete 路径） */
    dismissTransientRunNotice: () => void;
  },
  queryHelpers: {
    wsId: string;
    setActiveDiffSource: (source: FileDiff | null) => void;
    upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
  }
): {
  runStreamingAssistant: (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => void;
  /** 默认 Stop = L2 cooperative */
  handleStopGeneration: () => void;
  /** 强制取消 = L3 force（UI 二次确认后调用） */
  handleForceCancelGeneration: () => void;
} {
  const { onShowToast } = options;
  const { wsId, setActiveDiffSource, upsertSessionAgent } = queryHelpers;
  const { pushRunNotice, dismissTransientRunNotice } = noticeHelpers;
  const {
    streamManagerRef,
    textBatcherRef,
    thinkingBatcherRef,
    toolBatcherRef,
    renderBufferRef,
    openSidePanelOnceRef,
    flushStreamBatchers,
  } = refs;

  const { maybeContinueGoalMode, drainQueuedAfterComplete } = useGoalMode(
    streamManagerRef,
    onShowToast
  );

  const generationMapRef = useRef<Map<string, number>>(new Map());

  const runStreamingAssistant = (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => {
    const sid = resolveStreamSessionId(
      sessionIdOverride,
      getCompositionRoot().session.getActiveSessionId()
    );
    if (!sid || !canStreamLocalSession(sid, !!getSessionById(sid))) return;

    // W8-3：live stream 存在时禁止 hard replace/cancel。
    // 发送路径应走 useSlashSend follow_up 入队；此处 fail-closed 拒绝第二路 stream。
    const prevStream = streamManagerRef.current!.get(sid);
    if (prevStream) {
      try {
        const st = getCompositionRoot().layout.getState();
        const userMsg = getSessionById(sid)?.messages?.find(
          (m: SessionMessage) => m.id === userMsgId
        );
        if (userMsg?.sender === 'user' && userMsg.status === 'processing') {
          st.setSessionMessageStatus(sid, userMsgId, 'queued');
        }
      } catch {
        /* ignore */
      }
      console.warn(
        '[runStreamingAssistant] refuse start while stream live (L1 follow_up, no abort)',
        sid,
        userMsgId
      );
      return;
    }

    // 发送前固定 assistant clientMessageId（= message.id）：
    // 热路径 streamingStore / 终态 commit / run-task 下发 / hydrate rekey 同一键
    const assistantMsgId = generateMessageId('assistant');
    const store = getCompositionRoot().layout.getState();
    const toolNames: Record<string, string> = {};
    const startTime = Date.now();
    dismissTransientRunNotice();
    let gotRealText = false;
    /** network 错误收口标志：onComplete 空回复分支守卫（持久条已承载错误，不重复弹横幅） */
    let runEndedWithNetworkError = false;
    let localRunId: string | null = null;
    let runClosed = false;
    let streamedFullText = '';
    let finalHtmlScheduled = false;
    /**
     * complete 收口 drain 标志（T2.2，08-detail 3.2）：
     * - onComplete 置 draining=true（不置 runClosed），调 flushFinal()；
     * - drain 期间中间帧照常 setStreamText（UI 以预算节奏自然流完）；
     * - isFinal 帧到达 → finishComplete()（commit/status/HTML 收口），
     *   执行后 runClosed=true、draining=false。
     */
    let draining = false;
    /** finishComplete 幂等守卫（drain 无残余时同步调用 + isFinal 帧双路径） */
    let completed = false;

    const scheduleRunFinalHtml = (fullText: string) => {
      if (finalHtmlScheduled) return;
      if (!(fullText || '').trim()) return;
      finalHtmlScheduled = true;
      // N6（08-detail 3.3）：fullText 已由 finishComplete 预清理，
      // helpers 不再二次 strip（预清理文本直接入 HTML 调度）
      scheduleFinalMarkdownHtml(sid, assistantMsgId, fullText, {
        preCleaned: true,
      });
    };

    const buffer = new StreamRenderBuffer();
    renderBufferRef.current = buffer;
    buffer.reset();

    const myGen = (generationMapRef.current.get(sid) ?? 0) + 1;
    generationMapRef.current.set(sid, myGen);

    const assertLive = (): boolean => {
      if (runClosed) return false;
      return isLiveStreamRun(
        streamManagerRef.current!.get(sid),
        assistantMsgId
      );
    };

    buffer.onFrame = (frame) => {
      if (frame.isFinal) {
        // 收口帧恒落盘：本 run 的 buffer 属主（message id 唯一，新 run 用新 id
        // 不冲突）；complete 路径（draining）触发 finishComplete 收口，
        // stop 路径（非 draining）只落盘、收口由 finalizeStopGeneration 自管。
        // F1c（R2-4）：stop 路径（!draining）isFinal 帧仅为预算循环终止信号——
        // 收口已由 finalizeStopGeneration 同步完成（commit 含全量文本 + clearStream），
        // 跳过 setStreamText 避免 commit 后残留写入（byKey 累积）；complete 路径保持原逻辑。
        if (draining) {
          setStreamText(sid, assistantMsgId, frame.full);
          finishComplete();
        }
        return;
      }
      // T2.2 drain 帧守卫放宽：complete 分帧 drain 期间中间帧是「最终文本
      // 增量」，照常 setStreamText（UI 以预算节奏自然流完，无跳跃感）
      if (runClosed && !draining) return;
      if (!assertLive() && !draining) return;
      if (myGen !== generationMapRef.current.get(sid)) return;
      // Lightweight store only — avoid immer/session messages ref churn per token.
      setStreamText(sid, assistantMsgId, frame.full);
    };
    buffer.start();
    preloadPublishToolDiffs();
    if (getCompositionRoot().session.getActiveSessionId() === sid) {
      openSidePanelOnceRef.current = { terminal: false, diff: false };
      setActiveDiffSource(null);
    }

    // cancel 支持 L2/L3 mode；协议对接见 runControlClient / createStreamCancel
    let cancelStreamFn: (opts?: {
      mode?: 'cooperative' | 'force';
    }) => void = () => {};
    streamManagerRef.current!.set(sid, {
      cancel: (opts) => cancelStreamFn(opts),
      userMsgId,
      assistantMsgId,
      runId: null,
    });
    // 上文已拒绝 live replace；此处恒为 net-new start
    markStreamingActive(true);

    store.addMessage(wsId, sid, {
      id: assistantMsgId,
      sender: 'assistant',
      text: '',
      thinking: '正在处理…',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [],
    });

    /**
     * complete 收口（T2.2 拆分）：isFinal 帧到达（或 drain 无残余）后执行。
     * 与旧 onComplete 的差异：
     * - commit 文本来源 = buffer.currentText() 优先（drain 帧被新 run 接管
     *   丢弃时 getStreamText 可能停在残余前——buffer 始终持有完整全文）；
     * - recordStreamDiag / checkAndAlertSilentComplete 移出同步主块（微任务，
     *   主块瘦身，T2.3）；
     * - scheduleRunFinalHtml 收预清理文本（N6 单次化，helpers 不再二次 strip）。
     */
    const finishComplete = () => {
      if (completed) return;
      completed = true;
      // ONE durable commit of final stream text + thinking; clear streaming entry.
      const committedText = commitStreamToSession(sid, assistantMsgId, {
        text:
          buffer.currentText() ||
          getStreamText(sid, assistantMsgId) ||
          streamedFullText ||
          '',
      });
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const st = getCompositionRoot().layout.getState();
      const asst = getSessionById(sid)?.messages.find(
        (m: SessionMessage) => m.id === assistantMsgId
      );
      const lastTool = (asst?.toolCalls || []).findLast(Boolean);
      const runningLeft = (asst?.toolCalls || []).filter(
        (t: MessageToolCall) => t.status === 'running'
      ).length;
      // T2.3 主块瘦身：diag 移出同步主块（微任务）
      queueMicrotask(() => {
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
      });
      // network 错误收口：不弹空回复横幅（持久条已承载错误），也不清持久条
      if (!runEndedWithNetworkError) {
        if (
          asst &&
          !gotRealText &&
          !(asst.text || committedText || '').trim()
        ) {
          const hasTools = (asst.toolCalls || []).some(
            (t: MessageToolCall) =>
              t.status === 'success' ||
              t.status === 'error' ||
              t.status === 'running'
          );
          if (!hasTools) {
            pushRunNotice(
              {
                text: '这一轮没有文字回复。若刚改过配置，请检查模型与网络。',
                kind: 'empty',
              },
              6000
            );
          } else {
            dismissTransientRunNotice();
          }
        } else if (
          gotRealText ||
          (asst?.text || committedText || '').trim()
        ) {
          dismissTransientRunNotice();
        }
      }
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
      let finalTextForHtml = '';
      try {
        const latest = getSessionById(sid)?.messages.find(
          (m: SessionMessage) => m.id === assistantMsgId
        );
        const raw = latest?.text || committedText || streamedFullText || '';
        const cleaned = stripThoughtPlaceholders(raw);
        if (cleaned !== raw)
          st.updateMessageText(sid, assistantMsgId, cleaned);
        finalTextForHtml = cleaned || raw;
        const th = latest?.thinking || '';
        if (th === '正在处理…' || th === '正在思考中...') {
          thinkingBatcherRef.current?.drop(
            streamBatchKey(sid, assistantMsgId)
          );
          st.updateMessageThinking(sid, assistantMsgId, '');
        }
        // T-E 步骤 3（U4）：raw setState → updateMessageTimeline action
        getCompositionRoot()
          .layout.getState()
          .updateMessageTimeline(sid, assistantMsgId);
      } catch {
        /* ignore */
      }
      // N6 单次化：finalTextForHtml 已预清理，helpers 不再二次 strip
      scheduleRunFinalHtml(finalTextForHtml);
      const latestUserMsg = getSessionById(sid)?.messages.find(
        (m: SessionMessage) => m.id === userMsgId
      );
      const latestAssistantMsg = getSessionById(sid)?.messages.find(
        (m: SessionMessage) => m.id === assistantMsgId
      );
      // 只在消息仍处于 processing 时标记完成；error/cancelled 等终态保持原状，
      // 避免触发 error → completed 这类非法状态转换。
      if (latestUserMsg?.status === 'processing') {
        st.setSessionMessageStatus(sid, userMsgId, 'completed');
      }
      if (latestAssistantMsg?.status === 'processing') {
        st.setSessionMessageStatus(
          sid,
          assistantMsgId,
          'completed',
          elapsed
        );
      }
      // D2-5：终态后检测 silent complete（无 UserView 可见正文/工具）；
      // T2.3 主块瘦身：移出同步主块（微任务）
      queueMicrotask(() => {
        try {
          const finalizedAsst = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === assistantMsgId
          );
          checkAndAlertSilentComplete(finalizedAsst, {
            sessionId: sid,
            runId: localRunId || undefined,
            messageId: assistantMsgId,
          });
        } catch {
          /* ignore alert failures */
        }
      });
      // streamManager entry 已在 onComplete 同步释放；generationMap 在此清理
      //（drain 期间保持，供 myGen 守卫放行中间帧；新 run 只会发生在
      //  finishComplete 之后，不会覆盖本 run 的 gen）
      generationMapRef.current.delete(sid);
      runClosed = true;
      draining = false;
      void (async () => {
        try {
          const runId = localRunId;
          let applied = false;
          const { estimateCostUsd, estimateCostUsd4d, estimateSavingsUsd } =
            await import('../../api/pricingStore');
          if (runId) {
            await new Promise((r) => setTimeout(r, 400));
            const usage = await fetchRunSnapshotUsage(runId);
            if (
              usage &&
              (usage.sampleCount ?? 0) > 0 &&
              (usage.promptTokens || usage.completionTokens)
            ) {
              const model = getActiveModelId() || 'unknown';
              const cur = getSettingsState().tokenUsage;
              // T-47：4D 消费——缓存字段上报时用 estimateCostUsd4d + estimateSavingsUsd
              //（savedCost = 2D 全价 - 4D 实际价）；缓存缺失回退 2D，不虚报节省
              const { estimateCost, estimateSavings } =
                pickUsageCostEstimators(
                  usage,
                  {
                    estimateCostUsd,
                    estimateCostUsd4d,
                    estimateSavingsUsd,
                  },
                  model
                );
              const next = applyUsageDelta(
                cur,
                usage,
                estimateCost,
                estimateSavings
              );
              const dIn = Math.max(0, (next.input || 0) - (cur.input || 0));
              const dOut = Math.max(
                0,
                (next.output || 0) - (cur.output || 0)
              );
              const dCost = Math.max(0, (next.cost || 0) - (cur.cost || 0));
              const dCacheRead = Math.max(
                0,
                (next.cacheRead || 0) - (cur.cacheRead || 0)
              );
              const dCacheWrite = Math.max(
                0,
                (next.cacheWrite || 0) - (cur.cacheWrite || 0)
              );
              const dSavedCost = Math.max(
                0,
                (next.savedCost || 0) - (cur.savedCost || 0)
              );
              // F5 P2 修复：并发增量不丢失——delta 走串行化合并入口，
              // 不再「读陈旧快照 → 整体替换」（多 run 同刻收尾时后写者
              // 覆盖先写者、增量丢失）。D4 收敛：历史流水委托内建
              // （accumulateTokenUsage 单点完成 recordUsageDelta 委托）。
              accumulateTokenUsage({
                input: dIn,
                output: dOut,
                cost: dCost,
                model,
                ...(dCacheRead > 0 ? { cacheRead: dCacheRead } : {}),
                ...(dCacheWrite > 0 ? { cacheWrite: dCacheWrite } : {}),
                ...(dSavedCost > 0 ? { savedCost: dSavedCost } : {}),
              });
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
            const dCost = estimateCostUsd(model, approxIn, approxOut);
            // F5 P2 修复：估算兜底路径同样走串行化合并（并发不丢增量）；
            // D4 收敛：历史流水委托内建（同上，不再并列双写）
            accumulateTokenUsage({
              input: approxIn,
              output: approxOut,
              cost: dCost,
              model,
            });
          }
        } catch {
          /* ignore */
        }
      })();
      if (!maybeContinueGoalMode(sid, assistantMsgId)) {
        drainQueuedAfterComplete(sid);
      }
    };

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
      // Durable text snapshot before tool so blocks/streamTextOffset interleave correctly.
      snapshotStreamTextToSession(sid, assistantMsgId, streamedFullText);
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
        status === 'pending_approval'
      );
      if (isShellToolName(name) && args) {
        addTerminalLine(`$ ${args}`, sid);
      }
    };

    const goalOpts = (() => {
      const liveGm = getSessionById(sid)?.goalMode;
      if (!liveGm?.active || !(liveGm.goal || '').trim()) return undefined;
      return buildGoalRunTaskFields({
        goal: liveGm.goal,
        maxIterations: liveGm.maxIterations ?? 5,
      });
    })();
    // 助手 placeholder 幂等键始终下发；用户 clientMessageId 由 send 路径注入 options
    const mergedStreamOptions: StreamRequestOptions = {
      ...(streamOptions ?? {}),
      ...(goalOpts ?? {}),
      assistantClientMessageId:
        streamOptions?.assistantClientMessageId || assistantMsgId,
    };

    cancelStreamFn = streamAssistantResponseApi(
      input,
      {
        onRunMeta: ({ runId }) => {
          if (!assertLive()) return;
          localRunId = runId;
          const entry = streamManagerRef.current!.get(sid);
          if (entry && entry.assistantMsgId === assistantMsgId) {
            entry.runId = runId;
          }
          // T-E 步骤 3（U1）：raw setState → setEngineLastRunId action
          getCompositionRoot().layout.getState().setEngineLastRunId(sid, runId);
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
            messages: [],
            startedAt: Date.now(),
          });
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
          // T-E 步骤 3（U2）：raw setState → applySubagentEventToAgent action
          getCompositionRoot()
            .layout.getState()
            .applySubagentEventToAgent(sid, info.subagentId, info.event);
        },
        onSubagentEnded: (info) => {
          if (!assertLive()) return;
          if (!info.subagentId) return;
          // T-E 步骤 3（U3）：raw setState → patchSessionAgentToolStatus action
          //（agent 终态 + 时间线收口 + 父工具卡终态，与全局面 S3 共用同一 action）
          getCompositionRoot()
            .layout.getState()
            .patchSessionAgentToolStatus(sid, info.subagentId, {
              status: info.status,
              ...(info.summary ? { summary: info.summary } : {}),
            });
        },
        onTerminalLine: (line) => {
          if (!assertLive()) return;
          addTerminalLine(line, sid);
        },
        onToolSuccess: (toolId, output, diffs) => {
          if (!assertLive()) return;
          const name =
            toolNames[toolId] ||
            getStreamTool(sid, assistantMsgId, toolId)?.name ||
            getSessionById(sid)
              ?.messages?.find((m: SessionMessage) => m.id === assistantMsgId)
              ?.toolCalls?.find((t: MessageToolCall) => t.id === toolId)
              ?.name ||
            '';
          const args =
            getStreamTool(sid, assistantMsgId, toolId)?.arguments ||
            getSessionById(sid)
              ?.messages?.find((m: SessionMessage) => m.id === assistantMsgId)
              ?.toolCalls?.find((t: MessageToolCall) => t.id === toolId)
              ?.arguments ||
            '';
          const displayOut = sanitizeToolDisplayOutput(output || '');
          const resolvedDiffs = resolveToolDiffs({
            name,
            args,
            output: displayOut,
            structuredDiffs: diffs,
          });
          queueToolCallPatch(
            toolId,
            {
              id: toolId,
              ...(name ? { name } : {}),
              status: 'success',
              output: displayOut || output || '完成',
              diffs: resolvedDiffs.length ? resolvedDiffs : undefined,
            },
            true
          );
          if (isShellToolName(name) && displayOut) {
            addTerminalLines(displayOut.split('\n').slice(0, 80), sid);
          }
          if (resolvedDiffs.length > 0) {
            publishToolDiffsLazy(resolvedDiffs);
          }
        },
        onToolError: (toolId, error) => {
          if (!assertLive()) return;
          const clean = sanitizeToolDisplayOutput(error || '');
          queueToolCallPatch(
            toolId,
            { id: toolId, status: 'error', output: clean || error || '失败' },
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
          dismissTransientRunNotice();
          streamedFullText += chunk;
          if (renderBufferRef.current) {
            renderBufferRef.current.push(chunk);
          } else {
            textBatcherRef.current?.push(
              streamBatchKey(sid, assistantMsgId),
              streamedFullText
            );
          }
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
          if (!assertLive()) return;
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
          const hadText = !!(
            (asstErr?.text || '').trim() ||
            getStreamText(sid, assistantMsgId)?.trim()
          );
          // 分级分发（通道 E-B）：按错误分类选展示面，一次错误只占一个瞬时面；
          // 持久条与横幅/toast 互斥（persistent 无 TTL，恢复驱动消失）。
          const surface = resolveRunErrorSurface(kind, hadText);
          const notice: RunNotice = {
            text: message,
            kind: kind || 'error',
            detail: detail || undefined,
          };
          if (surface === 'persistent') {
            // network/恢复类：仅输入框上方持久条；不进 toast、不写气泡
            runEndedWithNetworkError = true;
            pushRunNotice({ ...notice, persistent: true });
          } else if (surface === 'banner-toast') {
            // 可行动错误（blocked/auth/no_key/no_project）：横幅 + 一次性 toast
            pushRunNotice(notice, 14000);
            onShowToast(message);
          } else if (surface === 'banner') {
            // 无正文的失败：仅横幅（14s TTL），无 toast
            pushRunNotice(notice, 14000);
          }
          // bubble：有正文的失败仅气泡错误卡（不弹横幅、不弹 toast）
          if (asstErr) {
            if (surface === 'persistent') {
              // network 类不写气泡错误卡；无正文时 withdraw 占位（保持现状）
              if (!hadText) {
                store.withdrawMessage(wsId, sid, assistantMsgId);
                clearStream(sid, assistantMsgId);
              }
            } else if (!hadText) {
              store.withdrawMessage(wsId, sid, assistantMsgId);
              clearStream(sid, assistantMsgId);
            } else {
              store.setSessionMessageStatus(
                sid,
                assistantMsgId,
                'error',
                undefined,
                {
                  errorDetail: {
                    message: message || '服务暂时不可用，请检查网络或后端配置',
                    kind: kind || 'stream-error',
                    technical:
                      typeof detail === 'string'
                        ? detail
                        : detail
                          ? JSON.stringify(detail)
                          : undefined,
                  },
                }
              );
            }
          }
          flushStreamBatchers();
          // R-11（08-detail T5.4）：error 收口补清理——先预算刷残余帧
          //（避免残余文本被 gen 守卫丢弃），再按 complete 同语义删 gen
          //（entry 匹配守卫：被新 run 接管时不误删新 run 的 generationMap）
          renderBufferRef.current?.flush(false);
          const errCur = streamManagerRef.current!.get(sid);
          if (errCur?.assistantMsgId === assistantMsgId) {
            generationMapRef.current.delete(sid);
          }
        },
        onComplete: () => {
          if (runClosed) return;
          if (
            !isLiveStreamRun(streamManagerRef.current!.get(sid), assistantMsgId)
          ) {
            runClosed = true;
            // Replaced by a newer run — that run owns streamingActive; do not clear.
            return;
          }
          // T2.2（08-detail 3.2）：drain 标志放宽——不置 runClosed，分帧 drain
          // 期间中间帧照常 setStreamText（UI 以预算节奏自然流完，无「停一下再出
          // 最终版」跳跃感）；isFinal 帧到达后由 finishComplete 收口。
          draining = true;
          markStreamingActive(false);
          // streamManager entry 同步释放：L1 follow_up 拒绝窗口以 streamManager
          // 为门，drain 期间新发送可入队不误拒；generationMap 保留到
          // finishComplete（drain 中间帧需通过 myGen 守卫）。
          const curStream = streamManagerRef.current!.get(sid);
          if (curStream?.assistantMsgId === assistantMsgId) {
            streamManagerRef.current!.delete(sid);
          }
          const hadPending = buffer.bufferedLength() > 0;
          // 预算式收口（T2.1 flushFinal）：≤2 帧同步刷完（isFinal 帧同步到达 →
          // finishComplete 同步执行）；大残余走 rAF 预算循环。
          buffer.flushFinal();
          flushStreamBatchers();
          // 无残余：isFinal 帧不会到达 → 同步收口（finishComplete 幂等）
          if (!hadPending) finishComplete();
        },
      },
      sid,
      assistantMsgId,
      mergedStreamOptions
    );

    const stillMine = streamManagerRef.current!.get(sid);
    if (stillMine?.assistantMsgId === assistantMsgId) {
      stillMine.cancel = (opts) => cancelStreamFn?.(opts);
      if (localRunId) stillMine.runId = localRunId;
    }
  };

  streamManagerRef.current!.bindStarter(runStreamingAssistant);

  /**
   * 停止生成：默认 L2 cooperative；force=true 时 L3。
   * UI 默认 Stop → handleStopGeneration()；强制取消 → handleForceCancelGeneration()。
   * 共享 wire：api/streamStop.dispatchStreamStopCancel → createStreamCancel / compositionRoot
   *（TRANSITIONAL：daemon L2 未全量时仍成对 cancel-run.mode）。
   * 本函数保留 chat 专属 partials（buffer / goalMode / message status / telemetry）。
   */
  const finalizeStopGeneration = (force: boolean) => {
    const sid = resolveStreamSessionId(
      null,
      getCompositionRoot().session.getActiveSessionId()
    );
    if (!sid) return;
    const cur = streamManagerRef.current!.get(sid);
    if (!cur) return;
    streamManagerRef.current!.delete(sid);
    generationMapRef.current.delete(sid);
    markStreamingActive(false);
    const stopBuf = renderBufferRef.current;
    // T2.2：stop 路径走预算式收口（常态 ≤2 帧同步刷完，行为不变；
    // 大残余分帧，isFinal 帧落盘后收口仍由本函数自管）
    // F1a（R2-4）：不再调用 stopBuf?.stop()——它 cancelScheduledFlush 中断预算
    // 循环，大残余（>16KB）时 isFinal 帧永不到达（P2-1 截断根因）。buffer 已
    // finalMarked，后续 push 被拒绝，预算循环至多 N 帧自然收口于 isFinal 帧。
    stopBuf?.flushFinal();
    flushStreamBatchers();
    const st = getCompositionRoot().layout.getState();
    if (getSessionById(sid)?.goalMode?.active) {
      streamManagerRef.current!.markGoalCancelled(sid);
      patchSession(sid, { goalMode: null });
    }
    // Persist partial stream text only（禁止把「已停止」等系统句写入气泡）
    // F1b（R2-4）：stopBuf.currentText() 优先——它 = fullText + pending.join('')
    // 恒为完整全文（大残余首帧同步刷入 ≤8KB 后剩余仍在 pending 中）；
    // getStreamText 是「停止前最后一帧」写入的陈旧截断值，降为兜底（P2-1 截断根因）。
    const stopBufFull = stopBuf?.currentText() ?? '';
    const partialText =
      stopBufFull ||
      getStreamText(sid, cur.assistantMsgId) ||
      getSessionById(sid)?.messages.find(
        (m: SessionMessage) => m.id === cur.assistantMsgId
      )?.text ||
      '';
    const stopText = (partialText || '').trim();
    commitStreamToolsToSession(sid, cur.assistantMsgId);
    if (stopText) {
      commitStreamToSession(sid, cur.assistantMsgId, { text: stopText });
      // F1d（R2-4）：截断防御断言——commit 文本不得短于 buffer 完整终稿，
      // 正常路径恒等，为将来任何 drain 回归的哨兵
      if (stopBufFull && stopText.length < stopBufFull.length) {
        console.warn(
          `[crish-desktop][stop-truncation] stop 终稿截断：committed=${stopText.length} buffered=${stopBufFull.length}`
        );
        recordStreamDiag({
          kind: 'stop-truncation',
          scope: 'chat-stream',
          message: `stop 终稿截断 committed=${stopText.length} buffered=${stopBufFull.length}`,
        });
      }
    } else {
      // 无正文：清空占位，用横幅提示停止（不写 assistant 正文）
      st.updateMessageText(sid, cur.assistantMsgId, '');
      clearStream(sid, cur.assistantMsgId);
      pushRunNotice(
        {
          text: force ? '已强制停止本轮生成。' : '已停止本轮生成。',
          kind: 'ended',
        },
        5000
      );
    }
    const asst = getSessionById(sid)?.messages.find(
      (m: SessionMessage) => m.id === cur.assistantMsgId
    );
    st.setSessionMessageStatus(sid, cur.userMsgId, 'completed');
    st.setSessionMessageStatus(sid, cur.assistantMsgId, 'completed');
    if (stopText) {
      scheduleFinalMarkdownHtml(sid, cur.assistantMsgId, stopText);
    }
    const stopPatches = buildTerminalToolPatches(asst?.toolCalls, 'stop');
    if (stopPatches.length) {
      // T-E 步骤 3（U5）：raw setState → applyToolCallPatches action（批量终态）
      getCompositionRoot()
        .layout.getState()
        .applyToolCallPatches(sid, cur.assistantMsgId, stopPatches);
    }
    void (async () => {
      try {
        const sess = getSessionById(sid);
        const userTxt =
          sess?.messages.find((m: SessionMessage) => m.id === cur.userMsgId)
            ?.text || '';
        const asstTxt = asst?.text || stopText || '';
        if (!userTxt && !asstTxt) return;
        const { estimateCostUsd } = await import('../../api/pricingStore');
        const approxIn = Math.max(1, Math.ceil(userTxt.length / 4));
        const approxOut = Math.max(0, Math.ceil(asstTxt.length / 4));
        const model = getActiveModelId() || 'unknown';
        const dCost = estimateCostUsd(model, approxIn, approxOut);
        // F5 P2 修复：stop 兜底路径走串行化合并（并发不丢增量）；
        // D4 收敛：历史流水委托内建（同上）
        accumulateTokenUsage({
          input: approxIn,
          output: approxOut,
          cost: dCost,
          model,
        });
      } catch {
        /* ignore */
      }
    })();
    // L2/L3 wire：shared helper（chat has live cancel; no runId double-dispatch）
    dispatchStreamStopCancel({ force, cancel: cur.cancel });
  };

  /** 默认 Stop = L2 cooperative_stop */
  const handleStopGeneration = () => {
    finalizeStopGeneration(false);
  };

  /** 强制取消 = L3 force_cancel（UI 应二次确认） */
  const handleForceCancelGeneration = () => {
    finalizeStopGeneration(true);
  };

  return {
    runStreamingAssistant,
    handleStopGeneration,
    handleForceCancelGeneration,
  };
}
