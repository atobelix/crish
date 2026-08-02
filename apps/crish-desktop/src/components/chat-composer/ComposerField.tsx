import React, { useCallback, useEffect, useRef } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Tooltip } from '../Tooltip';
import {
  COMPOSER_DENSE_LINE_HEIGHT,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
  useAutoGrowTextarea,
} from '../../hooks/useAutoGrowTextarea';

/**
 * Stop UX 文案（产品：默认 Stop = L2 cooperative；Force = L3 force_cancel）。
 * 用 Tooltip content / aria-label，禁止 native title=（避免双提示）。
 */
export const STOP_TOOLTIP =
  '停止生成（协作停止）。Shift+点击或长按：强制取消';
export const STOP_ARIA_LABEL =
  '停止生成（协作停止）。Shift+点击或长按可强制取消';
/** 强制取消二次确认文案（L3） */
export const FORCE_CANCEL_CONFIRM =
  '强制取消将立即中断模型与工具，未完成结果可能丢失。确定强制取消？';
/** 长按 Stop → L3 的毫秒阈值 */
export const FORCE_STOP_LONG_PRESS_MS = 550;

/** 与主对话同款输入壳：input-container + 发送钮 + 自动增高（默认 ≤4 行滚动） */
export type ComposerFieldProps = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  canSend: boolean;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  /** 流式/子 agent 运行中：显示发送（或排队）+ 停止 */
  isProcessing?: boolean | undefined;
  /** 默认 Stop = L2 cooperative_stop（单击） */
  onStop?: (() => void) | undefined;
  /**
   * 强制取消 = L3 force_cancel（Shift+点击 / 长按，二次确认后）。
   * 未传时 Shift+点击 / 长按会在确认后回落 onStop（过渡期）。
   */
  onForceStop?: (() => void) | undefined;
  /** 处理中时主按钮文案。主对话默认「排队」；子 agent 续聊用「发送」。 */
  processingSendLabel?: string | undefined;
  /** 处理中时的占位提示（中文） */
  processingPlaceholder?: string | undefined;
  onPaste?: ((e: React.ClipboardEvent) => void) | undefined;
  /** 额外按键（slash 等）；返回 true 表示已处理 */
  onKeyDownExtra?: ((e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean | void) | undefined;
  className?: string | undefined;
  /** 输入框内前缀区（slash 菜单等） */
  leading?: React.ReactNode;
  /** 侧栏 / 内联 denser：收紧 pad + 略紧行高，仍同一套半透壳与 grow */
  dense?: boolean | undefined;
  /** 打开侧栏 agent 时自动聚焦 */
  autoFocus?: boolean | undefined;
  /** 无障碍标签（默认随 placeholder） */
  ariaLabel?: string | undefined;
  /** 覆盖默认 maxLines（默认 COMPOSER_MAX_LINES=4；dense 侧栏/内联常传 3）。 */
  maxLines?: number | undefined;
  /** 斜杠 / 弹出层：aria-expanded */
  ariaExpanded?: boolean | undefined;
  /** 关联 listbox / menu id */
  ariaControls?: string | undefined;
  /** listbox | menu 等 */
  ariaHasPopup?: (boolean | 'false' | 'true' | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog') | undefined;
  /** 当前高亮 option id */
  ariaActivedescendant?: string | undefined;
  ariaAutocomplete?: ('none' | 'inline' | 'list' | 'both') | undefined;
  /** 可选 textarea id（供外部 label / controls） */
  textAreaId?: string | undefined;
  /** 外壳 ref（便于父级 focus 回输入框） */
  containerRef?: React.Ref<HTMLDivElement> | undefined;
};

export const ComposerField: React.FC<ComposerFieldProps> = React.memo(({
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
  const { ref: taRef, resize, maxLines: resolvedLines } = useAutoGrowTextarea(
    value,
    lines,
  );
  const lineHeightToken = dense ? COMPOSER_DENSE_LINE_HEIGHT : COMPOSER_LINE_HEIGHT;

  // 长按 Stop → L3 force（与 Shift+点击同源）
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  /** @returns 是否已真正执行 force（用户确认后） */
  const invokeForceStop = useCallback((): boolean => {
    const run = onForceStop ?? onStop;
    if (!run) return false;
    if (typeof window !== 'undefined' && !window.confirm(FORCE_CANCEL_CONFIRM)) {
      return false;
    }
    run();
    return true;
  }, [onForceStop, onStop]);

  const handleStopClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onStop) return;
      // 长按已触发 force 时忽略 mouseup 后的 click
      if (longPressFiredRef.current) {
        longPressFiredRef.current = false;
        e.preventDefault();
        return;
      }
      // Shift+点击 = L3 force_cancel（二次确认）
      if (e.shiftKey) {
        e.preventDefault();
        invokeForceStop();
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
      if (invokeForceStop()) {
        longPressFiredRef.current = true;
      }
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
    isProcessing && processingPlaceholder ? processingPlaceholder : placeholder;

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
          
          const sendShortcut = typeof window !== 'undefined' ? localStorage.getItem('crish_send_shortcut') || 'enter' : 'enter';
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
              <button
                type="button"
                className={`${styles.sendBtn} ${styles.queue}`}
                aria-label={sendAria}
                onClick={trySend}
                disabled={sendDisabled}
              >
                {processingSendLabel}
              </button>
            </Tooltip>
            {onStop ? (
              <Tooltip content={STOP_TOOLTIP}>
                <button
                  type="button"
                  className={`${styles.sendBtn} ${styles.stop}`}
                  data-testid="composer-stop"
                  data-stop-level="l2"
                  aria-label={STOP_ARIA_LABEL}
                  onClick={handleStopClick}
                  onPointerDown={handleStopPointerDown}
                  onPointerUp={clearLongPress}
                  onPointerLeave={clearLongPress}
                  onPointerCancel={clearLongPress}
                >
                  <Lucide.Square size={16} fill="currentColor" aria-hidden />
                </button>
              </Tooltip>
            ) : null}
          </>
        ) : (
          <Tooltip content={sendTitle}>
            <button
              type="button"
              className={styles.sendBtn}
              aria-label={sendAria}
              onClick={trySend}
              disabled={sendDisabled}
            >
              {disabled ? (
                <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
              ) : (
                <Lucide.CornerDownLeft size={16} />
              )}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
});
ComposerField.displayName = 'ComposerField';
