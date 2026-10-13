// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  DEFAULT_FILE_TREE_ROW_HEIGHT,
  FILE_TREE_COLLATOR,
  MAX_FILE_TREE_DOM_NODES,
  PrefixFileTreeIndex,
  getVisibleSlice,
} from './prefixFileTreeIndex';
import {
  useFileNavigation,
  sortFsDirEntries,
} from '../hooks/useFileNavigation';
import * as workspaceFsApi from '../api/workspaceFsApi';
import * as projectStore from '../api/projectStore';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function generatePaths(
  moduleCount: number,
  subCount: number,
  fileCount: number
): string[] {
  const paths: string[] = [];
  for (let m = 0; m < moduleCount; m++) {
    const mod = `pkg-${String(m).padStart(2, '0')}`;
    for (let s = 0; s < subCount; s++) {
      const sub = `feature-${String(s).padStart(2, '0')}`;
      for (let f = 0; f < fileCount; f++) {
        paths.push(`${mod}/${sub}/Comp_${f}.tsx`);
      }
    }
  }
  return paths;
}

describe('PrefixFileTreeIndex 纯前缀局部变异索引与 <= 60 DOM 刚性门禁', () => {
  it('使用全局单例 FILE_TREE_COLLATOR 按目录优先与自然数字序排序', () => {
    const index = new PrefixFileTreeIndex();
    index.upsertPaths([
      'src/file10.ts',
      'src/file2.ts',
      'src/components/Button.tsx',
      'src/.hidden',
      'README.md',
    ]);

    const flat = index.getFlatNodes();
    expect(flat[0]?.path).toBe('src');
    expect(flat[0]?.kind).toBe('directory');
    expect(flat[1]?.path).toBe('src/components');
    expect(flat[2]?.path).toBe('src/components/Button.tsx');
    expect(flat[3]?.path).toBe('src/file2.ts');
    expect(flat[4]?.path).toBe('src/file10.ts');
    expect(flat[5]?.path).toBe('src/.hidden');
    expect(flat[6]?.path).toBe('README.md');
    expect(FILE_TREE_COLLATOR.compare('file2.ts', 'file10.ts')).toBeLessThan(0);
  });

  it('在 10,000 个文件路径下支持 O(depth + K) 局部展开与 O(M) 连续区间截除', () => {
    const index = new PrefixFileTreeIndex();
    const paths = generatePaths(20, 10, 50); // 10,000 files
    expect(paths.length).toBe(10_000);

    const initialVisible = index.upsertPaths(paths);
    expect(initialVisible).toBe(10_220);

    const t0 = performance.now();
    const collapsed = index.toggleFolder('pkg-05/feature-03');
    const collapseMs = performance.now() - t0;
    expect(collapsed).toBe(false);
    expect(index.visibleCount).toBe(10_220 - 50);
    expect(collapseMs).toBeLessThan(1.2);

    const t1 = performance.now();
    const expanded = index.toggleFolder('pkg-05/feature-03');
    const expandMs = performance.now() - t1;
    expect(expanded).toBe(true);
    expect(index.visibleCount).toBe(10_220);
    expect(expandMs).toBeLessThan(1.2);

    // 增量添加与前缀移除
    index.upsertPaths(['pkg-05/feature-03/NewView.tsx']);
    expect(index.visibleCount).toBe(10_221);

    const removed = index.removePrefix('pkg-05/feature-03');
    expect(removed).toBe(52);
    expect(index.visibleCount).toBe(10_221 - 52);
  });

  it('getVisibleSlice 在任意视口高度与传入上限下刚性钳制挂载 DOM 节点数 <= 60', () => {
    const index = new PrefixFileTreeIndex();
    index.upsertPaths(generatePaths(20, 10, 50));

    const sliceNormal = index.getVisibleSlice(
      0,
      800,
      DEFAULT_FILE_TREE_ROW_HEIGHT,
      MAX_FILE_TREE_DOM_NODES
    );
    expect(sliceNormal.length).toBeLessThanOrEqual(60);
    expect(sliceNormal.items.length).toBeLessThanOrEqual(60);

    // 4K 超大视口 + 传入 maxDomNodes = 500，依然刚性 <= 60
    const sliceExtreme = getVisibleSlice(
      index.getFlatNodes(),
      12000,
      4000,
      28,
      500
    );
    expect(sliceExtreme.length).toBe(60);
    expect(sliceExtreme.items.length).toBe(60);
    expect(sliceExtreme.offsetTop).toBe(sliceExtreme.startIndex * 28);
  });

  it('【DEVIL-07-3】50,000 个文件巨型工程极速连击折叠与展开（单次 <= 1.2ms，活跃 DOM <= 60）', () => {
    // 构造 50,000 个工程文件：50 个顶层模块 x 20 个子包 x 50 个源码文件
    const index = new PrefixFileTreeIndex({ defaultExpanded: false });
    const paths = generatePaths(50, 20, 50);
    expect(paths.length).toBe(50_000);
    index.upsertPaths(paths);

    // 先展开前 10 个顶层模块及其子包以构建真实多级活跃树
    for (let m = 0; m < 10; m++) {
      const mod = `pkg-${String(m).padStart(2, '0')}`;
      index.toggleFolder(mod, true);
      for (let s = 0; s < 5; s++) {
        index.toggleFolder(
          `${mod}/feature-${String(s).padStart(2, '0')}`,
          true
        );
      }
    }

    // 预热 JIT
    index.toggleFolder('pkg-00/feature-00', false);
    index.toggleFolder('pkg-00/feature-00', true);

    const targets = [
      'pkg-01/feature-01',
      'pkg-01/feature-02',
      'pkg-02/feature-00',
      'pkg-02/feature-03',
      'pkg-03/feature-01',
      'pkg-03/feature-04',
      'pkg-04/feature-02',
      'pkg-05/feature-00',
      'pkg-06/feature-01',
      'pkg-07/feature-03',
    ];

    const durations: number[] = [];
    // 连续高速执行 20 次展开与折叠（10 次折叠 + 10 次展开）
    for (const target of targets) {
      const tCollapse = performance.now();
      const afterCollapse = index.toggleFolder(target, false);
      durations.push(performance.now() - tCollapse);
      expect(afterCollapse).toBe(false);

      const sliceDuringCollapse = index.getVisibleSlice(1400, 1080, 28, 60);
      expect(sliceDuringCollapse.length).toBeLessThanOrEqual(60);

      const tExpand = performance.now();
      const afterExpand = index.toggleFolder(target, true);
      durations.push(performance.now() - tExpand);
      expect(afterExpand).toBe(true);

      const sliceDuringExpand = index.getVisibleSlice(2800, 1080, 28, 60);
      expect(sliceDuringExpand.length).toBeLessThanOrEqual(60);
    }

    expect(durations.length).toBe(20);
    for (const d of durations) {
      expect(d).toBeLessThanOrEqual(1.2);
    }
  });

  it('useFileNavigation 接入 PrefixFileTreeIndex 与局部 splice 变异及 <= 60 切片', async () => {
    vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/repo');
    vi.spyOn(workspaceFsApi, 'resolveWorkspacePath').mockImplementation((p) =>
      p.replace(/\\/g, '/')
    );
    vi.spyOn(workspaceFsApi, 'listDirectory').mockImplementation(
      async (dir) => {
        const norm = dir.replace(/\\/g, '/').toLowerCase();
        if (norm === 'c:/repo') {
          return [
            { name: 'src', path: 'C:/repo/src', isDir: true },
            {
              name: 'package.json',
              path: 'C:/repo/package.json',
              isDir: false,
            },
          ];
        }
        if (norm === 'c:/repo/src') {
          return Array.from({ length: 80 }, (_, i) => ({
            name: `File_${i}.ts`,
            path: `C:/repo/src/File_${i}.ts`,
            isDir: false,
          }));
        }
        return [];
      }
    );

    const { result } = renderHook(() => useFileNavigation());

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.flatTree.length).toBe(2);

    // 展开 src 目录（触发 O(depth + K) 局部 splice 注入）
    await act(async () => {
      await result.current.toggleExpand('C:/repo/src');
    });
    expect(result.current.flatTree.length).toBe(82);

    // 验证 getVisibleSlice 严格限制返回 <= 60 个节点
    const visibleSlice = result.current.getVisibleSlice(0, 1200, 28, 100);
    expect(visibleSlice.length).toBeLessThanOrEqual(60);

    // 折叠 src 目录（触发 O(M) 连续区间截除）
    await act(async () => {
      await result.current.toggleExpand('C:/repo/src');
    });
    expect(result.current.flatTree.length).toBe(2);

    // 验证 WeakMap 排序缓存复用
    const rawEntries: workspaceFsApi.FsDirEntry[] = [
      { name: 'b.ts', path: 'c:/repo/b.ts', isDir: false },
      { name: 'a.ts', path: 'c:/repo/a.ts', isDir: false },
    ];
    const sorted1 = sortFsDirEntries(rawEntries);
    const sorted2 = sortFsDirEntries(rawEntries);
    expect(sorted1).toBe(sorted2);
    expect(sorted1[0]?.name).toBe('a.ts');
  });
});
