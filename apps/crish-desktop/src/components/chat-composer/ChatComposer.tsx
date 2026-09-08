/**
 * 主对话输入区：四层空间垂直堆叠架构（Four-Layer Vertical Spatial Stacking Architecture）
 * 严格对齐 docs/ui-reference-alignment-audit/02-pixel-perfect-implementation-plan.md §4 与 reference/chat-composer-component/index.html (L269-420) / css/composer.css
 *
 * 【四层垂直空间层级】：
 * - Layer 1: 浮动权限审批条（ComposerPermissionBar）
 * - Layer 2: 目标/计划模式进度条（ComposerPlanProgressBar）
 * - Layer 3: 上下文与文件引用卡片区（ComposerAttachmentBar，24px 高度圆角芯片卡片）
 * - Layer 4: 主输入区（Composer Card：加号/权限盾牌 + 富文本/兜底输入 + 融合模型胶囊 + 统计/语音 + 墨绿实体正圆发送按钮）
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
import type {
  ComposerFieldProps,
  ComposerSendApi,
  ComposerPermissionBarProps,
  ComposerPlanProgressBarProps,
} from './composerTypes';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';
import { ComposerPermissionBar } from './ComposerPermissionBar';
import { ComposerPlanProgressBar } from './ComposerPlanProgressBar';
import { ChatQueuePanel } from './ChatQueuePanel';
import { ComposerDropHost } from './ComposerDropHost';
import { ComposerFusedTrigger } from './ComposerFusedTrigger';
import { removePendingFileAnnotation } from '../../api/workspaceFsApi';
import { ComposerSendControls } from './ComposerSendControls';
import { useComposerMultiline } from './useComposerMultiline';
import { useComposerHiddenFileInputProps } from '../../api/modelVisionSupport';
import {
  ComposerNoticeBar,
  type ComposerNotice,
} from './ComposerNoticeBar';
import { useComposerNotice } from './useComposerNotice';
import { useComposerEmptyKind } from './useComposerEmptyKind';
import { useComposerProtectedSend } from './useComposerProtectedSend';
import { InputFieldErrorBoundary } from './InputFieldErrorBoundary';

export type { ComposerFieldProps } from './composerTypes';
export { ComposerField, STOP_TOOLTIP } from './ComposerField';
export { ComposerPermissionBar } from './ComposerPermissionBar';
export type { ComposerPermissionBarProps } from './ComposerPermissionBar';
export { ComposerPlanProgressBar } from './ComposerPlanProgressBar';
export type { ComposerPlanProgressBarProps } from './ComposerPlanProgressBar';
export { ComposerAttachmentBar } from './ComposerAttachmentBar';
export type { ComposerAttachmentBarProps } from './ComposerAttachmentBar';
export { ComposerSendControls } from './ComposerSendControls';
export type { ComposerSendControlsProps } from './ComposerSendControls';
export { ComposerFusedTrigger } from './ComposerFusedTrigger';
export type { ComposerFusedTriggerProps } from './ComposerFusedTrigger';

/** 富文本输入（默认主路）：React.lazy 软接，装配失败回落 textarea（F1-γ） */
const TiptapComposerFieldLazy = React.lazy(() =>
  import('./TiptapComposerField').then((m) => ({
    default: m.TiptapComposerField,
  }))
);


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
  onPickFiles?: () => void | Promise<void>;
  /** 点附件 / 文件 mention → files / file-viewer 叶；不传则不接线 */
  onOpenPath?: (filePath: string) => void;
  showPlusMenu: boolean;
  setShowPlusMenu: (v: boolean) => void;
  permissionMode: PermissionMode;
  onPermissionChange: (m: PermissionMode) => void;
  onCloseSiblingMenus?: () => void;
  rightActions?: React.ReactNode;
  className?: string;
  queuedMessages?: QueuedMessage[];
  onSendQueuedNow?: (id: string) => void;
  onEditQueued?: (id: string) => void;
  onDeleteQueued?: (id: string) => void;
  /** 落地面态（session-empty）；未传时从 DOM 祖先 data-empty-kind 感知 */
  emptyKind?: string | null;
  /** Layer 1: 权限审批条节点或属性 */
  permissionBarNode?: React.ReactNode;
  permissionBarProps?: ComposerPermissionBarProps;
  /** Layer 2: 目标/计划进度条节点或属性 */
  planProgressNode?: React.ReactNode;
  planProgressProps?: ComposerPlanProgressBarProps;
  /** 右侧统计/语音按键自定义或显示开关 */
  voiceStatsButton?: React.ReactNode;
  showVoiceStatsButton?: boolean;
  /** 草稿撤销：当前会话是否存在可撤销的外部模板覆盖（sessionDraftManager） */
  hasUndo?: boolean;
  /** 草稿撤销动作（原位无损恢复） */
  handleUndoDraft?: () => void;
  /** 定向注入信号 tick，驱动编辑器占位符聚焦 */
  draftInjectionTick?: number;
  /** 剪贴板文件粘贴接管（从桌面/资源管理器复制文件直接 Ctrl+V 入队） */
  onPasteFiles?: (files: File[]) => void | Promise<void>;
  /** 输入框上方状态/错误提示条（极细浅描边通白背景，叹号hover，复制，反馈，关闭） */
  notice?: ComposerNotice | null;
  onDismissNotice?: () => void;
  onNoticeFeedback?: () => void;
};

