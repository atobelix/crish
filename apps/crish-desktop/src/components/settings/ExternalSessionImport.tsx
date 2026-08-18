import { useToast } from '../../services/toast/ToastContext';
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
  type ExternalSessionSource,
} from '../../api/import';
import { openDirectoryDialogSafe } from '../../api/openDirectoryDialog';
import { Button, Tooltip } from '../ui';
import { ImportListSection } from './ImportListSection';
import {
  ImportRootsSection,
  type ImportRootDisplay,
} from './ImportRootsSection';
import styles from './ExternalSessionImport.module.css';

export type ExternalSessionImportProps = {
  /** settings：完整区块；wizard：紧凑向导步 */
  variant?: 'settings' | 'wizard';
  /** 成功导入后回调（条数） */
  onImported?: (count: number) => void;
};

export const ExternalSessionImport: React.FC<ExternalSessionImportProps> = ({
  variant = 'settings',
  onImported,
}) => {
  const { showToast } = useToast();
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
  const [roots, setRoots] = useState<ImportRootDisplay | null>(null);

  const selectedList = useMemo(
    () => detected.filter((s) => selected[s.id]),
    [detected, selected],
  );
  const selectedCount = selectedList.length;
  const allSelected =
    detected.length > 0 && detected.every((s) => selected[s.id]);
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
    const valid = new Set(detected.map((s) => s.id));
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
      showToast(`扫描失败：${msg}`);
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
    for (const s of detected) next[s.id] = true;
    setSelected(next);
  };

  const pickClaudeRoot = async () => {
    if (busy) return;
    const path = await openDirectoryDialogSafe('选择 Claude 目录');
    if (!path) return;
    setPersistedClaudeImportRoot(path);
    await refreshRoots();
    showToast('已设置 Claude 扫描目录');
  };

  const pickCodexRoot = async () => {
    if (busy) return;
    const path = await openDirectoryDialogSafe('选择 Codex 目录');
    if (!path) return;
    setPersistedCodexImportRoot(path);
    await refreshRoots();
    showToast('已设置 Codex 扫描目录');
  };

  const resetClaudeRoot = async () => {
    if (busy) return;
    setPersistedClaudeImportRoot(null);
    await refreshRoots();
    showToast('已恢复 Claude 默认目录');
  };

  const resetCodexRoot = async () => {
    if (busy) return;
    setPersistedCodexImportRoot(null);
    await refreshRoots();
    showToast('已恢复 Codex 默认目录');
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
            delete next[s.id];
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
          showToast(
            `导入部分失败：${result.errors[0]}`,
          );
        } else if (dups > 0) {
          // 软去重提示（非纯成功文案，可进 toast）
          showToast(
            `跳过 ${dups} 条：此前已导入（相同来源会话）`,
          );
        }
      } else if (dups > 0 && result.errors.length === 0) {
        // 全部为重复软跳过
        const msg = `跳过 ${dups} 条：此前已导入（相同来源会话）`;
        setStatus(msg);
        setError('');
        showToast(msg);
      } else {
        const errText =
          result.errors[0] ||
          '未能导入（源文件不可读或无可导入消息）';
        setError(errText);
        setStatus('');
        showToast(`导入失败：${errText}`);
      }
    } catch (err) {
      const msg = String(err || '导入失败');
      setError(msg);
      setStatus('');
      showToast(`导入失败：${msg}`);
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
        <ImportRootsSection
          roots={roots}
          busy={busy}
          onPickClaudeRoot={pickClaudeRoot}
          onPickCodexRoot={pickCodexRoot}
          onResetClaudeRoot={resetClaudeRoot}
          onResetCodexRoot={resetCodexRoot}
        />
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
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-busy={scanning === 'claude-code' || undefined}
            onClick={() => {
              void runScan('claude-code');
            }}
            icon={
              scanning === 'claude-code' ? (
                <Lucide.Loader2 size={14} aria-hidden className="spin" />
              ) : (
                <Lucide.ScanSearch size={14} aria-hidden />
              )
            }
          >
            {scanning === 'claude-code' ? '扫描中…' : '扫描 Claude Code'}
          </Button>
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
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-busy={scanning === 'codex' || undefined}
            onClick={() => {
              void runScan('codex');
            }}
            icon={
              scanning === 'codex' ? (
                <Lucide.Loader2 size={14} aria-hidden className="spin" />
              ) : (
                <Lucide.ScanSearch size={14} aria-hidden />
              )
            }
          >
            {scanning === 'codex' ? '扫描中…' : '扫描 Codex'}
          </Button>
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
        <ImportListSection
          detected={detected}
          selected={selected}
          selectedCount={selectedCount}
          allSelected={allSelected}
          busy={busy}
          importing={importing}
          listId={listId}
          baseId={baseId}
          onToggleOne={toggleOne}
          onToggleAll={toggleAll}
          onImport={handleImport}
        />
      ) : null}
    </div>
  );
};
