import React, { useState, useMemo } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import * as Lucide from 'lucide-react';

interface DiffCardProps {
  onShowToast: (message: string) => void;
}

export const DiffCard: React.FC<DiffCardProps> = ({ onShowToast }) => {
  const { activeDiffSource, setActiveDiffSource } = useLayoutStore();
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified');
  const [diffSearchQuery, setDiffSearchQuery] = useState('');

  const filteredChanges = useMemo(() => {
    if (!activeDiffSource) return [];
    const q = diffSearchQuery.trim().toLowerCase();
    if (!q) return activeDiffSource.changes;
    return activeDiffSource.changes.filter((c) => c.content.toLowerCase().includes(q));
  }, [activeDiffSource, diffSearchQuery]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, background: '#fff' }}>
      <div
        className="card-subheader diff-subheader"
        style={{
          padding: '8px 12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--border-subtle)',
          background: '#fff',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Lucide.FileDiff size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
            代码变更
          </span>
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
        </div>
      </div>

      <div className="diff-body" style={{ overflowY: 'auto', flex: 1, background: '#fff' }}>
        {!activeDiffSource ? (
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
            <div style={{ fontSize: 12 }}>在对话中点击文件改动，即可在此阅读完整 diff</div>
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
                >
                  {activeDiffSource.filePath}
                </span>
                <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                  <span style={{ color: 'var(--accent-green)' }}>+{activeDiffSource.additions}</span>
                  {' '}
                  <span style={{ color: 'var(--accent-red)' }}>-{activeDiffSource.deletions}</span>
                </span>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title="复制"
                  onClick={() => {
                    const diffText = activeDiffSource.changes
                      .map(
                        (c) =>
                          `${c.type === 'addition' ? '+' : c.type === 'deletion' ? '-' : ' '}${c.content}`,
                      )
                      .join('\n');
                    navigator.clipboard.writeText(diffText);
                    onShowToast('已复制差异');
                  }}
                >
                  <Lucide.Copy size={13} />
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => {
                    onShowToast(`已应用：${activeDiffSource.filePath}`);
                  }}
                >
                  应用
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  onClick={() => {
                    setActiveDiffSource(null);
                    onShowToast('已关闭此差异');
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
                      <div key={i} className={`git-diff-line-row ${change.type === 'deletion' ? 'deletion' : ''}`}>
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
                      <div key={i} className={`git-diff-line-row ${change.type === 'addition' ? 'addition' : ''}`}>
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
                  <div style={{ padding: 16, fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
                    没有匹配的行
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
