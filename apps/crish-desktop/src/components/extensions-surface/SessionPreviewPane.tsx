import React, { useState, useEffect } from 'react';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import type {
  DetectedExternalSession,
  MappedImportSession,
} from '../../api/import/types';
import { mapExternalSession } from '../../api/import/map';
import { MessageContent } from '../chat-message/MessageContent';
import chatStyles from '../chat-message-row/ChatMessageRow.module.css';
import styles from './ExternalSessionsWorkbench.module.css';

export interface SessionPreviewPaneProps {
  session: DetectedExternalSession | null;
  onImportAndResume: (session: DetectedExternalSession) => Promise<void>;
  onOpenExisting: (sessionId: string) => void;
  onDeleteExisting?: (sessionId: string) => void;
  existingSessionId?: string;
  isBusy: boolean;
}

export const SessionPreviewPane: React.FC<SessionPreviewPaneProps> = ({
  session,
  onImportAndResume,
  onOpenExisting,
  onDeleteExisting,
  existingSessionId,
  isBusy,
}) => {
  const [loading, setLoading] = useState(false);
  const [mapped, setMapped] = useState<MappedImportSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      setMapped(null);
      setError(null);
      setLoading(false);
      return;
    }

    let isCancelled = false;
    setLoading(true);
    setError(null);

    mapExternalSession(session)
      .then((res) => {
        if (!isCancelled) {
          setMapped(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!isCancelled) {
          setError(String(err?.message || err));
          setLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [session]);

  if (!session) {
    return (
      <div className={styles.previewEmptyPane}>
        <div className={styles.previewEmptyIconBox}>
          <AppIcon name="history" size={28} />
        </div>
        <div className={styles.previewEmptyTitle}>请在左侧选择对话记录</div>
      </div>
    );
  }

  const sourceName =
    session.source === 'claude-code' ? 'Claude Code' : 'Codex CLI';
  // 预览界面默认且恒定纯净：过滤无实际文本和思考的空工具调用步骤，仅展示人机核心对话
  const displayMessages = (mapped?.messages || []).filter((msg) => {
    if (msg.sender === 'user') {
      return Boolean(msg.text && msg.text.trim());
    }
    return Boolean(
      (msg.text && msg.text.trim()) || (msg.thinking && msg.thinking.trim())
    );
  });

  const count = mapped ? displayMessages.length : session.messageCount;
  const countText = count !== undefined ? ` · ${count} 条消息` : '';

  return (
    <div className={styles.previewContainer} data-testid="session-preview-pane">
      {/* 顶部 Header：极致克制 */}
      <div className={styles.previewHeader}>
        <div className={styles.previewHeaderInfo}>
          <div className={styles.previewTitleText}>
            {mapped?.title || session.title}
          </div>
          <div className={styles.previewSubtitleText}>
            {sourceName}
            {countText}
          </div>
        </div>

        <div className={styles.previewHeaderActions}>
          {existingSessionId ? (
            <div className={styles.existingActionGroup}>
              <Button
                variant="primary"
                size="sm"
                onClick={() => onOpenExisting(existingSessionId)}
              >
                <AppIcon name="external-link" size={13} />
                <span>打开已接续对话</span>
              </Button>
              {onDeleteExisting && (
                <Tooltip content="从本机移除此接续对话，重启后不再自动出现">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => onDeleteExisting(existingSessionId)}
                  >
                    <AppIcon name="trash" size={13} />
                    <span>删除该接续对话</span>
                  </Button>
                </Tooltip>
              )}
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={isBusy || loading}
              onClick={() => void onImportAndResume(session)}
            >
              {isBusy ? '正在接续…' : '导入并接续对话'}
            </Button>
          )}
        </div>
      </div>

      {/* 对话流区域：与主界面正常对话流同构 */}
      <div className={styles.previewStream}>
        {loading ? (
          <div className={styles.previewLoadingBox}>
            <AppIcon name="refresh" size={20} className={styles.spinning} />
            <span>正在提取对话内容…</span>
          </div>
        ) : error ? (
          <div className={styles.previewErrorBox}>
            <AppIcon name="alert-circle" size={18} />
            <span>解析出错：{error}</span>
          </div>
        ) : !mapped || displayMessages.length === 0 ? (
          <div className={styles.previewEmptyMessagesBox}>
            <span>该记录未检测到可解析的有效对话内容</span>
          </div>
        ) : (
          <div className={styles.previewMessagesList}>
            {displayMessages.map((msg, idx) => {
              const isUser = msg.sender === 'user';
              const key = msg.id || idx;

              if (isUser) {
                return (
                  <div
                    key={key}
                    className={`${chatStyles.row} ${chatStyles.rowUser}`}
                  >
                    <div className={chatStyles.userStack}>
                      <div className={chatStyles.userBubble}>
                        <div className={chatStyles.userBubbleContent}>
                          {msg.text}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              // 外部命令本身不重要，在预览中直接不展示冗余的外部工具卡片，仅展示思考折叠链（如果有）与 AI 回复正文
              const cleanMsg = {
                ...msg,
                toolCalls: undefined,
                blocks: undefined,
              };

              return (
                <div
                  key={key}
                  className={`${chatStyles.row} ${chatStyles.rowAssistant}`}
                >
                  <div className={chatStyles.messageContentWrapper}>
                    <MessageContent msg={cleanMsg} hideThinkingBlock={false} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
