import { getCurrentWindow } from '@tauri-apps/api/window';
import { beginLayoutInteraction, endLayoutInteraction } from '../store/layoutAnimationStore';

export class WindowResizeBridge {
  private static instance: WindowResizeBridge | null = null;
  private connected = false;
  private frozen = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupFns: (() => void)[] = [];
  private unlistenResize: (() => void) | null = null;
  private unlistenMoved: (() => void) | null = null;
  private readonly DEBOUNCE_MS = 200;
  private readonly WATCHDOG_MS = 5000;

  static getInstance(): WindowResizeBridge {
    if (!WindowResizeBridge.instance) {
      WindowResizeBridge.instance = new WindowResizeBridge();
    }
    return WindowResizeBridge.instance;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    await this.connectTauri();
    this.connectWebFallback();
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.runCleanup();
    this.cancelTimers();
    this.frozen = false;
  }

  private async connectTauri(): Promise<void> {
    try {
      const win = getCurrentWindow();
      try {
        this.unlistenResize = await win.onResized(() => this.handleWindowChange());
        this.cleanupFns.push(() => { this.unlistenResize?.(); });
      } catch {
        // fallback to Web
      }
      try {
        this.unlistenMoved = await win.onMoved(() => this.handleWindowChange());
        this.cleanupFns.push(() => { this.unlistenMoved?.(); });
      } catch {
        // onMoved unavailable, use rAF polling
        this.startRafPollingFallback();
      }
    } catch {
      console.info('[WindowResizeBridge] Not in Tauri, using Web fallback');
    }
  }

  private startRafPollingFallback(): void {
    let lastX = window.screenX;
    let lastY = window.screenY;
    let rafId: number;
    const poll = () => {
      if (!this.connected) return;
      if (window.screenX !== lastX || window.screenY !== lastY) {
        lastX = window.screenX;
        lastY = window.screenY;
        this.handleWindowChange();
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    this.cleanupFns.push(() => cancelAnimationFrame(rafId));
  }

  private connectWebFallback(): void {
    const handler = () => this.handleWindowChange();
    window.addEventListener('resize', handler, { passive: true });
    this.cleanupFns.push(() => window.removeEventListener('resize', handler));
  }

  private handleWindowChange(): void {
    // 1. 每次事件触发，必须重置并延后防抖定时器，确保拖拽期间持续处于冻结状态
    this.cancelTimers();

    this.watchdogTimer = setTimeout(() => {
      console.warn('[WindowResizeBridge] watchdog fired — forced thaw');
      endLayoutInteraction('window-resizing');
      this.frozen = false;
    }, this.WATCHDOG_MS);

    this.debounceTimer = setTimeout(() => {
      this.cancelTimers();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          endLayoutInteraction('window-resizing');
          this.frozen = false;
        });
      });
    }, this.DEBOUNCE_MS);

    // 2. 若已处于冻结中，只需刷新定时器即可，无需重复 beginLayoutInteraction
    if (this.frozen) return;

    this.frozen = true;
    try {
      beginLayoutInteraction('window-resizing');
    } catch (err) {
      console.error('[WindowResizeBridge] failed to begin freeze', err);
    }
  }

  private cancelTimers(): void {
    if (this.debounceTimer !== null) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.watchdogTimer !== null) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null; }
  }

  private runCleanup(): void {
    for (const fn of this.cleanupFns) { try { fn(); } catch { /* ignore */ } }
    this.cleanupFns = [];
    this.unlistenResize = null;
    this.unlistenMoved = null;
  }
}
