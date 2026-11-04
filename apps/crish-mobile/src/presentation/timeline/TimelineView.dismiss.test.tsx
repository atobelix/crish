// 时间线点外失焦（2026-11-03 用户实测：点会话内容区输入框不失焦、
// 键盘不退下）：TimelineView 的 FlatList 以 onTouchStart 被动通知收
// 键盘——触摸落在列表子树（行/空白/空态）即 Keyboard.dismiss；本路
// 不认领 responder，行内点按/长按语义照常（此处只钉 dismiss 接线，
// 语义不回归由既有时间线/宿主套件覆盖）。Composer 是宿主侧兄弟浮
// 层、不在本子树内，其控件永不触发本路（宿主级反例见
// conversationScreen.slots.test 的点外失焦用例）。
import { Keyboard } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { TimelineView } from './TimelineView';
import type { TimelineBlock } from './buildTimeline';
import { ToastProvider } from '@/presentation/ui';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const blocks: TimelineBlock[] = [
  {
    kind: 'message',
    id: 'm-1',
    role: 'assistant',
    text: '一条消息',
    streaming: false,
  } as TimelineBlock,
];

async function wrap(element: React.ReactElement) {
  return render(element, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>{children}</ToastProvider>
      </SafeAreaProvider>
    ),
  });
}

describe('TimelineView 点外失焦', () => {
  it('点时间线本体 → Keyboard.dismiss 被调用', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await wrap(
        <TimelineView blocks={blocks} follow onFollowChange={() => undefined} />
      );
      await fireEvent(view.getByTestId('session-timeline'), 'touchStart');
      expect(dismiss).toHaveBeenCalledTimes(1);
      await view.unmount();
    } finally {
      dismiss.mockRestore();
    }
  });

  it('点消息行 → 同样收键盘（触摸自子行冒泡到列表的被动通知）', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await wrap(
        <TimelineView blocks={blocks} follow onFollowChange={() => undefined} />
      );
      await fireEvent(view.getByText('一条消息'), 'touchStart');
      expect(dismiss).toHaveBeenCalledTimes(1);
      await view.unmount();
    } finally {
      dismiss.mockRestore();
    }
  });

  it('空态（无消息行）点列表 → 仍收键盘（空态在列表子树内）', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await wrap(
        <TimelineView blocks={[]} follow onFollowChange={() => undefined} />
      );
      await fireEvent(view.getByTestId('session-timeline'), 'touchStart');
      expect(dismiss).toHaveBeenCalledTimes(1);
      await view.unmount();
    } finally {
      dismiss.mockRestore();
    }
  });
});
