/**
 * 发送 / 排队 / 停止（L2 协作 · L3 强制取消）。
 * 主对话卡片使用墨绿色实体圆形发送按钮（32x32px 正圆，var(--brand)，Hover #059669，白色上箭头，200ms Spring 展开/收缩）；
 * 侧栏 ComposerField / 兜底模式回落至盒内回车折角按钮。
 */
import React, { useCallback, useEffect, useRef } from 'react';

import styles from './ChatComposer.module.css';
import { Button, ConfirmDialog, Tooltip } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import { useI18n } from '../../i18n';
import { AppIcon } from '../ui/icons/index';

export const STOP_TOOLTIP = '停止生成（协作停止）。Shift+点击或长按：强制取消';
export const STOP_ARIA_LABEL =
  '停止生成（协作停止）。Shift+点击或长按可强制取消';
export const FORCE_CANCEL_CONFIRM =
  '强制取消将立即中断模型与工具，未完成结果可能丢失。确定强制取消？';
export const FORCE_STOP_LONG_PRESS_MS = 550;

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
    run();
    return true;
  }, [onForceStop, onStop, confirmGate, t]);

  const handleStopClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onStop) return;
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
      onStop();
    },
    [onStop, invokeForceStop]
  );

  const handleStopPointerDown = useCallback(() => {
    if (!onStop) return;
    longPressFiredRef.current = false;
    clearLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      void invokeForceStop().then((fired) => {
        if (fired) longPressFiredRef.current = true;
      });
    }, FORCE_STOP_LONG_PRESS_MS);
  }, [onStop, clearLongPress, invokeForceStop]);

  const trySend = useCallback(() => {
    if (disabled || !canSend) return;
    onSend();
  }, [disabled, canSend, onSend]);

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

  const stopBtn = onStop ? (
    <Tooltip content={stopTooltip}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`${styles.stop} ${appearance === 'circle' ? styles.stopCircleBtn : ''}`}
        data-testid="composer-stop"
        data-stop-level="l2"
        aria-label={stopAria}
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
      <div className={styles.buttons} data-composer-send={appearance}>
        {isProcessing ? (
          <>
            <Tooltip content={sendTitle}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={styles.queue}
                aria-label={sendAria}
                onClick={trySend}
                disabled={sendDisabled}
              >
                {resolvedQueueLabel}
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
              className={`${styles.sendBtnCircle} ${styles.sendCircle} send-btn-circle ${sendDisabled ? '' : `${styles.active} active`}`}
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
              className={styles.sendBtn}
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
