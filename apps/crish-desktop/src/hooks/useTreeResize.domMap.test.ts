// @vitest-environment jsdom
/**
 * S4.3 — live resize DOM map 扫描与缓存清理。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  collectLiveResizeDomMap,
  clearLiveResizeDomCache,
} from './useTreeResize';

describe('useTreeResize live DOM map (S4.3)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    clearLiveResizeDomCache();
  });

  it('collectLiveResizeDomMap 按 data-leaf-id / data-branch-id 建表', () => {
    document.body.innerHTML = `
      <div data-tree-canvas="true">
        <div data-leaf-id="leaf-a"></div>
        <div data-leaf-id="leaf-b"></div>
        <div data-branch-id="br-1"></div>
      </div>
    `;
    const map = collectLiveResizeDomMap();
    expect(map.leaves.size).toBe(2);
    expect(map.branches.size).toBe(1);
    expect(map.leaves.get('leaf-a')?.getAttribute('data-leaf-id')).toBe(
      'leaf-a'
    );
    expect(map.branches.get('br-1')?.getAttribute('data-branch-id')).toBe(
      'br-1'
    );
  });

  it('clearLiveResizeDomCache 可安全重复调用', () => {
    expect(() => {
      clearLiveResizeDomCache();
      clearLiveResizeDomCache();
    }).not.toThrow();
  });
});
