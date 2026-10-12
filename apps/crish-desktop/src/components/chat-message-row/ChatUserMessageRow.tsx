import { useToast } from '../../services/toast/ToastContext';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './ChatMessageRow.module.css';
import { Tooltip } from '../ui';
import type { SessionMessage } from '../../store/types';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import {
  copyTextBestEffort,
  isUserBubbleLong,
  messageRowAriaLabel,
  userBubbleDisplayText,
  userBubbleExpandAria,
} from './chatMessageRowUtils';
import { DEFAULT_PIN_COLOR } from '../../utils/pinColor';
import { UserMessageActionsBar } from './MessageActionsBar';
import { openFileInPanel } from '../../api/filePanelOpener';
import {
  isAbsoluteFsPath,
  resolveWorkspacePath,
} from '../../api/workspaceFsApi';
import {
  AttachmentCard,
  normalizeMessageAttachments,
  type AttachmentItem,
} from '../chat-attachment/AttachmentCard';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { isBusyRetryPending } from '../../api/sessionStreamManager';
import { DOMAIN_MESSAGES } from '../../api/userFacingErrors';
import { useInvalidateActualOnChange } from './useInvalidateActualOnChange';
import { useUserBubbleEntrance } from './useUserBubbleEntrance';

export interface ParsedStructuredUserText {
  isStructured: boolean;
  userInputText: string;
  contextStateText?: string;
}

export function parseStructuredUserText(
  text: string | undefined | null
): ParsedStructuredUserText {
  const raw = text || '';
  const userTag = '[用户输入]';
  const ctxTag = '[系统环境上下文]';
  const userIdx = raw.indexOf(userTag);
  const ctxIdx = raw.indexOf(ctxTag);

  if (userIdx === -1 || ctxIdx === -1) {
    return { isStructured: false, userInputText: raw };
  }

  let userInputText =
    userIdx < ctxIdx
      ? raw.slice(userIdx + userTag.length, ctxIdx).trim()
      : raw.slice(userIdx + userTag.length).trim();
  let contextStateText =
    userIdx < ctxIdx
      ? raw.slice(ctxIdx + ctxTag.length).trim()
      : raw.slice(ctxIdx + ctxTag.length, userIdx).trim();

  if (userInputText.startsWith(':') || userInputText.startsWith('：')) {
    userInputText = userInputText.slice(1).trim();
  }
  if (contextStateText.startsWith(':') || contextStateText.startsWith('：')) {
    contextStateText = contextStateText.slice(1).trim();
  }

  return { isStructured: true, userInputText, contextStateText };
}

export type ChatUserMessageRowProps = {
  msg: SessionMessage;
  isPinned: boolean;
  pinnedColor?: string;
  isSearchHit: boolean;
  isExpanded: boolean;
  onToggleExpand: (msgId: string) => void;
  onTogglePin: (msgId: string, color?: string) => void;
  /** 会话最后一条 user：挂消息级撤回（用户锁：入口在对话里，不在 composer） */
  isLastUser?: boolean;
  onRetract?: () => void;
  /** 就地编辑消息模式（受控，由父级 composerElement 驱动） */
  isEditing?: boolean;
  onStartEdit?: ((sanitizedMsg?: SessionMessage) => void) | (() => void);
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
    prev.msg.images === next.msg.images &&
    prev.msg.attachments === next.msg.attachments &&
    prev.msg.metadata === next.msg.metadata &&
    prev.isPinned === next.isPinned &&
    prev.pinnedColor === next.pinnedColor &&
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
    prev.virtualScrollManager === next.virtualScrollManager &&
    prev.onOpenPath === next.onOpenPath &&
    prev.messageIndex === next.messageIndex &&
    prev.onEditMessageAndResend === next.onEditMessageAndResend
  );
}

