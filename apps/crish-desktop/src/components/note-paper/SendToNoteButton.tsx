/**
 * SendToNoteButton — 「发送到笔记」UI 钩子（W5-B · B-05/B-08 · Round6/8）
 *
 * - 仅 status === 'completed' 可点
 * - 点击调用 bridges/send-to-note 薄桥
 * - 展示错误态；失败不假装已写树
 * - 禁止流式 onStreamEnd 默认写笔记
 * - 写路径优先级：
 *   1. 显式 `sink`（单测 mock）
 *   2. 显式 `transport` prop
 *   3. 模块 `setDefaultNoteTransport` / 桥 `resolveNoteTransport`
 *   4. `createDefaultNoteTransport()`：Tauri 壳 → 真 `note_*` 命令；无 Tauri → Memory
 *
 * 产品桌面默认走真 Tauri note 通路；单测仍应 inject Memory / sink，避免依赖壳。
 */

import React, { useCallback, useState } from 'react';

import { Button, Tooltip } from '../ui';
import type { NoteTransport } from '../../api/noteApi';
import {
  dispatchSendToNote,
  type BuildSendToNoteInput,
  type SendToNoteResult,
  type SendToNoteSink,
} from '../../bridges/send-to-note';
import styles from './NotePaperPanel.module.css';
import { AppIcon } from '../ui/icons/index';

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
  /**
   * 写路径 sink（mock / 测试）。
   * 与 `transport` 同时存在时 **sink 优先**。
   * 皆缺省 → 桥走 `resolveNoteTransport`（模块默认 / `createDefaultNoteTransport`）。
   */
  sink?: SendToNoteSink;
  /**
   * 笔记通路。产品可省略（默认 Tauri note 命令）；
   * 单测请 inject `createMemoryNoteTransport()`。
   */
  transport?: NoteTransport;
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
  /** 纯图标按钮模式（嵌入消息操作栏） */
  iconOnly?: boolean;
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
  transport,
  intentId,
  origin = 'user',
  onSuccess,
  onError,
  className,
  label = '发送到笔记',
  iconOnly = false,
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

      const result = sink
        ? await dispatchSendToNote(input, sink, {
            streamStatus: status,
            transport,
          })
        : await dispatchSendToNote(input, {
            streamStatus: status,
            transport,
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
    transport,
    intentId,
    origin,
    status,
    onSuccess,
    onError,
  ]);

  if (iconOnly) {
    return (
      <div
        data-testid="send-to-note-root"
        data-status={String(status ?? '')}
        data-can-send={canSend ? 'true' : 'false'}
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        <Tooltip content={lastOk ? '已发送到笔记' : errorText || label}>
          <button
            type="button"
            disabled={!canSend || busy}
            onClick={() => {
              void handleClick();
            }}
            aria-label={label}
            data-testid="send-to-note-button"
            className={className}
          >
            {lastOk ? (
              <AppIcon name="check" size={13} aria-hidden />
            ) : (
              <AppIcon name="square-pen" size={13} aria-hidden />
            )}
          </button>
        </Tooltip>
      </div>
    );
  }

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
        icon={<AppIcon name="square-pen" size={14} aria-hidden />}
      >
        {label}
      </Button>
      {errorText ? (
        <div
          role="alert"
          data-testid="send-to-note-error"
          className={styles.feedbackError}
        >
          {errorText}
        </div>
      ) : null}
      {lastOk && !errorText ? (
        <div
          role="status"
          data-testid="send-to-note-success"
          className={styles.feedbackOk}
        >
          已发送到笔记
        </div>
      ) : null}
    </div>
  );
};

export default SendToNoteButton;
