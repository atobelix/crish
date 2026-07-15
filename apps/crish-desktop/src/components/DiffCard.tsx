/**
 * 右侧变更面板：Git 工作区变更 + 本会话 AI 回合汇总（下拉）。
 * 工具栏以图标为主，保持功能行紧凑。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { FileDiff, SessionMessage } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { fetchGitDiff, fetchGitStatus } from '../api/gitApi';
import { collectMessageDiffs } from './ChangeOverviewCard';

interface DiffCardProps {
  onShowToast: (message: string) => void;
}

type SourceMode = 'session' | 'git' | 'list';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

function assistantTurnLabel(msg: SessionMessage, index: number): string {
  const files = collectMessageDiffs(msg);
  const n = files.length;
  const t = new Date(msg.timestamp || Date.now());
  const time = `${t.getHours().toString().padStart(2, '0')}:${t
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
  if (n === 0) return `回合 ${index + 1} · ${time}`;
  return `回合 ${index + 1} · ${n} 个文件 · ${time}`;
}

const DiffCardInner: React.FC<DiffCardProps> = ({ onShowToast }) => {
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const setActiveDiffSource = useLayoutStore((s) => s.setActiveDiffSource);
  const setDiffFiles = useLayoutStore((s) => s.setDiffFiles);
  const pushDiffFile = useLayoutStore((s) => s.pushDiffFile);

  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified');
  const [diffSearchQuery, setDiffSearchQuery] = useState('');
  const [gitLoading, setGitLoading] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('list');
  const [turnKey, setTurnKey] = useState('');

  const session = sessions.find((s) => s.id === activeSessionId);
  const aiTurns = useMemo(() => {
    const msgs = (session?.messages || []).filter(
      (m) => m.sender === 'assistant' && m.status !== 'processing',
    );
    return msgs
      .map((m, i) => ({ msg: m, index: i, files: collectMessageDiffs(m) }))
      .filter((t) => t.files.length > 0)
      .reverse();
  }, [session?.messages]);

  const fileList = useMemo(() => {
    if (diffFiles.length > 0) return diffFiles;
    return activeDiffSource ? [activeDiffSource] : [];
  }, [diffFiles, activeDiffSource]);

  const current = activeDiffSource || fileList[0] || null;

  const applyFiles = useCallback(
    (files: FileDiff[], mode: SourceMode) => {
      setDiffFiles(files);
      setActiveDiffSource(files[0] || null);
      setSourceMode(mode);
    },
    [setActiveDiffSource, setDiffFiles],
  );

  const loadFromGit = useCallback(async () => {
    setGitLoading(true);
    try {
      const status = await fetchGitStatus();
      if (!status.found || status.files.length === 0) {
        onShowToast(status.found ? '工作区无未提交变更' : '无法读取 Git 状态');
        return;
      }
      const collected: FileDiff[] = [];
      const batch = await fetchGitDiff({});
      if (batch.files.length > 0) {
        for (const f of batch.files) {
          pushDiffFile(f);
          collected.push(f);
        }
      } else {
        for (const gf of status.files.slice(0, 20)) {
          const one = await fetchGitDiff({ path: gf.path });
          for (const f of one.files) {
            pushDiffFile(f);
            collected.push(f);
          }
        }
      }
      if (collected.length > 0) {
        applyFiles(collected, 'git');
        setTurnKey('');
        onShowToast(`Git · ${collected.length} 个文件`);
      } else {
        const placeholders = status.files.slice(0, 20).map((gf) => ({
          filePath: gf.path,
          additions: 0,
          deletions: 0,
          changes: [{ type: 'normal' as const, content: `（${gf.status}）暂无行级 diff` }],
        }));
        applyFiles(placeholders, 'git');
        setTurnKey('');
        onShowToast(`Git · 列出 ${placeholders.length} 个文件`);
      }
    } catch {
      onShowToast('从 Git 载入失败');
    } finally {
      setGitLoading(false);
    }
  }, [applyFiles, onShowToast, pushDiffFile]);

  const loadSessionAll = useCallback(() => {
    const map = new Map<string, FileDiff>();
    for (const t of aiTurns) {
      for (const f of t.files) {
        const prev = map.get(f.filePath);
        if (!prev) map.set(f.filePath, f);
        else {
          map.set(f.filePath, {
            ...f,
            additions: (prev.additions || 0) + (f.additions || 0),
            deletions: (prev.deletions || 0) + (f.deletions || 0),
            changes: [...(prev.changes || []), ...(f.changes || [])].slice(0, 400),
          });
        }
      }
    }
    const files = [...map.values()];
    if (!files.length) {
      onShowToast('本会话尚无 AI 文件改动');
      return;
    }
    applyFiles(files, 'session');
    setTurnKey('__all__');
    onShowToast(`本会话 · ${files.length} 个文件`);
  }, [aiTurns, applyFiles, onShowToast]);

  const onTurnSelect = (key: string) => {
    setTurnKey(key);
    if (key === '') return;
    if (key === '__all__') {
      loadSessionAll();
      return;
    }
    const turn = aiTurns.find((t) => t.msg.id === key);
    if (!turn) return;
    applyFiles(turn.files, 'session');
    onShowToast(assistantTurnLabel(turn.msg, turn.index));
  };

  const filteredChanges = useMemo(() => {
    if (!current) return [];
    const q = diffSearchQuery.trim().toLowerCase();
    if (!q) return current.changes;
    return current.changes.filter((c) => c.content.toLowerCase().includes(q));
  }, [current, diffSearchQuery]);

  return (
    <div className="diff-panel">
      <div className="diff-toolbar">
        <div className="diff-toolbar-left">
          <Lucide.FileDiff size={16} className="diff-toolbar-ico" />
          <span className="diff-toolbar-title">
            {sourceMode === 'git' ? 'Git' : sourceMode === 'session' ? '会话' : '变更'}
          </span>
          {fileList.length > 0 ? (
            <span className="diff-toolbar-meta">{fileList.length}</span>
          ) : null}
        </div>
        <div className="diff-toolbar-actions">
          <select
            className="diff-turn-select"
            value={turnKey}
            title="本会话 AI 改动汇总"
            onChange={(e) => onTurnSelect(e.target.value)}
          >
            <option value="">AI 回合…</option>
            <option value="__all__">本会话全部改动</option>
            {aiTurns.map((t) => (
              <option key={t.msg.id} value={t.msg.id}>
                {assistantTurnLabel(t.msg, t.index)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="diff-icon-btn"
            title="载入 Git 未提交变更"
            disabled={gitLoading}
            onClick={() => void loadFromGit()}
          >
            <Lucide.GitBranch size={16} className={gitLoading ? 'spin' : ''} />
          </button>
          <button
            type="button"
            className="diff-icon-btn"
            title="本会话全部 AI 改动"
            onClick={loadSessionAll}
          >
            <Lucide.Layers size={16} />
          </button>
          <button
            type="button"
            className={`diff-icon-btn ${diffViewMode === 'unified' ? 'is-on' : ''}`}
            title="合并视图"
            onClick={() => setDiffViewMode('unified')}
          >
            <Lucide.List size={16} />
          </button>
          <button
            type="button"
            className={`diff-icon-btn ${diffViewMode === 'split' ? 'is-on' : ''}`}
            title="分栏视图"
            onClick={() => setDiffViewMode('split')}
          >
            <Lucide.Columns size={16} />
          </button>
          <div className="diff-search">
            <Lucide.Search size={14} />
            <input
              type="text"
              placeholder="筛选"
              value={diffSearchQuery}
              onChange={(e) => setDiffSearchQuery(e.target.value)}
            />
          </div>
          {fileList.length > 0 ? (
            <button
              type="button"
              className="diff-icon-btn"
              title="清空列表"
              onClick={() => {
                setDiffFiles([]);
                setActiveDiffSource(null);
                setTurnKey('');
                setSourceMode('list');
              }}
            >
              <Lucide.Trash2 size={16} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="diff-body-wrap">
        {fileList.length > 1 ? (
          <div className="diff-file-list">
            {fileList.map((f) => {
              const active = current?.filePath === f.filePath;
              return (
                <button
                  key={f.filePath}
                  type="button"
                  className={`diff-file-item ${active ? 'is-active' : ''}`}
                  onClick={() => setActiveDiffSource(f)}
                  title={f.filePath}
                >
                  <span className="diff-file-name">{basename(f.filePath)}</span>
                  <span className="diff-file-stat">
                    <span className="add">+{f.additions}</span>
                    <span className="del">−{f.deletions}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className={`diff-body ${diffViewMode === 'split' ? 'is-split' : ''}`}>
          {!current ? (
            <div className="diff-empty">
              <Lucide.FileDiff size={28} style={{ opacity: 0.35 }} />
              <div>暂无变更</div>
              <div className="diff-empty-sub">
                助手改文件后会出现在此；也可载入 Git 未提交变更，或从上方下拉查看本会话各回合汇总。
              </div>
              <div className="diff-empty-actions">
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={gitLoading}
                  onClick={() => void loadFromGit()}
                >
                  <Lucide.GitBranch size={15} />
                  Git 变更
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  onClick={loadSessionAll}
                >
                  <Lucide.Layers size={15} />
                  会话汇总
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="diff-current-path" title={current.filePath}>
                {current.filePath}
              </div>
              <pre className="diff-lines">
                {filteredChanges.map((c, i) => (
                  <div
                    key={i}
                    className={`diff-line diff-line--${c.type}`}
                  >
                    <span className="diff-line-mark">
                      {c.type === 'addition' ? '+' : c.type === 'deletion' ? '−' : ' '}
                    </span>
                    <span className="diff-line-text">{c.content}</span>
                  </div>
                ))}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export const DiffCard = React.memo(DiffCardInner);
