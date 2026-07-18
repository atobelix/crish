import { describe, expect, it } from "vitest";
import { calculateDueWorkflowRuns, WorkflowScheduler } from "./workflow-scheduler";
import type { WorkflowDefinition, WorkflowRunEntry } from "./types";
import { validateInboundMessage, validateOutboundMessage } from "./protocol/protocol";

describe("workflow scheduler", () => {
  it("calculates daily workflows due in their configured timezone once per local day", () => {
    const workflow = workflowDefinition({
      id: "wf_daily",
      createdAt: "2026-06-07T00:00:00.000Z",
      schedule: { type: "daily", time: "09:30", timezone: "Asia/Shanghai" },
    });
    const scheduledFor = "2026-06-08T01:30:00.000Z";

    expect(
      calculateDueWorkflowRuns(
        [workflow],
        [],
        new Date("2026-06-08T01:29:59.000Z")
      )
    ).toEqual([]);

    expect(
      calculateDueWorkflowRuns(
        [workflow],
        [],
        new Date("2026-06-08T01:30:00.000Z")
      )
    ).toEqual([{ workflow, scheduledFor, reason: "daily" }]);

    expect(
      calculateDueWorkflowRuns(
        [workflow],
        [workflowRun({ workflowId: "wf_daily", scheduledFor })],
        new Date("2026-06-08T05:00:00.000Z")
      )
    ).toEqual([]);
  });

  it("calculates interval workflows from creation time and prior scheduled run", () => {
    const workflow = workflowDefinition({
      id: "wf_interval",
      createdAt: "2026-06-08T00:00:00.000Z",
      schedule: { type: "intervalMinutes", intervalMinutes: 15 },
    });

    expect(
      calculateDueWorkflowRuns(
        [workflow],
        [],
        new Date("2026-06-08T00:14:59.000Z")
      )
    ).toEqual([]);

    expect(
      calculateDueWorkflowRuns(
        [workflow],
        [],
        new Date("2026-06-08T00:15:00.000Z")
      )
    ).toEqual([
      {
        workflow,
        scheduledFor: "2026-06-08T00:15:00.000Z",
        reason: "intervalMinutes",
      },
    ]);

    expect(
      calculateDueWorkflowRuns(
        [workflow],
        [
          workflowRun({
            workflowId: "wf_interval",
            scheduledFor: "2026-06-08T00:15:00.000Z",
          }),
        ],
        new Date("2026-06-08T00:30:00.000Z")
      )
    ).toEqual([
      {
        workflow,
        scheduledFor: "2026-06-08T00:30:00.000Z",
        reason: "intervalMinutes",
      },
    ]);
  });

  it("tickScheduler exposes due calculation without requiring a background loop", async () => {
    const workflow = workflowDefinition({
      id: "wf_tick",
      createdAt: "2026-06-08T00:00:00.000Z",
      schedule: { type: "intervalMinutes", intervalMinutes: 10 },
    });
    const scheduler = new WorkflowScheduler({
      store: {
        listWorkflows: async () => [workflow],
        listRuns: async () => [],
        getWorkflow: async () => workflow,
        createWorkflow: async () => workflow,
        updateWorkflow: async () => workflow,
        deleteWorkflow: async () => true,
        appendRun: async () =>
          workflowRun({
            workflowId: workflow.id,
            scheduledFor: "2026-06-08T00:10:00.000Z",
          }),
        updateRun: async () => undefined,
      },
    });

    await expect(scheduler.tickScheduler(new Date("2026-06-08T00:10:00.000Z"))).resolves.toEqual({
      due: [
        {
          workflow,
          scheduledFor: "2026-06-08T00:10:00.000Z",
          reason: "intervalMinutes",
        },
      ],
      triggered: [],
    });
  });

  it("tickScheduler returns accepted workflow run handles without waiting for run completion", async () => {
    const workflow = workflowDefinition({
      id: "wf_tick_accept",
      createdAt: "2026-06-08T00:00:00.000Z",
      schedule: { type: "intervalMinutes", intervalMinutes: 10 },
    });
    const run = workflowRun({
      workflowId: workflow.id,
      runId: "run_tick_accept",
      scheduledFor: "2026-06-08T00:10:00.000Z",
      status: "running",
    });
    const scheduler = new WorkflowScheduler({
      store: {
        listWorkflows: async () => [workflow],
        listRuns: async () => [],
        getWorkflow: async () => workflow,
        createWorkflow: async () => workflow,
        updateWorkflow: async () => workflow,
        deleteWorkflow: async () => true,
        appendRun: async () => run,
        updateRun: async () => undefined,
      },
      triggerWorkflow: async () => ({
        accepted: true,
        runId: run.runId,
        workflowRunId: run.runId,
        run,
      }),
    });

    await expect(scheduler.tickScheduler(new Date("2026-06-08T00:10:00.000Z"))).resolves.toEqual({
      due: [
        {
          workflow,
          scheduledFor: "2026-06-08T00:10:00.000Z",
          reason: "intervalMinutes",
        },
      ],
      triggered: [
        {
          accepted: true,
          runId: "run_tick_accept",
          workflowRunId: "run_tick_accept",
          run,
        },
      ],
    });
  });
});

