/**
 * engineStatus 投影单测（S2 分布式追踪最小面，D-05 §二 S2 验收④）：
 * core_get_status 响应含 traceId 键 → EngineLiveStatus.traceId 投影；
 * 缺省（无活动 run）→ undefined。
 *
 * mock 面：transport 模块（getTransport）替换为桩 transport，request
 * 返回受控 raw 响应；userFacingErrors 静默（logInternalError 不抛）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEngineLiveStatus, type EngineLiveStatus } from './engineStatus';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  isReady: vi.fn(),
  waitUntilConnected: vi.fn(),
  logInternalError: vi.fn(),
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
}));

afterEach(() => {
  vi.clearAllMocks();
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
