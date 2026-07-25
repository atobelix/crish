// @vitest-environment jsdom
/**
 * useVirtualScroll wiring / phase tests (R8-List-SyncLayout + R8-List-RegressionTests).
 *
 * H1: ids→syncOrder runs in layout phase (useLayoutEffect), not paint-after useEffect.
 * H2: ids change calls syncOrder and never clear; ChatMessageList has no startIndex→clearHeights Effect.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVirtualScroll } from './useVirtualScroll';

const here =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

describe('useVirtualScroll — ids→syncOrder (layout phase, no clear)', () => {
  it('expand / window pan: ids change syncs order and retains heights without clear', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['m2', 'm3', 'm4'], itemCount: 3 } },
    );

    // Seed measured heights for the current window
    result.current.manager.setActual('m2', 200);
    result.current.manager.setActual('m3', 300);
    result.current.manager.setActual('m4', 400);

    expect(result.current.manager.getOrder()).toEqual(['m2', 'm3', 'm4']);
    expect(result.current.manager.getHeight('m2')).toBe(200);

    const clearSpy = vi.spyOn(result.current.manager, 'clear');
    const syncSpy = vi.spyOn(result.current.manager, 'syncOrder');

    // expand older: prepend m0,m1 — contract: syncOrder only, never clear
    const expanded = ['m0', 'm1', 'm2', 'm3', 'm4'];
    rerender({ ids: expanded, itemCount: 5 });

    expect(syncSpy).toHaveBeenCalled();
    expect(syncSpy.mock.calls.some((c) => c[0] === expanded || equalArr(c[0], expanded))).toBe(
      true,
    );
    expect(clearSpy).not.toHaveBeenCalled();

    // Layout phase completed: order length === ids.length === itemCount
    expect(result.current.manager.getOrder()).toEqual(expanded);
    expect(result.current.manager.getOrder().length).toBe(5);
    expect(result.current.manager.getOrder().length).toBe(expanded.length);

    // Same-id heights retained across pan
    expect(result.current.manager.getHeight('m2')).toBe(200);
    expect(result.current.manager.getHeight('m3')).toBe(300);
    expect(result.current.manager.getHeight('m4')).toBe(400);
    expect(result.current.manager.hasHeight('m2')).toBe(true);

    // totalHeight reflects new order (fallback for unmeasured prepends)
    expect(result.current.totalHeight).toBe(100 + 100 + 200 + 300 + 400);

    clearSpy.mockRestore();
    syncSpy.mockRestore();
  });

  it('repeated identical ids is safe (StrictMode-style double sync)', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 80 }),
      { initialProps: { ids: ['a', 'b'], itemCount: 2 } },
    );

    result.current.manager.setActual('a', 50);
    result.current.manager.setActual('b', 60);

    // Same content, new array reference (simulates parent re-memo miss / remount path)
    rerender({ ids: ['a', 'b'], itemCount: 2 });
    act(() => {
      result.current.syncOrder(['a', 'b']);
      result.current.syncOrder(['a', 'b']);
    });

    expect(result.current.manager.getOrder()).toEqual(['a', 'b']);
    expect(result.current.manager.getHeight('a')).toBe(50);
    expect(result.current.manager.getHeight('b')).toBe(60);
  });

  it('syncOrder called on ids change; clear NOT called during window pan', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['a', 'b'], itemCount: 2 } },
    );

    const clearSpy = vi.spyOn(result.current.manager, 'clear');
    const syncSpy = vi.spyOn(result.current.manager, 'syncOrder');
    clearSpy.mockClear();
    syncSpy.mockClear();

    // ids 变化 → syncOrder 被调用
    rerender({ ids: ['a', 'b', 'c'], itemCount: 3 });
    expect(syncSpy).toHaveBeenCalled();
    // 仅会话切换时 clear，窗口平移禁止 clear
    expect(clearSpy).not.toHaveBeenCalled();

    clearSpy.mockRestore();
    syncSpy.mockRestore();
  });

  it('syncOrder NOT called when ids array reference unchanged', () => {
    const stableIds = ['a', 'b'];
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: stableIds, itemCount: 2 } },
    );

    const syncSpy = vi.spyOn(result.current.manager, 'syncOrder');
    syncSpy.mockClear(); // clear the initial render call

    // Same array reference → useLayoutEffect deps [manager, ids] unchanged → skip
    rerender({ ids: stableIds, itemCount: 2 });
    expect(syncSpy).not.toHaveBeenCalled();

    syncSpy.mockRestore();
  });

  it('clearHeights empties order; subsequent ids sync restores without leaking clear into pan', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['s1-m0', 's1-m1'], itemCount: 2 } },
    );

    result.current.manager.setActual('s1-m0', 110);
    act(() => {
      result.current.clearHeights();
    });
    expect(result.current.manager.getOrder()).toEqual([]);
    expect(result.current.manager.hasHeight('s1-m0')).toBe(false);

    // Session switch style: new ids after clear
    const next = ['s2-m0', 's2-m1', 's2-m2'];
    rerender({ ids: next, itemCount: 3 });
    expect(result.current.manager.getOrder()).toEqual(next);
    expect(result.current.manager.getOrder().length).toBe(3);
  });
});

describe('useVirtualScroll source — layout phase lock', () => {
  it('auto ids→syncOrder uses useLayoutEffect (not paint-after useEffect)', () => {
    const src = readFileSync(resolve(here, './useVirtualScroll.ts'), 'utf8').replace(/\r\n/g, '\n');

    // Positive: layout-phase auto sync block
    expect(src).toMatch(
      /useLayoutEffect\(\(\)\s*=>\s*\{[\s\S]*?manager\.syncOrder\(ids\)[\s\S]*?\},\s*\[manager,\s*ids\]\)/,
    );

    // Negative: do not use useEffect for manager.syncOrder(ids)
    const useEffectBlocks = src.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[[^\]]*?\]\)/g) ?? [];
    for (const block of useEffectBlocks) {
      expect(block.includes('manager.syncOrder')).toBe(false);
    }
  });
});

describe('ChatMessageList height lifecycle contract (static source)', () => {
  it('has no startIndex + clearHeights wired in the same Effect', () => {
    const src = readFileSync(
      resolve(here, '../components/ChatMessageList.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    // Remove comments to avoid false positive comment matches
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

    // Forbid clearHeights appearing in an effect body/deps window with messageWindow.startIndex
    const effectBlocks = codeOnly.match(/use(?:Layout)?Effect\([\s\S]*?\);\s*\n/g) ?? [];
    for (const block of effectBlocks) {
      const hasClear = block.includes('clearHeights');
      const hasStartIndex = block.includes('startIndex');
      expect(hasClear && hasStartIndex).toBe(false);
    }

    // No effect dependency array listing both startIndex and clearHeights
    const effectCallRegex = /use(?:Layout)?Effect\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*(\[[^\]]*?\])\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = effectCallRegex.exec(codeOnly)) !== null) {
      const depArrayStr = match[1] ?? '';
      const hasClear = depArrayStr.includes('clearHeights');
      const hasStartIndex = depArrayStr.includes('startIndex');
      expect(hasClear && hasStartIndex).toBe(false);
    }

    // Positive lock: session switch still clears heights
    expect(src).toMatch(/activeSessionId[\s\S]{0,300}?clearHeights/);
    // Positive lock: window pan / expand relies on syncOrder (comment or hook path)
    expect(src).toMatch(/syncOrder/);
  });
});

function equalArr(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}
