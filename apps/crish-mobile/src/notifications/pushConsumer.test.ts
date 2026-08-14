// 推送消费接线单测（R3-04 部分 2）：帧识别（推送 vs 普通事件）→ 通知层分发
// - 帧识别：recognizePushPayload / parsePushEvent（schemaVersion=1 + eventType +
//   dedupeKey 区分字段；普通事件信封 type 面 → null 宽容跳过）；
// - 分发：前台（active）只 ingest 不弹系统通知；后台/最小化补系统通知
//   （presentSystemPushAsync → scheduleNotificationAsync 内容契约）；
// - 双通道去重：PresentedKeyTracker（24h TTL）——同 dedupeKey 只呈现一条；
//   呈现失败撤消登记（重推可再尝试）；离开配对态清表。
import { scheduleNotificationAsync } from 'expo-notifications';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { JsonValue } from '../../../../packages/shared-types/src/primitive-types';
import type { WsGateway } from '@/network/WsGateway';
import { authStore } from '@/domain/store/authStore';
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import {
  parsePushEvent,
  presentSystemPushAsync,
  PresentedKeyTracker,
  PRESENT_DEDUP_TTL_MS,
  PushWiring,
  pushSystemNotificationData,
  recognizePushPayload,
  routePresentation,
} from './pushConsumer';
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

function frame(kind: string, body: unknown): InboundEnvelope {
  return {
    v: 1,
    kind,
    msgId: `m-in-${Math.random().toString(36).slice(2)}`,
    ts: 1,
    from: 'desktop',
    to: 'mobile',
    body: body as JsonValue,
  };
}

/** events.push 推送帧（body.event = PushMessage，schema.rs ws_push_body 形态） */
function pushFrame(push: PushMessage): InboundEnvelope {
  return frame('events.push', {
    sessionId: push.target.sessionId ?? '',
    event: push,
  });
}

/** events.push 普通事件帧（AgentEventEnvelope type 面，M6 §10.5） */
function normalEventFrame(): InboundEnvelope {
  return frame('events.push', {
    sessionId: 's-7',
    event: {
      type: 'run-terminal',
      sessionId: 's-7',
      runId: 'run-42',
      sequence: 7,
      ts: 1,
    },
  });
}

/** 网关 mock：捕获订阅 handler，emit 按 kind 分发（同 WsGateway.on 语义） */
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
  return { gateway, emit, handlers };
}

function makeWiring(
  overrides: {
    gateway?: WsGateway;
    appState?: string;
    presentSystem?: jest.Mock;
    tracker?: PresentedKeyTracker;
    now?: () => number;
  } = {}
) {
  const gw = overrides.gateway ?? makeGateway().gateway;
  const tracker = overrides.tracker ?? new PresentedKeyTracker();
  const presentSystem =
    overrides.presentSystem ?? jest.fn(async () => 'mock-notification-id');
  const wiring = new PushWiring({
    gateway: gw,
    getAppState: () => (overrides.appState ?? 'active') as never,
    tracker,
    now: overrides.now ?? (() => 1000),
    presentSystem,
  });
  wiring.attach();
  return { wiring, tracker, presentSystem };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetNotificationsForTest();
  authStore.setState({ pairState: 'unpaired', host: null });
});

describe('recognizePushPayload / parsePushEvent（帧识别：推送 vs 普通事件）', () => {
  it('PushMessage 载荷（schemaVersion=1 + eventType + dedupeKey）→ 识别并完整解析', () => {
    const push = makePush();
    expect(recognizePushPayload(push)).toBe(true);
    expect(parsePushEvent(push)).toEqual(push);
  });

  it('普通事件信封（type 面）→ 非推送（null 宽容跳过，不打断连接）', () => {
    const normal = {
      type: 'run-terminal',
      sessionId: 's-7',
      runId: 'run-42',
      sequence: 7,
    };
    expect(recognizePushPayload(normal)).toBe(false);
    expect(parsePushEvent(normal)).toBeNull();
    expect(parsePushEvent(42)).toBeNull();
    expect(parsePushEvent(null)).toBeNull();
    expect(parsePushEvent(undefined)).toBeNull();
  });

  it('缺区分字段（schemaVersion 非 1 / 缺 eventType / 缺 dedupeKey）→ null', () => {
    expect(recognizePushPayload(makePush({ schemaVersion: 2 }))).toBe(false);
    expect(recognizePushPayload(makePush({ eventType: '' }))).toBe(false);
    expect(recognizePushPayload(makePush({ dedupeKey: '' }))).toBe(false);
    const { dedupeKey: _drop, ...noKey } = makePush();
    expect(parsePushEvent(noKey)).toBeNull();
  });

  it('可选字段缺省回退：title →「Crish 通知」/ body → null / severity 非法 → normal / id 缺省 → ws:dedupeKey', () => {
    const raw = {
      schemaVersion: 1,
      id: undefined,
      eventType: 'timer-fired',
      seq: 3,
      tsMs: 5,
      severity: 'weird',
      category: 'timer',
      dedupeKey: 'timer-fired:timer-1',
      channelId: 'timer',
      target: { screen: 'timer', params: { timerId: 'timer-1' } },
    };
    const push = parsePushEvent(raw)!;
    expect(push.title).toBe('Crish 通知');
    expect(push.body).toBeNull();
    expect(push.severity).toBe('normal');
    expect(push.id).toBe('ws:timer-fired:timer-1');
    expect(push.target.sessionId).toBeNull();
    expect(push.target.params).toEqual({ timerId: 'timer-1' });
  });

  it('target.params 非字符串值丢弃不猜测（schema.rs params 为对象）', () => {
    const push = parsePushEvent({
      ...makePush(),
      target: {
        screen: 'session',
        sessionId: 's-7',
        params: { runId: 'run-42', count: 3, nested: { a: 1 } },
      },
    })!;
    expect(push.target.params).toEqual({ runId: 'run-42' });
  });
});

