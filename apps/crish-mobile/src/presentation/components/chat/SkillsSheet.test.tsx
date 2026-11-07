import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { SkillEntry } from '@crish/shared-types';
import { SkillsSheet, type SkillsSheetProps } from './SkillsSheet';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function skill(index: number, scope = 'user'): SkillEntry {
  return {
    id: `skill-${index}`,
    name: `技能 ${index}`,
    description: `说明 ${index}`,
    scope,
    system: index === 0,
  };
}

function renderSheet(props: Partial<SkillsSheetProps> = {}) {
  return render(
    <SkillsSheet
      visible
      onClose={jest.fn()}
      connected
      skills={[skill(0), skill(1)]}
      status="loaded"
      errorCode={null}
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

describe('SkillsSheet 状态分支', () => {
  it('未连接、加载、失败、空列表分开呈现', async () => {
    const offline = await renderSheet({ connected: false, skills: null });
    expect(offline.getByText('未连接桌面')).toBeTruthy();
    expect(offline.queryByText(/无法获取技能列表/)).toBeNull();

    const loading = await renderSheet({ status: 'loading', skills: null });
    expect(loading.getByText('加载中…')).toBeTruthy();

    const onRetry = jest.fn();
    const failed = await renderSheet({
      status: 'error',
      skills: null,
      errorCode: 'cmd.timeout',
      onRetry,
    });
    expect(failed.getByText('无法获取技能列表（cmd.timeout）')).toBeTruthy();
    await fireEvent.press(failed.getByText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    const empty = await renderSheet({ status: 'loaded', skills: [] });
    expect(empty.getByText('桌面端暂无技能')).toBeTruthy();
    expect(empty.queryByTestId('skills-sheet-list')).toBeNull();
  });
});

describe('SkillsSheet 虚拟化', () => {
  it('长列表首屏挂载有界，作用域标题仍在', async () => {
    const skills = [
      ...Array.from({ length: 20 }, (_, index) => skill(index, 'user')),
      ...Array.from({ length: 20 }, (_, index) => skill(index + 20, 'project')),
    ];
    const view = await renderSheet({ skills });
    const list = view.getByTestId('skills-sheet-list');
    const style = StyleSheet.flatten(list.props.style);
    expect(style.height).toEqual(expect.any(Number));
    expect(list.props.initialNumToRender).toBeLessThan(skills.length);
    expect(view.getByText('当前项目')).toBeTruthy();
    expect(view.getByText('技能 20')).toBeTruthy();
    expect(view.queryByText('技能 0')).toBeNull();
    expect(view.queryByText('技能 39')).toBeNull();
    const rendered = view.getAllByTestId(/^skills-sheet-skill-/);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(skills.length);
  });

  it('关闭回调仍由面板承接', async () => {
    const onClose = jest.fn();
    const view = await renderSheet({ onClose });
    await fireEvent.press(view.getByTestId('sheet-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
