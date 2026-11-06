// 全局新建会话协议单测（2026-11-05 修订版裁决：新建 = 双模槽位重置 +
// 回主页新对话面；draft 伪路由与命令式导出已删除，防污染不变量保留）
import { router } from 'expo-router';
import { renderHook, act } from '@testing-library/react-native';
import { useNewConversation } from './newConversation';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import * as drawerContextModule from '@/presentation/components/drawer/DrawerContext';

jest.mock('expo-router', () => ({
  router: {
    navigate: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: jest.fn(),
  },
}));

const canGoBackMock = router.canGoBack as jest.Mock;
const dismissToMock = router.dismissTo as jest.Mock;
const navigateMock = router.navigate as jest.Mock;

describe('newConversation 协议原语', () => {
  const mockClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    localChatSessionStore.setState({
      threads: [
        {
          id: 'lth-1',
          title: '旧会话',
          titleSource: 'derived',
          preview: '旧预览',
          modelRef: null,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      activeThreadId: 'lth-1',
      messages: [{ id: 'm-1', role: 'user', content: '旧消息' }],
      streaming: false,
      error: null,
      inactive: {},
    });
    sessionStore.setState({
      selectedSessionId: 'remote-session-1',
    });
    jest.spyOn(drawerContextModule, 'useDrawerActions').mockReturnValue({
      open: jest.fn(),
      close: mockClose,
      closeImmediate: jest.fn(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('useNewConversation (唯一入口 Hook)', () => {
    it('执行双模槽位重置并导航回主页新对话面，不调用抽屉关闭', async () => {
      // 深链单屏栈口径：栈内无主页（canGoBack = false）→ navigate 落点
      canGoBackMock.mockReturnValue(false);
      const { result } = await renderHook(() => useNewConversation());

      await act(async () => {
        result.current();
      });

      // 本地状态清空且归拢（防历史污染不变量）
      const localState = localChatSessionStore.getState();
      expect(localState.activeThreadId).toBeNull();
      expect(localState.messages).toEqual([]);
      expect(localState.inactive['lth-1']?.messages).toHaveLength(1);

      // 远端状态清空
      expect(sessionStore.getState().selectedSessionId).toBeNull();

      // 落点 = 主页新对话面（设备维度由主页 CON-2 派生承担）
      expect(mockClose).not.toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('/');
      expect(dismissToMock).not.toHaveBeenCalled();
    });

    it('传入 closeDrawer: true 时，重置槽位、平滑关闭抽屉并回主页', async () => {
      canGoBackMock.mockReturnValue(false);
      const { result } = await renderHook(() => useNewConversation());

      await act(async () => {
        result.current({ closeDrawer: true });
      });

      expect(localChatSessionStore.getState().activeThreadId).toBeNull();
      expect(sessionStore.getState().selectedSessionId).toBeNull();
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith('/');
      expect(dismissToMock).not.toHaveBeenCalled();
    });

    it('栈中已有主页（canGoBack = true）时走 dismissTo 弹栈回主页，不 navigate 压栈', async () => {
      canGoBackMock.mockReturnValue(true);
      const { result } = await renderHook(() => useNewConversation());

      await act(async () => {
        result.current();
      });

      expect(localChatSessionStore.getState().activeThreadId).toBeNull();
      expect(sessionStore.getState().selectedSessionId).toBeNull();
      expect(dismissToMock).toHaveBeenCalledWith('/');
      expect(navigateMock).not.toHaveBeenCalled();
    });
  });
});