describe('routePresentation（AppState → 呈现通道，D7 §6.4）', () => {
  it('前台 active → in-app（应用内已展示，不弹系统通知）', () => {
    expect(routePresentation('active', false)).toBe('in-app');
    expect(routePresentation('active', true)).toBe('in-app');
  });
  it('后台 background / 最小化 inactive → system；同键已呈现 → deduped', () => {
    expect(routePresentation('background', false)).toBe('system');
    expect(routePresentation('inactive', false)).toBe('system');
    expect(routePresentation('background', true)).toBe('deduped');
  });
});

describe('PresentedKeyTracker（双通道去重表，D7 §6.4-2 / §3.4.1）', () => {
  it('mark 后 has=true；remove/clear 后 has=false；同键只记一次', () => {
    const tracker = new PresentedKeyTracker(PRESENT_DEDUP_TTL_MS, () => 1000);
    tracker.mark('approval-requested:tc-9f3a');
    expect(tracker.has('approval-requested:tc-9f3a')).toBe(true);
    tracker.mark('approval-requested:tc-9f3a');
    expect(tracker.size()).toBe(1);
    tracker.remove('approval-requested:tc-9f3a');
    expect(tracker.has('approval-requested:tc-9f3a')).toBe(false);
    tracker.mark('k');
    tracker.clear();
    expect(tracker.size()).toBe(0);
  });

  it('TTL 过期惰性清理：超过 24h → has=false 且条目被移除', () => {
    let now = 1000;
    const tracker = new PresentedKeyTracker(PRESENT_DEDUP_TTL_MS, () => now);
    tracker.mark('run-terminal:run-42');
    expect(tracker.has('run-terminal:run-42')).toBe(true);
    now = 1000 + PRESENT_DEDUP_TTL_MS + 1;
    expect(tracker.has('run-terminal:run-42')).toBe(false);
    expect(tracker.size()).toBe(0);
  });

  it('容量有界：超上限逐出最旧条目', () => {
    const now = 0;
    const tracker = new PresentedKeyTracker(PRESENT_DEDUP_TTL_MS, () => now, 2);
    tracker.mark('k1');
    tracker.mark('k2');
    tracker.mark('k3');
    expect(tracker.size()).toBe(2);
    expect(tracker.has('k1')).toBe(false);
    expect(tracker.has('k3')).toBe(true);
  });
});