export const ChatComposer: React.FC<ChatComposerProps> = ({
  chatInput,
  setChatInput,
  isComposing,
  setIsComposing,
  filteredCommands,
  loadSkillSlash,
  onPasteImage,
  onPasteFiles,
  notice: noticeProp,
  onDismissNotice,
  onNoticeFeedback,
  onSend,
  onStop,
  onForceStop,
  canSend,
  isProcessing,
  attachments,
  setAttachments,
  fileInputRef,
  onFilesSelected,
  onPickFiles,
  onOpenPath,
  showPlusMenu,
  setShowPlusMenu,
  permissionMode,
  onPermissionChange,
  onCloseSiblingMenus,
  rightActions,
  className,
  queuedMessages = [],
  onSendQueuedNow,
  onEditQueued,
  onDeleteQueued,
  emptyKind: emptyKindProp,
  permissionBarNode,
  permissionBarProps,
  planProgressNode,
  planProgressProps,
  voiceStatsButton,
  showVoiceStatsButton = false,
  hasUndo,
  handleUndoDraft,
  draftInjectionTick,
}) => {
  const plusMenuId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fieldContainerRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const sendApiRef = useRef<ComposerSendApi | null>(null);

  /** F1-γ：富文本装配失败（lazy 加载 / 渲染抛错）后永久回落 textarea 分支 */
  const [richTextFailed, setRichTextFailed] = useState(false);

  const emptyKind = useComposerEmptyKind(emptyKindProp, wrapperRef);

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

  const hiddenFileInputProps = useComposerHiddenFileInputProps(
    async (files) => {
      await onFilesSelected(files);
      requestAnimationFrame(focusComposerTextarea);
    }
  );

  const handleRemoveAttachment = useCallback(
    (identifier: string) => {
      setAttachments((prev) => {
        const targetIndex = prev.findIndex(
          (x) => (x.id && x.id === identifier) || x.name === identifier
        );
        if (targetIndex === -1) return prev;
        const target = prev[targetIndex];
        if (target?.annotation?.id) {
          removePendingFileAnnotation(target.annotation.id);
        }
        return prev.filter((_, idx) => idx !== targetIndex);
      });
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

  const handleProtectedSend = useComposerProtectedSend({
    chatInput,
    setChatInput,
    attachments,
    onSend,
  });

  // ── F1-γ 核心输入契约（canonical）：富文本 / textarea 共用同一契约对象 ───────
  const fieldContract = useMemo<ComposerFieldProps>(
    () => ({
      value: chatInput,
      onChange: (val) => {
        setChatInput(val);
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
      hideSendControls: true,
      sendApiRef,
      className: styles.fieldInGrid,
      hasUndo,
      handleUndoDraft,
      draftInjectionTick,
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
      hasUndo,
      handleUndoDraft,
      draftInjectionTick,
    ]
  );

  const isMultiline = useComposerMultiline({
    text: chatInput,
    hasAttachments: attachments.length > 0,
    layoutRef,
  });

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
            emptyKind={emptyKind}
            onFilesSelected={onFilesSelected}
            onPasteFiles={onPasteFiles}
          />
        </React.Suspense>
      </InputFieldErrorBoundary>
    );
  };

  const { effectiveNotice, handleDismissNotice } = useComposerNotice({
    attachments,
    noticeProp,
    onDismissNotice,
  });

  const hasFloatLayer = Boolean(
    permissionBarNode ||
      permissionBarProps ||
      planProgressNode ||
      planProgressProps
  );

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

        {/* 浮动层区域（Layer 1: 权限审批条 + Layer 2: 目标/计划进度条） */}
        {hasFloatLayer ? (
          <div className={styles.composerFloatZone} data-composer-float-zone="">
            {permissionBarNode ||
              (permissionBarProps ? (
                <ComposerPermissionBar {...permissionBarProps} />
              ) : null)}
            {planProgressNode ||
              (planProgressProps ? (
                <ComposerPlanProgressBar {...planProgressProps} />
              ) : null)}
          </div>
        ) : null}

        {/* 输入框上方精致提示条（极细浅描边通白背景，叹号hover详情，复制，反馈，关闭） */}
        {effectiveNotice ? (
          <div className={styles.composerNoticeZone} data-composer-notice-zone="">
            <ComposerNoticeBar
              notice={effectiveNotice}
              onDismiss={handleDismissNotice}
              onFeedback={onNoticeFeedback}
            />
          </div>
        ) : null}

        {/* 主输入卡片（Layer 4: 输入网格） */}
        <div
          className={`${styles.composerCard}${isMultiline ? ` ${styles.isMultiline}` : ''}`}
          data-composer-card=""
          data-multiline={isMultiline ? '1' : '0'}
          data-empty-kind={emptyKind}
        >
          {/* Layer 3: 附件与批注卡片区（内嵌于主输入卡片顶部，对齐图四） */}
          {attachments.length > 0 && (
            <ComposerAttachmentBar
              attachments={attachments}
              onRemoveAttachment={handleRemoveAttachment}
              {...(onOpenPath ? { onOpenPath } : {})}
            />
          )}

          {/* Layer 4: 主输入区网格布局 */}
          <div
            ref={layoutRef}
            className={styles.inputMainLayout}
            data-composer-layout=""
            data-composer-footer="1"
          >
            {/* 左侧控制区：[ ＋ 加号按钮 ] + [ 权限盾牌按钮 ]（icon-only 模式） */}
            <div className={styles.actionLeft} data-composer-grid="left">
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
                  icon={<Lucide.Plus size={14} aria-hidden />}
                />
              </Tooltip>
              <ComposePlusMenu
                id={plusMenuId}
                open={showPlusMenu}
                onClose={() => setShowPlusMenu(false)}
                onAddFiles={() => {
                  if (onPickFiles) {
                    void onPickFiles();
                    return;
                  }
                  requestAnimationFrame(() => {
                    if (fileInputRef.current) {
                      fileInputRef.current.value = '';
                      fileInputRef.current.click();
                    }
                  });
                }}
                onInsertSkillSlash={() => {
                  if (!chatInput.startsWith('/')) {
                    setChatInput(chatInput ? `/${chatInput}` : '/');
                  }
                  void loadSkillSlash();
                  requestAnimationFrame(focusComposerTextarea);
                }}
                restoreFocusRef={plusBtnRef}
              />
            </div>

            {/* 中间输入区：富文本/单多行自适应输入框 */}
            <div className={styles.fieldSlot} data-composer-grid="text">
              {renderInputField()}
            </div>

            {/* 权限模式切换按钮（icon-only 模式） */}
            <div className={styles.permSlot} data-composer-grid="perm">
              <PermissionModeMenu
                iconOnly
                mode={permissionMode}
                onChange={(m) => {
                  onPermissionChange(m);
                  setShowPlusMenu(false);
                  onCloseSiblingMenus?.();
                }}
              />
            </div>

            {/* 右侧动作区：[ 3.7 Sonnet ⏐ High ] 融合模型胶囊 + 语音/统计 + 墨绿正圆发送按钮 */}
            <div className={styles.actionRight} data-composer-grid="right">
              <ComposerFusedTrigger>{rightActions}</ComposerFusedTrigger>
              {voiceStatsButton ||
                (showVoiceStatsButton ? (
                  <Tooltip content="语音输入 / 上下文统计">
                    <button
                      type="button"
                      className={styles.actionCircleBtn}
                      aria-label="语音输入或上下文统计"
                    >
                      <Lucide.BarChart2 size={16} aria-hidden />
                    </button>
                  </Tooltip>
                ) : null)}
              <ComposerSendControls
                appearance="circle"
                canSend={canSend}
                isProcessing={isProcessing}
                onSend={() => {
                  if (sendApiRef.current) {
                    sendApiRef.current.flushAndSend();
                    return;
                  }
                  void handleProtectedSend();
                }}
                onStop={onStop}
                onForceStop={onForceStop}
              />
            </div>
          </div>

          <input
            ref={fileInputRef as React.RefObject<HTMLInputElement>}
            {...hiddenFileInputProps}
          />
        </div>
      </ComposerDropHost>
    </AppErrorBoundary>
  );
};
