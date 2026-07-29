/**
 * 导入外部对话：扫描 Claude Code / Codex，勾选后导入。
 * 用于设置 · 账户「数据」与首次向导可选步；禁止自动导入。
 */

import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  externalSourceLabel,
  getPersistedImportRoots,
  hasCustomImportRoot,
  importDetectedSessions,
  resolveDefaultImportRoots,
  resolveHostImportEnv,
  scanClaudeCodeSessions,
  scanCodexSessions,
  setPersistedClaudeImportRoot,
  setPersistedCodexImportRoot,
  type DetectedExternalSession,
  type ExternalImportRoots,
  type ExternalSessionSource,
} from '../../api/import';
import { openDirectoryDialogSafe } from '../../api/openDirectoryDialog';
import { Tooltip } from '../Tooltip';
import styles from './ExternalSessionImport.module.css';

export type ExternalSessionImportProps = {
  /** settings：完整区块；wizard：紧凑向导步 */
  variant?: 'settings' | 'wizard';
  onShowToast?: (msg: string) => void;
  /** 成功导入后回调（条数） */
  onImported?: (count: number) => void;
};

type RootDisplay = {
  /** Effective scan root (custom or default) */
  effective: ExternalImportRoots;
  /** Home-relative defaults without custom overrides */
  defaults: ExternalImportRoots;
  customClaude: boolean;
  customCodex: boolean;
};

function formatUpdatedAt(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '时间未知';
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '时间未知';
  }
}

function sessionKey(s: DetectedExternalSession): string {
  return s.id;
}

