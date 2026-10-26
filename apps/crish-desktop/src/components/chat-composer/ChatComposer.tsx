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
import React, { useCallback, useId, useMemo, useRef } from 'react';

import styles from './ChatComposer.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { Button, Input, Tooltip } from '../ui';
import { shouldSuppressMenuReopen } from '../ui/Menu';
import { ComposerField, STOP_TOOLTIP } from './ComposerField';
import type {
  ComposerFieldProps,
  ComposerSendApi,
  ChatComposerProps,
  ComposerLayoutVariant,
} from './composerTypes';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';
import { ComposerPermissionBar } from './ComposerPermissionBar';
import { ComposerPlanProgressBar } from './ComposerPlanProgressBar';
import { ComposerDropHost } from './ComposerDropHost';
import { ComposerFusedTrigger } from './ComposerFusedTrigger';
import { ComposerSendControls } from './ComposerSendControls';
import { useComposerMultiline } from './useComposerMultiline';
import { useComposerFileHandlers } from './useComposerFileHandlers';
import { ComposerEmbeddedNotice } from './ComposerEmbeddedNotice';
import { useComposerNotice } from './useComposerNotice';
import { useComposerEmptyKind } from './useComposerEmptyKind';
import { useComposerProtectedSend } from './useComposerProtectedSend';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';
import { ComposerFieldSlot } from './ComposerFieldSlot';

