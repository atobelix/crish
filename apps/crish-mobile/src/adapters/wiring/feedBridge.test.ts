// FeedBridge 单测（R2-05 观测面接线层）：
// - 帧消费：attach 订阅六类设备帧 → mapDeviceFrame → dispatchIngestActions（真实 store 断言）；
// - events.resume.page：正常分派 + hasMore 自动续页（store 游标为下一页起点）+ 完成清在途；
// - 相位投影：handlePhaseChange → eventStore.network + connectionStore.phase；
// - 对账驱动：handleProjection（resume/fullReplay/fresh/cleanup）+ 会话索引重拉；
// - 窗口卸载：maxWindows 超限卸载最久未活跃者（R2UX-05-09）；
// - 设备在场查询：open 相位 remote.listDevices fire-and-forget。
import { act } from '@testing-library/react-native';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { JsonValue } from '../../../../../packages/shared-types/src/primitive-types';
import { WsGateway } from '@/network/WsGateway';
import { eventStore, lastSeqOf } from '@/domain/store/eventStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { devicePresenceStore } from './devicePresenceStore';
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
  connectionStore.setState({ phase: 'disconnected' });
  devicePresenceStore.setState({ count: null });
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

  it('events.resume 失败 → 清在途 + warn 留痕（下轮投影可重试）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 无 send 注入 → invoke 立即 reject（transport.closed）
      const gateway = new WsGateway();
      const bridge = new FeedBridge({ gateway });
      bridge.attach();
      await act(async () => {
        bridge.handleProjection({
          resume: ['s-1'],
          fullReplay: [],
          fresh: [],
          cleanup: [],
        });
        await Promise.resolve();
      });
      // 在途已清 → 再次投影可重试（不再静默吞）
      await act(async () => {
        bridge.handleProjection({
          resume: ['s-1'],
          fullReplay: [],
          fresh: [],
          cleanup: [],
        });
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

describe('FeedBridge 重连对账驱动（M6 §9.3 ①~③）', () => {
  it('resume 增量补齐：以本地游标发起 events.resume', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    // 本地已有 seq 5 的窗口
    eventStore
      .getState()
      .hydrate('s-1', [{ type: 'message-end', sessionId: 's-1', sequence: 5 }]);
    await act(async () => {
      bridge.handleProjection({
        resume: ['s-1'],
        fullReplay: [],
        fresh: [],
        cleanup: [],
      });
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
    bridge.detach();
  });

  it('fullReplay / fresh：afterSequence=0 全量回放', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      bridge.handleProjection({
        resume: [],
        fullReplay: ['s-full'],
        fresh: ['s-fresh'],
        cleanup: [],
      });
    });
    const resumes = sent
      .map(
        (raw) =>
          JSON.parse(raw) as {
            kind: string;
            body: { params?: { afterSequence?: number } };
          }
      )
      .filter((f) => f.kind === 'events.resume');
    expect(resumes).toHaveLength(2);
    for (const r of resumes) {
      expect(
        (r.body as unknown as { afterSequence: number }).afterSequence
      ).toBe(0);
    }
    bridge.detach();
  });

  it('cleanup：本地投影 + 事件窗口清理 + 会话索引重拉', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const listSessions = jest
      .fn()
      .mockResolvedValue([{ id: 's-keep', updatedAt: 1000 }]);
    const bridge = new FeedBridge({ gateway, listSessions });
    bridge.attach();
    sessionStore.getState().upsert({ id: 's-gone', updatedAt: 1000 });
    eventStore
      .getState()
      .ingest('s-gone', {
        type: 'message-end',
        sessionId: 's-gone',
        sequence: 1,
      });
    await act(async () => {
      bridge.handleProjection({
        resume: [],
        fullReplay: [],
        fresh: [],
        cleanup: ['s-gone'],
      });
      await Promise.resolve();
    });
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
      's-keep',
    ]);
    expect(eventStore.getState().windows['s-gone']).toBeUndefined();
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

describe('FeedBridge 设备在场查询（open 相位 fire-and-forget）', () => {
  it('listDevices 成功 → 写入设备数；失败 → 保持未知不伪造', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      bridge.handlePhaseChange('open');
      await Promise.resolve();
    });
    // remote.listDevices 请求已发出（fire-and-forget）
    expect(sent.some((raw) => raw.includes('remote.listDevices'))).toBe(true);
    // 无响应时保持 null（不伪造 0）
    expect(devicePresenceStore.getState().count).toBeNull();
    bridge.detach();
  });

  it('listDevices 响应 devices 数组 → 写入条数；null 载荷 → 保持未知', async () => {
    const sent: string[] = [];
    const gateway = new WsGateway({ send: (raw) => sent.push(raw) });
    const bridge = new FeedBridge({ gateway });
    bridge.attach();
    await act(async () => {
      bridge.handlePhaseChange('open');
      await Promise.resolve();
    });
    // 回填 result 帧（命中 pending → setCount）
    const sentRaw = sent.find((raw) => raw.includes('remote.listDevices'))!;
    const req = JSON.parse(sentRaw) as { msgId: string };
    await act(async () => {
      gateway.dispatchFrame(
        frame('result.remote.listDevices', {
          reqMsgId: req.msgId,
          ok: true,
          result: { devices: [{ id: 'd-1' }, { id: 'd-2' }] },
        })
      );
      await Promise.resolve();
    });
    expect(devicePresenceStore.getState().count).toBe(2);
    bridge.detach();
  });

  it('listDevices 失败 → warn 留痕且保持未知（不伪造 0）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 无 send 注入 → invoke 立即 reject
      const gateway = new WsGateway();
      const bridge = new FeedBridge({ gateway });
      bridge.attach();
      await act(async () => {
        bridge.handlePhaseChange('open');
        await Promise.resolve();
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('设备在场查询失败')
      );
      expect(devicePresenceStore.getState().count).toBeNull();
      bridge.detach();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('FeedBridge 会话索引对账（refreshSessions）', () => {
  it('listSessions 成功 → reconcile 写入；失败 → warn 留痕静默', async () => {
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
      await act(async () => {
        bridge.handlePhaseChange('open');
        await Promise.resolve();
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('会话索引对账失败')
      );
      bridge.detach();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
