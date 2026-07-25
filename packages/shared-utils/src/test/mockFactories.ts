import { vi } from 'vitest';

export interface MockDaemonConfig {
  port: number;
  maxConcurrentRuns: number;
  runtimeIdleTimeoutMs: number;
  approvalTimeoutMs: number;
  defaultCwd: string;
  noProjectCwd: string;
  sessionEventLogDir: string;
  workflowStorePath: string;
  planDocumentStorePath: string;
  scopedContextStorePath: string;
  memoryStorePath: string;
  workflowSchedulerIntervalMs: number;
  secretToken: string | undefined;
  apiKeyLast4Exposure: 'none' | 'last4' | 'full' | undefined;
  healthPort: number;
  eventLogMaxSizeBytes: number;
  eventLogMaxArchives: number;
}

export function createMockProvider(overrides?: Partial<{
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  stream: boolean;
}>): { providerId: string; baseUrl: string; model: string; apiKey: string; stream: boolean } {
  return {
    providerId: 'test-provider',
    baseUrl: 'https://api.test.com/v1',
    model: 'test-model',
    apiKey: 'sk-test-123',
    stream: true,
    ...overrides,
  };
}

export function createMockDaemonConfig(overrides?: Partial<MockDaemonConfig>): MockDaemonConfig {
  return {
    port: 0,
    maxConcurrentRuns: 0,
    runtimeIdleTimeoutMs: 5000,
    approvalTimeoutMs: 5000,
    defaultCwd: '/tmp/test',
    noProjectCwd: '/tmp/test/no-project',
    sessionEventLogDir: '/tmp/test/events',
    workflowStorePath: '/tmp/test/workflows.json',
    planDocumentStorePath: '/tmp/test/plans.json',
    scopedContextStorePath: '/tmp/test/scoped-context.json',
    memoryStorePath: '/tmp/test/memories.jsonl',
    workflowSchedulerIntervalMs: 30000,
    secretToken: undefined,
    apiKeyLast4Exposure: 'last4',
    healthPort: 0,
    eventLogMaxSizeBytes: 104857600,
    eventLogMaxArchives: 10,
    ...overrides,
  };
}

export function createMockWebSocket(overrides?: Partial<{
  readyState: number;
  protocol: string;
  url: string;
}>): WebSocket {
  const mock = {
    readyState: WebSocket.OPEN,
    protocol: '',
    url: 'ws://localhost:0',
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    ...overrides,
  } as unknown as WebSocket;
  return mock;
}
