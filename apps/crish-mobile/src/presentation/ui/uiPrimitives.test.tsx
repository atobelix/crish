// 设计系统原子测试：文本 / 图标 / 按钮 / 徽标 / 输入 / 列表行 / Sheet 选项行。
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { lightTheme } from '@/adapters/platform/theme';
import { AuthButton } from '@/presentation/account/ui';
import {
  AppText,
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  ListRow,
  SectionHeader,
  SheetOptionRow,
  Spinner,
  ToastProvider,
} from '@/presentation/ui';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

async function renderWithProviders(element: React.ReactElement) {
  return await render(element, { wrapper: Providers });
}

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

describe('text / icon', () => {
  it('renders text, icons and spinner', async () => {
    const view = await renderWithProviders(
      <>
        <AppText variant="largeTitle" color="danger">
          标题
        </AppText>
        <Icon name="menu" size={20} />
        <Spinner centered />
      </>
    );
    expect(view.getByText('标题')).toBeTruthy();
    expect(view.toJSON()).toBeTruthy();
  });

  it('caps system font scaling at 1.35 by default; explicit value wins', async () => {
    const view = await renderWithProviders(
      <>
        <AppText>默认上限</AppText>
        <AppText maxFontSizeMultiplier={2}>显式上限</AppText>
      </>
    );
    expect(view.getByText('默认上限').props.maxFontSizeMultiplier).toBe(1.35);
    expect(view.getByText('显式上限').props.maxFontSizeMultiplier).toBe(2);
  });
});

describe('Button', () => {
  it('handles press, variants, loading and disabled', async () => {
    const onPress = jest.fn();
    const view = await renderWithProviders(
      <>
        <Button label="连接" onPress={onPress} />
        <Button label="次" variant="secondary" onPress={onPress} />
        <Button label="危" variant="danger" onPress={onPress} />
        <Button label="透" variant="ghost" onPress={onPress} />
        <Button label="加载" loading onPress={onPress} />
        <Button label="禁用" disabled onPress={onPress} />
      </>
    );
    fireEvent.press(view.getByText('连接'));
    fireEvent.press(view.getByText('加载'));
    fireEvent.press(view.getByText('禁用'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('带文字主按钮填充 = actionPrimary 亮绿（用户裁决 2026-11-02，推翻 D3 深绿）', async () => {
    const view = await renderWithProviders(
      <>
        <Button label="主" testID="btn-primary" onPress={() => {}} />
        <AuthButton
          label="账号主"
          testID="btn-auth-primary"
          onPress={() => {}}
        />
      </>
    );
    // 钉住亮绿口径：填充取 actionPrimary 本值（浅色 #10b981），不得回退 brandStrong
    expect(flatStyleOf(view.getByTestId('btn-primary')).backgroundColor).toBe(
      lightTheme.colors.actionPrimary
    );
    expect(
      flatStyleOf(view.getByTestId('btn-auth-primary')).backgroundColor
    ).toBe(lightTheme.colors.actionPrimary);
    expect(lightTheme.colors.actionPrimary).toBe('#10b981');
  });
});

describe('IconButton / Badge', () => {
  it('renders badge cap and dot; hides zero', async () => {
    const onPress = jest.fn();
    const view = await renderWithProviders(
      <>
        <IconButton
          name="bell"
          accessibilityLabel="通知中心"
          badge={120}
          badgeCap={99}
          onPress={onPress}
        />
        <IconButton
          name="menu"
          variant="floating"
          accessibilityLabel="打开侧栏"
          onPress={onPress}
        />
        <Badge dot tone="accent" testID="badge-dot" />
        <Badge count={0} testID="badge-zero" />
      </>
    );
    fireEvent.press(view.getByLabelText('通知中心，120 条未读'));
    expect(onPress).toHaveBeenCalled();
    expect(view.getByText('99+')).toBeTruthy();
    expect(view.getByTestId('badge-dot')).toBeTruthy();
    expect(view.queryByTestId('badge-zero')).toBeNull();
  });
});

describe('Input / ListRow / SheetOptionRow', () => {
  it('renders input states and interactions', async () => {
    const onPress = jest.fn();
    const view = await renderWithProviders(
      <>
        <Input testID="input" label="主机" error="必填" />
        <Input testID="input-plain" />
        <Input testID="input-field" tone="field" />
        <ListRow
          title="桌面连接"
          subtitle="192.168.1.2:8765"
          onPress={onPress}
          showChevron
          trailing={<Badge dot />}
        />
        <ListRow title="静态" divider={false} />
        <SheetOptionRow testID="option-a" label="标准审批" onPress={onPress} />
        <SheetOptionRow
          testID="option-b"
          label="快速放行"
          selected
          onPress={onPress}
        />
        <SectionHeader title="连接" trailing="2" />
      </>
    );
    fireEvent(view.getByTestId('input'), 'focus');
    fireEvent(view.getByTestId('input'), 'blur');
    fireEvent.press(view.getByText('桌面连接'));
    fireEvent.press(view.getByTestId('option-a'));
    expect(onPress).toHaveBeenCalled();
    // 选中行以对号表达，不渲染第二行的对号
    expect(view.getByTestId('option-b')).toBeTruthy();
    expect(view.getByText('必填')).toBeTruthy();
    expect(view.getByText('静态')).toBeTruthy();
    expect(view.getByText('连接')).toBeTruthy();
    // 输入壳形态（2026-11-02）：默认 subtle 壳 = fillSubtle；tone="field" 档
    // 壳 = field 白盒（grouped 背景上的表单口径）。壳 = TextInput 的父节点
    // （Animated.View 透传的 View）；reanimated 桩下动画底色求值为静置端。
    // 注 1：壳断言并入本用例而非独立用例——本文件内第二个含 TextInput 的
    // render 在先行用例的 focus/press 之后按 testID 查找 TextInput 会落空
    // （bisect 实测的跨用例污染），故同批断言同居一例。
    // 注 2：subtle 断言取无错误态的 input-plain——带 error 的 input 壳按设计
    // 被 dangerSoft 静态底覆盖（错误态优先），不作静置底色样本。
    const subtleShell = view.getByTestId('input-plain').parent;
    const fieldShell = view.getByTestId('input-field').parent;
    expect(subtleShell).toBeTruthy();
    expect(fieldShell).toBeTruthy();
    expect(flatStyleOf(subtleShell!).backgroundColor).toBe(
      lightTheme.colors.fillSubtle
    );
    expect(flatStyleOf(fieldShell!).backgroundColor).toBe(
      lightTheme.colors.field
    );
  });
});
