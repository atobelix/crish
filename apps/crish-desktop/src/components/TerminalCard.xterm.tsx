/**
 * 交互式 xterm + PTY 适配器。
 * stdin 开启：onData → ptyWrite；subscribePtyOutput → term.write；
 * ResizeObserver/fit → ptyResize。
 *
 * PTY 生命周期（策略 A）：
 * - mount：ensure/reuse registry，禁止 ensure 后再裸 create 造孤儿
 * - unmount / 切 sessionKey：**不** kill（折坞再开续同一 ptyId）
 * - kill 仅 closeTab / reset / 用户显式 restart 经 registry.take
 */
import React, {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {
  ptyCreate,
  ptyResize,
  ptyWrite,
  subscribePtyExit,
  subscribePtyOutput,
} from '../api/ptySessionApi';
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

function readCssVar(name: string, fallback: string): string {
  try {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const sessionKeyRef = useRef(sessionKey);
  const cwdRef = useRef(cwd);
  const onStatusRef = useRef(onStatusChange);
  const onMissingRef = useRef(onPtyMissing);
  /** 父级 restartToken 之外的本地强制重建计数 */
  const [localRestart, setLocalRestart] = React.useState(0);
  /** 用于区分「折坞复用」vs「用户 restart 强制重建」 */
  const prevLifecycleRef = useRef({
    sessionKey,
    restartToken,
    localRestart,
  });
  const reactId = useId();
  const termDomId = `${reactId}-xterm-pty`;

  sessionKeyRef.current = sessionKey;
  cwdRef.current = cwd;
  onStatusRef.current = onStatusChange;
  onMissingRef.current = onPtyMissing;

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        try {
          termRef.current?.focus();
        } catch {
          /* ignore */
        }
      },
      clear: () => {
        const term = termRef.current;
        const ptyId = ptyIdRef.current;
        // 本地清屏 + 向 shell 发送 Ctrl+L（与终端习惯一致）
        try {
          term?.clear();
        } catch {
          /* ignore */
        }
        if (ptyId) {
          void ptyWrite(ptyId, '\x0c');
        }
      },
      getPtyId: () => ptyIdRef.current,
      restart: () => setLocalRestart((n) => n + 1),
    }),
    [],
  );

  // ── 创建 xterm 实例（仅挂载一次）────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const bg = readCssVar('--terminal-bg', '#0d0d0d');
    const fg = readCssVar('--terminal-fg', '#d4d4d4');
    const cursor = readCssVar('--terminal-cmd', '#e5e5e5');
    const selection = 'rgba(255, 255, 255, 0.18)';

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: false,
      fontSize: 13,
      // canvas 不解析 CSS 变量；用实际字体名，与 --font-mono 默认栈一致
      fontFamily:
        "'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Consolas', 'Segoe UI Mono', monospace",
      lineHeight: 1.35,
      theme: {
        background: bg,
        foreground: fg,
        cursor,
        cursorAccent: bg,
        selectionBackground: selection,
        selectionForeground: fg,
        black: '#1e1e1e',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e5e5e5',
        brightBlack: '#6b7280',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f9fafb',
      },
      allowTransparency: false,
      convertEol: true,
      scrollback: 5000,
      cols: 80,
      rows: 24,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    term.open(container);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try {
          webgl.dispose();
        } catch {
          /* ignore */
        }
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL 不可用时静默降级 canvas 2d
    }

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
    });

    // stdin → PTY（按当前 ptyId 过滤，避免会话切换竞态）
    const dataDisp = term.onData((data) => {
      const id = ptyIdRef.current;
      if (!id) return;
      void ptyWrite(id, data);
    });

    termRef.current = term;

    return () => {
      dataDisp.dispose();
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // ── PTY 生命周期：sessionKey / restart / cwd 变化 ─────────────────
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    let cancelled = false;
    let activePtyId: string | null = null;
    let unsubOut: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;

    const key = (sessionKey || '').trim() || '_global';

    const start = async () => {
      onStatusRef.current?.('connecting');
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }

      const cols = Math.max(2, term.cols || 80);
      const rows = Math.max(1, term.rows || 24);
      const cwdOpt = cwdRef.current?.trim() || undefined;

      // 统一 ensure/reuse registry；openTool 已 ensure 时直接复用，禁止再裸 create
      const reg = await import('../api/ptyRegistry');

      // 同 session 下 restartToken/localRestart 变化 → 先 take+kill 再新建（避免复用旧壳）
      const prev = prevLifecycleRef.current;
      const restartBumped =
        prev.sessionKey === key &&
        (prev.restartToken !== restartToken || prev.localRestart !== localRestart);
      prevLifecycleRef.current = { sessionKey: key, restartToken, localRestart };
      if (restartBumped) {
        await reg.killPtyForSession(key);
      }

      const priorId = reg.ptyRegistry.get(key) ?? null;
      let ptyId: string | null = priorId;
      // 仅 registry 已有绑定时算复用（折坞再开续缓冲）；ensure 新建不算
      let reused = !!priorId;

      if (!ptyId) {
        // ensure：走 spawn handler（bootstrap 注入）；失败再直连 ptyCreate
        ptyId = await reg.ensurePtyForSession(key);
      }

      if (!ptyId) {
        const res = await ptyCreate({
          sessionKey: key,
          cols,
          rows,
          ...(cwdOpt ? { cwd: cwdOpt } : {}),
        });

        if (res.status === 'missing') {
          if (!cancelled) {
            ptyIdRef.current = null;
            onStatusRef.current?.('missing');
            onMissingRef.current?.();
          }
          return;
        }

        if (res.status === 'error') {
          if (!cancelled) {
            ptyIdRef.current = null;
            onStatusRef.current?.('error', res.message);
            try {
              term.writeln(`\x1b[31m✗ ${res.message}\x1b[0m`);
            } catch {
              /* ignore */
            }
          }
          return;
        }

        ptyId = res.data.ptyId;
        // 立刻登记，即使随后 cancelled 也不造孤儿（策略 A：留给 closeTab take）
        reg.registerPtyBinding(key, ptyId);
      } else if (!priorId) {
        // ensure 新建：已在 ensure 内 bind；加固一次无害
        reg.registerPtyBinding(key, ptyId);
      }

      if (cancelled) {
        // 策略 A：不 kill；registry 已绑定即可
        return;
      }

      // 仅新建会话清屏；复用时保留缓冲（折坞再开续看）
      if (!reused) {
        try {
          term.reset();
        } catch {
          /* ignore */
        }
      }

      activePtyId = ptyId;
      ptyIdRef.current = activePtyId;
      onStatusRef.current?.('ready');

      unsubOut = subscribePtyOutput((p) => {
        if (cancelled || p.ptyId !== activePtyId) return;
        try {
          term.write(p.data);
        } catch {
          /* ignore */
        }
      });

      unsubExit = subscribePtyExit((p) => {
        if (cancelled || p.ptyId !== activePtyId) return;
        const codeLabel =
          p.code === undefined || p.code === null ? '' : ` · exit ${p.code}`;
        try {
          term.writeln(`\r\n\x1b[90m── 进程已退出${codeLabel} ──\x1b[0m`);
        } catch {
          /* ignore */
        }
        // 进程自退出：解绑 registry，避免死绑定复用
        void import('../api/ptyRegistry').then((m) => {
          if (m.ptyRegistry.get(key) === activePtyId) {
            m.ptyRegistry.unbind(key);
          }
        });
        if (ptyIdRef.current === activePtyId) {
          ptyIdRef.current = null;
        }
        onStatusRef.current?.('exited', codeLabel);
      });

      // 对齐尺寸（复用 / 新建后 layout 可能变化）
      try {
        fitAddon.fit();
        if (activePtyId) {
          void ptyResize(activePtyId, term.cols, term.rows);
        }
      } catch {
        /* ignore */
      }

      try {
        term.focus();
      } catch {
        /* ignore */
      }
    };

    void start();

    return () => {
      cancelled = true;
      unsubOut?.();
      unsubExit?.();
      unsubOut = null;
      unsubExit = null;
      // 策略 A：卸载 / 切 session **不** kill PTY；仅 closeTab 经 registry.take 杀
      const id = activePtyId;
      activePtyId = null;
      if (ptyIdRef.current === id) {
        ptyIdRef.current = null;
      }
    };
  }, [sessionKey, restartToken, localRestart, cwd]);

  // ── 容器尺寸变化 → fit + ptyResize ────────────────────────────────
  // 拖拽分屏时 body.tree-resizing / is-resizing 期间降采样，避免 xterm
  // 每帧 fit/WebGL 重绘导致闪烁频率高于右侧其它面板。
  useEffect(() => {
    const fitAddon = fitAddonRef.current;
    const el = containerRef.current;
    if (!fitAddon || !el) return;

    let raf = 0;
    let throttleTimer = 0;
    let lastCols = 0;
    let lastRows = 0;
    let lastFitAt = 0;

    const isLayoutResizing = () => {
      try {
        const b = document.body;
        return (
          b.classList.contains('tree-resizing') ||
          b.classList.contains('is-resizing') ||
          b.classList.contains('resizing-active') ||
          b.classList.contains('workspace-resizing')
        );
      } catch {
        return false;
      }
    };

    const doFit = () => {
      const term = termRef.current;
      if (!term || !fitAddonRef.current) return;
      try {
        fitAddonRef.current.fit();
      } catch {
        return;
      }
      lastFitAt = performance.now();
      const cols = term.cols;
      const rows = term.rows;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      const id = ptyIdRef.current;
      if (id) {
        void ptyResize(id, cols, rows);
      }
    };

    const scheduleFit = () => {
      // 布局拖拽中：约 12fps，与 sash 几何刷新对齐、降低 WebGL 闪烁
      const minInterval = isLayoutResizing() ? 80 : 32;
      const now = performance.now();
      const wait = Math.max(0, minInterval - (now - lastFitAt));

      if (wait > 0) {
        if (throttleTimer) return;
        throttleTimer = window.setTimeout(() => {
          throttleTimer = 0;
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            raf = 0;
            doFit();
          });
        }, wait);
        return;
      }

      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        doFit();
      });
    };

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(el);

    // 手势结束时补一次最终 fit（与其它面板 commit 几何同步）
    const onResizeClassChange = () => {
      if (!isLayoutResizing()) {
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = 0;
        }
        scheduleFit();
      }
    };
    const mo = new MutationObserver(onResizeClassChange);
    try {
      mo.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
      });
    } catch {
      /* ignore */
    }

    return () => {
      ro.disconnect();
      mo.disconnect();
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = 0;
      }
    };
  }, []);

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
          /* ignore */
        }
      }}
    />
  );
});
