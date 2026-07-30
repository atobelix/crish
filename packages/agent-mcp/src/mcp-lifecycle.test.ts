import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_STARTUP_GATE_TIMEOUT_MS,
  McpLifecycleError,
  McpLifecycleManager,
  type McpCachedToolDefinition,
  type McpLifecycleEvent,
  type McpServerConnection,
} from './mcp-lifecycle';
import type { AgentTool } from '@crish/shared-types';
import type { JsonObject, ToolExecutionContext } from '@crish/shared-types';

describe('MCP lifecycle manager', () => {
  it('uses a 250ms startup gate by default', () => {
    const manager = new McpLifecycleManager();

    expect(DEFAULT_MCP_STARTUP_GATE_TIMEOUT_MS).toBe(250);
    expect(manager.startupGateTimeoutMs).toBe(250);
    expect(manager.snapshot().summary.discovering).toBe(0);
  });

  it('returns cached deferred tools after the startup gate and refreshes them in the background', async () => {
    const release = deferred<McpServerConnection>();
    const cachedTool: McpCachedToolDefinition = {
      name: 'mcp__slow__echo',
      description: 'Cached echo',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
      },
      readOnly: true,
      summarize: (input) => `cached ${input.text ?? ''}`,
    };
    const liveTool = textTool(
      'mcp__slow__echo',
      (input) => `live:${input.text ?? ''}`
    );
    const events: McpLifecycleEvent[] = [];
    const manager = new McpLifecycleManager({
      startupGateTimeoutMs: 5,
      servers: [
        {
          name: 'slow',
          cachedTools: [cachedTool],
          adapter: {
            connect: () => release.promise,
          },
        },
      ],
    });
    manager.subscribe((event) => events.push(event));

    const tools = await manager.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['mcp__slow__echo']);
    expect(tools[0]?.category).toBe('mcp');
    expect(tools[0]?.isReadOnly({})).toBe(true);
    expect(tools[0]?.summarize({ text: 'hi' })).toBe('cached hi');
    expect(manager.snapshot().summary.starting).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'startup-gate-timeout',
        pendingServers: ['slow'],
        diagnostic: expect.objectContaining({
          code: 'MCP_STARTUP_GATE_TIMEOUT',
          severity: 'warning',
        }),
      })
    );

    const outputPromise = tools[0]!.execute({ text: 'hi' }, context());
    release.resolve({
      listTools: () => [liveTool],
    });

    await expect(outputPromise).resolves.toMatchObject({ text: 'live:hi' });
    await expect(manager.getServer('slow')?.waitForReady(50)).resolves.toBe(
      true
    );
    expect(manager.snapshot().summary.ready).toBe(1);
    await expect(manager.listTools()).resolves.toMatchObject([
      { label: 'mcp__slow__echo' },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tools-refreshed',
        server: 'slow',
        toolCount: 1,
      })
    );
  });

  it('isolates startup failures so healthy servers still provide tools', async () => {
    const manager = new McpLifecycleManager({
      startupGateTimeoutMs: 20,
      servers: [
        {
          name: 'good',
          adapter: {
            connect: () => ({
              listTools: () => [textTool('mcp__good__ping', () => 'pong')],
            }),
          },
        },
        {
          name: 'bad',
          cachedTools: [
            { name: 'mcp__bad__cached', description: 'Cached fallback' },
          ],
          adapter: {
            connect: async () => {
              throw new Error('handshake failed');
            },
          },
        },
      ],
    });

    const result = await manager.start();
    const tools = await manager.listTools();

    expect(result.readyServers).toEqual(['good']);
    expect(result.degradedServers).toEqual([
      {
        server: 'bad',
        diagnostic: expect.objectContaining({
          code: 'MCP_CONNECT_FAILED',
          message: 'handshake failed',
        }),
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__bad__cached',
      'mcp__good__ping',
    ]);
    expect(manager.snapshot().summary).toMatchObject({ ready: 1, degraded: 1 });

    await expect(
      tools
        .find((tool) => tool.name === 'mcp__bad__cached')!
        .execute({}, context())
    ).rejects.toBeInstanceOf(McpLifecycleError);
    expect(
      manager
        .getServer('bad')
        ?.snapshot()
        .diagnostics.map((diagnostic) => diagnostic.code)
    ).toContain('MCP_CONNECT_FAILED');
  });

  it('keeps refresh failures scoped to the server that failed', async () => {
    let goodVersion = 1;
    const manager = new McpLifecycleManager({
      startupGateTimeoutMs: 20,
      servers: [
        {
          name: 'good',
          adapter: {
            connect: () => ({
              listTools: () => [
                textTool('mcp__good__version', () => `v${goodVersion}`),
              ],
            }),
          },
        },
        {
          name: 'flaky',
          adapter: {
            connect: () => {
              let calls = 0;
              return {
                listTools: () => {
                  calls += 1;
                  if (calls > 1) throw new Error('refresh failed');
                  return [textTool('mcp__flaky__search', () => 'ok')];
                },
              };
            },
          },
        },
      ],
    });

    await manager.start();
    goodVersion = 2;
    const refresh = await manager.refreshAllTools();
    const tools = await manager.listTools();

    expect(refresh.refreshedServers).toEqual(['good']);
    expect(refresh.degradedServers).toEqual([
      {
        server: 'flaky',
        diagnostic: expect.objectContaining({
          code: 'MCP_LIST_TOOLS_FAILED',
          message: 'refresh failed',
        }),
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__flaky__search',
      'mcp__good__version',
    ]);
    await expect(
      tools
        .find((tool) => tool.name === 'mcp__good__version')!
        .execute({}, context())
    ).resolves.toMatchObject({ text: 'v2' });
    expect(manager.getServer('flaky')?.state).toBe('degraded');
  });

  it('reconnects degraded servers through the reconnecting state', async () => {
    let attempts = 0;
    const states: string[] = [];
    const manager = new McpLifecycleManager({
      startupGateTimeoutMs: 20,
      servers: [
        {
          name: 'docs',
          cachedTools: [
            { name: 'mcp__docs__cached_search', description: 'Cached search' },
          ],
          adapter: {
            connect: () => {
              attempts += 1;
              if (attempts === 1) throw new Error('boot failed');
              return {
                listTools: () => [
                  textTool('mcp__docs__search', () => 'result'),
                ],
              };
            },
          },
        },
      ],
    });
    manager.subscribe((event) => {
      if (event.type === 'server-state') states.push(event.state);
    });

    const startup = await manager.start();
    expect(startup.degradedServers).toHaveLength(1);
    expect(manager.getServer('docs')?.state).toBe('degraded');

    const reconnect = await manager.reconnectDegradedServers();
    const tools = await manager.listTools();

    expect(reconnect.reconnectedServers).toEqual(['docs']);
    expect(reconnect.degradedServers).toEqual([]);
    expect(states).toContain('reconnecting');
    expect(manager.getServer('docs')?.state).toBe('ready');
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__docs__search']);
    await expect(tools[0]!.execute({}, context())).resolves.toMatchObject({
      text: 'result',
    });
  });

  it('tears down every server, removes tools, and reports close diagnostics', async () => {
    let closed = 0;
    const manager = new McpLifecycleManager({
      startupGateTimeoutMs: 20,
      servers: [
        {
          name: 'docs',
          adapter: {
            connect: () => ({
              listTools: () => [textTool('mcp__docs__search', () => 'result')],
              close: () => {
                closed += 1;
                throw new Error('close failed');
              },
            }),
          },
        },
      ],
    });

    await manager.start();
    await expect(manager.listTools()).resolves.toHaveLength(1);

    const teardown = await manager.teardown();

    expect(closed).toBe(1);
    expect(teardown.stoppedServers).toEqual(['docs']);
    expect(teardown.diagnostics).toEqual([
      expect.objectContaining({ code: 'MCP_CLOSE_FAILED', phase: 'teardown' }),
    ]);
    expect(manager.snapshot().summary.stopped).toBe(1);
    await expect(manager.listTools()).resolves.toEqual([]);
  });

  it('startServer/stopServer control a single server and report unknown when missing', async () => {
    let connectCount = 0;
    let closed = 0;
    const manager = new McpLifecycleManager({
      startupGateTimeoutMs: 20,
      servers: [
        {
          name: 'docs',
          adapter: {
            connect: () => {
              connectCount += 1;
              return {
                listTools: () => [
                  textTool('mcp__docs__search', () => 'result'),
                ],
                close: () => {
                  closed += 1;
                },
              };
            },
          },
        },
      ],
    });

    await expect(manager.startServer('missing')).resolves.toEqual({
      state: 'unknown',
    });
    await expect(manager.stopServer('missing')).resolves.toEqual({
      state: 'unknown',
    });

    const started = await manager.startServer('docs');
    expect(started.state).toBe('ready');
    expect(connectCount).toBe(1);
    expect(manager.getServer('docs')?.state).toBe('ready');

    const stopped = await manager.stopServer('docs');
    expect(stopped.state).toBe('stopped');
    expect(closed).toBe(1);
    expect(manager.getServer('docs')?.state).toBe('stopped');

    const restarted = await manager.startServer('docs');
    expect(restarted.state).toBe('ready');
    expect(connectCount).toBe(2);
    expect(manager.getServer('docs')?.state).toBe('ready');
  });
});

function textTool(
  name: string,
  execute: (input: JsonObject) => string
): AgentTool {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    category: 'mcp',
    concurrency: 'parallel',
    isReadOnly: () => true,
    summarize: () => name,
    async execute(input) {
      return { text: execute(input) };
    },
  };
}

function context(): ToolExecutionContext {
  return {
    toolCallId: 'call',
    sessionId: 'session',
    cwd: 'C:/repo',
    signal: new AbortController().signal,
    emit: () => undefined,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
} {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
  };
}
