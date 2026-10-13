import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  DEFAULT_MAX_CHUNKS,
  DiffChunkCachePool,
  MAX_FILE_TREE_DOM_NODES,
  PrefixFileTreeIndex,
} from './diffChunkCachePool';

function makeChunkLines(chunkIndex: number): string[] {
  const startLine = chunkIndex * CHUNK_SIZE;
  return Array.from(
    { length: CHUNK_SIZE },
    (_, i) => `token-line-${startLine + i}`
  );
}

describe('DiffChunkCachePool (L1 视口锁定 + L2 64行分块 LRU 缓存池)', () => {
  it('按固定 64 行分块存储并精确按行号读取 Token', () => {
    const pool = new DiffChunkCachePool<string>();
    expect(pool.chunkSize).toBe(64);
    expect(pool.maxChunks).toBe(DEFAULT_MAX_CHUNKS);

    pool.putChunk(0, makeChunkLines(0));
    pool.putChunk(2, makeChunkLines(2));

    expect(pool.getLine(0)).toBe('token-line-0');
    expect(pool.getLine(63)).toBe('token-line-63');
    expect(pool.getLine(64)).toBeUndefined();
    expect(pool.getLine(128)).toBe('token-line-128');
    expect(pool.getLine(191)).toBe('token-line-191');
    expect(pool.getLine(-1)).toBeUndefined();
  });

  it('在 10,000 行大文件下锁定当前视口 L1 Chunk 后，灌入大量远端 Chunk 触发 L2 LRU 淘汰时 L1 Chunk 100% 存活', () => {
    const pool = new DiffChunkCachePool<string>(64);
    const totalLines = 10_000;
    const totalChunks = Math.ceil(totalLines / CHUNK_SIZE); // 157 个分块

    // 锁定视口行 [120, 200]，默认预取 overscan = 64 -> 覆盖行 [56, 264]，对应 Chunk 0..4
    const pinned = pool.lockViewportRange(120, 200, 64);
    expect(Array.from(pinned)).toEqual([0, 1, 2, 3, 4]);

    // 先写入当前视口锁定的 L1 分块
    for (const chunkIdx of pinned) {
      pool.putChunk(chunkIdx, makeChunkLines(chunkIdx));
    }

    // 模拟用户在 10,000 行大文件中剧烈跨跳，连续灌入全部远端分块 (Chunk 5..156，共 152 个分块)
    for (let c = 5; c < totalChunks; c++) {
      pool.putChunk(c, makeChunkLines(c));
    }

    // 缓存池总容量严格受控于 64 个 Chunk (4096 行)
    expect(pool.size).toBe(64);

    // 核心断言：锁定的 L1 视口分块 (Chunk 0..4，行 0..319) 100% 存活，零驱逐！
    for (const chunkIdx of pinned) {
      expect(pool.hasChunk(chunkIdx)).toBe(true);
      const startLine = chunkIdx * CHUNK_SIZE;
      for (let line = startLine; line < startLine + CHUNK_SIZE; line++) {
        expect(pool.getLine(line)).toBe(`token-line-${line}`);
      }
    }

    // 早期灌入的未锁定冷分块 (如 Chunk 5..90) 已被按 LRU 淘汰，而最新灌入的尾部冷分块仍在池中
    expect(pool.hasChunk(5)).toBe(false);
    expect(pool.hasChunk(50)).toBe(false);
    expect(pool.hasChunk(totalChunks - 1)).toBe(true);
  });

  it('L2 未锁定分块严格遵循 LRU 顺序淘汰，getLine 命中会刷新分块热度', () => {
    const pool = new DiffChunkCachePool<string>(4);
    pool.lockViewportRange(0, 10, 0); // 仅锁定 Chunk 0
    pool.putChunk(0, makeChunkLines(0));
    pool.putChunk(1, makeChunkLines(1));
    pool.putChunk(2, makeChunkLines(2));
    pool.putChunk(3, makeChunkLines(3));

    // 访问 Chunk 1 的第 65 行，使 Chunk 1 成为最近使用，Chunk 2 成为最旧未锁定分块
    expect(pool.getLine(65)).toBe('token-line-65');

    // 写入新分块 Chunk 4，应淘汰最旧的未锁定分块 Chunk 2，保留锁定的 Chunk 0 及较新的 Chunk 1, 3, 4
    pool.putChunk(4, makeChunkLines(4));
    expect(pool.hasChunk(0)).toBe(true);
    expect(pool.hasChunk(1)).toBe(true);
    expect(pool.hasChunk(2)).toBe(false);
    expect(pool.hasChunk(3)).toBe(true);
    expect(pool.hasChunk(4)).toBe(true);
  });

  it('getMissingChunksInRange 仅返回指定行区间内尚未缓存的 64 行分块索引', () => {
    const pool = new DiffChunkCachePool<string>(64);
    pool.putChunk(1, makeChunkLines(1)); // 覆盖 64..127
    pool.putChunk(3, makeChunkLines(3)); // 覆盖 192..255

    // 查询行区间 [0, 300] (覆盖 Chunk 0..4)，应仅返回缺失的 [0, 2, 4]
    const missing = pool.getMissingChunksInRange(0, 300);
    expect(missing).toEqual([0, 2, 4]);

    // 补齐缺失分块后再次查询应为空数组
    for (const c of missing) {
      pool.putChunk(c, makeChunkLines(c));
    }
    expect(pool.getMissingChunksInRange(0, 300)).toEqual([]);
    expect(pool.getMissingChunksInRange(200, 100)).toEqual([]);
    expect(pool.getMissingChunksInRange(-50, -1)).toEqual([]);
  });
});

