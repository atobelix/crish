// FileBreadcrumb 组件测试（R2-06b）：分段渲染 / 当前层高亮 / 段点击 / 返回键
import { fireEvent, render, screen } from '@testing-library/react-native';
import { FileBreadcrumb, segmentLabel } from './FileBreadcrumb';

describe('segmentLabel', () => {
  it('根段 = 工作区名（缺省「根目录」）', () => {
    expect(segmentLabel('', 0, 'conex')).toBe('conex');
    expect(segmentLabel('', 0, null)).toBe('根目录');
  });

  it('其余段 = 路径叶名', () => {
    expect(segmentLabel('src/components', 1, 'conex')).toBe('components');
    expect(segmentLabel('src/components/files', 2, 'conex')).toBe('files');
  });
});

describe('FileBreadcrumb', () => {
  it('按导航栈渲染分段（根 + 各层叶名）', async () => {
    await render(
      <FileBreadcrumb
        history={['', 'src', 'src/components']}
        workspaceName="conex"
        backEnabled
        onBack={jest.fn()}
        onSelectSegment={jest.fn()}
      />
    );
    expect(screen.getByText('conex')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('components')).toBeTruthy();
  });

  it('当前层（栈顶）为 selected 态，不可点击', async () => {
    const onSelect = jest.fn();
    await render(
      <FileBreadcrumb
        history={['', 'src']}
        workspaceName="conex"
        backEnabled
        onBack={jest.fn()}
        onSelectSegment={onSelect}
      />
    );
    const current = screen.getByTestId('crumb-current');
    expect(current.props.accessibilityState.selected).toBe(true);
    await fireEvent.press(current);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('点击非当前段 → onSelectSegment(下标)', async () => {
    const onSelect = jest.fn();
    await render(
      <FileBreadcrumb
        history={['', 'src', 'src/components']}
        workspaceName="conex"
        backEnabled
        onBack={jest.fn()}
        onSelectSegment={onSelect}
      />
    );
    const crumbs = screen.getAllByTestId('crumb');
    // history = ['', 'src', 'src/components']：非当前段为下标 0/1；
    // 目标 history[1] = 'src'（crumbs[1]）
    await fireEvent.press(crumbs[1]!);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('返回键：backEnabled=false 时禁用（根层，X4-6）', async () => {
    const onBack = jest.fn();
    await render(
      <FileBreadcrumb
        history={['']}
        workspaceName="conex"
        backEnabled={false}
        onBack={onBack}
        onSelectSegment={jest.fn()}
      />
    );
    const back = screen.getByTestId('files-back');
    expect(back.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(back);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('返回键可点时 → onBack', async () => {
    const onBack = jest.fn();
    await render(
      <FileBreadcrumb
        history={['', 'src']}
        workspaceName="conex"
        backEnabled
        onBack={onBack}
        onSelectSegment={jest.fn()}
      />
    );
    await fireEvent.press(screen.getByTestId('files-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
