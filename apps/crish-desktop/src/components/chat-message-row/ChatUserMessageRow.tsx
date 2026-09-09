import { useToast } from '../../services/toast/ToastContext';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './ChatMessageRow.module.css';
import { Tooltip } from '../ui';
import type { SessionMessage } from '../../store/types';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { Pin } from 'lucide-react';
import {
  copyTextBestEffort,
  isUserBubbleLong,
  messageRowAriaLabel,
  userBubbleDisplayText,
  userBubbleExpandAria,
} from './chatMessageRowUtils';
import { UserMessageActionsBar } from './MessageActionsBar';
import { openFileInPanel } from '../../api/filePanelOpener';
import { isAbsoluteFsPath, resolveWorkspacePath } from '../../api/workspaceFsApi';
import {
  AttachmentCard,
  normalizeMessageAttachments,
  type AttachmentItem,
} from '../chat-attachment/AttachmentCard';
import type { ChatAttachment } from '../../hooks/useChatStream';

export type ChatUserMessageRowProps = {
  msg: SessionMessage;
  isPinned: boolean;
  isSearchHit: boolean;
  isExpanded: boolean;
  onToggleExpand: (msgId: string) => void;
  onTogglePin: (msgId: string) => void;
  /** 会话最后一条 user：挂消息级撤回（用户锁：入口在对话里，不在 composer） */
  isLastUser?: boolean;
  onRetract?: () => void;
  /** 就地编辑消息模式（受控，由父级 composerElement 驱动） */
  isEditing?: boolean;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  /** 100% 复用的 ChatComposer 组件节点（单实例转移） */
  composerElement?: React.ReactNode;
  /** 向后兼容保留 */
  onEditMessageAndResend?: (
    targetMsgId: string,
    newText: string,
    newAttachments: ChatAttachment[]
  ) => Promise<void>;
  messageIndex: number;
  virtualScrollManager: VirtualScrollManager | null;
  onOpenPath?: (filePath: string) => void;
};

function userRowPropsEqual(
  prev: ChatUserMessageRowProps,
  next: ChatUserMessageRowProps
): boolean {
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.status === next.msg.status &&
    prev.msg.text === next.msg.text &&
    prev.msg.timestamp === next.msg.timestamp &&
    prev.isPinned === next.isPinned &&
    prev.isSearchHit === next.isSearchHit &&
    prev.isExpanded === next.isExpanded &&
    prev.isEditing === next.isEditing &&
    prev.composerElement === next.composerElement &&
    prev.onStartEdit === next.onStartEdit &&
    prev.onCancelEdit === next.onCancelEdit &&
    prev.onToggleExpand === next.onToggleExpand &&
    prev.onTogglePin === next.onTogglePin &&
    prev.isLastUser === next.isLastUser &&
    prev.onRetract === next.onRetract &&
    prev.onEditMessageAndResend === next.onEditMessageAndResend &&
    prev.messageIndex === next.messageIndex &&
    prev.virtualScrollManager === next.virtualScrollManager &&
    prev.onOpenPath === next.onOpenPath &&
    prev.msg.images === next.msg.images &&
    prev.msg.attachments === next.msg.attachments
  );
}

