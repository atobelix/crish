/**
 * windowSnapOverlay —— Win11 贴靠布局（Snap Layouts）原生热区的前端控制器。
 *
 * 背景：主窗口无边框（decorations=false），客户区被 WebView2 覆盖，系统拿不到最大化按钮的
 * `HTMAXBUTTON` 命中测试，悬停最大化钮不会弹出贴靠布局面板。Rust 侧
 * （`src-tauri/src/window_snap_overlay.rs`）在按钮正上方放一个不绘制的原生子窗口，
 * 对 `WM_NCHITTEST` 回 `HTMAXBUTTON`；本模块负责：
 * 1. 测量最大化按钮的 CSS 矩形（视口坐标 = 客户区坐标），经
 *    `workbench_set_snap_overlay_rect` 上报；按钮尺寸（ResizeObserverManager）/ 窗口缩放稳定
 *    （WindowResizeBridge 的 app:window-resize-settled，含最大化 / 还原）/ DPR 变化时重报；
 * 2. 原生热区接管了这块区域的鼠标，`:hover` / `:active` 收不到 → 监听
 *    `crish://window-snap-overlay` 事件，把 enter / leave / press / release 转给按钮画状态；
 *    点击（最大化 / 还原）由 Rust 在热区内直接执行。
 *
 * 多实例：主顶栏与设置全屏页各有一组窗控，同一时刻只有最上层（最后挂载）那组拥有热区；
 * 它卸载后热区交还给下一组；全部卸载则撤销热区。
 *
 * 失败语义（QUALITY-GATE）：上报失败 / 命令缺失 → logger.warn（同一原因只记一次），
 * 按钮保持普通前端 onClick 实现；不在 Windows 桌面壳内时不启用（Mac 不渲染窗控）。
 */
import { invokeTyped } from '../../api/tauriInvoke';
import { logger, toErrMeta } from '../../services/LoggerService';

export const SNAP_OVERLAY_COMMAND = 'workbench_set_snap_overlay_rect';
/** 与 Rust `window_snap_overlay::SNAP_OVERLAY_EVENT` 同值 */
export const SNAP_OVERLAY_EVENT = 'crish://window-snap-overlay';

export type SnapOverlayPhase = 'enter' | 'leave' | 'press' | 'release';

const PHASES: ReadonlySet<string> = new Set(['enter', 'leave', 'press', 'release']);

/** 上报给 Rust 的按钮矩形（CSS 逻辑像素，相对视口左上角） */
export interface SnapButtonRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapOverlayTarget {
  /** 当前最大化按钮元素（未挂载时为 null） */
  getElement: () => HTMLElement | null;
  /** 原生热区回传的指针阶段 */
  onPhase: (phase: SnapOverlayPhase) => void;
}

const LOG_MODULE = 'window-snap';

const stack: SnapOverlayTarget[] = [];
let frameId: number | null = null;
let listenerReady: Promise<void> | null = null;
let detachEnvironment: (() => void) | null = null;
let lastFailure: string | null = null;

/** 仅 Windows 的 Tauri 桌面壳启用原生贴靠热区。 */
export function isSnapLayoutHost(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window &&
    typeof navigator !== 'undefined' &&
    /Windows/i.test(navigator.userAgent)
  );
}

export function parseSnapOverlayPhase(payload: unknown): SnapOverlayPhase | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const phase = (payload as { phase?: unknown }).phase;
  return typeof phase === 'string' && PHASES.has(phase)
    ? (phase as SnapOverlayPhase)
    : null;
}

export function measureSnapButton(el: HTMLElement | null): SnapButtonRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function reportFailure(reason: string, err?: unknown): void {
  if (reason === lastFailure) return;
  lastFailure = reason;
  logger.warn(
    `[window-snap] 贴靠布局原生热区不可用，最大化按钮回退前端点击实现：${reason}`,
    { module: LOG_MODULE, err: toErrMeta(err ?? reason) }
  );
}

