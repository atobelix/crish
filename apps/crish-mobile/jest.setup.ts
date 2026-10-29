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
  return {
    GestureHandlerRootView: ({ children }: { children: ReactNode }) =>
      React.createElement(View, null, children),
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
