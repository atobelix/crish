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
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './ChatComposer.module.css';
import { TiptapEditorField } from './TiptapEditorField';
import type {
  SlashCommandItem,
  TiptapEditorFieldHandle,
  MentionCandidate,
} from './composerTypes';
import { slashMenuPick } from '../../api/resolveSlashCommand';
import { DraftUndoToast } from './DraftUndoToast';
import {
  COMPOSER_DENSE_LINE_HEIGHT,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
} from '../../hooks/useAutoGrowTextarea';
import type { ComposerFieldProps } from './composerTypes';
import { ComposerSendControls } from './ComposerSendControls';
import {
  readSendShortcut,
  SEND_SHORTCUT_CHANGED_EVENT,
} from '../../api/store-access/settingsAccess';

/** 宿主系统斜杠命令默认集（对齐 useChatComposerProps.BASE_SLASH 与 AI 系统指令集） */
const HOST_SYSTEM_SLASH: ReadonlyArray<{ cmd: string; desc: string }> = [
  { cmd: '/clear', desc: '清空会话历史' },
  { cmd: '/stop', desc: '停止当前任务' },
  { cmd: '/mode', desc: '切换执行模式' },
  { cmd: '/prompt', desc: '插入提示词' },
  { cmd: '/compact', desc: '压缩会话上下文' },
  { cmd: '/goal', desc: '多轮推进直至完成' },
  { cmd: '/schedule', desc: '定时任务' },
  { cmd: '/grill-me', desc: '对齐提问，暂不实施' },
  { cmd: '/teamwork', desc: '协作看板' },
  { cmd: '/browser', desc: '预览浏览器' },
  { cmd: '/learn', desc: '记住一条规则' },
  { cmd: '/settings', desc: '打开设置中心' },
  { cmd: '/help', desc: '查看指令帮助' },
];

/** 宿主命令 → 斜杠菜单图标映射 */
const HOST_SLASH_ICONS: Record<string, string> = {
  '/clear': 'Eraser',
  '/stop': 'Square',
  '/mode': 'Sliders',
  '/prompt': 'FileCode',
  '/compact': 'Shrink',
  '/goal': 'Target',
  '/learn': 'BookOpen',
  '/grill-me': 'HelpCircle',
  '/schedule': 'Calendar',
  '/teamwork': 'Users',
  '/browser': 'Globe',
  '/simulate': 'PlayCircle',
  '/skill': 'Sparkles',
  '/settings': 'Sparkles',
  '/help': 'HelpCircle',
};

export type TiptapComposerFieldProps = ComposerFieldProps & {
  /** 宿主 skill 斜杠命令（动态加载后由宿主传入） */
  skillSlashCommands?: ReadonlyArray<{ cmd: string; desc: string }>;
  /** 宿主系统斜杠命令（缺省用内置 BASE_SLASH 对齐集） */
  baseSlashCommands?: ReadonlyArray<{ cmd: string; desc: string }>;
  /** 宿主文件选择链（编辑器拖放直达） */
  onFilesSelected?: (files: File[]) => void | Promise<void>;
  /** 提及候选人（@ 触发；未接入宿主候选人源时留空兜底） */
  mentionCandidates?: ReadonlyArray<MentionCandidate>;
  /** 落地面态（session-empty 走 5% 焦点混色特例） */
  emptyKind?: string;
};

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
  onFilesSelected,
  mentionCandidates,
  emptyKind,
  hideSendControls = false,
  sendApiRef,
  hasUndo,
  handleUndoDraft,
  draftInjectionTick,
}) => {
  const lines =
    typeof maxLines === 'number' && Number.isFinite(maxLines)
      ? maxLines
      : COMPOSER_MAX_LINES;
  const lineHeightToken = dense
    ? COMPOSER_DENSE_LINE_HEIGHT
    : COMPOSER_LINE_HEIGHT;

  // ── 发送偏好（ctrlEnter/enter，随 storage 事件同步）─────────────────────────
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'ctrlEnter'>(
    readSendShortcut
  );
  useEffect(() => {
    const sync = () => setSendShortcut(readSendShortcut());
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'crish_settings' || e.key === 'crish_send_shortcut') sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(SEND_SHORTCUT_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SEND_SHORTCUT_CHANGED_EVENT, sync);
    };
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

  useEffect(() => {
    if (!sendApiRef) return;
    sendApiRef.current = { flushAndSend: trySend };
    return () => {
      sendApiRef.current = null;
    };
  }, [sendApiRef, trySend]);

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

  // ── 定向注入响应：草稿模板命中活跃会话后聚焦并全选首个占位符 ───────────────
  useEffect(() => {
    if (!draftInjectionTick) return;
    fieldRef.current?.focusPlaceholder();
  }, [draftInjectionTick]);

  const slashExtraItems = useMemo(() => {
    const base = baseSlashCommands ?? HOST_SYSTEM_SLASH;
    return [...base, ...(skillSlashCommands ?? [])].map<SlashCommandItem>(
      (c) => ({
        id: `host-${c.cmd}`,
        title: c.cmd,
        description: c.desc,
        iconName: HOST_SLASH_ICONS[c.cmd] ?? HOST_SLASH_ICONS['/skill'],
        keywords: [c.cmd.replace(/^\/+/, '')],
        command: ({ editor, range }) => {
          const pick = slashMenuPick(c.cmd);
          const chain = editor.chain().focus();
          if (range) chain.deleteRange(range);
          chain.insertContent(pick.text).run();
        },
      })
    );
  }, [baseSlashCommands, skillSlashCommands]);

  const resolvedPlaceholder =
    isProcessing && processingPlaceholder ? processingPlaceholder : placeholder;

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
      {/* 草稿撤销浮条：外部模板覆盖后提示原位恢复（详案 03 §2.3） */}
      <DraftUndoToast
        show={Boolean(hasUndo)}
        onUndo={() => handleUndoDraft?.()}
      />
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
        containerRef={containerRef}
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
};
TiptapComposerField.displayName = 'TiptapComposerField';
