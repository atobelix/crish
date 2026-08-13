// notificationStore 单测（R2-14 第三波）：ingest 去重（同 id 幂等覆盖）/
// 未读计数与已读（markRead / markAllRead）/ 7 天清理（clearResolved）/ 排序不变量 /
// hydrate 三态回填 / 持久化接口注入面
import {
  notificationStore,
  configureNotificationsPersistence,
  resetNotificationsForTest,
  unreadOf,
  listOf,
  type NotificationsPersist,
} from './notificationStore';
import {
  NOTIFICATION_RESOLVED_RETENTION_MS,
  type InAppNotification,
  type NotificationInput,
  type NotificationStatus,
} from './notificationReducers';

const NOW = 1_800_000_000_000;

function makeInput(
  partial: Partial<NotificationInput> & { id: string }
): NotificationInput {
  return {
    kind: 'approval',
    toolCallId: null,
    runId: null,
    seq: null,
    title: '需要确认：shell 命令',
    body: 'rm -rf 高危操作',
    route: 'conex://mobile/approval/tc-1',
    ...partial,
  };
}

/** 可注入 fake 持久化（内存 Map + jest.fn 断言调用面） */
function makePersist(initial?: InAppNotification[]): NotificationsPersist & {
  upsert: jest.Mock;
  updateStatus: jest.Mock;
  deleteResolvedOlderThan: jest.Mock;
  listByStatus: jest.Mock;
} {
  const map = new Map<string, InAppNotification>();
  for (const row of initial ?? []) map.set(row.id, row);
  return {
    upsert: jest.fn(async (row: InAppNotification) => {
      const existed = map.has(row.id);
      map.set(row.id, row);
      return existed ? ('updated' as const) : ('inserted' as const);
    }),
    updateStatus: jest.fn(async (id: string, status: NotificationStatus) => {
      const row = map.get(id);
      if (row) map.set(id, { ...row, status });
    }),
    deleteResolvedOlderThan: jest.fn(async () => {}),
    listByStatus: jest.fn(async (status: NotificationStatus) =>
      [...map.values()].filter((r) => r.status === status)
    ),
  };
}

beforeEach(() => {
  resetNotificationsForTest();
  configureNotificationsPersistence(null); // 隔离默认持久化注入
});

describe('ingest（去重：同 id 幂等覆盖，D7 §3.4.1）', () => {
  it('同 id 二次 ingest 不重复入列，内容与时间覆盖更新', () => {
    const st = notificationStore.getState();
    st.ingest(makeInput({ id: 'approval-requested:tc-9f3a' }), NOW);
    st.ingest(
      makeInput({
        id: 'approval-requested:tc-9f3a',
        title: '更新标题',
        body: '更新正文',
      }),
      NOW + 1000
    );
    const items = listOf();
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('更新标题');
    expect(items[0]!.body).toBe('更新正文');
    expect(items[0]!.receivedAt).toBe(NOW + 1000);
    // 重推阶梯场景（D7 §9.3）：status 缺省 'shown' → 重新未读
    expect(items[0]!.status).toBe('shown');
    expect(unreadOf()).toBe(1);
  });

  it('不同去重键分别入列（双通道同键只留一条，异键并存）', () => {
    const st = notificationStore.getState();
    st.ingest(makeInput({ id: 'approval-requested:tc-1' }), NOW);
    st.ingest(makeInput({ id: 'run-terminal:run-42' }), NOW + 1000);
    st.ingest(makeInput({ id: 'approval-requested:tc-1' }), NOW + 2000);
    expect(listOf()).toHaveLength(2);
    expect(unreadOf()).toBe(2);
  });

  it('列表恒按 receivedAt 降序（新在前，对齐 DAO 排序）', () => {
    const st = notificationStore.getState();
    st.ingest(makeInput({ id: 'n-1' }), NOW);
    st.ingest(makeInput({ id: 'n-2' }), NOW + 3000);
    st.ingest(makeInput({ id: 'n-3' }), NOW + 1000);
    expect(listOf().map((n) => n.id)).toEqual(['n-2', 'n-3', 'n-1']);
  });
});

