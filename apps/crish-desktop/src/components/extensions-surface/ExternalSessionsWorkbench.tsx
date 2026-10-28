import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useToast } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/storeAccess';
import {
  importDetectedSessions,
  deleteImportedSession,
} from '../../api/import/importSessions';
import {
  type DetectedExternalSession,
  type ExternalSessionScanIssue,
  type ExternalSessionSource,
  makeExternalImportKey,
} from '../../api/import/types';
import { externalImportKeyAliases } from '../../api/import/externalSessionTombstone';
import { getWorkspacePath } from '../../api/workspaceFsApi';
import { navigateToChatSession } from '../../store/storeAccess';
import {
  loadExternalSessionsFromCache,
  getOrScanExternalSessions,
} from '../../api/import/externalSessionCache';
import { ImportPluginSettingsModal } from './ImportPluginSettingsModal';
import { SessionPreviewPane } from './SessionPreviewPane';
import styles from './ExternalSessionsWorkbench.module.css';

type FilterSource = 'workspace' | 'all' | 'claude' | 'codex';

const FILTER_TABS: Array<{ id: FilterSource; label: string }> = [
  { id: 'workspace', label: '当前工作区' },
  { id: 'all', label: '全部' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

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
    return loadExternalSessionsFromCache().sessions;
  });
  const [loading, setLoading] = useState(false);
  const [scanIssues, setScanIssues] = useState<ExternalSessionScanIssue[]>([]);
  const scanRequestIdRef = useRef(0);
  const initialScanCompletedRef = useRef(false);
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [filterSource, setFilterSource] = useState<FilterSource>('workspace');
  const [onlyWithContent, setOnlyWithContent] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(
    null
  );

  const currentWorkspace = useMemo(() => {
    return (getWorkspacePath() || '').replace(/\\/g, '/').toLowerCase();
  }, []);

  const sessionById = useMemo(() => {
    return new Map(sessions.map((s) => [s.id, s]));
  }, [sessions]);

  // 建立 source:sourceSessionId -> Conex sessionId 的映射，支持一键直达历史对话
  const existingSessionMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      if (s.importMeta?.source && s.importMeta.sourceSessionId) {
        const source = s.importMeta.source;
        if (source === 'claude-code' || source === 'codex') {
          for (const key of externalImportKeyAliases(
            source,
            s.importMeta.sourceSessionId,
            s.importMeta.sourcePath
          )) {
            map.set(key.toLowerCase(), s.id);
          }
        }
      }
    }
    return map;
  }, [sessions]);

  // 精准双向校验判断是否已导入：不仅在 key 映射中命中，且二次校验来源一致性与标识匹配
  const getExistingSessionId = useCallback(
    (item: DetectedExternalSession): string | undefined => {
      if (!item.source || !item.id) return undefined;
      const itemAliases = externalImportKeyAliases(
        item.source,
        item.id,
        item.path
      );
      const itemKeySet = new Set(itemAliases.map((k) => k.toLowerCase()));

      for (const key of itemAliases) {
        const sid = existingSessionMap.get(key.toLowerCase());
        if (!sid) continue;
        const matched = sessionById.get(sid);
        if (
          !matched?.importMeta?.source ||
          !matched.importMeta.sourceSessionId
        ) {
          continue;
        }
        // 双向强校验 1：来源系统必须完全一致（claude-code 与 codex 严防交叉误判）
        if (matched.importMeta.source !== item.source) {
          continue;
        }
        // 双向强校验 2：原始 sourceSessionId 精确相等
        const targetId = matched.importMeta.sourceSessionId
          .trim()
          .toLowerCase();
        const itemId = item.id.trim().toLowerCase();
        if (targetId === itemId) {
          return sid;
        }
        // 双向强校验 3：若不是直接字面相等，必须在其严格受控的 canonical key 集合中双向命中
        const targetKeys = externalImportKeyAliases(
          matched.importMeta.source as ExternalSessionSource,
          matched.importMeta.sourceSessionId,
          matched.importMeta.sourcePath
        );
        if (targetKeys.some((tk) => itemKeySet.has(tk.toLowerCase()))) {
          return sid;
        }
      }
      return undefined;
    },
    [existingSessionMap, sessionById]
  );

  // 扫描逻辑
  const handleScan = useCallback(
    async (force = true) => {
      const requestId = ++scanRequestIdRef.current;
      setLoading(true);
      setScanIssues([]);
      try {
        const result = await getOrScanExternalSessions(force);
        if (requestId !== scanRequestIdRef.current) return;
        initialScanCompletedRef.current = true;
        setDetected(result.sessions);
        setScanIssues(result.issues);
        onRefresh?.();
        if (force) {
          if (result.issues.length > 0) {
            showToast(
              /* i18n-allow */ `扫描未完成，共发现 ${result.sessions.length} 条记录，${result.issues.length} 项目录或文件需要检查`
            );
          } else {
            showToast(
              `扫描完成，共检测到 ${result.sessions.length} 个外部对话记录`
            );
          }
        }
      } catch (err) {
        if (requestId !== scanRequestIdRef.current) return;
        initialScanCompletedRef.current = true;
        setDetected([]);
        setScanIssues([
          {
            source: 'claude-code',
            kind: 'error',
            /* i18n-allow */ message: `扫描结果处理失败：${String(err)}`,
          },
          {
            source: 'codex',
            kind: 'error',
            /* i18n-allow */ message: `扫描结果处理失败：${String(err)}`,
          },
        ]);
        showToast('扫描外部会话记录失败: ' + String(err));
      } finally {
        if (requestId === scanRequestIdRef.current) setLoading(false);
      }
    },
    [showToast, onRefresh]
  );

  useEffect(
    () => () => {
      scanRequestIdRef.current += 1;
    },
    []
  );

  useEffect(() => {
    if (!initialScanCompletedRef.current) {
      void handleScan(false);
    }
  }, [handleScan]);

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
      if (onlyWithContent && (!s.messageCount || s.messageCount <= 0))
        return false;
      return true;
    });
  }, [detected, filterSource, isMatchingWorkspace, onlyWithContent]);

  // 自动选中有且仅有的首项，或者如果选中项不在当前过滤集中时保持同步
  const activeSession = useMemo(() => {
    if (selectedSessionKey) {
      const found = filteredSessions.find(
        (s) => makeExternalImportKey(s.source, s.id) === selectedSessionKey
      );
      if (found) return found;
    }
    return filteredSessions[0] || null;
  }, [filteredSessions, selectedSessionKey]);

  // 一键导入并打开该会话进入对话界面
  const handleImportAndResume = async (item: DetectedExternalSession) => {
    setImportingKey(makeExternalImportKey(item.source, item.id));
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
      setImportingKey(null);
    }
  };

  // 单个删除已接续的会话
  const handleDeleteExisting = useCallback(
    (existingId: string) => {
      const success = deleteImportedSession(existingId);
      if (success) {
        showToast('已删除该接续对话并记录防静默标记');
        onRefresh?.();
      } else {
        showToast('删除会话失败');
      }
    },
    [showToast, onRefresh]
  );

  const formatTime = (ts?: number) => {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return '';
    }
  };

  const failedSources = new Set(
    scanIssues
      .filter((issue) => issue.kind === 'error')
      .map((issue) => issue.source)
  );
  const allSourcesFailed =
    detected.length === 0 &&
    failedSources.has('claude-code') &&
    failedSources.has('codex');

  return (
    <div className={styles.workbenchContent}>
      {/* 头部摘要：纯净文字排版，大圆角容器，解耦二级设置 */}
      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <div className={styles.detailTitleInfo}>
            <div className={styles.detailTitle}>外部对话导入与接续</div>
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

      {scanIssues.length > 0 ? (
        <div className={styles.scanNotice} role="status" aria-live="polite">
          <strong>
            {
              /* i18n-allow */ scanIssues.some(
                (issue) => issue.kind === 'error'
              )
                ? allSourcesFailed
                  ? '全部来源扫描失败，无法确认是否存在外部会话。'
                  : '部分来源扫描失败，结果可能遗漏会话。'
                : '部分目录或文件未能读取，结果可能不完整。'
            }
          </strong>
          <ul>
            {scanIssues.map((issue, index) => (
              <li key={`${issue.source}-${issue.kind}-${index}`}>
                {issue.source === 'claude-code' ? 'Claude Code' : 'Codex'}
                {
                  /* i18n-allow */ issue.kind === 'error'
                    ? ' 扫描失败：'
                    : ' 扫描提示：'
                }
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 外部会话双栏主区域：左侧列表 + 右侧深度解析核验面板 */}
      <div className={styles.splitWorkbenchBody}>
        {/* 左栏：会话列表 */}
        <div className={styles.sessionListPane}>
          <div className={styles.sessionFilterBar}>
            <div className={styles.filterTabs}>
              {FILTER_TABS.map((tab) => (
                <Button
                  key={tab.id}
                  size="xs"
                  variant={filterSource === tab.id ? 'secondary' : 'ghost'}
                  className={`${styles.filterTabBtn} ${filterSource === tab.id ? styles.activeTab : ''}`}
                  onClick={() => setFilterSource(tab.id)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>

            <div className={styles.filterRightSlot}>
              <Tooltip
                content={
                  onlyWithContent ? '当前仅显示有内容对话' : '过滤空对话'
                }
              >
                <Button
                  size="xs"
                  variant={onlyWithContent ? 'secondary' : 'ghost'}
                  className={`${styles.filterTabBtn} ${onlyWithContent ? styles.activeTab : ''}`}
                  onClick={() => setOnlyWithContent((v) => !v)}
                >
                  <AppIcon name="sliders" size={11} />
                  <span>{onlyWithContent ? '仅有内容' : '全部会话'}</span>
                </Button>
              </Tooltip>
              <span className={styles.sessionCountText}>
                共 {filteredSessions.length} 条
              </span>
            </div>
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
                <div className={styles.emptyTitle}>
                  {
                    /* i18n-allow */ scanIssues.length > 0
                      ? '暂时无法确认是否存在会话'
                      : detected.length === 0
                        ? '扫描完成，未发现外部会话'
                        : '未发现匹配记录'
                  }
                </div>
              </div>
            ) : (
              filteredSessions.map((item) => {
                const existingId = getExistingSessionId(item);
                const isImported = Boolean(existingId);
                const isEmpty = !item.messageCount || item.messageCount <= 0;
                const isSelected =
                  activeSession != null &&
                  makeExternalImportKey(
                    activeSession.source,
                    activeSession.id
                  ) === makeExternalImportKey(item.source, item.id);
                const isMatch = isMatchingWorkspace(item);

                return (
                  <div
                    key={makeExternalImportKey(item.source, item.id)}
                    className={`${styles.sessionCard} ${isSelected ? styles.selectedCard : ''} ${isImported ? styles.cardImported : ''} ${isEmpty ? styles.cardEmpty : ''}`}
                    onClick={() =>
                      setSelectedSessionKey(
                        makeExternalImportKey(item.source, item.id)
                      )
                    }
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedSessionKey(
                          makeExternalImportKey(item.source, item.id)
                        );
                      }
                    }}
                  >
                    <div className={styles.sessionCardHeader}>
                      <div className={styles.sessionTitle}>{item.title}</div>
                      {isImported ? (
                        <div className={styles.cardStatusSlot}>
                          <span className={styles.statusImported}>
                            <AppIcon name="check" size={11} />
                            <span>已接续</span>
                          </span>
                        </div>
                      ) : null}
                    </div>

                    <div className={styles.sessionMetaGroup}>
                      <span className={styles.sourceText}>
                        {item.source === 'claude-code' ? 'Claude' : 'Codex'}
                      </span>
                      <span className={styles.metaDot}>·</span>
                      <span className={styles.sessionTime}>
                        {formatTime(item.updatedAt)}
                      </span>
                      {isEmpty ? (
                        <>
                          <span className={styles.metaDot}>·</span>
                          <span className={styles.emptySessionLabel}>
                            （空）
                          </span>
                        </>
                      ) : item.messageCount ? (
                        <>
                          <span className={styles.metaDot}>·</span>
                          <span>{item.messageCount} 条消息</span>
                        </>
                      ) : null}
                      {filterSource === 'all' && !isMatch && item.project && (
                        <>
                          <span className={styles.metaDot}>·</span>
                          <span className={styles.foreignProject}>
                            {item.project}
                          </span>
                        </>
                      )}
                    </div>
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
            onDeleteExisting={handleDeleteExisting}
            existingSessionId={
              activeSession ? getExistingSessionId(activeSession) : undefined
            }
            isBusy={
              loading ||
              (activeSession != null &&
                importingKey ===
                  makeExternalImportKey(activeSession.source, activeSession.id))
            }
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
