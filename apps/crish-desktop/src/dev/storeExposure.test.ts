import { afterEach, describe, expect, it } from 'vitest';
import { exposeStoresForDev } from './storeExposure';

const FAKE_STORE = { getState: () => ({}) };

function cleanup(): void {
  delete (window as Record<string, unknown>).__CRISH_STORE__;
  delete (window as Record<string, unknown>).__CRISH_SESSION_STORE__;
  delete (window as Record<string, unknown>).__CRISH_LAYOUT_STORE__;
  delete (window as Record<string, unknown>).__CRISH_TREE_STORE__;
}

describe('exposeStoresForDev（X-03 生产不暴露 window 全局）', () => {
  afterEach(cleanup);

  it('DEV=true 时挂载全部 store 全局', () => {
    exposeStoresForDev(
      {
        __CRISH_STORE__: FAKE_STORE,
        __CRISH_SESSION_STORE__: FAKE_STORE,
        __CRISH_LAYOUT_STORE__: FAKE_STORE,
        __CRISH_TREE_STORE__: FAKE_STORE,
      },
      true,
    );
    expect((window as Record<string, unknown>).__CRISH_STORE__).toBe(FAKE_STORE);
    expect((window as Record<string, unknown>).__CRISH_TREE_STORE__).toBe(FAKE_STORE);
  });

  it('DEV=false（生产构建）时不写入任何 window 全局', () => {
    exposeStoresForDev(
      {
        __CRISH_STORE__: FAKE_STORE,
        __CRISH_SESSION_STORE__: FAKE_STORE,
        __CRISH_LAYOUT_STORE__: FAKE_STORE,
        __CRISH_TREE_STORE__: FAKE_STORE,
      },
      false,
    );
    expect((window as Record<string, unknown>).__CRISH_STORE__).toBeUndefined();
    expect((window as Record<string, unknown>).__CRISH_SESSION_STORE__).toBeUndefined();
    expect((window as Record<string, unknown>).__CRISH_LAYOUT_STORE__).toBeUndefined();
    expect((window as Record<string, unknown>).__CRISH_TREE_STORE__).toBeUndefined();
  });

  it('DEV=false 时保留既有 window 全局不被覆盖', () => {
    (window as Record<string, unknown>).__CRISH_STORE__ = 'existing';
    exposeStoresForDev({ __CRISH_STORE__: FAKE_STORE }, false);
    expect((window as Record<string, unknown>).__CRISH_STORE__).toBe('existing');
  });
});
