import React, { useState, useMemo } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import * as Lucide from 'lucide-react';

interface DiffCardProps {
  onShowToast: (message: string) => void;
}

export const DiffCard: React.FC<DiffCardProps> = ({ onShowToast }) => {
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const setActiveDiffSource = useLayoutStore((s) => s.setActiveDiffSource);
  const setDiffFiles = useLayoutStore((s) => s.setDiffFiles);
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified');
  const [diffSearchQuery, setDiffSearchQuery] = useState('');

  const fileList = useMemo(() => {
    if (diffFiles.length > 0) return diffFiles;
    return activeDiffSource ? [activeDiffSource] : [];
  }, [diffFiles, activeDiffSource]);

  const current = activeDiffSource || fileList[0] || null;

  const filteredChanges = useMemo(() => {
    if (!current) return [];
    const q = diffSearchQuery.trim().toLowerCase();
    if (!q) return current.changes;
    return current.changes.filter((c) => c.content.toLowerCase().includes(q));
  }, [current, diffSearchQuery]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, background: 'var(--bg-primary)' }}>
      <div
        className="card-subheader diff-subheader"
        style={{
          padding: '8px 12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Lucide.FileDiff size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
            代码变更
          </span>
          {fileList.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{fileList.length} 个文件</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'var(--bg-secondary)',
              borderRadius: 6,
              padding: '3px 8px',
            }}
          >
            <Lucide.Search size={12} style={{ color: 'var(--text-tertiary)', marginRight: 4 }} />
            <input
              type="text"
              placeholder="筛选…"
              value={diffSearchQuery}
              onChange={(e) => setDiffSearchQuery((e.target as HTMLInputElement).value)}
              style={{
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 12,
                width: 90,
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-sans)',
              }}
            />
          </div>
          <div className="ui-segment" style={{ padding: 2 }}>
            <button
              type="button"
              className={`ui-segment-item ${diffViewMode === 'unified' ? 'active' : ''}`}
              style={{ minHeight: 22, fontSize: 11, padding: '2px 8px' }}
              onClick={() => setDiffViewMode('unified')}
            >
              合并
            </button>
            <button
              type="button"
              className={`ui-segment-item ${diffViewMode === 'split' ? 'active' : ''}`}
              style={{ minHeight: 22, fontSize: 11, padding: '2px 8px' }}
              onClick={() => setDiffViewMode('split')}
            >
              分栏
            </button>
          </div>
          {fileList.length > 0 && (
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              title="清空列表"
              onClick={() => {
                setDiffFiles([]);
                setActiveDiffSource(null);
              }}
            >
              <Lucide.Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 多文件列表 */}
        {fileList.length > 1 && (
          <div
            style={{
              width: 160,
              borderRight: '1px solid var(--border-subtle)',
              overflowY: 'auto',
              flexShrink: 0,
              background: 'var(--bg-secondary)',
            }}
          >
            {fileList.map((f) => {
              const active = current?.filePath === f.filePath;
              const base = f.filePath.replace(/\\/g, '/').split('/').pop() || f.filePath;
              return (
                <button
                  key={f.filePath}
                  type="button"
                  onClick={() => setActiveDiffSource(f)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    borderBottom: '1px solid var(--border-subtle)',
                    background: active ? 'var(--bg-active)' : 'transparent',
                    padding: '8px 10px',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: active ? 600 : 400,
                  }}
                  title={f.filePath}
                >
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {base}
                  </div>
                  <div style={{ fontSize: 10, marginTop: 2 }}>
                    <span style={{ color: 'var(--accent-green)' }}>+{f.additions}</span>{' '}
                    <span style={{ color: 'var(--accent-red)' }}>-{f.deletions}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="diff-body" style={{ overflowY: 'auto', flex: 1, background: 'var(--bg-primary)' }}>
          {!current ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                padding: 24,
                color: 'var(--text-tertiary)',
                fontSize: 13,
                textAlign: 'center',
                gap: 8,
              }}
            >
              <Lucide.FileDiff size={28} style={{ opacity: 0.35 }} />
              <div>暂无变更可查看</div>
              <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 280 }}>
                助手修改文件或产生 diff 后，会在此列出文件；可切换多文件对比。
              </div>
            </div>
          ) : (
            <>
              <div
                style={{
                  padding: '10px 14px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  borderBottom: '1px solid var(--border-subtle)',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={current.filePath}
                  >
                    {current.filePath}
                  </span>
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                    <span style={{ color: 'var(--accent-green)' }}>+{current.additions}</span>{' '}
                    <span style={{ color: 'var(--accent-red)' }}>-{current.deletions}</span>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    title="复制路径"
                    onClick={() => {
                      void navigator.clipboard.writeText(current.filePath);
                      onShowToast('已复制路径');
                    }}
                  >
                    <Lucide.Link size={13} />
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    title="复制差异"
                    onClick={() => {
                      const diffText = current.changes
                        .map(
                          (c) =>
                            `${c.type === 'addition' ? '+' : c.type === 'deletion' ? '-' : ' '}${c.content}`,
                        )
                        .join('\n');
                      void navigator.clipboard.writeText(diffText);
                      onShowToast('已复制差异');
                    }}
                  >
                    <Lucide.Copy size={13} />
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    title="关闭"
                    onClick={() => {
                      setActiveDiffSource(null);
                    }}
                  >
                    <Lucide.X size={13} />
                  </button>
                </div>
              </div>

              {diffViewMode === 'split' ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    borderTop: 'none',
                  }}
                >
                  <div style={{ borderRight: '1px solid var(--border-subtle)' }}>
                    <div
                      style={{
                        padding: '6px 12px',
                        fontSize: 11,
                        color: 'var(--text-tertiary)',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      删除
                    </div>
                    {filteredChanges
                      .filter((c) => c.type !== 'addition')
                      .map((change, i) => (
                        <div
                          key={i}
                          className={`git-diff-line-row ${change.type === 'deletion' ? 'deletion' : ''}`}
                        >
                          <div className="line-num-col">{change.type === 'deletion' ? '-' : ' '}</div>
                          <pre className="line-content">{change.content}</pre>
                        </div>
                      ))}
                  </div>
                  <div>
                    <div
                      style={{
                        padding: '6px 12px',
                        fontSize: 11,
                        color: 'var(--text-tertiary)',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      新增
                    </div>
                    {filteredChanges
                      .filter((c) => c.type !== 'deletion')
                      .map((change, i) => (
                        <div
                          key={i}
                          className={`git-diff-line-row ${change.type === 'addition' ? 'addition' : ''}`}
                        >
                          <div className="line-num-col">{change.type === 'addition' ? '+' : ' '}</div>
                          <pre className="line-content">{change.content}</pre>
                        </div>
                      ))}
                  </div>
                </div>
              ) : (
                <div className="git-diff-lines-container">
                  {filteredChanges.map((change, i) => (
                    <div key={i} className={`git-diff-line-row ${change.type}`}>
                      <div className="line-num-col">
                        {change.type === 'addition' ? '+' : change.type === 'deletion' ? '-' : ' '}
                      </div>
                      <pre className="line-content">{change.content}</pre>
                    </div>
                  ))}
                  {filteredChanges.length === 0 && (
                    <div
                      style={{
                        padding: 16,
                        fontSize: 12,
                        color: 'var(--text-tertiary)',
                        textAlign: 'center',
                      }}
                    >
                      没有匹配的行
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
