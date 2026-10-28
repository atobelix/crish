import { createElement, useCallback, useEffect, useState } from 'react';
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
} from '../../api/gitApi';
import { compactObj } from '../../utils/compactObj';
import type { FileDiff } from '../../store/types';
import type { DiffSourceMode } from '../../api/diffPanelHelpers';
import { ConfirmDialog } from '@/components/ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';

interface UseDiffGitActionsOptions {
  sessionWorkspacePath?: string;
  sourceMode: DiffSourceMode;
  stagedCount: number;
  setDiffFiles: (
    files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])
  ) => void;
  setActiveDiffSource: (diff: FileDiff | null) => void;
  setSourceMode: (mode: DiffSourceMode) => void;
  setPanelErr: (err: string) => void;
  showSoftHint: (msg: string) => void;
  dismissSoftHint: () => void;
  toastFail: (msg: string) => void;
  applyFiles: (files: FileDiff[], mode: DiffSourceMode) => void;
  setTurnKey: (key: string) => void;
}

export function useDiffGitActions({
  sessionWorkspacePath,
  sourceMode,
  stagedCount,
  setDiffFiles,
  setActiveDiffSource,
  setSourceMode,
  setPanelErr,
  showSoftHint,
  dismissSoftHint,
  toastFail,
  applyFiles,
  setTurnKey,
}: UseDiffGitActionsOptions) {
  const [gitLoading, setGitLoading] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>('');
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [stagingPaths, setStagingPaths] = useState<Record<string, boolean>>({});
  // window.confirm → ConfirmDialog Promise 桥（批次 4.1，04-detail §2.1.1）；
  // hook 不直接渲染，渲染物经返回值交给宿主（DiffCard）挂载
  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const loadBranches = useCallback(async () => {
    try {
      const res = await fetchGitBranches(sessionWorkspacePath ?? '');
      setBranches(res.list);
      setCurrentBranch(res.current);
    } catch (error) {
      setBranches([]);
      setCurrentBranch('');
      toastFail(
        error instanceof Error ? error.message : 'Git branch load failed'
      );
    }
  }, [sessionWorkspacePath, toastFail]);

  useEffect(() => {
    if (sourceMode === 'git') void loadBranches();
  }, [sourceMode, loadBranches]);

  const loadFromGit = useCallback(
    async (silent = false) => {
      setSourceMode('git');
      if (!silent) {
        setGitLoading(true);
        dismissSoftHint();
        setPanelErr('');
      }
      try {
        const status = await fetchGitStatus();
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
        const statusMap = new Map(
          status.files.map((gf) => [gf.path.replace(/\\/g, '/'), gf])
        );
        const placeholders: FileDiff[] = status.files
          .slice(0, 45)
          .map((gf): FileDiff => ({
            filePath: gf.path,
            additions: 0,
            deletions: 0,
            changes: [
              {
                type: 'normal' as const,
                content: `（${gf.status}）加载 diff…`,
              },
            ],
            gitStatus: gf.status,
            ...compactObj({
              staged: gf.staged,
              unstaged: gf.unstaged,
              untracked: gf.untracked,
            }),
          }));
        if (!silent) {
          applyFiles(placeholders, 'git');
          setTurnKey('');
        }
        const batch = await fetchGitDiff({});
        const enrich = (files: FileDiff[]): FileDiff[] =>
          files.map((f): FileDiff => {
            const gf = statusMap.get(f.filePath.replace(/\\/g, '/'));
            return {
              ...f,
              staged: gf ? Boolean(gf.staged) : false,
              unstaged: gf ? Boolean(gf.unstaged) : true,
              untracked: gf ? Boolean(gf.untracked) : false,
              gitStatus: gf ? gf.status : 'M',
            };
          });

        if (batch.files.length > 0) {
          applyFiles(enrich(batch.files), 'git');
          return;
        }
        const slice = status.files.slice(0, 8);
        const settled = await Promise.all(
          slice.map(async (gf) => (await fetchGitDiff({ path: gf.path })).files)
        );
        const collected = settled.flat();
        if (collected.length > 0) {
          const byPath = new Map(
            enrich(collected).map((f) => [f.filePath.replace(/\\/g, '/'), f])
          );
          applyFiles(
            placeholders.map(
              (p) =>
                byPath.get(p.filePath.replace(/\\/g, '/')) || {
                  ...p,
                  changes: [
                    {
                      type: 'normal' as const,
                      content: '（已变更）暂无行级 diff',
                    },
                  ],
                }
            ),
            'git'
          );
        } else {
          applyFiles(placeholders, 'git');
        }
      } catch (error) {
        if (!silent) {
          setDiffFiles([]);
          setActiveDiffSource(null);
        }
        toastFail(error instanceof Error ? error.message : '从 Git 载入失败');
      } finally {
        setGitLoading(false);
      }
    },
    [
      applyFiles,
      dismissSoftHint,
      setActiveDiffSource,
      setDiffFiles,
      setPanelErr,
      setSourceMode,
      setTurnKey,
      showSoftHint,
      toastFail,
    ]
  );

  const handleSwitchBranch = async (branch: string) => {
    setGitLoading(true);
    setPanelErr('');
    dismissSoftHint();
    try {
      const res = await switchGitBranch(sessionWorkspacePath ?? '', branch);
      if (!res.ok) {
        toastFail(res.error || '切换分支失败');
        await loadBranches();
        return;
      }
      await loadBranches();
      await loadFromGit();
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '切换分支失败');
      await loadBranches();
    } finally {
      setGitLoading(false);
    }
  };

  const handleCommit = async () => {
    const msg = commitMsg.trim();
    if (!msg) {
      toastFail('提交信息不能为空');
      return;
    }
    setCommitLoading(true);
    setPanelErr('');
    dismissSoftHint();
    try {
      const res = await commitGitChanges(
        sessionWorkspacePath ?? '',
        msg,
        stagedCount > 0
      );
      if (!res.ok) {
        toastFail(res.error || '提交失败');
        return;
      }
      setCommitMsg('');
      showSoftHint('提交成功！');
      await loadFromGit();
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '提交失败');
    } finally {
      setCommitLoading(false);
    }
  };

  const handlePush = async () => {
    setPushLoading(true);
    setPanelErr('');
    dismissSoftHint();
    try {
      const res = await pushGitChanges(sessionWorkspacePath ?? '');
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

  const handleStageFile = async (filePath: string) => {
    setStagingPaths((prev) => ({ ...prev, [filePath]: true }));
    setDiffFiles((prev) =>
      prev.map((f) =>
        f.filePath === filePath ? { ...f, staged: true, unstaged: false } : f
      )
    );
    try {
      const res = await stageGitPath(sessionWorkspacePath ?? '', filePath);
      if (!res.ok) {
        toastFail(res.error || '暂存失败');
        await loadFromGit();
      } else {
        await loadFromGit(true);
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '暂存失败');
      await loadFromGit();
    } finally {
      setStagingPaths((prev) => ({ ...prev, [filePath]: false }));
    }
  };

  const handleUnstageFile = async (filePath: string) => {
    setStagingPaths((prev) => ({ ...prev, [filePath]: true }));
    setDiffFiles((prev) =>
      prev.map((f) =>
        f.filePath === filePath ? { ...f, staged: false, unstaged: true } : f
      )
    );
    try {
      const res = await unstageGitPath(sessionWorkspacePath ?? '', filePath);
      if (!res.ok) {
        toastFail(res.error || '取消暂存失败');
        await loadFromGit();
      } else {
        await loadFromGit(true);
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '取消暂存失败');
      await loadFromGit();
    } finally {
      setStagingPaths((prev) => ({ ...prev, [filePath]: false }));
    }
  };

  const handleDiscardChanges = async (filePath: string) => {
    const name = filePath.replace(/^.*[\\/]/, '') || filePath;
    const ok = await confirmGate({
      title: '放弃修改',
      description: `确定要放弃对 "${name}" 的所有本地未暂存修改吗？此操作不可逆。`,
      confirmLabel: '确认放弃',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await discardGitPath(sessionWorkspacePath ?? '', filePath);
      if (!res.ok) toastFail(res.error || '放弃修改失败');
      else await loadFromGit();
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '放弃修改失败');
    }
  };

  const handleStageAll = async () => {
    setDiffFiles((prev) =>
      prev.map((f) => ({ ...f, staged: true, unstaged: false }))
    );
    try {
      const res = await stageAllGit(sessionWorkspacePath ?? '');
      if (!res.ok) {
        toastFail(res.error || '暂存全部失败');
        await loadFromGit();
      } else {
        await loadFromGit(true);
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '暂存全部失败');
      await loadFromGit();
    }
  };

  const handleUnstageAll = async () => {
    setDiffFiles((prev) =>
      prev.map((f) => ({ ...f, staged: false, unstaged: true }))
    );
    try {
      const res = await unstageAllGit(sessionWorkspacePath ?? '');
      if (!res.ok) {
        toastFail(res.error || '取消暂存全部失败');
        await loadFromGit();
      } else {
        await loadFromGit(true);
      }
    } catch (err) {
      toastFail(err instanceof Error ? err.message : '取消暂存全部失败');
      await loadFromGit();
    }
  };

  return {
    gitLoading,
    branches,
    currentBranch,
    commitMsg,
    commitLoading,
    pushLoading,
    stagingPaths,
    setCommitMsg,
    loadFromGit,
    handleSwitchBranch,
    handleCommit,
    handlePush,
    handleStageFile,
    handleUnstageFile,
    handleDiscardChanges,
    handleStageAll,
    handleUnstageAll,
    confirmGateView: renderConfirmGate(createElement(ConfirmDialog)),
  };
}
