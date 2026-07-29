import { afterEach, vi } from 'vitest';

/**
 * Node vitest 环境补齐 browser 全局，避免 seed layoutStore 时 localStorage 缺失。
 */
const mem = new Map<string, string>();
const sessionMem = new Map<string, string>();

function makeStorageMock(store: Map<string, string>) {
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

const localStorageMock = makeStorageMock(mem);
const sessionStorageMock = makeStorageMock(sessionMem);

// @ts-expect-error test env
globalThis.localStorage = localStorageMock;
// @ts-expect-error test env — shellWindowScope mints per-webview id here
globalThis.sessionStorage = sessionStorageMock;
// @ts-expect-error test env
if (typeof globalThis.window === 'undefined') {
  // @ts-expect-error test env
  globalThis.window = globalThis;
}
// Node vitest：sessionActions.setActiveSessionId → projectStore 会 dispatch 自定义事件
if (typeof globalThis.window.dispatchEvent !== 'function') {
  globalThis.window.dispatchEvent = () => true;
}
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
}
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
if (typeof globalThis.CustomEvent === 'undefined') {
  // @ts-expect-error test env
  globalThis.CustomEvent = class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

process.on('unhandledRejection', (reason) => {
  console.error('[vitest.setup] Unhandled Rejection:', reason);
});
