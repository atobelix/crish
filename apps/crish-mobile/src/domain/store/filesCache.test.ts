// filesCache 单测：目录列表缓存（LRU 128 层 + TTL 30s）+ 文件预览缓存
// （1MB 单条 + 64MB 总预算 + TTL + 敏感不缓存），R2-06（F4 §5.2 / R2UX-06-01/02）
import type {
  DirEntry,
  ReadFileResult,
} from '@crish/shared-types';
import {
  DIR_CACHE_CAPACITY,
  DIR_CACHE_TTL_MS,
  FILE_PREVIEW_MAX_BYTES,
  FILE_PREVIEW_TOTAL_BUDGET_BYTES,
  FILE_PREVIEW_TTL_MS,
  createLruCache,
  createDirListCache,
  createFilePreviewCache,
  dirCacheKey,
  filePreviewCacheKey,
  utf8ByteLength,
} from './filesCache';

const NOW = 1_800_000_000_000;

function makeDirEntry(name: string, isDir: boolean): DirEntry {
  return isDir
    ? { name, isDir }
    : { name, isDir, size: 100, modified: '1754700000000' };
}

function makeReadResult(
  content: string,
  overrides: Partial<ReadFileResult> = {}
): ReadFileResult {
  return {
    content,
    lineCount: content.split('\n').length,
    truncated: false,
    ...overrides,
  };
}

// ── 1. 通用 LRU ────────────────────────────────────────────────────────────

describe('createLruCache（通用 LRU）', () => {
  it('命中刷新最近使用；容量满淘汰最久未用（LRU 序）', () => {
    const c = createLruCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.get('a'); // a 变最近使用；b 成为最久
    c.set('d', 4); // 淘汰 b
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
    expect(c.size).toBe(3);
  });

  it('容量边界：size == capacity 时不淘汰已存在键重写；> capacity 淘汰', () => {
    const c = createLruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 11); // 重写 a（不增 size）
    expect(c.size).toBe(2);
    c.set('c', 3); // 淘汰 b
    expect(c.size).toBe(2);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(11);
  });

  it('容量 ≤ 0：退化不存储（安全降级）', () => {
    const c = createLruCache<string, number>(0);
    c.set('a', 1);
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });

  it('delete/clear 语义', () => {
    const c = createLruCache<string, number>(3);
    c.set('a', 1);
    expect(c.delete('a')).toBe(true);
    expect(c.delete('a')).toBe(false);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
  });
});

// ── 2. 目录列表缓存（R2UX-06-01 LRU 128 层 + F4 §5.2 30s 过期） ────────────

