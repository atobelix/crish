import { describe, expect, it } from "vitest";
import {
  approvalIdFromEvent,
  buildInitialTaskSnapshot,
  isDaemonLifecycleSnapshot,
  isDaemonMcpStatusSnapshot,
  isDaemonProviderStatusSnapshot,
  isDaemonTaskSnapshot,
  isWorkbenchConversationRewindAppliedResponse,
  isWorkbenchConversationRewindPreviewResult,
  isWorkbenchSessionActionReceipt,
  normalizeWorkbenchEvent,
  normalizeWorkbenchApprovalMetadata,
  projectDaemonStatusToWorkbench,
  projectDaemonProviderStatusToWorkbench,
  projectDaemonTaskSnapshotToWorkbench,
  WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION,
  WORKBENCH_SESSION_ACTIONS,
  workbenchRunLifecycleStatusFromDaemon,
  type DaemonLifecycleSnapshot,
  type DaemonMcpStatusSnapshot,
  type DaemonProviderStatusSnapshot,
  type DaemonRunEventsResponse,
  type DaemonSessionsListedResponse,
  type DaemonStatusResponse,
  type DaemonTaskSnapshot
} from "./workbench-contract";

describe("approval event normalization", () => {
  it("uses one canonical approval id for toolCallId-only and requestId-only resolved events", () => {
    const toolCallOnly = normalizeWorkbenchEvent({
      type: "approval-resolved",
      toolCallId: "approval-1",
      decision: "allow"
    });
    const requestOnly = normalizeWorkbenchEvent({
      type: "approval-resolved",
      requestId: "approval-1",
      decision: "deny"
    });

    expect(approvalIdFromEvent(toolCallOnly)).toBe("approval-1");
    expect(toolCallOnly).toMatchObject({
      approvalId: "approval-1",
      requestId: "approval-1",
      toolCallId: "approval-1",
      approvalDecision: "approved"
    });
    expect(approvalIdFromEvent(requestOnly)).toBe("approval-1");
    expect(requestOnly).toMatchObject({
      approvalId: "approval-1",
      requestId: "approval-1",
      toolCallId: "approval-1",
      approvalDecision: "denied"
    });
  });

  it("normalizes backend approval metadata as the risk source of truth", () => {
    const metadata = normalizeWorkbenchApprovalMetadata({
      risk: "destructive",
      riskRule: "dangerous-delete",
      reason: "Runtime matched destructive delete policy",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      checkpointId: "checkpoint-1",
    });

    expect(metadata).toMatchObject({
      source: "backend",
      riskLevel: "high",
      risk: "destructive",
      riskRule: "dangerous-delete",
      riskDetail: "Runtime matched destructive delete policy",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      checkpointId: "checkpoint-1",
    });
  });

  it("keeps missing or diagnostic approval metadata at unknown risk", () => {
    expect(normalizeWorkbenchApprovalMetadata({ toolName: "delete_file", input: { path: "important.txt" } })).toMatchObject({
      source: "unknown",
      riskLevel: "unknown",
    });
    expect(normalizeWorkbenchApprovalMetadata({ source: "local", risk: "destructive", riskRule: "destructive" })).toMatchObject({
      source: "unknown",
      riskLevel: "unknown",
      raw: expect.objectContaining({ source: "local", risk: "destructive" }),
    });
  });
});

