// 布局原子测试：Screen / Card / EmptyState / AppHeader / ScrollToBottomButton。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import {
  AppHeader,
  AppText,
  Badge,
  Card,
  EmptyState,
  Screen,
  ScrollToBottomButton,
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

describe('layout atoms', () => {
  it('renders screen, card, empty state, header and scroll button', async () => {
    const onBack = jest.fn();
    const onScroll = jest.fn();
    const view = await render(
      <>
        <Screen topInset bottomInset>
          <Card>
            <AppText>卡片</AppText>
          </Card>
        </Screen>
        <EmptyState title="还没有会话" action={<Badge dot />} />
        <AppHeader large title="首页" actions={<Badge dot />} />
        <AppHeader
          title="详情"
          onBack={onBack}
          status={<AppText>运行中</AppText>}
        />
        <ScrollToBottomButton onPress={onScroll} testID="bottom" />
      </>,
      { wrapper: Providers }
    );
    fireEvent.press(view.getByTestId('header-back'));
    fireEvent.press(view.getByTestId('bottom'));
    expect(onBack).toHaveBeenCalled();
    expect(onScroll).toHaveBeenCalled();
    expect(view.getByText('卡片')).toBeTruthy();
    expect(view.getByText('还没有会话')).toBeTruthy();
    expect(view.getByText('运行中')).toBeTruthy();
  });
});
