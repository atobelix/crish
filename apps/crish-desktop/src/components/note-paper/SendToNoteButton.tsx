/**
 * SendToNoteButton — 「发送到笔记」UI 钩子（W5-B · B-05/B-08）
 *
 * - 仅 status === 'completed' 可点
 * - 点击调用 bridges/send-to-note 薄桥
 * - 展示错误态；失败不假装已写树
 * - 禁止流式 onStreamEnd 默认写笔记
 */

import React, { useCallback, useState } from 'react';
import { NotebookPen } from 'lucide-react';
import { Button } from '../ui';
import {
  dispatchSendToNote,
  type BuildSendToNoteInput,
  type SendToNoteResult,
  type SendToNoteSink,
} from '../../bridges/send-to-note';

export type SendToNoteButtonProps = {
  /** 消息 id */
  messageId: string;
  /** 消息流状态；仅 completed 可点 */
  status: string | null | undefined;
  /**
   * 发送瞬间的 markdown **字符串**快照。
   * 禁止传入 lines 数组。
   */
  markdown: string;
  /** 目标笔记 docId */
  docId: string;
  /** 写路径 sink（产品注入 mock 或未来 RS IPC） */
  sink: SendToNoteSink;
  /** 幂等键；缺省由桥生成 */
  intentId?: string;
  origin?: 'user' | 'agent';
  /** 成功回调 */
  onSuccess?: (result: Extract<SendToNoteResult, { ok: true }>) => void;
  /** 失败回调 */
  onError?: (result: Extract<SendToNoteResult, { ok: false }>) => void;
  className?: string;
  /** 按钮文案 */
  label?: string;
};

/**
 * 完成态消息上的「发送到笔记」按钮。
 * 非 completed：disabled；点击后经桥派发 Intent。
 */
export const SendToNoteButton: React.FC<SendToNoteButtonProps> = ({
  messageId,
  status,
  markdown,
  docId,
  sink,
  intentId,
  origin = 'user',
  onSuccess,
  onError,
  className,
  label = '发送到笔记',
}) => {
  const canSend = status === 'completed';
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState(false);

  const handleClick = useCallback(async () => {
    setErrorText(null);
    setLastOk(false);

    if (!canSend) {
      const msg = '流未完成，无法发送到笔记';
      setErrorText(msg);
      onError?.({
        ok: false,
        intentId: intentId ?? '',
        code: 'stream_not_completed',
        reason: msg,
      });
      return;
    }

    setBusy(true);
    try {
      const input: BuildSendToNoteInput = {
        messageId,
        markdown,
        docId,
        origin,
      };
      if (intentId !== undefined) {
        input.intentId = intentId;
      }

      const result = await dispatchSendToNote(input, sink, {
        streamStatus: status,
      });

      if (result.ok) {
        setLastOk(true);
        setErrorText(null);
        onSuccess?.(result);
      } else {
        setLastOk(false);
        setErrorText(result.reason);
        onError?.(result);
      }
    } finally {
      setBusy(false);
    }
  }, [
    canSend,
    messageId,
    markdown,
    docId,
    sink,
    intentId,
    origin,
    status,
    onSuccess,
    onError,
  ]);

  return (
    <div
      className={className}
      data-testid="send-to-note-root"
      data-status={String(status ?? '')}
      data-can-send={canSend ? 'true' : 'false'}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!canSend || busy}
        loading={busy}
        onClick={() => {
          void handleClick();
        }}
        aria-label={label}
        data-testid="send-to-note-button"
        icon={<NotebookPen size={14} aria-hidden />}
      >
        {label}
      </Button>
      {errorText ? (
        <div
          role="alert"
          data-testid="send-to-note-error"
          style={{
            marginTop: 4,
            fontSize: 12,
            color: 'var(--danger, #f07178)',
          }}
        >
          {errorText}
        </div>
      ) : null}
      {lastOk && !errorText ? (
        <div
          role="status"
          data-testid="send-to-note-success"
          style={{
            marginTop: 4,
            fontSize: 12,
            color: 'var(--text-secondary, #9aa0a6)',
          }}
        >
          已发送到笔记
        </div>
      ) : null}
    </div>
  );
};

export default SendToNoteButton;