describe("daemon task snapshot projection", () => {
  it("projects daemon approval snapshots into product task state", () => {
    const previous = {
      ...buildInitialTaskSnapshot("C:/repo"),
      evidence: [
        {
          id: "evidence-1",
          kind: "check" as const,
          title: "existing evidence",
          createdAt: "2026-06-08T00:00:00.000Z"
        }
      ]
    };
    const snapshot = daemonSnapshot({
      status: "awaiting-approval",
      approval: {
        toolCallId: "tool-1",
        toolName: "edit",
        input: { path: "src/app.ts" },
        summary: "edit src/app.ts",
        requestedAt: "2026-06-08T00:01:00.000Z",
        status: "pending"
      }
    });

    const projected = projectDaemonTaskSnapshotToWorkbench(snapshot, { previous });

    expect(isDaemonTaskSnapshot(snapshot)).toBe(true);
    expect(projected).toMatchObject({
      id: "run-1",
      state: "waiting",
      title: "Ship daemon snapshots",
      userGoal: "Ship daemon snapshots",
      progressLabel: "Waiting for tool approval"
    });
    expect(projected.confirmations).toEqual([
      expect.objectContaining({
        id: "tool-1",
        title: "Approve edit",
        detail: "edit src/app.ts"
      })
    ]);
    expect(projected.evidence).toHaveLength(1);
    expect(projected.backgroundTasks[0]).toMatchObject({
      id: "cmd-1",
      state: "running",
      command: "npm test"
    });
  });

  it("projects completed daemon snapshots without keeping stale active state", () => {
    const projected = projectDaemonTaskSnapshotToWorkbench(
      daemonSnapshot({
        status: "completed",
        progressLabel: ""
      }),
      { previous: buildInitialTaskSnapshot("C:/repo") }
    );

    expect(projected.state).toBe("done");
    expect(projected.completionPercent).toBe(100);
    expect(projected.confirmations).toEqual([]);
    expect(projected.plan.every((item) => item.state === "done")).toBe(true);
    expect(projected.health.summary).toBe("Completed");
  });
});

describe("daemon provider status projection", () => {
  it("projects daemon-owned provider readiness into workbench config", () => {
    const status = providerStatus({
      readiness: "insufficient-quota",
      accountCenter: {
        configured: true,
        accountId: "acct-1",
        login: "ready",
        quota: "insufficient",
        gateway: "ready",
        runtimeCredential: "unavailable",
      },
      lastDiagnostic: {
        code: "account_center_insufficient_quota",
        message: "Account-center quota is insufficient.",
        updatedAt: "2026-06-08T00:02:00.000Z",
      },
    });

    const projected = projectDaemonProviderStatusToWorkbench(status);

    expect(isDaemonProviderStatusSnapshot(status)).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("sk-");
    expect(projected).toMatchObject({
      credentialMode: "account-center",
      credentialStatus: "insufficient-quota",
      accountCenterConfigured: true,
      accountId: "acct-1",
      model: "mimo-v2.5",
      statusText: "Account-center quota is insufficient",
      lastDiagnostic: {
        code: "account_center_insufficient_quota",
      },
    });
  });
});

describe("daemon workbench status projection", () => {
  it("preserves daemon lifecycle and MCP status from status-response", () => {
    const provider = providerStatus({
      readiness: "missing",
      accountCenter: {
        configured: false,
        login: "unknown",
        quota: "unknown",
        gateway: "unknown",
        runtimeCredential: "unknown",
      },
    });
    const lifecycle = lifecycleSnapshot({
      state: "degraded",
      providerReadiness: "missing",
      mcpReadiness: "ready",
      recentError: {
        code: "provider_missing",
        message: "Provider credential is missing.",
        updatedAt: "2026-06-08T00:03:00.000Z",
        source: "provider",
        severity: "error",
      },
    });
    const mcpStatus = mcpStatusSnapshot({
      configured: true,
      readiness: "ready",
      serverCount: 1,
      summary: {
        discovering: 0,
        starting: 0,
        ready: 1,
        degraded: 0,
        reconnecting: 0,
        stopped: 0,
      },
      servers: [
        {
          name: "mcp_status",
          state: "ready",
          availableToolCount: 2,
        },
      ],
    });
    const response: DaemonStatusResponse = {
      type: "status-response",
      lifecycle,
      activeRuns: [
        {
          runId: "run-1",
          prompt: "Ship status projection",
          status: "running",
          startedAt: 1,
          cwd: "C:/repo",
        },
      ],
      pendingApprovals: [
        {
          toolCallId: "tool-1",
          runId: "run-1",
          toolName: "edit",
          summary: "edit src/app.ts",
          createdAt: 2,
        },
      ],
      providerStatus: provider,
      mcpStatus,
    };

    const projected = projectDaemonStatusToWorkbench(response);

    expect(isDaemonLifecycleSnapshot(lifecycle)).toBe(true);
    expect(isDaemonMcpStatusSnapshot(mcpStatus)).toBe(true);
    expect(projected.activeRuns).toBe(1);
    expect(projected.pendingApprovals).toBe(1);
    expect(projected.lifecycle).toBe(lifecycle);
    expect(projected.mcpStatus).toBe(mcpStatus);
    expect(projected.providerStatus).toBe(provider);
    expect(projected.providerConfig).toMatchObject({
      credentialStatus: "missing",
      readiness: "missing",
    });
  });
});

