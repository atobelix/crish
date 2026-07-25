import type { WebSocket } from 'ws';
import type { JsonObject } from '@crish/shared-types';
import { AgentOrchestrator } from '@crish/agent-orchestrator';
import {
  handleListWorkflows,
  handleCreateWorkflow,
  handleUpdateWorkflow,
  handleDeleteWorkflow,
  handleTriggerWorkflow,
  handleListWorkflowRuns,
} from './handlers/workflow-handlers.js';
import {
  RunHandler,
  type DaemonMessageTransport,
  correlateResponse,
  correlationFrom,
} from './handlers/run-handlers.js';
import {
  handleListPlanDocuments,
  handleCreatePlanDocument,
  handleCreateRequirementsAlignmentPlan,
  handleGetPlanDocument,
  handlePatchPlanDocument,
  handleDeletePlanDocument,
} from './handlers/plan-document-handlers.js';
import {
  handleApproveTool as handleApproveToolExtracted,
  handleDenyTool as handleDenyToolExtracted,
} from './handlers/approval-handlers.js';
import {
  handleEnqueuePendingInput as handleEnqueuePendingInputExtracted,
  handleCancelPendingInput as handleCancelPendingInputExtracted,
  handleDispatchPendingInput as handleDispatchPendingInputExtracted,
  handleListPendingInputs as handleListPendingInputsExtracted,
} from './handlers/pending-input-handlers.js';
import {
  handleGetScopedContext as handleGetScopedContextExtracted,
  handleUpsertScopedContext as handleUpsertScopedContextExtracted,
  handleDeleteScopedContext as handleDeleteScopedContextExtracted,
  handleResolveScopedContext as handleResolveScopedContextExtracted,
} from './handlers/scoped-context-handlers.js';
import {
  handleStartMcpServer as handleStartMcpServerExtracted,
  handleStopMcpServer as handleStopMcpServerExtracted,
  handleListMcpServers as handleListMcpServersExtracted,
} from './handlers/mcp-handlers.js';
import {
  handleSendToSubagent as handleSendToSubagentExtracted,
  handleGetSubagentStatus as handleGetSubagentStatusExtracted,
} from './handlers/subagent-handlers.js';
import {
  handleGitStatus as handleGitStatusExtracted,
  handleGitDiff as handleGitDiffExtracted,
} from './handlers/git-handlers.js';
import {
  handleListBackgroundTasks as handleListBackgroundTasksExtracted,
  handleStartBackgroundTask as handleStartBackgroundTaskExtracted,
  handleCancelBackgroundTask as handleCancelBackgroundTaskExtracted,
  handleGetBackgroundTaskHistory as handleGetBackgroundTaskHistoryExtracted,
} from './handlers/background-task-handlers.js';
import {
  handleListArtifacts as handleListArtifactsExtracted,
  handleGetArtifactContent as handleGetArtifactContentExtracted,
  handleListMemories as handleListMemoriesExtracted,
  handleDeleteMemory as handleDeleteMemoryExtracted,
  handleListCheckpoints as handleListCheckpointsExtracted,
  handleRestoreCheckpoint as handleRestoreCheckpointExtracted,
  handleGetCheckpointDiff as handleGetCheckpointDiffExtracted,
} from './handlers/artifact-handlers.js';
import {
  handleGetStatus as handleGetStatusExtracted,
  handleListCapabilities as handleListCapabilitiesExtracted,
  handleUpdateConfig as handleUpdateConfigExtracted,
  handleProbeProviderModels as handleProbeProviderModelsExtracted,
  handleProbeProviderChat as handleProbeProviderChatExtracted,
} from './handlers/config-handlers.js';
import {
  handleReadSessionEvents as handleReadSessionEventsExtracted,
  handleReadRunEvents as handleReadRunEventsExtracted,
  handleGetRunSnapshot as handleGetRunSnapshotExtracted,
  handlePreviewConversationRewind as handlePreviewConversationRewindExtracted,
  handleResolveConversationRewindBoundary as handleResolveConversationRewindBoundaryExtracted,
  handlePreviewConversationRewindByBoundary as handlePreviewConversationRewindByBoundaryExtracted,
  handleApplyConversationRewind as handleApplyConversationRewindExtracted,
  handleApplySessionAction as handleApplySessionActionExtracted,
} from './handlers/session-handlers.js';
import { ApprovalQueue } from './approval-queue.js';
import type {
  DaemonConfig,
  DaemonInboundMessage,
  DaemonLifecycleSnapshot,
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
  DaemonProviderCredentialMode,
} from './types.js';
import type { ConnectedClient } from './daemon-client-registry.js';
import { DaemonRuntimeFactory } from './server-runtime-factory.js';
import { DaemonSubagentBridge } from './daemon-subagent-bridge.js';
import {
  createListRunsResponse,
  createListSessionsResponse,
} from './session-query-handlers.js';
import type {
  WorkflowDueRun,
  WorkflowRunAccepted,
} from './workflow-scheduler.js';
import { type WorkflowStore } from './workflow-store.js';
import { type PlanDocumentStore } from './plan-document-store.js';
import type { DaemonBackgroundTaskManager } from './background-task-manager.js';
import type { ScopedContextStore } from './scoped-context-store.js';
import type { FileSessionMetadataStore } from './session-metadata-store.js';

