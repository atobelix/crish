import { act, fireEvent, render } from '@testing-library/react-native';
import { Keyboard, Platform, TextInput, View } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { dismissKeyboardAndBlur } from './drawerFocus';
import { CrishDrawerLayout } from './CrishDrawerLayout';
import { CrishDrawerContent } from './CrishDrawerContent';
import {
  DrawerControllerContext,
  type DrawerController,
  useDrawerActions,
} from './DrawerContext';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { sessionStore } from '@/domain/store/sessionStore';

jest.mock('expo-router', () => ({
  usePathname: () => '/',
  router: { navigate: jest.fn(), push: jest.fn() },
}));

jest.mock('@/adapters/viewmodels/useSessionListVm', () => ({
  useSessionListVm: () => ({
    partition: 'local',
    partitionLabel: '本机',
    today: [],
    earlier: [],
    query: '',
    setQuery: jest.fn(),
    windows: { stale: false },
    remoteTotal: 0,
    localTotal: 0,
    hasSessions: false,
    connected: false,
    refresh: jest.fn(),
    syncStatus: 'ok',
    lastReconcileAt: null,
    localHydrated: true,
  }),
}));

jest.mock('@/presentation/components/sessions/useSessionOpsController', () => ({
  useSessionOpsController: () => ({
    layer: null,
    openActions: jest.fn(),
  }),
}));

jest.mock(
  '@/presentation/components/sessions/useLocalThreadOpsController',
  () => ({
    useLocalThreadOpsController: () => ({
      layer: null,
      openActions: jest.fn(),
    }),
  })
);

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

const openController: DrawerController = {
  isOpen: true,
  open: jest.fn(),
  close: jest.fn(),
  closeImmediate: jest.fn(),
};

function OpenDrawerWrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <DrawerControllerContext.Provider value={openController}>
        {children}
      </DrawerControllerContext.Provider>
    </SafeAreaProvider>
  );
}

describe('drawerFocus 焦点与键盘清理门面', () => {
  it('dismissKeyboardAndBlur 调用 Keyboard.dismiss', () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');
    try {
      dismissKeyboardAndBlur();
      expect(dismissSpy).toHaveBeenCalledTimes(1);
    } finally {
      dismissSpy.mockRestore();
    }
  });

  it('Web 环境下 dismissKeyboardAndBlur 主动调用 activeElement.blur', () => {
    const origOS = Platform.OS;
    const mockBlur = jest.fn();
    const fakeElement = { blur: mockBlur };
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const originalDoc = (globalThis as unknown as { document?: unknown })
      .document;
    (globalThis as unknown as { document?: unknown }).document = {
      activeElement: fakeElement,
    };
    try {
      dismissKeyboardAndBlur();
      expect(mockBlur).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Platform, 'OS', {
        value: origOS,
        configurable: true,
      });
      (globalThis as unknown as { document?: unknown }).document = originalDoc;
    }
  });
});

describe('CrishDrawerLayout 键盘与焦点防御', () => {
  function TestConsumer() {
    const actions = useDrawerActions();
    return (
      <View>
        <TextInput testID="main-input" />
        <View testID="trigger-close" onTouchStart={() => actions.close()} />
        <View
          testID="trigger-close-immediate"
          onTouchStart={() => actions.closeImmediate()}
        />
      </View>
    );
  }

  it('actions.close 与 actions.closeImmediate 会触发 Keyboard.dismiss', async () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await render(
        <CrishDrawerLayout>
          <TestConsumer />
        </CrishDrawerLayout>,
        { wrapper: Wrapper }
      );
      await fireEvent(view.getByTestId('trigger-close'), 'touchStart');
      expect(dismissSpy).toHaveBeenCalledTimes(1);

      await fireEvent(
        view.getByTestId('trigger-close-immediate'),
        'touchStart'
      );
      expect(dismissSpy).toHaveBeenCalledTimes(2);
    } finally {
      dismissSpy.mockRestore();
    }
  });

  it('点击遮罩层 tapDismiss 触发收起与 Keyboard.dismiss', async () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await render(
        <CrishDrawerLayout>
          <TestConsumer />
        </CrishDrawerLayout>,
        { wrapper: Wrapper }
      );
      const tapDismiss = view.getByTestId('drawer-tap-dismiss');
      await fireEvent(tapDismiss, 'touchStart');
      expect(dismissSpy).toHaveBeenCalledTimes(1);
    } finally {
      dismissSpy.mockRestore();
    }
  });
});

