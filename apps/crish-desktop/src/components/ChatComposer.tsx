/**
 * 主对话输入区：slash 菜单、textarea、发送/停止、附件条、+ 菜单 / 权限。
 * 会话次要动作（搜索/导出）在 card-header ChatHeaderMore。
 * 子 agent 通过 ComposerField 复用同一视觉与增高逻辑（侧栏 AgentCard / 内联 InlineAgentPanel）。
 */
import React, { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { AppErrorBoundary } from './AppErrorBoundary';
import { slashMenuPick } from '../api/resolveSlashCommand';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { Tooltip } from './Tooltip';
import type { PermissionMode } from '../api/permissionModes';
import type { ChatAttachment, QueuedMessage } from '../hooks/useChatStream';
import { ComposerField } from './chat-composer/ComposerField';
import {
  ComposerSlashMenu,
  handleSlashKeyDown,
  type SlashCommandItem,
} from './chat-composer/ComposerSlashMenu';
import { ComposerAttachmentBar } from './chat-composer/ComposerAttachmentBar';
import { ChatQueuePanel } from './chat-composer/ChatQueuePanel';

export type { SlashCommandItem } from './chat-composer/ComposerSlashMenu';
export type { ComposerFieldProps } from './chat-composer/ComposerField';
export {
  ComposerField,
  STOP_TOOLTIP,
  STOP_ARIA_LABEL,
  FORCE_CANCEL_CONFIRM,
  FORCE_STOP_LONG_PRESS_MS,
} from './chat-composer/ComposerField';

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
  /** 默认 Stop = L2 cooperative_stop（单击） */
  onStop: () => void;
  /** 强制取消 = L3 force_cancel（Shift+点击 / 长按，二次确认后由 ComposerField 调用） */
  onForceStop?: () => void;
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
  className?: string;
  queuedMessages?: QueuedMessage[];
  onSendQueuedNow?: (id: string) => void;
  onEditQueued?: (id: string) => void;
  onDeleteQueued?: (id: string) => void;
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
  onForceStop,
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
  className,
  queuedMessages = [],
  onSendQueuedNow,
  onEditQueued,
  onDeleteQueued,
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

  useEffect(() => {
    if (!slashMenuOpen) return;
    if (slashSelectedIndex !== safeIndex) {
      setSlashSelectedIndex(safeIndex);
    }
  }, [slashMenuOpen, slashSelectedIndex, safeIndex, setSlashSelectedIndex]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [slashMenuOpen, safeIndex, filteredCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (slashRootRef.current?.contains(t)) return;
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
        setChatInput('');
        onOpenSchedule();
        requestAnimationFrame(focusComposerTextarea);
        return;
      }
      setChatInput(pick.text);
      requestAnimationFrame(focusComposerTextarea);
    },
    [focusComposerTextarea, onOpenSchedule, setChatInput, setSlashMenuOpen],
  );

  const optionId = useCallback((i: number) => `${listboxId}-opt-${i}`, [listboxId]);

  const slashActiveDesc =
    slashMenuOpen && filteredCommands.length > 0
      ? optionId(safeIndex)
      : undefined;

  const handleRemoveAttachment = useCallback(
    (name: string) => {
      setAttachments((prev) => prev.filter((x) => x.name !== name));
    },
    [setAttachments]
  );

  return (
    <AppErrorBoundary variant="compact" title="输入区出错">
      <div className={`${styles.composerWrapper}${className ? ` ${className}` : ''}`}>
        <ChatQueuePanel
          queue={queuedMessages}
          onSendNow={onSendQueuedNow ?? (() => {})}
          onEdit={onEditQueued ?? (() => {})}
          onDelete={onDeleteQueued ?? (() => {})}
        />
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
          onForceStop={onForceStop}
          onPaste={(e) => {
            void onPasteImage(e);
          }}
          placeholder="输入消息，或键入 / 打开命令…（可粘贴截图）"
          processingPlaceholder="输入排队消息…（当前回复结束后发送，可粘贴截图）"
          ariaLabel="主对话输入"
          ariaExpanded={slashMenuOpen}
          {...(slashMenuOpen ? { ariaControls: listboxId } : {})}
          ariaHasPopup="listbox"
          ariaActivedescendant={slashActiveDesc}
          ariaAutocomplete="list"
          leading={
            slashMenuOpen ? (
              <ComposerSlashMenu
                id={listboxId}
                filteredCommands={filteredCommands}
                safeIndex={safeIndex}
                slashActiveDesc={slashActiveDesc}
                slashRootRef={slashRootRef}
                activeItemRef={activeItemRef}
                onSelect={applySlashSelection}
                onMouseEnterIndex={setSlashSelectedIndex}
                optionId={optionId}
              />
            ) : null
          }
          onKeyDownExtra={(e) =>
            handleSlashKeyDown(
              e,
              slashMenuOpen,
              filteredCommands,
              safeIndex,
              chatInput,
              setSlashMenuOpen,
              setSlashSelectedIndex,
              applySlashSelection,
              focusComposerTextarea
            )
          }
        />

        <ComposerAttachmentBar
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
        />

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
            requestAnimationFrame(focusComposerTextarea);
          }}
        />

        <div className={styles.footerActions} data-composer-footer="1">
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
      </div>
    </AppErrorBoundary>
  );
};