export interface DaemonRuntimeConfigUpdate {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: DaemonProviderCredentialMode;
  endpoint?: 'auto' | 'responses' | 'chat-completions';
  stream?: boolean;
}

interface DaemonRequestHandlersOptions {
  runHandler: RunHandler;
  orchestrator: AgentOrchestrator;
  approvalQueue: ApprovalQueue;
  config: DaemonConfig;
  runtimeFactory: DaemonRuntimeFactory;
  backgroundTasks: DaemonBackgroundTaskManager;
  workflowStore: WorkflowStore;
  planDocumentStore: PlanDocumentStore;
  scopedContextStore: ScopedContextStore;
  sessionMetadataStore: FileSessionMetadataStore;
  transport: DaemonMessageTransport;
  subagentBridge: DaemonSubagentBridge;
  getLifecycleSnapshot(input: {
    activeRunCount: number;
    providerStatus: DaemonProviderStatusSnapshot;
    mcpStatus: DaemonMcpStatusSnapshot;
  }): DaemonLifecycleSnapshot;
  recordDiagnostic?(input: {
    code: string;
    message: string;
    source:
      'daemon' | 'websocket' | 'client' | 'event-store' | 'provider' | 'mcp';
    severity?: 'warning' | 'error';
    detail?: string;
    metadata?: JsonObject;
  }): void;
  getConfigUpdateHandler():
    ((update: DaemonRuntimeConfigUpdate) => void) | undefined;
  applyMcpServerConfigs?(
    configs: NonNullable<import('./types.js').UpdateConfigMessage['mcpServers']>
  ): Promise<void> | void;
}

export class DaemonRequestHandlers {
  constructor(private readonly options: DaemonRequestHandlersOptions) {}

  async triggerWorkflowRun(input: {
    workflowId: string;
    runId?: string;
    sessionId?: string;
    scheduledFor?: string;
    clientId?: string;
    ws?: WebSocket;
  }): Promise<WorkflowRunAccepted> {
    return this.options.runHandler.triggerWorkflowRun(input);
  }

  async triggerDueWorkflow(
    due: WorkflowDueRun,
    now: Date
  ): Promise<WorkflowRunAccepted> {
    return this.options.runHandler.triggerDueWorkflow(due, now);
  }

  async waitForBackgroundWorkflowRuns(timeoutMs: number): Promise<void> {
    return this.options.runHandler.waitForBackgroundWorkflowRuns(timeoutMs);
  }

