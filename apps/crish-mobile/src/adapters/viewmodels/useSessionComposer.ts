// 会话内继续对话：发送 runTask（固定 sessionId），维护输入 / busy / 错误。
// 权限档（G1）：提交时刻读 settingsStore 的 composer 偏好，经
// domain/pure/permissionMode 单点映射申报（与桌面三档口径一致，不写死 ask）。
import { useCallback, useRef, useState } from 'react';
import { useConnectionStore } from '@/adapters/hooks/useAppStore';
import { settingsStore } from '@/domain/store/settingsStore';
import { runPermissionMode } from '@/domain/pure/permissionMode';
import {
  getQuickRunContext,
  RUN_TASK_ERROR_INTERNAL,
  runTaskErrorTextOf,
  RunTaskCommandError,
} from '@/adapters/quickRunWiring';
import {
  buildRunPayload,
  checkRunPayloadSizes,
  type ComposerAttachment,
} from '@/domain/pure/attachments';
import type { RunTaskParams } from '@crish/shared-types';

export interface SessionComposerFeedback {
  kind: 'idle' | 'sending' | 'error' | 'success';
  message: string | null;
}

export interface SessionComposerVm {
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
  sessionId: string,
  onSent?: (prompt: string, runId: string) => void
): SessionComposerVm {
  const connected = useConnectionStore((s) => s.phase === 'ready');
  const [prompt, setPromptState] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<SessionComposerFeedback>({
    kind: 'idle',
    message: null,
  });
  const busyRef = useRef(false);

  const setPrompt = useCallback((text: string) => {
    setPromptState(text);
    setFeedback((current) =>
      current.kind === 'error' ? { kind: 'idle', message: null } : current
    );
  }, []);

  const submitWithText = useCallback(
    async (rawText: string): Promise<boolean> => {
      const text = rawText.trim();
      if (busyRef.current || !connected || text.length === 0) return false;
      const context = getQuickRunContext();
      if (!context) {
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
        const result = await context.repository.runTask({
          prompt: text,
          sessionId,
          permissionMode: runPermissionMode(
            settingsStore.getState().get('composer').permissionMode
          ),
        });
        setPromptState('');
        setFeedback({ kind: 'success', message: null });
        onSent?.(text, result.runId);
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
    [connected, onSent, sessionId]
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
      const context = getQuickRunContext();
      if (!context) {
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
        const result = await context.repository.runTask({
          prompt: payload.prompt,
          sessionId,
          permissionMode: runPermissionMode(
            settingsStore.getState().get('composer').permissionMode
          ),
          content: payload.content as unknown as NonNullable<
            RunTaskParams['content']
          >,
          hasImages: payload.hasImages,
        });
        setPromptState('');
        setFeedback({ kind: 'success', message: null });
        // 本地 echo 只回显用户键入的文本：纯附件发送无文本可回显，
        // 消息经事件流落窗（附件块正文即 prompt，回显会与流内消息重复）
        const text = rawText.trim();
        if (text.length > 0) onSent?.(text, result.runId);
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
    [connected, onSent, sessionId, submitWithText]
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
