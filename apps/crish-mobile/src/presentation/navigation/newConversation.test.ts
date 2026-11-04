// 全局新建会话协议原语单测（维度 1 根治，2026-11-04 裁决）
import { router } from 'expo-router';
import { renderHook, act } from '@testing-library/react-native';
import { executeNewConversation, useNewConversation } from './newConversation';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import * as drawerContextModule from '@/presentation/components/drawer/DrawerContext';

jest.mock('expo-router', () => ({
  router: {
    navigate: jest.fn(),
  },
}));

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

  describe('executeNewConversation (命令式原语)', () => {
    it('执行槽位重置并导航至主屏', () => {
      executeNewConversation();

      // 本地状态清空且归拢
      const localState = localChatSessionStore.getState();
      expect(localState.activeThreadId).toBeNull();
      expect(localState.messages).toEqual([]);
      expect(localState.inactive['lth-1']?.messages).toHaveLength(1);

      // 远端状态清空
      expect(sessionStore.getState().selectedSessionId).toBeNull();

      // 导航回主屏
      expect(router.navigate).toHaveBeenCalledWith('/');
    });
  });

  describe('useNewConversation (响应式 Hook)', () => {
    it('不传 closeDrawer 时重置槽位并导航，不调用抽屉关闭', async () => {
      const { result } = await renderHook(() => useNewConversation());

      await act(async () => {
        result.current();
      });

      expect(localChatSessionStore.getState().activeThreadId).toBeNull();
      expect(sessionStore.getState().selectedSessionId).toBeNull();
      expect(mockClose).not.toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith('/');
    });

    it('传入 closeDrawer: true 时，平滑关闭抽屉、重置槽位并导航', async () => {
      const { result } = await renderHook(() => useNewConversation());

      await act(async () => {
        result.current({ closeDrawer: true });
      });

      expect(localChatSessionStore.getState().activeThreadId).toBeNull();
      expect(sessionStore.getState().selectedSessionId).toBeNull();
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledWith('/');
    });
  });
});
