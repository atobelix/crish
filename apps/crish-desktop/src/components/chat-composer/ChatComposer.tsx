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
 *
 * F1-γ 输入契约化：主输入不再硬绑富文本——
 * - 核心输入契约（ComposerFieldProps，composerTypes.ts canonical）统一装配 fieldContract；
 * - 默认主路 = TiptapComposerField（React.lazy 软接 + Suspense）；
 * - 富文本装配失败（模块加载 / 渲染抛错，InputFieldErrorBoundary 捕获）→
 *   回落 ComposerField（textarea）兜底，纯文本可发送；附件/权限/队列保持壳层职责。
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { Button, Tooltip } from '../ui';
import { shouldSuppressMenuReopen } from '../ui/Menu';
import type { PermissionMode } from '../../api/permissionModes';
import type { ChatAttachment, QueuedMessage } from '../../hooks/useChatStream';
import { ComposerField } from './ComposerField';
import type { ComposerFieldProps } from './composerTypes';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';
import { ChatQueuePanel } from './ChatQueuePanel';
import { ComposerDropHost } from './ComposerDropHost';
import { ComposerFusedTrigger } from './ComposerFusedTrigger';

export type { ComposerFieldProps } from './composerTypes';
export { ComposerField, STOP_TOOLTIP } from './ComposerField';

/** 富文本输入（默认主路）：React.lazy 软接，装配失败回落 textarea（F1-γ） */
const TiptapComposerFieldLazy = React.lazy(() =>
  import('./TiptapComposerField').then((m) => ({
    default: m.TiptapComposerField,
  }))
);

/** 富文本输入装配失败兜底边界：捕获 lazy 加载 / 渲染错误 → 通知宿主切 textarea */
class InputFieldErrorBoundary extends React.Component<
  { onFail: () => void; children?: React.ReactNode },
  { failed: boolean }
