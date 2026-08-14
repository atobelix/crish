import { describe, it, expect, beforeEach } from 'vitest';
import { DomPinningRegistry } from './domPinning';

describe('DomPinningRegistry', () => {
  let registry: DomPinningRegistry;

  beforeEach(() => {
    registry = new DomPinningRegistry();
  });

  it('初始状态无锁定的块', () => {
    expect(registry.size()).toBe(0);
    expect(registry.isPinned('blk-1')).toBe(false);
    expect([...registry.getPinned()]).toEqual([]);
  });

  it('pin 与 unpin 操作正常记录并维护状态', () => {
    registry.pin('blk-1');
    registry.pin('blk-2');

    expect(registry.size()).toBe(2);
    expect(registry.isPinned('blk-1')).toBe(true);
    expect(registry.isPinned('blk-2')).toBe(true);
    expect(registry.isPinned('blk-3')).toBe(false);

    registry.unpin('blk-1');
    expect(registry.size()).toBe(1);
    expect(registry.isPinned('blk-1')).toBe(false);
    expect(registry.isPinned('blk-2')).toBe(true);
  });

  it('filterSafeRemovals 将锁定块置入 deferredRemovals，未锁定块置入 safeRemovals', () => {
    registry.pin('blk-pinned-1');
    registry.pin('blk-pinned-2');

    const candidates = [
      'blk-pinned-1',
      'blk-safe-1',
      'blk-safe-2',
      'blk-pinned-2',
      'blk-safe-3',
    ];
    const result = registry.filterSafeRemovals(candidates);

    expect(result.safeRemovals).toEqual([
      'blk-safe-1',
      'blk-safe-2',
      'blk-safe-3',
    ]);
    expect(result.deferredRemovals).toEqual(['blk-pinned-1', 'blk-pinned-2']);
  });

  it('filterSafeUnmounts 针对对象项正确分离 allowed 与 retained', () => {
    registry.pin('blk-1');

    const items = [
      { id: 'blk-1', name: 'Active block' },
      { id: 'blk-2', name: 'Inactive block' },
    ];

    const result = registry.filterSafeUnmounts(items);
    expect(result.retained).toEqual([{ id: 'blk-1', name: 'Active block' }]);
    expect(result.allowed).toEqual([{ id: 'blk-2', name: 'Inactive block' }]);
  });

  it('clear 成功清除所有锁定块', () => {
    registry.pin('blk-1');
    registry.pin('blk-2');
    expect(registry.size()).toBe(2);

    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.isPinned('blk-1')).toBe(false);
  });
});