describe("daemon session query contract", () => {
  it("carries lightweight summaries and event pagination fields", () => {
    const listed: DaemonSessionsListedResponse = {
      type: "sessions-listed",
      sessions: [
        {
          id: "session-1",
          cwd: "C:/repo",
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:01:00.000Z",
          status: "open",
        },
      ],
      summaries: [
        {
          sessionId: "session-1",
          lastUpdated: "2026-06-08T00:02:00.000Z",
          eventCount: 12,
          runCount: 2,
          activeRunCount: 1,
          activeRunIds: ["run-2"],
          latestRunId: "run-2",
          latestRunStatus: "awaiting-approval",
          latestRunUpdatedAt: "2026-06-08T00:02:00.000Z",
          pendingInputCount: 1,
          pendingApprovalCount: 1,
          lastEventId: "event-12",
          lastSequence: 12,
          lastMessagePreview: "Summary preview",
        },
      ],
    };
    const runEvents: DaemonRunEventsResponse = {
      type: "run-events",
      runId: "run-1",
      events: [],
      eventLog: {
        eventLogId: "eventlog_one",
        generation: 1,
        schemaVersion: 1,
        protocolVersion: 1,
      },
      nextAfterSequence: 12,
      hasMore: true,
      nextCursor: {
        eventLogId: "eventlog_one",
        generation: 1,
        schemaVersion: 1,
        protocolVersion: 1,
        afterSequence: 12,
        lastEventId: "event-12",
      },
    };

    expect(listed.summaries?.[0]).toMatchObject({
      runCount: 2,
      activeRunCount: 1,
      activeRunIds: ["run-2"],
      latestRunStatus: "awaiting-approval",
      pendingInputCount: 1,
      pendingApprovalCount: 1,
      eventCount: 12,
      lastSequence: 12,
    });
    expect(runEvents.nextCursor?.lastEventId).toBe("event-12");
  });
});

describe("daemon run lifecycle status projection", () => {
  it("uses daemon outcome and reason for terminal run status", () => {
    expect(
      workbenchRunLifecycleStatusFromDaemon({
        type: "run-completed",
        payload: { outcome: "completed", reason: "completed" }
      })
    ).toBe("completed");
    expect(
      workbenchRunLifecycleStatusFromDaemon({
        type: "run-cancelled",
        payload: { run: { status: "cancelled", outcome: "cancelled", reason: "aborted" } }
      })
    ).toBe("cancelled");
    expect(
      workbenchRunLifecycleStatusFromDaemon({
        type: "run-failed",
        payload: { run: { status: "failed", outcome: "failed", reason: "max-turns" } }
      })
    ).toBe("failed");
    expect(
      workbenchRunLifecycleStatusFromDaemon({
        payload: { run: { status: "failed", outcome: "failed", reason: "provider-error" } }
      })
    ).toBe("failed");
    expect(
      workbenchRunLifecycleStatusFromDaemon({
        payload: { run: { status: "failed", outcome: "failed", reason: "runtime-error" } }
      })
    ).toBe("failed");
  });
});

