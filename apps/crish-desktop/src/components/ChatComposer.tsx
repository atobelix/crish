/**
 * 主对话输入区：slash 菜单、textarea、发送/停止、附件条、+ 菜单 / 权限。
 * 会话次要动作（搜索/导出）在 card-header ChatHeaderMore。
 * 子 agent 通过 ComposerField 复用同一视觉与增高逻辑（侧栏 AgentCard / 内联 InlineAgentPanel）。
 */
import React, { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { slashMenuPick } from '../api/resolveSlashCommand';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { Tooltip } from './settings/SettingsUI';
import type { PermissionMode } from '../api/permissionModes';
import type { ChatAttachment } from '../hooks/useChatStream';
import {
  COMPOSER_DENSE_LINE_HEIGHT,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
  useAutoGrowTextarea,
} from '../hooks/useAutoGrowTextarea';

export type SlashCommandItem = { cmd: string; desc: string };

/** 与主对话同款输入壳：input-container + 发送钮 + 自动增高（默认 ≤4 行滚动） */
export type ComposerFieldProps = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  canSend: boolean;
  placeholder?: string;
  disabled?: boolean;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  /** 流式/子 agent 运行中：显示发送（或排队）+ 停止 */
  isProcessing?: boolean;
  onStop?: () => void;
  /**
   * 处理中时主按钮文案。主对话默认「排队」；子 agent 续聊用「发送」。
   */
  processingSendLabel?: string;
  /** 处理中时的占位提示（中文） */
  processingPlaceholder?: string;
  onPaste?: (e: React.ClipboardEvent) => void;
  /** 额外按键（slash 等）；返回 true 表示已处理 */
  onKeyDownExtra?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean | void;
  className?: string;
  /** 输入框内前缀区（slash 菜单等） */
  leading?: React.ReactNode;
  /** 侧栏 / 内联 denser：收紧 pad + 略紧行高，仍同一套半透壳与 grow */
  dense?: boolean;
  /** 打开侧栏 agent 时自动聚焦 */
  autoFocus?: boolean;
  /** 无障碍标签（默认随 placeholder） */
  ariaLabel?: string;
  /**
   * 覆盖默认 maxLines（默认 COMPOSER_MAX_LINES=4；dense 侧栏/内联常传 3）。
   * 仍走 useAutoGrowTextarea 同一测量路径。
   */
  maxLines?: number;
  /** 斜杠 / 弹出层：aria-expanded */
  ariaExpanded?: boolean;
  /** 关联 listbox / menu id */
  ariaControls?: string;
  /** listbox | menu 等 */
  ariaHasPopup?: boolean | 'false' | 'true' | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog';
  /** 当前高亮 option id */
  ariaActivedescendant?: string;
  ariaAutocomplete?: 'none' | 'inline' | 'list' | 'both';
  /** 可选 textarea id（供外部 label / controls） */
  textAreaId?: string;
  /** 外壳 ref（便于父级 focus 回输入框） */
  containerRef?: React.Ref<HTMLDivElement>;
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
      className={`${styles.container}${dense ? ` ${styles.containerDense}` : ''}${className ? ` ${className}` : ''}`}
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
        placeholder={resolvedPlaceholder}
        rows={1}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        // 主对话斜杠：combobox + listbox；子 agent 不传 popup 属性，保持普通文本框
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
        // 无白底回归：行内再钉一层，不依赖 UA / autofill 实色
        style={{
          background: 'transparent',
          backgroundColor: 'transparent',
          // 与 CSS token 同值，首帧 font metrics 未就绪时 hook 仍可读
          lineHeight: lineHeightToken,
        }}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => {
          setIsComposing(false);
          // IME 结束后再量一次（中文候选确认后行数可能变）
          requestAnimationFrame(resize);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          // 同步增高（value 尚未 commit 时）
          requestAnimationFrame(resize);
        }}
        onInput={() => {
          // 粘贴/撤销等非 onChange 路径
          requestAnimationFrame(resize);
        }}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (isComposing) return;
          if (onKeyDownExtra?.(e) === true) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            trySend();
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
              <Tooltip content="停止生成">
                <button
                  type="button"
                  className={`${styles.sendBtn} ${styles.stop}`}
                  aria-label="停止生成"
                  onClick={onStop}
                >
                  <Lucide.Square size={16} fill="currentColor" />
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

export type ChatComposerProps = {
  chatInput: string;
  setChatInput: (v: string) => void;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  slashMenuOpen: boolean;
  setSlashMenuOpen: (v: boolean) => void;
  slashSelectedIndex: number;
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  filteredCommands: SlashCommandItem[];
  loadSkillSlash: () => void | Promise<void>;
  onPasteImage: (e: React.ClipboardEvent) => void;
  onSend: () => void;
  onStop: () => void;
  canSend: boolean;
  isProcessing: boolean;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFilesSelected: (files: File[]) => void | Promise<void>;
  showPlusMenu: boolean;
  setShowPlusMenu: (v: boolean) => void;
  permissionMode: PermissionMode;
  onPermissionChange: (m: PermissionMode) => void;
  onOpenSchedule: () => void;
  onCloseSiblingMenus?: () => void;
  rightActions?: React.ReactNode;
};

