import { describe, expect, it } from "vitest";
import { buildDaemonCapabilitySnapshot } from "./capabilities";
import {
  DAEMON_INBOUND_MESSAGE_REGISTRY,
  DAEMON_OUTBOUND_MESSAGE_REGISTRY,
} from "./protocol/registry";
import type {
  DaemonLifecycleSnapshot,
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
} from "./types";

describe("daemon capability snapshot", () => {
  it("marks unsupported runtime reflection APIs explicitly", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: false }),
      productAdapters: {
        artifacts: productStatus("artifacts", "unsupported"),
        memory: productStatus("memory", "unsupported"),
        checkpoints: productStatus("checkpoints", "unsupported"),
      },
      lifecycle: lifecycle(),
      now: new Date(timestamp()),
    });

    expect(capability(snapshot, "artifacts")).toMatchObject({
      state: "unsupported",
      owner: "agent-runtime",
      relatedMessageTypes: expect.arrayContaining(["list-artifacts", "artifact-content"]),
    });
    expect(capability(snapshot, "memory")).toMatchObject({ state: "unsupported" });
    expect(capability(snapshot, "checkpoints")).toMatchObject({ state: "unsupported" });
  });

  it("does not promote product capabilities when related protocol messages are unsupported", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: false }),
      productAdapters: {
        artifacts: productStatus("artifacts", "experimental", ["list", "content"]),
        memory: productStatus("memory", "unsupported"),
        checkpoints: productStatus("checkpoints", "unsupported"),
      },
      lifecycle: lifecycle(),
      now: new Date(timestamp()),
    });

    // artifacts 的 product adapter 报告 experimental，但 registry 中相关消息类型是 unsupported，
    // 所以 capability 不应被提升
    expect(capability(snapshot, "artifacts")).toMatchObject({
      state: "unsupported",
    });
    expect(capability(snapshot, "artifacts").diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CAPABILITY_REGISTRY_MISMATCH" }),
      ])
    );
  });

  it("exposes requirements alignment through the plan document capability", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: false }),
      lifecycle: lifecycle(),
      now: new Date(timestamp()),
    });

    expect(capability(snapshot, "plan-document")).toMatchObject({
      state: "implemented",
      owner: "agent-daemon",
      relatedMessageTypes: expect.arrayContaining([
        "create-plan-document",
        "create-requirements-alignment-plan",
        "patch-plan-document",
      ]),
    });
  });

  it("reports session metadata actions as partially implemented", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: false }),
      lifecycle: lifecycle(),
      now: new Date(timestamp()),
    });

    expect(capability(snapshot, "session.actions")).toMatchObject({
      state: "experimental",
      owner: "agent-daemon",
      reason: expect.stringContaining("soft delete"),
    });
    expect(capability(snapshot, "session.actions").reason).toContain("fork remains unsupported");
  });

  it("degrades run execution when provider readiness is not ready", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("missing"),
      mcpStatus: mcpStatus({ configured: false }),
      lifecycle: lifecycle(),
      now: new Date(timestamp()),
    });

    expect(capability(snapshot, "run.execution")).toMatchObject({
      state: "degraded",
      diagnostics: [
        expect.objectContaining({
          code: "PROVIDER_NOT_READY",
          severity: "warning",
        }),
      ],
    });
  });

  it("marks MCP unsupported when unconfigured and degraded when runtime reports failures", () => {
    const unconfigured = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: false }),
      now: new Date(timestamp()),
    });
    expect(capability(unconfigured, "mcp.lifecycle")).toMatchObject({
      state: "unsupported",
    });

    const degraded = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: true, readiness: "degraded" }),
      now: new Date(timestamp()),
    });
    expect(capability(degraded, "mcp.lifecycle")).toMatchObject({
      state: "degraded",
      diagnostics: [expect.objectContaining({ code: "MCP_DEGRADED" })],
    });
  });

  it("only references message types registered by the daemon protocol", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: true, readiness: "ready" }),
      lifecycle: lifecycle(),
      now: new Date(timestamp()),
    });
    const registeredMessageTypes = new Set([
      ...Object.keys(DAEMON_INBOUND_MESSAGE_REGISTRY),
      ...Object.keys(DAEMON_OUTBOUND_MESSAGE_REGISTRY),
    ]);

    for (const item of snapshot.capabilities) {
      for (const type of item.relatedMessageTypes) {
        expect(registeredMessageTypes.has(type), `${item.id} references ${type}`).toBe(true);
      }
    }
  });

  it("does not mark a capability available when its related protocol messages are unsupported", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: true, readiness: "ready" }),
      productAdapters: {
        artifacts: productStatus("artifacts", "experimental"),
        memory: productStatus("memory", "experimental"),
        checkpoints: productStatus("checkpoints", "experimental"),
      },
      lifecycle: lifecycle(),
      now: new Date(timestamp()),
    });
    const protocolRegistry = new Map([
      ...Object.entries(DAEMON_INBOUND_MESSAGE_REGISTRY),
      ...Object.entries(DAEMON_OUTBOUND_MESSAGE_REGISTRY),
    ]);

    for (const item of snapshot.capabilities.filter((capability) =>
      capability.state === "implemented" || capability.state === "experimental"
    )) {
      for (const type of item.relatedMessageTypes) {
        expect(protocolRegistry.get(type)?.state, `${item.id} references ${type}`).not.toBe("unsupported");
        expect(protocolRegistry.get(type)?.state, `${item.id} references ${type}`).not.toBe("backend-not-wired");
      }
    }
  });
});

