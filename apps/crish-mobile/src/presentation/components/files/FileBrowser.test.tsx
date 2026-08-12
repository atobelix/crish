// FileBrowser 组件测试（R2-06b）：四态（R2UX-06-07）/ 排序切换（F4-F13）/
// 密度三档（R2UX-06-01）/ 行交互（目录进入 / 文件预览入口）
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FileEntry } from '@/domain/types/domain';
import type { FilesVm, RowDensity } from '@/adapters/viewmodels/useFilesVm';
import type { DirLoadStatus } from '@/domain/store/filesReducers';
import { FileBrowser, browserViewState, nextDensity } from './FileBrowser';

const NOW = 1_800_000_000_000;

function makeEntry(
  name: string,
  isDir: boolean,
  extra: Partial<FileEntry> = {}
): FileEntry {
  return {
    name,
    isDir,
    size: 3277,
    modified: String(NOW - 3_600_000),
    relPath: name,
    receivedAtMs: NOW,
    ...extra,
  };
}

function makeVm(overrides: Partial<FilesVm> = {}): FilesVm {
  return {
    connected: true,
    activeWorkspaceRoot: 'C:\\Software\\conex',
    workspaceName: 'conex',
    cwd: '',
    history: [''],
    canGoBack: false,
    entries: [],
    status: 'loaded',
    errorCode: null,
    sortMode: 'name',
    density: 48 as RowDensity,
    refreshing: false,
    switchingWorkspace: false,
    workspaces: null,
    workspacesStatus: 'idle',
    workspacesError: null,
    enterDir: jest.fn(),
    back: jest.fn(),
    jumpTo: jest.fn(),
    setSortMode: jest.fn(),
    setDensity: jest.fn(),
    refresh: jest.fn(),
    retry: jest.fn(),
    retryConnect: jest.fn(),
    openWorkspaceList: jest.fn(),
    switchWorkspace: jest.fn(),
    ...overrides,
  };
}

// ── 1. 四态派生纯函数（R2UX-06-07） ───────────────────────────────────────

describe('browserViewState（四态优先级）', () => {
  const loaded = 'loaded' as DirLoadStatus;
  it('未连接优先（即使已有数据）', () => {
    expect(browserViewState(false, null, loaded, 3)).toBe('disconnected');
  });

  it('错误优先于加载/空态', () => {
    expect(browserViewState(true, 'path_not_found', loaded, 3)).toBe('error');
    expect(browserViewState(true, 'transport.closed', 'idle', 0)).toBe('error');
  });

  it('idle/loading → loading', () => {
    expect(browserViewState(true, null, 'idle', 0)).toBe('loading');
    expect(browserViewState(true, null, 'loading', 0)).toBe('loading');
  });

  it('loaded 空条目 → empty；有条目 → list', () => {
    expect(browserViewState(true, null, loaded, 0)).toBe('empty');
    expect(browserViewState(true, null, loaded, 3)).toBe('list');
  });
});

describe('nextDensity（44→48→56 循环，R2UX-06-01）', () => {
  it('三档循环且默认 48', () => {
    expect(nextDensity(44)).toBe(48);
    expect(nextDensity(48)).toBe(56);
    expect(nextDensity(56)).toBe(44);
  });
});

// ── 2. 四态渲染（R2UX-06-07 每态组件测试） ────────────────────────────────

