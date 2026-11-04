// FeedBridge 单测（R2-05 观测面接线层）：
// - 帧消费：attach 订阅六类设备帧 → mapDeviceFrame → dispatchIngestActions（真实 store 断言）；
// - events.resume.page：正常分派 + hasMore 自动续页（store 游标为下一页起点）+ 完成清在途；
// - 相位投影：handlePhaseChange → eventStore.network + connectionStore.phase；
// - 对账驱动：handleProjection（resume/fullReplay/fresh/cleanup）+ 会话索引重拉；
// - 对账可见化（M1）→ 增量口径（2026-11-02）：成败落 connectionStore 对账状态
//   （ok/error+错误信息）；无定时重试（fake timer 推进零同步调用）、后台对账
//   不置 syncing、无差分对账静默（状态/打点/列表引用全不动）、真实增量落地
//   清陈旧标记（已连接零未连接误报面）；
// - 窗口卸载：maxWindows 超限卸载最久未活跃者（R2UX-05-09）；
// - 设备在场查询：open 相位 remote.listDevices fire-and-forget。
import { act } from '@testing-library/react-native';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { JsonValue } from '../../../../../packages/shared-types/src/primitive-types';
import { WsGateway } from '@/network/WsGateway';
import type { SessionIndexEntry } from '@crish/shared-types';
import { eventStore, lastSeqOf } from '@/domain/store/eventStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { deviceSnapshotStore } from '@/domain/store/deviceSnapshotStore';
import { FeedBridge, feedNetworkOf } from './feedBridge';

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

function resetStores(): void {
  eventStore.setState({ windows: {}, network: 'live' });
  sessionStore.setState({ sessions: [], selectedSessionId: null });
  connectionStore.setState({
    phase: 'disconnected',
    sessionSyncStatus: 'idle',
    sessionSyncError: null,
    lastReconcileAt: null,
  });
}

beforeEach(() => {
  resetStores();
});

describe('FeedBridge 帧消费（M6 §3.1 分发表子集）', () => {
  it('attach 后 events.push 帧 → eventStore 窗口追加', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.push', {
          event: {
            type: 'message-delta',
            sessionId: 's-1',
            sequence: 1,
            text: '你好',
          },
        })
      );
    });
    expect(eventStore.getState().windows['s-1']!.entries).toHaveLength(1);
    bridge.detach();
  });

  it('events.push 帧发现序列空洞（seq > currentSeq + 1）时自动发起 events.resume 补洞自愈', async () => {
    const gateway = new WsGateway();
    const sendSpy = jest.fn();
    gateway.attachSend(sendSpy);
    const bridge = new FeedBridge({ gateway });
    bridge.attach();

    // 先推入 sequence 1
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.push', {
          event: {
            type: 'message-delta',
            sessionId: 's-gap',
            sequence: 1,
            text: '第1条',
          },
        })
      );
    });
    expect(lastSeqOf('s-gap')).toBe(1);

    // 跳过 2, 3，直接推入 sequence 4
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.push', {
          event: {
            type: 'message-delta',
            sessionId: 's-gap',
            sequence: 4,
            text: '第4条',
          },
        })
      );
    });

    // 验证发出了 events.resume 请求（afterSequence = 1）
    expect(sendSpy).toHaveBeenCalledWith(
      expect.stringContaining('"kind":"events.resume"')
    );
    expect(sendSpy).toHaveBeenCalledWith(
      expect.stringContaining('"afterSequence":1')
    );
    bridge.detach();
  });

  it('session.updated 帧 → sessionStore upsert', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('session.updated', {
          session: {
            id: 's-1',
            title: '会话一',
            updatedAt: 1000,
          },
        })
      );
    });
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['s-1']);
    bridge.detach();
  });

  it('session.removed 帧 → 会话移除 + 事件窗口卸载', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('session.updated', {
          session: { id: 's-1', updatedAt: 1000 },
        })
      );
      gateway.dispatchFrame(frame('session.removed', { sessionId: 's-1' }));
    });
    expect(sessionStore.getState().sessions).toHaveLength(0);
    expect(eventStore.getState().windows['s-1']).toBeUndefined();
    bridge.detach();
  });

  it('detach 退订全部（幂等：重复 attach 先 detach）', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    bridge.detach();
    bridge.detach(); // 幂等
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.push', {
          event: { type: 'message-end', sessionId: 's-1', sequence: 1 },
        })
      );
    });
    expect(eventStore.getState().windows['s-1']).toBeUndefined();
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.push', {
          event: { type: 'message-end', sessionId: 's-1', sequence: 2 },
        })
      );
    });
    expect(eventStore.getState().windows['s-1']!.entries).toHaveLength(1);
    bridge.detach();
  });
});

