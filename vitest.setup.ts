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
// Node vitest：window === globalThis。这里补齐真正互通的 add/remove/dispatch 事件三元组，
// 使 emitUiEvent（CustomEvent + dispatchEvent）与测试侧 window.addEventListener 订阅链路可用
// （migrateLegacyProfiles.test 断言 security-migration-failed 事件载荷）。
// 替换原先的 no-op dispatchEvent：无订阅者时行为不变（返回 true），纯增量能力。
type TestWindowEvent = { type: string; detail?: unknown };
type TestWindowListener = (ev: TestWindowEvent) => void;
const windowEventListeners = new Map<string, Set<TestWindowListener>>();

const winRef = globalThis.window as typeof globalThis & {
  addEventListener?: (type: string, listener: TestWindowListener) => void;
  removeEventListener?: (type: string, listener: TestWindowListener) => void;
  dispatchEvent?: (ev: TestWindowEvent) => boolean;
};

if (typeof winRef.addEventListener !== 'function') {
  winRef.addEventListener = (type: string, listener: TestWindowListener) => {
    let set = windowEventListeners.get(type);
    if (!set) {
      set = new Set();
      windowEventListeners.set(type, set);
    }
    set.add(listener);
  };
  winRef.removeEventListener = (type: string, listener: TestWindowListener) => {
    windowEventListeners.get(type)?.delete(listener);
  };
  winRef.dispatchEvent = (ev: TestWindowEvent) => {
    const set = windowEventListeners.get(ev.type);
    if (set) {
      // 快照迭代：handler 内自卸订阅安全
      for (const listener of [...set]) {
        try {
          listener(ev);
        } catch {
          /* 单个订阅者抛错不拖垮其余 */
        }
      }
    }
    return true;
  };
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
