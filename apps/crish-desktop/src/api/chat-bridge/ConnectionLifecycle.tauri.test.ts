/**
 * C1.2 Tauri IPC 路径测试（C3.1 后唯一路径）：mock '../transport'（getTransport 返回 fake Tauri transport），
 * 验证：
 * - run-task 经 startRunTask 分派（'core_run_task'，参数组装保留、不含 type 字段）
 * - 事件经 transport.onMessage → router.onMsg 全流程路由（消息→流→工具→收口）
 * - messageBelongsToRun 过滤不误杀（B6.3 注入 runId 后按 runId 精确路由）
 * - 核心未就绪时拒绝启动（C3.4 后无 directFetch 降级）
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createStreamSession, streamViaEngine } from './ConnectionLifecycle';
import type { StreamCallbacks } from '../chatApi';
import type { StreamState } from './handlers/streamState';
import type { SessionMessage } from '../../store/types';
import { resetControlMetrics } from '../controlMetrics';
import { mockTauriCommand } from '../../test-setup';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../modelsCatalogStore';
import {
  sessionRuntimeRegistry,
  setSessionThinkingTitle,
} from '../SessionRuntimeRegistry';
import type { ProviderSpec } from '../modelsCatalogTypes';

const { fakeTransport, startRunTask, messageListener, loadSessionBodyMock } =
  vi.hoisted(() => {
    const messageListener = {
      current: null as ((msg: Record<string, unknown>) => void) | null,
    };
    const fakeTransport = {
      waitUntilConnected: vi.fn(async () => true),
      isReady: vi.fn(() => true),
      onMessage: vi.fn((cb: (msg: Record<string, unknown>) => void) => {
        messageListener.current = cb;
        return () => undefined;
      }),
      getStatus: vi.fn(() => 'connected' as const),
      onStatus: vi.fn(() => () => undefined),
      request: vi.fn(async () => ({ runId: 'r', sessionId: 's' })),
      send: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    return {
      fakeTransport,
      startRunTask: vi.fn(async () => undefined),
      messageListener,
      // P4 T-31：loadSessionBody mock（createStreamSession 动态 import 的历史真源）
      loadSessionBodyMock: vi.fn(async () => []),
    };
  });

vi.mock('../transport', () => ({
  getTransport: () => fakeTransport,
  startRunTask,
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

// P4 T-31：createStreamSession 内 `await import('../session-persistence/sessionRustDb')`
// 的水合数据源 mock（测试可注入会话正文；缺省空会话）
vi.mock('../session-persistence/sessionRustDb', () => ({
  loadSessionBody: loadSessionBodyMock,
}));

describe('ConnectionLifecycle Tauri IPC 路径（C1.2）', () => {
  beforeEach(() => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    messageListener.current = null;
    startRunTask.mockClear();
    loadSessionBodyMock.mockClear();
    loadSessionBodyMock.mockResolvedValue([]);
    resetControlMetrics();
  });

  afterEach(() => {
    localStorage.removeItem('crish_active_profile_id');
    localStorage.removeItem('crish_active_model_id');
    localStorage.removeItem('crish_model_meta_v1');
    localStorage.removeItem('crish_pending_context_state_v1');
    resetModelsCatalogMirror();
    sessionRuntimeRegistry.clearAll();
  });

  describe('createStreamSession：core_run_task 参数组装', () => {
    it('run-task 参数经 startRunTask 分派，且不再内嵌 type 字段', async () => {
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };
      const finish = vi.fn();

      await createStreamSession(
        'hello',
        'sess-id-1',
        'run-id-1',
        callbacks,
        {
          clientMessageId: 'user-msg-1',
          assistantClientMessageId: 'assistant-msg-1',
        },
        state,
        () => undefined,
        finish,
        'assistant-msg-1'
      );

      expect(finish).not.toHaveBeenCalled();
      expect(startRunTask).toHaveBeenCalledTimes(1);
      const [transport, params] = startRunTask.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(transport).toBe(fakeTransport);
      expect(params).toEqual(
        expect.objectContaining({
          runId: 'run-id-1',
          prompt: 'hello',
          sessionId: 'sess-id-1',
          permissionMode: 'ask',
          clientMessageId: 'user-msg-1',
          assistantClientMessageId: 'assistant-msg-1',
          // P1：systemPrompt 经 composeSystemPrompt 组装后下发（settings 为 medium → 仅 guidance）
          systemPrompt:
            'Response style: balanced. Be clear and complete without padding. Explain non-obvious steps briefly.',
        })
      );
      // settings.defaultThinkingLevel 不再当 reasoningEffort 规格
      expect(params.reasoningEffort).toBeUndefined();
      expect(params.thinkingWire).toBeUndefined();
      // I1-β：budgetDifficulty 已从 run-task 参数移除（无 Rust 消费面）
      expect(params.budgetDifficulty).toBeUndefined();
      // I1-α②：无 pending context-state 时不携带 contextState 参数
      expect(params.contextState).toBeUndefined();
      // 通道名（core_run_task / run-task）由 startRunTask 分派，不再内嵌进 payload
      expect(params.type).toBeUndefined();
      // 事件订阅已挂在 transport.onMessage（懒订阅 listen('workbench-run-event') 的入口）
      expect(fakeTransport.onMessage).toHaveBeenCalledTimes(1);
      expect(messageListener.current).not.toBeNull();
    });

    it('核心未就绪（waitUntilConnected=false）→ 拒绝启动（C3.4 后无 directFetch 降级）', async () => {
      vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(false);
      vi.mocked(fakeTransport.isReady).mockReturnValue(false);
      const onRunError = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
        onRunError,
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };
      const finish = vi.fn();

      await createStreamSession(
        'offline ipc',
        'sess-t-2',
        'run-t-2',
        callbacks,
        undefined,
        state,
        () => undefined,
        finish
      );

      expect(startRunTask).not.toHaveBeenCalled();
      expect(finish).toHaveBeenCalled();
      expect(onRunError).toHaveBeenCalled();
    });

    it('options.systemPrompt 与 guidance 经 composeSystemPrompt 拼接后经 startRunTask 下发', async () => {
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };
      const finish = vi.fn();

      await createStreamSession(
        'hello base',
        'sess-id-2',
        'run-id-2',
        callbacks,
        {
          systemPrompt: '  Base instructions.  ',
        },
        state,
        () => undefined,
        finish
      );

      expect(startRunTask).toHaveBeenCalledTimes(1);
      const params = startRunTask.mock.calls[0][1] as Record<string, unknown>;
      expect(params.systemPrompt).toBe(
        'Base instructions.\n\n' +
          'Response style: balanced. Be clear and complete without padding. Explain non-obvious steps briefly.'
      );
    });

    it('P4 T-31：history 经 startRunTask 透传（loadSessionBody 数据源；完成态过滤 + 排除当前消息 + camelCase 字段）', async () => {
      localStorage.setItem('crish_active_profile_id', 'p1');
      localStorage.setItem('crish_active_model_id', 'deepseek-chat');
      resetModelsCatalogMirror();
      mockTauriCommand('workbench_read_models_yaml', () => ({
        path: 'C:\\tmp\\models.yaml',
        content: '',
        template: '',
        seeded: false,
        parseError: null,
        providers: {
          p1: {
            displayName: 'P1',
            baseUrl: 'https://example.invalid/v1',
            protocol: 'openai/chat',
            models: [{ id: 'deepseek-chat', contextWindow: 131_072 }],
          } satisfies ProviderSpec,
        },
      }));
      mockTauriCommand('workbench_save_models_yaml', () => ({
        path: 'C:\\tmp\\models.yaml',
      }));
      await ensureModelsCatalogLoaded(true);
      loadSessionBodyMock.mockResolvedValue([
        {
          id: 'h1',
          sender: 'user',
          text: '第一轮问题',
          timestamp: 1000,
          status: 'completed',
        },
        {
          id: 'h2',
          sender: 'assistant',
          text: '第一轮回复',
          thinking: '思考中',
          timestamp: 2000,
          status: 'completed',
          toolCalls: [
            { id: 'c1', name: 'bash', arguments: '{}', status: 'success' },
          ],
          toolCallResults: [{ id: 'c1', output: 'ok', isError: false }],
        },
        // 当前 run 的 user 消息：完成态也要排除（避免历史与 prompt 重复）
        {
          id: 'cur',
          sender: 'user',
          text: '当前问题',
          timestamp: 3000,
          status: 'completed',
        },
      ] as SessionMessage[]);

      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };

      await createStreamSession(
        '当前问题',
        'sess-h-1',
        'run-h-1',
        callbacks,
        { clientMessageId: 'cur' },
        state,
        () => undefined,
        vi.fn()
      );

      expect(loadSessionBodyMock).toHaveBeenCalledWith('sess-h-1');
      expect(startRunTask).toHaveBeenCalledTimes(1);
      const params = startRunTask.mock.calls[0][1] as Record<string, unknown>;
      expect(params.history).toEqual([
        {
          id: 'h1',
          sender: 'user',
          text: '第一轮问题',
          timestamp: 1000,
          status: 'completed',
        },
        {
          id: 'h2',
          sender: 'assistant',
          text: '第一轮回复',
          thinking: '思考中',
          timestamp: 2000,
          status: 'completed',
          tool_calls_json:
            '[{"id":"c1","name":"bash","arguments":"{}","status":"success"}]',
          tool_call_results_json: '[{"id":"c1","output":"ok","isError":false}]',
        },
      ]);
      // contextWindow 经 live contextWindow 透传（T-33 预算钳制消费）
      expect(params.contextWindow).toBe(131_072);
    });

    it('options.thinkingWire 原样作为 reasoningEffort（不 toLowerCase settings）', async () => {
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };

      await createStreamSession(
        'hello',
        'sess-think-1',
        'run-think-1',
        callbacks,
        { thinkingTitle: 'High', thinkingWire: 'HIGH' },
        state,
        () => undefined,
        vi.fn()
      );

      expect(startRunTask).toHaveBeenCalledTimes(1);
      const params = startRunTask.mock.calls[0][1] as Record<string, unknown>;
      expect(params.reasoningEffort).toBe('HIGH');
      expect(params.thinkingTitle).toBe('High');
      expect(params.thinkingWire).toBe('HIGH');
    });

    it('会话 Title + live 字典 → reasoningEffort 为 yaml value', async () => {
      localStorage.setItem('crish_active_profile_id', 'gemini');
      localStorage.setItem('crish_active_model_id', 'flash');
      resetModelsCatalogMirror();
      mockTauriCommand('workbench_read_models_yaml', () => ({
        path: 'C:\\tmp\\models.yaml',
        content: '',
        template: '',
        seeded: false,
        parseError: null,
        providers: {
          gemini: {
            displayName: 'Gemini',
            baseUrl: 'https://generativelanguage.googleapis.com',
            protocol: 'google/generate-content',
            models: [
              { id: 'flash', thinking: { Off: 'disabled', High: 'HIGH' } },
            ],
          } satisfies ProviderSpec,
        },
      }));
      mockTauriCommand('workbench_save_models_yaml', () => ({
        path: 'C:\\tmp\\models.yaml',
      }));
      await ensureModelsCatalogLoaded(true);
      setSessionThinkingTitle('sess-think-2', 'High');

      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };

      await createStreamSession(
        'hello',
        'sess-think-2',
        'run-think-2',
        callbacks,
        undefined,
        state,
        () => undefined,
        vi.fn()
      );

      const params = startRunTask.mock.calls[0][1] as Record<string, unknown>;
      expect(params.reasoningEffort).toBe('HIGH');
      expect(params.thinkingTitle).toBe('High');
      expect(params.thinkingWire).toBe('HIGH');
    });

    it('P4 T-31：空会话 → history / contextWindow 均不发送（params 无对应字段）', async () => {
      loadSessionBodyMock.mockResolvedValue([]);

      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };

      await createStreamSession(
        'hi empty',
        'sess-empty-1',
        'run-empty-1',
        callbacks,
        undefined,
        state,
        () => undefined,
        vi.fn()
      );

      expect(startRunTask).toHaveBeenCalledTimes(1);
      const params = startRunTask.mock.calls[0][1] as Record<string, unknown>;
      expect(params.history).toBeUndefined();
      expect(params.contextWindow).toBeUndefined();
      // 其余参数不受影响（现状单消息 run 向后兼容）
      expect(params.prompt).toBe('hi empty');
      expect(params.sessionId).toBe('sess-empty-1');
    });
  });

  describe('streamViaEngine：listen 事件流全流程（消息→流→工具→收口）', () => {
    it('平铺 IPC 事件经 transport.onMessage → router.onMsg 路由；runId 过滤不误杀', async () => {
      let capturedRunId = '';
      const onChunk = vi.fn();
      const onToolStart = vi.fn();
      const onComplete = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk,
        onThought: vi.fn(),
        onToolStart,
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete,
        onRunMeta: ({ runId }) => {
          capturedRunId = runId;
        },
      };

      const cancel = streamViaEngine(
        'hello ipc',
        callbacks,
        'sess-ipc-1',
        'asst-ipc-1'
      );

      await vi.waitFor(() => {
        expect(startRunTask).toHaveBeenCalledTimes(1);
        expect(messageListener.current).not.toBeNull();
      });
      // 前端 runId 自管（03 §3.1）：请求携带与本地一致，Rust 回发事件注入同一 runId
      const params = startRunTask.mock.calls[0][1] as Record<string, unknown>;
      expect(params.runId).toBe(capturedRunId);
      expect(params.prompt).toBe('hello ipc');
      expect(params.sessionId).toBe('sess-ipc-1');

      const listener = messageListener.current!;
      // 正文增量（B6.3 平铺事件：顶层 runId/sequence）
      listener({
        type: 'message-delta',
        runId: capturedRunId,
        sequence: 1,
        block: { type: 'text', text: 'Hi ' },
      });
      listener({
        type: 'message-delta',
        runId: capturedRunId,
        sequence: 2,
        block: { type: 'text', text: 'IPC' },
      });
      expect(onChunk.mock.calls.map((c) => c[0]).join('')).toBe('Hi IPC');

      // 工具事件
      listener({
        type: 'tool-start',
        runId: capturedRunId,
        sequence: 3,
        call: { id: 't-ipc', toolName: 'bash', args: 'ls' },
      });
      expect(onToolStart).toHaveBeenCalledWith('t-ipc', 'bash', 'ls', '');

      // 过滤不误杀：他 run 事件不路由（runId 注入后 filter 精确命中）
      onChunk.mockClear();
      listener({
        type: 'message-delta',
        runId: 'run-other',
        sequence: 4,
        block: { type: 'text', text: 'DROP' },
      });
      expect(onChunk).not.toHaveBeenCalled();

      // 收口：run-terminal(completed) → finish → onComplete
      listener({
        type: 'run-terminal',
        runId: capturedRunId,
        sequence: 5,
        terminal: 'completed',
      });
      expect(onComplete).toHaveBeenCalled();
      cancel();
    });
  });
});
