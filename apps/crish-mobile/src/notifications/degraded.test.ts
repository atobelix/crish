// Expo Go 降级集成测试（P0-1 DEF-5）：系统通知面不可用的环境
// - 模拟方式：setPushModuleUnavailableForTest(true) 测试注入——等价「Expo Go 下
//   expo-notifications 模块求值即抛错 → loadApi 返回 null」的降级契约（真实机制：
//   SDK 53+ 移除 push 原生模块，warnOfExpoGoPushUsage throw / requireNativeModule
//   无原生模块；jest 模块工厂抛错会致 worker 退出告警，故统一走注入面）；
// - 断言：能力探测 false → initNotificationLayer 降级分支（跳过系统面整体装配、
//   权限 undetermined、dispose 空操作）；安全包装全部回退（null/false/空操作）；
//   registerChannelsAsync 跳过建渠道返回 0；presentSystemPushAsync 空串；
//   PushWiring 后台推送仅 ingest（应用内通知中心有条目）不抛错。
// - 注：本文件不得静态 import expo-notifications（会拉进模块加载——那正是 DEF-5
//   场景；全部经 expoNotificationsFacade 惰性加载面验证降级）。
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import { authStore } from '@/domain/store/authStore';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { JsonValue } from '../../../../packages/shared-types/src/primitive-types';
import type { WsGateway } from '@/network/WsGateway';
import { initNotificationLayer } from './index';
import { registerChannelsAsync } from './channels';
import { notificationPermissionStore } from './permissions';
import { presentSystemPushAsync, PushWiring } from './pushConsumer';
import {
  addNotificationReceivedListenerSafe,
  addNotificationResponseReceivedListenerSafe,
  getLastNotificationResponseAsyncSafe,
  getPermissionsAsyncSafe,
  hasPushModule,
  requestPermissionsAsyncSafe,
  scheduleNotificationAsyncSafe,
  setNotificationChannelAsyncSafe,
  setNotificationHandlerSafe,
  setPushModuleUnavailableForTest,
} from './expoNotificationsFacade';
import type { PushMessage } from './types';

function makePush(overrides: Partial<PushMessage> = {}): PushMessage {
  return {
    schemaVersion: 1,
    id: 'push-000001',
    eventType: 'approval-requested',
    seq: 101,
    tsMs: 1786214400000,
    severity: 'critical',
    category: 'approval',
    title: 'Crish 需要你的批准',
    body: 'bash：执行部署脚本',
    dedupeKey: 'approval-requested:tc-9f3a',
    collapseKey: 'session:s-7',
    channelId: 'approval',
    target: {
      screen: 'approval',
      sessionId: 's-7',
      params: { toolCallId: 'tc-9f3a' },
    },
    ...overrides,
  };
}

function pushFrame(push: PushMessage): InboundEnvelope {
  return {
    v: 1,
    kind: 'events.push',
    msgId: `m-in-${Math.random().toString(36).slice(2)}`,
    ts: 1,
    from: 'desktop',
    to: 'mobile',
    body: {
      sessionId: push.target.sessionId ?? '',
      event: push,
    } as unknown as JsonValue,
  };
}

/** 网关 mock：捕获订阅 handler，emit 按 kind 分发（同 pushConsumer.test 语义） */
function makeGateway() {
  const handlers = new Map<string, Set<(f: InboundEnvelope) => void>>();
  const gateway = {
    on: jest.fn((kind: string, handler: (f: InboundEnvelope) => void) => {
      let set = handlers.get(kind);
      if (!set) {
        set = new Set();
        handlers.set(kind, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    }),
  } as unknown as WsGateway;
  const emit = (f: InboundEnvelope): void => {
    for (const h of [...(handlers.get(f.kind) ?? [])]) h(f);
  };
  return { gateway, emit };
}

beforeEach(() => {
  jest.clearAllMocks();
  setPushModuleUnavailableForTest(true);
  resetNotificationsForTest();
  notificationPermissionStore.setState({
    status: 'undetermined',
    checked: false,
    refreshing: false,
  });
  authStore.setState({ pairState: 'unpaired', host: null });
});

afterAll(() => {
  setPushModuleUnavailableForTest(null);
});

describe('能力探测（Expo Go：模块求值抛错 → 系统通知面不可用）', () => {
  it('hasPushModule → false；探测结果缓存', async () => {
    await expect(hasPushModule()).resolves.toBe(false);
    await expect(hasPushModule()).resolves.toBe(false);
  });

  it('安全包装全部回退：权限 null / 渠道 false / handler false / 监听 null / 呈现 null', async () => {
    await expect(getPermissionsAsyncSafe()).resolves.toBeNull();
    await expect(requestPermissionsAsyncSafe()).resolves.toBeNull();
    await expect(
      setNotificationChannelAsyncSafe('approval', {
        name: '审批',
        description: 'd',
        importance: 7,
      })
    ).resolves.toBe(false);
    await expect(
      setNotificationHandlerSafe({ handleNotification: async () => ({}) })
    ).resolves.toBe(false);
    await expect(addNotificationReceivedListenerSafe(jest.fn())).resolves.toBe(
      null
    );
    await expect(
      addNotificationResponseReceivedListenerSafe(jest.fn())
    ).resolves.toBe(null);
    await expect(getLastNotificationResponseAsyncSafe()).resolves.toBeNull();
    await expect(
      scheduleNotificationAsyncSafe({
        content: { title: 't', body: null, data: {} },
        trigger: { channelId: 'general' },
      })
    ).resolves.toBeNull();
  });
});

describe('initNotificationLayer 降级（DEF-5：不崩、不装配系统面、保留应用内）', () => {
  it('跳过系统面整体装配；permissionStatus undetermined；dispose 空操作', async () => {
    const handle = await initNotificationLayer({ navigate: jest.fn() });
    expect(handle.permissionStatus).toBe('undetermined');
    // 降级分支不接触任何原生 API（不建渠道/不查权限/不装 handler/不监听）
    expect(notificationPermissionStore.getState().checked).toBe(false);
    expect(notificationPermissionStore.getState().refreshing).toBe(false);
    // dispose 空操作不抛
    expect(() => handle.dispose()).not.toThrow();
  });
});

describe('通知层各模块降级（系统通知面不可用 → 应用内能力保留）', () => {
  it('registerChannelsAsync 跳过建渠道返回 0（不抛）', async () => {
    await expect(registerChannelsAsync()).resolves.toBe(0);
  });

  it('notificationPermissionStore.refresh 回退 undetermined 不阻塞（checked 不置位）', async () => {
    await expect(
      notificationPermissionStore.getState().refresh()
    ).resolves.toBe('undetermined');
    expect(notificationPermissionStore.getState().checked).toBe(false);
  });

  it('presentSystemPushAsync 返回空串（不呈现不抛）', async () => {
    await expect(presentSystemPushAsync(makePush())).resolves.toBe('');
  });

  it('PushWiring 后台推送 → 仅应用内 ingest（无系统通知面，不抛错）', () => {
    const { gateway, emit } = makeGateway();
    const wiring = new PushWiring({
      gateway,
      getAppState: () => 'background',
    });
    wiring.attach();
    expect(() => emit(pushFrame(makePush()))).not.toThrow();
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('approval-requested:tc-9f3a');
    wiring.detach();
  });
});
