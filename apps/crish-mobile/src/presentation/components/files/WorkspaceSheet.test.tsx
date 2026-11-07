import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { WorkspaceEntry } from '@crish/shared-types';
import { WorkspaceSheet, type WorkspaceSheetProps } from './WorkspaceSheet';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function workspace(index: number): WorkspaceEntry {
  return {
    root: `/work/${index}`,
    name: `工作区 ${index}`,
    active: index === 0,
  };
}

function renderSheet(props: Partial<WorkspaceSheetProps> = {}) {
  return render(
    <WorkspaceSheet
      visible
      onClose={jest.fn()}
      workspaces={[workspace(0), workspace(1)]}
      status="loaded"
      activeRoot="/work/0"
      switching={false}
      onSelect={jest.fn()}
      onRetry={jest.fn()}
      {...props}
    />,
    {
      wrapper: ({ children }) => (
        <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
      ),
    }
  );
}

describe('WorkspaceSheet 状态分支', () => {
  it('加载与空闲呈现加载态', async () => {
    const loading = await renderSheet({ status: 'loading', workspaces: null });
    expect(loading.getByText('加载中…')).toBeTruthy();
    const idle = await renderSheet({ status: 'idle', workspaces: null });
    expect(idle.getByText('加载中…')).toBeTruthy();
  });

  it('失败可重试，空列表单独呈现', async () => {
    const onRetry = jest.fn();
    const failed = await renderSheet({
      status: 'error',
      workspaces: null,
      onRetry,
    });
    expect(failed.getByText('无法获取工作区')).toBeTruthy();
    await fireEvent.press(failed.getByText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const empty = await renderSheet({ status: 'loaded', workspaces: [] });
    expect(empty.getByText('没有已授权的工作区')).toBeTruthy();
    expect(empty.queryByTestId('workspace-sheet-list')).toBeNull();
  });
});

describe('WorkspaceSheet 虚拟化', () => {
  it('长列表首屏挂载有界，短列表不锁死高度', async () => {
    const short = await renderSheet();
    const shortList = short.getByTestId('workspace-sheet-list');
    const shortStyle = StyleSheet.flatten(shortList.props.style);
    expect(shortStyle.height).toBeUndefined();
    expect(shortList.props.scrollEnabled).toBe(false);

    const workspaces = Array.from({ length: 40 }, (_, index) => workspace(index));
    const view = await renderSheet({ workspaces, activeRoot: '/work/0' });
    const list = view.getByTestId('workspace-sheet-list');
    const style = StyleSheet.flatten(list.props.style);
    expect(style.height).toEqual(expect.any(Number));
    expect(style.height).toBeGreaterThan(0);
    expect(list.props.initialNumToRender).toBeLessThan(workspaces.length);
    expect(view.getByText('工作区 0')).toBeTruthy();
    expect(view.queryByText('工作区 30')).toBeNull();
    const rendered = view.getAllByTestId(/^workspace-sheet-row-/);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(workspaces.length);
  });

  it('刷新选择回调不串到旧函数，切换中不可再选', async () => {
    const workspaces = Array.from({ length: 12 }, (_, index) => workspace(index));
    const first = jest.fn();
    const next = jest.fn();
    const view = await renderSheet({
      workspaces,
      onSelect: first,
      activeRoot: '/work/1',
    });
    await view.rerender(
      <WorkspaceSheet
        visible
        onClose={jest.fn()}
        workspaces={workspaces}
        status="loaded"
        activeRoot="/work/1"
        switching={false}
        onSelect={next}
        onRetry={jest.fn()}
      />
    );
    await fireEvent.press(view.getByTestId('workspace-sheet-row-1'));
    expect(next).toHaveBeenCalledWith('/work/1');
    expect(first).not.toHaveBeenCalled();

    await view.rerender(
      <WorkspaceSheet
        visible
        onClose={jest.fn()}
        workspaces={workspaces}
        status="loaded"
        activeRoot="/work/1"
        switching
        onSelect={next}
        onRetry={jest.fn()}
      />
    );
    await fireEvent.press(view.getByTestId('workspace-sheet-row-0'));
    expect(next).toHaveBeenCalledTimes(1);
  });
});
