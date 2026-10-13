import React, { useState, useEffect } from 'react';
import { Button } from '../ui';
import { AppIcon } from '../ui/icons/index';
import type {
  DetectedExternalSession,
  MappedImportSession,
} from '../../api/import/types';
import { mapExternalSession } from '../../api/import/map';
import styles from './ExtensionsMainSurface.module.css';

export interface SessionPreviewPaneProps {
  session: DetectedExternalSession | null;
  onImportAndResume: (session: DetectedExternalSession) => Promise<void>;
  onOpenExisting: (sessionId: string) => void;
  existingSessionId?: string;
  isBusy: boolean;
}

export const SessionPreviewPane: React.FC<SessionPreviewPaneProps> = ({
  session,
  onImportAndResume,
  onOpenExisting,
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
        <div className={styles.previewEmptyDesc}>
          选中后将直接展示对话内容并可一键导入接续
        </div>
      </div>
    );
  }

  const sourceName =
    session.source === 'claude-code' ? 'Claude Code' : 'Codex CLI';
  const count = mapped ? mapped.messages.length : session.messageCount;
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
            <Button
              variant="primary"
              size="sm"
              onClick={() => onOpenExisting(existingSessionId)}
            >
              打开已接续对话
            </Button>
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
        ) : !mapped || mapped.messages.length === 0 ? (
          <div className={styles.previewEmptyMessagesBox}>
            <span>该记录未检测到可解析的有效对话内容</span>
          </div>
        ) : (
          <div className={styles.previewMessagesList}>
            {mapped.messages.map((msg, idx) => {
              const isUser = msg.sender === 'user';
              const key = msg.id || idx;

              if (isUser) {
                return (
                  <div key={key} className={styles.previewUserRow}>
                    <div className={styles.previewUserBubble}>{msg.text}</div>
                  </div>
                );
              }

              return (
                <div key={key} className={styles.previewAssistantRow}>
                  {/* 可折叠思考过程 */}
                  {msg.thinking && (
                    <details className={styles.previewThinkingDetails}>
                      <summary className={styles.previewThinkingSummary}>
                        <AppIcon name="cpu" size={12} />
                        <span>思考过程</span>
                      </summary>
                      <div className={styles.previewThinkingContent}>
                        {msg.thinking}
                      </div>
                    </details>
                  )}

                  {/* 助手正文排版 */}
                  {msg.text && (
                    <div className={styles.previewAssistantText}>
                      {msg.text}
                    </div>
                  )}

                  {/* 紧凑轻量工具芯片 */}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className={styles.previewToolList}>
                      {msg.toolCalls.map((t, tidx) => (
                        <span
                          key={t.id || tidx}
                          className={styles.previewToolChip}
                        >
                          <AppIcon name="terminal" size={11} />
                          <span className={styles.previewToolName}>
                            {t.name}
                          </span>
                          {t.status && (
                            <span
                              className={
                                t.status === 'success'
                                  ? styles.previewToolSuccess
                                  : styles.previewToolError
                              }
                            >
                              {t.status === 'success' ? '调用成功' : '失败'}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