describe("conversation rewind contract guards", () => {
  it("accepts daemon boundary preview and applied responses", () => {
    expect(
      isWorkbenchConversationRewindPreviewResult({
        type: "conversation-rewind-boundary",
        status: "ok",
        sessionId: "session-1",
        userMessageId: "user-1",
        latestUserMessage: false,
        mode: "keep-user-message",
        missingFacts: [],
        diagnostics: [],
        plan: rewindPlan(),
      })
    ).toBe(true);
    expect(
      isWorkbenchConversationRewindAppliedResponse({
        type: "conversation-rewind-applied",
        sessionId: "session-1",
        plan: rewindPlan(),
        stepResults: [{ type: "move-session-leaf", status: "applied" }],
      })
    ).toBe(true);
  });

  it("rejects malformed rewind responses before UI callers treat them as success", () => {
    expect(
      isWorkbenchConversationRewindPreviewResult({
        type: "conversation-rewind-boundary",
        status: "ok",
        sessionId: "session-1",
        latestUserMessage: false,
        mode: "keep-user-message",
        diagnostics: [],
      })
    ).toBe(false);
    expect(
      isWorkbenchConversationRewindAppliedResponse({
        type: "conversation-rewind-applied",
        sessionId: "session-1",
        plan: rewindPlan(),
      })
    ).toBe(false);
  });
});

describe("session action contract", () => {
  it("marks daemon-owned metadata actions as apply-session-action backed", () => {
    expect(WORKBENCH_SESSION_ACTIONS).toEqual([
      expect.objectContaining({
        id: "pin",
        availability: "implemented",
        effect: "metadata",
        backendCommand: "workbench_apply_session_action",
      }),
      expect.objectContaining({ id: "unpin", availability: "implemented", effect: "metadata" }),
      expect.objectContaining({ id: "rename", availability: "implemented", effect: "metadata" }),
      expect.objectContaining({ id: "archive", availability: "implemented", effect: "metadata" }),
      expect.objectContaining({ id: "unarchive", availability: "implemented", effect: "metadata" }),
      expect.objectContaining({ id: "delete", availability: "implemented", effect: "metadata" }),
      expect.objectContaining({ id: "fork", availability: "unsupported", effect: "branch" }),
      expect.objectContaining({
        id: "open-in",
        availability: "experimental",
        effect: "navigation",
        backendCommand: "workbench_apply_session_action",
      }),
      expect.objectContaining({
        id: "open-in-split-view",
        availability: "experimental",
        effect: "navigation",
        backendCommand: "workbench_apply_session_action",
      }),
      expect.objectContaining({
        id: "rewind",
        availability: "implemented",
        effect: "history-mutation",
        backendCommand: "workbench_apply_conversation_rewind",
        daemonCapability: "conversation.rewind",
      }),
      expect.objectContaining({ id: "withdraw", availability: "backend-not-wired", effect: "message-mutation" }),
    ]);

    const wiredActions = WORKBENCH_SESSION_ACTIONS.filter((action) => action.availability === "implemented");
    expect(wiredActions.map((action) => action.id)).toEqual([
      "pin",
      "unpin",
      "rename",
      "archive",
      "unarchive",
      "delete",
      "rewind",
    ]);
    expect(WORKBENCH_SESSION_ACTIONS.find((action) => action.id === "withdraw")?.backendCommand).toBeUndefined();
    expect(WORKBENCH_SESSION_ACTIONS.find((action) => action.id === "fork")?.backendCommand).toBeUndefined();
  });

  it("validates session action receipts before UI treats them as committed", () => {
    expect(
      isWorkbenchSessionActionReceipt({
        type: "session-action-receipt",
        protocolVersion: WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION,
        actionId: "action-1",
        kind: "rename",
        sessionId: "session-1",
        status: "committed",
        committedAt: "2026-06-08T00:00:00.000Z",
      })
    ).toBe(true);
    expect(
      isWorkbenchSessionActionReceipt({
        type: "session-action-receipt",
        protocolVersion: WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION,
        actionId: "action-1",
        kind: "fork",
        sessionId: "session-1",
        status: "rejected",
      })
    ).toBe(false);
  });
});

