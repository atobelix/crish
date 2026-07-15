/**
 * 终端面板：镜像助手命令输出；样式对齐预览/文件栏。
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
  const outputEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onProj = () => setCwdTick((n) => n + 1);
    const onBg = (ev: Event) => {
      const detail = (ev as CustomEvent<{ title?: string; lines?: string[] }>).detail;
      if (!detail?.lines?.length) return;
      const sid = useLayoutStore.getState().activeSessionId || undefined;
      if (detail.title) addTerminalLine(`── ${detail.title} ──`, sid);
      for (const line of detail.lines) addTerminalLine(line, sid);
    };
    window.addEventListener('crish-project-changed', onProj);
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
    return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
  })();

  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
      addTerminalLine(`$ ${input}`, sid);
      if (!demoShell) {
        addTerminalLine('（输出由助手工具写入；此处不直接执行）', sid);
      } else {
        addTerminalLine('(demo) 请使用正式版引擎命令。', sid);
      }
      setTerminalHistory((prev) => [...prev, input]);
      setTermHistIdx(-1);
      setTerminalInput('');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!terminalHistory.length) return;
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
      <div className="files-bar term-bar">
        <Lucide.Terminal size={14} className="files-path-ico" />
        <div className="files-path-form">
          <span className="files-path-crumbs files-path-crumbs--grow" title={getWorkspacePath() || ''}>
            {cwdLabel} · 命令输出
          </span>
        </div>
        <button
          type="button"
          className="files-nav-btn"
          title="清空"
          onClick={() => clearTerminalLines(activeSessionId || undefined)}
        >
          <Lucide.Trash2 size={13} />
        </button>
      </div>
      <div className="term-body">
        {terminalLines.length === 0 ? (
          <div className="term-empty">助手执行命令后的输出会出现在这里</div>
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
          placeholder="备注 / clear 清空"
          spellCheck={false}
        />
      </div>
    </div>
  );
};
