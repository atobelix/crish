// UserMessageRow 单元测试：气泡结构、入场动画与无障碍减动效。
import { render } from '@testing-library/react-native';
import { UserMessageRow } from './UserMessageRow';

const mockUseReducedMotion = jest.fn(() => false);
jest.mock('@/adapters/platform/useReducedMotion', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

describe('UserMessageRow', () => {
  beforeEach(() => {
    mockUseReducedMotion.mockReturnValue(false);
  });

  it('渲染用户文本与气泡基础结构', async () => {
    const view = await render(<UserMessageRow id="msg-1" text="你好，世界" />);
    expect(view.getByText('你好，世界')).toBeTruthy();
    expect(view.getByTestId('user-message-msg-1')).toBeTruthy();
    expect(view.getByTestId('user-message-msg-1-bubble')).toBeTruthy();
  });

  it('默认无进场动画时以瞬态落位呈现', async () => {
    const view = await render(
      <UserMessageRow id="msg-static" text="历史消息" animateEntry={false} />
    );
    const bubble = view.getByTestId('user-message-msg-static-bubble');
    expect(bubble).toBeTruthy();
  });

  it('开启 animateEntry 时挂载入场动效', async () => {
    const view = await render(
      <UserMessageRow id="msg-fly" text="新发送的消息" animateEntry />
    );
    const bubble = view.getByTestId('user-message-msg-fly-bubble');
    expect(bubble).toBeTruthy();
    expect(view.getByText('新发送的消息')).toBeTruthy();
  });

  it('开启减弱动态（useReducedMotion=true）时优雅降级为即时呈现', async () => {
    mockUseReducedMotion.mockReturnValue(true);
    const view = await render(
      <UserMessageRow id="msg-reduced" text="减动效消息" animateEntry />
    );
    expect(view.getByText('减动效消息')).toBeTruthy();
  });
});
