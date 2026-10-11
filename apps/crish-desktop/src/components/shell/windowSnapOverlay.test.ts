// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeTyped = vi.fn();
vi.mock('../../api/tauriInvoke', () => ({
  invokeTyped: (...args: unknown[]) => invokeTyped(...args),
}));

const warn = vi.fn();
vi.mock('../../services/LoggerService', () => ({
  logger: { warn: (...args: unknown[]) => warn(...args), debug: vi.fn() },
  toErrMeta: (err: unknown) => ({ message: String(err) }),
}));

type EventHandler = (event: { payload: unknown }) => void;
let eventHandler: EventHandler | null = null;
const listen = vi.fn(async (_name: string, handler: EventHandler) => {
  eventHandler = handler;
  return () => undefined;
});
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: EventHandler) => listen(name, handler),
}));

import {
  SNAP_OVERLAY_COMMAND,
  SNAP_OVERLAY_EVENT,
  __resetSnapOverlayForTests,
  measureSnapButton,
  parseSnapOverlayPhase,
  registerSnapOverlayTarget,
  type SnapOverlayPhase,
} from './windowSnapOverlay';

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

function makeButton(x: number, width = 46, height = 36): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({ left: x, top: 0, width, height, right: x + width, bottom: height, x, y: 0 }) as DOMRect;
  return el;
}

