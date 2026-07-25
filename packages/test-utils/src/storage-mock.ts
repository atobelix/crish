/**
 * Storage mock 工厂 — 统一 localStorage / sessionStorage 测试替身
 *
 * 解决问题：12+ 测试文件各自 vi.hoisted 重复定义 Storage mock，接口不一致。
 *
 * 用法：
 *   import { createStorageMock, installBrowserStorageMocks } from "@crish/test-utils";
 *
 *   // 方式 1：手动创建并安装到 globalThis
 *   installBrowserStorageMocks();
 *
 *   // 方式 2：获取 mock 实例用于断言
 *   const mock = createStorageMock();
 *   globalThis.localStorage = mock;
 *
 *   // 方式 3：带 spy 的 mock（需要 vitest）
 *   import { vi } from "vitest";
 *   const spy = createStorageSpyMock(vi);
 *   expect(spy.setItem).toHaveBeenCalledTimes(1);
 */

/**
 * vitest 的 vi 子集类型，避免直接 import vitest（保持包零运行时依赖）。
 * 仅约束测试代码会用到的 fn 签名。
 */
export interface ViFnLike {
  fn: <T extends (...args: any[]) => any>(impl: T) => T & {
    mock: { calls: any[][] };
    mockClear(): void;
    mockReset(): void;
    mockRestore(): void;
  };
}

/**
 * 创建一个符合 Storage 接口的 mock 实例。
 * 使用 Map 存储，支持 getItem/setItem/removeItem/clear/key/length。
 */
export function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    key(index: number): string | null {
      if (index < 0 || index >= store.size) return null;
      return Array.from(store.keys())[index]!;
    },
    get length(): number {
      return store.size;
    },
  };
}

/**
 * 创建一个带 vi.fn() spy 的 Storage mock，用于断言调用次数。
 * @param vi 从测试文件传入的 vitest `vi` 对象（避免本包硬依赖 vitest）
 */
export function createStorageSpyMock(vi: ViFnLike): Storage {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string): string | null => (store.has(key) ? store.get(key)! : null)),
    setItem: vi.fn((key: string, value: string): void => {
      store.set(key, String(value));
    }),
    removeItem: vi.fn((key: string): void => {
      store.delete(key);
    }),
    clear: vi.fn((): void => {
      store.clear();
    }),
    key: vi.fn((index: number): string | null => {
      if (index < 0 || index >= store.size) return null;
      return Array.from(store.keys())[index]!;
    }),
    get length(): number {
      return store.size;
    },
  };
}

/**
 * 一次性安装 localStorage + sessionStorage mock 到 globalThis。
 * 适用于 test-setup.ts 全局调用，让所有测试共享。
 */
export function installBrowserStorageMocks(): void {
  if (!globalThis.localStorage) {
    globalThis.localStorage = createStorageMock();
  }
  if (!globalThis.sessionStorage) {
    globalThis.sessionStorage = createStorageMock();
  }
}
