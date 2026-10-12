// @vitest-environment jsdom
/**
 * 贴靠热区 × 模态遮罩：原生子窗口在 WebView 之上、DOM 遮罩盖不住它。
 * LayerStack 有模态层时必须撤下热区（上报 null），模态全部关闭后重测重报。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeTyped = vi.fn();
vi.mock('../../api/tauriInvoke', () => ({
  invokeTyped: (...args: unknown[]) => invokeTyped(...args),
}));
vi.mock('../../services/LoggerService', () => ({
  logger: { warn: vi.fn(), debug: vi.fn() },
  toErrMeta: (err: unknown) => ({ message: String(err) }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

import {
  SNAP_OVERLAY_COMMAND,
  __resetSnapOverlayForTests,
  registerSnapOverlayTarget,
} from './windowSnapOverlay';
import { layerStackService } from '../ui/internal/layer-stack/LayerStackService';

function makeButton(x: number): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({
      left: x,
      top: 0,
      width: 46,
      height: 36,
      right: x + 46,
      bottom: 36,
      x,
      y: 0,
    }) as DOMRect;
  return el;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('windowSnapOverlay：模态遮罩打开时撤下原生热区', () => {
  beforeEach(() => {
    layerStackService.dispose();
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) =>
      window.setTimeout(() => cb(0), 0)
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      window.clearTimeout(id);
    });
    invokeTyped.mockResolvedValue({ status: 'ok', data: true });
  });

  afterEach(() => {
    __resetSnapOverlayForTests();
    layerStackService.dispose();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    document.body.innerHTML = '';
    invokeTyped.mockReset();
    vi.restoreAllMocks();
  });

  it('模态入栈 → 上报 null；出栈 → 重报按钮矩形；非模态浮层不触发重报', async () => {
    const el = makeButton(1000);
    registerSnapOverlayTarget({
      getElement: () => el,
      onPhase: () => undefined,
    });
    await flush();
    expect(invokeTyped).toHaveBeenLastCalledWith(SNAP_OVERLAY_COMMAND, {
      rect: { x: 1000, y: 0, width: 46, height: 36 },
    });

    invokeTyped.mockClear();
    const offMenu = layerStackService.register({
      id: 'menu',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => undefined,
    });
    await flush();
    expect(invokeTyped).not.toHaveBeenCalled();
    offMenu();

    const offModal = layerStackService.register({
      id: 'settings',
      type: 'modal-dialog',
      modal: true,
      dismissible: false,
      onDismiss: () => undefined,
    });
    await flush();
    expect(invokeTyped).toHaveBeenLastCalledWith(SNAP_OVERLAY_COMMAND, {
      rect: null,
    });

    offModal();
    await flush();
    expect(invokeTyped).toHaveBeenLastCalledWith(SNAP_OVERLAY_COMMAND, {
      rect: { x: 1000, y: 0, width: 46, height: 36 },
    });
  });

  it('模态已打开时登记：首报即为 null，不会把热区盖到遮罩上', async () => {
    const offModal = layerStackService.register({
      id: 'settings',
      type: 'modal-dialog',
      modal: true,
      dismissible: false,
      onDismiss: () => undefined,
    });
    const el = makeButton(900);
    registerSnapOverlayTarget({
      getElement: () => el,
      onPhase: () => undefined,
    });
    await flush();
    expect(invokeTyped).toHaveBeenLastCalledWith(SNAP_OVERLAY_COMMAND, {
      rect: null,
    });
    offModal();
  });
});