/** 等待 rAF + invoke + 动态 import 的微任务链跑完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('windowSnapOverlay（Win11 贴靠布局热区前端控制器）', () => {
  beforeEach(() => {
    setUserAgent(WINDOWS_UA);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    // 与真实 rAF 一致：回调异步执行（同步调用会让 frameId 在回调之后才被赋值）
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return window.setTimeout(() => cb(0), 0);
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      window.clearTimeout(id);
    });
    invokeTyped.mockResolvedValue({ status: 'ok', data: true });
  });

  afterEach(() => {
    __resetSnapOverlayForTests();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    document.body.innerHTML = '';
    eventHandler = null;
    invokeTyped.mockReset();
    listen.mockClear();
    warn.mockReset();
    vi.restoreAllMocks();
  });

  it('登记后以 CSS 逻辑像素上报最大化按钮矩形，成功后监听热区事件并转给按钮', async () => {
    const phases: SnapOverlayPhase[] = [];
    const el = makeButton(1000);
    registerSnapOverlayTarget({ getElement: () => el, onPhase: (p) => phases.push(p) });
    await flush();

    expect(invokeTyped).toHaveBeenCalledWith(SNAP_OVERLAY_COMMAND, {
      rect: { x: 1000, y: 0, width: 46, height: 36 },
    });
    expect(listen).toHaveBeenCalledWith(SNAP_OVERLAY_EVENT, expect.any(Function));

    eventHandler?.({ payload: { phase: 'enter' } });
    eventHandler?.({ payload: { phase: 'press' } });
    eventHandler?.({ payload: { phase: 'release' } });
    eventHandler?.({ payload: { phase: 'leave' } });
    expect(phases).toEqual(['enter', 'press', 'release', 'leave']);
  });

  it('无法识别的热区事件不分派，并记 warn', async () => {
    const onPhase = vi.fn();
    const el = makeButton(10);
    registerSnapOverlayTarget({ getElement: () => el, onPhase });
    await flush();
    eventHandler?.({ payload: { phase: 'hover' } });
    eventHandler?.({ payload: 'enter' });
    expect(onPhase).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('多组窗控：后挂载者拥有热区；卸载后交还前一组并重报其矩形；全部卸载则撤销热区', async () => {
    const bottomPhases: SnapOverlayPhase[] = [];
    const topPhases: SnapOverlayPhase[] = [];
    const bottom = makeButton(900);
    const top = makeButton(800);
    const offBottom = registerSnapOverlayTarget({
      getElement: () => bottom,
      onPhase: (p) => bottomPhases.push(p),
    });
    await flush();
    eventHandler?.({ payload: { phase: 'enter' } });

    const offTop = registerSnapOverlayTarget({
      getElement: () => top,
      onPhase: (p) => topPhases.push(p),
    });
    await flush();
    // 被压下的一组先复位 hover，避免残留高亮
    expect(bottomPhases).toEqual(['enter', 'leave']);
    expect(invokeTyped).toHaveBeenLastCalledWith(SNAP_OVERLAY_COMMAND, {
      rect: { x: 800, y: 0, width: 46, height: 36 },
    });
    eventHandler?.({ payload: { phase: 'enter' } });
    expect(topPhases).toEqual(['enter']);

    offTop();
    await flush();
    expect(invokeTyped).toHaveBeenLastCalledWith(SNAP_OVERLAY_COMMAND, {
      rect: { x: 900, y: 0, width: 46, height: 36 },
    });

    offBottom();
    await flush();
    expect(invokeTyped).toHaveBeenLastCalledWith(SNAP_OVERLAY_COMMAND, { rect: null });
  });

  it('窗口缩放稳定（app:window-resize-settled）时重报矩形（最大化 / 还原后按钮位置变化）', async () => {
    let x = 1000;
    const el = makeButton(0);
    el.getBoundingClientRect = () =>
      ({ left: x, top: 0, width: 46, height: 36 }) as DOMRect;
    registerSnapOverlayTarget({ getElement: () => el, onPhase: vi.fn() });
    await flush();
    x = 1800;
    window.dispatchEvent(new Event('app:window-resize-settled'));
    await flush();
    expect(invokeTyped).toHaveBeenLastCalledWith(SNAP_OVERLAY_COMMAND, {
      rect: { x: 1800, y: 0, width: 46, height: 36 },
    });
  });

  it('原生热区失败：记 warn（同一原因只记一次），不监听事件（按钮保持普通点击）', async () => {
    invokeTyped.mockResolvedValue({
      status: 'error',
      kind: 'Internal',
      message: 'CreateWindowExW 失败 (GetLastError=5)',
    });
    const el = makeButton(10);
    registerSnapOverlayTarget({ getElement: () => el, onPhase: vi.fn() });
    await flush();
    window.dispatchEvent(new Event('app:window-resize-settled'));
    await flush();

    expect(invokeTyped).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('回退前端点击');
    expect(String(warn.mock.calls[0][0])).toContain('CreateWindowExW');
    expect(listen).not.toHaveBeenCalled();
  });

  it('命令缺失（未注册）同样可观测', async () => {
    invokeTyped.mockResolvedValue({ status: 'missing' });
    const el = makeButton(10);
    registerSnapOverlayTarget({ getElement: () => el, onPhase: vi.fn() });
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(SNAP_OVERLAY_COMMAND);
  });

  it('非 Windows 或非 Tauri 宿主不启用（不调命令）', async () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    const el = makeButton(10);
    registerSnapOverlayTarget({ getElement: () => el, onPhase: vi.fn() })();
    setUserAgent(WINDOWS_UA);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    registerSnapOverlayTarget({ getElement: () => el, onPhase: vi.fn() })();
    await flush();
    expect(invokeTyped).not.toHaveBeenCalled();
  });

  it('按钮不可见（0 尺寸 / 未挂载）时上报 null 撤销热区', () => {
    expect(measureSnapButton(null)).toBeNull();
    expect(measureSnapButton(document.createElement('div'))).toBeNull();
    expect(measureSnapButton(makeButton(10, 0, 36))).toBeNull();
    expect(measureSnapButton(makeButton(10))).toEqual({ x: 10, y: 0, width: 46, height: 36 });
  });

  it('phase 解析只认四个 wire 字面量（与 Rust SnapOverlayPhase::as_str 同值）', () => {
    for (const p of ['enter', 'leave', 'press', 'release']) {
      expect(parseSnapOverlayPhase({ phase: p })).toBe(p);
    }
    expect(parseSnapOverlayPhase({ phase: 'click' })).toBeNull();
    expect(parseSnapOverlayPhase(null)).toBeNull();
  });
});
