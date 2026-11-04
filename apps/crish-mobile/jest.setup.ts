// 全局测试 setup（D8 §5.2.2 / M5 §2.1 jest.setup.ts / M5 §10.4.5-6）
// expo 原生模块 mock（R-3 落地）：jest 环境无原生模块——
// - expo-secure-store：内存 Map 实现（语义对齐：读缺失 null / 删不存在静默），
//   每个测试前自动清空（本文件注册全局 beforeEach，隔离跨用例污染）；
// - expo-sqlite：openDatabaseAsync 桩（当前驱动层仅类型导入，运行时不经由
//   expo-sqlite；桩保留供后续 SQLiteProvider 接入与集成测试使用）。
// jest.mock 工厂仅允许引用以 mock 前缀命名的外部变量（jest 提升校验）。
// expo-notifications mock（R3-04 通知层）：jest 环境无原生模块——通道注册 /
// 权限查询请求 / handler / 监听全部以 jest.fn 桩替身；AndroidImportance 按
// SDK 57 枚举值提供（channels.ts 以值导入）。各测试按需 mockImplementation。
// 工厂内取 react / react-native 统一走 jest.requireActual（类型化、合规），
// 不用裸 require；顶层仅引入类型（编译期擦除，不受 jest.mock 提升影响）。
import type * as ReactModule from 'react';
import type { ReactNode } from 'react';
import type * as ReactNativeModule from 'react-native';

const mockNotificationsApi = {
  AndroidImportance: {
    UNKNOWN: 0,
    UNSPECIFIED: 1,
    NONE: 2,
    MIN: 3,
    LOW: 4,
    DEFAULT: 5,
    HIGH: 6,
    MAX: 7,
  },
  getPermissionsAsync: jest.fn(async () => ({
    status: 'undetermined',
    granted: false,
    canAskAgain: true,
    expires: 'never',
  })),
  requestPermissionsAsync: jest.fn(async () => ({
    status: 'granted',
    granted: true,
    canAskAgain: true,
    expires: 'never',
  })),
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(async () => 'mock-notification-id'),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
};

jest.mock('expo-notifications', () => mockNotificationsApi);

// expo-haptics mock（手感基建批）：jest 环境无原生触感模块——语义函数全部
// 静默桩；触觉门面自身的映射/静默断言在 adapters/platform/haptics.test.ts
// 以本地 jest.mock 精确哨兵覆盖。
jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: {
    Light: 'light',
    Medium: 'medium',
    Heavy: 'heavy',
    Rigid: 'rigid',
    Soft: 'soft',
  },
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
    Error: 'error',
  },
  selectionAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
}));

// react-native-keyboard-controller mock：jest 环境无原生键盘模块——用库自带
// 的 jest 替身（组件透传为 View / ScrollView、useKeyboardState 走静态收起态），
// 与真机保持同一导入面。避让契约的 props 级断言在
// src/__tests__/keyboardAvoidance.guard.test.tsx 内以本地 jest.mock 哨兵覆盖。
jest.mock('react-native-keyboard-controller', () =>
  jest.requireActual('react-native-keyboard-controller/jest')
);

const mockSecureStoreData = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(
    async (key: string) => mockSecureStoreData.get(key) ?? null
  ),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStoreData.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStoreData.delete(key);
  }),
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => {}),
    getFirstAsync: jest.fn(async () => null),
    getAllAsync: jest.fn(async () => []),
    withTransactionAsync: jest.fn(async () => {}),
    prepareAsync: jest.fn(async () => ({
      executeAsync: jest.fn(async () => ({})),
      finalizeAsync: jest.fn(async () => {}),
    })),
  })),
}));

jest.mock('react-native-gesture-handler', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  // 链式手势配置桩：任意方法调用返回代理自身（生产 API 为链式 builder）
  const chainable = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    const proxy = new Proxy(obj, {
      get: (t, prop: string | symbol) => {
        if (typeof prop !== 'string') return undefined;
        if (!(prop in t)) {
          t[prop] = () => proxy;
        }
        return t[prop];
      },
    });
    return proxy;
  };
  return {
    GestureHandlerRootView: ({ children }: { children: ReactNode }) =>
      React.createElement(View, null, children),
    GestureDetector: ({ children }: { children: ReactNode }) =>
      React.createElement(View, null, children),
    Gesture: {
      Pan: () => chainable(),
      Tap: () => chainable(),
      Fling: () => chainable(),
      Race: () => chainable(),
      LongPress: () => chainable(),
      Simultaneous: () => chainable(),
      Exclusive: () => chainable(),
    },
  };
});