function ensureEventListener(): Promise<void> {
  if (!listenerReady) {
    listenerReady = (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<unknown>(SNAP_OVERLAY_EVENT, (event) => {
        const phase = parseSnapOverlayPhase(event.payload);
        if (!phase) {
          logger.warn('[window-snap] 忽略无法识别的热区事件', {
            module: LOG_MODULE,
            err: toErrMeta(JSON.stringify(event.payload)),
          });
          return;
        }
        stack[stack.length - 1]?.onPhase(phase);
      });
    })().catch((err: unknown) => {
      listenerReady = null;
      logger.warn('[window-snap] 监听热区事件失败：最大化钮 hover/按下态将不显示（点击仍由原生热区执行）', {
        module: LOG_MODULE,
        err: toErrMeta(err),
      });
    });
  }
  return listenerReady;
}

async function sendRect(rect: SnapButtonRect | null): Promise<void> {
  const res = await invokeTyped<boolean>(SNAP_OVERLAY_COMMAND, { rect });
  if (res.status === 'ok') {
    if (rect && res.data === true) {
      lastFailure = null;
      await ensureEventListener();
    }
    return;
  }
  if (res.status === 'missing') {
    reportFailure(`命令 ${SNAP_OVERLAY_COMMAND} 未注册`);
    return;
  }
  reportFailure(res.message, res.raw);
}

async function reportTop(): Promise<void> {
  const top = stack[stack.length - 1];
  if (!top) return;
  await sendRect(measureSnapButton(top.getElement()));
}

function scheduleReport(): void {
  if (frameId !== null) return;
  frameId = window.requestAnimationFrame(() => {
    frameId = null;
    void reportTop();
  });
}

/** WindowResizeBridge 在窗口缩放（含最大化 / 还原）稳定后派发的事件 */
const WINDOW_RESIZE_SETTLED_EVENT = 'app:window-resize-settled';

function attachEnvironment(): void {
  if (detachEnvironment) return;
  const onResize = (): void => scheduleReport();
  let dprQuery: MediaQueryList | null = null;
  const onDprChange = (): void => {
    bindDprQuery();
    scheduleReport();
  };
  // DPR 变化（拖到不同缩放的显示器）不一定改变 CSS 布局，但物理矩形会变
  const bindDprQuery = (): void => {
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        : null;
    dprQuery?.addEventListener('change', onDprChange);
  };
  window.addEventListener(WINDOW_RESIZE_SETTLED_EVENT, onResize);
  bindDprQuery();
  detachEnvironment = () => {
    window.removeEventListener(WINDOW_RESIZE_SETTLED_EVENT, onResize);
    dprQuery?.removeEventListener('change', onDprChange);
    detachEnvironment = null;
  };
}

/** 按钮自身尺寸变化（ResizeObserver）等场景主动请求重报。 */
export function requestSnapOverlayReport(): void {
  if (stack.length > 0) scheduleReport();
}

/**
 * 登记一个最大化按钮为贴靠热区目标（后登记者在上）。返回注销函数。
 * 非 Windows 桌面壳返回空注销（该平台无贴靠布局，按钮走普通点击）。
 */
export function registerSnapOverlayTarget(target: SnapOverlayTarget): () => void {
  if (!isSnapLayoutHost()) return () => undefined;
  stack[stack.length - 1]?.onPhase('leave');
  stack.push(target);
  attachEnvironment();
  scheduleReport();
  return () => {
    const index = stack.indexOf(target);
    if (index < 0) return;
    const wasTop = index === stack.length - 1;
    stack.splice(index, 1);
    if (stack.length === 0) {
      detachEnvironment?.();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      void sendRect(null);
      return;
    }
    if (wasTop) scheduleReport();
  };
}

/** 测试专用：重置模块级状态。 */
export function __resetSnapOverlayForTests(): void {
  stack.length = 0;
  detachEnvironment?.();
  if (frameId !== null && typeof window !== 'undefined') {
    window.cancelAnimationFrame(frameId);
  }
  frameId = null;
  listenerReady = null;
  lastFailure = null;
}