describe('未读计数与已读（shown → resolved）', () => {
  it('ingest 缺省 status=shown，未读 +1；markRead 未读 -1', () => {
    const st = notificationStore.getState();
    st.ingest(makeInput({ id: 'a-1' }), NOW);
    st.ingest(makeInput({ id: 'a-2' }), NOW + 1000);
    expect(unreadOf()).toBe(2);
    st.markRead('a-1');
    expect(unreadOf()).toBe(1);
    expect(listOf().find((n) => n.id === 'a-1')!.status).toBe('resolved');
    // 重复已读不重复扣减
    st.markRead('a-1');
    expect(unreadOf()).toBe(1);
  });

  it('markAllRead 全部已读，未读归零；已 resolved 条目不受影响', () => {
    const st = notificationStore.getState();
    st.ingest(makeInput({ id: 'a-1' }), NOW);
    st.ingest(
      makeInput({ id: 'a-2', status: 'resolved' as const }),
      NOW + 1000
    );
    st.markAllRead();
    expect(unreadOf()).toBe(0);
    expect(listOf().every((n) => n.status === 'resolved')).toBe(true);
  });
});

describe('clearResolved（7 天清理，M5 §5.5）', () => {
  it('仅清理 resolved 且超期条目；shown/dismissed 与新 resolved 保留', () => {
    const st = notificationStore.getState();
    const old = NOW - NOTIFICATION_RESOLVED_RETENTION_MS - 1000;
    st.ingest(
      makeInput({ id: 'old-resolved', status: 'resolved' as const }),
      old
    );
    st.ingest(makeInput({ id: 'shown-old' }), old);
    st.ingest(
      makeInput({ id: 'dismissed-old', status: 'dismissed' as const }),
      old
    );
    st.ingest(
      makeInput({ id: 'fresh-resolved', status: 'resolved' as const }),
      NOW - NOTIFICATION_RESOLVED_RETENTION_MS + 1000
    );
    const removed = st.clearResolved(undefined, NOW);
    expect(removed).toBe(1);
    expect(listOf().map((n) => n.id)).toEqual([
      'fresh-resolved',
      'shown-old',
      'dismissed-old',
    ]);
  });

  it('显式 beforeMs 注入可测边界（毫秒精确）', () => {
    const st = notificationStore.getState();
    st.ingest(makeInput({ id: 'r1', status: 'resolved' as const }), NOW - 5000);
    st.ingest(makeInput({ id: 'r2', status: 'resolved' as const }), NOW - 3000);
    expect(st.clearResolved(NOW - 4000, NOW)).toBe(1);
    expect(listOf().map((n) => n.id)).toEqual(['r2']);
  });
});

describe('hydrate（三态回填 + 排序 + 未读重算）', () => {
  it('冷启动从持久化三态回填，receivedAt 降序 + 未读重算', async () => {
    const persist = makePersist([
      {
        ...makeInput({ id: 'n-1', status: 'shown' as const }),
        receivedAt: NOW,
      } as InAppNotification,
      {
        ...makeInput({ id: 'n-2' }),
        status: 'resolved' as const,
        receivedAt: NOW + 1000,
      } as InAppNotification,
      {
        ...makeInput({ id: 'n-3', status: 'shown' as const }),
        receivedAt: NOW + 2000,
      } as InAppNotification,
    ]);
    await notificationStore.getState().hydrate(persist);
    const st = notificationStore.getState();
    expect(st.hydrated).toBe(true);
    expect(listOf().map((n) => n.id)).toEqual(['n-3', 'n-2', 'n-1']);
    expect(unreadOf()).toBe(2);
    expect(persist.listByStatus).toHaveBeenCalledTimes(3);
  });

  it('读取失败不阻塞启动（空列表 + hydrated=true）', async () => {
    const persist = makePersist();
    persist.listByStatus.mockRejectedValue(new Error('db read error'));
    await notificationStore.getState().hydrate(persist);
    expect(notificationStore.getState().hydrated).toBe(true);
    expect(listOf()).toHaveLength(0);
    expect(unreadOf()).toBe(0);
  });

  it('无持久化注入时 hydrate 仅置位 hydrated', async () => {
    await notificationStore.getState().hydrate();
    expect(notificationStore.getState().hydrated).toBe(true);
  });
});

describe('持久化接口注入面（接线层先落库再推 store 的注记面）', () => {
  it('configureNotificationsPersistence 注入默认持久化', async () => {
    const persist = makePersist();
    configureNotificationsPersistence(persist);
    await notificationStore.getState().hydrate();
    expect(notificationStore.getState().hydrated).toBe(true);
  });

  it('ingest/markRead 走内存镜像（落库由接线层编排，见文件头注记）', () => {
    // 纪律：store 动作不直接写库——落库在 wiring 层（dao.upsert → store.ingest）
    const persist = makePersist();
    notificationStore.getState().ingest(makeInput({ id: 'x-1' }), NOW);
    expect(persist.upsert).not.toHaveBeenCalled();
  });
});
