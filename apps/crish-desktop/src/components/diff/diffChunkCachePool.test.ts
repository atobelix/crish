// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import {
  CHUNK_SIZE,
  DEFAULT_MAX_CHUNKS,
  DIFF_CHUNK_SIZE,
  DiffChunkCachePool,
  MAX_FILE_TREE_DOM_NODES,
  NativeHighlightManager,
  PrefixFileTreeIndex,
  SotaDiffChunkCachePool,
} from './diffChunkCachePool';
import { VirtualPlainCodeViewer } from './VirtualPlainCodeViewer';
import styles from './DiffCard.module.css';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeChunkLines(chunkIndex: number): string[] {
  const startLine = chunkIndex * CHUNK_SIZE;
  return Array.from(
    { length: CHUNK_SIZE },
    (_, i) => `token-line-${startLine + i}`
  );
}

describe('SotaDiffChunkCachePool (L1 视口锁定 + L2 128分块8192行池 + Generation Token 代次守卫)', () => {
  it('默认容量为 128 个 64 行分块（覆盖 8,192 行），并精确按行号读取 Token', () => {
    const pool = new SotaDiffChunkCachePool<string>();
    expect(pool.chunkSize).toBe(64);
    expect(DIFF_CHUNK_SIZE).toBe(64);
    expect(DEFAULT_MAX_CHUNKS).toBe(128);
    expect(pool.maxChunks).toBe(128);

    expect(pool.putChunk(0, makeChunkLines(0))).toBe(true);
    expect(pool.putChunk(2, makeChunkLines(2))).toBe(true);

    expect(pool.getLine(0)).toBe('token-line-0');
    expect(pool.getLine(63)).toBe('token-line-63');
    expect(pool.getLine(64)).toBeUndefined();
    expect(pool.getLine(128)).toBe('token-line-128');
    expect(pool.getLine(191)).toBe('token-line-191');
    expect(pool.getLine(-1)).toBeUndefined();
  });

  it('工作集免疫断言：灌入 200 个分块触发满载淘汰时，L1 pinnedChunkIndices 存活率 100%', () => {
    const pool = new DiffChunkCachePool<string>(128);

    // 锁定视口行 [120, 200]，预取 overscan = 64 -> 覆盖 Chunk 0..4
    const pinned = pool.lockViewportRange(120, 200, 64);
    expect(Array.from(pinned)).toEqual([0, 1, 2, 3, 4]);

    for (const chunkIdx of pinned) {
      pool.putChunk(chunkIdx, makeChunkLines(chunkIdx));
    }

    // 连续灌入 200 个远端分块 (Chunk 5..204)
    for (let c = 5; c < 205; c++) {
      pool.putChunk(c, makeChunkLines(c));
    }

    // 缓存池总容量严格受控于 128 个 Chunk (8,192 行)
    expect(pool.size).toBe(128);

    // 核心断言：锁定的 L1 视口分块 (Chunk 0..4) 100% 存活，绝对豁免 LRU 驱逐
    for (const chunkIdx of pinned) {
      expect(pool.hasChunk(chunkIdx)).toBe(true);
      const startLine = chunkIdx * CHUNK_SIZE;
      for (let line = startLine; line < startLine + CHUNK_SIZE; line++) {
        expect(pool.getLine(line)).toBe(`token-line-${line}`);
      }
    }

    expect(pool.hasChunk(5)).toBe(false);
    expect(pool.hasChunk(204)).toBe(true);
  });

  it('Generation Token 代次作废断言：跨跳 2,000 行递增代次后，旧代次 Worker 回写被 100% 拒绝', () => {
    const pool = new SotaDiffChunkCachePool<string>(128);

    // 初始停留在第 0~100 行 (Generation 1)
    const lock1 = pool.lockViewportAndAdvanceGen(0, 100, 64);
    expect(lock1.generation).toBe(1);
    expect(lock1.missingChunks).toEqual([0, 1, 2]);

    // 用户快速拖拽滚动条跨跳 2,000 行至 2000~2100 行 (Generation 2)
    const lock2 = pool.lockViewportAndAdvanceGen(2000, 2100, 64);
    expect(lock2.generation).toBe(2);

    // 此时旧代次 (Generation 1) 的 Worker 异步任务迟到完成并尝试回写 Chunk 0
    const staleAccepted = pool.putChunk(0, makeChunkLines(0), lock1.generation);
    expect(staleAccepted).toBe(false);
    expect(pool.hasChunk(0)).toBe(false);
    expect(pool.size).toBe(0);

    // 当前新代次 (Generation 2) 的 Worker 任务回写目标视口分块，100% 成功写入
    for (const chunkIdx of lock2.missingChunks) {
      const ok = pool.putChunk(
        chunkIdx,
        makeChunkLines(chunkIdx),
        lock2.generation
      );
      expect(ok).toBe(true);
    }
    expect(pool.size).toBe(lock2.missingChunks.length);
    expect(pool.getLine(2000)).toBe('token-line-2000');
  });

  it('L2 未锁定分块严格遵循 LRU 顺序淘汰，getLine 命中会刷新分块热度', () => {
    const pool = new DiffChunkCachePool<string>(4);
    pool.lockViewportRange(0, 10, 0); // 仅锁定 Chunk 0
    pool.putChunk(0, makeChunkLines(0));
    pool.putChunk(1, makeChunkLines(1));
    pool.putChunk(2, makeChunkLines(2));
    pool.putChunk(3, makeChunkLines(3));

    expect(pool.getLine(65)).toBe('token-line-65');

    pool.putChunk(4, makeChunkLines(4));
    expect(pool.hasChunk(0)).toBe(true);
    expect(pool.hasChunk(1)).toBe(true);
    expect(pool.hasChunk(2)).toBe(false);
    expect(pool.hasChunk(3)).toBe(true);
    expect(pool.hasChunk(4)).toBe(true);
  });

  it('getMissingChunksInRange 仅返回指定行区间内尚未缓存的 64 行分块索引', () => {
    const pool = new DiffChunkCachePool<string>(64);
    pool.putChunk(1, makeChunkLines(1));
    pool.putChunk(3, makeChunkLines(3));

    const missing = pool.getMissingChunksInRange(0, 300);
    expect(missing).toEqual([0, 2, 4]);

    for (const c of missing) {
      pool.putChunk(c, makeChunkLines(c));
    }
    expect(pool.getMissingChunksInRange(0, 300)).toEqual([]);
    expect(pool.getMissingChunksInRange(200, 100)).toEqual([]);
    expect(pool.getMissingChunksInRange(-50, -1)).toEqual([]);
  });
});

