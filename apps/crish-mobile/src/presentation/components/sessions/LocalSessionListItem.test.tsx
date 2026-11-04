// 本地线程行（抽屉本地分区）：标题在位、行上无「本地」标识（分区
// 口径：身份由会话区标题表达）；生成中呼吸点在位、未生成时无；
// 点按/长按回传 threadId。
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import type { LocalThreadMeta } from '@/domain/types/localChat';
import { LocalSessionListItem } from './LocalSessionListItem';

function thread(overrides: Partial<LocalThreadMeta> = {}): LocalThreadMeta {
  return {
    id: 'lth-1',
    title: '本地线程标题',
    titleSource: 'derived',
    preview: '',
    modelRef: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe('LocalSessionListItem', () => {
  it('标题在位、行上无「本地」标识，未生成时无呼吸点', async () => {
    const view = await render(
      <LocalSessionListItem
        thread={thread()}
        streaming={false}
        onPress={jest.fn()}
      />
    );
    expect(view.getByTestId('local-row-lth-1')).toBeTruthy();
    expect(view.getByText('本地线程标题')).toBeTruthy();
    expect(view.queryByTestId('local-row-badge-lth-1')).toBeNull();
    expect(view.queryByText('本地')).toBeNull();
    expect(view.queryByTestId('local-running')).toBeNull();
  });

  it('生成中：呼吸点在位', async () => {
    const view = await render(
      <LocalSessionListItem thread={thread()} streaming onPress={jest.fn()} />
    );
    expect(view.getByTestId('local-running')).toBeTruthy();
  });

  it('失败态（批 D）：失败徽标在位、无障碍标签带失败语义', async () => {
    const view = await render(
      <LocalSessionListItem
        thread={thread()}
        streaming={false}
        failed
        onPress={jest.fn()}
      />
    );
    expect(view.getByTestId('local-failed-badge')).toBeTruthy();
    expect(view.getByText('失败')).toBeTruthy();
    expect(
      view.getByTestId('local-row-lth-1').props.accessibilityLabel
    ).toContain('上次生成失败');
  });

  it('生成中压过失败残留：只出呼吸点不出失败徽标', async () => {
    const view = await render(
      <LocalSessionListItem
        thread={thread()}
        streaming
        failed
        onPress={jest.fn()}
      />
    );
    expect(view.getByTestId('local-running')).toBeTruthy();
    expect(view.queryByTestId('local-failed-badge')).toBeNull();
  });

  it('点按与长按回传 threadId', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const view = await render(
      <LocalSessionListItem
        thread={thread()}
        streaming={false}
        onPress={onPress}
        onLongPress={onLongPress}
      />
    );
    await fireEvent.press(view.getByTestId('local-row-lth-1'));
    expect(onPress).toHaveBeenCalledWith('lth-1');
    await fireEvent(view.getByTestId('local-row-lth-1'), 'longPress');
    expect(onLongPress).toHaveBeenCalledWith('lth-1');
  });

  it('空标题回落占位标题「新对话」', async () => {
    const view = await render(
      <LocalSessionListItem
        thread={thread({ title: '  ' })}
        streaming={false}
        onPress={jest.fn()}
      />
    );
    expect(view.getByText('新对话')).toBeTruthy();
  });

  it('未选中状态下背景色恒为 transparent，文字字重为 500', async () => {
    const view = await render(
      <LocalSessionListItem
        thread={thread({ id: 'lth-view-1', title: '本地测试会话' })}
        streaming={false}
        selected={false}
        onPress={jest.fn()}
      />
    );
    const row = view.getByTestId('local-row-lth-view-1');
    expect(StyleSheet.flatten(row.props.style).backgroundColor).toBe(
      'transparent'
    );
    const title = view.getByText('本地测试会话');
    const flatTitleStyle = StyleSheet.flatten(title.props.style);
    expect(flatTitleStyle.fontWeight).toBe('500');
  });

  it('选中状态下背景色仍为 transparent，绝不添加 fillSelected 浅灰底色，字重提至 600', async () => {
    const view = await render(
      <LocalSessionListItem
        thread={thread({ id: 'lth-view-2', title: '本地聚焦会话' })}
        streaming={false}
        selected={true}
        onPress={jest.fn()}
      />
    );
    const row = view.getByTestId('local-row-lth-view-2');
    expect(StyleSheet.flatten(row.props.style).backgroundColor).toBe(
      'transparent'
    );
    // 选中态纯视觉字阶加粗断言
    const title = view.getByText('本地聚焦会话');
    const flatTitleStyle = StyleSheet.flatten(title.props.style);
    expect(flatTitleStyle.fontWeight).toBe('600');
  });
});
