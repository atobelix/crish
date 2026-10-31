// 设计系统原子测试：文本 / 图标 / 按钮 / 徽标 / 输入 / 列表行。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import {
  AppText,
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  ListRow,
  SectionHeader,
  SegmentedControl,
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

describe('Input / ListRow / SegmentedControl', () => {
  it('renders input states and interactions', async () => {
    const onPress = jest.fn();
    const onChange = jest.fn();
    const view = await renderWithProviders(
      <>
        <Input testID="input" label="主机" error="必填" />
        <ListRow
          title="桌面连接"
          subtitle="192.168.1.2:8765"
          onPress={onPress}
          showChevron
          trailing={<Badge dot />}
        />
        <ListRow title="静态" divider={false} />
        <SegmentedControl
          options={[
            { value: 'system', label: '跟随系统' },
            { value: 'dark', label: '深色' },
          ]}
          value="system"
          onChange={onChange}
        />
        <SectionHeader title="连接" trailing="2" />
      </>
    );
    fireEvent(view.getByTestId('input'), 'focus');
    fireEvent(view.getByTestId('input'), 'blur');
    fireEvent.press(view.getByText('桌面连接'));
    fireEvent.press(view.getByText('深色'));
    expect(onPress).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('dark');
    expect(view.getByText('必填')).toBeTruthy();
    expect(view.getByText('静态')).toBeTruthy();
    expect(view.getByText('连接')).toBeTruthy();
  });
});
