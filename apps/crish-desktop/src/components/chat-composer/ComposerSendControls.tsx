/**
 * 发送 / 排队 / 停止（L2 协作 · L3 强制取消）。
 * 主对话卡片用圆钮上箭头；侧栏 ComposerField 仍用盒内回车折角。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Button, ConfirmDialog, Tooltip } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';

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
      title: '强制取消',
      description: FORCE_CANCEL_CONFIRM,
      confirmLabel: '确认强制取消',
      danger: true,
    });
    if (!ok) return false;
    run();
    return true;
  }, [onForceStop, onStop, confirmGate]);

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

  const sendDisabled = !canSend || Boolean(disabled);
  const sendTitle = sendDisabled
    ? isProcessing
      ? '请输入要排队的消息'
      : '请输入消息或添加附件'
    : isProcessing
      ? processingSendLabel === '排队'
        ? '加入队列，当前回复结束后发送'
        : '发送补充指示'
      : '发送 (Enter)';
  const sendAria = sendDisabled
    ? isProcessing
      ? '无法排队：请先输入内容'
      : '无法发送：请输入消息或添加附件'
    : isProcessing
      ? processingSendLabel
      : '发送';

  const stopBtn = onStop ? (
    <Tooltip content={STOP_TOOLTIP}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="composer-stop"
        data-stop-level="l2"
        aria-label={STOP_ARIA_LABEL}
        onClick={handleStopClick}
        onPointerDown={handleStopPointerDown}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
        icon={<Lucide.Square size={16} fill="currentColor" aria-hidden />}
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
                aria-label={sendAria}
                onClick={trySend}
                disabled={sendDisabled}
              >
                {processingSendLabel}
              </Button>
            </Tooltip>
            {stopBtn}
          </>
        ) : (
          <Tooltip content={sendTitle}>
            <Button
              type="button"
              variant="primary"
              size={appearance === 'circle' ? 'md' : 'sm'}
              className={styles.sendCircle}
              data-send-active={sendDisabled ? '0' : '1'}
              aria-label={sendAria}
              onClick={trySend}
              disabled={sendDisabled}
              loading={Boolean(disabled)}
              icon={
                appearance === 'circle' ? (
                  <Lucide.ArrowUp size={16} aria-hidden />
                ) : (
                  <Lucide.CornerDownLeft size={16} />
                )
              }
            />
          </Tooltip>
        )}
      </div>
    </>
  );
};
