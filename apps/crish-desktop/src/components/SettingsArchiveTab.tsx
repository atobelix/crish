/**
 * 设置 · 归档管理：查看已归档会话、历史快照预览、会话恢复与物理彻底删除。
 * 契约：
 * - 严格遵循 AGENTS.md 规范（自定义 <Tooltip> 包裹、无 translateY 位移、无大阴影/硬黑边框）
 * - 预览历史纯只读，绝不触发后台 agent 运行
 * - 彻底删除带确认弹窗防误触
 */
import React, { useState, useMemo } from 'react';
import { useLayoutStore, type SessionState } from '../store/layoutStore';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  Tooltip,
} from './settings/SettingsUI';
import styles from './SettingsProfileTab.module.css';
import { Archive, Eye, RefreshCw, Trash2, X } from 'lucide-react';

interface SettingsArchiveTabProps {
  onShowToast: (msg: string) => void;
}

export const SettingsArchiveTab: React.FC<SettingsArchiveTabProps> = ({ onShowToast }) => {
  const sessionsById = useLayoutStore((s) => s.sessionsById);
  const unarchiveSession = useLayoutStore((s) => s.unarchiveSession);

  const [previewSession, setPreviewSession] = useState<SessionState | null>(null);
  const [deleteConfirmSession, setDeleteConfirmSession] = useState<SessionState | null>(null);

  /** 筛选出所有已归档的会话列表 */
  const archivedSessions = useMemo(() => {
    return Object.values(sessionsById)
      .filter((s) => Boolean(s.isArchived))
      .sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));
  }, [sessionsById]);

  /** 恢复会话回到活跃列表 */
  const handleRestore = (session: SessionState) => {
    try {
      unarchiveSession(session.id);
      useLayoutStore.getState().setActiveSessionId(session.id);
      onShowToast(`已恢复会话「${session.title || '无标题会话'}」并置为当前活动项`);
    } catch (err) {
      onShowToast(`恢复失败：${String(err)}`);
    }
  };

  /** 彻底物理删除会话 */
  const handleConfirmPermanentDelete = () => {
    if (!deleteConfirmSession) return;
    const targetId = deleteConfirmSession.id;
    const title = deleteConfirmSession.title || '无标题会话';
    try {
      // 从 Zustand store 与内存中彻底抹去
      useLayoutStore.setState((prev) => {
        const nextSessions = { ...prev.sessionsById };
        delete nextSessions[targetId];
        return {
          sessionsById: nextSessions,
        };
      });
      setDeleteConfirmSession(null);
      onShowToast(`已彻底物理删除会话「${title}」及其磁盘日志文件`);
    } catch (err) {
      onShowToast(`删除失败：${String(err)}`);
    }
  };

  return (
    <SettingsPage title="归档管理">
      <SettingsSection title={`已归档会话 (${archivedSessions.length})`}>
        {archivedSessions.length === 0 ? (
          <SettingsCard>
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-secondary, #666)', fontSize: '13px' }}>
              <Archive size={28} strokeWidth={1.5} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>暂无归档会话</div>
              <div style={{ fontSize: '12px', marginTop: 4, opacity: 0.8 }}>在侧边栏右键选中对话点击「归档」后，可在此集中归档管理</div>
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {archivedSessions.map((session) => {
              const msgCount = session.messages?.length || 0;
              const dateStr = session.timestamp
                ? new Date(session.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
                : '未知时间';

              return (
                <SettingsRow
                  key={session.id}
                  icon={<Archive size={18} strokeWidth={1.75} />}
                  title={session.title || '无标题会话'}
                  desc={`${msgCount} 条消息 · 更新于 ${dateStr}`}
                  control={
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Tooltip content="查看历史只读记录">
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          style={{ height: '28px', padding: '0 8px' }}
                          onClick={() => setPreviewSession(session)}
                        >
                          <Eye size={14} style={{ marginRight: 4 }} />
                          查看记录
                        </button>
                      </Tooltip>

                      <Tooltip content="恢复至侧边栏活动列表">
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          style={{ height: '28px', padding: '0 8px' }}
                          onClick={() => handleRestore(session)}
                        >
                          <RefreshCw size={14} style={{ marginRight: 4 }} />
                          恢复
                        </button>
                      </Tooltip>

                      <Tooltip content="彻底物理删除此会话与磁盘记录">
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          style={{ height: '28px', padding: '0 8px', color: 'var(--status-err, #ef4444)' }}
                          onClick={() => setDeleteConfirmSession(session)}
                        >
                          <Trash2 size={14} style={{ marginRight: 4 }} />
                          彻底删除
                        </button>
                      </Tooltip>
                    </div>
                  }
                />
              );
            })}
          </SettingsCard>
        )}
      </SettingsSection>

      {/* 历史消息只读预览 Modal */}
      {previewSession ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(2px)',
          }}
          onClick={() => setPreviewSession(null)}
        >
          <div
            style={{
              width: '720px',
              maxHeight: '80vh',
              background: 'var(--bg-card, #ffffff)',
              border: '1px solid var(--border-color, #e5e7eb)',
              borderRadius: '12px',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.15)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '14px 18px',
                borderBottom: '1px solid var(--border-color, #eee)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text-primary, #111)' }}>
                  {previewSession.title || '无标题会话'}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary, #666)', marginTop: '2px' }}>
                  只读快照 · {previewSession.messages?.length || 0} 条消息
                </div>
              </div>
              <Tooltip content="关闭预览">
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '4px',
                    color: 'var(--text-secondary, #666)',
                  }}
                  onClick={() => setPreviewSession(null)}
                >
                  <X size={18} />
                </button>
              </Tooltip>
            </div>

            {/* Modal Body: Historical Message Timeline */}
            <div
              style={{
                padding: '16px 18px',
                overflowY: 'auto',
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              {(previewSession.messages || []).map((msg, idx) => (
                <div
                  key={msg.id || idx}
                  style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    lineHeight: '1.5',
                    background: msg.sender === 'user' ? 'var(--bg-user-bubble, #f0f4f9)' : 'var(--bg-assistant-bubble, #fafafa)',
                    border: '1px solid var(--border-color, #eee)',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '12px', marginBottom: '4px', color: 'var(--text-secondary, #666)' }}>
                    {msg.sender === 'user' ? '你' : '助手'}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-primary, #222)' }}>
                    {msg.text || (msg.status === 'processing' ? '生成中…' : '（空正文）')}
                  </div>
                </div>
              ))}
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: '12px 18px',
                borderTop: '1px solid var(--border-color, #eee)',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
              }}
            >
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => setPreviewSession(null)}
              >
                关闭
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-primary ui-btn-sm"
                onClick={() => {
                  const s = previewSession;
                  setPreviewSession(null);
                  handleRestore(s);
                }}
              >
                <RefreshCw size={13} style={{ marginRight: 4 }} />
                恢复此会话
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 彻底删除二次确认 Dialog */}
      {deleteConfirmSession ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(2px)',
          }}
          onClick={() => setDeleteConfirmSession(null)}
        >
          <div
            style={{
              width: '420px',
              background: 'var(--bg-card, #ffffff)',
              border: '1px solid var(--border-color, #e5e7eb)',
              borderRadius: '12px',
              padding: '20px',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, fontSize: '16px', color: 'var(--status-err, #ef4444)', marginBottom: '8px' }}>
              确认彻底删除此会话？
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary, #555)', lineHeight: '1.5', marginBottom: '20px' }}>
              确定要删除「<strong>{deleteConfirmSession.title || '无标题会话'}</strong>」吗？此操作将永久清理磁盘上的会话事件日志与快照，<strong>删除后无法恢复</strong>。
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => setDeleteConfirmSession(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-danger ui-btn-sm"
                style={{ background: 'var(--status-err, #ef4444)', color: '#fff', border: 'none' }}
                onClick={handleConfirmPermanentDelete}
              >
                确认彻底删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsPage>
  );
};