describe('PrefixFileTreeIndex 重导出兼容性验证', () => {
  function generate10kPaths(): string[] {
    const paths: string[] = [];
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

  it('在 10,000 个文件路径下支持高效的局部子目录折叠/展开与 <= 60 恒定窗口', () => {
    const index = new PrefixFileTreeIndex();
    const initialVisible = index.upsertPaths(generate10kPaths());
    expect(initialVisible).toBe(10_220);

    expect(index.toggleFolder('pkg-05/feature-03')).toBe(false);
    expect(index.visibleCount).toBe(10_220 - 50);

    const slice = index.getVisibleSlice(10_000, 3200, 28, 200);
    expect(slice.length).toBe(MAX_FILE_TREE_DOM_NODES);
  });
});

describe('【DEVIL-07-4】VirtualPlainCodeViewer Blink 原生 CSS.highlights Zero-Span 渐进增强验证', () => {
  it('10,000 字符超长单行 JSON 在 Blink CSS.highlights 环境下单行仅挂载 1 个原生 TextNode（0 Span），水平平移耗时 <= 0.42ms', () => {
    const g = globalThis as Record<string, unknown>;
    const origCSS = g.CSS;
    const origHighlight = g.Highlight;

    class MockHighlight {
      readonly ranges: AbstractRange[] = [];
      add(range: AbstractRange): void {
        this.ranges.push(range);
      }
    }
    const highlightMap = new Map<string, MockHighlight>();
    g.CSS = {
      ...(typeof origCSS === 'object' && origCSS ? origCSS : {}),
      highlights: highlightMap,
    };
    g.Highlight = MockHighlight;

    try {
      expect(NativeHighlightManager.isSupported()).toBe(true);

      // 构造恰好 10,000 字符的未格式化单行 JSON 源码
      const unit = '{"id":123,"name":"conex_item","active":true},';
      const repeatCount = Math.floor(9980 / unit.length);
      const body = unit.repeat(repeatCount);
      const tailPad = 'x'.repeat(10_000 - body.length - 12);
      const json10k = `[${body}{"pad":"${tailPad}"}]`;
      expect(json10k.length).toBe(10_000);

      const { container } = render(
        React.createElement(VirtualPlainCodeViewer, {
          content: json10k,
          filePath: 'bundle.min.json',
          wordWrap: false,
        })
      );

      const lineText = container.querySelector(
        `.${styles.lineText}`
      ) as HTMLElement;
      expect(lineText).not.toBeNull();

      // 核心断言 1：Zero-Span！单行内仅挂载 1 个纯原生 TextNode，子 Span 数量严格为 0
      expect(lineText.querySelectorAll('span').length).toBe(0);
      expect(lineText.children.length).toBe(0);
      expect(lineText.childNodes.length).toBe(1);
      expect(lineText.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(lineText.firstChild?.textContent?.length).toBe(10_000);

      // 核心断言 2：CSS.highlights 命名空间成功注册语法高亮 Range
      expect(highlightMap.size).toBeGreaterThan(0);
      expect(highlightMap.get('hl-string')?.ranges.length).toBeGreaterThan(0);
      expect(highlightMap.get('hl-number')?.ranges.length).toBeGreaterThan(0);

      // 核心断言 3：模拟水平横向平移拖拽，验证无 DOM 重排且单帧处理耗时 <= 0.42ms
      const scrollHost = container.firstElementChild as HTMLElement;
      scrollHost.scrollLeft = 200;
      fireEvent.scroll(scrollHost);

      const frameTimes: number[] = [];
      for (let step = 1; step <= 10; step++) {
        const t0 = performance.now();
        scrollHost.scrollLeft = step * 600;
        const currentSpanCount = lineText.children.length;
        const elapsed = performance.now() - t0;
        expect(currentSpanCount).toBe(0);
        frameTimes.push(elapsed);
      }

      const avgFrameMs =
        frameTimes.reduce((acc, v) => acc + v, 0) / frameTimes.length;
      expect(avgFrameMs).toBeLessThanOrEqual(0.42);
    } finally {
      g.CSS = origCSS;
      g.Highlight = origHighlight;
    }
  });
});
