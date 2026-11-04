// AuthField 整盒聚焦（2026-11-03 细修）：多行字段旧实现里输入框只占盒
// 顶部一行高、盒身其余面积无响应（「个性签名要点好几次」根因）。此组
// 用例钉住修复后的结构契约：盒身是可点按的 Pressable（testID 后缀 -box，
// 与 -eye / -error 同规），点按转发聚焦；多行盒 alignItems stretch 让
// 输入填满盒高、单行维持居中。
// 用例顺序有讲究（实测）：盒身点按会触发 TextInput 程序化聚焦，其全局
// 聚焦态残留会污染同一文件内后续渲染的查询（RNTL v14 + test-renderer
// 时序坑），故结构用例在前（无事件）、带点按的交互用例殿后。
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { AuthField } from './AuthField';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

/** 输入框是否被指定 testID 的盒包裹（向上走父链核对） */
function isWrappedBy(
  node: { parent: { props: Record<string, unknown>; parent: unknown } | null },
  boxTestID: string
): boolean {
  let current: { props: Record<string, unknown>; parent: unknown } | null =
    node.parent;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current.props.testID === boxTestID) return true;
    current = current.parent as typeof current;
  }
  return false;
}

describe('AuthField 整盒聚焦', () => {
  it('单行：盒身包裹输入，维持居中对齐', async () => {
    const view = await render(
      <AuthField
        label="用户昵称"
        testID="f-name"
        value=""
        onChangeText={jest.fn()}
        placeholder="昵称"
      />,
      { wrapper: Providers }
    );
    const box = view.getByTestId('f-name-box');
    expect(isWrappedBy(view.getByTestId('f-name'), 'f-name-box')).toBe(true);
    const flat = StyleSheet.flatten(box.props.style);
    expect(flat.alignItems).toBe('center');
    expect(flat.minHeight).toBeUndefined();
  });

  it('多行：盒身包裹输入，纵向拉伸填满 104 盒高', async () => {
    const view = await render(
      <AuthField
        label="个性签名"
        tall
        testID="f-bio"
        value=""
        onChangeText={jest.fn()}
        placeholder="简介"
      />,
      { wrapper: Providers }
    );
    const box = view.getByTestId('f-bio-box');
    expect(isWrappedBy(view.getByTestId('f-bio'), 'f-bio-box')).toBe(true);
    const flat = StyleSheet.flatten(box.props.style);
    expect(flat.alignItems).toBe('stretch');
    expect(flat.minHeight).toBe(104);
  });

  it('交互：点盒身后输入仍可正常录入（转发聚焦不吞输入）', async () => {
    const onChangeText = jest.fn();
    const view = await render(
      <AuthField
        label="个性签名"
        tall
        testID="g-bio"
        value=""
        onChangeText={onChangeText}
        placeholder="简介"
      />,
      { wrapper: Providers }
    );
    fireEvent.press(view.getByTestId('g-bio-box'));
    fireEvent.changeText(view.getByTestId('g-bio'), '你好');
    expect(onChangeText).toHaveBeenCalledWith('你好');
  });
});
