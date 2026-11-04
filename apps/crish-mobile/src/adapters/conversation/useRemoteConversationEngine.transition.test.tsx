import { act, render } from '@testing-library/react-native';
import { InteractionManager, View } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { ToastProvider } from '@/presentation/ui';
import { useRemoteConversationEngine } from './useRemoteConversationEngine';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
import * as appRuntime from '@/adapters/runtime/appRuntime';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';

jest.mock('@/adapters/runtime/appRuntime', () => {
  const actual = jest.requireActual('@/adapters/runtime/appRuntime');
  return {
    ...actual,
    ensureSessionHistory: jest.fn(),
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '测试会话',
    folder: '',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    updatedAt: 0,
    messageCount: 0,
    receivedAtMs: 0,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

describe('useRemoteConversationEngine 会话两阶段挂载（方案 21 性能铁律）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStore.setState({ sessions: [session()], selectedSessionId: 's-1' });
    eventStore.setState({
      windows: {
        's-1': {
          sessionId: 's-1',
          lastSeq: 5,
          entries: [
            {
              type: 'message-end',
              sessionId: 's-1',
              sequence: 1,
              message: {
                id: 'm-1',
                role: 'user',
                blocks: [{ type: 'text', text: '1' }],
              },
              receivedAtMs: 1000,
            },
            {
              type: 'message-end',
              sessionId: 's-1',
              sequence: 2,
              message: {
                id: 'm-2',
                role: 'assistant',
                blocks: [{ type: 'text', text: '2' }],
              },
              receivedAtMs: 2000,
            },
            {
              type: 'message-end',
              sessionId: 's-1',
              sequence: 3,
              message: {
                id: 'm-3',
                role: 'user',
                blocks: [{ type: 'text', text: '3' }],
              },
              receivedAtMs: 3000,
            },
            {
              type: 'message-end',
              sessionId: 's-1',
              sequence: 4,
              message: {
                id: 'm-4',
                role: 'assistant',
                blocks: [{ type: 'text', text: '4' }],
              },
              receivedAtMs: 4000,
            },
            {
              type: 'message-end',
              sessionId: 's-1',
              sequence: 5,
              message: {
                id: 'm-5',
                role: 'user',
                blocks: [{ type: 'text', text: '5' }],
              },
              receivedAtMs: 5000,
            },
          ],
        } as never,
      },
    });
  });

  it('Phase 1 转场未落定前轻量化挂载，Phase 2 落定后触发 ensureSessionHistory 并全量渲染', async () => {
    let interactionCallback: (() => void) | null = null;
    jest
      .spyOn(InteractionManager, 'runAfterInteractions')
      .mockImplementation((cb: any) => {
        interactionCallback = cb;
        return { cancel: jest.fn(), done: jest.fn() } as never;
      });

    let currentEngine: any = null;
    function Probe() {
      currentEngine = useRemoteConversationEngine(
        's-1',
        {},
        { follow: false, onSendSuccess: jest.fn() }
      );
      return <View testID="probe" />;
    }

    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <Probe />
        </ToastProvider>
      </SafeAreaProvider>
    );

    // Phase 1：转场未落定
    // - ensureSessionHistory 尚未调用，为抽屉平移动画让出 I/O 与 JS 线程
    expect(appRuntime.ensureSessionHistory).not.toHaveBeenCalled();
    // - timeline blocks 仅包含最后 3 条条目，削减首帧构建与排版耗时
    expect(currentEngine?.blocks).toHaveLength(3);

    // Phase 2：转场动画落定（InteractionManager 释放）
    await act(async () => {
      interactionCallback?.();
    });

    // - ensureSessionHistory 立即触发
    expect(appRuntime.ensureSessionHistory).toHaveBeenCalledWith('s-1');
    // - timeline blocks 恢复为全量 5 条条目
    expect(currentEngine?.blocks).toHaveLength(5);
  });
});
