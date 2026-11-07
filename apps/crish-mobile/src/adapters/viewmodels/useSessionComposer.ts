// 会话内继续对话：发送 runTask（固定 sessionId），维护输入 / busy / 错误。
// 权限档（G1）：提交时刻读 settingsStore 的 composer 偏好，经
// domain/pure/permissionMode 单点映射申报（与桌面三档口径一致，不写死 ask）。
// 草稿键控（批 C ②）：输入稿按 `remote:<sessionId>` 键存入
// composerDraftStore——切会话不串稿、杀进程后经 loadComposerDraft
// 回填；发送成功即清该会话草稿（clearPrompt 单点收敛两个成功路径）。
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

export interface SessionComposerVm {
  /** 远端会话管线是否可用（CON-2：中央派生反推；本页恒为远程会话，断线只禁用本管线并由页面给出本地出路，不在此切换模式） */
  connected: boolean;
  prompt: string;
  busy: boolean;
  feedback: SessionComposerFeedback;
  canSubmit: boolean;
  setPrompt: (text: string) => void;
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
  onSent?: (prompt: string, runId: string, createdSessionId?: string) => void
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
      setPromptState(text);
      saveComposerDraft(draftKey, text);
      setFeedback((current) =>
        current.kind === 'error' ? { kind: 'idle', message: null } : current
      );
    },
    [draftKey]
  );

  /** 发送成功清稿（状态 + 键控草稿一并清，两个成功路径共用） */
  const clearPrompt = useCallback(() => {
    setPromptState('');
    saveComposerDraft(draftKey, '');
  }, [draftKey]);

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
      busyRef.current = true;
      setBusy(true);
      setFeedback({ kind: 'sending', message: null });
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
        clearPrompt();
        // 发送被受理 → 成功触感与成功反馈同帧（触觉门面，手感基建批）
        haptics.success();
        setFeedback({ kind: 'success', message: null });
        if (isDraft) {
          onSent?.(text, result.runId, result.sessionId);
        } else {
          onSent?.(text, result.runId);
        }
        return true;
      } catch (error) {
        const code =
          error instanceof RunTaskCommandError
            ? error.code
            : RUN_TASK_ERROR_INTERNAL;
        setFeedback({ kind: 'error', message: runTaskErrorTextOf(code) });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [connected, onSent, sessionId, clearPrompt]
  );

  const submit = useCallback(
    (): Promise<boolean> => submitWithText(prompt),
    [submitWithText, prompt]
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
      busyRef.current = true;
      setBusy(true);
      setFeedback({ kind: 'sending', message: null });
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
        clearPrompt();
        // 发送被受理 → 成功触感与成功反馈同帧（触觉门面，手感基建批）
        haptics.success();
        setFeedback({ kind: 'success', message: null });
        // 本地 echo 只回显用户键入的文本：纯附件发送无文本可回显，
        // 消息经事件流落窗（附件块正文即 prompt，回显会与流内消息重复）
        const text = rawText.trim();
        if (text.length > 0) {
          if (isDraft) {
            onSent?.(text, result.runId, result.sessionId);
          } else {
            onSent?.(text, result.runId);
          }
        }
        return true;
      } catch (error) {
        const code =
          error instanceof RunTaskCommandError
            ? error.code
            : RUN_TASK_ERROR_INTERNAL;
        setFeedback({ kind: 'error', message: runTaskErrorTextOf(code) });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [connected, onSent, sessionId, submitWithText, clearPrompt]
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
