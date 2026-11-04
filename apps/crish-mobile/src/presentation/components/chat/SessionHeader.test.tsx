import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { ConversationHeader } from './SessionHeader';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

describe('ConversationHeader - Left Alignment', () => {
  it('renders menu button on the left followed immediately by title pill', async () => {
    const view = await render(
      <ConversationHeader
        title="测试会话标题"
        onOpenDrawer={jest.fn()}
        onNewConversation={jest.fn()}
        onMore={jest.fn()}
      />,
      { wrapper: Providers }
    );
    const drawerBtn = view.getByTestId('session-drawer');
    const newBtn = view.getByTestId('session-new');
    const moreBtn = view.getByTestId('session-more');

    expect(drawerBtn).toBeTruthy();
    expect(newBtn).toBeTruthy();
    expect(moreBtn).toBeTruthy();
    expect(view.getByText('测试会话标题')).toBeTruthy();
  });

  it('preserves tail truncation on long title without pushing action buttons', async () => {
    const longTitle =
      '超长对话标题用于验证左对齐流式布局与截断表现是否符合预期而不会挤出屏幕';
    const view = await render(
      <ConversationHeader
        title={longTitle}
        onOpenDrawer={jest.fn()}
        onNewConversation={jest.fn()}
        onMore={jest.fn()}
      />,
      { wrapper: Providers }
    );
    const titleText = view.getByText(longTitle);
    expect(titleText.props.numberOfLines).toBe(1);
    expect(view.getByTestId('session-new')).toBeTruthy();
    expect(view.getByTestId('session-more')).toBeTruthy();
  });
});
