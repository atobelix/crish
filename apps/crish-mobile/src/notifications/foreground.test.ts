// 前台 handler 与双通道去重单测（R3-04）：
// 前台不弹系统通知 / 系统通知归一 / dedupeKey 幂等收敛（复用 notificationStore.ingest）
import {
  addNotificationReceivedListener,
  setNotificationHandler,
} from 'expo-notifications';
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import {
  decideForegroundPresentation,
  ingestPushIntoStore,
  installForegroundHandler,
  normalizeSystemNotification,
  pushToNotificationInput,
  subscribeSystemNotificationReceived,
} from './foreground';
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

function makeSystemNotification(
  data: Record<string, unknown>,
  overrides: { title?: string | null; body?: string | null } = {}
) {
  return {
    request: {
      identifier: 'n-1',
      content: {
        title: overrides.title ?? 'title',
        body: overrides.body ?? 'body',
        data,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetNotificationsForTest();
});

describe('decideForegroundPresentation（前台不弹系统通知）', () => {
  it('恒全 false：双通道去重——app 内已展示，抑制系统横幅', () => {
    expect(decideForegroundPresentation()).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });
});

describe('installForegroundHandler（SDK 57 setNotificationHandler）', () => {
  it('安装 handler，handleNotification 返回不弹系统通知决策', async () => {
    await installForegroundHandler();
    expect(setNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = (setNotificationHandler as jest.Mock).mock.calls[0][0];
    await expect(handler.handleNotification({})).resolves.toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });
});

describe('pushToNotificationInput（dedupeKey 匹配）', () => {
  it('id = dedupeKey；kind = eventType；toolCallId/runId 从 target 取；route 深链', () => {
    const input = pushToNotificationInput(makePush());
    expect(input.id).toBe('approval-requested:tc-9f3a');
    expect(input.kind).toBe('approval-requested');
    expect(input.toolCallId).toBe('tc-9f3a');
    expect(input.runId).toBe('s-7');
    expect(input.seq).toBe(101);
    expect(input.title).toBe('Crish 需要你的批准');
    expect(input.body).toBe('bash：执行部署脚本');
    expect(input.route).toBe('crish://approval/tc-9f3a');
  });
});

describe('ingestPushIntoStore（双通道去重数据面）', () => {
  it('WS 直推 + 系统通知同 dedupeKey 二次到达 → 幂等覆盖仅一条（前台只呈现一次）', () => {
    ingestPushIntoStore(makePush(), 1000);
    ingestPushIntoStore(makePush({ title: '第二次到达（重推）' }), 2000);
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('approval-requested:tc-9f3a');
    expect(items[0]!.title).toBe('第二次到达（重推）');
    expect(items[0]!.receivedAt).toBe(2000);
    expect(notificationStore.getState().unreadCount).toBe(1);
  });

  it('不同 dedupeKey → 各自成条', () => {
    ingestPushIntoStore(makePush(), 1000);
    ingestPushIntoStore(
      makePush({
        id: 'push-000002',
        dedupeKey: 'run-terminal:run-42',
        eventType: 'run-terminal',
        severity: 'critical',
        title: '任务运行失败',
        channelId: 'run',
        target: {
          screen: 'session',
          sessionId: 's-7',
          params: { runId: 'run-42' },
        },
      }),
      2000
    );
    expect(notificationStore.getState().items).toHaveLength(2);
    expect(notificationStore.getState().unreadCount).toBe(2);
  });
});

describe('normalizeSystemNotification（厂商通道 data 白名单扁平字段 → PushMessage）', () => {
  it('完整载荷 → PushMessage（dedupeKey/eventType 必备，D7 §6.4-2）', () => {
    const push = normalizeSystemNotification(
      makeSystemNotification({
        eventType: 'run-terminal',
        dedupeKey: 'run-terminal:run-42',
        id: 'push-3',
        seq: 103,
        tsMs: 100,
        severity: 'critical',
        category: 'run',
        channelId: 'run',
        title: '任务运行失败',
        body: 'provider 401',
        screen: 'session',
        sessionId: 's-7',
        runId: 'run-42',
      })
    )!;
    expect(push).toMatchObject({
      schemaVersion: 1,
      id: 'push-3',
      eventType: 'run-terminal',
      dedupeKey: 'run-terminal:run-42',
      seq: 103,
      tsMs: 100,
      severity: 'critical',
      channelId: 'run',
      title: '任务运行失败',
      body: 'provider 401',
    });
    expect(push.target).toEqual({
      screen: 'session',
      sessionId: 's-7',
      params: { runId: 'run-42' },
    });
  });

  it('缺 eventType 或缺 dedupeKey（非 crish 推送）→ null 丢弃', () => {
    expect(normalizeSystemNotification(makeSystemNotification({}))).toBeNull();
    expect(
      normalizeSystemNotification(makeSystemNotification({ foo: 'bar' }))
    ).toBeNull();
    expect(
      normalizeSystemNotification(makeSystemNotification({ eventType: 'x' }))
    ).toBeNull();
    expect(
      normalizeSystemNotification(makeSystemNotification({ dedupeKey: 'x' }))
    ).toBeNull();
  });

  it('title/body 缺失 → content 兜底；severity 非法 → normal；id 缺失 → sys:identifier', () => {
    const push = normalizeSystemNotification({
      request: {
        identifier: 'n-9',
        content: {
          title: '系统标题',
          body: '系统正文',
          data: {
            eventType: 'timer-fired',
            dedupeKey: 'timer-fired:timer-1',
            severity: 'weird',
          },
        },
      },
    })!;
    expect(push.title).toBe('系统标题');
    expect(push.body).toBe('系统正文');
    expect(push.severity).toBe('normal');
    expect(push.id).toBe('sys:n-9');
    expect(push.channelId).toBe('general');
    expect(push.target).toEqual({ screen: '', sessionId: null, params: {} });
  });

  it('title/body 全缺（含 content）→ 标题兜底「Crish 通知」', () => {
    const push = normalizeSystemNotification({
      request: {
        identifier: 'n-9',
        content: {
          title: null,
          body: null,
          data: { eventType: 'x', dedupeKey: 'k' },
        },
      },
    })!;
    expect(push.title).toBe('Crish 通知');
    expect(push.body).toBeNull();
  });
});

describe('subscribeSystemNotificationReceived（系统通知 → app 内同步）', () => {
  it('注册监听；到达 → 归一 → 入 store；非 crish 忽略；退订移除', async () => {
    const sub = { remove: jest.fn() };
    (addNotificationReceivedListener as jest.Mock).mockImplementation(
      () => sub
    );
    const dispose = await subscribeSystemNotificationReceived();
    const listener = (addNotificationReceivedListener as jest.Mock).mock
      .calls[0][0];

    listener(
      makeSystemNotification({
        eventType: 'task-failed',
        dedupeKey: 'task-failed:t-1',
        title: '后台任务异常退出',
      })
    );
    expect(notificationStore.getState().items).toHaveLength(1);
    expect(notificationStore.getState().items[0]!.id).toBe('task-failed:t-1');

    // 非 crish 载荷 → 丢弃（不污染列表）
    listener(makeSystemNotification({ foo: 1 }));
    expect(notificationStore.getState().items).toHaveLength(1);

    dispose();
    expect(sub.remove).toHaveBeenCalledTimes(1);
  });
});
