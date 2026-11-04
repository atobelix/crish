// 本地线程行生成态（S4）：生成中呈现呼吸点 + 「生成中…」；未生成时
// 两者皆无（只有当前运行的行带动态指示，其余静止——同桌面纪律）。
import { render } from '@testing-library/react-native';
import { LocalChatHubRow } from './LocalChatHubRow';

const baseProps = {
  threadId: 't-1',
  title: '本地线程',
  snippet: '摘要文本',
  time: '刚刚',
  onPress: jest.fn(),
};

describe('LocalChatHubRow 生成态', () => {
  it('生成中：呼吸点 + 生成文案在位', async () => {
    const view = await render(<LocalChatHubRow {...baseProps} streaming />);
    expect(view.getByTestId('chat-item-local-running-t-1')).toBeTruthy();
    expect(view.getByText('生成中…')).toBeTruthy();
  });

  it('未生成：无呼吸点、无生成文案', async () => {
    const view = await render(
      <LocalChatHubRow {...baseProps} streaming={false} />
    );
    expect(view.queryByTestId('chat-item-local-running-t-1')).toBeNull();
    expect(view.queryByText('生成中…')).toBeNull();
  });
});
