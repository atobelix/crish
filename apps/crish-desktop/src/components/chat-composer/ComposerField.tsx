import React, { useCallback, useEffect } from 'react';
import styles from './ChatComposer.module.css';
import {
  COMPOSER_DENSE_LINE_HEIGHT,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
  useAutoGrowTextarea,
} from '../../hooks/useAutoGrowTextarea';
import type { ComposerFieldProps } from './composerTypes';
import { readSendShortcut } from '../../api/store-access/settingsAccess';
import { readCodeBlockIndent } from '../../api/codeBlockIndent';
import { ComposerSendControls } from './ComposerSendControls';
import { Textarea } from '../ui';

export {
  STOP_TOOLTIP,
  STOP_ARIA_LABEL,
  FORCE_CANCEL_CONFIRM,
  FORCE_STOP_LONG_PRESS_MS,
} from './ComposerSendControls';

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
    hideSendControls = false,
    sendApiRef,
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

    useEffect(() => {
      if (!sendApiRef) return;
      sendApiRef.current = { flushAndSend: trySend };
      return () => {
        sendApiRef.current = null;
      };
    }, [sendApiRef, trySend]);

    const resolvedPlaceholder =
      isProcessing && processingPlaceholder
        ? processingPlaceholder
        : placeholder;

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
        <Textarea
          bare
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

            if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              const indent = e.shiftKey ? '' : readCodeBlockIndent();
              if (!indent) return;
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const next = value.slice(0, start) + indent + value.slice(end);
              onChange(next);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + indent.length;
              });
              return;
            }

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
        {hideSendControls ? null : (
          <ComposerSendControls
            appearance="field"
            canSend={canSend}
            disabled={disabled}
            isProcessing={isProcessing}
            onSend={trySend}
            onStop={onStop}
            onForceStop={onForceStop}
            processingSendLabel={processingSendLabel}
          />
        )}
      </div>
    );
  }
);
ComposerField.displayName = 'ComposerField';
