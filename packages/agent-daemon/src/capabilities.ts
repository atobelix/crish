import type { JsonObject } from "@crish/shared-types";
import type {
  DaemonCapabilityRecord,
  DaemonCapabilitySnapshot,
  DaemonCapabilityState,
  DaemonLifecycleSnapshot,
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
} from "./types.js";
import type { DaemonProductAdapterStatusSnapshot } from "./daemon-product-adapters.js";
import {
  DAEMON_INBOUND_MESSAGE_REGISTRY,
  DAEMON_OUTBOUND_MESSAGE_REGISTRY,
} from "./protocol/registry.js";

export interface BuildDaemonCapabilitySnapshotInput {
  providerStatus: DaemonProviderStatusSnapshot;
  mcpStatus: DaemonMcpStatusSnapshot;
  productAdapters?: DaemonProductAdapterStatusSnapshot;
  lifecycle?: DaemonLifecycleSnapshot;
  now?: Date;
}

interface CapabilityDefinition {
  id: string;
  title: string;
  state: DaemonCapabilityState;
  reason: string;
  owner: DaemonCapabilityRecord["owner"];
  relatedMessageTypes: string[];
  relatedTauriCommands?: string[];
}

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  {
    id: "daemon.status",
    title: "Daemon status",
    state: "implemented",
    reason: "Status, lifecycle, provider, MCP, and capability snapshots are served by agent-daemon.",
    owner: "agent-daemon",
    relatedMessageTypes: ["get-status", "status-response", "list-capabilities", "capabilities-response"],
    relatedTauriCommands: ["workbench_status", "workbench_provider_diagnostics"],
  },
  {
    id: "run.execution",
    title: "Run execution",
    state: "implemented",
    reason: "Run start, cancel, stream, and snapshot APIs are wired through AgentOrchestrator.",
    owner: "agent-daemon",
    relatedMessageTypes: ["run-task", "cancel-run", "get-run-snapshot", "run-snapshot"],
    relatedTauriCommands: [
      "workbench_run_task_stream",
      "workbench_run_goal_stream",
      "workbench_cancel_run",
      "workbench_get_run_snapshot",
    ],
  },
  {
    id: "session.history",
    title: "Session history",
    state: "implemented",
    reason: "Session and run event queries are backed by the orchestrator event store.",
    owner: "agent-orchestrator",
    relatedMessageTypes: ["list-sessions", "list-runs", "read-session-events", "read-run-events"],
    relatedTauriCommands: [
      "workbench_list_sessions",
      "workbench_list_runs",
      "workbench_read_session_events",
      "workbench_read_run_events",
    ],
  },
  {
    id: "session.actions",
    title: "Session actions",
    state: "experimental",
    reason:
      "Daemon persists pin, rename, archive, unarchive, and soft delete in a daemon-owned session metadata store; fork remains unsupported until durable session-tree cloning is defined.",
    owner: "agent-daemon",
    relatedMessageTypes: ["apply-session-action", "session-action-receipt"],
  },
  {
    id: "approval.queue",
    title: "Approval queue",
    state: "implemented",
    reason: "Approval request, resolution, timeout, and status snapshots are owned by agent-daemon.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "approve-tool",
      "deny-tool",
      "approval-requested",
      "approval-resolved",
    ],
    relatedTauriCommands: ["workbench_approve_tool", "workbench_deny_tool"],
  },
  {
    id: "workflow.scheduler",
    title: "Workflow scheduler",
    state: "implemented",
    reason: "Workflow definitions, run history, and scheduler triggering are daemon-owned.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "list-workflows",
      "create-workflow",
      "update-workflow",
      "delete-workflow",
      "trigger-workflow",
      "list-workflow-runs",
    ],
  },
  {
    id: "plan-document",
    title: "Plan documents",
    state: "implemented",
    reason: "Editable plans and requirements alignment documents share the daemon-owned PlanDocument store.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "list-plan-documents",
      "create-plan-document",
      "create-requirements-alignment-plan",
      "get-plan-document",
      "patch-plan-document",
      "delete-plan-document",
    ],
  },
  {
    id: "git.workspace",
    title: "Git workspace status",
    state: "implemented",
    reason: "Read-only Git status and diff queries are served through the daemon Git adapter.",
    owner: "agent-daemon",
    relatedMessageTypes: ["git-status", "git-diff", "git-status-response", "git-diff-response"],
    relatedTauriCommands: ["workbench_git_status", "workbench_git_diff"],
  },
  {
    id: "mutation.leases",
    title: "Mutation leases",
    state: "implemented",
    reason: "Workspace mutation lease inspection is backed by daemon runtime coordinators.",
    owner: "agent-runtime",
    relatedMessageTypes: ["list-mutation-leases", "mutation-leases-listed"],
    relatedTauriCommands: ["workbench_list_mutation_leases"],
  },
  {
    id: "background.tasks",
    title: "Background tasks",
    state: "experimental",
    reason:
      "Background task protocol, daemon manager, and Workbench Tauri list/cancel/output-preview commands are wired; full persisted output remains future work.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "list-background-tasks",
      "start-background-task",
      "cancel-background-task",
      "get-background-task-history",
      "background-tasks-listed",
      "background-task-started",
      "background-task-cancelled",
      "background-task-history",
    ],
    relatedTauriCommands: [
      "workbench_list_background_tasks",
      "workbench_cancel_background_task",
      "workbench_get_background_task_output",
    ],
  },
  {
    id: "scoped-context",
    title: "Scoped context",
    state: "implemented",
    reason: "Scoped context CRUD, resolution, and runtime prompt injection are daemon-owned.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "get-scoped-context",
      "upsert-scoped-context",
      "delete-scoped-context",
      "resolve-scoped-context",
    ],
  },
  {
    id: "conversation.rewind",
    title: "Conversation rewind",
    state: "experimental",
    reason: "Rewind planning and boundary diagnostics are wired, while restore execution may defer unsupported runtime steps.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "resolve-conversation-rewind-boundary",
      "preview-conversation-rewind",
      "preview-conversation-rewind-by-boundary",
      "apply-conversation-rewind",
    ],
    relatedTauriCommands: ["workbench_preview_conversation_rewind", "workbench_apply_conversation_rewind"],
  },
  {
    id: "mcp.lifecycle",
    title: "MCP lifecycle",
    state: "experimental",
    reason: "MCP server discovery and status are wired; start and stop depend on manager support.",
    owner: "agent-runtime",
    relatedMessageTypes: [
      "list-mcp-servers",
      "mcp-servers-listed",
      "start-mcp-server",
      "stop-mcp-server",
      "mcp-server-started",
      "mcp-server-stopped",
    ],
    relatedTauriCommands: [
      "workbench_list_mcp_servers",
      "workbench_start_mcp_server",
      "workbench_stop_mcp_server",
    ],
  },
  {
    id: "subagent.control",
    title: "Subagent direct control",
    state: "unsupported",
    reason: "Subagent execution is available as a runtime tool, but daemon direct send/status control has no durable routing API.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "send-to-subagent",
      "get-subagent-status",
      "subagent-message-sent",
      "subagent-status",
      "subagent-started",
      "subagent-event",
      "subagent-ended",
    ],
    relatedTauriCommands: ["workbench_send_to_subagent", "workbench_get_subagent_status"],
  },
  {
    id: "artifacts",
    title: "Artifacts",
    state: "unsupported",
    reason: "No daemon-owned artifact index or runtime artifact adapter is currently wired.",
    owner: "agent-runtime",
    relatedMessageTypes: ["list-artifacts", "get-artifact-content", "artifacts-listed", "artifact-content"],
    relatedTauriCommands: ["workbench_list_artifacts", "workbench_get_artifact_content"],
  },
  {
    id: "memory",
    title: "Memory",
    state: "unsupported",
    reason: "No daemon-owned memory store or runtime memory adapter is currently wired.",
    owner: "agent-runtime",
    relatedMessageTypes: ["list-memories", "delete-memory", "memories-listed", "memory-deleted"],
    relatedTauriCommands: ["workbench_list_memories", "workbench_delete_memory"],
  },
  {
    id: "checkpoints",
    title: "Checkpoints",
    state: "experimental",
    reason: "Checkpoint manifests can inform rewind boundaries; list/restore/diff APIs are experimental and may lack a full runtime adapter.",
    owner: "agent-runtime",
    relatedMessageTypes: [
      "list-checkpoints",
      "restore-checkpoint",
      "get-checkpoint-diff",
      "checkpoints-listed",
      "checkpoint-restored",
      "checkpoint-diff",
    ],
    relatedTauriCommands: [
      "workbench_list_checkpoints",
      "workbench_get_checkpoint_diff",
      "workbench_restore_checkpoint",
    ],
  },
];