describe('FeedBridge events.resume.page（续传分页闭环，M6 §9.3 ③）', () => {
  it('resume.page 分派 feed-hydrate；hasMore=false 清在途', async () => {
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.resume.page', {
          sessionId: 's-1',
          events: [
            { type: 'message-end', sessionId: 's-1', sequence: 1 },
            { type: 'message-end', sessionId: 's-1', sequence: 2 },
          ],
          nextAfterSequence: 2,
          hasMore: false,
        })
      );
    });
    const window = eventStore.getState().windows['s-1']!;
    expect(window.entries).toHaveLength(2);
    expect(window.lastSeq).toBe(2);
    bridge.detach();
  });

  it('hasMore=true 自动续页：以 store 游标为下一页起点发起 events.resume', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    // 先灌入 seq 1-2（hydrate 置游标 2），再收 hasMore=true 的页
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.resume.page', {
          sessionId: 's-1',
          events: [
            { type: 'message-end', sessionId: 's-1', sequence: 1 },
            { type: 'message-end', sessionId: 's-1', sequence: 2 },
          ],
          nextAfterSequence: 2,
          hasMore: true,
        })
      );
    });
    expect(lastSeqOf('s-1')).toBe(2);
    // 续页请求已发出（events.resume + afterSequence=2 + maxEvents=200）
    const sentKinds = sent
      .map((raw) => {
        const parsed = JSON.parse(raw) as {
          kind: string;
          body: { params?: { afterSequence?: number } };
        };
        return parsed;
      })
      .filter((f) => f.kind === 'events.resume');
    expect(sentKinds.length).toBeGreaterThanOrEqual(1);
    const params = sentKinds[0]!.body as unknown as {
      afterSequence: number;
      maxEvents: number;
    };
    expect(params.afterSequence).toBe(2);
    expect(params.maxEvents).toBe(200);
    bridge.detach();
  });

  it('resumeSession 在途防重入：同一会话重复触发只发一次请求', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    // 第一页 hasMore=true 已发续页请求（在途）；再收一页 hasMore=true 不重复发
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.resume.page', {
          sessionId: 's-1',
          events: [{ type: 'message-end', sessionId: 's-1', sequence: 1 }],
          nextAfterSequence: 1,
          hasMore: true,
        })
      );
      gateway.dispatchFrame(
        frame('events.resume.page', {
          sessionId: 's-1',
          events: [{ type: 'message-end', sessionId: 's-1', sequence: 2 }],
          nextAfterSequence: 2,
          hasMore: true,
        })
      );
    });
    const resumeCalls = sent.filter((raw) => raw.includes('events.resume'));
    expect(resumeCalls).toHaveLength(1);
    bridge.detach();
  });

  it('resume.page 缺 sessionId → 宽容跳过（mapDeviceFrame ignore，不崩溃）', async () => {
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.resume.page', {
          events: [{ type: 'message-end', sessionId: 's-1', sequence: 1 }],
          nextAfterSequence: 1,
          hasMore: false,
        })
      );
    });
    expect(eventStore.getState().windows['s-1']).toBeUndefined();
    bridge.detach();
  });

  it('events.resume 失败 → 清在途 + warn 留痕（下轮空洞可重试）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 无 send 注入 → invoke 立即 reject（transport.closed）
      const gateway = new WsGateway();
      const bridge = new FeedBridge({ gateway });
      bridge.attach();
      // 本地已有 seq 1；收到 seq 3 → 空洞探测触发 events.resume
      eventStore
        .getState()
        .hydrate('s-1', [
          { type: 'message-end', sessionId: 's-1', sequence: 1 },
        ]);
      await act(async () => {
        gateway.dispatchFrame(
          frame('events.push', {
            event: { type: 'message-end', sessionId: 's-1', sequence: 3 },
          })
        );
        await Promise.resolve();
      });
      // 在途已清 → 再次空洞探测可重试（不再静默吞）
      await act(async () => {
        gateway.dispatchFrame(
          frame('events.push', {
            event: { type: 'message-end', sessionId: 's-1', sequence: 4 },
          })
        );
        await Promise.resolve();
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('events.resume 失败')
      );
      bridge.detach();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('FeedBridge 相位投影（M5 §4.3.1 投影表）', () => {
  it('open → eventStore.live + connectionStore.ready', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      bridge.handlePhaseChange('open');
    });
    expect(eventStore.getState().network).toBe('live');
    expect(connectionStore.getState().phase).toBe('ready');
    bridge.detach();
  });

  it('reconnecting → eventStore.reconnecting + connectionStore.recovering', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      bridge.handlePhaseChange('reconnecting');
    });
    expect(eventStore.getState().network).toBe('reconnecting');
    expect(connectionStore.getState().phase).toBe('recovering');
    bridge.detach();
  });

  it('idle/dead → eventStore.offline + connectionStore.offline/disconnected', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      bridge.handlePhaseChange('dead');
    });
    expect(eventStore.getState().network).toBe('offline');
    expect(connectionStore.getState().phase).toBe('offline');
    bridge.detach();
  });

  it('feedNetworkOf 纯函数映射全量（open/reconnecting/其余）', () => {
    expect(feedNetworkOf('open')).toBe('live');
    expect(feedNetworkOf('reconnecting')).toBe('reconnecting');
    expect(feedNetworkOf('idle')).toBe('offline');
    expect(feedNetworkOf('connecting')).toBe('offline');
    expect(feedNetworkOf('dead')).toBe('offline');
  });
});

