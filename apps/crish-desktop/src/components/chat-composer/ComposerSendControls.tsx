/**
 * 发送 / 排队 / 停止（L2 协作 · L3 强制取消）。
 * 主对话卡片使用墨绿色实体圆形发送按钮（28x28px 正圆常驻，var(--brand)，Hover var(--brand-deep)，disabled 态 0.38 透明度）；
 * 侧栏 ComposerField / 兜底模式回落至盒内回车折角按钮。
 * 停止乐观态（X3）：点停止同帧进入「正在停止…」呈现；收敛只认既有状态源
 * isProcessing 退出；超时未收敛则回滚并 toast 反馈（见 STOP_CONVERGE_TIMEOUT_MS）。
 * 全部 composer 表面（ComposerField / TiptapComposerField / ChatComposer 主面 /
 * AgentCard）都经本组件渲染停止钮，故乐观态在此一处归一。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

import styles from './ComposerSendControls.module.css';
import { Button, ConfirmDialog, Tooltip } from '@/components/ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import { useI18n } from '../../i18n';
import { toast } from '../../services/toast/ToastContext';
import { AppIcon } from '@/components/ui/icons';

export const STOP_TOOLTIP = '停止生成（协作停止）。Shift+点击或长按：强制取消';
export const STOP_ARIA_LABEL =
  '停止生成（协作停止）。Shift+点击或长按可强制取消';
export const FORCE_CANCEL_CONFIRM =
  '强制取消将立即中断模型与工具，未完成结果可能丢失。确定强制取消？';
export const FORCE_STOP_LONG_PRESS_MS = 550;

/**
 * 停止收敛兜底（ms）：乐观 stopping 态的回滚上限。
 * 收敛信号只消费既有状态源 isProcessing（会话退出 processing）：两条生产停止
 * 路径（主聊天 finalizeStopGeneration / 子 agent finalizeAgentStop）都在点击
 * 处理内同步收口本地 store，正常收敛在一帧内。系统内最慢的周期性收敛机制是
 * 子 agent 守护状态同步轮询（useAgentStream.startStatusSync，4000ms），5000
 * 在其上留余量；又远小于工具转后台门槛（20s），不会把假等待拉长。
 * 超时仍未收敛 ⇒ 判定停止未生效：回滚乐观态 + toast 反馈，绝不永久停在 stopping。
 */
export const STOP_CONVERGE_TIMEOUT_MS = 5000;

export type ComposerSendAppearance = 'field' | 'circle';

export type ComposerSendControlsProps = {
  canSend: boolean;
  disabled?: boolean | undefined;
  isProcessing?: boolean | undefined;
  onSend: () => void;
  onStop?: (() => void) | undefined;
  onForceStop?: (() => void) | undefined;
  processingSendLabel?: string | undefined;
  appearance?: ComposerSendAppearance;
};