export function buildDaemonCapabilitySnapshot(
  input: BuildDaemonCapabilitySnapshotInput
): DaemonCapabilitySnapshot {
  const generatedAt = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    capabilities: CAPABILITY_DEFINITIONS.map((definition) =>
      applyRuntimeState(definition, input, generatedAt)
    ),
  };
}

function applyRuntimeState(
  definition: CapabilityDefinition,
  input: BuildDaemonCapabilitySnapshotInput,
  generatedAt: string
): DaemonCapabilityRecord {
  const diagnostics: DaemonCapabilityRecord["diagnostics"] = [];
  let state = definition.state;
  let reason = definition.reason;

  if (definition.id === "run.execution" && input.providerStatus.readiness !== "ready") {
    state = "degraded";
    reason = `Run execution is degraded because provider readiness is ${input.providerStatus.readiness}.`;
    diagnostics.push({
      code: "PROVIDER_NOT_READY",
      message: reason,
      severity: "warning",
      updatedAt: input.providerStatus.updatedAt,
    });
  }

  if (definition.id === "mcp.lifecycle") {
    if (!input.mcpStatus.configured) {
      state = "unsupported";
      reason = "No MCP servers or lifecycle manager are configured for this daemon.";
    } else if (input.mcpStatus.readiness === "degraded") {
      state = "degraded";
      reason = "One or more MCP servers are degraded.";
      diagnostics.push({
        code: "MCP_DEGRADED",
        message: reason,
        severity: "warning",
        updatedAt: input.mcpStatus.updatedAt,
        metadata: { mcp: input.mcpStatus as unknown as JsonObject },
      });
    }
  }

  const productStatus = productStatusForCapability(definition.id, input.productAdapters);
  if (productStatus) {
    // Product adapter 不能将 capability 提升到高于其相关消息类型在 registry 中的实现状态
    const registryState = minRegistryStateForCapability(definition.relatedMessageTypes);
    if (registryState === "unsupported" && (productStatus.state === "implemented" || productStatus.state === "experimental")) {
      state = "unsupported";
      reason = `Product adapter reports ${productStatus.state}, but related protocol messages are not yet implemented in the daemon registry.`;
      diagnostics.push({
        code: "CAPABILITY_REGISTRY_MISMATCH",
        message: reason,
        severity: "warning",
        updatedAt: generatedAt,
      });
    } else {
      state = productStatus.state;
      reason = productStatus.reason;
      diagnostics.push(...productStatus.diagnostics);
    }
  }

  if (input.lifecycle?.eventStore.status === "failed" && affectsEventStore(definition.id)) {
    state = "degraded";
    reason = "Daemon event store is degraded; durable run and history capabilities may reject requests.";
    if (input.lifecycle.eventStore.failure) {
      diagnostics.push({
        code: input.lifecycle.eventStore.failure.code,
        message: input.lifecycle.eventStore.failure.message,
        severity: input.lifecycle.eventStore.failure.severity,
        updatedAt: input.lifecycle.eventStore.failure.updatedAt,
      });
    }
  }

  return {
    id: definition.id,
    title: definition.title,
    state,
    reason,
    owner: definition.owner,
    relatedMessageTypes: definition.relatedMessageTypes,
    relatedTauriCommands: definition.relatedTauriCommands ?? [],
    updatedAt: diagnostics.at(-1)?.updatedAt ?? generatedAt,
    diagnostics,
  };
}

