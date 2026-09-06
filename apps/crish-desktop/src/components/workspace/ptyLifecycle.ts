/**
 * PTY 生命周期纯函数（T4-8：从 useXtermTerminal.start 提取）。
 *
 * 原 `start` 函数体 150+ 行，提取为纯函数 `startPtySession`，所有依赖经参数注入。
 * 调用方（useXtermTerminal）提供 term/fitAddon/refs/cancellation token 等。
 */
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import {
  getPtyOutputHistory,
  ptyCreate,
  ptyKill,
  ptyResize,
  subscribePtyExit,
  subscribePtyOutput,
} from '../../api/ptySessionApi';

/** 调用方提供的取消 token（读 cancelled 标志） */
export interface CancellationSlot {
  isCancelled: () => boolean;
}

/** PTY 启动所需依赖（全部由 useXtermTerminal 注入） */
export interface StartPtySessionDeps {
  term: Terminal;
  fitAddon: FitAddon;
  key: string;
  restartToken: number;
  localRestart: number;
  cwdRef: { current: string | undefined };
  onStatus: (status: 'connecting' | 'ready' | 'missing' | 'error' | 'exited', detail?: string) => void;
  onMissing: () => void;
  prevLifecycle: {
    current: { sessionKey: string; restartToken: number; localRestart: number };
  };
  ptyIdRef: { current: string | null };
  cancellation: CancellationSlot;
  /** 写入 activePtyId（调用方持有局部变量） */
  setActivePtyId: (id: string | null) => void;
  /** 收集 disposable（退出时清理订阅） */
  addDisposable: (fn: () => void) => void;
}

/**
 * 启动 / 复用 PTY 会话。
 *
 * 与原 useXtermTerminal.start 逐分支等价：
 * 1. fit → 读 cols/rows/cwd
 * 2. 动态 import ptyRegistry
 * 3. restart 检测 → killPtyForSession
 * 4. ensure/reuse → 直连 ptyCreate 降级
 * 5. 清屏（仅新建）
 * 6. 订阅 output/exit
 * 7. 尺寸同步 + 聚焦
 */
export async function startPtySession(deps: StartPtySessionDeps): Promise<void> {
  const {
    term,
    fitAddon,
    key,
    restartToken,
    localRestart,
    cwdRef,
    onStatus,
    onMissing,
    prevLifecycle,
    ptyIdRef,
    cancellation,
    setActivePtyId,
    addDisposable,
  } = deps;

  onStatus('connecting');
  try {
    fitAddon.fit();
  } catch {
    /* swallow-ok: 连接阶段 fit 失败不阻断 pty 建立 */
  }

  const cols = Math.max(2, term.cols || 80);
  const rows = Math.max(1, term.rows || 24);
  const cwdOpt = cwdRef.current?.trim() || undefined;

  // 统一 ensure/reuse registry；openTool 已 ensure 时直接复用，禁止再裸 create
  const reg = await import('../../api/ptyRegistry');
  if (cancellation.isCancelled()) return;

  // 同 session 下 restartToken/localRestart 变化 → 先 take+kill 再新建
  const prev = prevLifecycle.current;
  const restartBumped =
    prev.sessionKey === key &&
    (prev.restartToken !== restartToken || prev.localRestart !== localRestart);
  prevLifecycle.current = { sessionKey: key, restartToken, localRestart };
  if (restartBumped) {
    await reg.killPtyForSession(key);
    if (cancellation.isCancelled()) return;
  }

  const priorId = reg.ptyRegistry.get(key) ?? null;
  let ptyId: string | null = priorId;
  // 仅 registry 已有绑定时算复用（折坞再开续缓冲）；ensure 新建不算
  const reused = !!priorId;

  if (!ptyId) {
    ptyId = await ensureOrAbort(reg, key, cancellation, onStatus, cwdOpt);
    if (cancellation.isCancelled()) return;
  }

  if (!ptyId) {
    const outcome = await tryDirectCreate(
      term,
      key,
      cols,
      rows,
      cwdOpt,
      cancellation,
      onStatus,
      onMissing,
      reg
    );
    if (outcome === 'abort') return;
    if (outcome.ptyId) {
      ptyId = outcome.ptyId;
      reg.registerPtyBinding(key, ptyId);
    }
  } else if (!priorId) {
    reg.registerPtyBinding(key, ptyId);
  }

  if (cancellation.isCancelled()) {
    if (ptyId && !reused) {
      void reg.killPtySession(key);
      void ptyKill(ptyId);
    }
    return;
  }

  // 仅新建会话清屏；复用时保留缓冲
  if (!reused) {
    try {
      term.reset();
    } catch {
      /* swallow-ok: reset 失败时终端仍可用，仅缓冲未清 */
    }
  }

  setActivePtyId(ptyId);
  ptyIdRef.current = ptyId;
  onStatus('ready');

  subscribePtyStreams({
    term,
    key,
    cancellation,
    ptyId,
    ptyIdRef,
    onStatus,
    addDisposable,
  });

  if (reused && ptyId) {
    // 复用 PTY 时，从环形历史缓冲重放已有屏幕输出，防止由于 PTY 空闲导致新终端空白
    const history = getPtyOutputHistory(ptyId);
    if (history && history.length > 0) {
      for (const chunk of history) {
        term.write(chunk);
      }
    }
    try {
      fitAddon.fit();
      term.refresh(0, Math.max(0, (term.rows || 24) - 1));
    } catch {
      /* swallow-ok: 历史重放后自适应与刷新失败不阻断后续流 */
    }
  }

  // 对齐尺寸（复用 / 新建后 layout 可能变化）
  try {
    fitAddon.fit();
    if (ptyId) {
      void ptyResize(ptyId, term.cols, term.rows);
    }
  } catch {
    /* swallow-ok: 尺寸同步失败时 pty 保持旧尺寸，下次 resize 校正 */
  }

  // 延迟一帧再次 fit，确保 DOM / 样式水合及字符网格完整铺开
  requestAnimationFrame(() => {
    if (cancellation.isCancelled()) return;
    try {
      fitAddon.fit();
      if (ptyId) {
        void ptyResize(ptyId, term.cols, term.rows);
      }
    } catch {
      /* swallow-ok */
    }
  });

  try {
    term.focus();
  } catch {
    /* swallow-ok: 终端未就绪时聚焦为空操作 */
  }
}

