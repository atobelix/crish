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

beforeEach(() => {
  mockSecureStoreData.clear();
});

export {};