describe('FileBrowser 四态', () => {
  it('加载态 → files-loading-state', async () => {
    await render(
      <FileBrowser vm={makeVm({ status: 'loading' })} onOpenFile={jest.fn()} />
    );
    expect(screen.getByTestId('files-loading-state')).toBeTruthy();
  });

  it('空态 → 「该目录为空」+ 刷新按钮触发 refresh', async () => {
    const vm = makeVm({ status: 'loaded', entries: [] });
    await render(<FileBrowser vm={vm} onOpenFile={jest.fn()} />);
    expect(screen.getByText('该目录为空')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('files-empty-refresh'));
    expect(vm.refresh).toHaveBeenCalledTimes(1);
  });

  it('错误态 → 映射文案 + 重试按钮触发 retry', async () => {
    const vm = makeVm({ status: 'error', errorCode: 'path_not_found' });
    await render(<FileBrowser vm={vm} onOpenFile={jest.fn()} />);
    expect(screen.getByTestId('files-error-state')).toBeTruthy();
    expect(screen.getByText('文件或目录不存在')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('files-retry'));
    expect(vm.retry).toHaveBeenCalledTimes(1);
  });

  it('未连接 → 「未连接」错误态 + 重连按钮触发 retryConnect（任务书）', async () => {
    const vm = makeVm({ connected: false });
    await render(<FileBrowser vm={vm} onOpenFile={jest.fn()} />);
    expect(screen.getByTestId('files-error-state')).toBeTruthy();
    expect(screen.getByText('未连接')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('files-retry-connect'));
    expect(vm.retryConnect).toHaveBeenCalledTimes(1);
  });
});

// ── 3. 列表渲染与行交互（F4 §6.2） ────────────────────────────────────────

describe('FileBrowser 列表与交互', () => {
  const entries = [
    makeEntry('src', true),
    makeEntry('a.ts', false),
    makeEntry('.env', false),
  ];

  it('渲染全部条目行（目录/文件/敏感标记）', async () => {
    await render(
      <FileBrowser vm={makeVm({ entries })} onOpenFile={jest.fn()} />
    );
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByTestId('file-row-sensitive')).toBeTruthy();
  });

  it('点击目录行 → enterDir(relPath)（push 导航，F4 §6.2）', async () => {
    const vm = makeVm({ entries });
    await render(<FileBrowser vm={vm} onOpenFile={jest.fn()} />);
    await fireEvent.press(screen.getAllByTestId('file-row-dir')[0]!);
    expect(vm.enterDir).toHaveBeenCalledWith('src');
  });

  it('点击文件行 → onOpenFile(entry)（预览入口，R2UX-06-02）', async () => {
    const onOpenFile = jest.fn();
    const vm = makeVm({ entries });
    await render(<FileBrowser vm={vm} onOpenFile={onOpenFile} />);
    await fireEvent.press(screen.getAllByTestId('file-row')[0]!);
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a.ts' })
    );
  });

  it('排序条：点击修改时间 → setSortMode(mtime-desc)（F4-F13）', async () => {
    const vm = makeVm({ entries });
    await render(<FileBrowser vm={vm} onOpenFile={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('sort-mtime'));
    expect(vm.setSortMode).toHaveBeenCalledWith('mtime-desc');
    await fireEvent.press(screen.getByTestId('sort-size'));
    expect(vm.setSortMode).toHaveBeenCalledWith('size-desc');
    await fireEvent.press(screen.getByTestId('sort-name'));
    expect(vm.setSortMode).toHaveBeenCalledWith('name');
  });

  it('密度开关：点击 → setDensity(下一档)，默认 48（R2UX-06-01）', async () => {
    const vm = makeVm({ entries, density: 48 as RowDensity });
    await render(<FileBrowser vm={vm} onOpenFile={jest.fn()} />);
    expect(screen.getByText('密度 48')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('density-toggle'));
    expect(vm.setDensity).toHaveBeenCalledWith(56);
  });

  it('下拉刷新接线：FlatList refreshing/onRefresh', async () => {
    const vm = makeVm({ entries, refreshing: true });
    await render(<FileBrowser vm={vm} onOpenFile={jest.fn()} />);
    const list = screen.getByTestId('files-list');
    expect(list.props.refreshing).toBe(true);
    expect(list.props.onRefresh).toBe(vm.refresh);
  });

  it('空态/错误态也在 FlatList 内（ListEmptyComponent），下拉刷新任意态可用', async () => {
    const vm = makeVm({ status: 'error', errorCode: 'cmd.timeout' });
    await render(<FileBrowser vm={vm} onOpenFile={jest.fn()} />);
    const list = screen.getByTestId('files-list');
    expect(list.props.ListEmptyComponent).toBeTruthy();
    expect(list.props.onRefresh).toBe(vm.refresh);
  });
});
