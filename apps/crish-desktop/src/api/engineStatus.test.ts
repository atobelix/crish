/**
 * engineStatus 投影单测（S2 分布式追踪最小面，D-05 §二 S2 验收④；
 * T5-1 心跳三态 + T5-1b 崩溃台账）：
 * - core_get_status 响应含 traceId 键 → EngineLiveStatus.traceId 投影；
 *   缺省（无活动 run）→ undefined；
 * - T5-1：transport 已就绪但请求连续 ENGINE_CRASH_PROBE_THRESHOLD 次
 *   失败/超时 → errorStore.connectionStatus = engine_crashed（探活判死）；
 *   单次失败不判死（防误报）；判死后探活成功 → 恢复 connected；
 * - T5-1b：lastCrash 投影 + 较上次查询新增崩溃文件 → errorStore 记录
 *   ENGINE_CRASH_PROBED（同文件不重复记录）。
 *
 * mock 面：transport 模块（getTransport）替换为桩 transport，request
 * 返回受控 raw 响应；userFacingErrors 静默（logInternalError 不抛）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchEngineLiveStatus,
  ENGINE_CRASH_PROBE_THRESHOLD,
  resetEngineHeartbeatForTests,
  type EngineLiveStatus,
} from './engineStatus';
import { errorStore } from '../services/ErrorStore';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  isReady: vi.fn(),
  waitUntilConnected: vi.fn(),
  logInternalError: vi.fn(),
  isEngineCrashishError: vi.fn(),
}));

vi.mock('./transport', () => ({
  getTransport: () => ({
    request: mocks.request,
    isReady: mocks.isReady,
    waitUntilConnected: mocks.waitUntilConnected,
  }),
}));

vi.mock('./userFacingErrors', () => ({
  logInternalError: mocks.logInternalError,
  isEngineCrashishError: mocks.isEngineCrashishError,
}));

function resetConnectionStatus(): void {
  errorStore.setConnectionStatus('connected');
  errorStore.resolveByCode('ENGINE_CRASH_PROBED');
  errorStore.resolveByCode('ENGINE_HEARTBEAT_FAILED');
}

beforeEach(() => {
  mocks.isEngineCrashishError.mockReturnValue(false);
  resetEngineHeartbeatForTests();
  resetConnectionStatus();
});

afterEach(() => {
  vi.clearAllMocks();
  resetConnectionStatus();
});

describe('fetchEngineLiveStatus · S2 traceId 投影', () => {
  it('core_get_status 响应含 traceId → EngineLiveStatus.traceId 投影', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockResolvedValue({
      engineReady: true,
      dbReady: true,
      activeRuns: [
        {
          runId: 'r1',
          sessionId: 's1',
          status: 'running',
          startedAt: 1,
          prompt: '',
        },
      ],
      pendingApprovals: [],
      traceId: 'run-t-1-2-3',
    });

    const live: EngineLiveStatus = await fetchEngineLiveStatus();
    expect(live.ok).toBe(true);
    expect(live.traceId).toBe('run-t-1-2-3');
    expect(mocks.request).toHaveBeenCalledWith(
      'core_get_status',
      {},
      { timeoutMs: 8_000 }
    );
  });

  it('响应无 traceId（无活动 run）→ traceId undefined（向后兼容缺省）', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockResolvedValue({
      engineReady: true,
      dbReady: true,
      activeRuns: [],
      pendingApprovals: [],
    });

    const live: EngineLiveStatus = await fetchEngineLiveStatus();
    expect(live.ok).toBe(true);
    expect(live.traceId).toBeUndefined();
  });

  it('traceId 非字符串（形状漂移）→ 缺省 undefined，不抛', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockResolvedValue({
      engineReady: true,
      dbReady: true,
      activeRuns: [],
      pendingApprovals: [],
      traceId: 42,
    });

    const live: EngineLiveStatus = await fetchEngineLiveStatus();
    expect(live.traceId).toBeUndefined();
  });
});

describe('fetchEngineLiveStatus · T5-1 心跳三态（探活判死）', () => {
  it('transport 已就绪 + 连续 N 次失败 → connectionStatus=engine_crashed + 记录心跳失败', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockRejectedValue(new Error('core_get_status timeout'));

    // 前 N-1 次：仅累计，不判死
    for (let i = 0; i < ENGINE_CRASH_PROBE_THRESHOLD - 1; i++) {
      const live = await fetchEngineLiveStatus();
      expect(live.ok).toBe(false);
      expect(live.error).toContain('timeout');
      expect(errorStore.getState().connectionStatus).not.toBe('engine_crashed');
    }

    // 第 N 次：判死 → engine_crashed
    const live = await fetchEngineLiveStatus();
    expect(live.ok).toBe(false);
    expect(errorStore.getState().connectionStatus).toBe('engine_crashed');
    expect(
      errorStore
        .getActiveErrors()
        .some((e) => e.code === 'ENGINE_HEARTBEAT_FAILED')
    ).toBe(true);
  });

  it('单次失败不判死（瞬时抖动防误报；transport 内部已有暂态重试一次）', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockRejectedValueOnce(new Error('boom'));
    mocks.request.mockResolvedValue({
      activeRuns: [],
      pendingApprovals: [],
    });

    const failed = await fetchEngineLiveStatus();
    expect(failed.ok).toBe(false);
    expect(errorStore.getState().connectionStatus).not.toBe('engine_crashed');

    // 下一次成功 → 计数归零，后续单次失败仍不判死
    const ok = await fetchEngineLiveStatus();
    expect(ok.ok).toBe(true);
    mocks.request.mockRejectedValue(new Error('boom'));
    const failed2 = await fetchEngineLiveStatus();
    expect(failed2.ok).toBe(false);
    expect(errorStore.getState().connectionStatus).not.toBe('engine_crashed');
  });

  it('判死后探活成功 → 恢复 connected + 自动关闭崩溃告警', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockRejectedValue(new Error('timeout'));
    for (let i = 0; i < ENGINE_CRASH_PROBE_THRESHOLD; i++) {
      await fetchEngineLiveStatus();
    }
    expect(errorStore.getState().connectionStatus).toBe('engine_crashed');

    // 恢复：成功响应 → connected + 告警关闭
    mocks.request.mockResolvedValue({
      activeRuns: [],
      pendingApprovals: [],
    });
    const live = await fetchEngineLiveStatus();
    expect(live.ok).toBe(true);
    expect(errorStore.getState().connectionStatus).toBe('connected');
    expect(
      errorStore
        .getActiveErrors()
        .some((e) => e.code === 'ENGINE_HEARTBEAT_FAILED')
    ).toBe(false);
  });

  it('transport 未就绪（命令面未建立）→ 不累计判死计数', async () => {
    mocks.isReady.mockReturnValue(false);
    mocks.waitUntilConnected.mockResolvedValue(false);
    mocks.request.mockRejectedValue(new Error('n/a'));

    for (let i = 0; i < ENGINE_CRASH_PROBE_THRESHOLD + 1; i++) {
      const live = await fetchEngineLiveStatus();
      expect(live.ok).toBe(false);
      expect(live.error).toBe('not_connected');
    }
    expect(errorStore.getState().connectionStatus).not.toBe('engine_crashed');
  });
});

describe('fetchEngineLiveStatus · T5-1b 崩溃台账投影', () => {
  it('lastCrash 存在 → crash 投影（camelCase 字段）', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockResolvedValue({
      activeRuns: [],
      pendingApprovals: [],
      lastCrash: {
        fileName: 'crash-proj-120000-main.log',
        timestampMs: 1_700_000_000_005,
      },
    });

    const live = await fetchEngineLiveStatus();
    expect(live.crash).toEqual({
      fileName: 'crash-proj-120000-main.log',
      timestampMs: 1_700_000_000_005,
    });
  });

  it('无 lastCrash → crash undefined（诚实缺省）', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockResolvedValue({
      activeRuns: [],
      pendingApprovals: [],
    });

    const live = await fetchEngineLiveStatus();
    expect(live.crash).toBeUndefined();
  });

  it('较上次查询新增崩溃文件 → errorStore 记录 ENGINE_CRASH_PROBED（同文件不重复）', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.request.mockResolvedValue({
      activeRuns: [],
      pendingApprovals: [],
      logDir: 'C:/logs',
      lastCrash: {
        fileName: 'crash-A-120000-main.log',
        timestampMs: 1_700_000_000_005,
      },
    });

    // 首次读到崩溃标记 → 记录
    await fetchEngineLiveStatus();
    let probed = errorStore
      .getActiveErrors()
      .find((e) => e.code === 'ENGINE_CRASH_PROBED');
    expect(probed).toBeTruthy();
    expect(probed?.technical).toContain('crash-A-120000-main.log');
    expect(probed?.technical).toContain('C:/logs');

    // 同文件再次读到 → 不重复记录（resolve 后仍不新增）
    errorStore.resolveByCode('ENGINE_CRASH_PROBED');
    await fetchEngineLiveStatus();
    expect(
      errorStore.getActiveErrors().some((e) => e.code === 'ENGINE_CRASH_PROBED')
    ).toBe(false);

    // 新崩溃文件（时间戳不同）→ 再次记录
    mocks.request.mockResolvedValue({
      activeRuns: [],
      pendingApprovals: [],
      lastCrash: {
        fileName: 'crash-B-130000-worker.log',
        timestampMs: 1_700_000_000_006,
      },
    });
    await fetchEngineLiveStatus();
    probed = errorStore
      .getActiveErrors()
      .find((e) => e.code === 'ENGINE_CRASH_PROBED');
    expect(probed?.technical).toContain('crash-B-130000-worker.log');
  });
});