// ── 子步骤：ensure（spawn handler 注入） ──────────────────────────

async function ensureOrAbort(
  reg: typeof import('../../api/ptyRegistry'),
  key: string,
  cancellation: CancellationSlot,
  onStatus: (status: 'connecting' | 'ready' | 'missing' | 'error' | 'exited', detail?: string) => void,
  cwd?: string,
): Promise<string | null> {
  // ensure：走 spawn handler（bootstrap 注入）；失败再直连 ptyCreate
  const ptyId = await reg.ensurePtyForSession(key, cwd);
  if (cancellation.isCancelled()) {
    if (ptyId) {
      void reg.killPtySession(key);
      void ptyKill(ptyId);
    }
    return null;
  }
  // 注意：ensureOrAbort 只在 !ptyId 时调用；这里不设 onStatus（由外层统一）
  return ptyId;
}

// ── 子步骤：直连 ptyCreate 降级 ───────────────────────────────────

type CreateOutcome =
  | { ptyId: string }
  | 'abort';

async function tryDirectCreate(
  term: Terminal,
  key: string,
  cols: number,
  rows: number,
  cwdOpt: string | undefined,
  cancellation: CancellationSlot,
  onStatus: (status: 'connecting' | 'ready' | 'missing' | 'error' | 'exited', detail?: string) => void,
  onMissing: () => void,
  reg: typeof import('../../api/ptyRegistry')
): Promise<CreateOutcome> {
  const res = await ptyCreate({
    sessionKey: key,
    cols,
    rows,
    ...(cwdOpt ? { cwd: cwdOpt } : {}),
  });

  if (cancellation.isCancelled()) {
    if (res.status === 'ok' && res.data?.ptyId) {
      void ptyKill(res.data.ptyId);
    }
    return 'abort';
  }

  if (res.status === 'missing') {
    onStatus('missing');
    onMissing();
    return 'abort';
  }

  if (res.status === 'error') {
    onStatus('error', res.message);
    try {
      term.writeln(`\x1b[31m✗ ${res.message}\x1b[0m`);
    } catch {
      /* ignore */
    }
    return 'abort';
  }

  return { ptyId: res.data.ptyId };
}

// ── 子步骤：订阅 output/exit ──────────────────────────────────────

function subscribePtyStreams(params: {
  term: Terminal;
  key: string;
  cancellation: CancellationSlot;
  ptyId: string | null;
  ptyIdRef: { current: string | null };
  onStatus: (status: 'connecting' | 'ready' | 'missing' | 'error' | 'exited', detail?: string) => void;
  addDisposable: (fn: () => void) => void;
}): void {
  const {
    term,
    key,
    cancellation,
    ptyId,
    ptyIdRef,
    onStatus,
    addDisposable,
  } = params;
  const activePtyId = ptyId;

  const unsubOut = subscribePtyOutput((p) => {
    if (cancellation.isCancelled() || p.ptyId !== activePtyId) return;
    try {
      term.write(p.data);
    } catch {
      /* swallow-ok: 终端已销毁时输出帧丢弃，不阻断会话 */
    }
  });
  addDisposable(unsubOut);

  const unsubExit = subscribePtyExit((p) => {
    if (cancellation.isCancelled() || p.ptyId !== activePtyId) return;
    const codeLabel =
      p.code === undefined || p.code === null ? '' : ` · exit ${p.code}`;
    try {
      term.writeln(`\r\n\x1b[90m── 进程已退出${codeLabel} ──\x1b[0m`);
    } catch {
      /* swallow-ok: 退出提示写终端失败不影响状态更新 */
    }
    // 进程自退出：解绑 registry，避免死绑定复用
    void import('../../api/ptyRegistry').then((m) => {
      if (m.ptyRegistry.get(key) === activePtyId) {
        m.ptyRegistry.unbind(key);
      }
    });
    if (ptyIdRef.current === activePtyId) {
      ptyIdRef.current = null;
    }
    onStatus('exited', codeLabel);
  });
  addDisposable(unsubExit);
}
