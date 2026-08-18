/**
 * 右侧变更面板：Git 工作区变更 + 本会话 AI 回合汇总（下拉）。
 * 瘦身为 ≤300 行的组装层。
 */
import React, { useCallback, useDeferredValue, useState } from 'react';
import styles from './DiffCard.module.css';
import { Button, ConfirmDialog, Tooltip } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import { selectActiveSession, useSessionField } from '../../store/storeAccess';
import type { FileDiff } from '../../store/types';
import {
  useTerminalField,
  selectActiveDiffSource,
  selectDiffFiles,
} from '../../store/storeAccess';
import * as Lucide from 'lucide-react';
import { filterPublishableDiffs } from '../../api/publishToolDiffs';
import type { DiffSourceMode } from '../../api/diffPanelHelpers';
import { readTextFile } from '../../api/workspaceFsApi';
import { DiffCardFileList } from './DiffCardFileList';
import { DiffCardGitActions } from './DiffCardGitActions';
import { DiffHeaderControls } from './DiffHeaderControls';
import { DiffCodeViewer } from './DiffCodeViewer';
import { useDiffData } from './useDiffData';
import { useDiffGitActions } from './useDiffGitActions';
import { formatGitPatch } from './GitPatchFormatter';
import { getWorkspacePath } from '../../api/projectStore';
import {
  acceptCurrentFile as acceptCurrentFileImpl,
  rejectCurrentFile as rejectCurrentFileImpl,
} from './DiffCardHandlers';

import { useToast } from '../../services/toast/ToastContext';

export interface DiffCardProps {
  className?: string;
}