export const ComposerSendControls: React.FC<ComposerSendControlsProps> = ({
  canSend,
  disabled,
  isProcessing,
  onSend,
  onStop,
  onForceStop,
  processingSendLabel = '排队',
  appearance = 'field',
}) => {
  const { t } = useI18n();
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const [confirmGate, renderConfirmGate] = useConfirmGate();
  // 停止乐观态：点击同帧置位；isProcessing 退出即收敛；超时未收敛回滚（见下两 effect）
  const [stopRequested, setStopRequested] = useState(false);
  const stopping = stopRequested && Boolean(isProcessing);

  // 收敛：引擎确认停止后，会话状态退出 processing（既有状态源）→ 清乐观态，
  // 终态呈现由既有渲染分支接管；同时保证下一轮运行不会继承残留 stopping。
  useEffect(() => {
    if (!isProcessing && stopRequested) setStopRequested(false);
  }, [isProcessing, stopRequested]);

  // 兜底回滚：STOP_CONVERGE_TIMEOUT_MS 内仍未收敛 ⇒ 停止未生效，
  // 回滚乐观态（停止钮恢复可点）并 toast 反馈，不许永远停在 stopping。
  useEffect(() => {
    if (!stopRequested) return;
    const id = setTimeout(() => {
      setStopRequested(false);
      toast.show(t('chat.composer.stop.stoppingTimeout'), { type: 'error' });
    }, STOP_CONVERGE_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [stopRequested, t]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  const invokeForceStop = useCallback(async (): Promise<boolean> => {
    const run = onForceStop ?? onStop;
    if (!run) return false;
    const ok = await confirmGate({
      title: t('chat.composer.stop.forceConfirmTitle'),
      description: t('chat.composer.stop.forceConfirmDesc'),
      confirmLabel: t('chat.composer.stop.forceConfirmBtn'),
      danger: true,
    });
    if (!ok) return false;
    setStopRequested(true);
    run();
    return true;
  }, [onForceStop, onStop, confirmGate, t]);

  const handleStopClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onStop || stopping) return;
      if (longPressFiredRef.current) {
        longPressFiredRef.current = false;
        e.preventDefault();
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        void invokeForceStop();
        return;
      }
      // 乐观置位先行：与 onStop 同一事件内提交，本帧即呈现「正在停止…」
      setStopRequested(true);
      onStop();
    },
    [onStop, invokeForceStop, stopping]
  );

  const handleStopPointerDown = useCallback(() => {
    if (!onStop || stopping) return;
    longPressFiredRef.current = false;
    clearLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      void invokeForceStop().then((fired) => {
        if (fired) longPressFiredRef.current = true;
      });
    }, FORCE_STOP_LONG_PRESS_MS);
  }, [onStop, clearLongPress, invokeForceStop, stopping]);

  const trySend = useCallback(() => {
    // stopping 期间禁止排队/追加：本轮正在收敛，新发送不得与停止竞态
    if (disabled || !canSend || stopping) return;
    onSend();
  }, [disabled, canSend, onSend, stopping]);

  const resolvedQueueLabel =
    processingSendLabel === '排队'
      ? t('chat.composer.queue')
      : processingSendLabel;

  const sendDisabled = !canSend || Boolean(disabled);
  const sendTitle = sendDisabled
    ? isProcessing
      ? t('chat.composer.sendDisabledProcessing')
      : t('chat.composer.sendDisabledNormal')
    : isProcessing
      ? processingSendLabel === '排队'
        ? t('chat.composer.queueTooltip')
        : t('chat.composer.appendTooltip')
      : t('chat.composer.sendTooltip');
  const sendAria = sendDisabled
    ? isProcessing
      ? t('chat.composer.cannotQueue')
      : t('chat.composer.cannotSend')
    : isProcessing
      ? resolvedQueueLabel
      : t('chat.composer.send');

  const stopTooltip = t('chat.composer.stop.tooltip');
  const stopAria = t('chat.composer.stop.ariaLabel');
  const stoppingLabel = t('chat.composer.stop.stopping');
  // stopping 时：排队钮改文案为「正在停止…」并禁用（可见文本态），停止钮禁用并换 aria
  const queueLabel = stopping ? stoppingLabel : resolvedQueueLabel;
  const queueDisabled = sendDisabled || stopping;
  const queueTitle = stopping ? stoppingLabel : sendTitle;
  const queueAria = stopping ? stoppingLabel : sendAria;

  const stopBtn = onStop ? (
    <Tooltip content={stopping ? stoppingLabel : stopTooltip}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`${styles.stop} ${appearance === 'circle' ? styles.stopCircleBtn : ''}`}
        data-testid="composer-stop"
        data-stop-level="l2"
        data-stop-state={stopping ? 'stopping' : undefined}
        aria-label={stopping ? stoppingLabel : stopAria}
        disabled={stopping}
        onClick={handleStopClick}
        onPointerDown={handleStopPointerDown}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
        icon={
          <AppIcon name="square" size={14} fill="currentColor" aria-hidden />
        }
      />
    </Tooltip>
  ) : null;

  return (
    <>
      {renderConfirmGate(<ConfirmDialog />)}
      <div className={styles.sendControls} data-composer-send={appearance}>
        {isProcessing ? (
          <>
            <Tooltip content={queueTitle}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={styles.queue}
                aria-label={queueAria}
                onClick={trySend}
                disabled={queueDisabled}
              >
                {queueLabel}
              </Button>
            </Tooltip>
            {stopBtn}
          </>
        ) : appearance === 'circle' ? (
          <Tooltip content={sendTitle}>
            <Button
              type="button"
              variant="primary"
              size="md"
              className={`${styles.sendCircle} send-btn-circle ${sendDisabled ? '' : `${styles.active} active`}`}
              data-send-active={sendDisabled ? '0' : '1'}
              aria-label={sendAria}
              onClick={trySend}
              disabled={sendDisabled}
              loading={Boolean(disabled)}
              icon={<AppIcon name="arrow-up" size={16} aria-hidden />}
            />
          </Tooltip>
        ) : (
          <Tooltip content={sendTitle}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className={styles.fieldActionBtn}
              data-send-active={sendDisabled ? '0' : '1'}
              aria-label={sendAria}
              onClick={trySend}
              disabled={sendDisabled}
              loading={Boolean(disabled)}
              icon={<AppIcon name="corner-down-left" size={16} aria-hidden />}
            />
          </Tooltip>
        )}
      </div>
    </>
  );
};
