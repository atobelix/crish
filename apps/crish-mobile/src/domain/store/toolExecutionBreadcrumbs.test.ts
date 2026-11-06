// 工具执行面包屑套件（2026-11-05 返工，波 1 要点 3）：
// ① 模块面：记录/环上限/落盘镜像/重启读回/坏值收敛；
// ② 注册表集成：executeToolCall 在开始与终局各落一条（成功、工具级
// 失败、超时三态）；③ 落败兜底：超时获胜后工具迟到 reject 必须被
// no-op catch 消费，不产生 unhandled rejection。
import { MobileToolRegistry } from '@/adapters/tools/toolRegistry';
import type { MobileToolDefinition } from '@/adapters/tools/types';
import {
  configureToolExecutionBreadcrumbPersistence,
  getToolExecutionBreadcrumbs,
  loadPersistedToolExecutionBreadcrumbs,
  parseToolExecutionBreadcrumbs,
  recordToolExecutionBreadcrumb,
  resetToolExecutionBreadcrumbsForTest,
  TOOL_EXECUTION_BREADCRUMB_KEY,
  TOOL_EXECUTION_BREADCRUMB_MAX,
  type ToolExecutionBreadcrumbPersist,
} from './toolExecutionBreadcrumbs';

class MemoryPersist implements ToolExecutionBreadcrumbPersist {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function fakeTool(
  overrides: Partial<MobileToolDefinition>
): MobileToolDefinition {
  return {
    name: 'fake_tool',
    description: '测试工具',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({
      toolCallId: '',
      toolName: 'fake_tool',
      ok: true,
      output: 'done',
    }),
    ...overrides,
  };
}

beforeEach(() => {
  resetToolExecutionBreadcrumbsForTest();
});

afterEach(() => {
  resetToolExecutionBreadcrumbsForTest();
});

describe('toolExecutionBreadcrumbs（模块面）', () => {
  it('按序记录并可读回；超过环上限丢最旧', () => {
    recordToolExecutionBreadcrumb({
      toolName: 'a',
      toolCallId: 'c1',
      stage: 'start',
      atMs: 1,
    });
    recordToolExecutionBreadcrumb({
      toolName: 'a',
      toolCallId: 'c1',
      stage: 'success',
      atMs: 2,
    });
    expect(getToolExecutionBreadcrumbs().map((c) => c.stage)).toEqual([
      'start',
      'success',
    ]);

    for (let i = 0; i < TOOL_EXECUTION_BREADCRUMB_MAX + 5; i += 1) {
      recordToolExecutionBreadcrumb({
        toolName: 'b',
        toolCallId: `c${i}`,
        stage: 'start',
        atMs: 10 + i,
      });
    }
    const ring = getToolExecutionBreadcrumbs();
    expect(ring).toHaveLength(TOOL_EXECUTION_BREADCRUMB_MAX);
    expect(ring[ring.length - 1]?.toolCallId).toBe(
      `c${TOOL_EXECUTION_BREADCRUMB_MAX + 4}`
    );
  });

  it('落盘镜像 + 重启读回：有 start 无终局的悬空调用可被对齐', async () => {
    const persist = new MemoryPersist();
    configureToolExecutionBreadcrumbPersistence(persist);
    recordToolExecutionBreadcrumb({
      toolName: 'web_search',
      toolCallId: 'call-x',
      stage: 'start',
      atMs: 100,
    });
    // 落盘是尽力异步：等待其落地
    await new Promise((r) => setTimeout(r, 0));
    expect(persist.map.has(TOOL_EXECUTION_BREADCRUMB_KEY)).toBe(true);

    // 模拟进程重启：内存环清空、重新注入同一持久面后读回
    resetToolExecutionBreadcrumbsForTest();
    expect(getToolExecutionBreadcrumbs()).toHaveLength(0);
    configureToolExecutionBreadcrumbPersistence(persist);
    const restored = await loadPersistedToolExecutionBreadcrumbs();
    expect(restored).toEqual([
      {
        toolName: 'web_search',
        toolCallId: 'call-x',
        stage: 'start',
        atMs: 100,
      },
    ]);
  });

  it('parse 鲁棒性：坏值一律收敛为空，绝不抛', () => {
    expect(parseToolExecutionBreadcrumbs(null)).toEqual([]);
    expect(parseToolExecutionBreadcrumbs('not-json')).toEqual([]);
    expect(parseToolExecutionBreadcrumbs('{"x":1}')).toEqual([]);
    expect(
      parseToolExecutionBreadcrumbs(
        JSON.stringify([
          { toolName: 'a', toolCallId: 'c', stage: 'bogus', atMs: 1 },
          { toolName: 'a', toolCallId: 'c', stage: 'start', atMs: 'x' },
          { toolName: 'a', toolCallId: 'c', stage: 'start', atMs: 3 },
        ])
      )
    ).toEqual([
      { toolName: 'a', toolCallId: 'c', stage: 'start', atMs: 3 },
    ]);
  });

  it('未注入持久面时 loadPersisted 返回空（内存降级口径）', async () => {
    recordToolExecutionBreadcrumb({
      toolName: 'a',
      toolCallId: 'c1',
      stage: 'start',
      atMs: 1,
    });
    await expect(loadPersistedToolExecutionBreadcrumbs()).resolves.toEqual([]);
  });
});

describe('toolRegistry 集成（面包屑 + 落败兜底）', () => {
  it('成功执行：start + success 两条，工具名与调用 id 对齐', async () => {
    const registry = new MobileToolRegistry();
    registry.register(fakeTool({}));
    const result = await registry.executeToolCall(
      { id: 'call-ok', name: 'fake_tool', arguments: '{}' },
      {}
    );
    expect(result.ok).toBe(true);
    const crumbs = getToolExecutionBreadcrumbs();
    expect(crumbs.map((c) => c.stage)).toEqual(['start', 'success']);
    expect(crumbs[0]).toMatchObject({
      toolName: 'fake_tool',
      toolCallId: 'call-ok',
    });
  });

  it('工具以结果对象返回失败：终局记 error（不是 success）', async () => {
    const registry = new MobileToolRegistry();
    registry.register(
      fakeTool({
        execute: async () => ({
          toolCallId: '',
          toolName: 'fake_tool',
          ok: false,
          output: 'bad',
          error: 'nope',
        }),
      })
    );
    const result = await registry.executeToolCall(
      { id: 'call-fail', name: 'fake_tool', arguments: '{}' },
      {}
    );
    expect(result.ok).toBe(false);
    expect(getToolExecutionBreadcrumbs().map((c) => c.stage)).toEqual([
      'start',
      'error',
    ]);
  });

  it('超时获胜 + 工具迟到 reject：被 no-op catch 消费，无 unhandled rejection，终局记 timeout', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const registry = new MobileToolRegistry();
      registry.register(
        fakeTool({
          timeoutMs: 20,
          execute: () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('late failure')), 80);
            }),
        })
      );
      const result = await registry.executeToolCall(
        { id: 'call-timeout', name: 'fake_tool', arguments: '{}' },
        {}
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe('timeout');
      expect(getToolExecutionBreadcrumbs().map((c) => c.stage)).toEqual([
        'start',
        'timeout',
      ]);
      // 等迟到 reject 发生并越过 unhandled 判定窗口
      await new Promise((r) => setTimeout(r, 200));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
