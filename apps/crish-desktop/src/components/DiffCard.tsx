/**
 * 右侧变更面板：Git 工作区变更 + 本会话 AI 回合汇总（下拉）。
 * 支持接受/拒绝落盘（工程闭环）。
 * 工具栏以图标为主，保持功能行紧凑。
 * 反馈策略：成功静默；失败 toast + 行内；空态/软提示仅行内。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { FileDiff } from '../store/layoutStore';
import {
  selectActiveSession,
  useSessionField,
} from '../store/sessionStore';
import * as Lucide from 'lucide-react';
import { fetchGitDiff, fetchGitStatus, gitStatusUserMessage } from '../api/gitApi';
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

interface DiffCardProps {
  onShowToast: (message: string) => void;
}

type SourceMode = DiffSourceMode;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

const DiffCardInner: React.FC<DiffCardProps> = ({ onShowToast }) => {
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const setActiveDiffSource = useLayoutStore((s) => s.setActiveDiffSource);
  const setDiffFiles = useLayoutStore((s) => s.setDiffFiles);
  const removeDiffFile = useLayoutStore((s) => s.removeDiffFile);
  /** O(1) 活动会话，避免 sessions 整表订阅 + find */
  const session = useSessionField(selectActiveSession);

  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified');
  const [diffSearchQuery, setDiffSearchQuery] = useState('');
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

  const current = activeDiffSource || fileList[0] || null;

  const applyFiles = useCallback(
    (files: FileDiff[], mode: SourceMode) => {
      // Git 占位路径正常；会话 AI 汇总再过一道发布门槛
      const next = mode === 'session' ? filterPublishableDiffs(files) : files;
      setDiffFiles(next);
      setActiveDiffSource(next[0] || null);
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

  const loadFromGit = useCallback(async () => {
    const seq = ++gitLoadSeqRef.current;
    setSourceMode('git');
    setGitLoading(true);
    dismissSoftHint();
    setPanelErr('');
    try {
      const status = await fetchGitStatus();
      if (seq !== gitLoadSeqRef.current) return;
      if (!status.found) {
        const msg = gitStatusUserMessage(status);
        toastFail(msg.hint ? `${msg.title}：${msg.hint}` : msg.title);
        return;
      }
      if (status.files.length === 0) {
        // 软空态：行内提示，不 toast（非失败）
        showSoftHint('工作区无未提交变更');
        setTurnKey('');
        setDiffFiles([]);
        setActiveDiffSource(null);
        return;
      }
      // 先用状态列表出结果（秒开），再补一行级 diff；禁止 12 路串行拖死 UI
      const placeholders = status.files.slice(0, 40).map((gf) => ({
        filePath: gf.path,
        additions: 0,
        deletions: 0,
        changes: [{ type: 'normal' as const, content: `（${gf.status}）加载 diff…` }],
      }));
      applyFiles(placeholders, 'git');
      setTurnKey('');

      const batch = await fetchGitDiff({});
      if (seq !== gitLoadSeqRef.current) return;
      if (batch.files.length > 0) {
        applyFiles(batch.files, 'git');
        return;
      }

      // 批 diff 为空：最多并行 4 个路径补样，其余保留状态占位
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
        // 合并：有 diff 的替换，其余保留占位
        const byPath = new Map(collected.map((f) => [f.filePath.replace(/\\/g, '/'), f]));
        const merged = placeholders.map((p) => {
          const key = p.filePath.replace(/\\/g, '/');
          return byPath.get(key) || {
            ...p,
            changes: [{ type: 'normal' as const, content: `（已变更）暂无行级 diff` }],
          };
        });
        applyFiles(merged, 'git');
      } else {
        applyFiles(
          placeholders.map((p) => ({
            ...p,
            changes: [{ type: 'normal' as const, content: '（已变更）暂无行级 diff' }],
          })),
          'git',
        );
        showSoftHint('已列出状态文件，暂无行级 diff');
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
      return;
    }
    applyFiles(files, 'session');
    setTurnKey('__all__');
  }, [aiTurns, applyFiles, showSoftHint]);

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

  const filteredChanges = useMemo(() => {
    if (!current) return [];
    const q = diffSearchQuery.trim().toLowerCase();
    if (!q) return current.changes;
    return current.changes.filter((c) => c.content.toLowerCase().includes(q));
  }, [current, diffSearchQuery]);

  const searchActive = diffSearchQuery.trim().length > 0;
  const noSearchHits = Boolean(current && searchActive && filteredChanges.length === 0);

  const currentCanApply = useMemo(
    () => (current ? classifyFileDiff(current).ok : false),
    [current],
  );

  const rejectCurrent = useCallback(() => {
    if (!current) return;
    removeDiffFile(current.filePath);
    // 列表移除即反馈，不 toast 成功
  }, [current, removeDiffFile]);

  const acceptCurrent = useCallback(async () => {
    if (!current || applyBusy) return;
    const cls = classifyFileDiff(current);
    if (!cls.ok) {
      toastFail('无法安全自动应用，请在编辑器确认');
      return;
    }
    setApplyBusy(true);
    try {
      const result = await applyFileDiffToDisk(current);
      if (result.ok === true) {
        removeDiffFile(current.filePath);
        setPanelErr('');
        // 应用成功：条目消失即反馈（成功静默）
        return;
      }
      // 单文件失败：带文件名，与批量 formatApplyFailureToast 一致
      const msg = formatApplyFailureToast(1, [
        { filePath: current.filePath, result },
      ]);
      toastFail(msg || result.message || '无法安全自动应用，请在编辑器确认');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      toastFail(
        detail
          ? `应用失败 · ${basename(current.filePath)}：${detail}`
          : `应用失败 · ${basename(current.filePath)}`,
      );
    } finally {
      setApplyBusy(false);
    }
  }, [applyBusy, current, removeDiffFile, toastFail]);

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
      // 成功静默；仅失败 toast（含首个失败文件名）；空串不 toast
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
    // 清空即反馈，不 toast
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
    // AI：默认最近一轮有改动的回合
    if (!hasAiTurns) {
      showSoftHint('本会话暂无 AI 改动');
      setSourceMode('session');
      setTurnKey('');
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

  return (
    <div
      className="diff-panel"
      aria-label="代码变更面板"
      aria-busy={busy || undefined}
      data-source={sourceMode}
    >
      <div className="diff-toolbar" role="toolbar" aria-label="变更工具栏">
        <div className="diff-toolbar-left">
          <div className="diff-source-seg" role="group" aria-label="变更来源">
            <button
              type="button"
              className={`diff-source-btn ${sourceMode === 'session' ? 'is-on' : ''}`}
              aria-pressed={sourceMode === 'session'}
              title="当前对话中 AI 产生的改动"
              disabled={applyBusy}
              onClick={() => switchSource('session')}
            >
              AI 改动
            </button>
            <button
              type="button"
              className={`diff-source-btn ${sourceMode === 'git' ? 'is-on' : ''}`}
              aria-pressed={sourceMode === 'git'}
              title="工作区 Git 未提交变更"
              disabled={gitLoading || applyBusy}
              onClick={() => switchSource('git')}
            >
              {gitLoading ? 'Git…' : 'Git'}
            </button>
          </div>
          {fileList.length > 0 ? (
            <span
              className="diff-toolbar-meta"
              title={`${fileList.length} 个文件`}
              aria-label={`${fileList.length} 个文件`}
            >
              {fileList.length} 文件
            </span>
          ) : null}
        </div>
        <div className="diff-toolbar-actions">
          {sourceMode !== 'git' ? (
            <div className="diff-turn-select-wrap">
              <SettingsSelect
                className="diff-turn-settings-select"
                value={turnKey}
                placeholder={hasAiTurns ? '选择回合…' : '暂无 AI 改动'}
                disabled={!hasAiTurns || applyBusy}
                options={turnOptions}
                onChange={(v) => {
                  if (!v) return;
                  onTurnSelect(v);
                }}
                maxHeight={260}
              />
            </div>
          ) : (
            <span className="diff-toolbar-meta diff-toolbar-meta--git" title="工作区未提交变更">
              工作区
            </span>
          )}
          {fileList.length > 1 ? (
            <button
              type="button"
              className="diff-icon-btn diff-icon-btn--accept"
              title="全部接受（可安全应用的文件）"
              aria-label="全部接受可安全应用的文件"
              disabled={applyBusy}
              onClick={() => void acceptAll()}
            >
              <Lucide.CheckCheck size={15} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className={`diff-icon-btn diff-view-btn ${diffViewMode === 'unified' ? 'is-on' : ''}`}
            title="合并视图"
            aria-label="合并视图"
            aria-pressed={diffViewMode === 'unified'}
            onClick={() => setDiffViewMode('unified')}
          >
            <Lucide.List size={15} aria-hidden />
          </button>
          <button
            type="button"
            className={`diff-icon-btn diff-view-btn ${diffViewMode === 'split' ? 'is-on' : ''}`}
            title="分栏视图"
            aria-label="分栏视图"
            aria-pressed={diffViewMode === 'split'}
            onClick={() => setDiffViewMode('split')}
          >
            <Lucide.Columns2 size={15} aria-hidden />
          </button>
          <button
            type="button"
            className={`diff-icon-btn ${searchOpen || searchActive ? 'is-on' : ''}`}
            title="筛选行"
            aria-label="筛选 diff 行"
            aria-pressed={searchOpen || searchActive}
            disabled={!current}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Lucide.Search size={15} aria-hidden />
          </button>
          {fileList.length > 0 ? (
            <button
              type="button"
              className="diff-icon-btn"
              title="清空列表"
              aria-label="清空变更列表"
              disabled={applyBusy}
              onClick={clearList}
            >
              <Lucide.Trash2 size={15} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {(searchOpen || searchActive) && current ? (
        <div className="diff-search-row">
          <div className="diff-search">
            <Lucide.Search size={14} aria-hidden />
            <input
              type="text"
              placeholder="筛选 diff 行…"
              aria-label="筛选 diff 行"
              value={diffSearchQuery}
              autoFocus
              onChange={(e) => setDiffSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDiffSearchQuery('');
                  setSearchOpen(false);
                }
              }}
            />
            {searchActive ? (
              <button
                type="button"
                className="diff-icon-btn"
                style={{ width: 22, height: 22, flexShrink: 0 }}
                title="清除筛选"
                aria-label="清除筛选"
                onClick={() => setDiffSearchQuery('')}
              >
                <Lucide.X size={12} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 硬失败条：复用 files-action-hint 密度，避免 thrash panels.css */}
      {panelErr ? (
        <div className="files-action-hint" role="alert" aria-live="assertive">
          <span className="files-action-hint-text" title={panelErr}>
            {panelErr}
          </span>
          <button
            type="button"
            className="files-action-hint-dismiss"
            title="关闭"
            aria-label="关闭错误"
            onClick={dismissPanelErr}
          >
            <Lucide.X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      {/* 软提示：空结果等，不 toast；轻量 flex 复用既有 dismiss 控件 */}
      {!panelErr && softHint ? (
        <div
          className="diff-apply-hint"
          role="status"
          aria-live="polite"
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{softHint}</span>
          <button
            type="button"
            className="files-action-hint-dismiss"
            title="关闭"
            aria-label="关闭提示"
            onClick={dismissSoftHint}
          >
            <Lucide.X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="diff-body-wrap">
        {fileList.length > 1 ? (
          <div
            className="diff-file-list"
            role="listbox"
            aria-label="变更文件列表"
            aria-activedescendant={
              current
                ? `diff-file-${current.filePath.replace(/[^\w.-]+/g, '_')}`
                : undefined
            }
          >
            {fileList.map((f) => {
              const active = current?.filePath === f.filePath;
              const itemId = `diff-file-${f.filePath.replace(/[^\w.-]+/g, '_')}`;
              return (
                <button
                  key={f.filePath}
                  id={itemId}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`diff-file-item ${active ? 'is-active' : ''}`}
                  onClick={() => setActiveDiffSource(f)}
                  title={f.filePath}
                  aria-label={`${basename(f.filePath)} +${f.additions} −${f.deletions}`}
                >
                  <span className="diff-file-name">{basename(f.filePath)}</span>
                  <span className="diff-file-stat" aria-hidden>
                    <span className="add">+{f.additions}</span>
                    <span className="del">−{f.deletions}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className={`diff-body ${diffViewMode === 'split' ? 'is-split' : ''}`}>
          {gitLoading && !current ? (
            <div className="diff-empty" role="status" aria-live="polite">
              <Lucide.Loader2 size={22} className="spin" style={{ opacity: 0.45 }} aria-hidden />
              <div>载入 Git 变更…</div>
            </div>
          ) : !current ? (
            <div className="diff-empty" role="status" aria-live="polite">
              <Lucide.FileDiff size={22} style={{ opacity: 0.3 }} aria-hidden />
              <div>暂无变更</div>
              <div className="diff-empty-sub">
                上方切换「AI 改动」查看本对话回合；或切「Git」加载工作区未提交变更。
              </div>
              <div className="diff-empty-actions">
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
          ) : (
            <>
              <div className="diff-current-header">
                <div className="diff-current-path" title={current.filePath}>
                  {/* 窄栏时优先显示文件名，完整路径放 title */}
                  <span className="diff-current-basename">{basename(current.filePath)}</span>
                  <span className="diff-current-fullpath">{current.filePath}</span>
                </div>
                <div className="diff-apply-actions">
                  <button
                    type="button"
                    className="diff-icon-btn diff-icon-btn--accept"
                    title={
                      currentCanApply
                        ? '接受并写入磁盘'
                        : '此 diff 无法安全自动应用'
                    }
                    aria-label={
                      currentCanApply
                        ? `接受并写入 ${basename(current.filePath)}`
                        : '无法安全自动应用'
                    }
                    disabled={applyBusy || !currentCanApply}
                    onClick={() => void acceptCurrent()}
                  >
                    <Lucide.Check size={15} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="diff-icon-btn"
                    title="从列表拒绝（不回滚磁盘）"
                    aria-label={`拒绝 ${basename(current.filePath)}`}
                    disabled={applyBusy}
                    onClick={rejectCurrent}
                  >
                    <Lucide.X size={15} aria-hidden />
                  </button>
                  {fileList.length > 1 ? (
                    <button
                      type="button"
                      className="diff-icon-btn diff-icon-btn--accept"
                      title="批量接受列表中可安全应用的文件"
                      aria-label="全部接受可安全应用的文件"
                      disabled={applyBusy}
                      onClick={() => void acceptAll()}
                    >
                      <Lucide.CheckCheck size={15} aria-hidden />
                    </button>
                  ) : null}
                </div>
              </div>
              {!currentCanApply ? (
                <div className="diff-apply-hint" role="status">
                  此 diff 无法安全自动应用，请在编辑器确认
                </div>
              ) : null}
              {noSearchHits ? (
                <div className="diff-empty" role="status" aria-live="polite">
                  <div>无匹配行</div>
                  <div className="diff-empty-sub">
                    筛选「{diffSearchQuery.trim()}」无结果
                  </div>
                  <div className="diff-empty-actions">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-label="清除筛选"
                      onClick={() => setDiffSearchQuery('')}
                    >
                      清除筛选
                    </button>
                  </div>
                </div>
              ) : (
                <pre
                  className="diff-lines"
                  aria-label={`${basename(current.filePath)} 的变更内容${
                    searchActive ? `（已筛选，${filteredChanges.length} 行）` : ''
                  }`}
                >
                  {filteredChanges.map((c, i) => (
                    <div
                      key={i}
                      className={`diff-line diff-line--${c.type}`}
                    >
                      <span className="diff-line-mark" aria-hidden>
                        {c.type === 'addition' ? '+' : c.type === 'deletion' ? '−' : ' '}
                      </span>
                      <span className="diff-line-text">{c.content}</span>
                    </div>
                  ))}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export const DiffCard = React.memo(DiffCardInner);
