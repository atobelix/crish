import { getCurrentWindow } from '@tauri-apps/api/window';

export class WindowResizeBridge {
  private static instance: WindowResizeBridge | null = null;
  private connected = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupFns: (() => void)[] = [];
  private readonly DEBOUNCE_MS = 150;

  static getInstance(): WindowResizeBridge {
    if (!WindowResizeBridge.instance) {
      WindowResizeBridge.instance = new WindowResizeBridge();
    }
    return WindowResizeBridge.instance;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    // 1. 尝试连接 Tauri 原生窗口 Resize 事件
    try {
      const win = getCurrentWindow();
      const unlisten = await win.onResized(() => this.handleResizeDebounced());
      this.cleanupFns.push(() => {
        unlisten();
      });
    } catch {
      // 2. 降级为 Web 原生 passive 监听（彻底拔除 rAF 轮询）
      const onResize = () => this.handleResizeDebounced();
      window.addEventListener('resize', onResize, { passive: true });
      this.cleanupFns.push(() =>
        window.removeEventListener('resize', onResize)
      );
    }
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.cleanupFns.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
    this.cleanupFns = [];
  }

  /** 仅在用户停止拖拽 150ms 后发出单次低频通知，拖拽期间 JS 彻底休眠！ */
  private handleResizeDebounced(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // 触发轻量自定义事件，通知需要精确重绘的特殊视口（如虚拟滚动、XTerm）
      window.dispatchEvent(new CustomEvent('app:window-resize-settled'));
    }, this.DEBOUNCE_MS);
  }
}