function capability(snapshot: ReturnType<typeof buildDaemonCapabilitySnapshot>, id: string) {
  const record = snapshot.capabilities.find((item) => item.id === id);
  if (!record) throw new Error(`Missing capability ${id}`);
  return record;
}

function timestamp(): string {
  return "2026-06-08T00:00:00.000Z";
}

function providerStatus(readiness: DaemonProviderStatusSnapshot["readiness"]): DaemonProviderStatusSnapshot {
  return {
    credentialMode: "auto",
    readiness,
    providerId: "provider_a",
    routeId: "route_a",
    baseUrl: "https://gateway.example/v1",
    model: "model_a",
    upstreamModel: "model_a",
    endpoint: "auto",
    stream: true,
    systemPromptWireMode: "user-prefix",
    apiKey: { hasApiKey: false, source: "unset" },
    hasDirectApiKey: false,
    apiKeySource: "unset",
    gateway: {
      ready: readiness === "ready",
      credentialConfigured: readiness === "ready",
      routeDecision: ["route_a"],
    },
    updatedAt: timestamp(),
  };
}

function mcpStatus(input: {
  configured: boolean;
  readiness?: DaemonMcpStatusSnapshot["readiness"];
}): DaemonMcpStatusSnapshot {
  return {
    configured: input.configured,
    readiness: input.readiness ?? "unknown",
    serverCount: input.configured ? 1 : 0,
    summary: {},
    diagnostics: [],
    servers: [],
    updatedAt: timestamp(),
  };
}

function productStatus(
  surface: "artifacts" | "memory" | "checkpoints",
  state: "implemented" | "experimental" | "unsupported" | "degraded",
  operations: string[] = []
) {
  return {
    surface,
    state,
    reason: `${surface} adapter state`,
    operations,
    diagnostics: [
      {
        code: `${surface.toUpperCase()}_ADAPTER_STATE`,
        message: `${surface} adapter state`,
        severity: "info" as const,
        updatedAt: timestamp(),
      },
    ],
  };
}

function lifecycle(): DaemonLifecycleSnapshot {
  return {
    state: "ready",
    startedAt: timestamp(),
    updatedAt: timestamp(),
    readyAt: timestamp(),
    uptimeMs: 1_000,
    currentPort: 12345,
    connectedClientCount: 1,
    totalClientConnectionCount: 1,
    totalClientDisconnectCount: 0,
    activeRunCount: 0,
    eventStore: { status: "ok", path: "C:/Software/conex/events.jsonl" },
    providerReadiness: "ready",
    mcpReadiness: "unknown",
  };
}
