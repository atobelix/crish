/**
 * useXtermTerminal：xterm 实例 + PTY 生命周期 + 容器尺寸适配的装配 hook。
 * 从 TerminalCard.xterm.tsx 提取，将 150 行 `start` 与 resize 观察逻辑收敛于此。
 *
 * 职责：
 * - 创建 Terminal / FitAddon / WebglAddon（仅挂载一次）
 * - PTY ensure/reuse/kill + 输入桥接（onData → ptyWrite，subscribePtyOutput → term.write）
 * - ResizeObserver/fit → ptyResize（拖拽分屏降采样）
 *
 * 策略 A（折坞复用）：unmount / 切 sessionKey 不 kill；closeTab/reset/restart 经 registry.take。
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ptyResize, ptyWrite } from '../../api/ptySessionApi';
import { ResizeObserverManager } from '../../services/ResizeObserverManager';
import { useLayoutAnimationStore } from '../../store/layoutAnimationStore';
import type { InteractiveXtermStatus } from './TerminalCard.xterm';
import { startPtySession } from './ptyLifecycle';

/** 读取 CSS 变量，缺失或 SSR 时回落 fallback。 */
function readCssVar(name: string, fallback = ''): string {
  try {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

export interface UseXtermTerminalArgs {
  sessionKey: string;
  cwd?: string;
  restartToken?: number;
  onStatusChange?: (status: InteractiveXtermStatus, detail?: string) => void;
  onPtyMissing?: () => void;
}

export interface UseXtermTerminalResult {
  /** 挂载 xterm 的容器节点 ref */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 稳定 DOM id（用于容器 + reactId 派生） */
  termDomId: string;
  /** 当前 ptyId（渲染层用于 data-* 属性）；每次 start/exit 后刷新 */
  ptyIdRef: React.RefObject<string | null>;
  /** 父级 restartToken 之外的本地强制重建计数；restart 暴露给 imperative handle */
  localRestart: number;
  /** 触发本地强制重建（imperative handle.restart 调用） */
  bumpLocalRestart: () => void;
  /** 终端实例 ref（imperative handle.focus/clear 读取） */
  termRef: React.RefObject<Terminal | null>;
}

/**
 * 装配 xterm 实例 + PTY 生命周期 + resize 适配。
 * 返回的 refs 供组件渲染与 imperative handle 共享；hook 自身管理副作用清理。
 */
export function useXtermTerminal({
  sessionKey,
  cwd,
  restartToken = 0,
  onStatusChange,
  onPtyMissing,
}: UseXtermTerminalArgs): UseXtermTerminalResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const sessionKeyRef = useRef(sessionKey);
  const cwdRef = useRef(cwd);
  const onStatusRef = useRef(onStatusChange);
  const onMissingRef = useRef(onPtyMissing);
  /** 父级 restartToken 之外的本地强制重建计数 */
  const [localRestart, setLocalRestart] = useState(0);
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

  // ── 创建 xterm 实例（仅挂载一次）────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const bg = readCssVar('--terminal-bg');
    const fg = readCssVar('--terminal-fg');
    const cursor = readCssVar('--terminal-cmd');
    const selection = readCssVar('--xterm-selection');

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
        black: readCssVar('--xterm-black'),
        red: readCssVar('--xterm-red'),
        green: readCssVar('--xterm-green'),
        yellow: readCssVar('--xterm-yellow'),
        blue: readCssVar('--xterm-blue'),
        magenta: readCssVar('--xterm-magenta'),
        cyan: readCssVar('--xterm-cyan'),
        white: readCssVar('--xterm-white'),
        brightBlack: readCssVar('--xterm-bright-black'),
        brightRed: readCssVar('--xterm-bright-red'),
        brightGreen: readCssVar('--xterm-bright-green'),
        brightYellow: readCssVar('--xterm-bright-yellow'),
        brightBlue: readCssVar('--xterm-bright-blue'),
        brightMagenta: readCssVar('--xterm-bright-magenta'),
        brightCyan: readCssVar('--xterm-bright-cyan'),
        brightWhite: readCssVar('--xterm-bright-white'),
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
          /* swallow-ok: WebGL 上下文已丢失时 dispose 幂等降级 */
        }
      });
      term.loadAddon(webgl);
    } catch {
      // swallow-ok: WebGL 不可用时静默降级 canvas 2d
    }

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        /* swallow-ok: 容器尚未布局完成时 fit 失败，下一帧重试 */
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
        /* swallow-ok: 组件卸载路径 dispose 失败不影响其余清理 */
      }
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // ── PTY 生命周期：sessionKey / restart / cwd 变化 ─────────────────
  //
  // start 函数体已提取为纯函数 startPtySession（见 ptyLifecycle.ts），
  // 本 effect 仅做 ref 读取 + cancellation token + 依赖注入 + 清理。
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    let cancelled = false;
    let activePtyId: string | null = null;
    const disposables: (() => void)[] = [];

    const key = (sessionKey || '').trim() || '_global';

    void startPtySession({
      term,
      fitAddon,
      key,
      restartToken,
      localRestart,
      cwdRef,
      onStatus: (status, detail) => onStatusRef.current?.(status, detail),
      onMissing: () => onMissingRef.current?.(),
      prevLifecycle: prevLifecycleRef,
      ptyIdRef,
      cancellation: { isCancelled: () => cancelled },
      setActivePtyId: (id) => {
        activePtyId = id;
      },
      addDisposable: (fn) => disposables.push(fn),
    });

    return () => {
      cancelled = true;
      for (const fn of disposables) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      disposables.length = 0;
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
        if (
          b.classList.contains('tree-resizing') ||
          b.classList.contains('is-resizing') ||
          b.classList.contains('resizing-active') ||
          b.classList.contains('workspace-resizing')
        ) {
          return true;
        }
        if (
          typeof document !== 'undefined' &&
          document.documentElement.dataset.layoutFrozen === 'true'
        ) {
          return true;
        }
        if (useLayoutAnimationStore.getState().activeAnimations.size > 0) {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };

    const doFit = () => {
      if (isLayoutResizing()) return;
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
      // 拖拽 / 动画期间彻底挂起（Zero-JS / 0 fit / 0 IPC），等 resize-settled 广播后单次补偿下发
      if (isLayoutResizing()) {
        return;
      }

      const now = performance.now();
      const wait = Math.max(0, 32 - (now - lastFitAt));

      if (wait > 0) {
        if (throttleTimer) return;
        throttleTimer = window.setTimeout(() => {
          throttleTimer = 0;
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (!isLayoutResizing()) {
              doFit();
            }
          });
        }, wait);
        return;
      }

      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!isLayoutResizing()) {
          doFit();
        }
      });
    };

    const roManager = ResizeObserverManager.getInstance();
    const handleResize = () => {
      scheduleFit();
    };
    roManager.observe(el, handleResize);

    const onResizeSettled = () => {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = 0;
      }
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (!isLayoutResizing()) {
        doFit();
      }
    };
    window.addEventListener('app:window-resize-settled', onResizeSettled, {
      passive: true,
    });

    return () => {
      roManager.unobserve(el, handleResize);
      window.removeEventListener('app:window-resize-settled', onResizeSettled);
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

  return {
    containerRef,
    termDomId,
    ptyIdRef,
    localRestart,
    bumpLocalRestart: () => setLocalRestart((n) => n + 1),
    termRef,
  };
}
