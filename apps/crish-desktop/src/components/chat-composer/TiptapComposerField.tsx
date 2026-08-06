/**
 * apps/crish-desktop/src/components/chat-composer/TiptapComposerField.tsx
 * 适配层：ComposerFieldProps 兼容超集的 tiptap 输入壳（40 方案 T3）。
 *
 * 状态真相源：宿主 useChatComposerProps（value/onChange/onSend 全链零改动）；
 * 编辑器只产 markdown，经 onMarkdownChange 回流宿主；发送走「回流 → 重渲染 → 触发」。
 * 关键设计：
 * - 防循环写回：编辑器清空回流在发送挂起期被吞掉，宿主 chatInput 保持待发文本；
 * - 空护栏：disabled/canSend 以重渲染后最新 props 判定（规避 150ms 防抖期宿主状态陈旧）；
 * - 附件/权限/队列/IME：宿主链路不变（onPaste 转发原事件、composition 同步宿主）。
 * CI Guardrail: UI Component (Max 500 lines of effective code, Max 12 useState)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Tooltip } from '../Tooltip';
import { TiptapEditorField } from './TiptapEditorField';
import type { SlashCommandItem, TiptapEditorFieldHandle, MentionCandidate } from './composerTypes';
import { slashMenuPick } from '../../api/resolveSlashCommand';
import {
  COMPOSER_DENSE_LINE_HEIGHT,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
} from '../../hooks/useAutoGrowTextarea';
import {
  FORCE_CANCEL_CONFIRM,
  FORCE_STOP_LONG_PRESS_MS,
  STOP_ARIA_LABEL,
  STOP_TOOLTIP,
  type ComposerFieldProps,
} from './ComposerField';

/** 宿主系统斜杠命令默认集（对齐 useChatComposerProps.BASE_SLASH，/simulate 由宿主按 demo 模式注入） */
const HOST_SYSTEM_SLASH: ReadonlyArray<{ cmd: string; desc: string }> = [
  { cmd: '/goal', desc: '多轮推进直至完成' },
  { cmd: '/learn', desc: '记住一条规则' },
  { cmd: '/grill-me', desc: '对齐提问，暂不实施' },
  { cmd: '/schedule', desc: '定时任务' },
  { cmd: '/teamwork', desc: '协作看板' },
  { cmd: '/browser', desc: '预览浏览器' },
];

/** 宿主命令 → 斜杠菜单图标映射 */
const HOST_SLASH_ICONS: Record<string, string> = {
  '/goal': 'Target',
  '/learn': 'BookOpen',
  '/grill-me': 'HelpCircle',
  '/schedule': 'Calendar',
  '/teamwork': 'Users',
  '/browser': 'Globe',
  '/simulate': 'PlayCircle',
  '/skill': 'Sparkles',
};

export type TiptapComposerFieldProps = ComposerFieldProps & {
  /** 宿主 skill 斜杠命令（动态加载后由宿主传入） */
  skillSlashCommands?: ReadonlyArray<{ cmd: string; desc: string }>;
  /** 宿主系统斜杠命令（缺省用内置 BASE_SLASH 对齐集） */
  baseSlashCommands?: ReadonlyArray<{ cmd: string; desc: string }>;
  /** 宿主点选系统命令回调（open-schedule 动作等） */
  onSlashMenuPick?: (cmd: string) => void;
  /** 宿主文件选择链（编辑器拖放直达） */
  onFilesSelected?: (files: File[]) => void | Promise<void>;
  /** 提及候选人（@ 触发；未接入宿主候选人源时留空兜底） */
  mentionCandidates?: ReadonlyArray<MentionCandidate>;
  /** 落地面态（session-empty 走 5% 焦点混色特例） */
  emptyKind?: string;
};

/** 读取发送快捷键偏好（与 ComposerField 同 key） */
function readSendShortcut(): 'enter' | 'ctrlEnter' {
  try {
    return typeof window !== 'undefined' &&
      localStorage.getItem('crish_send_shortcut') === 'ctrlEnter'
      ? 'ctrlEnter'
      : 'enter';
  } catch {
    return 'enter';
  }
}

