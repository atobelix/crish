// 缓存清理策略测试（M5 §5.5：容量上限/窗口纯函数 + 执行器集成）
import { migrateIfNeeded } from './db';
import {
  DEFAULT_CACHE_LIMITS,
  buildTimeWindowCleanup,
  computeEventsCleanup,
  daysToMs,
  runCleanup,
  type CacheLimits,
} from './cachePolicy';
import { MemorySqlDriver } from './driver';
import { SqlEventsDao, type EventRow } from './dao/eventsDao';
import { SqlSessionSummariesDao } from './dao/sessionSummariesDao';
import {
  SqlApprovalHistoryDao,
  type ApprovalHistoryRow,
} from './dao/approvalHistoryDao';
import {
  SqlApprovalQueueDao,
  type ApprovalQueueRow,
} from './dao/approvalQueueDao';
import {
  SqlNotificationsDao,
  type NotificationRow,
} from './dao/notificationsDao';

describe('computeEventsCleanup：每会话窗口 + 全局兜底（纯函数）', () => {
  const limits: CacheLimits = {
    ...DEFAULT_CACHE_LIMITS,
    eventsPerSession: 10,
    eventsGlobal: 25,
  };

  it('未超全局上限：只按每会话窗口截断', () => {
    const steps = computeEventsCleanup(
      [
        { sessionId: 'a', count: 20, updatedAtMs: 1000 },
        { sessionId: 'b', count: 5, updatedAtMs: 2000 },
      ],
      limits
    );
    // a 截到 10；b 不超限不进结果；总保留 15 ≤ 25 全局
    expect(steps).toEqual([{ sessionId: 'a', keepCount: 10 }]);
  });

  it('每会话截断后仍超全局上限：按会话最旧优先收缩', () => {
    const steps = computeEventsCleanup(
      [
        { sessionId: 'a', count: 20, updatedAtMs: 1000 }, // 最旧
        { sessionId: 'b', count: 20, updatedAtMs: 2000 },
        { sessionId: 'c', count: 20, updatedAtMs: 3000 },
      ],
      limits
    );
    // 每会话先截 10 → 30 仍超 25 → 从最旧 a 开始收缩：a 先减 5（到 5），总 25 达标
    expect(steps).toEqual([
      { sessionId: 'a', keepCount: 5 },
      { sessionId: 'b', keepCount: 10 },
      { sessionId: 'c', keepCount: 10 },
    ]);
  });

  it('不超限时返回空计划', () => {
    expect(
      computeEventsCleanup(
        [{ sessionId: 'a', count: 3, updatedAtMs: 1000 }],
        limits
      )
    ).toEqual([]);
  });

  it('keepCount 可为 0（会话清空场景）', () => {
    const steps = computeEventsCleanup(
      [
        { sessionId: 'a', count: 5, updatedAtMs: 1000 },
        { sessionId: 'b', count: 30, updatedAtMs: 2000 },
      ],
      { ...limits, eventsGlobal: 3 }
    );
    const a = steps.find((s) => s.sessionId === 'a');
    expect(a?.keepCount).toBe(0); // a 最旧且全局预算不足 → 全清
  });
});

describe('buildTimeWindowCleanup：窗口计算（纯函数）', () => {
  it('approval_history 30 天窗口（非待办态 + decided_at）', () => {
    const now = 1_000_000_000_000;
    const plans = buildTimeWindowCleanup(now);
    const history = plans.find((p) => p.table === 'approval_history');
    expect(history?.sql).toContain('status NOT IN');
    expect(history?.sql).toContain('decided_at < ?');
    expect(history?.params[0]).toBe(now - daysToMs(30));
  });

  it('approval_queue sent 7 天窗口 + notifications resolved 7 天窗口', () => {
    const now = 1_000_000_000_000;
    const plans = buildTimeWindowCleanup(now);
    const outbox = plans.find((p) => p.table === 'approval_queue');
    expect(outbox?.sql).toContain("status = 'sent'");
    expect(outbox?.params[0]).toBe(now - daysToMs(7));
    const notif = plans.find((p) => p.table === 'notifications');
    expect(notif?.sql).toContain("status = 'resolved'");
    expect(notif?.params[0]).toBe(now - daysToMs(7));
  });

  it('自定义上限参与窗口计算', () => {
    const now = 2_000_000_000_000;
    const plans = buildTimeWindowCleanup(now, {
      ...DEFAULT_CACHE_LIMITS,
      approvalHistoryKeepDays: 90,
    });
    expect(plans.find((p) => p.table === 'approval_history')?.params[0]).toBe(
      now - daysToMs(90)
    );
  });
});

