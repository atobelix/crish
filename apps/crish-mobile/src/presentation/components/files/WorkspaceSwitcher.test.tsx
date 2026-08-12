// WorkspaceSwitcher 组件测试（R2-06b）：列表/活动标记/切换/装载态（loading/
// empty/error）/空态引导文案（F4 §6.1）/关闭
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { WorkspaceEntry } from '../../../../../../packages/shared-types/src/generated/device/types';
import { WorkspaceSwitcher, workspaceCard } from './WorkspaceSwitcher';

const WORKSPACES: WorkspaceEntry[] = [
  { root: 'C:\\Software\\conex', active: true, reachable: true },
  { root: 'D:\\Projects\\blog', active: false, reachable: true },
];

describe('workspaceCard（F4 §6.1 卡片信息）', () => {
  it('名称 = name ?? 路径叶名；活动标记双源（entry.active / activeRoot）', () => {
    expect(workspaceCard(WORKSPACES[0]!, null)).toEqual({
      name: 'conex',
      path: 'C:\\Software\\conex',
      active: true,
    });
    expect(workspaceCard(WORKSPACES[1]!, 'D:\\Projects\\blog')).toEqual({
      name: 'blog',
      path: 'D:\\Projects\\blog',
      active: true,
    });
    expect(workspaceCard({ root: 'E:\\docs', active: false }, null)).toEqual({
      name: 'docs',
      path: 'E:\\docs',
      active: false,
    });
  });
});

describe('WorkspaceSwitcher', () => {
  const base = {
    workspaces: WORKSPACES,
    status: 'loaded' as const,
    errorCode: null,
    activeRoot: 'C:\\Software\\conex',
    switching: false,
    onClose: jest.fn(),
    onSelect: jest.fn(),
    onRetry: jest.fn(),
  };

  it('列表：名称 + 完整路径 + 活动标记', async () => {
    await render(<WorkspaceSwitcher {...base} />);
    expect(screen.getByText('conex')).toBeTruthy();
    expect(screen.getByText('C:\\Software\\conex')).toBeTruthy();
    expect(screen.getByText('blog')).toBeTruthy();
    expect(screen.getByText('活动中')).toBeTruthy();
  });

  it('点击工作区 → onSelect(root)（F4-F02 切换入口）', async () => {
    const onSelect = jest.fn();
    await render(<WorkspaceSwitcher {...base} onSelect={onSelect} />);
    const items = screen.getAllByTestId('workspace-item');
    await fireEvent.press(items[1]!);
    expect(onSelect).toHaveBeenCalledWith('D:\\Projects\\blog');
  });

  it('切换中：行禁用防双点（F2 §9.3-3）', async () => {
    const onSelect = jest.fn();
    await render(<WorkspaceSwitcher {...base} switching onSelect={onSelect} />);
    const items = screen.getAllByTestId('workspace-item');
    expect(items[0]!.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(items[0]!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('关闭：关闭按钮 / 遮罩 → onClose', async () => {
    const onClose = jest.fn();
    await render(<WorkspaceSwitcher {...base} onClose={onClose} />);
    await fireEvent.press(screen.getByTestId('workspace-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('workspace-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('空列表 → 引导文案「请先在桌面端添加项目工作区」（F4 §6.1）', async () => {
    await render(<WorkspaceSwitcher {...base} workspaces={[]} />);
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    expect(
      screen.getByText('请先在桌面端添加项目工作区（F4 §6.1）')
    ).toBeTruthy();
  });

  it('装载中 → workspace-loading', async () => {
    await render(
      <WorkspaceSwitcher {...base} status="loading" workspaces={null} />
    );
    expect(screen.getByTestId('workspace-loading')).toBeTruthy();
  });

  it('装载失败 → 错误文案 + 重试 → onRetry（F4-F03）', async () => {
    const onRetry = jest.fn();
    await render(
      <WorkspaceSwitcher
        {...base}
        status="error"
        errorCode="workspace_not_granted"
        workspaces={null}
        onRetry={onRetry}
      />
    );
    expect(screen.getByTestId('workspace-error')).toBeTruthy();
    expect(screen.getByText('工作区未授权')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('workspace-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