const ChatUserMessageRowInner: React.FC<ChatUserMessageRowProps> = ({
  msg,
  isPinned,
  pinnedColor,
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
  messageIndex,
  virtualScrollManager,
  onOpenPath,
}) => {
  void _onCancelEdit;
  void _onEditMessageAndResend;
  const { showToast } = useToast();
  const { isEntering, handleAnimationEnd } = useUserBubbleEntrance(
    msg.id,
    msg.timestamp
  );

  const isLong = isUserBubbleLong(msg.text);
  // 真实签名：userBubbleDisplayText 仅接收 2 个参数 (text, isExpanded)
  const displayText = userBubbleDisplayText(msg.text, isExpanded);

  const parsedStructured = useMemo(() => {
    const fromDisplay = parseStructuredUserText(displayText);
    if (fromDisplay.isStructured) {
      return fromDisplay;
    }
    const fromRaw = parseStructuredUserText(msg.text);
    if (fromRaw.isStructured) {
      return {
        isStructured: true,
        userInputText: userBubbleDisplayText(fromRaw.userInputText, isExpanded),
        contextStateText: fromRaw.contextStateText,
      };
    }
    return fromDisplay;
  }, [displayText, msg.text, isExpanded]);
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

  // 展开/收起/正文变化才作废实测。首帧跳过，避免挂载把已测高度抹掉。
  // 实测回写只允许经宿主 RO → useVirtualScroll.setActual（触发 actualTick）。
  useInvalidateActualOnChange(
    virtualScrollManager,
    msg.id,
    msg.status !== 'processing',
    [
      msg.text,
      msg.id,
      msg.status,
      msg.images,
      msg.attachments,
      isExpanded,
      virtualScrollManager,
    ]
  );

  const rowRef = useRef<HTMLDivElement>(null);

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

  const handleStartEdit = useCallback(() => {
    if (!onStartEdit) return;
    if (parsedStructured.isStructured) {
      const sanitizedMsg: SessionMessage = {
        ...msg,
        text: parsedStructured.userInputText,
      };
      const originalText = msg.text;
      let mutated = false;
      try {
        if (!Object.isFrozen(msg)) {
          (msg as { text?: string }).text = parsedStructured.userInputText;
          mutated = true;
        }
      } catch {
        /* swallow-ok: read-only object */
      }
      try {
        (onStartEdit as (m?: SessionMessage) => void)(sanitizedMsg);
      } finally {
        if (mutated) {
          try {
            (msg as { text?: string }).text = originalText;
          } catch {
            /* swallow-ok */
          }
        }
      }
      return;
    }
    onStartEdit();
  }, [msg, onStartEdit, parsedStructured]);

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
  const isQueued = msg.status === 'queued';
  const triggerSource = (msg.metadata as Record<string, unknown> | undefined)
    ?.triggerSource as string | undefined;
  const triggerBadgeText = useMemo(() => {
    if (triggerSource === 'system_timer') return '系统定时任务唤醒';
    if (triggerSource === 'cron') return '定时计划唤醒';
    if (triggerSource === 'subagent_complete') return '子代理完成通知';
    return null;
  }, [triggerSource]);

  const hasTextContent =
    Boolean(
      parsedStructured.isStructured
        ? (parsedStructured.userInputText &&
            parsedStructured.userInputText.trim()) ||
            parsedStructured.contextStateText
        : displayText && displayText.trim()
    ) ||
    isQueued ||
    Boolean(triggerBadgeText);
  // S7 只在串行守卫自动重试时作为 Tooltip；用户主动追问的排队不附这段文案。
  const queuedBusyTip = isQueued && isBusyRetryPending(msg.id);
  const queuedBadge = isQueued ? (
    queuedBusyTip ? (
      <Tooltip content={DOMAIN_MESSAGES.S7} side="top">
        <span className={styles.queued} role="status">
          <span className={styles.queuedBadge}>排队中</span>
        </span>
      </Tooltip>
    ) : (
      <span className={styles.queued} role="status">
        <span className={styles.queuedBadge}>排队中</span>
      </span>
    )
  ) : null;

  const isEditingRow = Boolean(isEditing && composerElement);

  useInvalidateActualOnChange(virtualScrollManager, msg.id, true, [
    isEditingRow,
    virtualScrollManager,
    msg.id,
  ]);

  return (
    <div
      ref={rowRef}
      className={`${styles.row} ${styles.rowUser} msg-row msg-row-user${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`}
      data-testid="chat-user-message-row"
      data-msg-id={msg.id}
      data-role="user"
      data-pinned={isPinned ? 'true' : undefined}
      data-editing={isEditingRow ? 'true' : undefined}
      data-session-user-row
      role="article"
      aria-label={rowAria}
    >
      <div
        className={`${styles.userStack}${isEditingRow ? ` ${styles.userStackEditing}` : ''}`}
        data-editing={isEditingRow ? 'true' : undefined}
      >
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
                className={`${styles.userBubble}${isEntering ? ` ${styles.userBubbleEntering}` : ''} ${isLong ? styles.userBubbleExpandable : ''}${isPinned ? ` ${styles.userBubblePinned}` : ''}`}
                data-entering={isEntering ? 'true' : undefined}
                data-first-message={messageIndex === 0 ? 'true' : undefined}
                onAnimationEnd={handleAnimationEnd}
                onClick={toggleExpand}
                onKeyDown={onBubbleKeyDown}
                style={{
                  cursor: isLong ? 'pointer' : 'default',
                  ...(isPinned
                    ? ({
                        '--user-bubble-pin-color':
                          pinnedColor || DEFAULT_PIN_COLOR,
                      } as React.CSSProperties)
                    : {}),
                }}
                role={isLong ? 'button' : undefined}
                tabIndex={isLong ? 0 : undefined}
                aria-expanded={isLong ? isExpanded : undefined}
                aria-label={
                  isLong ? userBubbleExpandAria(isExpanded) : undefined
                }
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

                {/* 1.5 触发源/系统定时任务标识 */}
                {triggerBadgeText ? (
                  <div
                    className={styles.triggerBadge}
                    data-testid="trigger-source-badge"
                    data-source={triggerSource}
                  >
                    <span aria-hidden="true">⏰</span>
                    <span>{triggerBadgeText}</span>
                  </div>
                ) : null}

                {/* 2. 底部：正文文本 */}
                {hasTextContent ? (
                  parsedStructured.isStructured ? (
                    <div
                      className={styles.userBubbleStructuredContent}
                      data-testid="user-bubble-structured"
                    >
                      {/* (a) 顶部主体段：用户的实际输入正文 */}
                      <div
                        className={styles.userBubbleText}
                        data-testid="user-bubble-main-input"
                      >
                        {parsedStructured.userInputText}
                        {queuedBadge}
                      </div>

                      {/* (b) 底部随附段：系统环境上下文信封 */}
                      {parsedStructured.contextStateText ? (
                        <div
                          className={styles.userBubbleContextEnvelope}
                          data-testid="user-bubble-context-envelope"
                          role="note"
                          aria-label="系统环境上下文"
                        >
                          <span className={styles.userBubbleContextBadge}>
                            [系统环境上下文]
                          </span>
                          <span className={styles.userBubbleContextContent}>
                            {parsedStructured.contextStateText}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className={styles.userBubbleText}>
                      {displayText}
                      {queuedBadge}
                    </div>
                  )
                ) : null}
              </div>
            ) : null}

            {/* 3. 底部悬浮操作栏 */}
            <UserMessageActionsBar
              timestamp={msg.timestamp}
              isPinned={isPinned}
              pinnedColor={pinnedColor}
              copied={copied}
              onCopy={handleCopy}
              onTogglePin={(color?: string) => onTogglePin(msg.id, color)}
              onRetract={retractHandler}
              onEdit={onStartEdit ? handleStartEdit : undefined}
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