describe("workflow protocol schema", () => {
  it("accepts typed workflow create messages and rejects invalid schedules", () => {
    expect(
      validateInboundMessage({
        type: "create-workflow",
        id: "wf_schema",
        name: "Schema workflow",
        prompt: "Run schema test",
        cwd: "C:/workspace/crish",
        mode: "task",
        schedule: { type: "daily", time: "09:00", timezone: "Asia/Shanghai" },
        enabled: true,
        metadata: { source: "test" },
      }).ok
    ).toBe(true);

    const invalid = validateInboundMessage({
      type: "create-workflow",
      name: "Bad workflow",
      prompt: "Run schema test",
      schedule: { type: "daily", time: "25:00", timezone: "Not/AZone" },
    });

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.issues.map((issue: { path: string }) => issue.path)).toContain("$.schedule.time");
      expect(invalid.error.issues.map((issue: { path: string }) => issue.path)).toContain("$.schedule.timezone");
    }
  });

  it("validates workflow run history responses", () => {
    expect(
      validateOutboundMessage({
        type: "workflow-runs-listed",
        workflowId: "wf_schema",
        runs: [
          workflowRun({
            workflowId: "wf_schema",
            scheduledFor: "2026-06-08T00:00:00.000Z",
          }),
        ],
      }).ok
    ).toBe(true);

    expect(
      validateOutboundMessage({
        type: "workflow-runs-listed",
        runs: [{ workflowId: "wf_schema", runId: "run_a", status: "queued" }],
      }).ok
    ).toBe(false);
  });

  it("validates workflow run status update events", () => {
    const run = workflowRun({
      workflowId: "wf_schema",
      runId: "run_schema",
      scheduledFor: "2026-06-08T00:00:00.000Z",
      status: "awaiting-approval",
    });

    expect(
      validateOutboundMessage({
        type: "workflow-run-updated",
        workflowId: "wf_schema",
        runId: "run_schema",
        workflowRunId: "run_schema",
        run,
      }).ok
    ).toBe(true);
  });

  it("validates conversation rewind preview and apply messages", () => {
    const entries = sessionEntries();
    const inbound = validateInboundMessage({
      type: "preview-conversation-rewind",
      sessionId: "session_rewind",
      targetLeafId: "leaf_target",
      entries,
      checkpoint: { source: "runtime-manifest", checkpointId: "checkpoint_1" },
      restorePolicy: "if-present",
      activeSubagents: [
        {
          parentRunId: "run_parent",
          subagentRunId: "run_child",
          subagentId: "sub_1",
        },
      ],
    });

    expect(inbound.ok).toBe(true);

    const plan = {
      sessionId: "session_rewind",
      fromLeafId: "leaf_current",
      targetLeafId: "leaf_target",
      targetPath: entries.slice(0, 2),
      entryProjection: {
        currentPath: [entries[0], entries[2]],
        targetPath: entries.slice(0, 2),
        commonAncestorId: "root",
        retainedEntryIds: ["root", "leaf_target"],
        hiddenEntryIds: ["leaf_current"],
        hiddenCurrentPathEntryIds: ["leaf_current"],
        hiddenBranchEntryIds: [],
      },
      runCancellations: [
        { runId: "run_parent", reason: "conversation-rewind", role: "session-run" },
      ],
      approvalClearances: [
        { toolCallId: "approval_1", runId: "run_parent", reason: "conversation-rewind" },
      ],
      workspaceRestore: {
        required: true,
        source: "runtime-manifest",
        checkpointId: "checkpoint_1",
        cleanUntracked: false,
      },
      steps: [
        {
          type: "restore-workspace",
          restore: {
            required: true,
            source: "runtime-manifest",
            checkpointId: "checkpoint_1",
            cleanUntracked: false,
          },
        },
        {
          type: "move-session-leaf",
          sessionId: "session_rewind",
          fromLeafId: "leaf_current",
          toLeafId: "leaf_target",
        },
      ],
    };

    expect(
      validateOutboundMessage({
        type: "conversation-rewind-preview",
        sessionId: "session_rewind",
        plan,
      }).ok
    ).toBe(true);

    expect(
      validateOutboundMessage({
        type: "conversation-rewind-applied",
        sessionId: "session_rewind",
        plan,
        stepResults: [
          {
            type: "restore-workspace",
            status: "unsupported",
            message: "not implemented",
          },
          {
            type: "move-session-leaf",
            status: "deferred",
            message: "not implemented",
          },
        ],
      }).ok
    ).toBe(true);

    expect(
      validateInboundMessage({
        type: "apply-conversation-rewind",
        sessionId: "session_rewind",
        targetLeafId: "leaf_target",
        entries: [{ type: "node", id: "bad", createdAt: "2026-06-08T00:00:00.000Z" }],
      }).ok
    ).toBe(false);
  });

  it("validates approval timeout fields on outbound protocol messages", () => {
    expect(
      validateOutboundMessage({
        type: "approval-requested",
        runId: "run_schema",
        toolCallId: "approval_schema",
        toolName: "write_sensitive",
        input: { path: "approval.txt" },
        summary: "write approval.txt",
        timeoutMs: 300_000,
        expiresAt: 1_000_300_000,
        remainingMs: 300_000,
        risk: "destructive",
        riskReason: "Delete targets protected location",
        requiresDoubleConfirm: true,
        recommendSnapshot: true,
        metadata: {
          risk: "destructive",
          reason: "Delete targets protected location",
          requiresDoubleConfirm: true,
          recommendSnapshot: true,
        },
      }).ok
    ).toBe(true);

    expect(
      validateOutboundMessage({
        type: "approval-requested",
        runId: "run_schema",
        toolCallId: "approval_schema",
        toolName: "write_sensitive",
        input: { path: "approval.txt" },
        summary: "write approval.txt",
      }).ok
    ).toBe(false);

    expect(
      validateOutboundMessage({
        type: "approval-resolved",
        toolCallId: "approval_schema",
        decision: "expired",
        reason: "timeout",
        expiredAt: 1_000_300_000,
      }).ok
    ).toBe(true);
  });

  it("validates status responses with pending and recent approval snapshots", () => {
    const pendingApproval = {
      toolCallId: "approval_pending",
      runId: "run_schema",
      toolName: "write_sensitive",
      summary: "write pending.txt",
      createdAt: 1_000_000_000,
      status: "pending",
      timeoutMs: 300_000,
      expiresAt: 1_000_300_000,
      remainingMs: 120_000,
      risk: "destructive",
      riskReason: "Delete targets protected location",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      metadata: {
        risk: "destructive",
        reason: "Delete targets protected location",
        requiresDoubleConfirm: true,
        recommendSnapshot: true,
      },
    };
    const recentApproval = {
      toolCallId: "approval_recent",
      runId: "run_schema",
      toolName: "write_sensitive",
      summary: "write recent.txt",
      createdAt: 1_000_000_000,
      status: "expired",
      timeoutMs: 300_000,
      expiresAt: 1_000_300_000,
      remainingMs: 0,
      resolvedAt: 1_000_300_000,
      expiredAt: 1_000_300_000,
      reason: "timeout",
      expiredReason: "timeout",
    };

    expect(
      validateOutboundMessage({
        type: "status-response",
        lifecycle: lifecycleSnapshot(),
        activeRuns: [],
        pendingApprovals: [pendingApproval],
        recentApprovals: [recentApproval],
        providerStatus: providerStatusSnapshot(),
        mcpStatus: mcpStatusSnapshot(),
        capabilities: capabilitySnapshot(),
      }).ok
    ).toBe(true);

    expect(
      validateOutboundMessage({
        type: "status-response",
        lifecycle: lifecycleSnapshot(),
        activeRuns: [],
        pendingApprovals: [pendingApproval],
        providerStatus: providerStatusSnapshot(),
        mcpStatus: mcpStatusSnapshot(),
      }).ok
    ).toBe(false);
  });
});

