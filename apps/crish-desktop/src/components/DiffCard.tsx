/**
 * 右侧变更面板：Git 工作区变更 + 本会话 AI 回合汇总（下拉）。
 * 支持接受/拒绝落盘（工程闭环）。
 * 工具栏以图标为主，保持功能行紧凑。
 * 反馈策略：成功静默；失败 toast + 行内；空态/软提示仅行内。
 */
import React, { useCallback, useEffect, useDeferredValue, useMemo, useRef, useState } from 'react';
import styles from './DiffCard.module.css';
import { Tooltip } from './settings/SettingsUI';
import { useLayoutStore } from '../store/layoutStore';
import type { FileDiff } from '../store/layoutStore';
import {
  selectActiveSession,
  useSessionField,
} from '../store/sessionStore';
import * as Lucide from 'lucide-react';
import {
  fetchGitDiff,
  fetchGitStatus,
  gitStatusUserMessage,
  fetchGitBranches,
  switchGitBranch,
  commitGitChanges,
  pushGitChanges,
  stageGitPath,
  unstageGitPath,
  discardGitPath,
  stageAllGit,
  unstageAllGit,
} from '../api/gitApi';
import {
  applyFileDiffToDisk,
  applyFileDiffsToDisk,
  classifyFileDiff,
  formatApplyFailureToast,
} from '../api/applyFileDiff';
import { filterPublishableDiffs } from '../api/publishToolDiffs';
import { collectMessageDiffs } from './ChangeOverviewCard';
import { SettingsSelect } from './SettingsSelect';
import {
  assistantTurnLabel,
  mergeSessionDiffFiles,
  type DiffSourceMode,
} from '../api/diffPanelHelpers';
import { getWorkspacePath } from '../api/projectStore';
import { readTextFile } from '../api/workspaceFsApi';
import { useVirtualDiffScroll } from '../hooks/useVirtualDiffScroll';
import { DiffCardFileList } from './DiffCardFileList';
import { DiffCardGitActions } from './DiffCardGitActions';
import { DiffCardUnifiedView } from './DiffCardUnifiedView';
import { DiffCardSplitView } from './DiffCardSplitView';
import type { CompareMode, ComputedChange, SplitPair, UnifiedRenderItem, SplitRenderItem } from './diffCardTypes';

interface DiffCardProps {
  onShowToast: (message: string) => void;
}

type SourceMode = DiffSourceMode;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

// ============================================================================
// 🌟 HIGH-PERFORMANCE VIRTUAL SCROLL COMPONENTS FOR INFINITE SCALABILITY 🌟
// ============================================================================

interface VirtualPlainCodeViewerProps {
  content: string;
  filePath: string;
}

