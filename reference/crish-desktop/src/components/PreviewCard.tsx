import React, { useState } from 'react';
import * as Lucide from 'lucide-react';

interface PreviewCardProps {
  wsId: string;
  onShowToast: (message: string) => void;
}

export const PreviewCard: React.FC<PreviewCardProps> = ({
  wsId: _wsId,
  onShowToast,
}) => {
  const [browserUrl, setBrowserUrl] = useState('http://localhost:5174/');
  const [browserHistory, setBrowserHistory] = useState<string[]>(['http://localhost:5174/']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [isSWActive, setIsSWActive] = useState(true);
  const [isScriptInjected, setIsScriptInjected] = useState(true);
  const [mockPage, setMockPage] = useState<'app' | 'google' | 'github'>('app');

  const updatePageFromUrl = (url: string) => {
    const lower = url.toLowerCase();
    if (lower.includes('github')) setMockPage('github');
    else if (lower.includes('google') || lower.includes('baidu')) setMockPage('google');
    else setMockPage('app');
  };

  const navigateTo = (url: string) => {
    let next = url.trim();
    if (!next.startsWith('http://') && !next.startsWith('https://')) {
      next = 'http://' + next;
    }
    const newHist = browserHistory.slice(0, historyIndex + 1);
    newHist.push(next);
    setBrowserHistory(newHist);
    setHistoryIndex(newHist.length - 1);
    setBrowserUrl(next);
    updatePageFromUrl(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, background: '#fff' }}>
      <div
        className="card-subheader preview-subheader"
        style={{
          padding: '6px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          borderBottom: '1px solid var(--border-subtle)',
          background: '#fff',
        }}
      >
        <div style={{ display: 'flex', gap: 2 }}>
          <button
            type="button"
            className="sub-btn"
            title="后退"
            disabled={historyIndex === 0}
            onClick={() => {
              if (historyIndex > 0) {
                const prevIdx = historyIndex - 1;
                setHistoryIndex(prevIdx);
                const url = browserHistory[prevIdx];
                setBrowserUrl(url);
                updatePageFromUrl(url);
              }
            }}
          >
            <Lucide.ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className="sub-btn"
            title="前进"
            disabled={historyIndex === browserHistory.length - 1}
            onClick={() => {
              if (historyIndex < browserHistory.length - 1) {
                const nextIdx = historyIndex + 1;
                setHistoryIndex(nextIdx);
                const url = browserHistory[nextIdx];
                setBrowserUrl(url);
                updatePageFromUrl(url);
              }
            }}
          >
            <Lucide.ChevronRight size={14} />
          </button>
          <button
            type="button"
            className="sub-btn"
            title="刷新"
            onClick={() => onShowToast('已刷新预览')}
          >
            <Lucide.RotateCw size={13} />
          </button>
        </div>

        <div
          className="url-bar"
          style={{
            flex: 1,
            maxWidth: 'none',
            margin: 0,
            height: 28,
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-secondary)',
            padding: '0 10px',
          }}
        >
          <Lucide.Lock size={11} style={{ color: 'var(--text-tertiary)' }} />
          <input
            type="text"
            value={browserUrl}
            onChange={(e) => setBrowserUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigateTo(browserUrl);
            }}
            style={{ fontSize: 12, color: 'var(--text-primary)' }}
          />
        </div>

        <button
          type="button"
          className="sub-btn"
          title="在浏览器打开"
          onClick={() => onShowToast(`已请求打开 ${browserUrl}`)}
        >
          <Lucide.ExternalLink size={13} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', background: '#fff', padding: 16 }}>
        {mockPage === 'app' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: isSWActive ? 'var(--accent-green)' : 'var(--text-tertiary)',
                }}
              />
              <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                本地应用预览
              </h3>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 0,
                marginBottom: 20,
                borderTop: '1px solid var(--border-subtle)',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              {[
                { label: '状态', value: isSWActive ? '运行中' : '已停止' },
                { label: '脚本', value: isScriptInjected ? '已注入' : '未注入' },
                { label: '连接', value: '1' },
              ].map((s, i) => (
                <div
                  key={s.label}
                  style={{
                    padding: '12px 8px',
                    textAlign: 'center',
                    borderRight: i < 2 ? '1px solid var(--border-subtle)' : 'none',
                  }}
                >
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4, color: 'var(--text-primary)' }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
                控制
              </div>
              {[
                {
                  label: '启用后台服务',
                  checked: isSWActive,
                  onChange: () => setIsSWActive((v) => !v),
                },
                {
                  label: '注入内容脚本',
                  checked: isScriptInjected,
                  onChange: () => setIsScriptInjected((v) => !v),
                },
              ].map((row) => (
                <label
                  key={row.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 0',
                    borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                  }}
                >
                  {row.label}
                  <input type="checkbox" checked={row.checked} onChange={row.onChange} />
                </label>
              ))}
            </div>

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                日志
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  color: 'var(--text-secondary)',
                  whiteSpace: 'pre-wrap',
                  background: 'transparent',
                  border: 'none',
                }}
              >
                {[
                  '[11:04:12] 服务已注册',
                  '[11:04:13] 内容脚本已加载',
                  '[11:05:01] 会话已同步',
                ].join('\n')}
              </pre>
            </div>
          </div>
        )}

        {mockPage === 'google' && (
          <div style={{ textAlign: 'center', paddingTop: 48, color: 'var(--text-secondary)' }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
              搜索
            </div>
            <div
              style={{
                maxWidth: 360,
                margin: '0 auto',
                border: '1px solid var(--border-color)',
                borderRadius: 20,
                padding: '10px 16px',
                textAlign: 'left',
                color: 'var(--text-tertiary)',
                fontSize: 13,
              }}
            >
              模拟搜索页 · {browserUrl}
            </div>
          </div>
        )}

        {mockPage === 'github' && (
          <div style={{ paddingTop: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              GitHub 预览
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{browserUrl}</div>
          </div>
        )}
      </div>
    </div>
  );
};
