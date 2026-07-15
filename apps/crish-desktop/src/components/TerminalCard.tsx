/**
 * 终端面板：镜像助手命令输出；后台常驻任务详情也可写入此处查看。
 */
import React, { useEffect, useRef, useState } from 'react';
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
  const [cwdTick, setCwdTick] = useState(0);
  const demoShell = isDemoMode();

  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onProj = () => setCwdTick((n) => n + 1);
    window.addEventListener('crish-project-changed', onProj);
    // 后台任务详情注入
    const onBg = (ev: Event) => {
      const detail = (ev as CustomEvent<{ title?: string; lines?: string[] }>).detail;
      if (!detail?.lines?.length) return;
      const sid = useLayoutStore.getState().activeSessionId || undefined;
      if (detail.title) addTerminalLine(`── ${detail.title} ──`, sid);
      for (const line of detail.lines) addTerminalLine(line, sid);
    };
    window.addEventListener('crish-terminal-append', onBg);
    return () => {
      window.removeEventListener('crish-project-changed', onProj);
      window.removeEventListener('crish-terminal-append', onBg);
    };
  }, [addTerminalLine]);

  const cwdLabel = (() => {
    void cwdTick;
    const p = getWorkspacePath();
    if (!p) return '未选择项目';
    const base = p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
    return base;
  })();

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
      if (!demoShell) {
        addTerminalLine(`$ ${input}`, sid);
        addTerminalLine('（命令输出由助手工具写入；此处不直接执行 shell）', sid);
        setTerminalHistory((prev) => [...prev, input]);
        setTermHistIdx(-1);
        setTerminalInput('');
        return;
      }
      addTerminalLine(`$ ${input}`, sid);
      setTerminalHistory((prev) => [...prev, input]);
      setTermHistIdx(-1);
      setTerminalInput('');
      addTerminalLine('(demo) 请使用正式版引擎命令。', sid);
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
    <div className="term-panel">
      <div className="term-toolbar">
        <Lucide.Terminal size={12} style={{ color: 'var(--terminal-muted)', flexShrink: 0 }} />
        <span className="term-toolbar-label" title={getWorkspacePath() || ''}>
          {cwdLabel} · 命令输出
        </span>
        <button
          type="button"
          className="files-icon-btn"
          title="清空"
          onClick={() => clearTerminalLines(activeSessionId || undefined)}
        >
          <Lucide.Trash2 size={12} />
        </button>
      </div>
      <div ref={terminalBodyRef} className="term-body">
        {terminalLines.length === 0 ? (
          <div style={{ color: 'var(--terminal-muted)', fontSize: 12 }}>
            助手执行命令后的输出会出现在这里。后台常驻任务可从「运行状态」点开查看详情。
          </div>
        ) : (
          terminalLines.map((line, i) => (
            <div key={i} className={`term-line ${line.startsWith('$') ? 'is-cmd' : ''}`}>
              {line}
            </div>
          ))
        )}
        <div ref={outputEndRef} />
      </div>
      <div className="term-input-row">
        <span className="term-prompt">›</span>
        <input
          className="term-input"
          value={terminalInput}
          onChange={(e) => setTerminalInput(e.target.value)}
          onKeyDown={handleTerminalKeyDown}
          placeholder="过滤备注 / clear 清空…"
          spellCheck={false}
        />
      </div>
    </div>
  );
};
