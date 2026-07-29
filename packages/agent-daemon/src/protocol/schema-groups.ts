import type { DaemonInboundMessage, DaemonOutboundMessage } from '../types.js';

export const DAEMON_PROTOCOL_CAPABILITIES = [
  'approval',
  'artifacts',
  'background-task',
  'checkpoint',
  'config',
  'daemon',
  'event-stream',
  'git',
  'mcp',
  'memory',
  'mutation',
  'plan-document',
  'rewind',
  'run',
  'scoped-context',
  'session',
  'subagent',
  'workflow',
] as const;

export type DaemonProtocolCapability =
  (typeof DAEMON_PROTOCOL_CAPABILITIES)[number];

interface DaemonProtocolMessageGroup {
  inbound: readonly DaemonInboundMessage['type'][];
  outbound: readonly DaemonOutboundMessage['type'][];
}

export const DAEMON_PROTOCOL_MESSAGE_GROUPS = {
  approval: {
    inbound: ['approve-tool', 'deny-tool'],
    outbound: ['approval-requested', 'approval-resolved'],
  },
  artifacts: {
    inbound: ['list-artifacts', 'get-artifact-content'],
    outbound: ['artifacts-listed', 'artifact-content'],
  },
  'background-task': {
    inbound: [
      'list-background-tasks',
      'start-background-task',
      'cancel-background-task',
      'get-background-task-history',
    ],
    outbound: [
      'background-tasks-listed',
      'background-task-started',
      'background-task-cancelled',
      'background-task-history',
    ],
  },
  checkpoint: {
    inbound: ['list-checkpoints', 'restore-checkpoint', 'get-checkpoint-diff'],
    outbound: ['checkpoints-listed', 'checkpoint-diff', 'checkpoint-restored'],
  },
  config: {
    inbound: ['update-config', 'probe-provider-models', 'probe-provider-chat'],
    outbound: [
      'config-updated',
      'provider-models-probed',
      'provider-chat-probed',
    ],
  },
  daemon: {
    inbound: ['hello', 'ping', 'get-status', 'list-capabilities'],
    outbound: [
      'welcome',
      'daemon-ready',
      'error',
      'pong',
      'status-response',
      'capabilities-response',
    ],
  },
  'event-stream': {
    inbound: ['read-session-events', 'read-run-events'],
    outbound: ['event', 'session-events', 'run-events'],
  },
  git: {
    inbound: ['git-status', 'git-diff'],
    outbound: ['git-status-response', 'git-diff-response'],
  },
  mcp: {
    inbound: ['start-mcp-server', 'stop-mcp-server', 'list-mcp-servers'],
    outbound: [
      'mcp-servers-listed',
      'mcp-server-started',
      'mcp-server-stopped',
    ],
  },
  memory: {
    inbound: ['list-memories', 'delete-memory'],
    outbound: ['memories-listed', 'memory-deleted'],
  },
  mutation: {
    inbound: ['list-mutation-leases'],
    outbound: ['mutation-leases-listed'],
  },
  'plan-document': {
    inbound: [
      'list-plan-documents',
      'create-plan-document',
      'create-requirements-alignment-plan',
      'get-plan-document',
      'patch-plan-document',
      'delete-plan-document',
    ],
    outbound: [
      'plan-documents-listed',
      'plan-document-created',
      'plan-document',
      'plan-document-patched',
      'plan-document-deleted',
    ],
  },
  rewind: {
    inbound: [
      'resolve-conversation-rewind-boundary',
      'preview-conversation-rewind',
      'preview-conversation-rewind-by-boundary',
      'apply-conversation-rewind',
    ],
    outbound: [
      'conversation-rewind-boundary',
      'conversation-rewind-preview',
      'conversation-rewind-applied',
    ],
  },
  run: {
    inbound: [
      'run-task',
      'cancel-run',
      'run-control',
      'stream-pause',
      'stream-resume',
      'list-runs',
      'get-run-snapshot',
      'enqueue-pending-input',
      'cancel-pending-input',
      'dispatch-pending-input',
      'list-pending-inputs',
    ],
    outbound: [
      'runs-listed',
      'run-snapshot',
      'pending-input-queued',
      'pending-input-cancelled',
      'pending-input-dispatched',
      'pending-inputs-listed',
    ],
  },
  'scoped-context': {
    inbound: [
      'get-scoped-context',
      'upsert-scoped-context',
      'delete-scoped-context',
      'resolve-scoped-context',
    ],
    outbound: [
      'scoped-context-response',
      'scoped-context-upserted',
      'scoped-context-deleted',
      'scoped-context-resolved',
    ],
  },
  session: {
    inbound: ['list-sessions', 'apply-session-action'],
    outbound: ['sessions-listed', 'session-action-receipt'],
  },
  subagent: {
    inbound: ['send-to-subagent', 'get-subagent-status'],
    outbound: [
      'subagent-started',
      'subagent-ended',
      'subagent-event',
      'subagent-message-sent',
      'subagent-status',
    ],
  },
  workflow: {
    inbound: [
      'list-workflows',
      'create-workflow',
      'update-workflow',
      'delete-workflow',
      'trigger-workflow',
      'list-workflow-runs',
    ],
    outbound: [
      'workflows-listed',
      'workflow-created',
      'workflow-updated',
      'workflow-deleted',
      'workflow-triggered',
      'workflow-run-updated',
      'workflow-runs-listed',
    ],
  },
} as const satisfies Record<
  DaemonProtocolCapability,
  DaemonProtocolMessageGroup
>;
