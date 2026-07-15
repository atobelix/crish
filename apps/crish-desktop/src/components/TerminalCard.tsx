import React, { useState, useEffect, useRef } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { isDemoMode } from '../api/appMode';
import { getWorkspacePath } from '../api/projectStore';

export const TerminalCard: React.FC = () => {
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const terminalBySession = useLayoutStore((s) => s.terminalBySession);
  const terminalLinesCompat = useLayoutStore((s) => s.terminalLines);
  const addTerminalLine = useLayoutStore((s) => s.addTerminalLine);
  const clearTerminalLines = useLayoutStore((s) => s.clearTerminalLines);
  const terminalLines =
    (activeSessionId && terminalBySession[activeSessionId]) || terminalLinesCompat || [];
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [termHistIdx, setTermHistIdx] = useState(-1);
  const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });
  const [cwdTick, setCwdTick] = useState(0);
  const demoShell = isDemoMode();

  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onProj = () => setCwdTick((n) => n + 1);
    window.addEventListener('crish-project-changed', onProj);
    return () => window.removeEventListener('crish-project-changed', onProj);
  }, []);

  const cwdLabel = (() => {
    void cwdTick;
    const p = getWorkspacePath();
    if (!p) return '（未选择项目）';
    return p.length > 48 ? `…${p.slice(-46)}` : p;
  })();

  useEffect(() => {
    const el = terminalBodyRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const cols = Math.floor(width / 7.2) || 80;
        const rows = Math.floor(height / 16.5) || 24;
        setTermSize({ cols, rows });
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLines]);

  const handleTerminalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const input = terminalInput.trim();
      if (!input) return;

      const sid = activeSessionId || undefined;
      if (input.toLowerCase() === 'clear') {
        clearTerminalLines(sid);
        setTerminalInput('');
        return;
      }

      // 正式版：只读镜像助手命令输出，不在此直接执行 shell
      if (!demoShell) {
        addTerminalLine(`$ ${input}`, sid);
        addTerminalLine('（此面板显示助手命令输出，不会在本机直接执行输入。）', sid);
        setTerminalHistory((prev) => [...prev, input]);
        setTermHistIdx(-1);
        setTerminalInput('');
        return;
      }

      // 演示模式：本地模拟 shell（演示暂搁，保留兼容）
      addTerminalLine(`$ ${input}`, sid);
      setTerminalHistory((prev) => [...prev, input]);
      setTermHistIdx(-1);
      setTerminalInput('');
      addTerminalLine('(demo) 模拟输出已关闭，请使用正式版引擎命令。', sid);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (terminalHistory.length === 0) return;
      const nextIdx = termHistIdx === -1 ? terminalHistory.length - 1 : Math.max(0, termHistIdx - 1);
      setTermHistIdx(nextIdx);
      setTerminalInput(terminalHistory[nextIdx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (termHistIdx === -1) return;
      const nextIdx = termHistIdx + 1;
      if (nextIdx >= terminalHistory.length) {
        setTermHistIdx(-1);
        setTerminalInput('');
      } else {
        setTermHistIdx(nextIdx);
        setTerminalInput(terminalHistory[nextIdx]);
      }
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1 }}>
      <div className="card-subheader terminal-subheader">
        <div className="subheader-left" style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <Lucide.Terminal size={12} className="term-icon" />
          <span className="term-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            命令输出 · {termSize.cols}×{termSize.rows}
          </span>
        </div>
        <div className="subheader-right" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span
            title={getWorkspacePath() || '未选择项目'}
            style={{
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              maxWidth: 160,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {cwdLabel}
          </span>
          <button
            type="button"
            className="sub-btn"
            title="清空本会话输出"
            onClick={() => clearTerminalLines(activeSessionId || undefined)}
          >
            <Lucide.Trash2 size={13} />
          </button>
        </div>
      </div>
      <div
        ref={terminalBodyRef}
        className="terminal-body"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--terminal-bg)',
          padding: '12px',
          overflow: 'hidden',
        }}
        onClick={() => {
          const inputEl = document.getElementById('term-input-element');
          if (inputEl) inputEl.focus();
        }}
      >
        <div
          className="terminal-output terminal-output-text"
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            color: 'var(--terminal-text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            lineHeight: 1.45,
          }}
        >
          {terminalLines.length === 0 && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.6, padding: '8px 0' }}>
              助手执行命令后，输出会出现在这里。
              <br />
              此处不会直接运行本机 shell，避免误操作。
            </div>
          )}
          {terminalLines.map((line, index) => {
            let className = 'term-log';
            if (line.startsWith('$ ')) className = 'term-command-line';
            else if (line.startsWith('✓') || line.startsWith('[ready]') || line.includes('[自动授权成功]'))
              className = 'term-success-line';
            else if (
              line.startsWith('bash:') ||
              line.startsWith('cat:') ||
              line.startsWith('Error:') ||
              line.startsWith('error:') ||
              /failed|error|denied/i.test(line)
            )
              className = 'term-error-line';

            return (
              <div
                key={index}
                className={className}
                style={{
                  color:
                    className === 'term-success-line'
                      ? '#10b981'
                      : className === 'term-error-line'
                        ? '#f87171'
                        : className === 'term-command-line'
                          ? 'var(--accent-color, #60a5fa)'
                          : 'inherit',
                }}
              >
                {line}
              </div>
            );
          })}

          <div className="terminal-prompt-input-line" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className="term-symbol" style={{ color: 'var(--terminal-symbol)' }}>
              $
            </span>
            <input
              id="term-input-element"
              type="text"
              value={terminalInput}
              onChange={(e) => setTerminalInput(e.target.value)}
              onKeyDown={handleTerminalKeyDown}
              placeholder={demoShell ? '' : '仅记录备注 · 不会执行'}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--terminal-text)',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                caretColor: 'var(--terminal-text)',
              }}
              autoFocus
            />
          </div>
          <div ref={outputEndRef} />
        </div>
      </div>
    </div>
  );
};