export const TiptapComposerField: React.FC<TiptapComposerFieldProps> = ({
  value,
  onChange,
  onSend,
  canSend,
  placeholder = '输入消息…',
  disabled,
  isComposing: _isComposing,
  setIsComposing,
  isProcessing,
  onStop,
  onForceStop,
  processingSendLabel = '排队',
  processingPlaceholder,
  onPaste,
  onKeyDownExtra: _onKeyDownExtra,
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
  textAreaId: _textAreaId,
  containerRef,
  skillSlashCommands,
  baseSlashCommands,
  onSlashMenuPick,
  onFilesSelected,
  mentionCandidates,
  emptyKind,
}) => {
  const lines =
    typeof maxLines === 'number' && Number.isFinite(maxLines)
      ? maxLines
      : COMPOSER_MAX_LINES;
  const lineHeightToken = dense ? COMPOSER_DENSE_LINE_HEIGHT : COMPOSER_LINE_HEIGHT;

  // ── 发送偏好（ctrlEnter/enter，随 storage 事件同步）─────────────────────────
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'ctrlEnter'>(readSendShortcut);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'crish_send_shortcut') setSendShortcut(readSendShortcut());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // ── 发送回流机制（编辑器 → 宿主 chatInput → 重渲染 → 触发宿主 onSend）───────
  const onSendRef = useRef(onSend);
  const fieldRef = useRef<TiptapEditorFieldHandle>(null);
  const sendRequestRef = useRef<string | null>(null);
  const [sendTick, setSendTick] = useState(0);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  useEffect(() => {
    if (sendRequestRef.current === null) return;
    const md = sendRequestRef.current;
    sendRequestRef.current = null;
    // 空护栏以重渲染后最新 props 判定（防抖期宿主 canSend 可能仍为旧值）
    if (disabled || !canSend || !md.trim()) {
      return; // 文本已回流宿主，编辑器经 content 水合自动恢复
    }
    onSendRef.current?.();
  }, [sendTick, disabled, canSend]);

  /**
   * 编辑器 Enter 发送入口：先把最新 markdown 回流宿主（真相源），
   * 再以 tick 驱动 effect 在重渲染后调用宿主 onSend（规避闭包陈旧）。
   * 期间吞掉编辑器清空回流，宿主 chatInput 保持待发文本。
   */
  const handleSendMarkdown = useCallback(
    (md: string) => {
      if (!md.trim()) return;
      onChange(md);
      sendRequestRef.current = md;
      setSendTick((t) => t + 1);
    },
    [onChange]
  );

  /** 编辑器 markdown 回流：发送挂起期吞掉清空，其余正常回流宿主 */
  const handleMarkdownChange = useCallback(
    (md: string) => {
      if (sendRequestRef.current !== null) return;
      onChange(md);
    },
    [onChange]
  );

  /** 发送钮点击：宿主已同步则直发；防抖未到则复用 Enter 同款回流机制 */
  const trySend = useCallback(() => {
    const latest = fieldRef.current?.getMarkdown() ?? null;
    if (latest !== null && latest.trim() !== value.trim()) {
      handleSendMarkdown(latest);
      return;
    }
    if (disabled || !canSend) return;
    onSendRef.current?.();
  }, [disabled, canSend, value, handleSendMarkdown]);

  // ── 粘贴图片转发（宿主 handlePasteImage 读原事件 clipboardData）──────────────
  // 类型桥说明：宿主 onPaste 契约是 React.ClipboardEvent，编辑器侧为原生
  // ClipboardEvent；两者仅静态形状不同，运行期宿主只消费 clipboardData/preventDefault，
  // 因此以一次受限断言转发原事件，不重建合成事件（保持原生对象唯一性）。
  const handlePasteImage = useCallback(
    (_file: File, event: ClipboardEvent) => {
      onPaste?.(event as unknown as React.ClipboardEvent);
    },
    [onPaste]
  );

  const handleDropFiles = useCallback(
    (files: File[]) => {
      void onFilesSelected?.(files);
    },
    [onFilesSelected]
  );

  // ── 宿主斜杠命令桥（系统 + skill → 编辑器菜单项，slashMenuPick 文本注入）──────
  const slashPickRef = useRef(onSlashMenuPick);
  useEffect(() => {
    slashPickRef.current = onSlashMenuPick;
  }, [onSlashMenuPick]);

  const slashExtraItems = useMemo(() => {
    const base = baseSlashCommands ?? HOST_SYSTEM_SLASH;
    return [...base, ...(skillSlashCommands ?? [])].map<SlashCommandItem>((c) => ({
      id: `host-${c.cmd}`,
      title: c.cmd,
      description: c.desc,
      iconName: HOST_SLASH_ICONS[c.cmd] ?? HOST_SLASH_ICONS['/skill'],
      keywords: [c.cmd.replace(/^\/+/, '')],
      command: ({ editor, range }) => {
        const pick = slashMenuPick(c.cmd);
        if (pick.action === 'open-schedule') {
          // 定时任务：转交宿主开面板，不落输入
          slashPickRef.current?.(c.cmd);
          return;
        }
        const chain = editor.chain().focus();
        if (range) chain.deleteRange(range);
        chain.insertContent(pick.text).run();
      },
    }));
  }, [baseSlashCommands, skillSlashCommands]);

  // ── Stop L2/L3 UX（与 ComposerField 同源：Shift+点击 / 长按 550ms + 二次确认）──
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

  // ── 渲染数据（与 ComposerField 同语义）─────────────────────────────────────
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
      data-composer-max-lines={lines}
      data-empty-kind={emptyKind}
      style={
        {
          position: 'relative',
          // 与 hook / CSS token 同步，避免侧栏与主列行数/行高漂移
          ['--composer-max-lines' as string]: String(lines),
          ['--composer-line-height' as string]: String(lineHeightToken),
        } as React.CSSProperties
      }
    >
      {leading}
      <TiptapEditorField
        ref={fieldRef}
        placeholder={resolvedPlaceholder}
        disabled={disabled}
        sendShortcut={sendShortcut}
        content={value}
        autoFocus={autoFocus}
        ariaLabel={ariaLabel || resolvedPlaceholder}
        ariaExpanded={ariaExpanded}
        ariaControls={ariaControls}
        ariaHasPopup={ariaHasPopup}
        ariaActivedescendant={ariaActivedescendant}
        ariaAutocomplete={ariaAutocomplete}
        onSendMarkdown={handleSendMarkdown}
        onMarkdownChange={handleMarkdownChange}
        onCompositionChange={setIsComposing}
        onDropFiles={handleDropFiles}
        onPasteImage={handlePasteImage}
        slashExtraItems={slashExtraItems}
        mentionCandidates={mentionCandidates}
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
};
TiptapComposerField.displayName = 'TiptapComposerField';
