import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDaemonCapabilitySnapshot } from '../capabilities';
import type {
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
} from '../types';
import {
  DAEMON_INBOUND_MESSAGE_REGISTRY,
  DAEMON_INBOUND_MESSAGE_TYPES,
  DAEMON_OUTBOUND_MESSAGE_REGISTRY,
  DAEMON_OUTBOUND_MESSAGE_TYPES,
} from './registry';
import {
  DAEMON_PROTOCOL_CAPABILITIES,
  DAEMON_PROTOCOL_MESSAGE_GROUPS,
} from './schema-groups';
import {
  INBOUND_MESSAGE_TYPES,
  OUTBOUND_MESSAGE_TYPES,
  validateInboundMessage,
  validateOutboundMessage,
} from './protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(__dirname, '..');

describe('daemon protocol registry', () => {
  it('drives schema message type allowlists from one registry', () => {
    expect(INBOUND_MESSAGE_TYPES).toBe(DAEMON_INBOUND_MESSAGE_TYPES);
    expect(OUTBOUND_MESSAGE_TYPES).toBe(DAEMON_OUTBOUND_MESSAGE_TYPES);
    expect(Object.keys(DAEMON_INBOUND_MESSAGE_REGISTRY).sort()).toEqual(
      [...DAEMON_INBOUND_MESSAGE_TYPES].sort()
    );
    expect(Object.keys(DAEMON_OUTBOUND_MESSAGE_REGISTRY).sort()).toEqual(
      [...DAEMON_OUTBOUND_MESSAGE_TYPES].sort()
    );
  });

  it('keeps handler switch cases aligned with registered inbound messages', () => {
    const source = readFileSync(
      resolve(SOURCE_ROOT, 'server-handlers.ts'),
      'utf8'
    );
    const handledTypes = extractCases(
      source,
      'async handleInboundMessage',
      '    default:'
    );

    // hello is handled separately during the WebSocket handshake (server.ts),
    // not in the regular inbound message switch.
    const expectedHandled = new Set(DAEMON_INBOUND_MESSAGE_TYPES);
    expectedHandled.delete('hello' as never);
    expect(new Set(handledTypes)).toEqual(expectedHandled);
  });

  it('has inbound schema validators for every registered message type', () => {
    const source = readFileSync(resolve(__dirname, 'protocol-codec.ts'), 'utf8');
    const schemaCases = extractCases(
      source,
      'export function validateInboundMessage',
      'export function validateOutboundMessage'
    );

    expect(new Set(schemaCases)).toEqual(new Set(DAEMON_INBOUND_MESSAGE_TYPES));
  });

  it('has outbound schema validators for every registered message type', () => {
    const source = readFileSync(resolve(__dirname, 'protocol-codec.ts'), 'utf8');
    const schemaCases = extractCases(
      source,
      'export function validateOutboundMessage',
      'export function encodeOutboundMessage'
    );

    expect(new Set(schemaCases)).toEqual(
      new Set(DAEMON_OUTBOUND_MESSAGE_TYPES)
    );
  });

  it('keeps capability groups aligned with registry and schema validators', () => {
    const source = readFileSync(resolve(__dirname, 'protocol-codec.ts'), 'utf8');
    const inboundSchemaCases = extractCases(
      source,
      'export function validateInboundMessage',
      'export function validateOutboundMessage'
    );
    const outboundSchemaCases = extractCases(
      source,
      'export function validateOutboundMessage',
      'export function encodeOutboundMessage'
    );
    const inboundGroupMap = collectGroupMessageCapabilities('inbound');
    const outboundGroupMap = collectGroupMessageCapabilities('outbound');

    expect(Object.keys(DAEMON_PROTOCOL_MESSAGE_GROUPS).sort()).toEqual(
      [...DAEMON_PROTOCOL_CAPABILITIES].sort()
    );
    expect([...inboundGroupMap.keys()].sort()).toEqual(
      [...DAEMON_INBOUND_MESSAGE_TYPES].sort()
    );
    expect([...outboundGroupMap.keys()].sort()).toEqual(
      [...DAEMON_OUTBOUND_MESSAGE_TYPES].sort()
    );
    expect([...inboundGroupMap.keys()].sort()).toEqual(
      inboundSchemaCases.sort()
    );
    expect([...outboundGroupMap.keys()].sort()).toEqual(
      outboundSchemaCases.sort()
    );

    for (const [type, registration] of Object.entries(
      DAEMON_INBOUND_MESSAGE_REGISTRY
    )) {
      expect(inboundGroupMap.get(type)).toBe(registration.capability);
    }
    for (const [type, registration] of Object.entries(
      DAEMON_OUTBOUND_MESSAGE_REGISTRY
    )) {
      expect(outboundGroupMap.get(type)).toBe(registration.capability);
    }
  });

  it('accepts minimal valid inbound messages for every registered message type', () => {
    for (const message of inboundMessageSamples()) {
      const result = validateInboundMessage(message);
      expect(
        result,
        JSON.stringify({ type: message.type, result })
      ).toMatchObject({ ok: true });
    }
  });

  it('accepts minimal valid outbound messages for every registered message type', () => {
    for (const message of outboundMessageSamples()) {
      const result = validateOutboundMessage(message);
      expect(
        result,
        JSON.stringify({ type: message.type, result })
      ).toMatchObject({ ok: true });
    }
  });

  it('distinguishes unknown type from invalid shape', () => {
    const unknown = validateInboundMessage({ type: 'not-a-command' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('UNKNOWN_MESSAGE_TYPE');
    }

    const invalid = validateInboundMessage({ type: 'run-task' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('INVALID_MESSAGE');
    }
  });

  it('validates long-run run-task fields', () => {
    const valid = validateInboundMessage({
      type: 'run-task',
      runId: 'run_long',
      prompt: 'Run for a while',
      workspaceMode: 'project',
      cwd: 'C:/work/crish',
      visibleGoal: 'Finish the long run',
      budgetDifficulty: 'hard',
      runTokenBudget: 120000,
      maxRounds: 8,
      maxStalledRounds: 3,
      backgroundDrainTimeoutMs: 0,
    });
    expect(valid).toMatchObject({
      ok: true,
      value: {
        workspaceMode: 'project',
        cwd: 'C:/work/crish',
        visibleGoal: 'Finish the long run',
        budgetDifficulty: 'hard',
        runTokenBudget: 120000,
        maxRounds: 8,
        maxStalledRounds: 3,
        backgroundDrainTimeoutMs: 0,
      },
    });

    const invalid = validateInboundMessage({
      type: 'run-task',
      runId: 'run_long',
      prompt: 'Run for a while',
      visibleGoal: '',
      runTokenBudget: 0,
      maxStalledRounds: 0,
      backgroundDrainTimeoutMs: -1,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining([
          '$.visibleGoal',
          '$.runTokenBudget',
          '$.maxStalledRounds',
          '$.backgroundDrainTimeoutMs',
        ])
      );
    }
  });

  it('marks subagent control as implemented collaborative capability', () => {
    expect(DAEMON_INBOUND_MESSAGE_REGISTRY['send-to-subagent'].state).toBe(
      'implemented'
    );
    expect(DAEMON_INBOUND_MESSAGE_REGISTRY['get-subagent-status'].state).toBe(
      'implemented'
    );
    expect(
      DAEMON_OUTBOUND_MESSAGE_REGISTRY['subagent-message-sent'].state
    ).toBe('implemented');
    expect(DAEMON_OUTBOUND_MESSAGE_REGISTRY['subagent-status'].state).toBe(
      'implemented'
    );
  });

  it('covers every daemon capability related message type with registry metadata', () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatusSnapshot() as DaemonProviderStatusSnapshot,
      mcpStatus: mcpStatusSnapshot() as DaemonMcpStatusSnapshot,
      now: new Date(timestamp()),
    });
    const registry = new Map([
      ...Object.entries(DAEMON_INBOUND_MESSAGE_REGISTRY),
      ...Object.entries(DAEMON_OUTBOUND_MESSAGE_REGISTRY),
    ]);

    for (const capability of snapshot.capabilities) {
      for (const type of capability.relatedMessageTypes) {
        const registration = registry.get(type);
        expect(
          registration,
          `${capability.id} references ${type}`
        ).toBeDefined();

        if (
          capability.state === 'implemented' ||
          capability.state === 'experimental'
        ) {
          expect(
            registration?.state,
            `${capability.id} references ${type}`
          ).not.toBe('unsupported');
          expect(
            registration?.state,
            `${capability.id} references ${type}`
          ).not.toBe('backend-not-wired');
        }
      }
    }
  });
});