function workflowDefinition(
  patch: Partial<WorkflowDefinition> & Pick<WorkflowDefinition, "id" | "schedule">
): WorkflowDefinition {
  return {
    id: patch.id,
    name: patch.name ?? patch.id,
    prompt: patch.prompt ?? "Run workflow",
    cwd: patch.cwd ?? "C:/workspace/crish",
    mode: patch.mode ?? "task",
    schedule: patch.schedule,
    enabled: patch.enabled ?? true,
    createdAt: patch.createdAt ?? "2026-06-08T00:00:00.000Z",
    updatedAt: patch.updatedAt ?? patch.createdAt ?? "2026-06-08T00:00:00.000Z",
    metadata: patch.metadata ?? {},
  };
}

function workflowRun(patch: Partial<WorkflowRunEntry> & { workflowId: string; scheduledFor: string }): WorkflowRunEntry {
  return {
    workflowId: patch.workflowId,
    runId: patch.runId ?? `run_${patch.workflowId}`,
    sessionId: patch.sessionId ?? `session_${patch.workflowId}`,
    scheduledFor: patch.scheduledFor,
    startedAt: patch.startedAt ?? patch.scheduledFor,
    status: patch.status ?? "completed",
    ...(patch.error !== undefined ? { error: patch.error } : {}),
  };
}