describe('runCleanup：执行器集成（内存 driver）', () => {
  const now = 100_000_000;
  const limits: CacheLimits = {
    eventsPerSession: 3,
    eventsGlobal: 10,
    approvalHistoryKeepDays: 30,
    sessionKeepCount: 2,
    outboxKeepDays: 7,
    notificationsKeepDays: 7,
  };

  function makeEvent(sequence: number, sessionId: string): EventRow {
    return {
      sequence,
      eventId: `e-${sessionId}-${sequence}`,
      type: 'message',
      sessionId,
      runId: null,
      timestamp: sequence,
      payloadJson: '{}',
      schemaVersion: 1,
      ingestedAt: sequence,
    };
  }

  async function seed(): Promise<{ db: MemorySqlDriver }> {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const eventsDao = new SqlEventsDao(db);
    const sessionsDao = new SqlSessionSummariesDao(db);
    const historyDao = new SqlApprovalHistoryDao(db);
    const queueDao = new SqlApprovalQueueDao(db);
    const notificationsDao = new SqlNotificationsDao(db);
    // events：s1 5 条、s2 2 条（每会话窗口 3）
    for (let i = 1; i <= 5; i++) await eventsDao.upsert(makeEvent(i, 's1'));
    for (let i = 1; i <= 2; i++) await eventsDao.upsert(makeEvent(i, 's2'));
    // 会话：3 个保留 2 个
    for (const [sid, ts] of [
      ['s1', 1000],
      ['s2', 2000],
      ['s3', 3000],
    ] as const) {
      await sessionsDao.upsert({
        sessionId: sid,
        title: sid,
        cwd: '/w',
        status: 'open',
        isPinned: 0,
        isArchived: 0,
        messageCount: 0,
        engineCursor: 0,
        engineLastRunId: null,
        updatedAt: ts,
        lastMessagePreview: null,
        metadataJson: null,
      });
    }
    // 审批历史：1 条旧已决（删）+ 1 条新已决（留）+ 1 条 pending（恒保留）
    const old = now - daysToMs(40);
    const historyRows: ApprovalHistoryRow[] = [
      {
        toolCallId: 'h-old',
        sessionId: 's1',
        runId: null,
        toolName: 'runTask',
        summary: null,
        arbiter: 'user',
        dangerLevel: 1,
        status: 'expired',
        decision: null,
        requestJson: '{}',
        riskMetaJson: null,
        requestedAt: old,
        decidedAt: old,
        expiresAt: null,
      },
      {
        toolCallId: 'h-new',
        sessionId: 's1',
        runId: null,
        toolName: 'runTask',
        summary: null,
        arbiter: 'user',
        dangerLevel: 1,
        status: 'approved',
        decision: 'approved',
        requestJson: '{}',
        riskMetaJson: null,
        requestedAt: now - 1000,
        decidedAt: now - 500,
        expiresAt: null,
      },
      {
        toolCallId: 'h-pending',
        sessionId: 's1',
        runId: null,
        toolName: 'runTask',
        summary: null,
        arbiter: 'user',
        dangerLevel: 1,
        status: 'pending',
        decision: null,
        requestJson: '{}',
        riskMetaJson: null,
        requestedAt: now,
        decidedAt: null,
        expiresAt: now + 120000,
      },
    ];
    for (const h of historyRows) await historyDao.upsert(h);
    // outbox：1 条旧 sent（删）+ 1 条 pending（保留）
    const queueRows: ApprovalQueueRow[] = [
      {
        id: 'q-old',
        toolCallId: 'tc-old',
        decision: 'approved',
        reason: null,
        runId: null,
        msgId: 'm1',
        status: 'sent',
        attempts: 1,
        lastError: null,
        nextRetryAtMs: null,
        createdAtMs: old,
        updatedAtMs: old,
      },
      {
        id: 'q-pending',
        toolCallId: 'tc-p',
        decision: 'approved',
        reason: null,
        runId: null,
        msgId: 'm2',
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextRetryAtMs: null,
        createdAtMs: now,
        updatedAtMs: now,
      },
    ];
    for (const q of queueRows) await queueDao.upsert(q);
    // 通知：1 条旧 resolved（删）+ 1 条 shown（保留）
    const notifRows: NotificationRow[] = [
      {
        id: 'n-old',
        kind: 'run-ended',
        toolCallId: null,
        runId: null,
        seq: 1,
        title: 't',
        body: 'b',
        route: null,
        status: 'resolved',
        receivedAt: old,
      },
      {
        id: 'n-shown',
        kind: 'approval',
        toolCallId: 'tc1',
        runId: null,
        seq: 2,
        title: 't',
        body: 'b',
        route: '/approval/tc1',
        status: 'shown',
        receivedAt: now,
      },
    ];
    for (const n of notifRows) await notificationsDao.upsert(n);
    return { db };
  }

  it('一次清理后各表符合保留策略', async () => {
    const { db } = await seed();
    const summary = await runCleanup(db, now, limits);
    // events：s1 保留 3（删 2），s2 保留 2（不删）
    expect(db.rowCount('events')).toBe(5);
    expect(summary.eventsDeleted).toBe(2);
    // sessions：3 → 2（保留最近 2）
    expect(db.rowCount('session_summaries')).toBe(2);
    expect(summary.sessionsDeleted).toBe(1);
    // approval_history：删 1 旧已决，pending/新已决保留
    expect(db.rowCount('approval_history')).toBe(2);
    expect(summary.approvalsDeleted).toBe(1);
    // approval_queue：删 1 旧 sent，pending 保留
    expect(db.rowCount('approval_queue')).toBe(1);
    expect(summary.outboxDeleted).toBe(1);
    // notifications：删 1 旧 resolved，shown 保留
    expect(db.rowCount('notifications')).toBe(1);
    expect(summary.notificationsDeleted).toBe(1);
  });

  it('幂等：数据已达标时重复清理不再删除', async () => {
    const { db } = await seed();
    await runCleanup(db, now, limits);
    const second = await runCleanup(db, now, limits);
    expect(second.eventsDeleted).toBe(0);
    expect(second.sessionsDeleted).toBe(0);
    expect(second.approvalsDeleted).toBe(0);
    expect(second.outboxDeleted).toBe(0);
    expect(second.notificationsDeleted).toBe(0);
  });

  it('events 全局兜底：多会话超全局上限时按最旧会话收缩', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const eventsDao = new SqlEventsDao(db);
    for (let i = 1; i <= 6; i++) await eventsDao.upsert(makeEvent(i, 's1'));
    for (let i = 1; i <= 6; i++) await eventsDao.upsert(makeEvent(i, 's2'));
    // 每会话窗口 3 → 共 6；全局上限 4 → 最旧会话 s1（ingested 相同按先后）收缩到 1
    const summary = await runCleanup(db, now, {
      ...limits,
      eventsPerSession: 3,
      eventsGlobal: 4,
    });
    expect(db.rowCount('events')).toBe(4);
    expect(summary.eventsDeleted).toBe(8);
  });

  it('events 行 session_id 为 NULL → 防御性跳过（不参与清理统计）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    // 直接插入 NULL session_id 行（绕过 DAO 类型约束，模拟脏数据）
    await db.exec(
      `INSERT INTO events (sequence, event_id, type, session_id, timestamp, payload_json, schema_version, ingested_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      [1, 'e-null', 'message', 1, '{}', 1, 1]
    );
    const summary = await runCleanup(db, now, limits);
    expect(db.rowCount('events')).toBe(1); // NULL 行保留
    expect(summary.eventsDeleted).toBe(0);
  });

  it('keepCount ≤ 0 → 删除该会话全部事件（会话清空路径）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const eventsDao = new SqlEventsDao(db);
    for (let i = 1; i <= 4; i++) await eventsDao.upsert(makeEvent(i, 's1'));
    // 全局上限 1 → s1 每会话窗口 3 → 全局兜底收缩到 1？不——用 eventsGlobal 极小值触发 keepCount=0
    const summary = await runCleanup(db, now, {
      ...limits,
      eventsPerSession: 3,
      eventsGlobal: 1,
    });
    expect(db.rowCount('events')).toBe(1);
    expect(summary.eventsDeleted).toBe(3);
  });

  it('session_summaries 空表 + sessionKeepCount=0 → 全删不报错（防御分支）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const sessionsDao = new SqlSessionSummariesDao(db);
    await sessionsDao.upsert({
      sessionId: 's1',
      title: 's1',
      cwd: '/w',
      status: 'open',
      isPinned: 0,
      isArchived: 0,
      messageCount: 0,
      engineCursor: 0,
      engineLastRunId: null,
      updatedAt: 1000,
      lastMessagePreview: null,
      metadataJson: null,
    });
    const summary = await runCleanup(db, now, {
      ...limits,
      sessionKeepCount: 0,
    });
    expect(db.rowCount('session_summaries')).toBe(0);
    expect(summary.sessionsDeleted).toBe(1);
  });

  it('runCleanup 缺省 limits（默认容量规格）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    await expect(runCleanup(db, now)).resolves.toMatchObject({
      eventsDeleted: 0,
      sessionsDeleted: 0,
    });
  });
});
