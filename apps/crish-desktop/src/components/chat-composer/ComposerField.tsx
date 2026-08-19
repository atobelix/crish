import React, { useCallback, useEffect, useRef } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Button, ConfirmDialog, Tooltip } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import {
  COMPOSER_DENSE_LINE_HEIGHT,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
  useAutoGrowTextarea,
} from '../../hooks/useAutoGrowTextarea';
import type { ComposerFieldProps } from './composerTypes';
import { readSendShortcut } from '../../api/store-access/settingsAccess';

/**
 * Stop UX 文案（产品：默认 Stop = L2 cooperative；Force = L3 force_cancel）。
 * 用 Tooltip content / aria-label，禁止 native title=（避免双提示）。
 */
export const STOP_TOOLTIP = '停止生成（协作停止）。Shift+点击或长按：强制取消';
export const STOP_ARIA_LABEL =
  '停止生成（协作停止）。Shift+点击或长按可强制取消';
/** 强制取消二次确认文案（L3） */
export const FORCE_CANCEL_CONFIRM =
  '强制取消将立即中断模型与工具，未完成结果可能丢失。确定强制取消？';
/** 长按 Stop → L3 的毫秒阈值 */
export const FORCE_STOP_LONG_PRESS_MS = 550;

/** 核心输入契约（canonical 归置 composerTypes.ts，F1-γ）：与主对话同款输入壳 */
export type { ComposerFieldProps } from './composerTypes';

export const ComposerField: React.FC<ComposerFieldProps> = React.memo(
  ({
    value,
    onChange,
    onSend,
    canSend,
    placeholder = '输入消息…',
    disabled,
    isComposing,
    setIsComposing,
    isProcessing,
    onStop,
    onForceStop,
    processingSendLabel = '排队',
    processingPlaceholder,
    onPaste,
    onKeyDownExtra,
    className,
    leading,
    dense = false,
    autoFocus,
    ariaLabel,
    maxLines = COMPOSER_MAX_LINES,
    ariaExpanded,
    ariaControls,
    ariaHasPopup,
    ariaActivedescendant,
    ariaAutocomplete,
    textAreaId,
    containerRef,
  }) => {
    // 主列默认最多 10 行；非法/缺省回落 COMPOSER_MAX_LINES
    const lines =
      typeof maxLines === 'number' && Number.isFinite(maxLines)
        ? maxLines
        : COMPOSER_MAX_LINES;
    const {
      ref: taRef,
      resize,
      maxLines: resolvedLines,
    } = useAutoGrowTextarea(value, lines);
    const lineHeightToken = dense
      ? COMPOSER_DENSE_LINE_HEIGHT
      : COMPOSER_LINE_HEIGHT;

    // 长按 Stop → L3 force（与 Shift+点击同源）
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null
    );
    const longPressFiredRef = useRef(false);
    // window.confirm → ConfirmDialog Promise 桥（批次 4.1，04-detail §2.1.1）
    const [confirmGate, renderConfirmGate] = useConfirmGate();

    const clearLongPress = useCallback(() => {
      if (longPressTimerRef.current != null) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }, []);

    useEffect(() => () => clearLongPress(), [clearLongPress]);

    /** @returns 是否已真正执行 force（用户确认后） */
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
        // 长按已触发 force 时忽略 mouseup 后的 click
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false;
          e.preventDefault();
          return;
        }
        // Shift+点击 = L3 force_cancel（二次确认，异步弹窗）
        if (e.shiftKey) {
          e.preventDefault();
          void invokeForceStop();
          return;
        }
        // 默认单击 = L2 cooperative_stop
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
        // 仅确认后吞掉后续 click；用户取消确认仍可单击 L2
        void invokeForceStop().then((fired) => {
          if (fired) longPressFiredRef.current = true;
        });
      }, FORCE_STOP_LONG_PRESS_MS);
    }, [onStop, clearLongPress, invokeForceStop]);

    // autoFocus 挂载后字体/布局可能尚未稳定，再量一次避免首帧单行假矮
    useEffect(() => {
      if (!autoFocus) return;
      const id = requestAnimationFrame(resize);
      return () => cancelAnimationFrame(id);
    }, [autoFocus, resize]);

    /**
     * 空发送护栏：disabled / !canSend 一律不触发 onSend。
     * 父级 canSend 已含 trim/附件；此处防御重复点击与 Enter 竞态。
     */
    const trySend = useCallback(() => {
      if (disabled || !canSend) return;
      onSend();
    }, [disabled, canSend, onSend]);

    const resolvedPlaceholder =
      isProcessing && processingPlaceholder
        ? processingPlaceholder
        : placeholder;

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

    return (
      <div
        ref={containerRef}
        className={`${styles.container} input-container${dense ? ` ${styles.containerDense}` : ''}${className ? ` ${className}` : ''}`}
        data-composer-field="1"
        data-composer-dense={dense ? '1' : '0'}
        data-composer-max-lines={resolvedLines}
        style={
          {
            position: 'relative',
            // 与 hook / CSS token 同步，避免侧栏与主列行数/行高漂移
            ['--composer-max-lines' as string]: String(resolvedLines),
            ['--composer-line-height' as string]: String(lineHeightToken),
          } as React.CSSProperties
        }
      >
        {leading}
        {/* 强制取消二次确认（Promise 桥渲染点：request 已带标题/文案，元素 props 兜底） */}
        {renderConfirmGate(<ConfirmDialog />)}
        <textarea
          id={textAreaId}
          ref={taRef}
          className={styles.textarea}
          data-testid="chat-input"
          placeholder={resolvedPlaceholder}
          rows={1}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          role={
            ariaHasPopup === 'listbox' || typeof ariaExpanded === 'boolean'
              ? 'combobox'
              : undefined
          }
          aria-label={ariaLabel || resolvedPlaceholder}
          aria-multiline="true"
          aria-expanded={ariaExpanded}
          aria-controls={ariaControls}
          aria-haspopup={ariaHasPopup}
          aria-activedescendant={ariaActivedescendant}
          aria-autocomplete={ariaAutocomplete}
          aria-disabled={disabled || undefined}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          style={{
            background: 'transparent',
            backgroundColor: 'transparent',
            lineHeight: lineHeightToken,
          }}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => {
            setIsComposing(false);
            requestAnimationFrame(resize);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            requestAnimationFrame(resize);
          }}
          onInput={() => {
            requestAnimationFrame(resize);
          }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (isComposing) return;
            if (onKeyDownExtra?.(e) === true) return;

            const sendShortcut = readSendShortcut();
            if (sendShortcut === 'ctrlEnter') {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                trySend();
              }
            } else {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                trySend();
              }
            }
          }}
        />
        <div className={styles.buttons}>
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
              {onStop ? (
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
                    icon={
                      <Lucide.Square
                        size={16}
                        fill="currentColor"
                        aria-hidden
                      />
                    }
                  />
                </Tooltip>
              ) : null}
            </>
          ) : (
            <Tooltip content={sendTitle}>
              <Button
                type="button"
                variant="primary"
                size="sm"
                className={styles.sendCircle}
                aria-label={sendAria}
                onClick={trySend}
                disabled={sendDisabled}
                loading={Boolean(disabled)}
                icon={<Lucide.CornerDownLeft size={16} />}
              />
            </Tooltip>
          )}
        </div>
      </div>
    );
  }
);
ComposerField.displayName = 'ComposerField';
