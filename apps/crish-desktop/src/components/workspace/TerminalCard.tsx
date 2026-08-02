/**
 * 终端面板：VS Code 式交互式 PTY + xterm。
 * 纯终端：无顶栏 / 无镜像条 / 无搜索壳；仅 xterm 全屏 + PTY 不可用时的简短提示。
 *
 * sessionId prop 优先（TreeLeafPanel 注入 leaf.sessionId）。
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import styles from './TerminalCard.module.css';
import { useLayoutStore } from '../../api/store-access/componentAccess';
import { getWorkspacePath } from '../../api/projectStore';
import {
  InteractiveXtermTerminal,
  type InteractiveXtermStatus,
} from './TerminalCard.xterm';

export type TerminalCardProps = {
  /** leaf 绑定的 session；多 unit 时必须传入，避免串到 activeSessionId */
  sessionId?: string | null;
};

export const TerminalCard: React.FC<TerminalCardProps> = ({
  sessionId: sessionIdProp,
}) => {
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const boundSessionId =
    (sessionIdProp || '').trim() || (activeSessionId || '').trim() || null;
  const sessionKey = boundSessionId || '_global';

  const [cwdTick, setCwdTick] = useState(0);
  const [ptyStatus, setPtyStatus] = useState<InteractiveXtermStatus>('idle');
  const [ptyError, setPtyError] = useState('');
  // 无顶栏操作，restartToken 仅保留给 xterm 生命周期 prop
  const [restartToken] = useState(0);
  const reactId = useId();
  const titleId = `${reactId}-term-title`;

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

  const ptyMissing = ptyStatus === 'missing';

  return (
    <div
      className={`${styles.panel} term-card`}
      role="region"
      aria-labelledby={titleId}
      aria-label="终端"
      data-session-id={boundSessionId || ''}
      data-session-key={sessionKey}
      data-ux-mode="interactive"
      data-interactive-pty={ptyMissing ? 'false' : 'true'}
      data-pty-status={ptyStatus}
    >
      <span id={titleId} className={styles.srOnly}>
        终端
      </span>

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
        ) : (
          <div className={styles.xtermWrap}>
            <InteractiveXtermTerminal
              sessionKey={sessionKey}
              cwd={fullCwd || undefined}
              restartToken={restartToken}
              onStatusChange={handlePtyStatus}
              onPtyMissing={handlePtyMissing}
            />
          </div>
        )}
      </div>
    </div>
  );
};