function affectsEventStore(capabilityId: string): boolean {
  return capabilityId === "run.execution" || capabilityId === "session.history" || capabilityId === "workflow.scheduler";
}

function productStatusForCapability(
  capabilityId: string,
  snapshot: DaemonProductAdapterStatusSnapshot | undefined
) {
  if (!snapshot) return undefined;
  if (capabilityId === "artifacts") return snapshot.artifacts;
  if (capabilityId === "memory") return snapshot.memory;
  if (capabilityId === "checkpoints") return snapshot.checkpoints;
  return undefined;
}

/**
 * 检查 capability 相关的所有消息类型在 registry 中的最低实现状态。
 * 如果任一消息类型是 unsupported，则返回 "unsupported"。
 * 否则返回 "implemented"（表示至少所有消息类型都已注册为非 unsupported）。
 */
function minRegistryStateForCapability(
  relatedMessageTypes: string[]
): "unsupported" | "implemented" {
  const allRegistries = new Map([
    ...Object.entries(DAEMON_INBOUND_MESSAGE_REGISTRY),
    ...Object.entries(DAEMON_OUTBOUND_MESSAGE_REGISTRY),
  ]);
  for (const type of relatedMessageTypes) {
    const entry = allRegistries.get(type);
    if (!entry || entry.state === "unsupported") {
      return "unsupported";
    }
  }
  return "implemented";
}