export const ChatComposer: React.FC<ChatComposerProps> = ({
  chatInput,
  setChatInput,
  isComposing,
  setIsComposing,
  slashMenuOpen,
  setSlashMenuOpen,
  slashSelectedIndex,
  setSlashSelectedIndex,
  filteredCommands,
  loadSkillSlash,
  onPasteImage,
  onSend,
  onStop,
  canSend,
  isProcessing,
  attachments,
  setAttachments,
  fileInputRef,
  onFilesSelected,
  showPlusMenu,
  setShowPlusMenu,
  permissionMode,
  onPermissionChange,
  onOpenSchedule,
  onCloseSiblingMenus,
  rightActions,
}) => {
  const listboxId = useId();
  const plusMenuId = useId();
  const textAreaDomId = useId();
  const slashRootRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLDivElement | null>(null);
  const fieldContainerRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);

  const safeIndex = useMemo(() => {
    if (filteredCommands.length === 0) return 0;
    return Math.min(Math.max(0, slashSelectedIndex), filteredCommands.length - 1);
  }, [filteredCommands.length, slashSelectedIndex]);

  // 过滤结果变短时钳制选中下标，避免越界高亮
  useEffect(() => {
    if (!slashMenuOpen) return;
    if (slashSelectedIndex !== safeIndex) {
      setSlashSelectedIndex(safeIndex);
    }
  }, [slashMenuOpen, slashSelectedIndex, safeIndex, setSlashSelectedIndex]);

  // 键盘/过滤切换后把 active 项滚入视野
  useEffect(() => {
    if (!slashMenuOpen) return;
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [slashMenuOpen, safeIndex, filteredCommands.length]);

  // 点菜单外关闭（与 + 菜单同契约）
  useEffect(() => {
    if (!slashMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (slashRootRef.current?.contains(t)) return;
      // 输入框内继续打字不关；仅真正外部点击
      const el = t as HTMLElement | null;
      if (el?.closest?.('.input-container')) return;
      setSlashMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [slashMenuOpen, setSlashMenuOpen]);

  const focusComposerTextarea = useCallback(() => {
    const root = fieldContainerRef.current;
    const ta =
      root?.querySelector?.('textarea.composer-textarea') ??
      root?.querySelector?.('textarea');
    if (ta instanceof HTMLTextAreaElement) {
      ta.focus();
    }
  }, []);

  const applySlashSelection = useCallback(
    (cmd: string) => {
      setSlashMenuOpen(false);
      const pick = slashMenuPick(cmd);
      if (pick.action === 'open-schedule') {
        // 纯导航：只开定时面板，清空输入，绝不走 onSend（防幽灵会话）
        setChatInput('');
        onOpenSchedule();
        requestAnimationFrame(focusComposerTextarea);
        return;
      }
      // fill：写入规范文本（常带尾空格待续参），焦点回输入框继续编辑
      setChatInput(pick.text);
      requestAnimationFrame(focusComposerTextarea);
    },
    [focusComposerTextarea, onOpenSchedule, setChatInput, setSlashMenuOpen],
  );

  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  const slashActiveDesc =
    slashMenuOpen && filteredCommands.length > 0
      ? optionId(safeIndex)
      : undefined;

  return (
    <>
      <ComposerField
        containerRef={fieldContainerRef}
        textAreaId={textAreaDomId}
        value={chatInput}
        onChange={(val) => {
          setChatInput(val);
          if (val.startsWith('/') && !val.includes(' ')) {
            setSlashMenuOpen(true);
            setShowPlusMenu(false);
            setSlashSelectedIndex(0);
            void loadSkillSlash();
          } else {
            setSlashMenuOpen(false);
          }
        }}
        onSend={onSend}
        canSend={canSend}
        isComposing={isComposing}
        setIsComposing={setIsComposing}
        isProcessing={isProcessing}
        onStop={onStop}
        onPaste={(e) => {
          void onPasteImage(e);
        }}
        placeholder="输入消息，或键入 / 打开命令…（可粘贴截图）"
        processingPlaceholder="输入排队消息…（当前回复结束后发送，可粘贴截图）"
        ariaLabel="主对话输入"
        ariaExpanded={slashMenuOpen}
        ariaControls={slashMenuOpen ? listboxId : undefined}
        ariaHasPopup="listbox"
        ariaActivedescendant={slashActiveDesc}
        ariaAutocomplete="list"
        leading={
          slashMenuOpen ? (
            <div
              ref={slashRootRef}
              id={listboxId}
              className={styles.slashPopover}
              role="listbox"
              aria-label="斜杠命令"
              aria-activedescendant={slashActiveDesc}
            >
              {filteredCommands.length === 0 ? (
                <div className={styles.slashEmpty} role="presentation">
                  无匹配命令
                </div>
              ) : (
                filteredCommands.map((c, i) => {
                  const active = i === safeIndex;
                  return (
                    <div
                      key={c.cmd}
                      id={optionId(i)}
                      ref={active ? activeItemRef : undefined}
                      role="option"
                      aria-selected={active}
                      className={`${styles.slashItem}${active ? ` ${styles.isActive}` : ''}`}
                      onClick={() => applySlashSelection(c.cmd)}
                      onMouseEnter={() => setSlashSelectedIndex(i)}
                    >
                      <span className={styles.slashCmd}>{c.cmd}</span>
                      <span className={styles.slashDesc}>{c.desc}</span>
                    </div>
                  );
                })
              )}
            </div>
          ) : null
        }
        onKeyDownExtra={(e) => {
          if (!slashMenuOpen) return false;
          const n = filteredCommands.length;

          if (e.key === 'Escape') {
            e.preventDefault();
            setSlashMenuOpen(false);
            // 焦点留在输入框
            requestAnimationFrame(focusComposerTextarea);
            return true;
          }
          if (e.key === 'Tab') {
            // Tab 收起菜单，允许默认焦点移动
            setSlashMenuOpen(false);
            return false;
          }
          if (n === 0) {
            // 无匹配时 Enter 不发送残缺 slash-only（防空壳会话）
            if (e.key === 'Enter' && !e.shiftKey) {
              const bare = chatInput.trim();
              if (bare === '/' || bare === '／') {
                e.preventDefault();
                return true;
              }
            }
            return false;
          }

          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSlashSelectedIndex((prev) => (prev + 1) % n);
            return true;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSlashSelectedIndex((prev) => (prev - 1 + n) % n);
            return true;
          }
          if (e.key === 'Home') {
            e.preventDefault();
            setSlashSelectedIndex(0);
            return true;
          }
          if (e.key === 'End') {
            e.preventDefault();
            setSlashSelectedIndex(n - 1);
            return true;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            const selected = filteredCommands[safeIndex];
            // 菜单确认只 fill / 导航，绝不直接 onSend
            if (selected) applySlashSelection(selected.cmd);
            return true;
          }
          return false;
        }}
      />

      {attachments.length > 0 && (
        <div
          className={styles.attachStrip}
          role="list"
          aria-label={`附件，共 ${attachments.length} 个`}
        >
          {attachments.map((a) => (
            <Tooltip key={a.name} content={a.name}>
              <span
                role="listitem"
                className={`${styles.attachChip} ${a.dataUrl ? styles.attachChipImage : ''}`}
              >
                {a.dataUrl ? (
                  <img src={a.dataUrl} alt={a.name} className={styles.attachThumb} />
                ) : (
                  <Lucide.Paperclip size={14} className={styles.attachIcon} aria-hidden />
                )}
                <span className={styles.attachName}>{a.name}</span>
                <Tooltip content={`移除 ${a.name}`}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost chat-attach-remove"
                    aria-label={`移除附件 ${a.name}`}
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.name !== a.name))}
                  >
                    <Lucide.X size={14} aria-hidden />
                  </button>
                </Tooltip>
              </span>
            </Tooltip>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef as React.RefObject<HTMLInputElement>}
        type="file"
        multiple
        aria-hidden
        tabIndex={-1}
        style={{ display: 'none' }}
        onChange={async (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (!files.length) return;
          await onFilesSelected(files);
          // 选完文件后焦点回输入框，便于继续打字发送
          requestAnimationFrame(focusComposerTextarea);
        }}
      />

      <div className={styles.footerActions}>
        <div className={styles.leftActions} style={{ position: 'relative' }}>
          <Tooltip content="添加文件、技能、扩展…">
            <button
              ref={plusBtnRef}
              type="button"
              className={`${styles.plusBtn} ${showPlusMenu ? styles.isOpen : ''}`}
              aria-label="打开添加菜单"
              aria-haspopup="menu"
              aria-expanded={showPlusMenu}
              aria-controls={showPlusMenu ? plusMenuId : undefined}
              onClick={() => {
                if (showPlusMenu) {
                  setShowPlusMenu(false);
                  requestAnimationFrame(() => plusBtnRef.current?.focus());
                } else {
                  setShowPlusMenu(true);
                  setSlashMenuOpen(false);
                  onCloseSiblingMenus?.();
                }
              }}
            >
              <Lucide.Plus size={16} aria-hidden />
            </button>
          </Tooltip>
          <ComposePlusMenu
            id={plusMenuId}
            open={showPlusMenu}
            onClose={() => setShowPlusMenu(false)}
            onAddFiles={() => fileInputRef.current?.click()}
            onInsertSkillSlash={() => {
              // 打开斜杠菜单：以 / 起头触发技能/指令
              if (!chatInput.startsWith('/')) {
                setChatInput(chatInput ? `/${chatInput}` : '/');
              }
              setSlashMenuOpen(true);
              void loadSkillSlash();
              requestAnimationFrame(focusComposerTextarea);
            }}
            restoreFocusRef={plusBtnRef}
          />
          <PermissionModeMenu
            mode={permissionMode}
            onChange={(m) => {
              onPermissionChange(m);
              setShowPlusMenu(false);
              setSlashMenuOpen(false);
              onCloseSiblingMenus?.();
            }}
          />
        </div>
        <div className={styles.rightActions}>{rightActions}</div>
      </div>
    </>
  );
};