> {
  state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onFail();
  }

  render(): React.ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

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
  /** 点附件 / 文件 mention → files / file-viewer 叶；不传则不接线 */
  onOpenPath?: (filePath: string) => void;
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
  onOpenPath,
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

  /** F1-γ：富文本装配失败（lazy 加载 / 渲染抛错）后永久回落 textarea 分支 */
  const [richTextFailed, setRichTextFailed] = useState(false);

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
    mo.observe(observed, {
      attributes: true,
      attributeFilter: ['data-empty-kind'],
    });
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

  const handleFileOpenClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onOpenPath) return;
      const t =
        e.target instanceof Element
          ? e.target
          : e.target instanceof Node
            ? e.target.parentElement
            : null;
      if (!t) return;
      if (t.closest('.chat-attach-remove')) return;
      const el = t.closest('[data-file-open-path]');
      if (!(el instanceof HTMLElement)) return;
      const path = (el.getAttribute('data-file-open-path') || '').trim();
      if (!path || /^(note|notebook)(:|$)/i.test(path)) return;
      if (!/[\\/]/.test(path) && !/\.[A-Za-z0-9]{1,12}$/.test(path)) return;
      e.preventDefault();
      e.stopPropagation();
      onOpenPath(path);
    },
    [onOpenPath]
  );

  // 草稿原子保护：在前置校验失败或 IPC 发送未成功时，自动将已发送的内容原地回填至输入框
  const handleProtectedSend = useCallback(async () => {
    const rawInput = chatInput;
    if (!rawInput.trim() && attachments.length === 0) return;

    try {
      await Promise.resolve(onSend());
    } catch (err) {
      console.warn('[ChatComposer] send failed, restoring draft:', err);
      if (rawInput) {
        setChatInput(rawInput);
        try {
          const { getCompositionRoot } =
            await import('../../app/compositionRoot');
          const root = getCompositionRoot();
          const activeSessionId =
            root.session.getActiveSessionId?.() ??
            root.session.getState().activeSessionId;
          if (activeSessionId) {
            root.session.getState().setComposerDraft(activeSessionId, rawInput);
          }
        } catch {
          /* swallow-ok: 草稿持久化失败不阻断回填 */
        }
      }
    }
  }, [attachments.length, chatInput, onSend, setChatInput]);

  // ── F1-γ 核心输入契约（canonical）：富文本 / textarea 共用同一契约对象 ───────
  // 附件（ComposerAttachmentBar + 隐藏 file input）/ 权限 / 队列为壳层职责，不塞入契约；
  // 发送底层只吃纯文本（useSlashSend chatInput.trim()），提取层归各变体。
  const fieldContract = useMemo<ComposerFieldProps>(
    () => ({
      value: chatInput,
      onChange: (val) => {
        setChatInput(val);
        // 输入前缀斜杠时预载 skill 命令（tiptap 菜单经引用桥接即时并入）
        if (val.startsWith('/') && !val.includes(' ')) {
          void loadSkillSlash();
        }
      },
      onSend: handleProtectedSend,
      canSend,
      isComposing,
      setIsComposing,
      isProcessing,
      onStop,
      onForceStop,
      onPaste: (e) => {
        void onPasteImage(e);
      },
      placeholder: '输入消息，或键入 / 打开命令…（可粘贴截图）',
      processingPlaceholder: '输入排队消息…（当前回复结束后发送，可粘贴截图）',
      ariaLabel: '主对话输入',
      containerRef: fieldContainerRef,
    }),
    [
      chatInput,
      setChatInput,
      loadSkillSlash,
      handleProtectedSend,
      canSend,
      isComposing,
      setIsComposing,
      isProcessing,
      onStop,
      onForceStop,
      onPasteImage,
    ]
  );

  /**
   * 统一输入区装配：默认主路 = TiptapComposerField（React.lazy 软接 + Suspense，
   * 加载期以 textarea 同契约兜底渲染）；富文本装配失败（lazy 加载 / 渲染抛错，
   * InputFieldErrorBoundary 捕获）→ 永久回落 ComposerField（textarea），纯文本可发送。
   */
  const renderInputField = () => {
    if (richTextFailed) {
      return <ComposerField {...fieldContract} />;
    }
    return (
      <InputFieldErrorBoundary onFail={() => setRichTextFailed(true)}>
        <React.Suspense fallback={<ComposerField {...fieldContract} />}>
          <TiptapComposerFieldLazy
            {...fieldContract}
            baseSlashCommands={filteredCommands}
            onSlashMenuPick={handleSlashMenuPick}
            emptyKind={emptyKind}
            onFilesSelected={onFilesSelected}
          />
        </React.Suspense>
      </InputFieldErrorBoundary>
    );
  };

  return (
    <AppErrorBoundary variant="compact" title="输入区出错">
      <ComposerDropHost
        ref={wrapperRef}
        className={`${styles.composerWrapper}${className ? ` ${className}` : ''}`}
        data-input-field={richTextFailed ? 'textarea' : 'rich-text'}
        onClick={handleFileOpenClick}
        onDropFiles={(files) => {
          void onFilesSelected(files);
        }}
      >
        <ChatQueuePanel
          queue={queuedMessages}
          onSendNow={onSendQueuedNow ?? (() => {})}
          onEdit={onEditQueued ?? (() => {})}
          onDelete={onDeleteQueued ?? (() => {})}
        />
        {renderInputField()}

        <ComposerAttachmentBar
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
          {...(onOpenPath ? { onOpenPath } : {})}
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
            <Tooltip content="添加文件、技能、扩展…" disabled={showPlusMenu}>
              <Button
                ref={plusBtnRef}
                type="button"
                variant="ghost"
                size="sm"
                className={`${styles.plusBtn} ${showPlusMenu ? styles.isOpen : ''}`}
                aria-label="打开添加菜单"
                aria-haspopup="menu"
                aria-expanded={showPlusMenu}
                aria-controls={showPlusMenu ? plusMenuId : undefined}
                onClick={() => {
                  if (shouldSuppressMenuReopen(plusBtnRef.current)) return;
                  if (showPlusMenu) {
                    setShowPlusMenu(false);
                    requestAnimationFrame(() => plusBtnRef.current?.focus());
                  } else {
                    setShowPlusMenu(true);
                    onCloseSiblingMenus?.();
                  }
                }}
                icon={<Lucide.Plus size={16} aria-hidden />}
              />
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
          <div className={styles.rightActions}>
            <ComposerFusedTrigger>{rightActions}</ComposerFusedTrigger>
          </div>
        </div>
      </ComposerDropHost>
    </AppErrorBoundary>
  );
};