describe('PrefixFileTreeIndex (万级文件树纯前缀路径局部增量索引与 <= 60 恒定窗口)', () => {
  function generate10kPaths(): string[] {
    const paths: string[] = [];
    // 构造 10,000 个文件路径：20 个顶层模块 x 10 个子包 x 50 个源码文件
    for (let m = 0; m < 20; m++) {
      const mod = `pkg-${String(m).padStart(2, '0')}`;
      for (let s = 0; s < 10; s++) {
        const sub = `feature-${String(s).padStart(2, '0')}`;
        for (let f = 0; f < 50; f++) {
          paths.push(`${mod}/${sub}/Comp_${f}.tsx`);
        }
      }
    }
    return paths;
  }

  it('在 10,000 个文件路径下支持高效的局部子目录折叠/展开与增量更新', () => {
    const index = new PrefixFileTreeIndex();
    const paths = generate10kPaths();
    expect(paths.length).toBe(10_000);

    const initialVisible = index.upsertPaths(paths);
    // 20 个顶层目录 + 200 个二级目录 + 10,000 个文件 = 10,220 个可见节点
    expect(initialVisible).toBe(10_220);

    // 局部折叠二级目录 'pkg-05/feature-03'（包含 50 个文件）
    const tCollapseStart = performance.now();
    const afterCollapseState = index.toggleFolder('pkg-05/feature-03');
    const collapseElapsedMs = performance.now() - tCollapseStart;

    expect(afterCollapseState).toBe(false);
    expect(index.visibleCount).toBe(10_220 - 50);
    expect(collapseElapsedMs).toBeLessThan(15);

    // 局部重新展开 'pkg-05/feature-03'，恢复 50 个文件切片
    const tExpandStart = performance.now();
    const afterExpandState = index.toggleFolder('pkg-05/feature-03');
    const expandElapsedMs = performance.now() - tExpandStart;

    expect(afterExpandState).toBe(true);
    expect(index.visibleCount).toBe(10_220);
    expect(expandElapsedMs).toBeLessThan(15);

    // 局部折叠顶层大目录 'pkg-00'（包含 10 个子目录 + 500 个文件 = 510 个后代节点）
    index.toggleFolder('pkg-00', false);
    expect(index.visibleCount).toBe(10_220 - 510);

    // 局部增量插入新文件到已展开目录 'pkg-05/feature-03'
    index.upsertPaths(['pkg-05/feature-03/NewWidget.tsx']);
    expect(index.visibleCount).toBe(10_220 - 510 + 1);

    // 局部前缀删除整个 'pkg-05/feature-03'（1 个目录自身 + 51 个文件 = 52 个可见节点）
    const removedCount = index.removePrefix('pkg-05/feature-03');
    expect(removedCount).toBe(52);
    expect(index.visibleCount).toBe(10_220 - 510 + 1 - 52);
  });

  it('getVisibleSlice 在任意滚动位置与超大视口下返回的 DOM 节点数严格 <= 60', () => {
    const index = new PrefixFileTreeIndex();
    index.upsertPaths(generate10kPaths());

    // 常规视口 (800px 高，28px 行高 -> 约 29 行可见 + 上下 overscan)
    const sliceTop = index.getVisibleSlice(0, 800, 28, 60);
    expect(sliceTop.length).toBeLessThanOrEqual(MAX_FILE_TREE_DOM_NODES);
    expect(sliceTop.items.length).toBeLessThanOrEqual(60);
    expect(sliceTop.startIndex).toBe(0);
    expect(sliceTop[0].path).toBe('pkg-00');

    // 中部滚动位置
    const sliceMid = index.getVisibleSlice(50_000, 900, 28, 60);
    expect(sliceMid.length).toBeLessThanOrEqual(60);
    expect(sliceMid.offsetTop).toBe(sliceMid.startIndex * 28);
    expect(sliceMid.totalHeight).toBe(10_220 * 28);

    // 极端超大视口 (例如 4K 全屏高度 3200px，即便调用方传入 maxDomNodes = 200 也必须被硬上限钳制在 <= 60)
    const sliceHugeViewport = index.getVisibleSlice(10_000, 3200, 28, 200);
    expect(sliceHugeViewport.length).toBe(60);
    expect(sliceHugeViewport.items.length).toBeLessThanOrEqual(60);

    // 底部边界滚动位置
    const sliceBottom = index.getVisibleSlice(999_999, 1200, 28, 60);
    expect(sliceBottom.length).toBeLessThanOrEqual(60);
    expect(sliceBottom.endIndex).toBe(10_220);
  });
});
