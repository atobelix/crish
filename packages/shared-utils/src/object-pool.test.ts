import { describe, expect, it, vi } from 'vitest';
import { ObjectPool } from './object-pool';

describe('ObjectPool', () => {
  it('池空时 acquire 调用 factory 新建', () => {
    const factory = vi.fn(() => ({ v: 0 }));
    const pool = new ObjectPool(factory, () => {});
    const a = pool.acquire();
    const b = pool.acquire();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
    expect(pool.size).toBe(0);
  });

  it('release 先 reset 再入池，acquire 复用同一实例（LIFO）', () => {
    const factory = vi.fn(() => ({ v: 0 }));
    const pool = new ObjectPool(factory, (o) => {
      o.v = 0;
    });
    const a = pool.acquire();
    const b = pool.acquire();
    a.v = 5;
    b.v = 9;
    pool.release(a);
    pool.release(b);
    expect(pool.size).toBe(2);
    expect(a.v).toBe(0);
    expect(b.v).toBe(0);
    expect(pool.acquire()).toBe(b);
    expect(pool.acquire()).toBe(a);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('超过 maxSize 的对象被 reset 但丢弃，不无限增长', () => {
    const reset = vi.fn();
    const pool = new ObjectPool(() => ({}), reset, 2);
    pool.release({});
    pool.release({});
    pool.release({});
    expect(reset).toHaveBeenCalledTimes(3);
    expect(pool.size).toBe(2);
  });

  it('默认 maxSize 为 100；clear 清空池', () => {
    const pool = new ObjectPool(
      () => ({}),
      () => {}
    );
    for (let i = 0; i < 150; i++) pool.release({});
    expect(pool.size).toBe(100);
    pool.clear();
    expect(pool.size).toBe(0);
  });

  it('maxSize=0 时永不缓存', () => {
    const factory = vi.fn(() => ({}));
    const pool = new ObjectPool(factory, () => {}, 0);
    pool.release(pool.acquire());
    expect(pool.size).toBe(0);
    pool.acquire();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