describe('FeedBridge 序列空洞自愈（实现波总方案 C1：stash + resume 按序 drain）', () => {
  it('空洞探测：以本地游标发起 events.resume，乱序高帧暂存不推进游标', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    // 本地已有 seq 5 的窗口
    eventStore
      .getState()
      .hydrate('s-1', [{ type: 'message-end', sessionId: 's-1', sequence: 5 }]);
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.push', {
          event: { type: 'message-end', sessionId: 's-1', sequence: 7 },
        })
      );
    });
    const resume = sent
      .map(
        (raw) =>
          JSON.parse(raw) as {
            kind: string;
            body: { params?: { afterSequence?: number } };
          }
      )
      .find((f) => f.kind === 'events.resume')!;
    expect(
      (resume.body as unknown as { afterSequence: number }).afterSequence
    ).toBe(5);
    // 乱序高帧已暂存：窗口仍是 5，lastSeq 未被推进（补洞帧不会被判 duplicate）
    expect(eventStore.getState().windows['s-1']!.lastSeq).toBe(5);
    expect(eventStore.getState().windows['s-1']!.entries).toHaveLength(1);
    bridge.detach();
  });

  it('空洞闭合：补洞页到达后 stash 帧按序入库，无 duplicate 丢弃', async () => {
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    eventStore
      .getState()
      .hydrate('s-1', [{ type: 'message-end', sessionId: 's-1', sequence: 1 }]);
    await act(async () => {
      // 乱序帧 3 到达 → 暂存 + 触发 resume
      gateway.dispatchFrame(
        frame('events.push', {
          event: { type: 'message-end', sessionId: 's-1', sequence: 3 },
        })
      );
    });
    await act(async () => {
      // 补洞帧 2 到达（resume.page）→ 空洞闭合 → stash 的 3 按序入库
      gateway.dispatchFrame(
        frame('events.resume.page', {
          sessionId: 's-1',
          events: [{ type: 'message-end', sessionId: 's-1', sequence: 2 }],
          nextAfterSequence: 2,
          hasMore: false,
        })
      );
    });
    const entries = eventStore.getState().windows['s-1']!.entries;
    expect(entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(eventStore.getState().windows['s-1']!.lastSeq).toBe(3);
    bridge.detach();
  });
});