const VirtualPlainCodeViewer: React.FC<VirtualPlainCodeViewerProps> = ({ content, filePath }) => {
  const { containerRef, scrollTop, containerHeight, onScroll } = useVirtualDiffScroll();

  const lines = useMemo(() => {
    return content.split('\n').map((line, idx) => ({
      num: idx + 1,
      content: line,
    }));
  }, [content]);

  const totalLines = lines.length;
  const rowHeight = 20;
  const totalHeight = totalLines * rowHeight;

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 15);
  const endIndex = Math.min(totalLines, Math.ceil((scrollTop + containerHeight) / rowHeight) + 15);

  const visibleLines = lines.slice(startIndex, endIndex);
  const offsetTop = startIndex * rowHeight;

  return (
    <div
      ref={containerRef}
      className={styles.scrollParent}
      onScroll={onScroll}
      tabIndex={0}
      style={{ position: 'relative', overflowY: 'auto', outline: 'none' }}
    >
      <div style={{ height: `${totalHeight}px`, width: '100%', position: 'relative' }}>
        <pre
          className={styles.linesContainer}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${offsetTop}px)`,
            margin: 0,
            background: 'transparent',
          }}
          aria-label={`${basename(filePath)} 的源码`}
        >
          {visibleLines.map((l) => (
            <div
              key={l.num}
              className={styles.line}
              style={{ minHeight: `${rowHeight}px` }}
            >
              <div className={styles.gutterNum} data-num={l.num}>
                {l.num}
              </div>
              <div className={styles.gutterMarker}> </div>
              <div className={styles.lineText} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l.content}</div>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
};




const DiffCardInner: React.FC<DiffCardProps> = ({ onShowToast }) => {
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);
  const diffFiles = useLayoutStore((s) => s.diffFiles) as FileDiff[];
  const setActiveDiffSource = useLayoutStore((s) => s.setActiveDiffSource);
  const setDiffFiles = useLayoutStore((s) => s.setDiffFiles);
  const removeDiffFile = useLayoutStore((s) => s.removeDiffFile);
  /** O(1) 活动会话，避免 sessions 整表订阅 + find */
  const session = useSessionField(selectActiveSession);

  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified');
  const [rawDiffSearchQuery, setDiffSearchQuery] = useState('');
  const diffSearchQuery = useDeferredValue(rawDiffSearchQuery);
  const searchActive = !!rawDiffSearchQuery.trim();
  const [searchOpen, setSearchOpen] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  /** list = 未选源；session = AI 回合；git = 工作区 git */
  const [sourceMode, setSourceMode] = useState<SourceMode>('list');
  const [turnKey, setTurnKey] = useState('');
  /** 硬失败：行内 + toast（仅失败，无成功 toast） */
  const [panelErr, setPanelErr] = useState('');
  /** 软提示：空结果/无改动等，仅行内，不 toast */
  const [softHint, setSoftHint] = useState('');
  const softHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 丢弃过期 git 加载结果，避免连点后 loading 状态错乱 */
  const gitLoadSeqRef = useRef(0);

  // 🌟 Git 多分支及行内直接提交相关状态 🌟
  const [branches, setBranches] = useState<string[]>(['main']);
  const [currentBranch, setCurrentBranch] = useState<string>('main');
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);

  // 🌟 Individual file compare modes: { [filePath]: compareMode } 🌟
  const [fileCompareModes, setFileCompareModes] = useState<Record<string, CompareMode>>({});

  // Collapsed block state: { [filePath]: { [lineIndex]: isExpanded } }
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, Record<number, boolean>>>({});

  // Plain Text states for full source code viewing
  const [plainFileContents, setPlainFileContents] = useState<Record<string, string>>({});
  const [plainLoading, setPlainLoading] = useState<Record<string, boolean>>({});

  // Per-file staging/unstaging loading states for premium Optimistic UI
  const [stagingPaths, setStagingPaths] = useState<Record<string, boolean>>({});

  // Commit Panel visibility state (not permanent)
  const [commitPanelOpen, setCommitPanelOpen] = useState(false);

  /** 加载本地分支列表 */
  const loadBranches = useCallback(async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    try {
      const res = await fetchGitBranches(cwd);
      setBranches(res.list);
      setCurrentBranch(res.current);
    } catch {
      // 静默落回默认值
    }
  }, []);

  useEffect(() => {
    if (sourceMode === 'git') {
      void loadBranches();
    }
  }, [sourceMode, loadBranches]);

  /** 切换分支操作 */
  const handleSwitchBranch = async (branch: string) => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setGitLoading(true);
    setPanelErr('');
    dismissSoftHint();
    try {
      const res = await switchGitBranch(cwd, branch);
      if (!res.ok) {
        toastFail(res.error || '切换分支失败');
        // REVERT the dropdown value back to what it actually is in Git!
        await loadBranches();
        return;
      }
      // 成功后，自动重刷分支及 git status 变更列表
      await loadBranches();
      await loadFromGit();
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '切换分支失败');
      await loadBranches();
    } finally {
      setGitLoading(false);
    }
  };

  /** 提交变更操作 */
  const handleCommit = async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    const msg = commitMsg.trim();
    if (!msg) {
      toastFail('提交信息不能为空');
      return;
    }
    setCommitLoading(true);
    setPanelErr('');
    dismissSoftHint();
    try {
      const stagedCount = fileList.filter((f) => f.staged).length;
      // If there are staged files, commit only staged. Otherwise commit all (add -A)
      const res = await commitGitChanges(cwd, msg, stagedCount > 0);
      if (!res.ok) {
        toastFail(res.error || '提交失败');
        return;
      }
      setCommitMsg('');
      showSoftHint('提交成功！');
      // 提交成功后自动重拉工作区状态
      await loadFromGit();
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '提交失败');
    } finally {
      setCommitLoading(false);
    }
  };

  /** 推送变更操作 */
  const handlePush = async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setPushLoading(true);
    setPanelErr('');
    dismissSoftHint();
    try {
      const res = await pushGitChanges(cwd);
      if (!res.ok) {
        toastFail(res.error || '推送失败');
        return;
      }
      showSoftHint('推送成功！');
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '推送失败');
    } finally {
      setPushLoading(false);
    }
  };

  /** 🌟 Git Staging, Unstaging and Discarding Operations (Optimistic UI) 🌟 */
  const handleStageFile = async (filePath: string) => {
    const cwd = getWorkspacePath();
    if (!cwd) return;

    // Optimistically update file state instantly
    setStagingPaths((prev) => ({ ...prev, [filePath]: true }));
    setDiffFiles((prev) =>
      prev.map((f) =>
        f.filePath === filePath ? { ...f, staged: true, unstaged: false } : f
      )
    );

    try {
      const res = await stageGitPath(cwd, filePath);
      if (!res.ok) {
        toastFail(res.error || '暂存失败');
        await loadFromGit(); // Revert on failure
      } else {
        await loadFromGit(true); // Quiet silent sync in background
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '暂存失败');
      await loadFromGit();
    } finally {
      setStagingPaths((prev) => ({ ...prev, [filePath]: false }));
    }
  };

  const handleUnstageFile = async (filePath: string) => {
    const cwd = getWorkspacePath();
    if (!cwd) return;

    // Optimistically update file state instantly
    setStagingPaths((prev) => ({ ...prev, [filePath]: true }));
    setDiffFiles((prev) =>
      prev.map((f) =>
        f.filePath === filePath ? { ...f, staged: false, unstaged: true } : f
      )
    );

    try {
      const res = await unstageGitPath(cwd, filePath);
      if (!res.ok) {
        toastFail(res.error || '取消暂存失败');
        await loadFromGit(); // Revert on failure
      } else {
        await loadFromGit(true); // Quiet silent sync in background
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '取消暂存失败');
      await loadFromGit();
    } finally {
      setStagingPaths((prev) => ({ ...prev, [filePath]: false }));
    }
  };

  const handleDiscardChanges = async (filePath: string) => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    if (!window.confirm(`确定要放弃对 "${basename(filePath)}" 的所有本地未暂存修改吗？此操作不可逆。`)) {
      return;
    }
    setApplyBusy(true);
    try {
      const res = await discardGitPath(cwd, filePath);
      if (!res.ok) {
        toastFail(res.error || '放弃修改失败');
      } else {
        await loadFromGit();
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '放弃修改失败');
    } finally {
      setApplyBusy(false);
    }
  };

  const handleStageAll = async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setApplyBusy(true);
    // Optimistic UI for bulk operations
    setDiffFiles((prev) =>
      prev.map((f) => ({ ...f, staged: true, unstaged: false }))
    );
    try {
      const res = await stageAllGit(cwd);
      if (!res.ok) {
        toastFail(res.error || '暂存全部失败');
        await loadFromGit();
      } else {
        await loadFromGit(true);
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '暂存全部失败');
      await loadFromGit();
    } finally {
      setApplyBusy(false);
    }
  };

  const handleUnstageAll = async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setApplyBusy(true);
    // Optimistic UI for bulk operations
    setDiffFiles((prev) =>
      prev.map((f) => ({ ...f, staged: false, unstaged: true }))
    );
    try {
      const res = await unstageAllGit(cwd);
      if (!res.ok) {
        toastFail(res.error || '取消暂存全部失败');
        await loadFromGit();
      } else {
        await loadFromGit(true);
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '取消暂存全部失败');
      await loadFromGit();
    } finally {
      setApplyBusy(false);
    }
  };

  const clearSoftHintTimer = useCallback(() => {
    if (softHintTimerRef.current) {
      clearTimeout(softHintTimerRef.current);
      softHintTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearSoftHintTimer(), [clearSoftHintTimer]);

  const showSoftHint = useCallback(
    (message: string) => {
      const m = (message || '').trim();
      if (!m) return;
      clearSoftHintTimer();
      setPanelErr('');
      setSoftHint(m);
      softHintTimerRef.current = setTimeout(() => {
        setSoftHint('');
        softHintTimerRef.current = null;
      }, 5000);
    },
    [clearSoftHintTimer],
  );

  const dismissSoftHint = useCallback(() => {
    clearSoftHintTimer();
    setSoftHint('');
  }, [clearSoftHintTimer]);

  const dismissPanelErr = useCallback(() => {
    setPanelErr('');
  }, []);

  const aiTurns = useMemo(() => {
    const msgs = (session?.messages || []).filter(
      (m) => m.sender === 'assistant' && m.status !== 'processing',
    );
    return msgs
      .map((m, i) => ({ msg: m, index: i, files: collectMessageDiffs(m) }))
      .filter((t) => t.files.length > 0)
      .reverse();
  }, [session?.messages]);

  const hasAiTurns = aiTurns.length > 0;

  const fileList = useMemo(() => {
    if (diffFiles.length > 0) return diffFiles;
    return activeDiffSource ? [activeDiffSource] : [];
  }, [diffFiles, activeDiffSource]);

  const current = activeDiffSource;

  const applyFiles = useCallback(
    (files: FileDiff[], mode: SourceMode) => {
      // Git 占位路径正常；会话 AI 汇总再过一道发布门槛
      const next = mode === 'session' ? filterPublishableDiffs(files) : files;
      setDiffFiles(next);
      setActiveDiffSource(null);
      setSourceMode(mode);
      setPanelErr('');
      dismissSoftHint();
    },
    [dismissSoftHint, setActiveDiffSource, setDiffFiles],
  );

  /** 仅失败 toast；空串 / 成功路径绝不调用；同步行内错误条 */
  const toastFail = useCallback(
    (message: string) => {
      const m = (message || '').trim();
      if (!m) return;
      dismissSoftHint();
      setPanelErr(m);
      onShowToast(m);
    },
    [dismissSoftHint, onShowToast],
  );

  /** 🌟 Highly Enriched Git Status Loading with Staged Properties 🌟 */
  const loadFromGit = useCallback(async (silent = false) => {
    const seq = ++gitLoadSeqRef.current;
    setSourceMode('git');
    if (!silent) {
      setGitLoading(true);
      dismissSoftHint();
      setPanelErr('');
    }
    try {
      const status = await fetchGitStatus();
      if (seq !== gitLoadSeqRef.current) return;
      if (!status.found) {
        const msg = gitStatusUserMessage(status);
        toastFail(msg.hint ? `${msg.title}：${msg.hint}` : msg.title);
        return;
      }
      if (status.files.length === 0) {
        showSoftHint('工作区无未提交变更');
        setTurnKey('');
        setDiffFiles([]);
        setActiveDiffSource(null);
        return;
      }

      const statusMap = new Map(status.files.map((gf) => [gf.path.replace(/\\/g, '/'), gf]));

      const placeholders = status.files.slice(0, 45).map((gf) => ({
        filePath: gf.path,
        additions: 0,
        deletions: 0,
        changes: [{ type: 'normal' as const, content: `（${gf.status}）加载 diff…` }],
        staged: gf.staged,
        unstaged: gf.unstaged,
        untracked: gf.untracked,
        gitStatus: gf.status,
      }));
      if (!silent) {
        applyFiles(placeholders, 'git');
        setTurnKey('');
      }

      const batch = await fetchGitDiff({});
      if (seq !== gitLoadSeqRef.current) return;

      const enrich = (files: FileDiff[]) => files.map((f) => {
        const key = f.filePath.replace(/\\/g, '/');
        const gf = statusMap.get(key);
        return {
          ...f,
          staged: gf ? gf.staged : false,
          unstaged: gf ? gf.unstaged : true,
          untracked: gf ? gf.untracked : false,
          gitStatus: gf ? gf.status : 'M',
        };
      });

      if (batch.files.length > 0) {
        applyFiles(enrich(batch.files), 'git');
        return;
      }

      // 批 diff 为空：最多并行 8 个路径补样，其余保留状态占位
      const slice = status.files.slice(0, 8);
      const settled = await Promise.all(
        slice.map(async (gf) => {
          try {
            const one = await fetchGitDiff({ path: gf.path });
            return one.files;
          } catch {
            return [] as FileDiff[];
          }
        }),
      );
      if (seq !== gitLoadSeqRef.current) return;
      const collected = settled.flat();
      if (collected.length > 0) {
        const enrichedCollected = enrich(collected);
        const byPath = new Map(enrichedCollected.map((f) => [f.filePath.replace(/\\/g, '/'), f]));
        const merged = placeholders.map((p) => {
          const key = p.filePath.replace(/\\/g, '/');
          return byPath.get(key) || {
            ...p,
            changes: [{ type: 'normal' as const, content: `（已变更）暂无行级 diff` }],
          };
        });
        applyFiles(merged, 'git');
      } else {
        applyFiles(placeholders, 'git');
      }
    } catch {
      if (seq === gitLoadSeqRef.current) toastFail('从 Git 载入失败');
    } finally {
      if (seq === gitLoadSeqRef.current) setGitLoading(false);
    }
  }, [
    applyFiles,
    dismissSoftHint,
    setActiveDiffSource,
    setDiffFiles,
    showSoftHint,
    toastFail,
  ]);

  const loadSessionAll = useCallback(() => {
    const files = mergeSessionDiffFiles(aiTurns);
    if (!files.length) {
      showSoftHint('本会话暂无 AI 改动');
      setDiffFiles([]);
      setActiveDiffSource(null);
      return;
    }
    applyFiles(files, 'session');
    setTurnKey('__all__');
  }, [aiTurns, applyFiles, showSoftHint, setDiffFiles, setActiveDiffSource]);

  const onTurnSelect = (key: string) => {
    setTurnKey(key);
    if (key === '') return;
    if (key === '__all__') {
      loadSessionAll();
      return;
    }
    const turn = aiTurns.find((t) => t.msg.id === key);
    if (!turn) {
      showSoftHint('未找到该回合改动');
      return;
    }
    applyFiles(turn.files, 'session');
  };

  /** 🌟 Get compareMode for each individual file 🌟 */
  const getFileCompareMode = (filePath: string) => {
    return fileCompareModes[filePath] || (sourceMode === 'git' ? 'git' : 'session-merged');
  };

  const changeFileCompareMode = async (filePath: string, mode: CompareMode) => {
    setFileCompareModes((prev) => ({ ...prev, [filePath]: mode }));
    if (mode === 'plain') {
      await loadPlainContent(filePath);
    }
  };

  /** 🌟 Resolve Active Diff Source per File dynamically 🌟 */
  const getFileDiffData = (f: FileDiff) => {
    const mode = getFileCompareMode(f.filePath);
    if (mode === 'plain') {
      return null;
    }
    if (mode === 'git') {
      return f;
    }
    if (mode === 'session-merged') {
      const mergedFiles = mergeSessionDiffFiles(aiTurns);
      return mergedFiles.find((m) => m.filePath === f.filePath) || f;
    }
    if (mode.startsWith('turn-')) {
      const turnId = mode.substring(5);
      const turn = aiTurns.find((t) => t.msg.id === turnId);
      if (turn) {
        return turn.files.find((m) => m.filePath === f.filePath) || f;
      }
    }
    return f;
  };

  const getComputedChanges = (f: FileDiff) => {
    const target = getFileDiffData(f);
    if (!target) return [];
    let oldLineNum = 0;
    let newLineNum = 0;
    
    return target.changes.map((c, globalIdx) => {
      let oldLine: number | undefined;
      let newLine: number | undefined;
      const isHeader = c.content.startsWith('@@') && c.type === 'normal';
      
      if (isHeader) {
        const match = c.content.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (match) {
          oldLineNum = parseInt(match[1], 10) - 1;
          newLineNum = parseInt(match[2], 10) - 1;
        }
      } else {
        if (c.type === 'addition') {
          newLineNum += 1;
          newLine = newLineNum;
        } else if (c.type === 'deletion') {
          oldLineNum += 1;
          oldLine = oldLineNum;
        } else {
          oldLineNum += 1;
          newLineNum += 1;
          oldLine = oldLineNum;
          newLine = newLineNum;
        }
      }
      
      return {
        change: c,
        globalIdx,
        oldLine,
        newLine,
        isHeader,
      };
    });
  };

  /** 🌟 Split View Lines Aligner 🌟 */
  const getSplitPairs = (f: FileDiff, inputLines?: ReturnType<typeof getComputedChanges>) => {
    const lines = inputLines ?? getComputedChanges(f);
    const pairs: Array<{
      left?: typeof lines[0];
      right?: typeof lines[0];
    }> = [];
    let i = 0;
    while (i < lines.length) {
      const currentLine = lines[i];
      if (currentLine.isHeader) {
        i++;
        continue;
      }
      if (currentLine.change.type === 'deletion') {
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.change.type === 'addition') {
          pairs.push({ left: currentLine, right: nextLine });
          i += 2;
        } else {
          pairs.push({ left: currentLine });
          i++;
        }
      } else if (currentLine.change.type === 'addition') {
        pairs.push({ right: currentLine });
        i++;
      } else {
        pairs.push({ left: currentLine, right: currentLine });
        i++;
      }
    }
    return pairs;
  };

  const acceptAll = useCallback(async () => {
    if (!fileList.length || applyBusy) return;
    const safe = fileList.filter((f) => classifyFileDiff(f).ok);
    if (!safe.length) {
      toastFail('无法安全自动应用，请在编辑器确认');
      return;
    }
    setApplyBusy(true);
    try {
      const { failed, results } = await applyFileDiffsToDisk(safe);
      for (const r of results) {
        if (r.result.ok) removeDiffFile(r.filePath);
      }
      if (failed > 0) {
        toastFail(formatApplyFailureToast(failed, results));
      } else {
        setPanelErr('');
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      toastFail(detail ? `应用失败：${detail}` : '应用失败');
    } finally {
      setApplyBusy(false);
    }
  }, [applyBusy, fileList, removeDiffFile, toastFail]);

  const clearList = useCallback(() => {
    setDiffFiles([]);
    setActiveDiffSource(null);
    setTurnKey('');
    setSourceMode('list');
    setDiffSearchQuery('');
    setSearchOpen(false);
    setPanelErr('');
    dismissSoftHint();
  }, [dismissSoftHint, setActiveDiffSource, setDiffFiles]);

  const busy = applyBusy || gitLoading;

  const turnOptions = useMemo(() => {
    const opts: { value: string; label: string; hint?: string }[] = [
      {
        value: '__all__',
        label: '本会话全部 AI 改动',
        hint: hasAiTurns ? `${aiTurns.reduce((n, t) => n + t.files.length, 0)} 文件` : undefined,
      },
    ];
    for (const t of aiTurns) {
      opts.push({
        value: t.msg.id,
        label: assistantTurnLabel(t.msg, t.index, t.files.length),
        hint: `${t.files.length} 文件`,
      });
    }
    return opts;
  }, [aiTurns, hasAiTurns]);

  const switchSource = (mode: 'session' | 'git') => {
    if (mode === 'git') {
      void loadFromGit();
      return;
    }
    if (!hasAiTurns) {
      showSoftHint('本会话暂无 AI 改动');
      setSourceMode('session');
      setTurnKey('');
      setDiffFiles([]);
      setActiveDiffSource(null);
      return;
    }
    const latest = aiTurns[0];
    if (latest) {
      setTurnKey(latest.msg.id);
      applyFiles(latest.files, 'session');
    } else {
      loadSessionAll();
    }
  };

  /** 🌟 Collapsible Diff Context Algoritm (Unified View) 🌟 */
  const getUnifiedRenderItems = (f: FileDiff, inputComputed?: ReturnType<typeof getComputedChanges>) => {
    const computed = inputComputed ?? getComputedChanges(f);
    const q = diffSearchQuery.trim().toLowerCase();
    const changes = q ? computed.filter((item) => item.change.content.toLowerCase().includes(q)) : computed;
    const total = changes.length;
    const isVisible = new Array(total).fill(false);
    
    if (q) {
      return changes.map((c, i) => ({
        isCollapsedPlaceholder: false as const,
        index: i,
        item: c,
      })) as UnifiedRenderItem[];
    }

    const contextCount = 3;
    for (let i = 0; i < total; i++) {
      const type = changes[i].change.type;
      const isHeader = changes[i].isHeader;
      if (type === 'addition' || type === 'deletion' || isHeader) {
        isVisible[i] = true;
        for (let j = Math.max(0, i - contextCount); j < i; j++) {
          if (changes[j].change.type === 'normal') isVisible[j] = true;
        }
        for (let j = i + 1; j <= Math.min(total - 1, i + contextCount); j++) {
          if (changes[j].change.type === 'normal') isVisible[j] = true;
        }
      }
    }

    const fileKey = f.filePath;
    const renderItems: UnifiedRenderItem[] = [];
    let collapsedStart = -1;

    for (let i = 0; i < total; i++) {
      const isExpanded = expandedBlocks[fileKey]?.[i] || false;
      if (isVisible[i] || isExpanded) {
        if (collapsedStart !== -1) {
          const count = i - collapsedStart;
          renderItems.push({
            isCollapsedPlaceholder: true,
            startIndex: collapsedStart,
            count,
          });
          collapsedStart = -1;
        }
        renderItems.push({
          isCollapsedPlaceholder: false,
          index: i,
          item: changes[i],
        });
      } else {
        if (collapsedStart === -1) {
          collapsedStart = i;
        }
      }
    }

    if (collapsedStart !== -1) {
      const count = total - collapsedStart;
      renderItems.push({
        isCollapsedPlaceholder: true,
        startIndex: collapsedStart,
        count,
      });
    }

    return renderItems;
  };

  /** 🌟 Collapsible Diff Context Algoritm (Split View) 🌟 */
  const getSplitRenderItems = (f: FileDiff, inputLines?: ReturnType<typeof getComputedChanges>) => {
    const pairs = getSplitPairs(f, inputLines);
    const q = diffSearchQuery.trim().toLowerCase();
    if (q) {
      return pairs.map((p, i) => ({
        isCollapsedPlaceholder: false as const,
        index: i,
        pair: p,
      })) as SplitRenderItem[];
    }

    const total = pairs.length;
    const isVisible = new Array(total).fill(false);

    const contextCount = 3;
    for (let i = 0; i < total; i++) {
      const p = pairs[i];
      const hasDiff = (p.left && p.left.change.type !== 'normal') || (p.right && p.right.change.type !== 'normal');
      const isHeader = (p.left && p.left.isHeader) || (p.right && p.right.isHeader);
      
      if (hasDiff || isHeader) {
        isVisible[i] = true;
        for (let j = Math.max(0, i - contextCount); j < i; j++) {
          isVisible[j] = true;
        }
        for (let j = i + 1; j <= Math.min(total - 1, i + contextCount); j++) {
          isVisible[j] = true;
        }
      }
    }

    const fileKey = f.filePath;
    const renderItems: SplitRenderItem[] = [];
    let collapsedStart = -1;

    for (let i = 0; i < total; i++) {
      const isExpanded = expandedBlocks[fileKey]?.[i] || false;
      if (isVisible[i] || isExpanded) {
        if (collapsedStart !== -1) {
          const count = i - collapsedStart;
          renderItems.push({
            isCollapsedPlaceholder: true,
            startIndex: collapsedStart,
            count,
          });
          collapsedStart = -1;
        }
        renderItems.push({
          isCollapsedPlaceholder: false,
          index: i,
          pair: pairs[i],
        });
      } else {
        if (collapsedStart === -1) {
          collapsedStart = i;
        }
      }
    }

    if (collapsedStart !== -1) {
      const count = total - collapsedStart;
      renderItems.push({
        isCollapsedPlaceholder: true,
        startIndex: collapsedStart,
        count,
      });
    }

    return renderItems;
  };

  const handleExpandBlock = (fileKey: string, startIndex: number) => {
    setExpandedBlocks((prev) => ({
      ...prev,
      [fileKey]: {
        ...(prev[fileKey] || {}),
        [startIndex]: true,
      },
    }));
  };

  /** 🌟 Load Plain Disk Content for Full Code View 🌟 */
  const loadPlainContent = async (filePath: string) => {
    if (plainFileContents[filePath] !== undefined) return;
    setPlainLoading((prev) => ({ ...prev, [filePath]: true }));
    try {
      const res = await readTextFile(filePath, 1000000); // Request up to 1,000,000 lines
      const content = res.content || '（空文件或读取失败）';
      setPlainFileContents((prev) => ({ ...prev, [filePath]: content }));
    } catch (err) {
      setPlainFileContents((prev) => ({ ...prev, [filePath]: '读取源码失败：' + String(err) }));
    } finally {
      setPlainLoading((prev) => ({ ...prev, [filePath]: false }));
    }
  };

  const handleCopyCodeOfFile = async (filePath: string) => {
    try {
      const res = await readTextFile(filePath);
      if (res.content) {
        // Warning confirmation for gigantic system copies
        if (res.content.length > 3 * 1024 * 1024) {
          if (!window.confirm(`该文件内容十分庞大 (${(res.content.length / 1024 / 1024).toFixed(2)} MB)，进行复制操作可能导致剪贴板短时间卡死。确定要复制吗？`)) {
            return;
          }
        }
        await navigator.clipboard.writeText(res.content);
        onShowToast('最新源码已复制到剪贴板');
      }
    } catch (err) {
      onShowToast('复制失败：' + String(err));
    }
  };

  const acceptCurrentFile = async (f: FileDiff) => {
    if (applyBusy) return;
    const cls = classifyFileDiff(f);
    if (!cls.ok) {
      toastFail('无法安全自动应用，请在编辑器确认');
      return;
    }
    setApplyBusy(true);
    try {
      const result = await applyFileDiffToDisk(f);
      if (result.ok === true) {
        removeDiffFile(f.filePath);
        setPanelErr('');
        return;
      }
      const msg = formatApplyFailureToast(1, [
        { filePath: f.filePath, result },
      ]);
      toastFail(msg || result.message || '无法安全自动应用，请在编辑器确认');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      toastFail(
        detail
          ? `应用失败 · ${basename(f.filePath)}：${detail}`
          : `应用失败 · ${basename(f.filePath)}`,
      );
    } finally {
      setApplyBusy(false);
    }
  };

  const rejectCurrentFile = useCallback((f: FileDiff) => {
    removeDiffFile(f.filePath);
  }, [removeDiffFile]);

  // Computed partitioned list of staged vs unstaged for git mode
  const { stagedCount, unstagedCount } = useMemo(() => {
    let staged = 0;
    let unstaged = 0;
    for (const f of fileList) {
      if (f.staged) staged++;
      else unstaged++;
    }
    return { stagedCount: staged, unstagedCount: unstaged };
  }, [fileList]);

  /** 🌟 Collapsed / Expanding Diff Content Helper 🌟 */
  const renderInlineDiffContent = (f: FileDiff) => {
    const compareMode = getFileCompareMode(f.filePath);

    if (compareMode === 'plain') {
      if (plainLoading[f.filePath]) {
        return (
          <div className={styles.detailLoading}>
            <Lucide.Loader2 size={16} className="spin" />
            <span>正在加载源码...</span>
          </div>
        );
      }
      
      const fileContent = plainFileContents[f.filePath] || '';
      return (
        <VirtualPlainCodeViewer
          content={fileContent}
          filePath={f.filePath}
        />
      );
    }

    const computed = getComputedChanges(f);
    const q = diffSearchQuery.trim();
    if (q && computed.filter(item => item.change.content.toLowerCase().includes(q.toLowerCase())).length === 0) {
      return (
        <div className={styles.empty} role="status" aria-live="polite" style={{ padding: '16px 10px' }}>
          <div>无匹配行</div>
          <div className={styles.emptySub}>
            筛选「{q}」无结果
          </div>
        </div>
      );
    }

    if (diffViewMode === 'split') {
      const renderItems = getSplitRenderItems(f, computed);
      return (
        <DiffCardSplitView
          f={f}
          renderItems={renderItems}
          onExpandBlock={handleExpandBlock}
        />
      );
    }

    const renderItems = getUnifiedRenderItems(f, computed);
    return (
      <DiffCardUnifiedView
        f={f}
        renderItems={renderItems}
        onExpandBlock={handleExpandBlock}
      />
    );
  };

  return (
    <div
      className={styles.panel}
      aria-label="代码变更面板"
      aria-busy={busy || undefined}
      data-source={sourceMode}
    >
      {/* 双排统一高度工具栏 */}
      <div className={styles.toolbarContainer} role="toolbar" aria-label="变更工具栏">
        <div className={styles.toolbarRow1}>
          <div className={styles.sourceSeg} role="group" aria-label="变更来源">
            <Tooltip content="当前对话中 AI 产生的改动">
              <button
                type="button"
                className={`${styles.sourceBtn} ${sourceMode === 'session' ? styles.isOn : ''}`}
                aria-pressed={sourceMode === 'session'}
                disabled={applyBusy}
                onClick={() => switchSource('session')}
              >
                AI 改动
              </button>
            </Tooltip>
            <Tooltip content="工作区 Git 未提交变更">
              <button
                type="button"
                className={`${styles.sourceBtn} ${sourceMode === 'git' ? styles.isOn : ''}`}
                aria-pressed={sourceMode === 'git'}
                disabled={gitLoading || applyBusy}
                onClick={() => switchSource('git')}
              >
                {gitLoading ? 'Git…' : 'Git'}
              </button>
            </Tooltip>
          </div>

          <div className={styles.toolbarActions1}>
            <Tooltip content={diffViewMode === 'unified' ? '切换至分栏视图 (Split View)' : '切换至合并视图 (Unified View)'}>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label={diffViewMode === 'unified' ? '切换至分栏视图' : '切换至合并视图'}
                onClick={() => setDiffViewMode(diffViewMode === 'unified' ? 'split' : 'unified')}
              >
                {diffViewMode === 'unified' ? (
                  <Lucide.Columns2 size={14} aria-hidden />
                ) : (
                  <Lucide.List size={14} aria-hidden />
                )}
              </button>
            </Tooltip>

            {sourceMode === 'git' && fileList.length > 0 && (
              <Tooltip content={commitPanelOpen ? "隐藏提交面板" : "显示提交面板"}>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${commitPanelOpen ? styles.isOn : ''}`}
                  aria-label="切换提交面板"
                  onClick={() => setCommitPanelOpen((v) => !v)}
                >
                  <Lucide.GitCommit size={14} aria-hidden />
                </button>
              </Tooltip>
            )}

            <Tooltip content="筛选行">
              <button
                type="button"
                className={`${styles.iconBtn} ${searchOpen || searchActive ? styles.isOn : ''}`}
                aria-label="筛选 diff 行"
                aria-pressed={searchOpen || searchActive}
                disabled={!current}
                onClick={() => setSearchOpen((v) => !v)}
              >
                <Lucide.Search size={14} aria-hidden />
              </button>
            </Tooltip>
            {fileList.length > 0 ? (
              <Tooltip content="清空列表">
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label="清空变更列表"
                  disabled={applyBusy}
                  onClick={clearList}
                >
                  <Lucide.Trash2 size={14} aria-hidden />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>

        {/* 第二排：AI改动回合 / Git 切换分支下拉框 */}
        <div className={styles.toolbarRow2}>
          {sourceMode === 'session' ? (
            <SettingsSelect
              className={styles.turnSettingsSelect}
              disabled={busy}
              value={turnKey}
              options={turnOptions}
              onChange={onTurnSelect}
            />
          ) : sourceMode === 'git' ? (
            <div className={styles.branchSelectWrap}>
              <Lucide.GitBranch size={13} className={styles.branchIcon} aria-hidden />
              <SettingsSelect
                className={styles.turnSettingsSelect}
                disabled={busy}
                value={currentBranch}
                options={branches.map((b) => ({ value: b, label: b }))}
                onChange={(val) => void handleSwitchBranch(val)}
              />
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>载入变更源开始对比</div>
          )}
        </div>
      </div>

      {/* 行级筛选搜索框 */}
      {searchOpen || searchActive ? (
        <div className={styles.searchRow}>
          <input
            type="search"
            className={styles.searchInput}
            placeholder="搜索/筛选行…"
            value={rawDiffSearchQuery}
            disabled={!current}
            onChange={(e) => setDiffSearchQuery(e.target.value)}
          />
        </div>
      ) : null}

      {/* 异常错误提示框: Styled beautifully with pre-wrapping preventing layout breaks! */}
      {panelErr ? (
        <div
          className={styles.panelErrBanner}
          role="alert"
          aria-live="assertive"
        >
          <Lucide.AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <div className={styles.panelErrText}>
            {panelErr}
          </div>
          <Tooltip content="关闭错误">
            <button
              type="button"
              className={styles.panelErrDismiss}
              aria-label="关闭错误"
              onClick={dismissPanelErr}
            >
              <Lucide.X size={13} aria-hidden />
            </button>
          </Tooltip>
        </div>
      ) : null}

      {/* 软提示 */}
      {!panelErr && softHint ? (
        <div
          className={styles.applyHint}
          role="status"
          aria-live="polite"
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{softHint}</span>
          <Tooltip content="关闭">
            <button
              type="button"
              className="files-action-hint-dismiss"
              aria-label="关闭提示"
              onClick={dismissSoftHint}
            >
              <Lucide.X size={12} aria-hidden />
            </button>
          </Tooltip>
        </div>
      ) : null}

      <div className={styles.bodyWrap}>
        {fileList.length > 0 ? (
          <DiffCardFileList
            files={fileList}
            sourceMode={sourceMode}
            current={current}
            applyBusy={applyBusy}
            stagingPaths={stagingPaths}
            aiTurns={aiTurns}
            getFileCompareMode={getFileCompareMode}
            onChangeCompareMode={changeFileCompareMode}
            onSetActiveDiffSource={setActiveDiffSource}
            onStageFile={handleStageFile}
            onUnstageFile={handleUnstageFile}
            onDiscardChanges={handleDiscardChanges}
            onStageAll={handleStageAll}
            onUnstageAll={handleUnstageAll}
            onAcceptFile={acceptCurrentFile}
            onRejectFile={rejectCurrentFile}
            onCopyCode={handleCopyCodeOfFile}
            onShowToast={onShowToast}
            renderInlineDiffContent={renderInlineDiffContent}
          />
        ) : !gitLoading ? (
          <div className={styles.empty} role="status" aria-live="polite">
            <Lucide.FileDiff size={22} style={{ opacity: 0.3 }} aria-hidden />
            <div>暂无变更</div>
            <div className={styles.emptySub}>
              上方切换「AI 改动」查看本对话回合；或切「Git」加载工作区未提交变更。
            </div>
            <div className={styles.emptyActions}>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={!hasAiTurns || applyBusy}
                aria-label="查看 AI 改动"
                onClick={() => switchSource('session')}
              >
                AI 改动
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                disabled={gitLoading || applyBusy}
                aria-label="载入 Git 未提交变更"
                onClick={() => switchSource('git')}
              >
                <Lucide.GitBranch size={15} aria-hidden />
                Git
              </button>
            </div>
          </div>
        ) : null}

        {gitLoading && fileList.length === 0 ? (
          <div className={styles.empty} role="status" aria-live="polite">
            <Lucide.Loader2 size={22} className="spin" style={{ opacity: 0.45 }} aria-hidden />
            <div>载入 Git 变更…</div>
          </div>
        ) : null}
      </div>

      {sourceMode === 'git' && fileList.length > 0 && (
        <DiffCardGitActions
          open={commitPanelOpen}
          commitMsg={commitMsg}
          commitLoading={commitLoading}
          pushLoading={pushLoading}
          stagedCount={stagedCount}
          unstagedCount={unstagedCount}
          onToggle={() => setCommitPanelOpen((v) => !v)}
          onCommitMsgChange={setCommitMsg}
          onCommit={handleCommit}
          onPush={handlePush}
        />
      )}
    </div>
  );
};

export const DiffCard = React.memo(DiffCardInner);
