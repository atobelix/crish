/**
 * 主对话输入区：slash 菜单（tiptap 接管）、富文本输入、发送/停止、附件条、+ 菜单 / 权限。
 * 会话次要动作（搜索/导出）在 card-header ChatHeaderMore。
 * 子 agent 通过 ComposerField 复用同一视觉与增高逻辑（侧栏 AgentCard / 内联 InlineAgentPanel）。
 *
 * 40 方案 T6 接线：编辑器由 TiptapComposerField 接管；
 * - 宿主 ComposerSlashMenu 文本注入路径退役（tiptap 菜单已接管键盘与点选）；
 * - 命令源 filteredCommands 以 baseSlashCommands 桥入编辑器菜单（宿主过滤 + 编辑器 query 精滤）；
 * - open-schedule 动作经 onSlashMenuPick 回宿主开面板；
 * - 落地面态（RL-01 5% 焦点混色特例）从祖先 DOM data-empty-kind 感知。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { Tooltip } from '../Tooltip';
import type { PermissionMode } from '../../api/permissionModes';
import type { ChatAttachment, QueuedMessage } from '../../hooks/useChatStream';
import { TiptapComposerField } from './TiptapComposerField';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';
import { ChatQueuePanel } from './ChatQueuePanel';

export type { ComposerFieldProps } from './ComposerField';
export {
  ComposerField,
  STOP_TOOLTIP,
  STOP_ARIA_LABEL,
  FORCE_CANCEL_CONFIRM,
  FORCE_STOP_LONG_PRESS_MS,
} from './ComposerField';

export type ChatComposerProps = {
  chatInput: string;
  setChatInput: (v: string) => void;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  /** 宿主斜杠菜单状态（ChatCard 契约保留；tiptap 菜单接管后暂不消费） */
  slashMenuOpen?: boolean;
  setSlashMenuOpen?: (v: boolean) => void;
  slashSelectedIndex?: number;
  setSlashSelectedIndex?: React.Dispatch<React.SetStateAction<number>>;
  /** 宿主斜杠命令（base + skill，已按输入前缀过滤；桥入 tiptap 菜单） */
  filteredCommands: Array<{ cmd: string; desc: string }>;
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
  /** 落地面态（session-empty）；未传时从 DOM 祖先 data-empty-kind 感知 */
  emptyKind?: string | null;
};

export const ChatComposer: React.FC<ChatComposerProps> = ({
  chatInput,
  setChatInput,
  isComposing,
  setIsComposing,
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
  emptyKind: emptyKindProp,
}) => {
  const plusMenuId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fieldContainerRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);

  // 落地面态（RL-01 特例）：宿主未透传 emptyKind 时，从 DOM 祖先 data-empty-kind
  // （chatBody）读取；会话在空态/消息态间切换时经 MutationObserver 同步，
  // 保证 session-empty 落地面走 5% 焦点混色而非标准 6%。
  const [emptyKind, setEmptyKind] = useState<string | undefined>(
    emptyKindProp ?? undefined
  );
  useEffect(() => {
    if (emptyKindProp !== undefined && emptyKindProp !== null) return;
    const root = wrapperRef.current;
    if (!root) return;
    const read = () => {
      const el = root.closest('[data-empty-kind]');
      setEmptyKind(el?.getAttribute('data-empty-kind') ?? undefined);
    };
    read();
    const observed = root.closest('[data-main-surface]') ?? root;
    const mo = new MutationObserver(read);
    mo.observe(observed, { attributes: true, attributeFilter: ['data-empty-kind'] });
    return () => mo.disconnect();
  }, [emptyKindProp]);

  const focusComposerTextarea = useCallback(() => {
    const root = fieldContainerRef.current;
    // tiptap 编辑器为 contenteditable 根；textarea 分支兼容侧栏 ComposerField 复用
    const el =
      root?.querySelector?.('textarea.composer-textarea') ??
      root?.querySelector?.('textarea') ??
      root?.querySelector?.('[contenteditable="true"]');
    if (el instanceof HTMLElement) {
      el.focus();
    }
  }, []);

  // tiptap 菜单 open-schedule 动作：清空输入并转交宿主开面板（不落输入，对齐原文本注入语义）
  const handleSlashMenuPick = useCallback(() => {
    setChatInput('');
    onOpenSchedule();
    requestAnimationFrame(focusComposerTextarea);
  }, [focusComposerTextarea, onOpenSchedule, setChatInput]);

  const handleRemoveAttachment = useCallback(
    (name: string) => {
      setAttachments((prev) => prev.filter((x) => x.name !== name));
    },
    [setAttachments]
  );

  return (
    <AppErrorBoundary variant="compact" title="输入区出错">
      <div
        ref={wrapperRef}
        className={`${styles.composerWrapper}${className ? ` ${className}` : ''}`}
      >
        <ChatQueuePanel
          queue={queuedMessages}
          onSendNow={onSendQueuedNow ?? (() => {})}
          onEdit={onEditQueued ?? (() => {})}
          onDelete={onDeleteQueued ?? (() => {})}
        />
        <TiptapComposerField
          containerRef={fieldContainerRef}
          value={chatInput}
          onChange={(val) => {
            setChatInput(val);
            // 输入前缀斜杠时预载 skill 命令（tiptap 菜单经引用桥接即时并入）
            if (val.startsWith('/') && !val.includes(' ')) {
              void loadSkillSlash();
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
          baseSlashCommands={filteredCommands}
          onSlashMenuPick={handleSlashMenuPick}
          emptyKind={emptyKind}
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