function rewindPlan() {
  const targetPath = [
    {
      type: "node" as const,
      id: "leaf-target",
      parentId: null,
      createdAt: "2026-06-08T00:00:00.000Z",
      payload: {
        source: "runtime-session",
        entryType: "message",
        messageId: "user-1",
        role: "user",
        blockTypes: ["text"],
        summary: "target",
      },
    },
  ];
  return {
    sessionId: "session-1",
    fromLeafId: "leaf-current",
    targetLeafId: "leaf-target",
    targetPath,
    entryProjection: {
      currentPath: targetPath,
      targetPath,
      retainedEntryIds: ["leaf-target"],
      hiddenEntryIds: [],
      hiddenCurrentPathEntryIds: [],
      hiddenBranchEntryIds: [],
    },
    runCancellations: [],
    approvalClearances: [],
    workspaceRestore: {
      required: false,
      source: "none" as const,
      cleanUntracked: false,
    },
    steps: [
      {
        type: "move-session-leaf" as const,
        sessionId: "session-1",
        fromLeafId: "leaf-current",
        toLeafId: "leaf-target",
      },
    ],
  };
}

function daemonSnapshot(overrides: Partial<DaemonTaskSnapshot> = {}): DaemonTaskSnapshot {
  const now = "2026-06-08T00:01:00.000Z";
  return {
    runId: "run-1",
    sessionId: "session-1",
    status: "running",
    title: "Ship daemon snapshots",
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "Working on daemon snapshots",
        createdAt: now
      }
    ],
    pendingToolCalls: [],
    backgroundTasks: [
      {
        id: "cmd-1",
        kind: "command",
        title: "npm test",
        state: "running",
        command: "npm test",
        cwd: "C:/repo",
        startedAt: now,
        updatedAt: now,
        outputPreview: "running"
      }
    ],
    updatedAt: now,
    progressLabel: "Waiting for tool approval",
    currentRun: {
      id: "run-1",
      sessionId: "session-1",
      cwd: "C:/repo",
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: now,
      startedAt: "2026-06-08T00:00:01.000Z",
      metadata: {
        prompt: "Ship daemon snapshots",
        mode: "execute"
      }
    },
    ...overrides
  };
}

function providerStatus(overrides: Partial<DaemonProviderStatusSnapshot> = {}): DaemonProviderStatusSnapshot {
  return {
    credentialMode: "account-center",
    readiness: "ready",
    providerId: "crish",
    routeId: "default:crish:mimo-v2.5",
    baseUrl: "https://gateway.example/v1",
    model: "mimo-v2.5",
    upstreamModel: "mimo-v2.5",
    endpoint: "auto",
    stream: true,
    systemPromptWireMode: "user-prefix",
    apiKey: { hasApiKey: false, source: "unset" },
    hasDirectApiKey: false,
    apiKeySource: "unset",
    accountCenter: {
      configured: true,
      login: "ready",
      quota: "ready",
      gateway: "ready",
      runtimeCredential: "ready",
    },
    gateway: {
      ready: true,
      credentialConfigured: true,
      routeDecision: ["selected_route"],
    },
    updatedAt: "2026-06-08T00:01:00.000Z",
    ...overrides,
  };
}

function lifecycleSnapshot(overrides: Partial<DaemonLifecycleSnapshot> = {}): DaemonLifecycleSnapshot {
  return {
    state: "ready",
    startedAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:01:00.000Z",
    readyAt: "2026-06-08T00:00:01.000Z",
    uptimeMs: 60000,
    currentPort: 4317,
    connectedClientCount: 1,
    totalClientConnectionCount: 1,
    totalClientDisconnectCount: 0,
    activeRunCount: 0,
    eventStore: {
      status: "ok",
      path: "C:/repo/.conex/events.jsonl",
    },
    providerReadiness: "ready",
    mcpReadiness: "unknown",
    ...overrides,
  };
}

function mcpStatusSnapshot(overrides: Partial<DaemonMcpStatusSnapshot> = {}): DaemonMcpStatusSnapshot {
  return {
    configured: false,
    readiness: "unknown",
    serverCount: 0,
    summary: {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 0,
      reconnecting: 0,
      stopped: 0,
    },
    diagnostics: [],
    servers: [],
    updatedAt: "2026-06-08T00:01:00.000Z",
    ...overrides,
  };
}