export type { ComposerFieldProps, ChatComposerProps, ComposerLayoutVariant };
export { ComposerField, STOP_TOOLTIP };
import { AppIcon } from '../ui/icons/index';

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
  isEditingMessage = false,
  onCancelEdit,
  layoutVariant = 'adaptive',
  disabled = false,
  placeholder,
}) => {
  const scopedSessionId = useScopedSessionId();
  const plusMenuId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fieldContainerRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const sendApiRef = useRef<ComposerSendApi | null>(null);

  const handleHostKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isEditingMessage && onCancelEdit && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancelEdit();
      }
    },
    [isEditingMessage, onCancelEdit]
  );

  const [richTextFailed, setRichTextFailed] = React.useState(false);
  const emptyKind = useComposerEmptyKind(emptyKindProp, wrapperRef);

  const {
    focusComposerTextarea,
    hiddenFileInputProps,
    handleRemoveAttachment,
    handleFileOpenClick,
  } = useComposerFileHandlers({
    setAttachments,
    scopedSessionId,
    fieldContainerRef,
    onOpenPath,
    onFilesSelected,
  });

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
        if (
          (val.startsWith('/') || val.startsWith('、')) &&
          !val.includes(' ')
        ) {
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
      onPaste: (e) => void onPasteImage(e),
      placeholder: placeholder || '输入消息，或键入 / 打开命令…（可粘贴截图）',
      processingPlaceholder: '输入排队消息…（当前回复结束后发送，可粘贴截图）',
      disabled,
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
      placeholder,
      disabled,
    ]
  );

  const multilineDetected = useComposerMultiline({
    text: chatInput,
    hasAttachments: attachments.length > 0,
    layoutRef,
    enabled: layoutVariant === 'adaptive' && !isEditingMessage,
  });

  const isMultiline =
    layoutVariant === 'multiline' ||
    (layoutVariant === 'adaptive' && multilineDetected);

  const { effectiveNotice, isClosing, handleDismissNotice } = useComposerNotice(
    {
      attachments,
      noticeProp,
      onDismissNotice,
    }
  );

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
        onKeyDown={handleHostKeyDown}
        onDropFiles={(files) => {
          void onFilesSelected(files);
        }}
      >
        {/* 主输入卡片（单卡片围合：内嵌顶槽 + 附件条 + 主输入网格） */}
        <div
          className={`${styles.composerCard}${isMultiline ? ` ${styles.isMultiline}` : ''}${disabled ? ` ${styles.disabled}` : ''}`}
          data-composer-card=""
          data-multiline={isMultiline ? '1' : '0'}
          data-empty-kind={emptyKind}
          data-disabled={disabled ? 'true' : undefined}
        >
          {/* 内嵌顶槽：权限审批条、目标/计划进度条、内嵌通知顶条共享 .composerCard 同一围合 */}
          {hasFloatLayer || effectiveNotice ? (
            <div
              className={styles.embeddedTopSlot}
              data-composer-top-slot-host=""
              data-closing={!hasFloatLayer && isClosing ? 'true' : undefined}
            >
              <div className={styles.embeddedTopSlotInner}>
                {permissionBarNode ||
                  (permissionBarProps ? (
                    <ComposerPermissionBar {...permissionBarProps} />
                  ) : null)}
                {planProgressNode ||
                  (planProgressProps ? (
                    <ComposerPlanProgressBar {...planProgressProps} />
                  ) : null)}
                {effectiveNotice ? (
                  <ComposerEmbeddedNotice
                    notice={effectiveNotice}
                    isClosing={isClosing}
                    onDismiss={handleDismissNotice}
                    onFeedback={onNoticeFeedback}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Layer 3: 附件与批注卡片区（内嵌于主输入卡片顶部） */}
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
            {/* 左侧控制区：[ ＋ 加号按钮 ] + [ 权限模式菜单（全场景常驻左槽） ] */}
            <div className={styles.actionLeft} data-composer-grid="left">
              <Tooltip
                content="添加文件或附件、使用 skill…"
                disabled={disabled || showPlusMenu}
              >
                <Button
                  ref={plusBtnRef}
                  type="button"
                  variant="ghost"
                  disabled={disabled}
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
                >
                  <AppIcon name="plus" size={14} aria-hidden />
                </Button>
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
                  if (!chatInput.startsWith('/'))
                    setChatInput(chatInput ? `/${chatInput}` : '/');
                  void loadSkillSlash();
                  requestAnimationFrame(focusComposerTextarea);
                }}
                onSelectSkillCommand={(cmd) => {
                  setChatInput(`${cmd} `);
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

            {/* 中间输入区：富文本/单多行自适应输入框 */}
            <div className={styles.fieldSlot} data-composer-grid="text">
              <ComposerFieldSlot
                fieldContract={fieldContract}
                filteredCommands={filteredCommands}
                emptyKind={emptyKind}
                onFilesSelected={onFilesSelected}
                onPasteFiles={onPasteFiles}
                richTextFailed={richTextFailed}
                onRichTextFail={() => setRichTextFailed(true)}
              />
            </div>

            {/* 右侧动作区：模型胶囊 + 语音/统计 + 墨绿正圆常驻发送按钮 */}
            <div className={styles.actionRight} data-composer-grid="right">
              <ComposerFusedTrigger>{rightActions}</ComposerFusedTrigger>
              {voiceStatsButton ||
                (showVoiceStatsButton ? (
                  <Tooltip content="语音输入 / 上下文统计">
                    <Button
                      type="button"
                      variant="ghost"
                      className={styles.actionCircleBtn}
                      aria-label="语音输入或上下文统计"
                    >
                      <AppIcon name="bar-chart" size={16} aria-hidden />
                    </Button>
                  </Tooltip>
                ) : null)}
              {isEditingMessage && onCancelEdit ? (
                <Tooltip content="取消编辑 (Esc)">
                  <Button
                    type="button"
                    variant="ghost"
                    className={styles.cancelEditBtn}
                    onClick={onCancelEdit}
                    data-testid="composer-cancel-edit-btn"
                    aria-label="取消编辑"
                  >
                    <AppIcon name="x" size={16} aria-hidden />
                  </Button>
                </Tooltip>
              ) : null}
              <ComposerSendControls
                appearance="circle"
                canSend={!disabled && canSend}
                disabled={disabled}
                isProcessing={isProcessing}
                onSend={() => {
                  if (disabled) return;
                  if (sendApiRef.current) sendApiRef.current.flushAndSend();
                  else void handleProtectedSend();
                }}
                onStop={onStop}
                onForceStop={onForceStop}
              />
            </div>
          </div>

          <Input
            bare
            ref={fileInputRef as React.RefObject<HTMLInputElement>}
            {...hiddenFileInputProps}
          />
        </div>
      </ComposerDropHost>
    </AppErrorBoundary>
  );
};
