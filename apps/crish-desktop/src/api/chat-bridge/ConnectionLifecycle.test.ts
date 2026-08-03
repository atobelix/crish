/**
 * ConnectionLifecycle 单测（Tauri IPC transport 版，C3.1）。
 * - 完整 run-task / 事件流契约见 ConnectionLifecycle.tauri.test.ts；
 * - 本文件覆盖 createFinishController / createStreamCancel / ensureEngineConnected 纯逻辑面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFinishController,
  createStreamCancel,
  ensureEngineConnected,
  composeSystemPrompt,
} from './ConnectionLifecycle';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamCallbacks } from '../chatApi';
import type { StreamState } from './handlers/streamState';
import { getControlMetrics, resetControlMetrics } from '../controlMetrics';

const { fakeTransport } = vi.hoisted(() => {
  const fakeTransport = {
    waitUntilConnected: vi.fn(async () => true),
    isReady: vi.fn(() => true),
    onMessage: vi.fn(() => () => undefined),
    getStatus: vi.fn(() => 'connected' as const),
    onStatus: vi.fn(() => () => undefined),
    request: vi.fn(async () => ({ ok: true })),
    send: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  return { fakeTransport };
});

vi.mock('../transport', () => ({
  getTransport: () => fakeTransport,
  startRunTask: vi.fn(async () => undefined),
  resetTransportForTests: () => undefined,
  TauriTransport: class TauriTransport {},
}));

vi.mock('../projectStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectStore')>();
  return {
    ...actual,
    getWorkspacePath: () => 'C:/tmp/ws',
  };
});

vi.mock('../storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storeAccess')>();
  return {
    ...actual,
    getPermissionMode: () => 'ask',
  };
});

vi.mock('../clientApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientApi')>();
  return {
    ...actual,
    clientApi: {
      ...actual.clientApi,
      getSettingsEx: vi.fn().mockResolvedValue({
        defaultThinkingLevel: 'medium',
        responseStyle: 'medium',
      }),
    },
  };
});

function makeState(partial: Partial<StreamState> = {}): StreamState {
  return {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
    ...partial,
  };
}

describe('composeSystemPrompt（P1：三形态唯一确定）', () => {
  const guidance = 'Response style: balanced. Be clear and complete.';

  it('base 与 guidance 都存在 → 各自 trim 后按 "\\n\\n" 拼接', () => {
    expect(
      composeSystemPrompt('  Base instructions.  ', `  ${guidance}  `)
    ).toBe(`Base instructions.\n\n${guidance}`);
  });

  it('guidance 为空 → 仅 base（trim 后）', () => {
    expect(composeSystemPrompt('  Base only.  ', undefined)).toBe('Base only.');
    expect(composeSystemPrompt('Base only.', '   ')).toBe('Base only.');
  });

  it('base 为空 → 仅 guidance（trim 后）', () => {
    expect(composeSystemPrompt(undefined, `  ${guidance}  `)).toBe(guidance);
    expect(composeSystemPrompt('', guidance)).toBe(guidance);
  });

  it('两者皆空（undefined / 空串 / 纯空白）→ undefined', () => {
    expect(composeSystemPrompt(undefined, undefined)).toBeUndefined();
    expect(composeSystemPrompt('', undefined)).toBeUndefined();
    expect(composeSystemPrompt(undefined, '')).toBeUndefined();
    expect(composeSystemPrompt('   ', '  ')).toBeUndefined();
  });

  it('base 含 "Response style:" 字样不特殊处理（同配置形态唯一）', () => {
    const baseWithStyle = 'Response style: thorough. User says hi.';
    expect(composeSystemPrompt(baseWithStyle, guidance)).toBe(
      `${baseWithStyle}\n\n${guidance}`
    );
  });
});

describe('ConnectionLifecycle（Tauri IPC 版）', () => {
  beforeEach(() => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    fakeTransport.request.mockClear();
    fakeTransport.send.mockClear();
    resetControlMetrics();
  });

  describe('ensureEngineConnected', () => {
    it('核心就绪 → ok:true（waitUntilConnected 即 core_get_status 轮询）', async () => {
      const res = await ensureEngineConnected();
      expect(res.ok).toBe(true);
      expect(fakeTransport.waitUntilConnected).toHaveBeenCalledWith(20_000);
    });

    it('核心未就绪 → ok:false + network 文案', async () => {
      vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(false);
      const res = await ensureEngineConnected();
      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
    });
  });

  describe('createFinishController', () => {
    it('invokes onComplete when finishing stream state', () => {
      const approvalFlow = new ApprovalFlowMachine();
      const onComplete = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete,
      };
      const cleanup = vi.fn();
      const state = makeState();

      const controller = createFinishController(
        approvalFlow,
        callbacks,
        cleanup,
        state
      );

      controller.finish(true);

      expect(state.finished).toBe(true);
      expect(cleanup).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
    });
  });

  describe('createStreamCancel', () => {
    it('force 默认：state 收口 + onComplete（run-control L3 经 compositionRoot 分派）', async () => {
      const approvalFlow = new ApprovalFlowMachine();
      const onComplete = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete,
      };
      const cleanup = vi.fn();
      const state = makeState();

      const cancel = createStreamCancel(
        'run-test-1',
        callbacks,
        approvalFlow,
        cleanup,
        state
      );

      cancel();

      expect(state.cancelled).toBe(true);
      expect(state.finished).toBe(true);
      expect(cleanup).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
      // metrics：L3 force_cancel 只记一次 level
      expect(getControlMetrics().run_control_L3).toBe(1);
    });

    it('cooperative 模式 → L2（metrics 记 L2）', () => {
      const approvalFlow = new ApprovalFlowMachine();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state = makeState();

      const cancel = createStreamCancel(
        'run-coop-1',
        callbacks,
        approvalFlow,
        () => undefined,
        state
      );

      cancel({ mode: 'cooperative' });

      expect(state.cancelled).toBe(true);
      expect(getControlMetrics().run_control_L2).toBe(1);
      expect(getControlMetrics().run_control_L3).toBe(0);
    });
  });
});