const ChatUserMessageRowInner: React.FC<ChatUserMessageRowProps> = ({
  msg,
  isPinned,
  isSearchHit,
  isExpanded,
  onToggleExpand,
  onTogglePin,
  isLastUser = false,
  onRetract,
  isEditing = false,
  onStartEdit,
  onCancelEdit: _onCancelEdit,
  composerElement,
  onEditMessageAndResend: _onEditMessageAndResend,
  messageIndex: _messageIndex,
  virtualScrollManager,
  onOpenPath,
}) => {
  void _messageIndex;
  void _onCancelEdit;
  void _onEditMessageAndResend;
  const { showToast } = useToast();

  const isLong = isUserBubbleLong(msg.text);
  // 真实签名：userBubbleDisplayText 仅接收 2 个参数 (text, isExpanded)
  const displayText = userBubbleDisplayText(msg.text, isExpanded);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  // 真实签名：messageRowAriaLabel 接收单对象入参
  const rowAria = messageRowAriaLabel({
    role: 'user',
    isPinned,
    status: msg.status,
  });

  // 单轨归一化提取并去重
  const allCardItems = useMemo<AttachmentItem[]>(
    () => normalizeMessageAttachments(msg.attachments, msg.images),
    [msg.attachments, msg.images]
  );

  const handleOpenPath = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      const trimmed = filePath.trim();
      if (!trimmed) return;
      // F2 残留防护：data:/blob:/http(s) 非本地打开目标，禁止盲传区外绝对 source
      if (/^(data:|blob:|https?:)/i.test(trimmed)) {
        showToast('该附件无工作区路径可打开');
        return;
      }
      if (onOpenPath) {
        onOpenPath(trimmed);
        return;
      }
      const safe = resolveWorkspacePath(trimmed);
      if (safe) {
        openFileInPanel(safe);
        return;
      }
      if (isAbsoluteFsPath(trimmed)) {
        void import('../../api/hostOpenersApi').then(({ openPathDefault }) => {
          openPathDefault(trimmed).catch(() => {
            showToast('无法打开该文件');
          });
        });
        return;
      }
      showToast('文件不在当前工作区内');
    },
    [onOpenPath, showToast]
  );

  useEffect(() => {
    return () => {
      if (copiedTimer.current != null) {
        window.clearTimeout(copiedTimer.current);
      }
    };
  }, []);

  // 虚拟滚动高度同步与失效通知
  useEffect(() => {
    if (msg.status === 'processing') return;
    virtualScrollManager?.invalidateActual(msg.id);
  }, [
    msg.text,
    msg.id,
    msg.status,
    msg.images,
    msg.attachments,
    virtualScrollManager,
  ]);

  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!virtualScrollManager || !rowRef.current) return;
    const h = rowRef.current.offsetHeight;
    if (h > 0) virtualScrollManager.setActual(msg.id, h);
  });

  const handleCopy = useCallback(() => {
    const text = msg.text || '';
    if (!text) return;
    void copyTextBestEffort(text).then((ok) => {
      if (!ok) {
        showToast('复制失败');
        return;
      }
      setCopied(true);
      if (copiedTimer.current != null) {
        window.clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [msg.text, showToast]);

  const retractHandler = isLastUser && onRetract ? onRetract : undefined;

  const toggleExpand = useCallback(() => {
    if (isLong) {
      const sel = window.getSelection()?.toString();
      if (sel) return;
      onToggleExpand(msg.id);
    }
  }, [isLong, msg.id, onToggleExpand]);

  const onBubbleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isLong) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggleExpand(msg.id);
      }
    },
    [isLong, msg.id, onToggleExpand]
  );

  const hasAttachmentCards = allCardItems.length > 0;
  // 核心判定：无文本且非排队态时，空气泡彻底销毁为 null（NEG-06）
  const hasTextContent = Boolean(displayText && displayText.trim()) || msg.status === 'queued';

  const isEditingRow = Boolean(isEditing && composerElement);

  useEffect(() => {
    virtualScrollManager?.invalidateActual(msg.id);
  }, [isEditingRow, virtualScrollManager, msg.id]);

  return (
    <div
      ref={rowRef}
      className={`${styles.row} ${styles.rowUser} msg-row msg-row-user${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`}
      data-testid="chat-user-message-row"
      data-msg-id={msg.id}
      data-role="user"
      data-pinned={isPinned ? 'true' : undefined}
      data-session-user-row
      role="article"
      aria-label={rowAria}
    >
      <div
        className={`${styles.userStack}${isEditingRow ? ` ${styles.userStackEditing}` : ''}`}
        data-editing={isEditingRow ? 'true' : undefined}
      >
        {/* 固定徽标 */}
        {isPinned ? (
          <Tooltip content="已固定">
            <span className={styles.pinBadge} aria-hidden="true">
              <Pin size={11} strokeWidth={2.25} />
              已固定
            </span>
          </Tooltip>
        ) : null}

        {isEditingRow ? (
          <div
            className={styles.rowComposerHost}
            data-testid="in-place-user-editor"
          >
            {composerElement}
          </div>
        ) : (
          <>
            {/* 统一类输入框卡片：内嵌顶部附件卡片横排流 + 底部正文文本 */}
            {hasAttachmentCards || hasTextContent ? (
              <div
                className={`${styles.userBubble} ${isLong ? styles.userBubbleExpandable : ''}`}
                onClick={toggleExpand}
                onKeyDown={onBubbleKeyDown}
                style={{
                  cursor: isLong ? 'pointer' : 'default',
                }}
                role={isLong ? 'button' : undefined}
                tabIndex={isLong ? 0 : undefined}
                aria-expanded={isLong ? isExpanded : undefined}
                aria-label={isLong ? userBubbleExpandAria(isExpanded) : undefined}
              >
                {/* 1. 顶部：内嵌 58×58 附件卡片横排流 */}
                {hasAttachmentCards ? (
                  <div
                    className={styles.userAttachmentStrip}
                    data-testid="user-attachment-strip"
                    role="list"
                    aria-label={`附件列表，共 ${allCardItems.length} 个`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {allCardItems.map((item, idx) => (
                      <AttachmentCard
                        key={item.id || item.path || `${item.name}-${idx}`}
                        item={item}
                        onClick={(it) => {
                          if (it.path) {
                            handleOpenPath(it.path);
                          } else if (
                            it.dataUrl &&
                            (it.dataUrl.startsWith('data:') ||
                              it.dataUrl.startsWith('blob:'))
                          ) {
                            const w = window.open('');
                            if (w) {
                              w.document.write(
                                `<img src="${it.dataUrl}" style="max-width:100%;height:auto;display:block;margin:auto;" />`
                              );
                            }
                          } else {
                            showToast('该附件无物理路径可打开');
                          }
                        }}
                      />
                    ))}
                  </div>
                ) : null}

                {/* 2. 底部：正文文本 */}
                {hasTextContent ? (
                  <div className={styles.userBubbleText}>
                    {displayText}
                    {msg.status === 'queued' ? (
                      <span className={styles.queued}>排队中</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* 3. 底部悬浮操作栏 */}
            <UserMessageActionsBar
              timestamp={msg.timestamp}
              isPinned={isPinned}
              copied={copied}
              onCopy={handleCopy}
              onTogglePin={() => onTogglePin(msg.id)}
              onRetract={retractHandler}
              onEdit={onStartEdit}
              alwaysVisible={Boolean(retractHandler)}
            />
          </>
        )}
      </div>
    </div>
  );
};

export const ChatUserMessageRow = React.memo(
  ChatUserMessageRowInner,
  userRowPropsEqual
);

ChatUserMessageRow.displayName = 'ChatUserMessageRow';