export const ExternalSessionImport: React.FC<ExternalSessionImportProps> = ({
  variant = 'settings',
  onShowToast,
  onImported,
}) => {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const statusId = `${baseId}-status`;
  const errorId = `${baseId}-error`;

  const [detected, setDetected] = useState<DetectedExternalSession[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scanning, setScanning] = useState<ExternalSessionSource | null>(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [hasScanned, setHasScanned] = useState(false);
  const [roots, setRoots] = useState<RootDisplay | null>(null);

  const selectedList = useMemo(
    () => detected.filter((s) => selected[sessionKey(s)]),
    [detected, selected],
  );
  const selectedCount = selectedList.length;
  const allSelected =
    detected.length > 0 && detected.every((s) => selected[sessionKey(s)]);
  const busy = scanning !== null || importing;

  const refreshRoots = useCallback(async () => {
    try {
      const host = await resolveHostImportEnv({});
      const persisted = getPersistedImportRoots();
      // Defaults: host home only (no custom roots)
      const defaults = resolveDefaultImportRoots({
        home: host.home,
        platform: host.platform,
        sep: host.sep,
      });
      const effective = resolveDefaultImportRoots(host);
      // Badge/reset UX must use same SoT as scan merge (hasCustomImportRoot)
      setRoots({
        effective,
        defaults,
        customClaude: hasCustomImportRoot('claude', persisted),
        customCodex: hasCustomImportRoot('codex', persisted),
      });
    } catch {
      setRoots(null);
    }
  }, []);

  useEffect(() => {
    void refreshRoots();
  }, [refreshRoots]);

  // 列表变化时剪掉无效勾选
  useEffect(() => {
    const valid = new Set(detected.map(sessionKey));
    setSelected((sel) => {
      let changed = false;
      const nextSel: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(sel)) {
        if (v && valid.has(k)) nextSel[k] = true;
        else if (v) changed = true;
      }
      if (!changed && Object.keys(nextSel).length === Object.keys(sel).length) {
        return sel;
      }
      return nextSel;
    });
  }, [detected]);

  const mergeDetected = useCallback(
    (source: ExternalSessionSource, batch: DetectedExternalSession[]) => {
      setDetected((prev) => {
        const keep = prev.filter((s) => s.source !== source);
        const merged = [...keep, ...batch];
        // 稳定排序：来源 + 时间倒序 + 标题
        merged.sort((a, b) => {
          if (a.source !== b.source) {
            return a.source.localeCompare(b.source);
          }
          const ta = a.updatedAt ?? 0;
          const tb = b.updatedAt ?? 0;
          if (tb !== ta) return tb - ta;
          return (a.title || '').localeCompare(b.title || '', 'zh-CN');
        });
        return merged;
      });
    },
    [],
  );

  const runScan = async (source: ExternalSessionSource) => {
    if (busy) return;
    setError('');
    setStatus(
      source === 'claude-code' ? '正在扫描 Claude Code…' : '正在扫描 Codex…',
    );
    setScanning(source);
    try {
      const list =
        source === 'claude-code'
          ? await scanClaudeCodeSessions()
          : await scanCodexSessions();
      mergeDetected(source, list);
      setHasScanned(true);
      const label = externalSourceLabel(source);
      if (list.length === 0) {
        setStatus(`未在本机发现 ${label} 会话`);
      } else {
        setStatus(`已发现 ${list.length} 条 ${label} 会话`);
      }
    } catch (err) {
      const msg = String(err || '扫描失败');
      setError(msg);
      setStatus('');
      onShowToast?.(`扫描失败：${msg}`);
    } finally {
      setScanning(null);
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const s of detected) next[sessionKey(s)] = true;
    setSelected(next);
  };

  const pickClaudeRoot = async () => {
    if (busy) return;
    const path = await openDirectoryDialogSafe('选择 Claude 目录');
    if (!path) return;
    setPersistedClaudeImportRoot(path);
    await refreshRoots();
    onShowToast?.('已设置 Claude 扫描目录');
  };

  const pickCodexRoot = async () => {
    if (busy) return;
    const path = await openDirectoryDialogSafe('选择 Codex 目录');
    if (!path) return;
    setPersistedCodexImportRoot(path);
    await refreshRoots();
    onShowToast?.('已设置 Codex 扫描目录');
  };

  const resetClaudeRoot = async () => {
    if (busy) return;
    setPersistedClaudeImportRoot(null);
    await refreshRoots();
    onShowToast?.('已恢复 Claude 默认目录');
  };

  const resetCodexRoot = async () => {
    if (busy) return;
    setPersistedCodexImportRoot(null);
    await refreshRoots();
    onShowToast?.('已恢复 Codex 默认目录');
  };

  const handleImport = async () => {
    if (busy || selectedCount === 0) return;
    setError('');
    setImporting(true);
    setStatus(`正在导入 ${selectedCount} 条…`);
    try {
      const result = await importDetectedSessions(selectedList);
      const dups = result.skippedDuplicates ?? 0;
      // 清除已处理项勾选（成功导入或重复跳过）
      if (result.imported > 0 || dups > 0) {
        setSelected((prev) => {
          const next = { ...prev };
          for (const s of selectedList) {
            delete next[sessionKey(s)];
          }
          return next;
        });
      }
      if (result.imported > 0) {
        onImported?.(result.imported);
        // 行内 status 始终中文完整摘要；toast 仅在有失败/软跳过时提示
        // （纯「已导入…」会被 toast 策略静默，属产品禁令）
        let statusText =
          dups > 0
            ? `已导入 ${result.imported} 条，跳过 ${dups} 条（此前已导入）`
            : `已导入 ${result.imported} 条对话`;
        if (result.errors.length) {
          statusText += `，${result.errors.length} 条失败`;
        }
        setStatus(statusText);
        if (result.errors.length) {
          setError(result.errors.slice(0, 3).join('；'));
          onShowToast?.(
            `导入部分失败：${result.errors[0]}`,
          );
        } else if (dups > 0) {
          // 软去重提示（非纯成功文案，可进 toast）
          onShowToast?.(
            `跳过 ${dups} 条：此前已导入（相同来源会话）`,
          );
        }
      } else if (dups > 0 && result.errors.length === 0) {
        // 全部为重复软跳过
        const msg = `跳过 ${dups} 条：此前已导入（相同来源会话）`;
        setStatus(msg);
        setError('');
        onShowToast?.(msg);
      } else {
        const errText =
          result.errors[0] ||
          '未能导入（源文件不可读或无可导入消息）';
        setError(errText);
        setStatus('');
        onShowToast?.(`导入失败：${errText}`);
      }
    } catch (err) {
      const msg = String(err || '导入失败');
      setError(msg);
      setStatus('');
      onShowToast?.(`导入失败：${msg}`);
    } finally {
      setImporting(false);
    }
  };

  const rootClass =
    variant === 'wizard'
      ? `${styles.importRoot} ${styles.importRootWizard}`
      : styles.importRoot;

  return (
    <div className={rootClass}>
      {roots ? (
        <div className={styles.importRoots} role="group" aria-label="扫描根目录">
          <div className={styles.importRootRow}>
            <div className={styles.importRootInfo}>
              <span className={styles.importRootLabel}>
                Claude
                {roots.customClaude ? (
                  <span className={styles.importRootBadge}>自定义</span>
                ) : (
                  <span className={styles.importRootBadgeMuted}>默认</span>
                )}
              </span>
              <span className={styles.importRootPath} title={roots.effective.claudeConfig}>
                {roots.effective.claudeConfig || roots.defaults.claudeConfig || '（未解析）'}
              </span>
            </div>
            <div className={styles.importRootBtns}>
              <Tooltip content="选择非默认的 Claude Code 配置目录（含 projects）">
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  disabled={busy}
                  onClick={() => {
                    void pickClaudeRoot();
                  }}
                >
                  <Lucide.FolderOpen size={14} aria-hidden />
                  选择 Claude 目录
                </button>
              </Tooltip>
              {roots.customClaude ? (
                <Tooltip content={`恢复默认：${roots.defaults.claudeConfig}`}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    disabled={busy}
                    onClick={() => {
                      void resetClaudeRoot();
                    }}
                  >
                    恢复默认
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </div>
          <div className={styles.importRootRow}>
            <div className={styles.importRootInfo}>
              <span className={styles.importRootLabel}>
                Codex
                {roots.customCodex ? (
                  <span className={styles.importRootBadge}>自定义</span>
                ) : (
                  <span className={styles.importRootBadgeMuted}>默认</span>
                )}
              </span>
              <span className={styles.importRootPath} title={roots.effective.codexHome}>
                {roots.effective.codexHome || roots.defaults.codexHome || '（未解析）'}
              </span>
            </div>
            <div className={styles.importRootBtns}>
              <Tooltip content="选择非默认的 Codex 配置目录（含 sessions）">
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  disabled={busy}
                  onClick={() => {
                    void pickCodexRoot();
                  }}
                >
                  <Lucide.FolderOpen size={14} aria-hidden />
                  选择 Codex 目录
                </button>
              </Tooltip>
              {roots.customCodex ? (
                <Tooltip content={`恢复默认：${roots.defaults.codexHome}`}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    disabled={busy}
                    onClick={() => {
                      void resetCodexRoot();
                    }}
                  >
                    恢复默认
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className={styles.importActions} role="group" aria-label="扫描外部对话">
        <Tooltip
          content={
            scanning === 'claude-code'
              ? '正在扫描…'
              : roots?.effective.claudeConfig
                ? `扫描 ${roots.effective.claudeConfig}`
                : '扫描本机 Claude Code 会话目录'
          }
        >
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={busy}
            aria-busy={scanning === 'claude-code' || undefined}
            onClick={() => {
              void runScan('claude-code');
            }}
          >
            {scanning === 'claude-code' ? (
              <Lucide.Loader2 size={14} aria-hidden className="spin" />
            ) : (
              <Lucide.ScanSearch size={14} aria-hidden />
            )}
            {scanning === 'claude-code' ? '扫描中…' : '扫描 Claude Code'}
          </button>
        </Tooltip>
        <Tooltip
          content={
            scanning === 'codex'
              ? '正在扫描…'
              : roots?.effective.codexHome
                ? `扫描 ${roots.effective.codexHome}`
                : '扫描本机 Codex 会话目录'
          }
        >
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={busy}
            aria-busy={scanning === 'codex' || undefined}
            onClick={() => {
              void runScan('codex');
            }}
          >
            {scanning === 'codex' ? (
              <Lucide.Loader2 size={14} aria-hidden className="spin" />
            ) : (
              <Lucide.ScanSearch size={14} aria-hidden />
            )}
            {scanning === 'codex' ? '扫描中…' : '扫描 Codex'}
          </button>
        </Tooltip>
      </div>

      <p className={styles.importHint}>
        仅扫描上方配置的根目录（默认 ~/.claude、~/.codex，可自定义）。点击扫描后勾选会话，再点「导入所选」。不会自动导入。
      </p>

      {error ? (
        <div className={styles.importError} role="alert" id={errorId}>
          {error}
        </div>
      ) : null}

      {status ? (
        <p
          className={styles.importStatus}
          role="status"
          aria-live="polite"
          id={statusId}
        >
          {status}
        </p>
      ) : null}

      {hasScanned || detected.length > 0 ? (
        <>
          <div className={styles.importListToolbar}>
            <span className={styles.importListMeta}>
              {detected.length === 0
                ? '暂无检测结果'
                : `共 ${detected.length} 条 · 已选 ${selectedCount}`}
            </span>
            {detected.length > 0 ? (
              <Tooltip content={allSelected ? '取消全选' : '全选'}>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  disabled={busy}
                  onClick={toggleAll}
                >
                  {allSelected ? '取消全选' : '全选'}
                </button>
              </Tooltip>
            ) : null}
          </div>

          {detected.length === 0 ? (
            <div className={styles.importEmpty} role="status">
              本机未发现可导入会话。确认已安装 Claude Code / Codex，且会话目录可读。
            </div>
          ) : (
            <ul
              className={styles.importList}
              id={listId}
              role="listbox"
              aria-label="检测到的外部会话"
              aria-multiselectable="true"
            >
              {detected.map((s) => {
                const key = sessionKey(s);
                const checked = Boolean(selected[key]);
                const checkId = `${baseId}-chk-${key}`;
                return (
                  <li
                    key={key}
                    className={styles.importItem}
                    role="option"
                    aria-selected={checked}
                  >
                    <input
                      id={checkId}
                      type="checkbox"
                      className={styles.importCheck}
                      checked={checked}
                      disabled={busy}
                      onChange={() => toggleOne(key)}
                      aria-label={`选择 ${s.title}`}
                    />
                    <label htmlFor={checkId} className={styles.importItemBody}>
                      <span className={styles.importItemTitle}>{s.title}</span>
                      <span className={styles.importItemMeta}>
                        <span className={styles.importItemSource}>
                          {externalSourceLabel(s.source)}
                        </span>
                        {s.project ? <span>项目 {s.project}</span> : null}
                        <span>{formatUpdatedAt(s.updatedAt)}</span>
                        <span>{s.messageCount} 条消息</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <div className={styles.importFooter}>
            <Tooltip
              content={
                selectedCount === 0
                  ? '请先勾选要导入的会话'
                  : `导入 ${selectedCount} 条所选会话`
              }
            >
              <button
                type="button"
                className="ui-btn ui-btn-primary ui-btn-sm"
                disabled={busy || selectedCount === 0}
                aria-busy={importing || undefined}
                onClick={() => {
                  void handleImport();
                }}
              >
                {importing ? (
                  <>
                    <Lucide.Loader2 size={14} aria-hidden />
                    导入中…
                  </>
                ) : (
                  <>
                    <Lucide.Download size={14} aria-hidden />
                    导入所选
                    {selectedCount > 0 ? `（${selectedCount}）` : ''}
                  </>
                )}
              </button>
            </Tooltip>
          </div>
        </>
      ) : null}
    </div>
  );
};
