/**
 * 后台任务操作面（T-AB-20）：kill 按钮（二次确认 + KillResult 三态反馈）与
 * send_input 输入框（默认追加换行，对齐 appendNewline 参数语义）。
 *
 * 依赖注入：onKill / onSendInput 由父组件（BgTaskCard）注入默认实现或测试桩，
 * 组件自身不直接触碰 Tauri 边界。
 */
import React, { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './BgTaskCard.module.css';
import {
  canCancelBackgroundTask,
  type BackgroundTaskInfo,
  type KillBackgroundTaskResult,
  type SendBackgroundTaskInputResult,
} from '../../api/backgroundTasksApi';
import {
  buildKillConfirmPrompt,
  formatKillResultFeedback,
  formatSendInputFeedback,
} from './bgTaskCardLib';

export type BgTaskActionsProps = {
  /** 任务（操作仅对活跃任务展示：queued / running） */
  task: Pick<BackgroundTaskInfo, 'id' | 'label' | 'state'>;
  /** 推荐输入（prompt 推断）；null 表示不预填 */
  recommendedInput?: string | null;
  /** kill 实现（缺省由 BgTaskCard 注入真实 API） */
  onKill?: (taskId: string) => Promise<KillBackgroundTaskResult | null>;
  /** send_input 实现（缺省由 BgTaskCard 注入真实 API） */
  onSendInput?: (
    taskId: string,
    text: string,
    appendNewline: boolean,
  ) => Promise<SendBackgroundTaskInputResult>;
  /** kill 成功后通知父组件（如本地状态翻转 / 列表刷新） */
  onKillApplied?: (result: KillBackgroundTaskResult) => void;
};

/** 默认占位实现：不执行任何副作用（测试直接注入桩，真实接线在卡片层） */
const noopKill = async (): Promise<KillBackgroundTaskResult | null> => null;
const noopSendInput = async (): Promise<SendBackgroundTaskInputResult> => ({
  ok: false,
  reason: 'invoke_failed',
});

export const BgTaskActions: React.FC<BgTaskActionsProps> = ({
  task,
  recommendedInput = null,
  onKill = noopKill,
  onSendInput = noopSendInput,
  onKillApplied,
}) => {
  const active = canCancelBackgroundTask(task);

  // ── kill 状态：二次确认 / 忙碌 / 三态反馈 ─────────────────────────
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'kill' | 'send' | null>(null);
  const [killResult, setKillResult] = useState<KillBackgroundTaskResult | null>(null);
  const [killAttempted, setKillAttempted] = useState(false);

  // ── send_input 状态：文本 / 追加换行开关 / 反馈 ──────────────────
  const [inputText, setInputText] = useState('');
  const [appendNewline, setAppendNewline] = useState(true);
  const [sendFeedback, setSendFeedback] = useState<'ok' | 'fail' | null>(null);

  // prompt 变化且输入为空时预填推荐输入（推荐失败则不打扰）
  useEffect(() => {
    if (recommendedInput) {
      setInputText((prev) => (prev === '' ? recommendedInput : prev));
    }
  }, [task.id, recommendedInput]);

  const startKill = () => {
    if (busy) return;
    setConfirming(true);
  };

  const cancelKill = () => {
    if (busy) return;
    setConfirming(false);
  };

  const confirmKill = async () => {
    if (busy) return;
    setBusy('kill');
    try {
      const res = await onKill(task.id);
      setKillResult(res);
      setKillAttempted(true);
      if (res && res.kind === 'killed') {
        onKillApplied?.(res);
      }
    } catch {
      // 桩 / 异常实现不应让界面卡死：按「终止失败」呈现
      setKillResult(null);
      setKillAttempted(true);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  const handleSend = async () => {
    if (busy) return;
    const text = inputText;
    if (!text.trim()) return;
    setBusy('send');
    try {
      const res = await onSendInput(task.id, text, appendNewline);
      setSendFeedback(res.ok ? 'ok' : 'fail');
      if (res.ok) setInputText('');
    } catch {
      setSendFeedback('fail');
    } finally {
      setBusy(null);
    }
  };

  // 非活跃任务不渲染操作面（终态展示在卡片主体：状态 / 退出码 / 日志）
  if (!active) return null;

  const killFeedback = killAttempted ? formatKillResultFeedback(killResult) : null;
  const busyAny = busy !== null;

  return (
    <div className={styles.actions} role="group" aria-label={`任务 ${task.id} 操作`}>
      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.killBtn}
          disabled={busyAny}
          onClick={startKill}
          aria-haspopup="dialog"
        >
          <Lucide.Square size={12} aria-hidden />
          终止任务
        </button>

        <div className={styles.inputRow}>
          <input
            className={styles.inputField}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={
              recommendedInput ? '输入回应（已预填推荐答案）' : '向任务 stdin 发送输入'
            }
            aria-label={`向任务 ${task.id} 发送输入`}
            disabled={busyAny}
          />
          <label className={styles.newlineToggle}>
            <input
              type="checkbox"
              checked={appendNewline}
              onChange={(e) => setAppendNewline(e.target.checked)}
              disabled={busyAny}
            />
            追加换行
          </label>
          <button
            type="button"
            className={styles.sendBtn}
            disabled={busyAny || !inputText.trim()}
            onClick={() => void handleSend()}
          >
            <Lucide.Send size={12} aria-hidden />
            发送
          </button>
        </div>
      </div>

      {confirming && (
        <div className={styles.confirmRow} role="alertdialog" aria-label="确认终止任务">
          <span className={styles.confirmText}>{buildKillConfirmPrompt(task)}</span>
          <span className={styles.confirmBtns}>
            <button
              type="button"
              className={styles.btnGhost}
              disabled={busyAny}
              onClick={cancelKill}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.btnDanger}
              disabled={busyAny}
              onClick={() => void confirmKill()}
            >
              确认终止
            </button>
          </span>
        </div>
      )}

      {killFeedback && (
        <div
          className={`${styles.feedback} ${
            killFeedback.tone === 'ok'
              ? styles.isOk
              : killFeedback.tone === 'info'
                ? styles.isInfo
                : styles.isError
          }`}
          role="status"
          aria-live="polite"
        >
          {killFeedback.text}
        </div>
      )}

      {sendFeedback && (
        <div
          className={`${styles.feedback} ${
            sendFeedback === 'ok' ? styles.isOk : styles.isError
          }`}
          role="status"
          aria-live="polite"
        >
          {formatSendInputFeedback(sendFeedback === 'ok')}
        </div>
      )}
    </div>
  );
};
