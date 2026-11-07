// 会话内继续对话：发送 runTask（固定 sessionId），维护输入 / busy / 错误。
// 权限档（G1）：提交时刻读 settingsStore 的 composer 偏好，经
// domain/pure/permissionMode 单点映射申报（与桌面三档口径一致，不写死 ask）。
// 草稿键控（批 C ②）：输入稿按 `remote:<sessionId>` 键存入
// composerDraftStore——切会话不串稿、杀进程后经 loadComposerDraft
// 回填；受理即清该会话草稿（clearPrompt 单点收敛两个受理路径）。
// R5 受理与 ACK 分离：本地校验通过即受理——快照锁定草稿/附件、立即清可视
// 输入、立即 pending 回显（onPending）；仓储回执（ACK）与失败（reject）
// 各自回调，等待与受理明确分离；失败按「输入是否被新写」恢复快照或保留
// 新稿，不假 runId/sessionId、不提前宣称服务器成功。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/adapters/hooks/useAppStore';
import { selectEffectiveChatMode } from '@/domain/store/connectionStore';
import { haptics } from '@/adapters/platform/haptics';
import { settingsStore } from '@/domain/store/settingsStore';
import { runPermissionMode } from '@/domain/pure/permissionMode';
import {
  getQuickRunContext,
  RUN_TASK_ERROR_INTERNAL,
  runTaskErrorTextOf,
  RunTaskCommandError,
  remoteControlFacade,
} from '@/adapters/RemoteControlFacade';
import {
  buildRunPayload,
  checkRunPayloadSizes,
  type ComposerAttachment,
} from '@/domain/pure/attachments';
import {
  loadComposerDraft,
  peekComposerDraft,
  saveComposerDraft,
} from '@/domain/store/composerDraftStore';
import { filesStore } from '@/domain/store/filesStore';
import type { RunTaskParams } from '@crish/shared-types';

export interface SessionComposerFeedback {
  kind: 'idle' | 'sending' | 'error' | 'success';
  message: string | null;
}

/** 发送回调组（R5 受理/ACK/失败三段分离；pendingId 为本地受理标识，非 runId） */
export interface SessionComposerSend {
  /**
   * 受理回调：本地校验通过、即将调用仓储时立即触发一次（早于任何网络
   * 回执）。宿主据此立即追加 pending 回显；快照文本随行。
   */
  onPending?: (pendingId: string, text: string) => void;
  /**
   * ACK 回调：仓储受理成功。runId 为服务器真实回执（不伪造）；
   * isDraft 受理路径创建新会话时带 createdSessionId。
   */
  onAcked?: (
    pendingId: string,
    runId: string,
    createdSessionId?: string
  ) => void;
  /**
   * 失败回调：restoredToInput=true 表示等待期间输入未被新写、快照已恢复
   * 进输入框（pending 回显可撤）；false 表示用户新稿保留、快照文本随行
   * （宿主保留失败回显供手动重发）。attachments 为受理时附件快照。
   */
  onFailed?: (
    pendingId: string,
    info: {
      restoredToInput: boolean;
      text: string;
      attachments: readonly ComposerAttachment[];
    }
  ) => void;
  /** 新建会话（isDraft 受理路径 ACK 后切会话） */
  onSessionCreated?: (createdSessionId: string) => void;
}

export interface SessionComposerVm {
  /** 远端会话管线是否可用（CON-2：中央派生反推；本页恒为远程会话，断线只禁用本管线并由页面给出本地出路，不在此切换模式） */
  connected: boolean;
  prompt: string;
  busy: boolean;
  feedback: SessionComposerFeedback;
  canSubmit: boolean;
  setPrompt: (text: string) => void;
  /**
   * 提交（R5 口径）：返回 true = 已受理（可视输入已清、pending 已回显，
   * ACK/失败由回调异步送达）；false = 未受理（校验/守卫拒绝，状态不变）。
   */
  submit: () => Promise<boolean>;
  /** 以显式文本提交（语音输入松开直发：回填与提交同刻发生，不能依赖 prompt 状态时序） */
  submitText: (text: string) => Promise<boolean>;
  /**
   * 带附件提交（G5b）：以显式文本 + 已选附件组装 content/prompt 附件块
   * （显式文本口径同 submitText：语音直发时回填与提交同刻，不依赖输入
   * 状态时序），发送前总量预检（超限反馈并返回 false，不调仓储）。
   * 附件为空时等价 submitText。返回 true 时宿主清空已选区；false 保留。
   */
  submitWithAttachments: (
    rawText: string,
    attachments: readonly ComposerAttachment[],
    visionSupported: boolean
  ) => Promise<boolean>;
}

