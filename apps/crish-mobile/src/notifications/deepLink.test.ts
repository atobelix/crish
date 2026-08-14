// 通知点击深链单测（R3-04）：target → crish:// 深链 → notificationMeta 白名单翻译 → 导航
// - 白名单唯一真源 = notificationMeta.notificationRouteToPath（只读引用，R2-04e 已交付）；
// - 未知 screen（subagent/task/timer/audit/home 等白名单外目标）→ 不导航仅已读（M4 §4.3）。
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import {
  buildDeepLinkRoute,
  handleNotificationResponse,
  pushToDeepLinkSource,
} from './deepLink';
import type { PushMessage, PushTarget } from './types';

function makeTarget(overrides: Partial<PushTarget> = {}): PushTarget {
  return {
    screen: 'approval',
    sessionId: 's-7',
    params: { toolCallId: 'tc-9f3a' },
    ...overrides,
  };
}

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
    target: makeTarget(),
    ...overrides,
  };
}

function makeResponse(data: Record<string, unknown>) {
  return {
    actionIdentifier: 'default',
    notification: {
      request: {
        identifier: 'n-1',
        content: { title: 't', body: 'b', data },
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetNotificationsForTest();
});

describe('buildDeepLinkRoute（target → crish:// 深链，M8 §4.1.2）', () => {
  it('approval + toolCallId → crish://approval/tc-9f3a', () => {
    expect(buildDeepLinkRoute(makeTarget({ sessionId: null }))).toBe(
      'crish://approval/tc-9f3a'
    );
  });

  it('session + sessionId + runId → crish://session/s-7?runId=run-42', () => {
    expect(
      buildDeepLinkRoute(
        makeTarget({
          screen: 'session',
          params: { runId: 'run-42' },
        })
      )
    ).toBe('crish://session/s-7?runId=run-42');
  });

  it('无 id → 仅 screen 段；screen 为空 → null', () => {
    expect(
      buildDeepLinkRoute(makeTarget({ sessionId: null, params: {} }))
    ).toBe('crish://approval');
    expect(buildDeepLinkRoute(makeTarget({ screen: '' }))).toBeNull();
  });
});

describe('pushToDeepLinkSource（白名单翻译输入面）', () => {
  it('route = 深链，kind/toolCallId/runId 透传', () => {
    const src = pushToDeepLinkSource(makePush());
    expect(src.route).toBe('crish://approval/tc-9f3a');
    expect(src.kind).toBe('approval-requested');
    expect(src.toolCallId).toBe('tc-9f3a');
    expect(src.runId).toBe('s-7');
  });
});

describe('handleNotificationResponse（点击 → 已读 → 白名单翻译 → 导航）', () => {
  it('白名单内（approval）→ 入 store + 点击即已读 + navigate(翻译路径)', () => {
    const navigate = jest.fn();
    handleNotificationResponse(
      makeResponse({
        eventType: 'approval-requested',
        dedupeKey: 'approval-requested:tc-9f3a',
        screen: 'approval',
        sessionId: 's-7',
        toolCallId: 'tc-9f3a',
      }),
      navigate
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/approval/tc-9f3a');
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('resolved');
  });

  it('白名单外（subagent 无对应路由）→ 入 store + 已读，但不导航（M4 §4.3）', () => {
    const navigate = jest.fn();
    handleNotificationResponse(
      makeResponse({
        eventType: 'subagent-ended',
        dedupeKey: 'subagent-ended:sa-3',
        screen: 'subagent',
        subagentId: 'sa-3',
      }),
      navigate
    );
    expect(navigate).not.toHaveBeenCalled();
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('resolved');
  });

  it('无 navigate 注入 → 仅已读不导航（冷启动兜底语义）', () => {
    handleNotificationResponse(
      makeResponse({
        eventType: 'approval-requested',
        dedupeKey: 'approval-requested:tc-9f3a',
        screen: 'approval',
        toolCallId: 'tc-9f3a',
      })
    );
    expect(notificationStore.getState().items[0]!.status).toBe('resolved');
  });

  it('非 crish 载荷（缺 dedupeKey/eventType）→ 无任何动作', () => {
    const navigate = jest.fn();
    handleNotificationResponse(makeResponse({ foo: 'bar' }), navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(notificationStore.getState().items).toHaveLength(0);
  });

  it('同 dedupeKey 重复点击 → 幂等（仅一条，状态仍 resolved）', () => {
    const navigate = jest.fn();
    const response = makeResponse({
      eventType: 'run-terminal',
      dedupeKey: 'run-terminal:run-42',
      screen: 'session',
      sessionId: 's-7',
      runId: 'run-42',
    });
    handleNotificationResponse(response, navigate);
    handleNotificationResponse(response, navigate);
    expect(notificationStore.getState().items).toHaveLength(1);
    expect(notificationStore.getState().items[0]!.status).toBe('resolved');
  });
});