function sessionEntries() {
  return [
    {
      type: "node",
      id: "root",
      parentId: null,
      createdAt: "2026-06-08T00:00:00.000Z",
      payload: { text: "root" },
    },
    {
      type: "node",
      id: "leaf_target",
      parentId: "root",
      createdAt: "2026-06-08T00:00:01.000Z",
      payload: { text: "target" },
    },
    {
      type: "node",
      id: "leaf_current",
      parentId: "root",
      createdAt: "2026-06-08T00:00:02.000Z",
      payload: { text: "current" },
    },
  ];
}

function lifecycleSnapshot() {
  return {
    state: "ready",
    startedAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:01.000Z",
    readyAt: "2026-06-08T00:00:00.000Z",
    uptimeMs: 1_000,
    currentPort: 12345,
    connectedClientCount: 1,
    totalClientConnectionCount: 1,
    totalClientDisconnectCount: 0,
    activeRunCount: 0,
    eventStore: {
      status: "ok",
      path: "C:/workspace/crish/events.jsonl",
    },
    providerReadiness: "ready",
    mcpReadiness: "unknown",
  };
}

function providerStatusSnapshot() {
  return {
    credentialMode: "auto",
    readiness: "ready",
    providerId: "crish",
    routeId: "default:crish:mimo-v2.5",
    baseUrl: "https://gateway.example/v1",
    model: "mimo-v2.5",
    upstreamModel: "mimo-v2.5",
    endpoint: "auto",
    stream: true,
    systemPromptWireMode: "native-system-role",
    apiKey: {
      hasApiKey: false,
      source: "unset",
    },
    hasDirectApiKey: false,
    apiKeySource: "unset",
    gateway: {
      ready: true,
      credentialConfigured: true,
      routeDecision: ["selected_route"],
    },
    updatedAt: "2026-06-08T00:00:00.000Z",
  };
}

function mcpStatusSnapshot() {
  return {
    configured: false,
    readiness: "unknown",
    serverCount: 0,
    summary: {},
    diagnostics: [],
    servers: [],
    updatedAt: "2026-06-08T00:00:00.000Z",
  };
}

function capabilitySnapshot() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-08T00:00:00.000Z",
    capabilities: [],
  };
}