describe('FeedBridge 窗口卸载策略（R2UX-05-09：≤4 活跃窗口）', () => {
  it('超过 maxWindows 个活跃窗口 → 卸载最久未活跃者', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, maxWindows: 2 });
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('events.push', {
          event: { type: 'message-end', sessionId: 's-1', sequence: 1 },
        })
      );
      gateway.dispatchFrame(
        frame('events.push', {
          event: { type: 'message-end', sessionId: 's-2', sequence: 1 },
        })
      );
      gateway.dispatchFrame(
        frame('events.push', {
          event: { type: 'message-end', sessionId: 's-3', sequence: 1 },
        })
      );
    });
    // 窗口 3 个 > maxWindows 2 → 卸载最久未活跃（s-1，按 activity 时间戳）
    expect(eventStore.getState().windows['s-1']).toBeUndefined();
    expect(eventStore.getState().windows['s-2']).toBeDefined();
    expect(eventStore.getState().windows['s-3']).toBeDefined();
    bridge.detach();
  });
});

describe('FeedBridge 连接就绪订阅（open 相位）', () => {
  it('open → 发送 events.subscribe 与关键类型 subscribeAll', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    sessionStore.setState({
      sessions: [
        {
          id: 's-1',
          title: '会话一',
          folder: '常规会话',
          isPinned: false,
          isArchived: false,
          timestamp: '',
          updatedAt: 1000,
          messageCount: 0,
          receivedAtMs: 1,
          lastReadSequence: 0,
          unreadCount: 0,
          activeRunIds: [],
          pendingApprovalCount: 0,
        },
      ],
      selectedSessionId: null,
    });
    await act(async () => {
      bridge.handlePhaseChange('open');
      await Promise.resolve();
    });
    const subscribe = sent.find((raw) => raw.includes('events.subscribe"'));
    expect(subscribe).toBeDefined();
    expect(subscribe).toContain('s-1');
    expect(sent.some((raw) => raw.includes('events.subscribeAll'))).toBe(true);
    bridge.detach();
  });
});

