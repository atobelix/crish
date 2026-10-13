import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useToast } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/sessionStore';
import { importDetectedSessions } from '../../api/import/importSessions';
import { type DetectedExternalSession } from '../../api/import/types';
import { getWorkspacePath } from '../../api/workspaceFsApi';
import { navigateToChatSession } from '../../store/surfaceRouter';
import {
  loadExternalSessionsFromCache,
  getOrScanExternalSessions,
} from '../../api/import/externalSessionCache';
import { ImportPluginSettingsModal } from './ImportPluginSettingsModal';
import { SessionPreviewPane } from './SessionPreviewPane';
import styles from './ExtensionsMainSurface.module.css';

type FilterSource = 'workspace' | 'all' | 'claude' | 'codex';

export interface ExternalSessionsWorkbenchProps {
  onBackToChat?: () => void;
  onRefresh?: () => void;
}

export const ExternalSessionsWorkbench: React.FC<
  ExternalSessionsWorkbenchProps
> = ({ onBackToChat: _onBackToChat, onRefresh }) => {
  const { showToast } = useToast();
  const sessions = useSessionStore((s) => s.sessions);

  // 0ms 瞬时水合：优先读取持久化缓存，杜绝每次打开重复全盘扫描
  const [detected, setDetected] = useState<DetectedExternalSession[]>(() => {
    return loadExternalSessionsFromCache();
  });
  const [loading, setLoading] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [filterSource, setFilterSource] = useState<FilterSource>('workspace');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );

  const currentWorkspace = useMemo(() => {
    return (getWorkspacePath() || '').replace(/\\/g, '/').toLowerCase();
  }, []);

  // 建立 source:sourceSessionId -> Conex sessionId 的映射，支持一键直达历史对话
  const existingSessionMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      if (s.importMeta?.source && s.importMeta.sourceSessionId) {
        map.set(`${s.importMeta.source}:${s.importMeta.sourceSessionId}`, s.id);
      }
    }
    return map;
  }, [sessions]);

  // 扫描逻辑
  const handleScan = useCallback(
    async (force = true) => {
      setLoading(true);
      try {
        const result = await getOrScanExternalSessions(force);
        setDetected(result);
        onRefresh?.();
        if (force) {
          showToast(`扫描完成，共检测到 ${result.length} 个外部对话记录`);
        }
      } catch (err) {
        showToast('扫描外部会话记录失败: ' + String(err));
      } finally {
        setLoading(false);
      }
    },
    [showToast, onRefresh]
  );

  useEffect(() => {
    if (detected.length === 0) {
      void handleScan(false);
    }
  }, [detected.length, handleScan]);

  const isMatchingWorkspace = useCallback(
    (s: DetectedExternalSession) => {
      if (!currentWorkspace || !s.cwd) return false;
      const norm = s.cwd.replace(/\\/g, '/').toLowerCase();
      return (
        norm === currentWorkspace ||
        norm.startsWith(currentWorkspace + '/') ||
        currentWorkspace.startsWith(norm + '/')
      );
    },
    [currentWorkspace]
  );

  const filteredSessions = useMemo(() => {
    return detected.filter((s) => {
      if (filterSource === 'workspace' && !isMatchingWorkspace(s)) return false;
      if (filterSource === 'claude' && s.source !== 'claude-code') return false;
      if (filterSource === 'codex' && s.source !== 'codex') return false;
      return true;
    });
  }, [detected, filterSource, isMatchingWorkspace]);

  // 自动选中有且仅有的首项，或者如果选中项不在当前过滤集中时保持同步
  const activeSession = useMemo(() => {
    if (selectedSessionId) {
      const found = filteredSessions.find((s) => s.id === selectedSessionId);
      if (found) return found;
    }
    return filteredSessions[0] || null;
  }, [filteredSessions, selectedSessionId]);

  // 一键导入并打开该会话进入对话界面
  const handleImportAndResume = async (item: DetectedExternalSession) => {
    setImportingId(item.id);
    try {
      const res = await importDetectedSessions([item]);
      if (res.imported > 0 && res.sessionIds[0]) {
        showToast(`已接续对话：${item.title}`);
        onRefresh?.();
        navigateToChatSession(res.sessionIds[0]);
      } else if (res.skippedDuplicates > 0) {
        showToast('该会话此前已导入');
      }
    } catch (err) {
      showToast('导入失败: ' + String(err));
    } finally {
      setImportingId(null);
    }
  };

  const formatTime = (ts?: number) => {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return '';
    }
  };

  return (
    <div className={styles.workbenchContent}>
      {/* 头部摘要：纯净文字排版，大圆角容器，解耦二级设置 */}
      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <div className={styles.detailTitleInfo}>
            <div className={styles.detailTitle}>外部对话导入与接续</div>
            <div className={styles.detailSubtitle}>
              接续本机 Claude 与 Codex
              中的历史对话与任务，核验解析内容后一键导入并继续聊天
            </div>
          </div>
          <div className={styles.headerActions}>
            <Tooltip content="重新探测外部软件会话目录">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleScan(true)}
                disabled={loading}
              >
                <AppIcon
                  name="refresh"
                  size={13}
                  className={loading ? styles.spinning : ''}
                />
                <span>{loading ? '扫描中…' : '重新扫描'}</span>
              </Button>
            </Tooltip>
            <Tooltip content="配置外部对话扫描与路径设置">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowSettingsModal(true)}
              >
                <AppIcon name="settings" size={13} />
                <span>配置设置</span>
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* 外部会话双栏主区域：左侧列表 + 右侧深度解析核验面板 */}
      <div className={styles.splitWorkbenchBody}>
        {/* 左栏：会话列表 */}
        <div className={styles.sessionListPane}>
          <div className={styles.sessionFilterBar}>
            <div className={styles.filterTabs}>
              <Button
                size="xs"
                variant={filterSource === 'workspace' ? 'secondary' : 'ghost'}
                className={`${styles.filterTabBtn} ${filterSource === 'workspace' ? styles.activeTab : ''}`}
                onClick={() => setFilterSource('workspace')}
              >
                当前工作区
              </Button>
              <Button
                size="xs"
                variant={filterSource === 'all' ? 'secondary' : 'ghost'}
                className={`${styles.filterTabBtn} ${filterSource === 'all' ? styles.activeTab : ''}`}
                onClick={() => setFilterSource('all')}
              >
                全部
              </Button>
              <Button
                size="xs"
                variant={filterSource === 'claude' ? 'secondary' : 'ghost'}
                className={`${styles.filterTabBtn} ${filterSource === 'claude' ? styles.activeTab : ''}`}
                onClick={() => setFilterSource('claude')}
              >
                Claude
              </Button>
              <Button
                size="xs"
                variant={filterSource === 'codex' ? 'secondary' : 'ghost'}
                className={`${styles.filterTabBtn} ${filterSource === 'codex' ? styles.activeTab : ''}`}
                onClick={() => setFilterSource('codex')}
              >
                Codex
              </Button>
            </div>

            <span className={styles.sessionCountText}>
              共 {filteredSessions.length} 条
            </span>
          </div>

          <div className={styles.sessionCardsList}>
            {loading && detected.length === 0 ? (
              <div className={styles.emptyWorkbenchState}>
                <AppIcon name="refresh" size={20} className={styles.spinning} />
                <span>正在探测本地历史对话…</span>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className={styles.emptyWorkbenchState}>
                <AppIcon name="package" size={24} />
                <div className={styles.emptyTitle}>未发现匹配记录</div>
                <div className={styles.emptyDesc}>
                  {filterSource === 'workspace'
                    ? '当前工作区未找到，可切换到「全部」'
                    : '可检查外部软件目录设置'}
                </div>
              </div>
            ) : (
              filteredSessions.map((item) => {
                const key = `${item.source}:${item.id}`;
                const existingId = existingSessionMap.get(key);
                const isImported = Boolean(existingId);
                const isSelected = activeSession?.id === item.id;
                const isMatch = isMatchingWorkspace(item);

                return (
                  <div
                    key={item.id}
                    className={`${styles.sessionCard} ${isSelected ? styles.selectedCard : ''} ${isImported ? styles.cardImported : ''}`}
                    onClick={() => setSelectedSessionId(item.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedSessionId(item.id);
                      }
                    }}
                  >
                    <div className={styles.sessionCardTop}>
                      <div className={styles.sessionMetaGroup}>
                        <span className={styles.sourceText}>
                          {item.source === 'claude-code' ? 'Claude' : 'Codex'}
                        </span>
                        <span className={styles.metaDot}>·</span>
                        <span className={styles.sessionTime}>
                          {formatTime(item.updatedAt)}
                        </span>
                        {filterSource === 'all' && !isMatch && item.project && (
                          <>
                            <span className={styles.metaDot}>·</span>
                            <span className={styles.foreignProject}>
                              {item.project}
                            </span>
                          </>
                        )}
                      </div>

                      <div className={styles.cardStatusSlot}>
                        {isImported ? (
                          <span className={styles.statusImported}>
                            <AppIcon name="check" size={11} />
                            <span>已接续</span>
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className={styles.sessionTitle}>{item.title}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 右栏：深度解析核验与对话流预览 */}
        <div className={styles.sessionDetailPane}>
          <SessionPreviewPane
            session={activeSession}
            onImportAndResume={handleImportAndResume}
            onOpenExisting={(sid) => {
              navigateToChatSession(sid);
              showToast('已打开历史对话');
            }}
            existingSessionId={
              activeSession
                ? existingSessionMap.get(
                    `${activeSession.source}:${activeSession.id}`
                  )
                : undefined
            }
            isBusy={activeSession ? importingId === activeSession.id : false}
          />
        </div>
      </div>

      {/* 独立二级设置弹窗 */}
      <ImportPluginSettingsModal
        open={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        onScanNeeded={() => void handleScan(true)}
      />
    </div>
  );
};

export const ExternalImportWorkbench = ExternalSessionsWorkbench;
export type ExternalImportWorkbenchProps = ExternalSessionsWorkbenchProps;
