import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { Dialog, Button, Tooltip, Input, Switch } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useToast } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/storeAccess';
import {
  combineExternalSessionScans,
  scanClaudeCodeSessions,
  scanCodexSessions,
} from '../../api/import/scan';
import {
  importDetectedSessions,
  collectExistingImportKeys,
} from '../../api/import/importSessions';
import {
  makeExternalImportKey,
  type DetectedExternalSession,
  type ExternalSessionScanIssue,
} from '../../api/import/types';
import {
  getPersistedImportRoots,
  setPersistedClaudeImportRoot,
  setPersistedCodexImportRoot,
  getImportAutoSyncEnabled,
  setImportAutoSyncEnabled,
} from '../../api/import/importRootSettings';
import { getWorkspacePath } from '../../api/workspaceFsApi';
import styles from './ExternalSessionImportModal.module.css';

export interface ExternalSessionImportModalProps {
  open: boolean;
  onClose: () => void;
}

type FilterTab = 'all' | 'workspace' | 'claude' | 'codex';

export const ExternalSessionImportModal: React.FC<
  ExternalSessionImportModalProps
> = ({ open, onClose }) => {
  const { showToast } = useToast();
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);

  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detected, setDetected] = useState<DetectedExternalSession[]>([]);
  const [scanIssues, setScanIssues] = useState<ExternalSessionScanIssue[]>([]);
  const scanRequestIdRef = useRef(0);
  const [filterTab, setFilterTab] = useState<FilterTab>('workspace');
  const [searchQuery, setSearchQuery] = useState('');

  const [topTab, setTopTab] = useState<'sessions' | 'settings'>('sessions');
  const [claudeCustomPath, setClaudeCustomPath] = useState('');
  const [codexCustomPath, setCodexCustomPath] = useState('');
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);

  const currentWorkspace = useMemo(() => {
    return (getWorkspacePath() || '').replace(/\\/g, '/').toLowerCase();
  }, [open]);

  // 已导入的外部会话键集
  const existingKeys = useMemo(() => {
    return collectExistingImportKeys(sessions);
  }, [sessions]);

  const loadSessions = useCallback(async () => {
    const requestId = ++scanRequestIdRef.current;
    setLoading(true);
    setScanIssues([]);
    try {
      const [claudeScan, codexScan] = await Promise.all([
        scanClaudeCodeSessions(),
        scanCodexSessions(),
      ]);
      const result = combineExternalSessionScans([claudeScan, codexScan]);
      if (requestId !== scanRequestIdRef.current) return;
      setDetected(result.sessions);
      setScanIssues(result.issues);
    } catch (err) {
      if (requestId !== scanRequestIdRef.current) return;
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
    } finally {
      if (requestId === scanRequestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      scanRequestIdRef.current += 1;
      return;
    }

    void loadSessions();
    const roots = getPersistedImportRoots();
    setClaudeCustomPath(roots.claudeConfigDir || '');
    setCodexCustomPath(roots.codexHome || '');
    setAutoSyncEnabled(getImportAutoSyncEnabled());

    return () => {
      scanRequestIdRef.current += 1;
    };
  }, [open, loadSessions]);

  const handleSaveClaudePath = () => {
    setPersistedClaudeImportRoot(claudeCustomPath.trim() || null);
    void loadSessions();
    showToast('已更新 Claude 配置路径');
  };

  const handleResetClaudePath = () => {
    setPersistedClaudeImportRoot(null);
    setClaudeCustomPath('');
    void loadSessions();
    showToast('已重置 Claude 默认配置路径');
  };

  const handleSaveCodexPath = () => {
    setPersistedCodexImportRoot(codexCustomPath.trim() || null);
    void loadSessions();
    showToast('已更新 Codex 数据路径');
  };

  const handleResetCodexPath = () => {
    setPersistedCodexImportRoot(null);
    setCodexCustomPath('');
    void loadSessions();
    showToast('已重置 Codex 默认数据路径');
  };

  const handleToggleAutoSync = (enabled: boolean) => {
    setImportAutoSyncEnabled(enabled);
    setAutoSyncEnabled(enabled);
    showToast(enabled ? '已开启工作区自动检测' : '已关闭工作区自动检测');
  };

  // 判断是否与当前工作区相符
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

  // 过滤会话
  const filteredSessions = useMemo(() => {
    return detected.filter((s) => {
      // Tab 过滤
      if (filterTab === 'workspace' && !isMatchingWorkspace(s)) return false;
      if (filterTab === 'claude' && s.source !== 'claude-code') return false;
      if (filterTab === 'codex' && s.source !== 'codex') return false;

      // 文本搜索过滤
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = s.title.toLowerCase().includes(q);
        const matchCwd = s.cwd?.toLowerCase().includes(q) ?? false;
        const matchProject = s.project?.toLowerCase().includes(q) ?? false;
        if (!matchTitle && !matchCwd && !matchProject) return false;
      }
      return true;
    });
  }, [detected, filterTab, searchQuery, isMatchingWorkspace]);

  const failedSources = new Set(
    scanIssues
      .filter((issue) => issue.kind === 'error')
      .map((issue) => issue.source)
  );
  const allSourcesFailed =
    detected.length === 0 &&
    failedSources.has('claude-code') &&
    failedSources.has('codex');

  // 导入单条
  const handleImportSingle = async (item: DetectedExternalSession) => {
    setImporting(true);
    try {
      const res = await importDetectedSessions([item]);
      if (res.imported > 0 && res.sessionIds[0]) {
        showToast(`已同步会话：${item.title}`);
        setActiveSessionId(res.sessionIds[0]);
        onClose();
      } else if (res.skippedDuplicates > 0) {
        showToast('该会话此前已导入');
      }
    } catch (err) {
      showToast('同步失败: ' + String(err));
    } finally {
      setImporting(false);
    }
  };

  // 一键同步当前列表所有未同步
  const handleSyncAllVisible = async () => {
    const unsynced = filteredSessions.filter(
      (s) => !existingKeys.has(makeExternalImportKey(s.source, s.id))
    );
    if (unsynced.length === 0) {
      showToast('当前列表已全部同步');
      return;
    }
    setImporting(true);
    try {
      const res = await importDetectedSessions(unsynced);
      showToast(`成功同步 ${res.imported} 条会话`);
      const firstId = res.sessionIds[0];
      if (firstId) {
        setActiveSessionId(firstId);
        onClose();
      }
    } catch (err) {
      showToast('批量同步失败: ' + String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel="外部对话同步"
      role="dialog"
      showCloseButton={false}
      classNames={{ panel: styles.dialogPanel, body: styles.dialogBody }}
    >
      <div className={styles.modalOverlay}>
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <h3 className={styles.title}>
              <AppIcon name="puzzle" size={16} />
              外部对话同步
            </h3>
            <p className={styles.subtitle}>
              零迁移成本：自动识别 Claude Code 与 Codex 客户端历史对话并一键呈现
            </p>
          </div>
          <Button
            variant="ghost"
            size="xs"
            onClick={loadSessions}
            disabled={loading || importing}
          >
            <AppIcon name="refresh" size={14} />
            刷新
          </Button>
        </div>

        <div className={styles.topNav} role="tablist">
          <Button
            bare
            type="button"
            className={`${styles.topNavBtn} ${topTab === 'sessions' ? styles.topNavBtnActive : ''}`}
            onClick={() => setTopTab('sessions')}
          >
            <AppIcon name="sparkles" size={14} />
            对话列表
          </Button>
          <Button
            bare
            type="button"
            className={`${styles.topNavBtn} ${topTab === 'settings' ? styles.topNavBtnActive : ''}`}
            onClick={() => setTopTab('settings')}
          >
            <AppIcon name="settings" size={14} />
            插件设置
          </Button>
        </div>

        {topTab === 'settings' ? (
          <div className={styles.settingsPanel}>
            <div className={styles.settingsCard}>
              <div className={styles.settingsRow}>
                <div className={styles.settingsMeta}>
                  <span className={styles.settingsTitle}>
                    项目自动检测与同步
                  </span>
                  <span className={styles.settingsDesc}>
                    进入工作区时自动探测当前项目相关的外部对话并索引
                  </span>
                </div>
                <Switch
                  checked={autoSyncEnabled}
                  onCheckedChange={handleToggleAutoSync}
                  aria-label="自动同步开关"
                />
              </div>
            </div>

            <div className={styles.settingsCard}>
              <div className={styles.settingsInputGroup}>
                <span className={styles.settingsTitle}>
                  Claude Code 历史记录目录
                </span>
                <span className={styles.settingsDesc}>
                  默认自动探测
                  ~/.claude/projects。若使用自定义安装目录可在此指定。
                </span>
                <div className={styles.inputActionRow}>
                  <Input
                    size="sm"
                    placeholder="例如: C:/Users/xxx/.claude"
                    value={claudeCustomPath}
                    onChange={(e) => setClaudeCustomPath(e.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={handleSaveClaudePath}
                  >
                    保存
                  </Button>
                  {claudeCustomPath ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={handleResetClaudePath}
                    >
                      重置
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className={styles.settingsCard}>
              <div className={styles.settingsInputGroup}>
                <span className={styles.settingsTitle}>
                  OpenAI Codex 数据目录
                </span>
                <span className={styles.settingsDesc}>
                  默认自动探测
                  ~/.codex/sessions。若使用自定义安装目录可在此指定。
                </span>
                <div className={styles.inputActionRow}>
                  <Input
                    size="sm"
                    placeholder="例如: C:/Users/xxx/.codex"
                    value={codexCustomPath}
                    onChange={(e) => setCodexCustomPath(e.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={handleSaveCodexPath}
                  >
                    保存
                  </Button>
                  {codexCustomPath ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={handleResetCodexPath}
                    >
                      重置
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className={styles.statusSummary}>
              <span>
                已探测 Claude 对话：
                {detected.filter((s) => s.source === 'claude-code').length} 条
              </span>
              <span>
                已探测 Codex 对话：
                {detected.filter((s) => s.source === 'codex').length} 条
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.toolbar}>
              <div className={styles.filterTabs} role="tablist">
                <Button
                  bare
                  type="button"
                  role="tab"
                  aria-selected={filterTab === 'workspace'}
                  className={`${styles.filterTab} ${filterTab === 'workspace' ? styles.filterTabActive : ''}`}
                  onClick={() => setFilterTab('workspace')}
                >
                  当前项目
                </Button>
                <Button
                  bare
                  type="button"
                  role="tab"
                  aria-selected={filterTab === 'all'}
                  className={`${styles.filterTab} ${filterTab === 'all' ? styles.filterTabActive : ''}`}
                  onClick={() => setFilterTab('all')}
                >
                  全部 ({detected.length})
                </Button>
                <Button
                  bare
                  type="button"
                  role="tab"
                  aria-selected={filterTab === 'claude'}
                  className={`${styles.filterTab} ${filterTab === 'claude' ? styles.filterTabActive : ''}`}
                  onClick={() => setFilterTab('claude')}
                >
                  Claude Code
                </Button>
                <Button
                  bare
                  type="button"
                  role="tab"
                  aria-selected={filterTab === 'codex'}
                  className={`${styles.filterTab} ${filterTab === 'codex' ? styles.filterTabActive : ''}`}
                  onClick={() => setFilterTab('codex')}
                >
                  Codex
                </Button>
              </div>

              <div className={styles.searchBar}>
                <Input
                  type="search"
                  placeholder="搜索标题或目录…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={styles.queryInput}
                />
              </div>
            </div>

            <div className={styles.sessionList}>
              {!loading && scanIssues.length > 0 ? (
                <div
                  className={styles.scanNotice}
                  role="status"
                  aria-live="polite"
                >
                  <strong>
                    {scanIssues.some((issue) => issue.kind === 'error')
                      ? allSourcesFailed
                        ? /* i18n-allow */ '全部来源扫描失败，无法确认是否存在外部会话。'
                        : /* i18n-allow */ '部分来源扫描失败，结果可能遗漏会话。'
                      : /* i18n-allow */ '部分目录或文件未能读取，结果可能不完整。'}
                  </strong>
                  <ul>
                    {scanIssues.map((issue, index) => (
                      <li key={`${issue.source}-${issue.kind}-${index}`}>
                        {issue.source === 'claude-code'
                          ? 'Claude Code'
                          : 'Codex'}
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
              {loading ? (
                <div className={styles.emptyState}>
                  <AppIcon name="sparkles" size={20} />
                  <span>正在扫描本机会话…</span>
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className={styles.emptyState}>
                  <AppIcon name="info" size={20} />
                  <span>
                    {detected.length > 0
                      ? '当前筛选条件下没有匹配的外部历史对话'
                      : scanIssues.length > 0
                        ? /* i18n-allow */ '暂时无法确认是否存在可导入会话，请检查上方扫描状态或配置路径后重试。'
                        : /* i18n-allow */ '扫描完成，未发现外部历史对话'}
                  </span>
                </div>
              ) : (
                filteredSessions.map((item) => {
                  const isSynced = existingKeys.has(
                    makeExternalImportKey(item.source, item.id)
                  );
                  const isMatch = isMatchingWorkspace(item);

                  return (
                    <div
                      key={makeExternalImportKey(item.source, item.id)}
                      className={`${styles.sessionCard} ${isMatch ? styles.sessionCardMatching : ''}`}
                    >
                      <div className={styles.cardMain}>
                        <div className={styles.cardHeader}>
                          <span
                            className={`${styles.sourceBadge} ${
                              item.source === 'claude-code'
                                ? styles.sourceBadgeClaude
                                : styles.sourceBadgeCodex
                            }`}
                          >
                            {item.source === 'claude-code'
                              ? 'Claude Code'
                              : 'Codex'}
                          </span>
                          {isMatch && (
                            <span className={styles.workspaceBadge}>
                              当前工作区
                            </span>
                          )}
                          <Tooltip content={item.title}>
                            <span className={styles.cardTitle}>
                              {item.title}
                            </span>
                          </Tooltip>
                        </div>

                        <div className={styles.cardMeta}>
                          {item.cwd && (
                            <Tooltip content={item.cwd}>
                              <span className={styles.cardCwd}>{item.cwd}</span>
                            </Tooltip>
                          )}
                          {item.messageCount > 0 && (
                            <span>~{item.messageCount} 条消息</span>
                          )}
                        </div>
                      </div>

                      <div className={styles.cardAction}>
                        {isSynced ? (
                          <span className={styles.syncedBadge}>
                            <AppIcon name="check" size={12} />
                            已同步
                          </span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="xs"
                            disabled={importing}
                            onClick={() => handleImportSingle(item)}
                          >
                            同步呈现
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        <div className={styles.footer}>
          <span className={styles.footerInfo}>
            {topTab === 'sessions'
              ? `共 ${filteredSessions.length} 条会话`
              : '外部对话同步插件设置'}
          </span>
          <div className={styles.footerActions}>
            <Button variant="ghost" size="sm" onClick={onClose}>
              关闭
            </Button>
            {topTab === 'sessions' ? (
              <Button
                variant="primary"
                size="sm"
                disabled={importing || loading || filteredSessions.length === 0}
                onClick={handleSyncAllVisible}
              >
                一键同步
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
};