export function useSessionComposer(
  sessionId: string | null,
  send?: SessionComposerSend
): SessionComposerVm {
  const connected = useConnectionStore(
    (s) => selectEffectiveChatMode(s.phase) === 'remote'
  );
  const draftKey = `remote:${sessionId || 'draft'}`;
  const [prompt, setPromptState] = useState(() => peekComposerDraft(draftKey));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<SessionComposerFeedback>({
    kind: 'idle',
    message: null,
  });
  const busyRef = useRef(false);
  // 用户已在本会话键入 → 迟到的持久回填不得覆盖（loadComposerDraft
  // 的内存优先只防跨挂载竞态，本 ref 防同挂载内时序）
  const touchedRef = useRef(false);
  // R5：受理→结算窗口内输入是否被新写（失败恢复判据：未被新写才恢复快照）
  const typedDuringWaitRef = useRef(false);
  // 受理标识计数（本地单调，非 runId/sessionId 语义）
  const pendingSeqRef = useRef(0);
  // 卸载守卫：迟到回执不触碰已卸载 VM 的状态（回调仍送达宿主，状态面跳过）
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 持久草稿回填（挂载一次）：内存面已有（含上次挂载残留）时首帧
  // 即命中，本回填只补「冷启动后首次进本会话」的落盘稿。
  useEffect(() => {
    let cancelled = false;
    void loadComposerDraft(draftKey).then((draft) => {
      if (cancelled || touchedRef.current || draft === '') return;
      setPromptState(draft);
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  const setPrompt = useCallback(
    (text: string) => {
      touchedRef.current = true;
      typedDuringWaitRef.current = true;
      setPromptState(text);
      saveComposerDraft(draftKey, text);
      setFeedback((current) =>
        current.kind === 'error' ? { kind: 'idle', message: null } : current
      );
    },
    [draftKey]
  );

  /** 受理清稿（状态 + 键控草稿一并清，两个受理路径共用） */
  const clearPrompt = useCallback(() => {
    setPromptState('');
    saveComposerDraft(draftKey, '');
  }, [draftKey]);

  /**
   * 失败恢复（R5）：等待期间输入未被新写 → 快照文本恢复进输入框与落盘稿
   * （可重试），restoredToInput=true；已被新写 → 新稿原样保留（绝不覆盖），
   * 快照文本经 onFailed 随行给宿主保留失败回显。
   */
  const settleFailure = useCallback(
    (
      pendingId: string,
      snapshot: { text: string; attachments: readonly ComposerAttachment[] },
      code: string
    ): boolean => {
      const restored = !typedDuringWaitRef.current;
      if (restored) {
        setPromptState(snapshot.text);
        saveComposerDraft(draftKey, snapshot.text);
        typedDuringWaitRef.current = false;
      }
      // R6 失败语义触觉：一次发送至多一次触感——受理 tap 已发，失败以
      // failure 收尾（不再叠加成功触感，不在失败前宣称 success）
      haptics.failure();
      setFeedback({ kind: 'error', message: runTaskErrorTextOf(code) });
      send?.onFailed?.(pendingId, {
        restoredToInput: restored,
        text: snapshot.text,
        attachments: snapshot.attachments,
      });
      return false;
    },
    [draftKey, send]
  );

  const submitWithText = useCallback(
    async (rawText: string): Promise<boolean> => {
      const text = rawText.trim();
      if (busyRef.current || !connected || text.length === 0) return false;
      if (!remoteControlFacade.isAvailable() && !getQuickRunContext()) {
        setFeedback({
          kind: 'error',
          message: runTaskErrorTextOf('transport.closed'),
        });
        return false;
      }
      const pendingId = `pending-${++pendingSeqRef.current}`;
      // R5 受理点：快照锁定 + 立即清可视输入 + 立即 pending 回显
      const snapshot = { text, attachments: [] as readonly ComposerAttachment[] };
      typedDuringWaitRef.current = false;
      busyRef.current = true;
      setBusy(true);
      setFeedback({ kind: 'sending', message: null });
      clearPrompt();
      // R6 发送只震一次：受理语义触觉在受理点发声（Composer 按压处不再
      // 叠加 tap）；ACK 不再叠加 success（受理触觉即本次发送的唯一触感）
      haptics.tap();
      send?.onPending?.(pendingId, snapshot.text);
      try {
        const isDraft = !sessionId || sessionId === 'draft';
        const cwd = filesStore.getState().activeWorkspaceRoot || undefined;
        const context = getQuickRunContext();
        const runner =
          context?.repository?.runTask ??
          remoteControlFacade.runTask.bind(remoteControlFacade);
        const result = await runner({
          prompt: text,
          ...(isDraft ? {} : { sessionId }),
          permissionMode: runPermissionMode(
            settingsStore.getState().get('composer').permissionMode
          ),
          ...(cwd ? { cwd } : {}),
        });
        if (aliveRef.current) {
          setFeedback({ kind: 'success', message: null });
        }
        send?.onAcked?.(
          pendingId,
          result.runId,
          isDraft ? result.sessionId : undefined
        );
        if (isDraft && result.sessionId) {
          send?.onSessionCreated?.(result.sessionId);
        }
        return true;
      } catch (error) {
        const code =
          error instanceof RunTaskCommandError
            ? error.code
            : RUN_TASK_ERROR_INTERNAL;
        return settleFailure(pendingId, snapshot, code);
      } finally {
        busyRef.current = false;
        if (aliveRef.current) setBusy(false);
      }
    },
    [connected, sessionId, clearPrompt, send, settleFailure]
  );

  const submitWithAttachments = useCallback(
    async (
      rawText: string,
      attachments: readonly ComposerAttachment[],
      visionSupported: boolean
    ): Promise<boolean> => {
      if (attachments.length === 0) return submitWithText(rawText);
      if (busyRef.current || !connected) return false;
      const payload = buildRunPayload(rawText, attachments, visionSupported);
      if (!payload) return submitWithText(rawText);
      // 发送前预检（与网关钳制同口径）：超限直接拦截，不送达网关才失败
      const sizeCheck = checkRunPayloadSizes(payload);
      if (!sizeCheck.ok) {
        setFeedback({ kind: 'error', message: sizeCheck.message });
        return false;
      }
      if (!remoteControlFacade.isAvailable() && !getQuickRunContext()) {
        setFeedback({
          kind: 'error',
          message: runTaskErrorTextOf('transport.closed'),
        });
        return false;
      }
      const pendingId = `pending-${++pendingSeqRef.current}`;
      // R5 受理点：附件随文本一并快照锁定（失败恢复依据）
      const snapshot = { text: rawText.trim(), attachments };
      typedDuringWaitRef.current = false;
      busyRef.current = true;
      setBusy(true);
      setFeedback({ kind: 'sending', message: null });
      clearPrompt();
      // R6 发送只震一次：受理语义触觉在受理点发声（同文本路径）
      haptics.tap();
      send?.onPending?.(pendingId, snapshot.text);
      try {
        const isDraft = !sessionId || sessionId === 'draft';
        const cwd = filesStore.getState().activeWorkspaceRoot || undefined;
        const context = getQuickRunContext();
        const runner =
          context?.repository?.runTask ??
          remoteControlFacade.runTask.bind(remoteControlFacade);
        const result = await runner({
          prompt: payload.prompt,
          ...(isDraft ? {} : { sessionId }),
          permissionMode: runPermissionMode(
            settingsStore.getState().get('composer').permissionMode
          ),
          content: payload.content as unknown as NonNullable<
            RunTaskParams['content']
          >,
          hasImages: payload.hasImages,
          ...(cwd ? { cwd } : {}),
        });
        if (aliveRef.current) {
          setFeedback({ kind: 'success', message: null });
        }
        send?.onAcked?.(
          pendingId,
          result.runId,
          isDraft ? result.sessionId : undefined
        );
        if (isDraft && result.sessionId) {
          send?.onSessionCreated?.(result.sessionId);
        }
        return true;
      } catch (error) {
        const code =
          error instanceof RunTaskCommandError
            ? error.code
            : RUN_TASK_ERROR_INTERNAL;
        return settleFailure(pendingId, snapshot, code);
      } finally {
        busyRef.current = false;
        if (aliveRef.current) setBusy(false);
      }
    },
    [connected, sessionId, submitWithText, clearPrompt, send, settleFailure]
  );

  const submit = useCallback(
    (): Promise<boolean> => submitWithText(prompt),
    [submitWithText, prompt]
  );

  return {
    connected,
    prompt,
    busy,
    feedback,
    canSubmit: connected && !busy && prompt.trim().length > 0,
    setPrompt,
    submit,
    submitText: submitWithText,
    submitWithAttachments,
  };
}