const DiffCardInner: React.FC<DiffCardProps> = () => {
  const { showToast } = useToast();
  const activeDiffSource = useTerminalField(selectActiveDiffSource);
  const diffFiles = useTerminalField(selectDiffFiles) as FileDiff[];
  const setActiveDiffSource = useTerminalField((s) => s.setActiveDiffSource);
  const setDiffFiles = useTerminalField((s) => s.setDiffFiles);
  const removeDiffFile = useTerminalField((s) => s.removeDiffFile);
  const session = useSessionField(selectActiveSession);

  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>(
    'unified'
  );
  const [rawDiffSearchQuery, setDiffSearchQuery] = useState('');
  const diffSearchQuery = useDeferredValue(rawDiffSearchQuery);
  const searchActive = !!rawDiffSearchQuery.trim();
  const [searchOpen, setSearchOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [sourceMode, setSourceMode] = useState<DiffSourceMode>('list');
  const [turnKey, setTurnKey] = useState('');
  const [panelErr, setPanelErr] = useState('');
  const [_softHint, setSoftHint] = useState('');
  const [commitPanelOpen, setCommitPanelOpen] = useState(false);
  // window.confirm → ConfirmDialog Promise 桥（批次 4.1，04-detail §2.1.1）
  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const {
    aiTurns,
    hasAiTurns,
    mergedSessionFiles,
    fileList,
    computedChangesByFile,
    turnOptions,
    plainLoading,
    plainFileContents,
    changeFileCompareMode,
    getFileCompareMode,
    handleExpandBlock,
    unifiedRenderCache,
    splitRenderCache,
    stagedCount,
    unstagedCount,
  } = useDiffData({
    session: session ?? null,
    diffFiles,
    activeDiffSource,
    diffSearchQuery,
    diffViewMode,
    sourceMode,
  });

  const showSoftHint = useCallback((message: string) => {
    const m = (message || '').trim();
    if (m) {
      setPanelErr('');
      setSoftHint(m);
    }
  }, []);

  const dismissSoftHint = useCallback(() => setSoftHint(''), []);

  const toastFail = useCallback(
    (message: string) => {
      const m = (message || '').trim();
      if (m) {
        dismissSoftHint();
        setPanelErr(m);
        showToast(m);
      }
    },
    [dismissSoftHint, showToast]
  );

  const applyFiles = useCallback(
    (files: FileDiff[], mode: DiffSourceMode) => {
      setDiffFiles(mode === 'session' ? filterPublishableDiffs(files) : files);
      setActiveDiffSource(null);
      setSourceMode(mode);
      setPanelErr('');
      dismissSoftHint();
    },
    [dismissSoftHint, setActiveDiffSource, setDiffFiles]
  );

  const {
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
    confirmGateView,
  } = useDiffGitActions({
    sessionWorkspacePath: getWorkspacePath(),
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
  });

  const loadSessionAll = useCallback(() => {
    if (!mergedSessionFiles.length) {
      showSoftHint('本会话暂无 AI 改动');
      setDiffFiles([]);
      setActiveDiffSource(null);
      return;
    }
    applyFiles(mergedSessionFiles, 'session');
    setTurnKey('__all__');
  }, [
    mergedSessionFiles,
    applyFiles,
    showSoftHint,
    setDiffFiles,
    setActiveDiffSource,
  ]);

  const onTurnSelect = (key: string) => {
    setTurnKey(key);
    if (!key) return;
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

  const handleCopyCodeOfFile = async (filePath: string) => {
    try {
      const res = await readTextFile(filePath);
      if (res.content) {
        if (res.content.length > 3 * 1024 * 1024) {
          const ok = await confirmGate({
            title: '复制大文件',
            description: `文件庞大 (${(res.content.length / 1024 / 1024).toFixed(2)} MB)，确定复制？`,
            confirmLabel: '确定复制',
          });
          if (!ok) return;
        }
        await navigator.clipboard.writeText(res.content);
        showToast('最新源码已复制到剪贴板');
      }
    } catch (err) {
      showToast('复制失败：' + String(err));
    }
  };

  const acceptCurrentFile = (f: FileDiff) =>
    acceptCurrentFileImpl(f, applyBusy, setApplyBusy, removeDiffFile, setPanelErr, toastFail);

  const rejectCurrentFile = useCallback(
    (f: FileDiff) => rejectCurrentFileImpl(f, removeDiffFile),
    [removeDiffFile]
  );

  const switchSource = (mode: 'session' | 'git') => {
    if (mode === 'git') {
      void loadFromGit();
      return;
    }
    if (!aiTurns.length) {
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
    } else loadSessionAll();
  };

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

  const handleCopyPatch = useCallback(() => {
    if (!activeDiffSource) return;
    const patch = formatGitPatch(activeDiffSource);
    navigator.clipboard.writeText(patch);
    showToast('已复制标准 Git Patch 到剪贴板');
  }, [activeDiffSource, showToast]);

  const renderInlineDiffContent = (f: FileDiff) => (
    <DiffCodeViewer
      f={f}
      compareMode={getFileCompareMode(f.filePath)}
      diffViewMode={diffViewMode}
      diffSearchQuery={diffSearchQuery}
      plainLoading={plainLoading[f.filePath]}
      plainContent={plainFileContents[f.filePath]}
      unifiedRenderItems={unifiedRenderCache.get(f.filePath) ?? []}
      splitRenderItems={splitRenderCache.get(f.filePath) ?? []}
      computed={computedChangesByFile.get(f.filePath) ?? []}
      onExpandBlock={handleExpandBlock}
    />
  );

  return (
    <div
      className={styles.panel}
      aria-label="代码变更面板"
      aria-busy={applyBusy || gitLoading || undefined}
      data-source={sourceMode}
    >
      <DiffHeaderControls
        sourceMode={sourceMode}
        diffViewMode={diffViewMode}
        searchOpen={searchOpen}
        searchActive={searchActive}
        gitLoading={gitLoading}
        applyBusy={applyBusy}
        busy={applyBusy || gitLoading}
        turnKey={turnKey}
        turnOptions={turnOptions}
        branches={branches}
        currentBranch={currentBranch}
        commitPanelOpen={commitPanelOpen}
        fileListLength={fileList.length}
        current={activeDiffSource}
        hasAiTurns={hasAiTurns}
        onViewModeChange={() =>
          setDiffViewMode(diffViewMode === 'unified' ? 'split' : 'unified')
        }
        onSearchOpenChange={setSearchOpen}
        onSourceModeChange={switchSource}
        onTurnSelect={onTurnSelect}
        onBranchChange={(val) => void handleSwitchBranch(val)}
        onCommitPanelToggle={() => setCommitPanelOpen((v) => !v)}
        onCopyPatch={handleCopyPatch}
        onClear={clearList}
      />

      {searchOpen || searchActive ? (
        <div className={styles.searchRow}>
          <input
            type="search"
            className={styles.searchInput}
            placeholder="搜索/筛选行…"
            value={rawDiffSearchQuery}
            onChange={(e) => setDiffSearchQuery(e.target.value)}
          />
        </div>
      ) : null}

      {panelErr ? (
        <div
          className={styles.panelErrBanner}
          role="alert"
          aria-live="assertive"
        >
          <Lucide.AlertCircle
            size={14}
            style={{ flexShrink: 0, marginTop: 1 }}
          />
          <div className={styles.panelErrText}>{panelErr}</div>
          <Tooltip content="关闭错误">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.panelErrDismiss}
              aria-label="关闭错误"
              onClick={() => setPanelErr('')}
              icon={<Lucide.X size={13} aria-hidden />}
            />
          </Tooltip>
        </div>
      ) : null}

      <div className={styles.bodyWrap}>
        {fileList.length > 0 ? (
          <DiffCardFileList
            files={fileList}
            sourceMode={sourceMode}
            current={activeDiffSource}
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
            renderInlineDiffContent={renderInlineDiffContent}
          />
        ) : !gitLoading ? (
          <div className={styles.empty} role="status" aria-live="polite">
            <Lucide.FileDiff size={22} style={{ opacity: 0.3 }} aria-hidden />
            <div>暂无变更</div>
            <div className={styles.emptySub}>
              上方切换「AI
              改动」查看本对话回合；或切「Git」加载工作区未提交变更。
            </div>
            <div className={styles.emptyActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!hasAiTurns || applyBusy}
                onClick={() => switchSource('session')}
              >
                AI 改动
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={gitLoading || applyBusy}
                onClick={() => switchSource('git')}
                icon={<Lucide.GitBranch size={15} aria-hidden />}
              >
                Git
              </Button>
            </div>
          </div>
        ) : null}

        {gitLoading && fileList.length === 0 ? (
          <div className={styles.empty} role="status" aria-live="polite">
            <Lucide.Loader2
              size={22}
              className="spin"
              style={{ opacity: 0.45 }}
              aria-hidden
            />
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

      {/* 确认对话框渲染点：useDiffGitActions（放弃修改）+ 本组件（大文件复制） */}
      {confirmGateView}
      {renderConfirmGate(<ConfirmDialog />)}
    </div>
  );
};

export const DiffCard = React.memo(DiffCardInner);
