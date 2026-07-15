/**
 * Node vitest 环境补齐 browser 全局，避免 seed layoutStore 时 localStorage 缺失。
 */
const mem = new Map<string, string>();

const localStorageMock = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => {
    mem.set(k, String(v));
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
  clear: () => {
    mem.clear();
  },
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};

// @ts-expect-error test env
globalThis.localStorage = localStorageMock;
// @ts-expect-error test env  
if (typeof globalThis.window === 'undefined') {
  // @ts-expect-error test env
  globalThis.window = globalThis;
}
