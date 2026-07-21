import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { DaemonInboundMessage, ConnectedClient } from './types';
import { DaemonRequestHandlers } from './server-handlers';

type HandlersOptions = ConstructorParameters<typeof DaemonRequestHandlers>[0];

function createMockWebSocket(): WebSocket {
  return {
    readyState: 1,
    close: vi.fn(),
    send: vi.fn(),
  } as unknown as WebSocket;
}

function createMockClient(id = 'client_1'): ConnectedClient {
  return { id, label: 'test client', joinedAt: new Date().toISOString() };
}

function mockOptions(): HandlersOptions {
  return {
    runHandler: {
      handleRunTaskWithOrchestrator: vi.fn(),
      handleCancelRun: vi.fn(),
      activeRunCount: vi.fn().mockReturnValue(0),
      triggerWorkflowRun: vi.fn(),
      triggerDueWorkflow: vi.fn(),
      handleListMutationLeases: vi.fn(),
      waitForBackgroundWorkflowRuns: vi.fn(),
    },
    orchestrator: {} as HandlersOptions['orchestrator'],
    approvalQueue: {
      resolve: vi.fn().mockReturnValue(true),
      getPendingApprovals: vi.fn().mockReturnValue([]),
    } as unknown as HandlersOptions['approvalQueue'],
    config: { defaultCwd: 'C:/workspace' } as HandlersOptions['config'],
    runtimeFactory: {
      getProviderStatusSnapshot: vi.fn().mockReturnValue({}),
      getMcpStatusSnapshot: vi.fn().mockReturnValue({}),
      getProductAdapterStatusSnapshot: vi.fn().mockReturnValue([]),
      listMcpServers: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      getArtifactContent: vi.fn().mockResolvedValue(null),
      listMemories: vi.fn().mockResolvedValue([]),
      deleteMemory: vi.fn().mockResolvedValue(true),
      listCheckpoints: vi.fn().mockResolvedValue([]),
      restoreCheckpoint: vi.fn().mockResolvedValue(true),
      getCheckpointDiff: vi.fn().mockResolvedValue(null),
      getSubagentStatus: vi.fn().mockResolvedValue({}),
      startMcpServer: vi.fn().mockResolvedValue({ state: 'starting' }),
      stopMcpServer: vi.fn().mockResolvedValue({ state: 'stopped' }),
    } as unknown as HandlersOptions['runtimeFactory'],
    backgroundTasks: {} as HandlersOptions['backgroundTasks'],
    workflowStore: {} as HandlersOptions['workflowStore'],
    planDocumentStore: {} as HandlersOptions['planDocumentStore'],
    scopedContextStore: {} as HandlersOptions['scopedContextStore'],
    sessionMetadataStore: {} as HandlersOptions['sessionMetadataStore'],
    transport: { send: vi.fn(), sendError: vi.fn(), broadcast: vi.fn() },
    subagentBridge: {} as HandlersOptions['subagentBridge'],
    getLifecycleSnapshot: vi.fn().mockReturnValue({}),
    getConfigUpdateHandler: vi.fn().mockReturnValue(vi.fn()),
    recordDiagnostic: vi.fn(),
  } as HandlersOptions;
}

function createMessage(
  type: string,
  overrides: Record<string, unknown> = {}
): DaemonInboundMessage {
  return {
    type,
    correlationId: 'corr_1',
    ...overrides,
  } as DaemonInboundMessage;
}

describe('DaemonRequestHandlers', () => {
  it('handles ping by sending pong', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('ping')
    );
    expect(opts.transport.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'pong', correlationId: 'corr_1' })
    );
  });

  it('handles run-task by delegating to runHandler', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    const ws = createMockWebSocket();
    const msg = createMessage('run-task');
    await handlers.handleInboundMessage(ws, createMockClient(), msg);
    expect(opts.runHandler.handleRunTaskWithOrchestrator).toHaveBeenCalledWith(
      ws,
      'client_1',
      msg
    );
  });

  it('handles cancel-run by delegating to runHandler', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    const msg = createMessage('cancel-run');
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      msg
    );
    expect(opts.runHandler.handleCancelRun).toHaveBeenCalledWith(msg);
  });

  it('handles list-mutation-leases by delegating', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    const ws = createMockWebSocket();
    const msg = createMessage('list-mutation-leases');
    await handlers.handleInboundMessage(ws, createMockClient(), msg);
    expect(opts.runHandler.handleListMutationLeases).toHaveBeenCalledWith(
      ws,
      msg
    );
  });

  it('handles approve-tool by delegating to approval handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('approve-tool')
    );
    expect(opts.approvalQueue.resolve).toHaveBeenCalled();
  });

  it('handles deny-tool by delegating to approval handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('deny-tool')
    );
    expect(opts.approvalQueue.resolve).toHaveBeenCalled();
  });

  it('sends UNKNOWN_MESSAGE_TYPE error for unrecognized message types', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    const msg = {
      type: 'unknown-type',
      correlationId: 'corr_1',
    } as DaemonInboundMessage;
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      msg
    );
    expect(opts.transport.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'UNKNOWN_MESSAGE_TYPE',
      expect.stringContaining('unknown-type'),
      undefined,
      expect.anything()
    );
  });

  it('dispatches probe-provider-models via config handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('probe-provider-models')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches probe-provider-chat via config handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('probe-provider-chat')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches list-artifacts via artifact handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('list-artifacts')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches get-artifact-content via artifact handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('get-artifact-content')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches list-memories via artifact handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('list-memories')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches delete-memory via artifact handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('delete-memory')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches list-checkpoints via artifact handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('list-checkpoints')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches restore-checkpoint via artifact handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('restore-checkpoint')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches get-checkpoint-diff via artifact handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('get-checkpoint-diff')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches get-subagent-status via subagent handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('get-subagent-status')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches start-mcp-server via mcp handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('start-mcp-server')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches stop-mcp-server via mcp handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('stop-mcp-server')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });

  it('dispatches list-mcp-servers via mcp handlers', async () => {
    const opts = mockOptions();
    const handlers = new DaemonRequestHandlers(opts);
    await handlers.handleInboundMessage(
      createMockWebSocket(),
      createMockClient(),
      createMessage('list-mcp-servers')
    );
    expect(opts.transport.send).toHaveBeenCalledOnce();
  });
});
