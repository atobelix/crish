/**
 * 终端面板：VS Code 式交互式 PTY + xterm。
 * 纯终端：无顶栏 / 无镜像条 / 无搜索壳；仅 xterm 全屏 + PTY 不可用时的简短提示。
 *
 * sessionId prop 优先（TreeLeafPanel 注入 leaf.sessionId）。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from './TerminalCard.module.css';
import { useSessionStore } from '../../store/storeAccess';
import { getWorkspacePath } from '../../api/projectStore';
import { openNewTerminalInActiveTab } from '../../store/workspace-shell/openTool';
import {
  InteractiveXtermTerminal,
  type InteractiveXtermHandle,
  type InteractiveXtermStatus,
} from './TerminalCard.xterm';
import { TerminalToolbar, type TerminalSplitMode } from './TerminalToolbar';

export type TerminalCardProps = {
  /** leaf 绑定的 session；多 unit 时必须传入，避免串到 activeSessionId */
  sessionId?: string | null;
  /** 面板 ID（多终端标签支持，如 'terminal', 'terminal:2' 等） */
  panelId?: string | null;
};

export const TerminalCard: React.FC<TerminalCardProps> = ({
  sessionId: sessionIdProp,
  panelId: panelIdProp,
}) => {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const boundSessionId =
    (sessionIdProp || '').trim() || (activeSessionId || '').trim() || null;
  const baseKey = boundSessionId || '_global';
  const sessionKey =
    panelIdProp && panelIdProp !== 'terminal'
      ? `${baseKey}:${panelIdProp}`
      : baseKey;

  const [cwdTick, setCwdTick] = useState(0);
  const [ptyStatus, setPtyStatus] = useState<InteractiveXtermStatus>('idle');
  const [ptyError, setPtyError] = useState('');
  const [restartToken] = useState(0);

  // 标签页内分屏状态
  const [splitMode, setSplitMode] = useState<TerminalSplitMode>('none');
  const [activePaneIndex, setActivePaneIndex] = useState(0);

  const reactId = useId();
  const titleId = `${reactId}-term-title`;
  const termHandleRef1 = useRef<InteractiveXtermHandle | null>(null);
  const termHandleRef2 = useRef<InteractiveXtermHandle | null>(null);

  const fitAll = useCallback(() => {
    requestAnimationFrame(() => {
      termHandleRef1.current?.fit();
      termHandleRef2.current?.fit();
      requestAnimationFrame(() => {
        termHandleRef1.current?.fit();
        termHandleRef2.current?.fit();
      });
    });
  }, []);

  useEffect(() => {
    fitAll();
  }, [fitAll, splitMode]);

  useEffect(() => {
    const onProj = () => setCwdTick((n) => n + 1);
    window.addEventListener('crish-project-changed', onProj);
    return () => window.removeEventListener('crish-project-changed', onProj);
  }, []);

  useEffect(() => {
    setPtyStatus('idle');
    setPtyError('');
  }, [boundSessionId]);

  const fullCwd = (() => {
    void cwdTick;
    return getWorkspacePath() || '';
  })();

  const handlePtyStatus = useCallback(
    (status: InteractiveXtermStatus, detail?: string) => {
      setPtyStatus(status);
      if (status === 'error' && detail) setPtyError(detail);
      else if (status === 'ready') setPtyError('');
    },
    []
  );

  const handlePtyMissing = useCallback(() => {
    setPtyStatus('missing');
  }, []);

  // 工具栏动作
  const handleNewTerminal = useCallback(() => {
    openNewTerminalInActiveTab();
  }, []);

  const handleSplitHorizontal = useCallback(() => {
    setSplitMode((prev) => (prev === 'horizontal' ? 'none' : 'horizontal'));
    setActivePaneIndex(1);
    fitAll();
  }, [fitAll]);

  const handleSplitVertical = useCallback(() => {
    setSplitMode((prev) => (prev === 'vertical' ? 'none' : 'vertical'));
    setActivePaneIndex(1);
    fitAll();
  }, [fitAll]);

  const handleClear = useCallback(() => {
    if (activePaneIndex === 1 && termHandleRef2.current) {
      termHandleRef2.current.clear();
    } else {
      termHandleRef1.current?.clear();
    }
  }, [activePaneIndex]);

  const handleCloseSplit = useCallback(() => {
    setSplitMode('none');
    setActivePaneIndex(0);
    void import('../../api/ptyRegistry').then((m) => {
      void m.killPtyForSession(`${sessionKey}:split-2`);
    });
    fitAll();
  }, [fitAll, sessionKey]);

  const ptyMissing = ptyStatus === 'missing';
  const isSplit = splitMode !== 'none';
  const toolbarTitle =
    panelIdProp && panelIdProp !== 'terminal'
      ? `pwsh ${panelIdProp.replace('terminal:', '')}`
      : 'pwsh';

  return (
    <div
      className={`${styles.panel} chat-side-panel side-panel-body term-card`}
      role="region"
      aria-labelledby={titleId}
      aria-label="终端"
      data-session-id={boundSessionId || ''}
      data-session-key={sessionKey}
      data-ux-mode="interactive"
      data-interactive-pty={ptyMissing ? 'false' : 'true'}
      data-pty-status={ptyStatus}
      data-split-mode={splitMode}
    >
      <span id={titleId} className={styles.srOnly}>
        终端
      </span>

      {/* 终端顶部操作工具栏（对齐截图要求） */}
      <TerminalToolbar
        splitMode={splitMode}
        activePaneIndex={activePaneIndex}
        onSelectPane={setActivePaneIndex}
        onNewTerminal={handleNewTerminal}
        onSplitHorizontal={handleSplitHorizontal}
        onSplitVertical={handleSplitVertical}
        onClear={handleClear}
        onCloseSplit={handleCloseSplit}
        title={toolbarTitle}
      />

      <div
        className={styles.interactiveHost}
        data-pty-host="true"
        data-pty-active={ptyMissing ? 'false' : 'true'}
        aria-label="终端区域"
      >
        {ptyMissing ? (
          <div className={styles.fallbackBanner} role="status">
            <span>
              当前环境无交互式终端（需桌面应用 PTY）。请使用正式版桌面壳。
            </span>
            {ptyError ? <span> {ptyError}</span> : null}
          </div>
        ) : !isSplit ? (
          <div className={styles.xtermWrap}>
            <InteractiveXtermTerminal
              ref={termHandleRef1}
              sessionKey={sessionKey}
              cwd={fullCwd || undefined}
              restartToken={restartToken}
              onStatusChange={handlePtyStatus}
              onPtyMissing={handlePtyMissing}
            />
          </div>
        ) : (
          <div className={styles.splitContainer} data-direction={splitMode}>
            <div
              className={`${styles.splitPane} ${
                activePaneIndex === 0 ? styles.activeSplitPane : ''
              }`}
              onClick={() => setActivePaneIndex(0)}
            >
              <InteractiveXtermTerminal
                ref={termHandleRef1}
                sessionKey={sessionKey}
                cwd={fullCwd || undefined}
                restartToken={restartToken}
                onStatusChange={handlePtyStatus}
                onPtyMissing={handlePtyMissing}
              />
            </div>
            <div className={styles.splitDivider} />
            <div
              className={`${styles.splitPane} ${
                activePaneIndex === 1 ? styles.activeSplitPane : ''
              }`}
              onClick={() => setActivePaneIndex(1)}
            >
              <InteractiveXtermTerminal
                ref={termHandleRef2}
                sessionKey={`${sessionKey}:split-2`}
                cwd={fullCwd || undefined}
                restartToken={restartToken}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