  async handleInboundMessage(
    ws: WebSocket,
    client: ConnectedClient,
    msg: DaemonInboundMessage
  ): Promise<void> {
    switch (msg.type) {
      case 'run-task':
        await this.options.runHandler.handleRunTaskWithOrchestrator(
          ws,
          client.id,
          msg
        );
        break;

      case 'approve-tool':
        handleApproveToolExtracted(
          msg,
          this.options.approvalQueue,
          this.options.transport,
          ws
        );
        break;

      case 'deny-tool':
        handleDenyToolExtracted(
          msg,
          this.options.approvalQueue,
          this.options.transport,
          ws
        );
        break;

      case 'cancel-run':
        this.options.runHandler.handleCancelRun(msg);
        break;

      case 'stream-pause':
        this.options.runHandler.pauseStream(msg.runId);
        this.options.transport.send(
          ws,
          correlateResponse({ type: 'pong' }, msg)
        );
        break;

      case 'stream-resume':
        this.options.runHandler.resumeStream(msg.runId);
        this.options.transport.send(
          ws,
          correlateResponse({ type: 'pong' }, msg)
        );
        break;

      case 'ping':
        this.options.transport.send(
          ws,
          correlateResponse({ type: 'pong' }, msg)
        );
        break;

      case 'get-status':
        handleGetStatusExtracted(
          ws,
          msg,
          {
            orchestrator: this.options.orchestrator,
            approvalQueue: this.options.approvalQueue,
            runtimeFactory: this.options.runtimeFactory,
            transport: this.options.transport,
            activeRunCount: this.options.runHandler.activeRunCount(),
            getLifecycleSnapshot: this.options.getLifecycleSnapshot,
            getConfigUpdateHandler: () => this.options.getConfigUpdateHandler(),
          },
          correlateResponse
        );
        break;

      case 'list-capabilities':
        handleListCapabilitiesExtracted(
          ws,
          msg,
          {
            orchestrator: this.options.orchestrator,
            approvalQueue: this.options.approvalQueue,
            runtimeFactory: this.options.runtimeFactory,
            transport: this.options.transport,
            activeRunCount: this.options.runHandler.activeRunCount(),
            getLifecycleSnapshot: this.options.getLifecycleSnapshot,
            getConfigUpdateHandler: () => this.options.getConfigUpdateHandler(),
          },
          correlateResponse
        );
        break;

      case 'update-config':
        await handleUpdateConfigExtracted(
          ws,
          msg,
          {
            orchestrator: this.options.orchestrator,
            approvalQueue: this.options.approvalQueue,
            runtimeFactory: this.options.runtimeFactory,
            transport: this.options.transport,
            activeRunCount: this.options.runHandler.activeRunCount(),
            getLifecycleSnapshot: this.options.getLifecycleSnapshot,
            getConfigUpdateHandler: () => this.options.getConfigUpdateHandler(),
            ...(this.options.applyMcpServerConfigs
              ? { applyMcpServerConfigs: (configs: NonNullable<import('./types.js').UpdateConfigMessage['mcpServers']>) => this.options.applyMcpServerConfigs!(configs) }
              : {}),
          },
          correlateResponse,
          correlationFrom
        );
        break;

      case 'probe-provider-models':
        handleProbeProviderModelsExtracted(
          ws,
          msg,
          {
            orchestrator: this.options.orchestrator,
            approvalQueue: this.options.approvalQueue,
            runtimeFactory: this.options.runtimeFactory,
            transport: this.options.transport,
            activeRunCount: this.options.runHandler.activeRunCount(),
            getLifecycleSnapshot: this.options.getLifecycleSnapshot,
            getConfigUpdateHandler: () => this.options.getConfigUpdateHandler(),
          },
          correlateResponse
        );
        break;

      case 'probe-provider-chat':
        handleProbeProviderChatExtracted(
          ws,
          msg,
          {
            orchestrator: this.options.orchestrator,
            approvalQueue: this.options.approvalQueue,
            runtimeFactory: this.options.runtimeFactory,
            transport: this.options.transport,
            activeRunCount: this.options.runHandler.activeRunCount(),
            getLifecycleSnapshot: this.options.getLifecycleSnapshot,
            getConfigUpdateHandler: () => this.options.getConfigUpdateHandler(),
          },
          correlateResponse
        );
        break;

      case 'list-sessions':
        this.options.transport.send(
          ws,
          correlateResponse(
            await createListSessionsResponse(this.options.orchestrator, {
              metadataStore: this.options.sessionMetadataStore,
              query: msg,
            }),
            msg
          )
        );
        break;

      case 'list-runs':
        this.options.transport.send(
          ws,
          correlateResponse(
            createListRunsResponse(this.options.orchestrator, msg),
            msg
          )
        );
        break;

      case 'read-session-events':
        await handleReadSessionEventsExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.transport,
          correlateResponse,
          correlationFrom
        );
        break;

      case 'read-run-events':
        await handleReadRunEventsExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.transport,
          correlateResponse,
          correlationFrom
        );
        break;