function extractCases(
  source: string,
  startMarker: string,
  endMarker: string
): string[] {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Unable to find source region: ${startMarker}`);
  }

  // Accept both case "x": and case 'x': (server-handlers uses single quotes).
  return [
    ...source.slice(start, end).matchAll(/case\s+['"]([^'"]+)['"]\s*:/g),
  ].map((match) => match[1]).filter((m): m is string => m !== undefined);
}

function collectGroupMessageCapabilities(
  direction: 'inbound' | 'outbound'
): Map<string, string> {
  const messageCapabilities = new Map<string, string>();
  for (const capability of DAEMON_PROTOCOL_CAPABILITIES) {
    for (const type of DAEMON_PROTOCOL_MESSAGE_GROUPS[capability][direction]) {
      const existing = messageCapabilities.get(type);
      if (existing) {
        throw new Error(
          `Message type ${type} is grouped by both ${existing} and ${capability}`
        );
      }
      messageCapabilities.set(type, capability);
    }
  }
  return messageCapabilities;
}

function inboundMessageSamples(): Array<{
  type: string;
  [key: string]: unknown;
}> {
  const entries = sessionEntries();
  return [
    { type: 'run-task', runId: 'run_1', prompt: 'Run task' },
    { type: 'approve-tool', toolCallId: 'tool_1', scope: 'project' },
    { type: 'deny-tool', toolCallId: 'tool_1' },
    { type: 'cancel-run', runId: 'run_1' },
    { type: 'stream-pause', runId: 'run_1' },
    { type: 'stream-resume', runId: 'run_1' },
    { type: 'ping' },
    { type: 'get-status' },
    { type: 'list-capabilities' },
    {
      type: 'update-config',
      model: 'model_a',
      credentialMode: 'auto',
      endpoint: 'responses',
      stream: true,
    },
    { type: 'list-sessions' },
    { type: 'list-runs', sessionId: 'session_1' },
    { type: 'read-session-events', sessionId: 'session_1', afterSequence: 0 },
    {
      type: 'read-run-events',
      runId: 'run_1',
      afterSequence: 0,
      includeSnapshot: true,
    },
    { type: 'get-run-snapshot', runId: 'run_1' },
    {
      type: 'enqueue-pending-input',
      sessionId: 'session_1',
      runId: 'run_1',
      text: 'Continue after the current run',
      mode: 'after-current-run',
    },
    {
      type: 'cancel-pending-input',
      inputId: 'pending_1',
      sessionId: 'session_1',
      reason: 'user-cancelled',
    },
    {
      type: 'dispatch-pending-input',
      inputId: 'pending_1',
      sessionId: 'session_1',
      targetRunId: 'run_2',
    },
    { type: 'list-pending-inputs', sessionId: 'session_1' },
    { type: 'list-workflows' },
    {
      type: 'create-workflow',
      name: 'workflow',
      prompt: 'Run workflow',
      schedule: { type: 'manual' },
    },
    { type: 'update-workflow', workflowId: 'workflow_1', enabled: false },
    { type: 'delete-workflow', workflowId: 'workflow_1' },
    { type: 'trigger-workflow', workflowId: 'workflow_1' },
    { type: 'list-workflow-runs', workflowId: 'workflow_1' },
    { type: 'list-plan-documents' },
    {
      type: 'create-plan-document',
      title: 'Plan One',
      goal: 'Wire editable plan documents.',
    },
    {
      type: 'create-requirements-alignment-plan',
      goal: 'Clarify the product backend scope.',
      questions: ['Which workflows must ship first?'],
      assumptions: ['The daemon remains the product state source.'],
      acceptance: ['Open questions are captured before execution.'],
      risks: ['Unclear scope can create throwaway work.'],
      source: 'slash-command',
    },
    { type: 'get-plan-document', documentId: 'plan_1' },
    {
      type: 'patch-plan-document',
      documentId: 'plan_1',
      patch: {
        expectedVersion: 1,
        operations: [{ op: 'set-status', status: 'ready' }],
      },
    },
    { type: 'delete-plan-document', documentId: 'plan_1' },
    { type: 'list-mutation-leases', cwd: 'C:/workspace/crish' },
    { type: 'list-artifacts', sessionId: 'session_1' },
    {
      type: 'get-artifact-content',
      artifactUri: 'artifact://run_1/output.txt',
    },
    { type: 'list-memories', scope: 'project' },
    { type: 'delete-memory', memoryId: 'memory_1' },
    { type: 'list-checkpoints', runId: 'run_1', sessionId: 'session_1' },
    { type: 'restore-checkpoint', checkpointId: 'checkpoint_1' },
    { type: 'get-checkpoint-diff', checkpointId: 'checkpoint_1' },
    { type: 'git-status', cwd: 'C:/workspace/crish' },
    {
      type: 'git-diff',
      cwd: 'C:/workspace/crish',
      path: 'packages/agent-daemon/src/types.ts',
    },
    {
      type: 'resolve-conversation-rewind-boundary',
      sessionId: 'session_1',
      userMessageId: 'user_1',
      mode: 'keep-user-message',
    },
    {
      type: 'preview-conversation-rewind',
      sessionId: 'session_1',
      targetLeafId: 'leaf_1',
      entries,
    },
    {
      type: 'preview-conversation-rewind-by-boundary',
      sessionId: 'session_1',
      latestUserMessage: true,
      mode: 'remove-user-message',
      restorePolicy: 'required',
    },
    {
      type: 'apply-conversation-rewind',
      sessionId: 'session_1',
      targetLeafId: null,
      entries,
    },
    { type: 'apply-session-action', action: sessionAction('open') },
    {
      type: 'send-to-subagent',
      subagentRunId: 'subrun_1',
      message: 'Continue',
    },
    { type: 'get-subagent-status', subagentRunId: 'subrun_1' },
    { type: 'start-mcp-server', serverId: 'mcp_1' },
    { type: 'stop-mcp-server', serverId: 'mcp_1' },
    { type: 'list-mcp-servers' },
    { type: 'get-scoped-context', scope: 'project', kind: 'rule' },
    { type: 'upsert-scoped-context', record: scopedContextRecord() },
    { type: 'delete-scoped-context', recordId: 'rule_1' },
    {
      type: 'resolve-scoped-context',
      cwd: 'C:/workspace/crish',
      projectRoot: 'C:/workspace/crish',
      projectTags: ['typescript'],
      userEnabledIds: ['skill_1'],
    },
  ];
}

function outboundMessageSamples(): Array<{
  type: string;
  [key: string]: unknown;
}> {
  return [
    {
      type: 'daemon-ready',
      port: 12345,
      protocolVersion: 1,
      buildHash: 'abc123',
    },
    { type: 'event', runId: 'run_1', event: { type: 'agent-start' } },
    {
      type: 'approval-requested',
      runId: 'run_1',
      toolCallId: 'tool_1',
      toolName: 'write_file',
      input: { path: 'a.txt' },
      summary: 'write a.txt',
      timeoutMs: null,
      expiresAt: null,
      remainingMs: null,
    },
    { type: 'approval-resolved', toolCallId: 'tool_1', decision: 'approved' },
    { type: 'error', code: 'UNSUPPORTED_CAPABILITY', message: 'Unsupported' },
    { type: 'pong' },
    {
      type: 'status-response',
      lifecycle: lifecycleSnapshot(),
      activeRuns: [],
      pendingApprovals: [],
      recentApprovals: [],
      providerStatus: providerStatusSnapshot(),
      mcpStatus: mcpStatusSnapshot(),
      capabilities: capabilitySnapshot(),
    },
    { type: 'capabilities-response', snapshot: capabilitySnapshot() },
    { type: 'config-updated', updatedFields: ['model'] },
    {
      type: 'subagent-started',
      runId: 'run_1',
      subagentId: 'sub_1',
      subagentRunId: 'subrun_1',
      parentToolCallId: 'tool_1',
      description: 'Subagent',
      mode: 'task',
    },
    {
      type: 'subagent-ended',
      runId: 'run_1',
      subagentId: 'sub_1',
      subagentRunId: 'subrun_1',
      parentToolCallId: 'tool_1',
      status: 'completed',
      summary: 'done',
    },
    {
      type: 'subagent-event',
      runId: 'run_1',
      subagentId: 'sub_1',
      subagentRunId: 'subrun_1',
      parentToolCallId: 'tool_1',
      event: { type: 'agent-start' },
    },
    {
      type: 'sessions-listed',
      sessions: [sessionRecord()],
      eventLog: eventLogMetadata(),
      diagnostics: {
        queryMs: 1,
        sessionCount: 1,
        summaryCount: 0,
        metadataCount: 0,
        filteredOutCount: 0,
        summarySource: 'event-store',
      },
    },
    { type: 'runs-listed', runs: [runRecord()], sessionId: 'session_1' },
    {
      type: 'session-events',
      sessionId: 'session_1',
      events: [orchestratorEvent('session-created')],
      eventLog: eventLogMetadata(),
      nextAfterSequence: 2,
      afterSequence: 0,
    },
    {
      type: 'run-events',
      runId: 'run_1',
      events: [orchestratorEvent('run-started')],
      eventLog: eventLogMetadata(),
      nextAfterSequence: 2,
      afterSequence: 0,
      snapshot: taskSnapshot(),
    },
    { type: 'run-snapshot', runId: 'run_1', snapshot: taskSnapshot() },
    {
      type: 'pending-input-queued',
      input: pendingInputRecord(),
      event: orchestratorEvent('pending-input-created'),
    },
    {
      type: 'pending-input-cancelled',
      input: { ...pendingInputRecord(), status: 'cancelled' },
      event: orchestratorEvent('pending-input-cancelled'),
    },
    {
      type: 'pending-input-dispatched',
      input: { ...pendingInputRecord(), status: 'dispatched' },
      event: orchestratorEvent('pending-input-dispatched'),
    },
    {
      type: 'pending-inputs-listed',
      inputs: [pendingInputRecord()],
      sessionId: 'session_1',
    },
    { type: 'workflows-listed', workflows: [workflowDefinition()] },
    { type: 'workflow-created', workflow: workflowDefinition() },
    { type: 'workflow-updated', workflow: workflowDefinition() },
    { type: 'workflow-deleted', workflowId: 'workflow_1' },
    {
      type: 'workflow-triggered',
      accepted: true,
      runId: 'run_1',
      workflowRunId: 'run_1',
      run: workflowRun(),
    },
    {
      type: 'workflow-run-updated',
      runId: 'run_1',
      workflowRunId: 'run_1',
      workflowId: 'workflow_1',
      run: workflowRun(),
    },
    {
      type: 'workflow-runs-listed',
      workflowId: 'workflow_1',
      runs: [workflowRun()],
    },
    { type: 'plan-documents-listed', documents: [planDocumentSummary()] },
    { type: 'plan-document-created', document: planDocument() },
    { type: 'plan-document', document: planDocument() },
    {
      type: 'plan-document-patched',
      document: {
        ...planDocument(),
        version: 2,
        updatedAt: '2026-06-08T00:00:01.000Z',
      },
    },
    { type: 'plan-document-deleted', documentId: 'plan_1' },
    {
      type: 'mutation-leases-listed',
      leases: [
        {
          token: 'lease_1',
          scope: { type: 'workspace' },
          createdAt: timestamp(),
          expiresAt: timestamp(),
          ttlMs: 1_000,
        },
      ],
    },
    { type: 'artifacts-listed', artifacts: [artifactRecord()] },
    {
      type: 'artifact-content',
      artifactUri: 'artifact://run_1/output.txt',
      content: 'output',
      mimeType: 'text/plain',
    },
    { type: 'memories-listed', memories: [memoryRecord()] },
    { type: 'memory-deleted', memoryId: 'memory_1' },
    { type: 'checkpoints-listed', checkpoints: [checkpointRecord()] },
    {
      type: 'checkpoint-diff',
      checkpointId: 'checkpoint_1',
      files: [
        { path: 'a.txt', status: 'modified', addedLines: 1, removedLines: 0 },
      ],
    },
    {
      type: 'checkpoint-restored',
      checkpointId: 'checkpoint_1',
      runId: 'run_1',
    },
    {
      type: 'git-status-response',
      cwd: 'C:/workspace/crish',
      found: true,
      repositoryRoot: 'C:/workspace/crish',
      gitDir: 'C:/workspace/crish/.git',
      head: 'abc123',
      branch: 'main',
      clean: false,
      files: [
        {
          path: 'packages/agent-daemon/src/types.ts',
          status: 'M',
          index: ' ',
          worktree: 'M',
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: false,
        },
      ],
      stagedCount: 0,
      unstagedCount: 1,
      untrackedCount: 0,
      conflictedCount: 0,
    },
    {
      type: 'git-diff-response',
      cwd: 'C:/workspace/crish',
      repositoryRoot: 'C:/workspace/crish',
      path: 'packages/agent-daemon/src/types.ts',
      staged: false,
      unified:
        'diff --git a/packages/agent-daemon/src/types.ts b/packages/agent-daemon/src/types.ts\n',
      stat: ' packages/agent-daemon/src/types.ts | 1 +\n',
      files: [{ path: 'packages/agent-daemon/src/types.ts', status: 'M' }],
    },
    { type: 'conversation-rewind-boundary', ...rewindBoundaryResponse() },
    {
      type: 'conversation-rewind-preview',
      sessionId: 'session_1',
      plan: rewindPlan(),
    },
    {
      type: 'conversation-rewind-applied',
      sessionId: 'session_1',
      plan: rewindPlan(),
      stepResults: [{ type: 'move-session-leaf', status: 'deferred' }],
    },
    {
      type: 'session-action-receipt',
      protocolVersion: 1,
      actionId: 'session_action_1',
      kind: 'open',
      sessionId: 'session_1',
      status: 'committed',
      committedAt: timestamp(),
      resultingSessionId: 'session_1',
    },
    {
      type: 'subagent-message-sent',
      subagentRunId: 'subrun_1',
      accepted: false,
    },
    {
      type: 'subagent-status',
      subagentRunId: 'subrun_1',
      status: 'unsupported',
    },
    { type: 'mcp-servers-listed', servers: [mcpServerRecord()] },
    { type: 'mcp-server-started', serverId: 'mcp_1', state: 'starting' },
    { type: 'mcp-server-stopped', serverId: 'mcp_1', state: 'stopped' },
    {
      type: 'scoped-context-response',
      status: 'ok',
      records: [scopedContextRecord()],
    },
    {
      type: 'scoped-context-upserted',
      status: 'ok',
      record: scopedContextRecord(),
      persisted: true,
    },
    {
      type: 'scoped-context-deleted',
      status: 'ok',
      recordId: 'rule_1',
      deleted: true,
    },
    {
      type: 'scoped-context-resolved',
      status: 'ok',
      stableContext: [
        {
          id: 'scoped-context:rules',
          kind: 'custom-stable',
          label: 'Scoped Rules',
          content: { version: 1, rules: [] },
        },
      ],
      recommended: [scopedContextCandidate()],
      items: [{ ...scopedContextCandidate(), status: 'recommended' }],
      diagnostics: [
        {
          severity: 'info',
          id: 'disabled_rule',
          code: 'disabled',
          message: 'Scoped context item is disabled.',
        },
      ],
      storeRecordCount: 1,
      resourceRecordCount: 1,
      resourceDiagnostics: [],
      stableContextHash: 'hash_1',
    },
  ];
}

function timestamp(): string {
  return '2026-06-08T00:00:00.000Z';
}

function sessionAction(kind: 'open' | 'rename' | 'rewind' = 'open') {
  const base = {
    protocolVersion: 1,
    actionId: 'session_action_1',
    kind,
    sessionId: 'session_1',
    requestedAt: timestamp(),
    requestedBy: 'workbench',
  };

  if (kind === 'rename') {
    return { ...base, title: 'Renamed session' };
  }
  if (kind === 'rewind') {
    return { ...base, targetEventId: 'event_1', restoreWorkspace: false };
  }
  return { ...base, target: 'split-view', paneId: 'pane_1' };
}

function eventLogMetadata() {
  return {
    eventLogId: 'event_log_1',
    generation: 1,
    schemaVersion: 1,
    protocolVersion: 1,
  };
}

function capabilitySnapshot() {
  return {
    schemaVersion: 1,
    generatedAt: timestamp(),
    capabilities: [
      {
        id: 'daemon.status',
        title: 'Daemon status',
        state: 'implemented',
        reason: 'Status snapshots are available.',
        owner: 'agent-daemon',
        relatedMessageTypes: ['get-status', 'status-response'],
        relatedTauriCommands: [],
        updatedAt: timestamp(),
        diagnostics: [],
      },
      {
        id: 'artifacts',
        title: 'Artifacts',
        state: 'unsupported',
        reason: 'No artifact adapter is wired.',
        owner: 'agent-runtime',
        relatedMessageTypes: ['list-artifacts', 'artifacts-listed'],
        relatedTauriCommands: [],
        updatedAt: timestamp(),
        diagnostics: [
          {
            code: 'ARTIFACTS_UNSUPPORTED',
            message: 'No artifact adapter is wired.',
            severity: 'info',
            updatedAt: timestamp(),
          },
        ],
      },
    ],
  };
}

function sessionEntries() {
  return [
    {
      type: 'node',
      id: 'root',
      parentId: null,
      createdAt: timestamp(),
      payload: { text: 'root' },
    },
    {
      type: 'node',
      id: 'leaf_1',
      parentId: 'root',
      createdAt: timestamp(),
      payload: { text: 'leaf' },
    },
  ];
}

function lifecycleSnapshot() {
  return {
    state: 'ready',
    startedAt: timestamp(),
    updatedAt: timestamp(),
    readyAt: timestamp(),
    uptimeMs: 1_000,
    currentPort: 12345,
    connectedClientCount: 1,
    totalClientConnectionCount: 1,
    totalClientDisconnectCount: 0,
    activeRunCount: 0,
    eventStore: { status: 'ok', path: 'C:/workspace/crish/events.jsonl' },
    providerReadiness: 'ready',
    mcpReadiness: 'ready',
  };
}

function providerStatusSnapshot() {
  return {
    credentialMode: 'auto',
    readiness: 'ready',
    providerId: 'provider_a',
    routeId: 'route_a',
    baseUrl: 'https://gateway.example/v1',
    model: 'model_a',
    upstreamModel: 'model_a',
    endpoint: 'auto',
    stream: true,
    systemPromptWireMode: 'user-prefix',
    apiKey: { hasApiKey: false, source: 'unset' },
    hasDirectApiKey: false,
    apiKeySource: 'unset',
    gateway: {
      ready: true,
      credentialConfigured: true,
      routeDecision: ['route_a'],
      selectedEndpointSupport: 'auto',
      selectedStreamingSupport: 'streaming',
    },
    updatedAt: timestamp(),
  };
}

function mcpStatusSnapshot() {
  return {
    configured: true,
    readiness: 'ready',
    serverCount: 1,
    summary: {},
    diagnostics: [],
    servers: [mcpServerRecord()],
    updatedAt: timestamp(),
  };
}

function sessionRecord() {
  return {
    id: 'session_1',
    cwd: 'C:/workspace/crish',
    createdAt: timestamp(),
    updatedAt: timestamp(),
    status: 'open',
    currentLeafId: 'leaf_1',
    metadata: {},
  };
}

function runRecord() {
  return {
    id: 'run_1',
    sessionId: 'session_1',
    cwd: 'C:/workspace/crish',
    status: 'completed',
    createdAt: timestamp(),
    updatedAt: timestamp(),
    startedAt: timestamp(),
    finishedAt: timestamp(),
    kind: 'task',
    metadata: {},
  };
}

function pendingInputRecord() {
  return {
    id: 'pending_1',
    sessionId: 'session_1',
    runId: 'run_1',
    text: 'Continue after the current run',
    mode: 'after-current-run',
    status: 'pending',
    createdAt: timestamp(),
    updatedAt: timestamp(),
    source: 'workbench',
  };
}

function orchestratorEvent(type: string) {
  return {
    protocolVersion: 1,
    id: `event_${type}`,
    sequence: 1,
    type,
    sessionId: 'session_1',
    runId: 'run_1',
    timestamp: timestamp(),
    payload: {},
  };
}

function taskSnapshot() {
  return {
    runId: 'run_1',
    sessionId: 'session_1',
    status: 'completed',
    title: 'Run task',
    messages: [
      {
        id: 'message_1',
        role: 'assistant',
        content: 'done',
        createdAt: timestamp(),
      },
    ],
    pendingToolCalls: [],
    backgroundTasks: [],
    progress: {
      label: 'Completed',
      eventCount: 1,
      turnCount: 1,
      textDeltaCount: 0,
      toolCallCount: 0,
      completedToolCallCount: 0,
      pendingToolCallCount: 0,
      approvalPending: false,
      updatedAt: timestamp(),
    },
    usage: {
      sampleCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
    },
    cache: {
      sampleCount: 0,
      promptTokens: 0,
      readTokens: 0,
      writeTokens: 0,
      missTokens: 0,
      hitRatio: 0,
      writeRatio: 0,
    },
    updatedAt: timestamp(),
    progressLabel: 'Completed',
    currentRun: {
      id: 'run_1',
      sessionId: 'session_1',
      cwd: 'C:/workspace/crish',
      createdAt: timestamp(),
      updatedAt: timestamp(),
      metadata: {},
    },
  };
}

function workflowDefinition() {
  return {
    id: 'workflow_1',
    name: 'Workflow',
    prompt: 'Run workflow',
    cwd: 'C:/workspace/crish',
    mode: 'task',
    schedule: { type: 'manual' },
    enabled: true,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    metadata: {},
  };
}

function workflowRun() {
  return {
    workflowId: 'workflow_1',
    runId: 'run_1',
    sessionId: 'session_1',
    scheduledFor: timestamp(),
    startedAt: timestamp(),
    status: 'completed',
  };
}

function planDocument() {
  return {
    id: 'plan_1',
    title: 'Plan One',
    goal: 'Wire editable plan documents.',
    assumptions: [],
    questions: [],
    steps: [
      {
        id: 'step_1',
        title: 'Build store',
        status: 'completed',
        dependencies: [],
        evidenceIds: [],
        toolHints: [],
      },
    ],
    acceptance: [],
    risks: [],
    status: 'ready',
    version: 1,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    metadata: {},
  };
}

function planDocumentSummary() {
  return {
    id: 'plan_1',
    title: 'Plan One',
    goal: 'Wire editable plan documents.',
    status: 'ready',
    version: 1,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    steps: {
      total: 1,
      byStatus: {
        pending: 0,
        in_progress: 0,
        completed: 1,
        blocked: 0,
        skipped: 0,
      },
      next: [],
      blocked: [],
    },
    questions: {
      total: 0,
      byStatus: { open: 0, answered: 0, resolved: 0, deferred: 0 },
      open: [],
    },
    assumptions: {
      total: 0,
      byStatus: { proposed: 0, confirmed: 0, rejected: 0, deferred: 0 },
      unresolved: [],
    },
    acceptance: {
      total: 0,
      byStatus: { pending: 0, met: 0, failed: 0, waived: 0 },
    },
    risks: {
      total: 0,
      bySeverity: { low: 0, medium: 0, high: 0 },
      byStatus: { open: 0, mitigated: 0, accepted: 0 },
      open: [],
    },
  };
}

function artifactRecord() {
  return {
    uri: 'artifact://run_1/output.txt',
    type: 'text',
    name: 'output.txt',
    size: 6,
    createdAt: timestamp(),
    sessionId: 'session_1',
    runId: 'run_1',
  };
}

function memoryRecord() {
  return {
    id: 'memory_1',
    key: 'project',
    value: 'remembered',
    scope: 'project',
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

function checkpointRecord() {
  return {
    id: 'checkpoint_1',
    runId: 'run_1',
    sessionId: 'session_1',
    label: 'before edit',
    createdAt: timestamp(),
    messageCount: 1,
  };
}

function rewindBoundaryResponse() {
  return {
    status: 'ok',
    sessionId: 'session_1',
    userMessageId: 'user_1',
    latestUserMessage: false,
    mode: 'keep-user-message',
    boundary: rewindBoundaryRecord(),
    checkpoint: rewindCheckpointRecord(),
    target: rewindTargetFacts(),
    missingFacts: [],
    diagnostics: [],
    plan: rewindPlan(),
    runtimeTargetLeafId: 'runtime_leaf_1',
  };
}

function rewindBoundaryRecord() {
  return {
    sessionId: 'session_1',
    runId: 'run_1',
    userMessageId: 'user_1',
    sessionTreeLeafIdBefore: 'root',
    sessionTreeLeafIdAfter: 'leaf_1',
    runtimeLeafIdBefore: 'runtime_root',
    runtimeLeafIdAfter: 'runtime_leaf_1',
    eventSequence: 1,
    workspaceRoot: 'C:/workspace/crish',
    checkpointId: 'checkpoint_1',
    checkpointRef: 'checkpoint://runtime/1',
    checkpointSource: 'runtime',
    changedPaths: ['a.txt'],
    createdAt: timestamp(),
    metadata: { reason: 'test' },
  };
}

function rewindCheckpointRecord() {
  return {
    sessionId: 'session_1',
    runId: 'run_1',
    userMessageId: 'user_1',
    toolCall: { id: 'tool_1', toolName: 'create_workspace_checkpoint' },
    checkpointId: 'checkpoint_1',
    checkpointRef: 'checkpoint://runtime/1',
    workspaceRoot: 'C:/workspace/crish',
    changedPaths: ['a.txt'],
    source: 'runtime',
    createdAt: timestamp(),
    metadata: { reason: 'test' },
  };
}

function rewindTargetFacts() {
  return {
    sessionId: 'session_1',
    runId: 'run_1',
    userMessageId: 'user_1',
    mode: 'keep-user-message',
    eventSequence: 1,
    workspaceRoot: 'C:/workspace/crish',
    changedPaths: ['a.txt'],
    createdAt: timestamp(),
    sessionTreeTargetLeafId: 'leaf_1',
    runtimeTargetLeafId: 'runtime_leaf_1',
    checkpoint: {
      checkpointId: 'checkpoint_1',
      checkpointRef: 'checkpoint://runtime/1',
      checkpointSource: 'runtime',
      workspaceRoot: 'C:/workspace/crish',
      changedPaths: ['a.txt'],
      createdAt: timestamp(),
    },
    missingFacts: [],
    metadata: { reason: 'test' },
  };
}

function mcpServerRecord() {
  return {
    id: 'mcp_1',
    name: 'MCP One',
    state: 'ready',
    transport: 'stdio',
    cachedToolCount: 2,
    startedAt: timestamp(),
  };
}

function scopedContextRecord() {
  return {
    id: 'rule_1',
    kind: 'rule',
    title: 'Rule One',
    content: 'Use daemon scoped context APIs.',
    scope: 'project',
    activation: 'enabled',
    appliesTo: ['tag:typescript'],
    tags: ['daemon'],
    source: {
      type: 'user',
      label: 'Workbench',
    },
    sourceMetadata: {
      owner: 'workbench',
    },
    order: 1,
    updatedAt: timestamp(),
  };
}

function scopedContextCandidate() {
  return {
    id: 'skill_1',
    kind: 'skill',
    title: 'Skill One',
    description: 'Recommended skill',
    scope: 'global',
    activation: 'recommended',
    appliesTo: [],
    tags: ['daemon'],
    source: {
      type: 'skill-file',
      path: 'C:/workspace/user/.codex/skills/skill-one/SKILL.md',
      label: 'skill-one',
    },
    reason: 'recommended-for-project',
  };
}

function rewindPlan() {
  const targetPath = sessionEntries();
  const currentPath = [
    targetPath[0],
    {
      type: 'node',
      id: 'leaf_2',
      parentId: 'root',
      createdAt: timestamp(),
      payload: { text: 'current' },
    },
  ];

  return {
    sessionId: 'session_1',
    fromLeafId: 'leaf_2',
    targetLeafId: 'leaf_1',
    targetPath,
    entryProjection: {
      currentPath,
      targetPath,
      commonAncestorId: 'root',
      retainedEntryIds: ['root', 'leaf_1'],
      hiddenEntryIds: ['leaf_2'],
      hiddenCurrentPathEntryIds: ['leaf_2'],
      hiddenBranchEntryIds: [],
    },
    runCancellations: [],
    approvalClearances: [],
    workspaceRestore: {
      required: false,
      source: 'none',
      cleanUntracked: false,
    },
    steps: [
      {
        type: 'move-session-leaf',
        sessionId: 'session_1',
        fromLeafId: 'leaf_2',
        toLeafId: 'leaf_1',
      },
    ],
  };
}