describe('FeedBridge 会话索引对账（refreshSessions）', () => {
  it('listSessions 成功 → reconcile 写入 + 状态 ok；失败 → 状态 error + warn 留痕（M1 可见化）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const listSessions = jest
        .fn()
        .mockResolvedValueOnce([{ id: 's-1', updatedAt: 1000 }])
        .mockRejectedValueOnce(new Error('对账超时'));
      const gateway = new WsGateway({ send: () => {} });
      const bridge = new FeedBridge({ gateway, listSessions });
      bridge.attach();
      await act(async () => {
        bridge.handlePhaseChange('open');
        await Promise.resolve();
      });
      expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
        's-1',
      ]);
      // M1：成功落一等状态（ok + 成功打点 + 无错误）
      expect(connectionStore.getState().sessionSyncStatus).toBe('ok');
      expect(connectionStore.getState().sessionSyncError).toBeNull();
      expect(connectionStore.getState().lastReconcileAt).not.toBeNull();
      await act(async () => {
        bridge.handlePhaseChange('open');
        await Promise.resolve();
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('会话索引对账失败')
      );
      // M1：失败不再静默——状态 error + 错误信息入面；既有列表残量不被清
      expect(connectionStore.getState().sessionSyncStatus).toBe('error');
      expect(connectionStore.getState().sessionSyncError).toBe('对账超时');
      expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
        's-1',
      ]);
      bridge.detach();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('FeedBridge 增量同步口径（2026-11-02 用户裁决）', () => {
  it('对账失败 → 无定时重试：fake timer 推进零同步调用；手动 refreshNow 成功 → ok', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const listSessions = jest.fn().mockRejectedValue(new Error('持续失败'));
      const gateway = new WsGateway({ send: () => {} });
      const bridge = new FeedBridge({ gateway, listSessions });
      bridge.attach();
      await act(async () => {
        bridge.handlePhaseChange('open');
        await Promise.resolve();
      });
      expect(listSessions).toHaveBeenCalledTimes(1);
      expect(connectionStore.getState().sessionSyncStatus).toBe('error');
      // 定时自动刷新已废除：时间推进不产生任何新的列表同步调用
      await act(async () => {
        jest.advanceTimersByTime(120_000);
        await Promise.resolve();
      });
      expect(listSessions).toHaveBeenCalledTimes(1);
      expect(connectionStore.getState().sessionSyncStatus).toBe('error');
      // 恢复靠用户主动刷新（下拉/重试同路）
      listSessions.mockResolvedValue([{ id: 's-9', updatedAt: 9000 }]);
      await act(async () => {
        await bridge.refreshNow();
      });
      expect(connectionStore.getState().sessionSyncStatus).toBe('ok');
      expect(sessionStore.getState().sessions.map((x) => x.id)).toEqual([
        's-9',
      ]);
      bridge.detach();
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it('后台对账不置 syncing（零「同步中」呈现面）；手动 refreshNow 才置 syncing', async () => {
    let resolveList: ((v: SessionIndexEntry[]) => void) | null = null;
    const listSessions = jest.fn(
      () =>
        new Promise<SessionIndexEntry[]>((resolve) => {
          resolveList = resolve;
        })
    );
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({ gateway, listSessions });
    bridge.attach();
    // 后台（open 触发）：在途期间状态面保持 idle，绝不出现 syncing
    bridge.handlePhaseChange('open');
    expect(connectionStore.getState().sessionSyncStatus).toBe('idle');
    await act(async () => {
      resolveList!([{ id: 's-1', updatedAt: 1000 }]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(connectionStore.getState().sessionSyncStatus).toBe('ok');
    // 手动刷新：在途期间置 syncing（反馈归下拉原生指示，状态面如实）
    const pending = bridge.refreshNow();
    expect(connectionStore.getState().sessionSyncStatus).toBe('syncing');
    await act(async () => {
      resolveList!([{ id: 's-1', updatedAt: 1000 }]);
      await pending;
    });
    expect(connectionStore.getState().sessionSyncStatus).toBe('ok');
    bridge.detach();
  });

  it('无差分对账静默收尾：列表引用、状态、成功打点全不动', async () => {
    const entry = { id: 's-1', title: '甲', updatedAt: 1000 };
    const listSessions = jest.fn().mockResolvedValue([{ ...entry }]);
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({ gateway, listSessions });
    bridge.attach();
    await act(async () => {
      bridge.handlePhaseChange('open');
      await Promise.resolve();
      await Promise.resolve();
    });
    const sessionsRef = sessionStore.getState().sessions;
    const reconcileAt = connectionStore.getState().lastReconcileAt;
    expect(connectionStore.getState().sessionSyncStatus).toBe('ok');
    expect(reconcileAt).not.toBeNull();
    // 第二轮 open，权威列表内容与现状完全一致（新数组、新对象）
    await act(async () => {
      bridge.handlePhaseChange('open');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listSessions).toHaveBeenCalledTimes(2);
    // 静默：同一列表引用（零写入）、成功打点不刷新、状态不翻动
    expect(sessionStore.getState().sessions).toBe(sessionsRef);
    expect(connectionStore.getState().lastReconcileAt).toBe(reconcileAt);
    expect(connectionStore.getState().sessionSyncStatus).toBe('ok');
    bridge.detach();
  });

  it('增量落地清陈旧：ready 相位下 session.updated 帧到达 → 陈旧标记撤下（误报修复）', async () => {
    deviceSnapshotStore.setState({ liveStale: true, liveSnapshotAt: 42 });
    connectionStore.setState({ phase: 'ready' });
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('session.updated', {
          session: { id: 's-1', title: '实时更新', updatedAt: 2000 },
        })
      );
    });
    expect(sessionStore.getState().sessions.map((x) => x.id)).toEqual(['s-1']);
    expect(deviceSnapshotStore.getState().liveStale).toBe(false);
    bridge.detach();
  });

  it('清陈旧守卫：非 ready 相位 / 仅 refresh 信号 → 不清标（不冒充新鲜）', async () => {
    deviceSnapshotStore.setState({ liveStale: true, liveSnapshotAt: 42 });
    connectionStore.setState({ phase: 'disconnected' });
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      gateway.dispatchFrame(
        frame('session.updated', {
          session: { id: 's-1', updatedAt: 2000 },
        })
      );
    });
    // 相位未就绪：帧虽入店，数据面不算「活」，陈旧标注保留
    expect(deviceSnapshotStore.getState().liveStale).toBe(true);
    connectionStore.setState({ phase: 'ready' });
    await act(async () => {
      gateway.dispatchFrame(frame('session.updatedAll', {}));
    });
    // updatedAll 只触发对账（无 repo 时无从落盘）——信号本身不清标
    expect(deviceSnapshotStore.getState().liveStale).toBe(true);
    bridge.detach();
    deviceSnapshotStore.setState({ liveStale: false, liveSnapshotAt: null });
  });
});