      case 'get-run-snapshot':
        await handleGetRunSnapshotExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.transport,
          correlateResponse,
          correlationFrom
        );
        break;

      case 'enqueue-pending-input':
        await handleEnqueuePendingInputExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'cancel-pending-input':
        await handleCancelPendingInputExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'dispatch-pending-input':
        await handleDispatchPendingInputExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'list-pending-inputs':
        handleListPendingInputsExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'list-workflows':
        await handleListWorkflows(
          ws,
          msg,
          this.options.transport,
          this.options.workflowStore
        );
        break;

      case 'create-workflow':
        await handleCreateWorkflow(
          ws,
          msg,
          this.options.transport,
          this.options.workflowStore,
          this.options.config.defaultCwd
        );
        break;

      case 'update-workflow':
        await handleUpdateWorkflow(
          ws,
          msg,
          this.options.transport,
          this.options.workflowStore
        );
        break;

      case 'delete-workflow':
        await handleDeleteWorkflow(
          ws,
          msg,
          this.options.transport,
          this.options.workflowStore
        );
        break;

      case 'trigger-workflow':
        await handleTriggerWorkflow(
          ws,
          client,
          msg,
          this.options.transport,
          (input) => this.options.runHandler.triggerWorkflowRun(input)
        );
        break;

      case 'list-workflow-runs':
        await handleListWorkflowRuns(
          ws,
          msg,
          this.options.transport,
          this.options.workflowStore
        );
        break;

      case 'git-status':
        await handleGitStatusExtracted(
          ws,
          msg,
          this.options.config,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'git-diff':
        await handleGitDiffExtracted(
          ws,
          msg,
          this.options.config,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'list-plan-documents':
        await handleListPlanDocuments(
          ws,
          msg,
          this.options.transport,
          this.options.planDocumentStore
        );
        break;

      case 'create-plan-document':
        await handleCreatePlanDocument(
          ws,
          msg,
          this.options.transport,
          this.options.planDocumentStore
        );
        break;

      case 'create-requirements-alignment-plan':
        await handleCreateRequirementsAlignmentPlan(
          ws,
          msg,
          this.options.transport,
          this.options.planDocumentStore
        );
        break;

      case 'get-plan-document':
        await handleGetPlanDocument(
          ws,
          msg,
          this.options.transport,
          this.options.planDocumentStore
        );
        break;

      case 'patch-plan-document':
        await handlePatchPlanDocument(
          ws,
          msg,
          this.options.transport,
          this.options.planDocumentStore
        );
        break;

      case 'delete-plan-document':
        await handleDeletePlanDocument(
          ws,
          msg,
          this.options.transport,
          this.options.planDocumentStore
        );
        break;

      case 'list-mutation-leases':
        this.options.runHandler.handleListMutationLeases(ws, msg);
        break;

      case 'list-background-tasks':
        handleListBackgroundTasksExtracted(
          ws,
          msg,
          this.options.backgroundTasks,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'start-background-task':
        await handleStartBackgroundTaskExtracted(
          ws,
          msg,
          this.options.backgroundTasks,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'cancel-background-task':
        handleCancelBackgroundTaskExtracted(
          ws,
          msg,
          this.options.backgroundTasks,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'get-background-task-history':
        handleGetBackgroundTaskHistoryExtracted(
          ws,
          msg,
          this.options.backgroundTasks,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'preview-conversation-rewind':
        handlePreviewConversationRewindExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.approvalQueue,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'resolve-conversation-rewind-boundary':
        await handleResolveConversationRewindBoundaryExtracted(
          ws,
          msg,
          this.options.config,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'preview-conversation-rewind-by-boundary':
        await handlePreviewConversationRewindByBoundaryExtracted(
          ws,
          msg,
          this.options.config,
          this.options.orchestrator,
          this.options.approvalQueue,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'apply-conversation-rewind':
        await handleApplyConversationRewindExtracted(
          ws,
          msg,
          {
            orchestrator: this.options.orchestrator,
            approvalQueue: this.options.approvalQueue,
            config: this.options.config,
            transport: this.options.transport,
            sessionMetadataStore: this.options.sessionMetadataStore,
          },
          correlateResponse
        );
        break;

      case 'apply-session-action':
        await handleApplySessionActionExtracted(
          ws,
          msg,
          this.options.orchestrator,
          this.options.sessionMetadataStore,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'list-artifacts':
        await handleListArtifactsExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'get-artifact-content':
        await handleGetArtifactContentExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'list-memories':
        await handleListMemoriesExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'delete-memory':
        await handleDeleteMemoryExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'list-checkpoints':
        await handleListCheckpointsExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'restore-checkpoint':
        await handleRestoreCheckpointExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'get-checkpoint-diff':
        await handleGetCheckpointDiffExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'send-to-subagent':
        handleSendToSubagentExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'get-subagent-status':
        handleGetSubagentStatusExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'start-mcp-server':
        await handleStartMcpServerExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'stop-mcp-server':
        await handleStopMcpServerExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'list-mcp-servers':
        handleListMcpServersExtracted(
          ws,
          msg,
          this.options.runtimeFactory,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'get-scoped-context':
        await handleGetScopedContextExtracted(
          ws,
          msg,
          this.options.scopedContextStore,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'upsert-scoped-context':
        await handleUpsertScopedContextExtracted(
          ws,
          msg,
          this.options.scopedContextStore,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'delete-scoped-context':
        await handleDeleteScopedContextExtracted(
          ws,
          msg,
          this.options.scopedContextStore,
          this.options.transport,
          correlateResponse
        );
        break;

      case 'resolve-scoped-context':
        await handleResolveScopedContextExtracted(
          ws,
          msg,
          this.options.scopedContextStore,
          this.options.transport,
          correlateResponse
        );
        break;

      default:
        this.options.transport.sendError(
          ws,
          'UNKNOWN_MESSAGE_TYPE',
          `Unknown message type: ${(msg as unknown as Record<string, unknown>).type}`,
          undefined,
          correlationFrom(msg as unknown as import('./types.js').DaemonCorrelationFields)
        );
    }
  }
}
