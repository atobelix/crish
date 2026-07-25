import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchGitDiff, fetchGitStatus, gitStatusUserMessage,
  fetchGitBranches, switchGitBranch, commitGitChanges, pushGitChanges,
  stageGitPath, unstageGitPath, discardGitPath, stageAllGit, unstageAllGit,
} from '../../api/gitApi';
import { getWorkspacePath } from '../../api/projectStore';
import type { FileDiff } from '../../store/types';
import type { DiffSourceMode } from '../../api/diffPanelHelpers';

type SourceMode = DiffSourceMode;

/**
 * 把 GitStatusFile 上的可选字段（staged/unstaged/untracked）通过条件展开注入 FileDiff，
 * 避免在 `exactOptionalPropertyTypes: true` 下因 `undefined` 漂移污染目标类型。
 *
 * 同时把 gitStatus 字段一并补齐，保证列表项可被后续 stage/unstage 逻辑正确识别。
 *
 * 此函数返回的是「占位 FileDiff」——additions/deletions 为 0、changes 仅含一行提示文案。
 * 真正的行级 diff 由后续 `fetchGitDiff` 异步拉取并替换。
 */
function buildPlaceholderFileDiff(
  gf: { path: string; status: string; staged?: boolean; unstaged?: boolean; untracked?: boolean },
): FileDiff {
  const changes: FileDiff['changes'] = [
    { type: 'normal', content: `（${gf.status}）加载 diff…` },
  ];
  return {
    filePath: gf.path,
    additions: 0,
    deletions: 0,
    changes,
    ...(gf.staged !== undefined ? { staged: gf.staged } : {}),
    ...(gf.unstaged !== undefined ? { unstaged: gf.unstaged } : {}),
    ...(gf.untracked !== undefined ? { untracked: gf.untracked } : {}),
    gitStatus: gf.status,
  };
}

/**
 * 用 GitStatusFile 信息丰富已抓回的 FileDiff（行级 diff 已就绪）。
 * - 命中状态：补齐 staged/unstaged/untracked/gitStatus
 * - 未命中：默认 staged=false / unstaged=true / untracked=false / gitStatus='M'
 *
 * 通过条件展开构造对象，避免 `as FileDiff` 类型逃逸。
 */
function enrichFileDiff(
  f: FileDiff,
  statusMap: Map<string, { staged?: boolean; unstaged?: boolean; untracked?: boolean; status: string }>,
): FileDiff {
  const key = f.filePath.replace(/\\/g, '/');
  const gf = statusMap.get(key);
  const staged = gf ? gf.staged : false;
  const unstaged = gf ? gf.unstaged : true;
  const untracked = gf ? gf.untracked : false;
  const gitStatus = gf ? gf.status : 'M';
  return {
    ...f,
    ...(staged !== undefined ? { staged } : {}),
    ...(unstaged !== undefined ? { unstaged } : {}),
    ...(untracked !== undefined ? { untracked } : {}),
    gitStatus,
  };
}

