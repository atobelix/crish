// filesReducers 单测：目录树状态纯逻辑（R2-06）
// 覆盖：展开/折叠（F4-F11 懒展开）、导航（X4-6 push/pop）、排序（F4 §2.2 / F4-F13）、
//       四态数据面（R2UX-06-07）、工作区切换清空（F4 §5.2）
import type { FileEntry } from '../types/domain';
import {
  createFilesTreeState,
  enterDir,
  goBack,
  expandDir,
  collapseDir,
  toggleDir,
  markDirLoading,
  markDirLoaded,
  markDirError,
  invalidateDir,
  setSortMode,
  resetWorkspace,
  sortDirEntries,
} from './filesReducers';

const NOW = 1_800_000_000_000;

function makeEntry(
  name: string,
  isDir: boolean,
  extra: Partial<FileEntry> = {}
): FileEntry {
  return {
    name,
    isDir,
    relPath: name,
    receivedAtMs: NOW,
    ...extra,
  };
}

// ── 1. 排序（F4 §2.2 目录优先+名称序；F4-F13 P1 mtime/size 序） ────────────

describe('sortDirEntries（F4 §2.2 默认 + F4-F13 P1 扩展）', () => {
  it('默认 name：目录优先 + 名称升序（桌面 directory.rs:68-72 语义）', () => {
    const entries = [
      makeEntry('zebra.ts', false),
      makeEntry('app', true),
      makeEntry('alpha.ts', false),
      makeEntry('core', true),
    ];
    const sorted = sortDirEntries(entries, 'name');
    expect(sorted.map((e) => e.name)).toEqual([
      'app',
      'core',
      'alpha.ts',
      'zebra.ts',
    ]);
  });

  it('mtime-desc：目录优先 + modified（epoch ms 字符串）降序，缺省值排最后', () => {
    const entries = [
      makeEntry('old.ts', false, { modified: '1000' }),
      makeEntry('new.ts', false, { modified: '3000' }),
      makeEntry('no-mtime.ts', false), // 缺 modified → 0 → 最末
      makeEntry('dir', true, { modified: '2000' }),
    ];
    const sorted = sortDirEntries(entries, 'mtime-desc');
    expect(sorted.map((e) => e.name)).toEqual([
      'dir',
      'new.ts',
      'old.ts',
      'no-mtime.ts',
    ]);
  });

  it('size-desc：目录优先 + size 降序，缺省值排最后', () => {
    const entries = [
      makeEntry('small.ts', false, { size: 10 }),
      makeEntry('big.ts', false, { size: 500 }),
      makeEntry('no-size.ts', false),
      makeEntry('dir', true),
    ];
    const sorted = sortDirEntries(entries, 'size-desc');
    expect(sorted.map((e) => e.name)).toEqual([
      'dir',
      'big.ts',
      'small.ts',
      'no-size.ts',
    ]);
  });

  it('不修改入参数组（纯函数纪律）', () => {
    const entries = [makeEntry('b', false), makeEntry('a', true)];
    const copy = [...entries];
    sortDirEntries(entries, 'name');
    expect(entries).toEqual(copy);
  });
});

// ── 2. 展开/折叠（F4-F11 懒展开，内存态） ──────────────────────────────────

describe('展开/折叠（F4-F11 懒展开）', () => {
  it('expandDir 幂等：重复展开不重复入集合', () => {
    let s = createFilesTreeState();
    s = expandDir(s, 'src');
    s = expandDir(s, 'src');
    expect(s.expanded).toEqual(['src']);
  });

  it('collapseDir 幂等：未展开的路径收起无效果', () => {
    let s = createFilesTreeState();
    s = collapseDir(s, 'src');
    expect(s.expanded).toEqual([]);
  });

  it('toggleDir 双向切换', () => {
    let s = createFilesTreeState();
    s = toggleDir(s, 'src');
    expect(s.expanded).toContain('src');
    s = toggleDir(s, 'src');
    expect(s.expanded).not.toContain('src');
  });

  it('收起不清缓存：再展开命中已加载条目（X4-6 展开态保留）', () => {
    let s = createFilesTreeState();
    s = expandDir(s, 'src');
    s = markDirLoading(s, 'src');
    s = markDirLoaded(s, 'src', [makeEntry('a.ts', false)], NOW);
    s = collapseDir(s, 'src');
    expect(s.dirs['src']?.status).toBe('loaded'); // 缓存仍在
    s = expandDir(s, 'src');
    expect(s.dirs['src']?.entries).toHaveLength(1);
  });
});

// ── 3. 导航（X4-6 push/pop 与面包屑一致性） ────────────────────────────────

