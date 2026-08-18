/**
 * 交互式 xterm + PTY 适配器。
 * stdin 开启：onData → ptyWrite；subscribePtyOutput → term.write；
 * ResizeObserver/fit → ptyResize。
 *
 * PTY 生命周期（策略 A）：
 * - mount：ensure/reuse registry，禁止 ensure 后再裸 create 造孤儿
 * - unmount / 切 sessionKey：**不** kill（折坞再开续同一 ptyId）
 * - kill 仅 closeTab / reset / 用户显式 restart 经 registry.take
 *
 * xterm 初始化 / PTY 桥接 / resize 适配已提取至 useXtermTerminal hook。
 */
import React, {
  forwardRef,
  useImperativeHandle,
} from 'react';
import { ptyWrite } from '../../api/ptySessionApi';
import { useXtermTerminal } from './useXtermTerminal';
import styles from './TerminalCard.module.css';

export type InteractiveXtermStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'missing'
  | 'error'
  | 'exited';

export type InteractiveXtermHandle = {
  focus: () => void;
  /** 发送 Ctrl+L（清屏），本地 buffer 同步 clear */
  clear: () => void;
  getPtyId: () => string | null;
  /** 强制重建当前会话 PTY */
  restart: () => void;
};

export type InteractiveXtermProps = {
  /** 会话隔离键：通常 = activeSessionId；无会话时用 _global */
  sessionKey: string;
  cwd?: string;
  /** 父组件 bump 以强制 kill+recreate */
  restartToken?: number;
  onStatusChange?: (status: InteractiveXtermStatus, detail?: string) => void;
  /** PTY 命令未注册 / 非 Tauri */
  onPtyMissing?: () => void;
  className?: string;
};

export const InteractiveXtermTerminal = forwardRef<
  InteractiveXtermHandle,
  InteractiveXtermProps
>(function InteractiveXtermTerminal(
  {
    sessionKey,
    cwd,
    restartToken = 0,
    onStatusChange,
    onPtyMissing,
    className,
  },
  ref,
) {
  const {
    containerRef,
    termDomId,
    ptyIdRef,
    bumpLocalRestart,
    termRef,
  } = useXtermTerminal({
    sessionKey,
    cwd,
    restartToken,
    onStatusChange,
    onPtyMissing,
  });

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        try {
          termRef.current?.focus();
        } catch {
          /* swallow-ok: 终端实例未就绪时聚焦为空操作 */
        }
      },
      clear: () => {
        const term = termRef.current;
        const ptyId = ptyIdRef.current;
        // 本地清屏 + 向 shell 发送 Ctrl+L（与终端习惯一致）
        try {
          term?.clear();
        } catch {
          /* swallow-ok: 清屏失败不阻断后续 Ctrl+L 下发 */
        }
        if (ptyId) {
          void ptyWrite(ptyId, '\x0c');
        }
      },
      getPtyId: () => ptyIdRef.current,
      restart: () => bumpLocalRestart(),
    }),
    [bumpLocalRestart, ptyIdRef, termRef],
  );

  return (
    <div
      ref={containerRef}
      id={termDomId}
      className={`${styles.xtermHost}${className ? ` ${className}` : ''}`}
      data-session-key={sessionKey}
      data-pty-id={ptyIdRef.current || undefined}
      role="application"
      aria-label="交互式 PowerShell 终端"
      tabIndex={0}
      onClick={() => {
        try {
          termRef.current?.focus();
        } catch {
          /* swallow-ok: 点击聚焦失败时用户可再点终端内部 */
        }
      }}
    />
  );
});
