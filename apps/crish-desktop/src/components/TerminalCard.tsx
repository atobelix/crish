/**
 * 终端面板：镜像助手命令输出；样式对齐预览/文件栏。
 * 单滚动面在 .term-body；成功路径无 toast。
 * 按会话隔离缓冲；空会话有独立空态，不混用其它会话行。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from './TerminalCard.module.css';
import { Tooltip } from './settings/SettingsUI';
import { useLayoutStore } from '../store/layoutStore';
import { getSessionStoreState } from '../store/sessionStore';
import * as Lucide from 'lucide-react';
import { isDemoMode } from '../api/appMode';
import { getWorkspacePath } from '../api/projectStore';
import {
  runTerminalShell,
  shellResultToLines,
  shouldExecuteTerminalInput,
} from '../api/terminalShellApi';

/** 空态种类：无活动会话 / 本会话尚无输出 */
type TermEmptyKind = 'no-session' | 'session-empty';

/** 行样式类型检测 */
function getLineType(line: string): 'cmd' | 'sep' | 'err' | 'normal' {
  if (line.startsWith('PS>') || line.startsWith('$')) return 'cmd';
  if (/^──\s/.test(line) || /^──/.test(line)) return 'sep';
  if (
    /失败|错误|error|Error|ERR!|FATAL|denied|拒绝|读取失败|异常|超时|\(exit\s/i.test(
      line,
    ) ||
    line.startsWith('✗') ||
    line.startsWith('[error]')
  ) {
    return 'err';
  }
  return 'normal';
}

/** 顶栏行数：紧凑中文，0 行不展示 */
function formatLineCountLabel(n: number): string {
  if (n <= 0) return '';
  return `${n} 行`;
}

/** 空态文案：区分未选会话与本会话空缓冲 */
function resolveTermEmptyCopy(kind: TermEmptyKind): {
  title: string;
  desc: string;
  hint: string;
} {
  if (kind === 'no-session') {
    return {
      title: '未选择会话',
      desc: '选中或新建会话后，可在此用系统 PowerShell 执行命令；助手工具输出也会镜像到此',
      hint: '输入 clear 可清空本缓冲',
    };
  }
  return {
    title: '本会话暂无命令输出',
    desc: '直接输入命令将调用系统 PowerShell；助手 Shell 结果也会同步到此',
    hint: '输入 clear 清空 · ↑↓ 历史',
  };
}

export const TerminalCard: React.FC = () => {
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const terminalBySession = useLayoutStore((s) => s.terminalBySession);
  const terminalLinesCompat = useLayoutStore((s) => s.terminalLines);
  const addTerminalLine = useLayoutStore((s) => s.addTerminalLine);
  const clearTerminalLines = useLayoutStore((s) => s.clearTerminalLines);

  /**
   * 会话隔离：有活动会话时只读该 sid 缓冲（缺 key → []），
   * 禁止 `[] || compat` 式回落，避免空会话误显其它会话行。
   */
  const terminalLines: string[] = activeSessionId
    ? terminalBySession[activeSessionId] ?? []
    : terminalLinesCompat?.length
      ? terminalLinesCompat
      : terminalBySession['_global'] ?? [];

  const [terminalInput, setTerminalInput] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [termHistIdx, setTermHistIdx] = useState(-1);
  const [cwdTick, setCwdTick] = useState(0);
  const [running, setRunning] = useState(false);
  const demoShell = isDemoMode();
  const bodyRef = useRef<HTMLDivElement>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 防止连按 Enter 叠多路 shell */
  const runningRef = useRef(false);
  /** 仅当用户贴近底部时跟滚，避免回看历史时被拽回 */
  const stickToBottomRef = useRef(true);
  /** 会话切换后首帧用 auto 滚动，避免 smooth 拖沓 */
  const scrollInstantRef = useRef(false);
  const reactId = useId();
  const titleId = `${reactId}-term-title`;
  const inputHintId = `${reactId}-term-hint`;
  const countId = `${reactId}-term-count`;

  useEffect(() => {
    const onProj = () => setCwdTick((n) => n + 1);
    const onBg = (ev: Event) => {
      const detail = (ev as CustomEvent<{ title?: string; lines?: string[] }>).detail;
      if (!detail?.lines?.length) return;
      const sid = getSessionStoreState().activeSessionId || undefined;
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

  /** 切换会话：清草稿与历史游标，贴底并瞬时滚到末尾（空会话干净起步） */
  useEffect(() => {
    setTerminalInput('');
    setTermHistIdx(-1);
    stickToBottomRef.current = true;
    scrollInstantRef.current = true;
  }, [activeSessionId]);

  const cwdLabel = (() => {
    void cwdTick;
    const p = getWorkspacePath();
    if (!p) return '未选择项目';
    return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
  })();

  const fullCwd = (() => {
    void cwdTick;
    return getWorkspacePath() || '';
  })();

  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = gap < 48;
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const behavior: ScrollBehavior = scrollInstantRef.current ? 'auto' : 'smooth';
    scrollInstantRef.current = false;
    outputEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, [terminalLines, activeSessionId]);

  const clearOutput = useCallback(() => {
    clearTerminalLines(activeSessionId || undefined);
    stickToBottomRef.current = true;
    scrollInstantRef.current = true;
  }, [activeSessionId, clearTerminalLines]);

  const runUserCommand = useCallback(
    async (input: string) => {
      const sid = activeSessionId || undefined;
      if (runningRef.current) {
        addTerminalLine('（上一命令仍在执行）', sid);
        return;
      }
      stickToBottomRef.current = true;
      addTerminalLine(`PS> ${input}`, sid);

      if (demoShell) {
        addTerminalLine('（演示）请使用正式版桌面壳执行系统 PowerShell。', sid);
        return;
      }

      const cwd = getWorkspacePath() || undefined;
      runningRef.current = true;
      setRunning(true);
      try {
        const res = await runTerminalShell({ command: input, cwd });
        if (res.status === 'missing') {
          addTerminalLine(
            '（当前环境无法调用系统 PowerShell：请使用桌面应用）',
            sid,
          );
          return;
        }
        if (res.status === 'error') {
          addTerminalLine(`✗ ${res.message}`, sid);
          return;
        }
        for (const line of shellResultToLines(res.data)) {
          addTerminalLine(line, sid);
        }
      } catch (err) {
        addTerminalLine(
          `✗ ${err instanceof Error ? err.message : String(err)}`,
          sid,
        );
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [activeSessionId, addTerminalLine, demoShell],
  );

  const handleTerminalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ctrl/Cmd+L：清空输出（终端习惯）；不拦浏览器其它快捷键
    if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      clearOutput();
      setTerminalInput('');
      setTermHistIdx(-1);
      return;
    }
    if (e.key === 'Escape') {
      if (terminalInput) {
        e.preventDefault();
        setTerminalInput('');
        setTermHistIdx(-1);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const input = terminalInput.trim();
      if (!input) return;
      if (runningRef.current) return;
      if (!shouldExecuteTerminalInput(input)) {
        // clear（及未来内建）本地处理，不走系统 PowerShell
        if (input.toLowerCase() === 'clear') {
          clearOutput();
          setTerminalInput('');
          setTermHistIdx(-1);
        }
        return;
      }
      setTerminalHistory((prev) => [...prev, input].slice(-80));
      setTermHistIdx(-1);
      setTerminalInput('');
      void runUserCommand(input);
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

  const lineCount = terminalLines.length;
  const lineCountLabel = formatLineCountLabel(lineCount);
  const emptyKind: TermEmptyKind | null =
    lineCount === 0 ? (activeSessionId ? 'session-empty' : 'no-session') : null;
  const emptyCopy = emptyKind ? resolveTermEmptyCopy(emptyKind) : null;

  const barTitle = fullCwd
    ? `${fullCwd} · 命令输出${lineCountLabel ? ` · ${lineCountLabel}` : ''}`
    : `命令输出${lineCountLabel ? ` · ${lineCountLabel}` : ''}`;

  const clearTitle =
    lineCount === 0 ? '暂无输出可清空' : `清空本会话输出（${lineCountLabel}）`;

  return (
    <div
      className={styles.panel}
      role="region"
      aria-labelledby={titleId}
      aria-label="终端 · 命令输出"
      data-session-id={activeSessionId || ''}
      data-empty-kind={emptyKind || undefined}
      data-line-count={lineCount}
    >
      <div className={styles.bar} role="toolbar" aria-label="终端工具栏">
        <Lucide.Terminal size={15} className={styles.barIco} strokeWidth={1.75} aria-hidden />
        <Tooltip content={barTitle}>
          <div id={titleId} className={styles.barMeta}>
            <span className={styles.barCwd}>{cwdLabel}</span>
            <span className={styles.barSep} aria-hidden>
              ·
            </span>
            <span className={styles.barShell}>PowerShell</span>
            {running ? (
              <>
                <span className={styles.barSep} aria-hidden>
                  ·
                </span>
                <span role="status" aria-live="polite">
                  执行中
                </span>
              </>
            ) : null}
            {lineCountLabel ? (
              <>
                <span className={styles.barSep} aria-hidden>
                  ·
                </span>
                <span id={countId} role="status" aria-live="polite" aria-atomic="true">
                  {lineCountLabel}
                </span>
              </>
            ) : null}
          </div>
        </Tooltip>
        <Tooltip content={clearTitle}>
          <button
            type="button"
            className={`files-nav-btn ${styles.barBtn}`}
            aria-label={clearTitle}
            aria-disabled={lineCount === 0}
            disabled={lineCount === 0}
            onClick={() => {
              clearOutput();
              inputRef.current?.focus();
            }}
          >
            <Lucide.Trash2 size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
      </div>
      {/* 单滚动面：overflow 在 term-body；长行 overflow-wrap，不撑破侧栏 */}
      <div
        ref={bodyRef}
        className={styles.body}
        role="log"
        aria-label={
          activeSessionId ? '本会话终端输出' : '终端输出（未选择会话）'
        }
        aria-live="polite"
        aria-relevant="additions"
        tabIndex={0}
        onScroll={onBodyScroll}
      >
        {emptyKind && emptyCopy ? (
          <div
            className={styles.empty}
            role="status"
            aria-live="polite"
            data-empty-kind={emptyKind}
          >
            <div className={styles.emptyTitle}>{emptyCopy.title}</div>
            <div className={styles.emptyDesc}>{emptyCopy.desc}</div>
            <div className={styles.emptyHint} id={inputHintId}>
              {emptyKind === 'session-empty' ? (
                <>
                  输入 <kbd>clear</kbd> 清空 · <kbd>Ctrl</kbd>+<kbd>L</kbd> 同上
                </>
              ) : (
                emptyCopy.hint
              )}
            </div>
          </div>
        ) : (
          terminalLines.map((line, i) => {
            const lineType = getLineType(line);
            return (
              <div
                key={`${activeSessionId || '_g'}:${i}:${line.length}`}
                className={`${styles.line} ${
                  lineType === 'cmd' ? styles.isCmd :
                  lineType === 'sep' ? styles.isSep :
                  lineType === 'err' ? styles.isErr : ''
                }`}
                data-line-index={i}
              >
                {line}
              </div>
            );
          })
        )}
        <div ref={outputEndRef} aria-hidden />
      </div>
      <div className={styles.inputRow}>
        <span className={styles.prompt} aria-hidden>
          PS&gt;
        </span>
        <input
          ref={inputRef}
          className={styles.input}
          value={terminalInput}
          onChange={(e) => setTerminalInput(e.target.value)}
          onKeyDown={handleTerminalKeyDown}
          placeholder={running ? '执行中…' : '系统 PowerShell 命令 · clear 清空'}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          enterKeyHint="send"
          disabled={running}
          aria-label="PowerShell 命令输入"
          aria-busy={running || undefined}
          aria-describedby={emptyKind ? inputHintId : undefined}
          aria-keyshortcuts="Control+l Meta+l Escape"
        />
      </div>
    </div>
  );
};