describe('FeedBridge 属主盖章穿线（M7 / CON-3）', () => {
  afterEach(() => {
    sessionStore.setState({ ownerDeviceId: null, droppedWriteCount: 0 });
    deviceSnapshotStore.setState({
      snapshots: {},
      liveStale: false,
      liveSnapshotAt: null,
    });
  });

  it('旧桥在途对账在设备切换后落不进新属主数据面（盖章丢弃且不清陈旧标）', async () => {
    // 场景：dev-a 的桥已发出对账请求，用户切到 dev-b 并完成盖章，
    // dev-a 的对账结果此后才返回——不得整表替换 dev-b 的数据面。
    sessionStore.getState().stampOwner('dev-b');
    deviceSnapshotStore.setState({ liveStale: true, liveSnapshotAt: 42 });
    const listSessions = jest
      .fn()
      .mockResolvedValue([{ id: 's-a', updatedAt: 1000 }]);
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({
      gateway,
      listSessions,
      ownerDeviceId: 'dev-a',
    });
    bridge.attach();
    await act(async () => {
      bridge.handlePhaseChange('open');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sessionStore.getState().sessions).toEqual([]);
    expect(sessionStore.getState().droppedWriteCount).toBe(1);
    expect(deviceSnapshotStore.getState().liveStale).toBe(true);
    bridge.detach();
  });

  it('同属主对账落盘并清陈旧标（保留快照转新鲜）', async () => {
    sessionStore.getState().stampOwner('dev-a');
    deviceSnapshotStore.setState({ liveStale: true, liveSnapshotAt: 42 });
    const listSessions = jest
      .fn()
      .mockResolvedValue([{ id: 's-a', updatedAt: 1000 }]);
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({
      gateway,
      listSessions,
      ownerDeviceId: 'dev-a',
    });
    bridge.attach();
    await act(async () => {
      bridge.handlePhaseChange('open');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['s-a']);
    expect(deviceSnapshotStore.getState().liveStale).toBe(false);
    bridge.detach();
  });

  it('接线 dead → live 打陈旧标记（此后列表是上次同步存量）', () => {
    const gateway = new WsGateway({ send: () => {} });
    const bridge = new FeedBridge({ gateway });
    bridge.handlePhaseChange('dead');
    expect(deviceSnapshotStore.getState().liveStale).toBe(true);
    bridge.detach();
  });
});