describe('导航（enterDir/goBack，X4-6）', () => {
  it('enterDir：目录压入导航栈 + 设为当前；未加载目标建 idle 占位', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    expect(s.cwd).toBe('src');
    expect(s.history).toEqual(['', 'src']);
    expect(s.dirs['src']).toEqual({ status: 'idle', entries: [] });
  });

  it('深层导航栈正确：根 → src → src/components', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = enterDir(s, 'src/components');
    expect(s.cwd).toBe('src/components');
    expect(s.history).toEqual(['', 'src', 'src/components']);
  });

  it('goBack 逐级返回，根层原地不动（无上级）', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = enterDir(s, 'src/components');
    s = goBack(s);
    expect(s.cwd).toBe('src');
    expect(s.history).toEqual(['', 'src']);
    s = goBack(s);
    expect(s.cwd).toBe('');
    expect(s.history).toEqual(['']);
    const before = s;
    s = goBack(s); // 根层原地不动
    expect(s).toBe(before);
  });

  it('返回后已展开目录保留展开态（X4-6：栈回溯时保留展开态）', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = expandDir(s, 'src/lib');
    s = markDirLoaded(s, 'src/lib', [makeEntry('x.ts', false)], NOW);
    s = goBack(s);
    expect(s.expanded).toContain('src/lib');
    expect(s.dirs['src/lib']?.status).toBe('loaded');
  });
});

// ── 4. 四态数据面（R2UX-06-07） ────────────────────────────────────────────

describe('目录加载四态（R2UX-06-07）', () => {
  it('初始：目标目录不存在 → 访问为 undefined（idle 在导航时才建）', () => {
    const s = createFilesTreeState();
    expect(s.dirs['']).toBeUndefined();
  });

  it('markDirLoading：loading 态（条目清空，等待请求）', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = markDirLoading(s, 'src');
    expect(s.dirs['src']).toEqual({ status: 'loading', entries: [] });
  });

  it('markDirLoaded：loaded 态 + 按当前 sortMode 排序 + loadedAtMs 记录', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = markDirLoaded(
      s,
      'src',
      [
        makeEntry('b.ts', false),
        makeEntry('a.ts', false),
        makeEntry('d', true),
      ],
      NOW
    );
    expect(s.dirs['src']?.status).toBe('loaded');
    expect(s.dirs['src']?.entries.map((e) => e.name)).toEqual([
      'd',
      'a.ts',
      'b.ts',
    ]);
    expect(s.dirs['src']?.loadedAtMs).toBe(NOW);
  });

  it('markDirError：error 态 + 错误码透传（UI 层映射文案 + 重试入口）', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = markDirError(s, 'src', 'file.not_found');
    expect(s.dirs['src']).toEqual({
      status: 'error',
      entries: [],
      errorCode: 'file.not_found',
    });
  });

  it('invalidateDir：loaded → idle（下拉刷新/写成功后失效上级目录，F4 §5.2）', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = markDirLoaded(s, 'src', [makeEntry('a.ts', false)], NOW);
    s = invalidateDir(s, 'src');
    expect(s.dirs['src']?.status).toBe('idle');
    expect(s.dirs['src']?.entries).toEqual([]);
  });

  it('invalidateDir 对非 loaded 态无效果', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = markDirLoading(s, 'src');
    s = invalidateDir(s, 'src');
    expect(s.dirs['src']?.status).toBe('loading');
  });
});

// ── 5. 排序模式切换与工作区切换（F4-F13 P1 / F4 §5.2） ─────────────────────

describe('setSortMode / resetWorkspace', () => {
  it('setSortMode：已加载层全部重排；未加载层原样保留', () => {
    let s = createFilesTreeState();
    s = markDirLoaded(
      s,
      'root',
      [
        makeEntry('big.ts', false, { size: 500 }),
        makeEntry('small.ts', false, { size: 10 }),
      ],
      NOW
    );
    s = markDirLoading(s, 'other');
    s = setSortMode(s, 'size-desc');
    expect(s.sortMode).toBe('size-desc');
    expect(s.dirs['root']?.entries.map((e) => e.name)).toEqual([
      'big.ts',
      'small.ts',
    ]);
    expect(s.dirs['other']?.status).toBe('loading');
  });

  it('setSortMode 相同模式幂等（不产生新引用）', () => {
    const s = createFilesTreeState();
    expect(setSortMode(s, 'name')).toBe(s);
  });

  it('resetWorkspace：清空展开/缓存/导航，挂新活动根（F4 §5.2 切换工作区清空）', () => {
    let s = createFilesTreeState();
    s = enterDir(s, 'src');
    s = expandDir(s, 'src/lib');
    s = markDirLoaded(s, 'src/lib', [makeEntry('x.ts', false)], NOW);
    s = resetWorkspace(s, 'D:\\other');
    expect(s.activeWorkspaceRoot).toBe('D:\\other');
    expect(s.expanded).toEqual([]);
    expect(s.dirs).toEqual({});
    expect(s.cwd).toBe('');
    expect(s.history).toEqual(['']);
  });

  it('resetWorkspace(null)：活动根清除（工作区列表页/未授权态）', () => {
    let s = createFilesTreeState();
    s = resetWorkspace(s, null);
    expect(s.activeWorkspaceRoot).toBeNull();
  });
});
