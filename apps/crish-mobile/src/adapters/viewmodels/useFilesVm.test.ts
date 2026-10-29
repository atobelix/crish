// 文件浏览视图模型测试：纯函数 + 导航/排序动作（store 面）。
//
// 组件级渲染路径由 screens.test.tsx 的 FilesScreen 用例覆盖；这里聚焦
// useFilesVm 导出的纯逻辑与不依赖 React 渲染的 store 动作，避免与
// zustand 复合 selector 的渲染时序耦合。
import {
  errorCodeOf,
  pickBootstrapWorkspace,
  FILE_ROW_HEIGHT,
} from './useFilesVm';
import { filesStore } from '@/domain/store/filesStore';
import { FilesCommandError } from '@/adapters/wiring/filesRepository';
import type { WorkspaceEntry } from '@crish/shared-types';

function workspace(root: string, active = false): WorkspaceEntry {
  return { root, name: root, active } as WorkspaceEntry;
}

beforeEach(() => {
  filesStore.setState({
    cwd: '',
    history: [''],
    sortMode: 'name',
    activeWorkspaceRoot: null,
    dirs: {},
  });
});

describe('errorCodeOf', () => {
  it('FilesCommandError 取协议错误码', () => {
    expect(errorCodeOf(new FilesCommandError('not_found', 'x'))).toBe(
      'not_found'
    );
  });

  it('普通异常归为 internal', () => {
    expect(errorCodeOf(new Error('boom'))).toBe('internal');
  });

  it('非 Error 值也归为 internal（不抛错）', () => {
    expect(errorCodeOf('string error')).toBe('internal');
    expect(errorCodeOf(null)).toBe('internal');
    expect(errorCodeOf(undefined)).toBe('internal');
  });
});

describe('pickBootstrapWorkspace', () => {
  it('优先选 active 工作区', () => {
    expect(
      pickBootstrapWorkspace([workspace('/w1'), workspace('/w2', true)])?.root
    ).toBe('/w2');
  });

  it('无 active 时选首个', () => {
    expect(
      pickBootstrapWorkspace([workspace('/w1'), workspace('/w2')])?.root
    ).toBe('/w1');
  });

  it('空列表返回 undefined', () => {
    expect(pickBootstrapWorkspace([])).toBeUndefined();
  });

  it('多个 active 时取第一个', () => {
    expect(
      pickBootstrapWorkspace([workspace('/a', true), workspace('/b', true)])
        ?.root
    ).toBe('/a');
  });
});

describe('FILE_ROW_HEIGHT', () => {
  it('固定 56（移动端不再提供密度切换）', () => {
    expect(FILE_ROW_HEIGHT).toBe(56);
  });
});

describe('filesStore 导航动作（VM 直接驱动的数据面）', () => {
  it('enterDir 推入导航栈', () => {
    filesStore.getState().enterDir('sub');
    expect(filesStore.getState().cwd).toBe('sub');
    expect(filesStore.getState().history).toEqual(['', 'sub']);
  });

  it('goBack 在根层幂等（不越界）', () => {
    filesStore.getState().goBack();
    expect(filesStore.getState().cwd).toBe('');
    expect(filesStore.getState().history).toEqual(['']);
  });

  it('多层进入后 goBack 逐层回退', () => {
    filesStore.getState().enterDir('a');
    filesStore.getState().enterDir('a/b');
    filesStore.getState().goBack();
    expect(filesStore.getState().cwd).toBe('a');
  });

  it('canGoBack 语义 = history 长度 > 1', () => {
    expect(filesStore.getState().history.length > 1).toBe(false);
    filesStore.getState().enterDir('x');
    expect(filesStore.getState().history.length > 1).toBe(true);
  });

  it('setSortMode 写入 store', () => {
    filesStore.getState().setSortMode('date');
    expect(filesStore.getState().sortMode).toBe('date');
  });
});
