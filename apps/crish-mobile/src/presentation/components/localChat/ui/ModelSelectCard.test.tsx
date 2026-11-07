// 模型选择卡片呈现契约（P3 选中点）：
// - 选中与未选的卡片边框恒为 hairline，不含 brand / actionPrimary 描边；
// - 选中标记是 size.dot 的 textPrimary 实心圆，未选是同尺寸 hairline 空心圆；
// - accessibilityRole="checkbox" 与 accessibilityState.checked 保留。
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { lightTheme } from '@/adapters/platform/theme';
import { ModelSelectCard } from './ModelSelectCard';

type FlatStyle = Record<string, unknown>;

/** 解析节点 style（数组 / 函数式 Pressable style 均摊平为单对象，未按下态） */
function flatStyleOf(node: { props: { style?: unknown } }): FlatStyle {
  const raw = node.props.style as unknown;
  const resolved =
    typeof raw === 'function'
      ? (raw as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : raw;
  return (StyleSheet.flatten(resolved as never) ?? {}) as FlatStyle;
}

describe('ModelSelectCard P3 契约', () => {
  it('选中：实心 textPrimary 点、卡边 hairline、checked 为 true', async () => {
    const view = await render(
      <ModelSelectCard
        id="m1"
        displayName="示例模型"
        selected
        onToggle={() => {}}
      />
    );
    const card = view.getByTestId('model-select-card-m1');
    expect(card.props.accessibilityRole).toBe('checkbox');
    expect(card.props.accessibilityState).toEqual({ checked: true });

    const cardStyle = flatStyleOf(card);
    expect(cardStyle.borderColor).toBe(lightTheme.colors.hairline);
    expect(cardStyle.borderColor).not.toBe(lightTheme.colors.brand);
    expect(cardStyle.borderColor).not.toBe(lightTheme.colors.actionPrimary);

    const dot = flatStyleOf(view.getByTestId('model-select-dot-m1'));
    expect(dot.width).toBe(lightTheme.size.dot);
    expect(dot.height).toBe(lightTheme.size.dot);
    expect(dot.backgroundColor).toBe(lightTheme.colors.textPrimary);
  });

  it('未选：hairline 空心点、卡边仍 hairline、checked 为 false', async () => {
    const view = await render(
      <ModelSelectCard id="m2" selected={false} onToggle={() => {}} />
    );
    const card = view.getByTestId('model-select-card-m2');
    expect(card.props.accessibilityRole).toBe('checkbox');
    expect(card.props.accessibilityState).toEqual({ checked: false });
    expect(flatStyleOf(card).borderColor).toBe(lightTheme.colors.hairline);

    const dot = flatStyleOf(view.getByTestId('model-select-dot-m2'));
    expect(dot.width).toBe(lightTheme.size.dot);
    expect(dot.height).toBe(lightTheme.size.dot);
    expect(dot.backgroundColor).toBe('transparent');
    expect(dot.borderColor).toBe(lightTheme.colors.hairline);
    expect(dot.borderWidth).toBe(1);
  });
});