describe('createDirListCache（目录列表缓存）', () => {
  it('默认容量 128 层（R2UX-06-01 规格锚点）', () => {
    expect(DIR_CACHE_CAPACITY).toBe(128);
    expect(DIR_CACHE_TTL_MS).toBe(30_000);
    const c = createDirListCache();
    for (let i = 0; i < 128; i += 1) {
      c.set(`k${i}`, [makeDirEntry(`f${i}.ts`, false)]);
    }
    expect(c.size).toBe(128);
    c.set('overflow', [makeDirEntry('o.ts', false)]);
    expect(c.size).toBe(128); // 淘汰最久未用 k0
    expect(c.get('k0')).toBeUndefined();
    expect(c.get('overflow')?.length).toBe(1);
  });

  it('自定义容量边界：容量 2，命中刷新序（LRU 语义）', () => {
    const c = createDirListCache({ capacity: 2 });
    c.set('a', [makeDirEntry('a.ts', false)]);
    c.set('b', [makeDirEntry('b.ts', false)]);
    c.get('a'); // a 最近使用
    c.set('c', [makeDirEntry('c.ts', false)]); // 淘汰 b
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
  });

  it('TTL 过期：30s 后命中返回 undefined 并惰性清除（F4 §5.2「进入页面 30s 过期」）', () => {
    let now = NOW;
    const c = createDirListCache({ now: () => now });
    c.set('src', [makeDirEntry('a.ts', false)]);
    expect(c.get('src')).toBeDefined();
    now = NOW + 30_000; // 恰在 TTL 内（30s 边界不过期）
    expect(c.get('src')).toBeDefined();
    now = NOW + 30_001; // 超 1ms → 过期
    expect(c.get('src')).toBeUndefined();
    expect(c.size).toBe(0); // 惰性清除
  });

  it('invalidate 显式失效（下拉刷新 / 写成功后失效上级目录，F4 附录 A）', () => {
    const c = createDirListCache();
    c.set('src', [makeDirEntry('a.ts', false)]);
    c.invalidate('src');
    expect(c.get('src')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('写入时刻为 TTL 起点：TTL 内重写刷新过期计时', () => {
    let now = NOW;
    const c = createDirListCache({ now: () => now });
    c.set('src', [makeDirEntry('a.ts', false)]);
    now = NOW + 20_000;
    c.set('src', [makeDirEntry('b.ts', false)]); // 重写 → 新 TTL 起点
    now = NOW + 40_000; // 距首次写入 40s > 30s，但距重写仅 20s
    expect(c.get('src')).toBeDefined();
  });

  it('键构造：workspaceRoot + relPath 隔离不同工作区（F4 §5.2）', () => {
    const c = createDirListCache();
    c.set(dirCacheKey('C:\\a', 'src'), [makeDirEntry('a.ts', false)]);
    expect(c.get(dirCacheKey('C:\\b', 'src'))).toBeUndefined();
    expect(c.get(dirCacheKey('C:\\a', 'src'))).toBeDefined();
    expect(c.get(dirCacheKey('C:\\a', ''))).toBeUndefined(); // 根层是独立键
  });
});

// ── 3. 文件预览缓存（R2UX-06-02 预览按需/1MB 上限；F4 §5.2 64MB 预算 + TTL） ─

describe('createFilePreviewCache（文件预览缓存）', () => {
  it('规格锚点：1MB 单条 / 64MB 总预算 / 5min TTL', () => {
    expect(FILE_PREVIEW_MAX_BYTES).toBe(1_048_576);
    expect(FILE_PREVIEW_TOTAL_BUDGET_BYTES).toBe(64 * 1024 * 1024);
    expect(FILE_PREVIEW_TTL_MS).toBe(300_000);
  });

  it('命中返回完整条目（content/lineCount/truncated/sensitive:false/cachedAtMs）', () => {
    const now = NOW;
    const c = createFilePreviewCache({ now: () => now });
    const ok = c.set('f1', makeReadResult('hello world'));
    expect(ok).toBe(true);
    const entry = c.get('f1');
    expect(entry?.content).toBe('hello world');
    expect(entry?.sensitive).toBe(false);
    expect(entry?.cachedAtMs).toBe(NOW);
    expect(c.size).toBe(1);
  });

  it('sensitive=true 拒绝入缓存（F4 §7.1 敏感文件内容不进任何缓存）', () => {
    const c = createFilePreviewCache();
    const ok = c.set('env', makeReadResult('SECRET', { sensitive: true }));
    expect(ok).toBe(false);
    expect(c.size).toBe(0);
    expect(c.get('env')).toBeUndefined();
  });

  it('内容超 1MB 拒绝入缓存（R2UX-06-02 超限展示占位）', () => {
    const c = createFilePreviewCache();
    const huge = 'x'.repeat(FILE_PREVIEW_MAX_BYTES + 1);
    expect(utf8ByteLength(huge)).toBe(FILE_PREVIEW_MAX_BYTES + 1);
    expect(c.set('huge', makeReadResult(huge))).toBe(false);
    expect(c.size).toBe(0);
    // 恰 1MB 边界可缓存（桌面 MAX_TEXT_FILE_BYTES 同口径）
    const edge = 'x'.repeat(FILE_PREVIEW_MAX_BYTES);
    expect(c.set('edge', makeReadResult(edge))).toBe(true);
    expect(c.get('edge')).toBeDefined();
  });

  it('TTL 过期：5min 后命中返回 undefined 并惰性清除', () => {
    let now = NOW;
    const c = createFilePreviewCache({ now: () => now });
    c.set('f1', makeReadResult('content'));
    now = NOW + FILE_PREVIEW_TTL_MS; // 恰在 TTL 内
    expect(c.get('f1')).toBeDefined();
    now = NOW + FILE_PREVIEW_TTL_MS + 1; // 超 1ms
    expect(c.get('f1')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('总预算超限按 LRU 淘汰最久未用（F4 §5.2 文本 ≤ 64MB 总预算）', () => {
    const c = createFilePreviewCache({
      totalBudgetBytes: 100,
      maxEntryBytes: 80, // 单条 40 字节（10 字符 UTF-8 为 10 字节——用 ASCII 控制）
    });
    // 10 字符 ASCII = 10 字节/条；预算 100 → 最多 10 条
    for (let i = 0; i < 9; i += 1) {
      c.set(`f${i}`, makeReadResult('0123456789'));
    }
    expect(c.size).toBe(9);
    c.get('f0'); // f0 最近使用
    c.set('f9', makeReadResult('0123456789')); // 第 10 条 → 10 字节 × 10 = 100 恰满
    expect(c.size).toBe(10);
    c.set('f10', makeReadResult('0123456789')); // 超预算 → 淘汰最久未用（f1）
    expect(c.size).toBe(10);
    expect(c.get('f1')).toBeUndefined();
    expect(c.get('f0')).toBeDefined(); // 命中过的保留
    expect(c.totalBytes).toBe(100);
  });

  it('键含 lineBudget（F4 §5.2 文件内容键），不同行预算独立缓存', () => {
    const c = createFilePreviewCache();
    const k400 = filePreviewCacheKey('C:\\a', 'src/a.ts', 400);
    const k800 = filePreviewCacheKey('C:\\a', 'src/a.ts', 800);
    c.set(k400, makeReadResult('first 400 lines'));
    c.set(k800, makeReadResult('first 800 lines'));
    expect(c.get(k400)?.content).toBe('first 400 lines');
    expect(c.get(k800)?.content).toBe('first 800 lines');
  });

  it('invalidate/clear 语义', () => {
    const c = createFilePreviewCache();
    c.set('a', makeReadResult('a'));
    c.set('b', makeReadResult('b'));
    c.invalidate('a');
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.totalBytes).toBe(0);
  });
});

// ── 4. utf8ByteLength（多字节字符计字节，无 TextEncoder 依赖） ─────────────

describe('utf8ByteLength', () => {
  it('ASCII 1 字节/字符；CJK 3 字节；emoji 4 字节', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('a中文b')).toBe(8);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('')).toBe(0);
  });
});