// Reanimated 4 jest 桩：jest 无 UI 线程 worklet 运行时——共享值为普通对象、
// 动画助手恒等返回目标值、Animated.View 透传为 View（entering/exiting 丢弃）。
// Easing 桩（M8 收口补）：bezier 恒等返回线性函数——动画助手本就恒等返回
// 目标值，曲线形状在单测中无语义，补桩只为让组件的 Easing.bezier 调用点
// 在测试环境走与真机同一代码路径（此前缺桩逼出多处 Easing?. 可选链）。
// 手势/动画语义的真机验收走集中验收清单；单测只覆盖回调逻辑与渲染结构。
jest.mock('react-native-reanimated', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View, Text } =
    jest.requireActual<typeof ReactNativeModule>('react-native');
  const chainable = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    const proxy = new Proxy(obj, {
      get: (t, prop: string | symbol) => {
        if (typeof prop !== 'string') return undefined;
        if (!(prop in t)) {
          t[prop] = () => proxy;
        }
        return t[prop];
      },
    });
    return proxy;
  };
  const AnimatedView = ({
    children,
    style,
    ...rest
  }: {
    children?: ReactNode;
    style?: Record<string, unknown>;
  }) => React.createElement(View, { style: style as never, ...rest }, children);
  const AnimatedText = ({
    children,
    style,
    ...rest
  }: {
    children?: ReactNode;
    style?: Record<string, unknown>;
  }) => React.createElement(Text, { style: style as never, ...rest }, children);
  return {
    __esModule: true,
    // default 导出（`import Animated from 'react-native-reanimated'`）与命名
    // 导出（`import { Animated, useSharedValue } from ...`）双形态同构
    default: {
      // createAnimatedComponent 返回原组件（保真）：真实库保留宿主组件全部
      // 行为（Pressable 的 disabled / 可访问性 / 事件）仅叠加动效——若替换成
      // 裸 View 会把 disabled 语义剥掉（测试里禁用钮照样触发 onPress）且丢
      // testID/label 查询面（按压过渡统一批 2026-11-02 修正）。
      createAnimatedComponent: <P>(Comp: React.ComponentType<P>) => Comp,
      View: AnimatedView,
      Text: AnimatedText,
    },
    Animated: { View: AnimatedView, Text: AnimatedText },
    useSharedValue: (initial: unknown) => {
      // ref 持有（保真）：真实 reanimated 的 SharedValue 跨渲染保持同一引用，
      // pressIn 写入的值在 rerender 后必须仍可读——每次渲染新建对象会把
      // 按压进度重置为初值，usePressFade 行为测试即在此失真（2026-11-02 修正）
      const ref = React.useRef<{ value: unknown }>({ value: initial });
      return ref.current;
    },
    useAnimatedStyle: (fn: () => unknown) =>
      typeof fn === 'function' ? fn() : {},
    useDerivedValue: (fn: () => unknown) => ({
      value: typeof fn === 'function' ? fn() : fn,
    }),
    useAnimatedReaction: () => {},
    scrollTo: jest.fn(),
    useAnimatedRef: () => {
      const ref = React.useRef(null);
      return ref;
    },
    useAnimatedKeyboard: () => ({ height: { value: 0 }, state: { value: 0 } }),
    useReducedMotion: () => false,
    interpolate: (_v: number, _input: number[], output: number[]) => output[0],
    interpolateColor: (_v: number, _input: number[], output: unknown[]) =>
      output[0],
    runOnJS: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    withSpring: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    withDelay: (_ms: number, v: unknown) => v,
    withRepeat: (v: unknown) => v,
    withSequence: (...values: unknown[]) => values[values.length - 1],
    cancelAnimation: () => {},
    Easing: {
      bezier: () => (t: number) => t,
      linear: (t: number) => t,
      ease: (t: number) => t,
      quad: (t: number) => t,
      cubic: (t: number) => t,
      in: (fn: (t: number) => number) => fn,
      out: (fn: (t: number) => number) => fn,
      inOut: (fn: (t: number) => number) => fn,
    },
    Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
    FadeIn: chainable(),
    FadeOut: chainable(),
    FadeInDown: chainable(),
    FadeOutDown: chainable(),
    FadeInUp: chainable(),
    FadeOutUp: chainable(),
    SlideInUp: chainable(),
    SlideOutUp: chainable(),
    SlideInDown: chainable(),
    SlideOutDown: chainable(),
    LinearTransition: chainable(),
  };
});

jest.mock('react-native/Libraries/Modal/Modal', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  function MockModal({
    children,
    visible = true,
  }: {
    children: ReactNode;
    visible?: boolean;
  }) {
    return visible === false ? null : React.createElement(View, null, children);
  }
  return { __esModule: true, default: MockModal };
});

jest.mock('expo-camera', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  return {
    CameraView: (props: Record<string, unknown>) =>
      React.createElement(View, props),
    useCameraPermissions: () => [
      { granted: true, canAskAgain: true, status: 'granted' },
      jest.fn(async () => ({ granted: true })),
      jest.fn(async () => ({ granted: true })),
    ],
  };
});

// expo-blur mock：jest 无原生 BlurView，替成透传 props 的 View，便于断言 intensity / tint。
jest.mock('expo-blur', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  return {
    BlurView: (props: Record<string, unknown>) =>
      React.createElement(View, props),
  };
});

// react-native-webview mock（批 E)：jest 无原生 WebView——透传 props 的
// View 替身，公式 / 图块宿主（WebContentBlock）的高度回传与回落断言经
// props.onMessage 驱动（见 WebContentBlock.test.tsx)。
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  return {
    WebView: (props: Record<string, unknown>) =>
      React.createElement(View, props),
  };
});

beforeEach(() => {
  mockSecureStoreData.clear();
});

/**
 * 全局运行时收口：停掉应用级单例的后台定时器。
 *
 * `startAccountRuntime` 注册 15s/30s 两个 setInterval（心跳 + 设备发现），
 * 测试若不调用 `stopAccountRuntime` 会留下悬挂句柄，jest 报
 * "A worker process has failed to exit gracefully" 并强杀 worker。
 * 在这里统一收口，测试无需各自记得清理。
 */
afterEach(() => {
  // 延迟 require：本文件在部分用例上下文里先于模块图求值，顶层 import 会
  // 把 store 依赖链提前拉起来；此处按需取用即可。
  const { stopAccountRuntime } = jest.requireActual(
    '@/adapters/runtime/accountRuntime'
  ) as { stopAccountRuntime: () => void };
  stopAccountRuntime();
});

export {};
