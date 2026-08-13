// filesStore 单测（R2-06 领域层 store，M5 §3.1 一行转发 + 状态装配面）：
// 纯逻辑已由 filesReducers.test.ts 覆盖，本文件验证 store 动作转发不变量：
// 进入目录 / 返回上级 / 展开收起 / 四态数据面 / 失效 / 排序 / 工作区切换。
import { filesStore } from './filesStore';
import type { FileEntry } from '../types/domain';

function makeEntry(
  name: string,
  overrides: Partial<FileEntry> = {}
): FileEntry {
  return {
    name,
    kind: 'file',
    size: 0,
    modifiedMs: 1000,
    relPath: name,
    receivedAtMs: 1000,
    ...overrides,
  };
}

function resetStore(): void {
  filesStore.setState({
    activeWorkspaceRoot: null,
    cwd: '',
    history: [''],
    expanded: [],
    dirs: {},
    sortMode: 'name',
  });
}

beforeEach(() => {
  resetStore();
});

describe('filesStore 导航动作（F4 §6.2 / X4-6）', () => {
  it('enterDir 进入子目录（push 导航语义；目标未加载 → idle 占位）', () => {
    filesStore.getState().resetWorkspace('/workspace');
    filesStore.getState().enterDir('src');
    const s = filesStore.getState();
    expect(s.cwd).toBe('src');
    expect(s.history).toEqual(['', 'src']);
    expect(s.dirs['src']?.status).toBe('idle');
  });

  it('goBack 返回上级（pop 语义；根目录不再后退）', () => {
    filesStore.getState().resetWorkspace('/workspace');
    filesStore.getState().enterDir('src');
    filesStore.getState().enterDir('pages');
    filesStore.getState().goBack();
    expect(filesStore.getState().cwd).toBe('src');
    filesStore.getState().goBack();
    expect(filesStore.getState().cwd).toBe('');
    filesStore.getState().goBack();
    expect(filesStore.getState().cwd).toBe('');
  });
});

describe('filesStore 展开态（F4-F11 懒展开）', () => {
  it('expandDir / collapseDir / toggleDir 往返', () => {
    filesStore.getState().resetWorkspace('/workspace');
    filesStore.getState().expandDir('src');
    expect(filesStore.getState().expanded).toContain('src');
    filesStore.getState().collapseDir('src');
    expect(filesStore.getState().expanded).not.toContain('src');
    filesStore.getState().toggleDir('src');
    expect(filesStore.getState().expanded).toContain('src');
    filesStore.getState().toggleDir('src');
    expect(filesStore.getState().expanded).not.toContain('src');
  });
});

describe('filesStore 目录四态数据面（R2UX-06-07）', () => {
  it('loading → loaded（按 sortMode 排序写入）→ error（错误码透传）', () => {
    filesStore.getState().resetWorkspace('/workspace');
    filesStore.getState().markDirLoading('src');
    expect(filesStore.getState().dirs['src']?.status).toBe('loading');

    filesStore
      .getState()
      .markDirLoaded('src', [makeEntry('b.txt'), makeEntry('a.txt')]);
    const loaded = filesStore.getState().dirs['src'];
    expect(loaded?.status).toBe('loaded');
    expect(loaded?.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt']);

    filesStore.getState().markDirError('src', 'net.unreachable');
    const failed = filesStore.getState().dirs['src'];
    expect(failed?.status).toBe('error');
    expect(failed?.errorCode).toBe('net.unreachable');
  });

  it('invalidateDir 仅 loaded → idle（下拉刷新；error 态保留供重试，F4 §5.2）', () => {
    filesStore.getState().resetWorkspace('/workspace');
    filesStore.getState().markDirLoaded('src', [makeEntry('a.txt')]);
    filesStore.getState().invalidateDir('src');
    expect(filesStore.getState().dirs['src']?.status).toBe('idle');
    // error 态不被失效（重试入口保持）
    filesStore.getState().markDirError('src', 'net.unreachable');
    filesStore.getState().invalidateDir('src');
    expect(filesStore.getState().dirs['src']?.status).toBe('error');
  });
});

describe('filesStore 排序与工作区切换', () => {
  it('setSortMode 重排已加载层', () => {
    filesStore.getState().resetWorkspace('/workspace');
    filesStore
      .getState()
      .markDirLoaded('', [
        makeEntry('b.txt', { size: 2 }),
        makeEntry('a.txt', { size: 1 }),
      ]);
    filesStore.getState().setSortMode('size-desc');
    const s = filesStore.getState();
    expect(s.sortMode).toBe('size-desc');
    expect(s.dirs['']?.entries.map((e) => e.name)).toEqual(['b.txt', 'a.txt']);
  });

  it('resetWorkspace 清空整树并挂新活动根（F4 §5.2）', () => {
    filesStore.getState().resetWorkspace('/workspace');
    filesStore.getState().enterDir('src');
    filesStore.getState().markDirLoaded('src', [makeEntry('a.ts')]);
    filesStore.getState().resetWorkspace('/workspace-b');
    const s = filesStore.getState();
    expect(s.activeWorkspaceRoot).toBe('/workspace-b');
    expect(s.cwd).toBe('');
    expect(s.history).toEqual(['']);
    expect(s.expanded).toEqual([]);
    expect(s.dirs).toEqual({});
  });
});