export function useDiffGitPanel(opts: {
  sourceMode: SourceMode;
  fileList: FileDiff[];
  onApplyFiles: (files: FileDiff[], mode: SourceMode) => void;
  onShowSoftHint: (msg: string) => void;
  onToastFail: (msg: string) => void;
  setDiffFiles: (updater: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])) => void;
  setActiveDiffSource: (source: FileDiff | null) => void;
}) {
  const { sourceMode, fileList, onShowSoftHint, onToastFail, setDiffFiles, setActiveDiffSource } = opts;

  const [branches, setBranches] = useState<string[]>(['main']);
  const [currentBranch, setCurrentBranch] = useState<string>('main');
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [stagingPaths, setStagingPaths] = useState<Record<string, boolean>>({});
  const [commitPanelOpen, setCommitPanelOpen] = useState(false);
  const gitLoadSeqRef = useRef(0);

  const loadBranches = useCallback(async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    try {
      const res = await fetchGitBranches(cwd);
      setBranches(res.list);
      setCurrentBranch(res.current);
    } catch {
      // 分支拉取失败属可恢复错误：UI 仍能展示当前假定的 'main'，后续操作触发重试
      console.debug('[DiffGitPanel] loadBranches failed');
    }
  }, []);

  useEffect(() => {
    if (sourceMode === 'git') void loadBranches();
  }, [sourceMode, loadBranches]);

  /**
   * 从 Git 拉取 status + diff，写回 setDiffFiles。
   * 用 gitLoadSeqRef 做请求序号保护：后发起的请求若先返回，前序返回时序号不匹配则丢弃。
   *
   * 注意：必须先声明此函数，再被 handleSwitchBranch / handleCommit 等回调引用，
   * 避免「Block-scoped variable used before declaration」以及 useCallback 依赖缺失导致的 stale closure。
   */
  const loadFromGit = useCallback(async (silent = false) => {
    const seq = ++gitLoadSeqRef.current;
    if (!silent) { setGitLoading(true); }
    try {
      const status = await fetchGitStatus();
      if (seq !== gitLoadSeqRef.current) return;
      if (!status.found) { onToastFail(gitStatusUserMessage(status).title); return; }
      if (status.files.length === 0) {
        onShowSoftHint('工作区无未提交变更');
        setDiffFiles([]);
        setActiveDiffSource(null);
        return;
      }
      const statusMap = new Map(
        status.files.map((gf) => [gf.path.replace(/\\/g, '/'), gf]),
      );
      const placeholders: FileDiff[] = status.files
        .slice(0, 45)
        .map((gf) => buildPlaceholderFileDiff(gf));
      if (!silent) { setActiveDiffSource(null); setDiffFiles(placeholders); }
      const batch = await fetchGitDiff({});
      if (seq !== gitLoadSeqRef.current) return;
      const enrich = (files: FileDiff[]): FileDiff[] =>
        files.map((f) => enrichFileDiff(f, statusMap));
      if (batch.files.length > 0) { setDiffFiles(enrich(batch.files)); return; }
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
        const byPath = new Map(
          enrichedCollected.map((f) => [f.filePath.replace(/\\/g, '/'), f]),
        );
        const fallbackChanges: FileDiff['changes'] = [
          { type: 'normal', content: '（已变更）暂无行级 diff' },
        ];
        setDiffFiles(
          placeholders.map((p) => {
            const found = byPath.get(p.filePath.replace(/\\/g, '/'));
            if (found) return found;
            return { ...p, changes: fallbackChanges };
          }),
        );
      } else {
        setDiffFiles(placeholders);
      }
    } catch {
      if (seq === gitLoadSeqRef.current) onToastFail('从 Git 载入失败');
    } finally {
      if (seq === gitLoadSeqRef.current) setGitLoading(false);
    }
  }, [onToastFail, onShowSoftHint, setDiffFiles, setActiveDiffSource]);

  const handleSwitchBranch = useCallback(async (branch: string) => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setGitLoading(true);
    try {
      const res = await switchGitBranch(cwd, branch);
      if (!res.ok) { onToastFail(res.error || '切换分支失败'); await loadBranches(); return; }
      await loadBranches();
      await loadFromGit();
    } catch (err) {
      onToastFail(err instanceof Error ? err.message : '切换分支失败');
      await loadBranches();
    } finally { setGitLoading(false); }
  }, [loadBranches, loadFromGit, onToastFail]);

  const handleCommit = useCallback(async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    const msg = commitMsg.trim();
    if (!msg) { onToastFail('提交信息不能为空'); return; }
    setCommitLoading(true);
    try {
      const stagedCount = fileList.filter((f) => f.staged).length;
      const res = await commitGitChanges(cwd, msg, stagedCount > 0);
      if (!res.ok) { onToastFail(res.error || '提交失败'); return; }
      setCommitMsg('');
      onShowSoftHint('提交成功！');
      await loadFromGit();
    } catch (err) {
      onToastFail(err instanceof Error ? err.message : '提交失败');
    } finally { setCommitLoading(false); }
  }, [commitMsg, fileList, loadFromGit, onToastFail, onShowSoftHint]);

  const handlePush = useCallback(async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setPushLoading(true);
    try {
      const res = await pushGitChanges(cwd);
      if (!res.ok) { onToastFail(res.error || '推送失败'); return; }
      onShowSoftHint('推送成功！');
    } catch (err) {
      onToastFail(err instanceof Error ? err.message : '推送失败');
    } finally { setPushLoading(false); }
  }, [onToastFail, onShowSoftHint]);

  const handleStageFile = useCallback(async (filePath: string) => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setStagingPaths((prev) => ({ ...prev, [filePath]: true }));
    setDiffFiles((prev) => prev.map((f) => f.filePath === filePath ? { ...f, staged: true, unstaged: false } : f));
    try {
      const res = await stageGitPath(cwd, filePath);
      if (!res.ok) { onToastFail(res.error || '暂存失败'); await loadFromGit(); } else await loadFromGit(true);
    } catch (err) { onToastFail(err instanceof Error ? err.message : '暂存失败'); await loadFromGit(); }
    finally { setStagingPaths((prev) => ({ ...prev, [filePath]: false })); }
  }, [onToastFail, loadFromGit, setDiffFiles]);

  const handleUnstageFile = useCallback(async (filePath: string) => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setStagingPaths((prev) => ({ ...prev, [filePath]: true }));
    setDiffFiles((prev) => prev.map((f) => f.filePath === filePath ? { ...f, staged: false, unstaged: true } : f));
    try {
      const res = await unstageGitPath(cwd, filePath);
      if (!res.ok) { onToastFail(res.error || '取消暂存失败'); await loadFromGit(); } else await loadFromGit(true);
    } catch (err) { onToastFail(err instanceof Error ? err.message : '取消暂存失败'); await loadFromGit(); }
    finally { setStagingPaths((prev) => ({ ...prev, [filePath]: false })); }
  }, [onToastFail, loadFromGit, setDiffFiles]);

  const handleDiscardChanges = useCallback(async (filePath: string) => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    if (!window.confirm(`确定要放弃对 "${filePath.replace(/^.*[\\/]/, '')}" 的所有本地未暂存修改吗？此操作不可逆。`)) return;
    try {
      const res = await discardGitPath(cwd, filePath);
      if (!res.ok) onToastFail(res.error || '放弃修改失败'); else await loadFromGit();
    } catch (err) { onToastFail(err instanceof Error ? err.message : '放弃修改失败'); }
  }, [onToastFail, loadFromGit]);

  const handleStageAll = useCallback(async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setDiffFiles((prev) => prev.map((f) => ({ ...f, staged: true, unstaged: false })));
    try {
      const res = await stageAllGit(cwd);
      if (!res.ok) { onToastFail(res.error || '暂存全部失败'); await loadFromGit(); } else await loadFromGit(true);
    } catch (err) { onToastFail(err instanceof Error ? err.message : '暂存全部失败'); await loadFromGit(); }
  }, [onToastFail, loadFromGit, setDiffFiles]);

  const handleUnstageAll = useCallback(async () => {
    const cwd = getWorkspacePath();
    if (!cwd) return;
    setDiffFiles((prev) => prev.map((f) => ({ ...f, staged: false, unstaged: true })));
    try {
      const res = await unstageAllGit(cwd);
      if (!res.ok) { onToastFail(res.error || '取消暂存全部失败'); await loadFromGit(); } else await loadFromGit(true);
    } catch (err) { onToastFail(err instanceof Error ? err.message : '取消暂存全部失败'); await loadFromGit(); }
  }, [onToastFail, loadFromGit, setDiffFiles]);

  const stagedCount = fileList.filter((f) => f.staged).length;
  const unstagedCount = fileList.filter((f) => !f.staged).length;

  return {
    branches, currentBranch, commitMsg, setCommitMsg,
    commitLoading, pushLoading, commitPanelOpen, setCommitPanelOpen,
    stagingPaths, gitLoading, stagedCount, unstagedCount,
    loadBranches, handleSwitchBranch, handleCommit, handlePush,
    handleStageFile, handleUnstageFile, handleDiscardChanges,
    handleStageAll, handleUnstageAll, loadFromGit,
  };
}