describe('CrishDrawerContent 搜索框焦点与键盘收起', () => {
  it('点击搜索胶囊展开搜索框，点击取消按钮立即收起键盘与清空焦点', async () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await render(<CrishDrawerContent />, {
        wrapper: OpenDrawerWrapper,
      });
      // 初始常态：未展开搜索框
      expect(view.queryByTestId('drawer-search')).toBeNull();

      // 点击展开搜索
      await act(async () => {
        await fireEvent.press(view.getByTestId('drawer-search-pill'));
      });
      const input = view.getByTestId('drawer-search');
      expect(input).toBeTruthy();

      // 点击取消搜索
      await act(async () => {
        await fireEvent.press(view.getByTestId('drawer-search-cancel'));
      });
      expect(dismissSpy).toHaveBeenCalled();
      // 搜索框收拢
      expect(view.queryByTestId('drawer-search')).toBeNull();
    } finally {
      dismissSpy.mockRestore();
    }
  });

  it('抽屉触发关闭时，注册的关闭监听器立即收起搜索框并收起键盘', async () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');
    let triggerClose: (() => void) | undefined;
    const registerCloseListener = (cb: () => void) => {
      triggerClose = cb;
      return () => {
        triggerClose = undefined;
      };
    };

    try {
      const view = await render(
        <CrishDrawerContent registerCloseListener={registerCloseListener} />,
        { wrapper: OpenDrawerWrapper }
      );

      // 展开搜索态
      await act(async () => {
        await fireEvent.press(view.getByTestId('drawer-search-pill'));
      });
      expect(view.getByTestId('drawer-search')).toBeTruthy();

      // 抽屉触发关闭
      await act(async () => {
        triggerClose?.();
      });

      expect(dismissSpy).toHaveBeenCalled();
      expect(view.queryByTestId('drawer-search')).toBeNull();
    } finally {
      dismissSpy.mockRestore();
    }
  });

  it('输入框失焦 (blur) 时主动调用 dismissKeyboardAndBlur', async () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await render(<CrishDrawerContent />, {
        wrapper: OpenDrawerWrapper,
      });
      await act(async () => {
        await fireEvent.press(view.getByTestId('drawer-search-pill'));
      });
      const input = view.getByTestId('drawer-search');
      await fireEvent(input, 'blur');
      expect(dismissSpy).toHaveBeenCalled();
    } finally {
      dismissSpy.mockRestore();
    }
  });
});

describe('CrishDrawerContent 新建对话协议接入 (维度 1)', () => {
  it('点击抽屉底部新建对话，触发双模槽位重置、收起抽屉并导航至主屏', async () => {
    // 注入历史活动状态
    localChatSessionStore.setState({
      threads: [
        {
          id: 'lth-1',
          title: '旧会话',
          titleSource: 'derived',
          preview: '',
          modelRef: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeThreadId: 'lth-1',
      messages: [{ id: 'm-1', role: 'user', content: '旧提问' }],
      streaming: false,
      error: null,
      inactive: {},
    });
    sessionStore.setState({ selectedSessionId: 's-remote-1' });

    const view = await render(<CrishDrawerContent />, {
      wrapper: OpenDrawerWrapper,
    });

    const newChatBtn = view.getByTestId('drawer-new-chat');
    await act(async () => {
      await fireEvent.press(newChatBtn);
    });

    // 验证本地槽位已重置
    expect(localChatSessionStore.getState().activeThreadId).toBeNull();
    expect(localChatSessionStore.getState().messages).toEqual([]);

    // 验证远端选中已清空
    expect(sessionStore.getState().selectedSessionId).toBeNull();

    // 验证抽屉收起
    expect(openController.close).toHaveBeenCalled();
  });
});