describe('PushWiring（WS events.push → 通知层分发）', () => {
  it('前台（active）：ingest 入应用内通知中心；不弹系统通知', () => {
    const { gateway, emit } = makeGateway();
    const { presentSystem } = makeWiring({ gateway, appState: 'active' });
    emit(pushFrame(makePush()));
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('approval-requested:tc-9f3a');
    expect(items[0]!.title).toBe('Crish 需要你的批准');
    expect(notificationStore.getState().unreadCount).toBe(1);
    expect(presentSystem).not.toHaveBeenCalled();
  });

  it('前台幂等：同 dedupeKey 双达 → 覆盖仅一条（双通道收敛，R2-04e 通知中心联动）', () => {
    const { gateway, emit } = makeGateway();
    const { presentSystem } = makeWiring({ gateway, appState: 'active' });
    emit(pushFrame(makePush()));
    emit(pushFrame(makePush({ title: '重推刷新' })));
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('重推刷新');
    expect(presentSystem).not.toHaveBeenCalled();
  });

  it('后台（background）：ingest + 系统通知呈现（一次）', () => {
    const { gateway, emit } = makeGateway();
    const { presentSystem } = makeWiring({ gateway, appState: 'background' });
    emit(pushFrame(makePush()));
    expect(presentSystem).toHaveBeenCalledTimes(1);
    expect(presentSystem).toHaveBeenCalledWith(makePush());
    // 双通道收敛：后台同样入应用内通知中心（用户回到前台可见）
    expect(notificationStore.getState().items).toHaveLength(1);
  });

  it('后台同 dedupeKey 二次到达 → 只呈现一条（去重）；不同键各自呈现', () => {
    const { gateway, emit } = makeGateway();
    const { presentSystem } = makeWiring({ gateway, appState: 'background' });
    emit(pushFrame(makePush()));
    emit(pushFrame(makePush({ id: 'push-000002', seq: 102 })));
    expect(presentSystem).toHaveBeenCalledTimes(1);
    emit(
      pushFrame(
        makePush({
          id: 'push-000003',
          eventType: 'run-terminal',
          severity: 'critical',
          title: '任务运行失败',
          dedupeKey: 'run-terminal:run-42',
          channelId: 'run',
          target: {
            screen: 'session',
            sessionId: 's-7',
            params: { runId: 'run-42' },
          },
        })
      )
    );
    expect(presentSystem).toHaveBeenCalledTimes(2);
    expect(notificationStore.getState().items).toHaveLength(2);
  });

  it('普通事件帧 / 非 events.push 帧 → 宽容跳过（不 ingest 不呈现）', () => {
    const { gateway, emit } = makeGateway();
    const { presentSystem } = makeWiring({ gateway, appState: 'background' });
    emit(normalEventFrame());
    emit(frame('session.updated', { session: { id: 's-1', updatedAt: 1 } }));
    emit(frame('events.push', { event: { foo: 1 } }));
    expect(notificationStore.getState().items).toHaveLength(0);
    expect(presentSystem).not.toHaveBeenCalled();
  });

  it('呈现失败 → 撤消去重登记：同键重推可再尝试（审批不能漏）', async () => {
    const { gateway, emit } = makeGateway();
    const presentSystem = jest
      .fn()
      .mockRejectedValueOnce(new Error('channel missing'))
      .mockResolvedValueOnce('mock-notification-id');
    const { tracker } = makeWiring({
      gateway,
      appState: 'background',
      presentSystem,
    });
    emit(pushFrame(makePush()));
    expect(tracker.has('approval-requested:tc-9f3a')).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // 等 catch 微任务
    expect(tracker.has('approval-requested:tc-9f3a')).toBe(false);
    emit(pushFrame(makePush()));
    expect(presentSystem).toHaveBeenCalledTimes(2);
  });

  it('离开配对态（unpair）→ 清去重表（新配对会话允许重呈现）', () => {
    const { gateway, emit } = makeGateway();
    authStore.setState({ pairState: 'paired' });
    const { tracker } = makeWiring({ gateway, appState: 'background' });
    emit(pushFrame(makePush()));
    expect(tracker.has('approval-requested:tc-9f3a')).toBe(true);
    authStore.setState({ pairState: 'unpaired' });
    expect(tracker.size()).toBe(0);
  });

  it('attach 订阅 events.push；detach 退订后不再消费', () => {
    const { gateway, emit } = makeGateway();
    const { wiring, presentSystem, tracker } = makeWiring({
      gateway,
      appState: 'background',
    });
    wiring.detach();
    emit(pushFrame(makePush()));
    expect(presentSystem).not.toHaveBeenCalled();
    expect(tracker.size()).toBe(0);
    expect(notificationStore.getState().items).toHaveLength(0);
  });
});

describe('presentSystemPushAsync / pushSystemNotificationData（后台系统通知内容契约）', () => {
  it('scheduleNotificationAsync 收到扁平 data 白名单 + Android 四类渠道 trigger', async () => {
    await presentSystemPushAsync(
      makePush({
        channelId: 'subagent',
        target: {
          screen: 'session',
          sessionId: 's-7',
          params: { runId: 'run-42', subagentId: 'sa-1' },
        },
      })
    );
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const req = (scheduleNotificationAsync as jest.Mock).mock.calls[0]![0];
    expect(req.content.title).toBe('Crish 需要你的批准');
    expect(req.content.body).toBe('bash：执行部署脚本');
    // data 扁平白名单（normalizeSystemNotification 消费面：dedupeKey + eventType 必备，
    // D7 §6.4-2）+ 深链定位参数（D7 §6.3 白名单）
    expect(req.content.data).toMatchObject({
      eventType: 'approval-requested',
      dedupeKey: 'approval-requested:tc-9f3a',
      screen: 'session',
      sessionId: 's-7',
      runId: 'run-42',
      subagentId: 'sa-1',
      severity: 'critical',
    });
    // 渠道归一：subagent → run（Z0 §7.4 四类）
    expect(req.trigger).toEqual({ channelId: 'run' });
  });

  it('collapseKey 空 → data 不含该键；params 非白名单键不进 data', () => {
    const data = pushSystemNotificationData(
      makePush({
        collapseKey: null,
        target: { screen: 'home', sessionId: null, params: {} },
      })
    );
    expect(data['collapseKey']).toBeUndefined();
    expect(data['screen']).toBe('home');
    expect(data['sessionId']).toBeNull();
    expect(data['toolCallId']).toBeUndefined();
  });
});
