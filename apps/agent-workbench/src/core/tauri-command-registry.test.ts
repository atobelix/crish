import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_NOT_WIRED_CODE,
  BACKEND_NOT_WIRED_COMMAND_ALLOWLIST,
  DAEMON_DISCONNECTED_CODE,
  PROTOCOL_ERROR_CODE,
  REGISTERED_TAURI_COMMANDS,
  TAURI_COMMAND_REGISTRY,
  UNSUPPORTED_CODE,
  commandCapabilityStatus,
  diffTauriCommandRegistry,
  extractInvokedTauriCommands,
  extractRegisteredTauriCommands,
  getBridgeViewStatus,
  isProductCapabilityCommand,
  isBackendDiagnosticResult,
  isBackendNotWiredError,
  isBackendNotWiredResult,
  shouldHaveReleaseTauriRegistration,
} from "./tauri-command-registry";
import { buildDaemonCapabilitySnapshot } from "../../../../packages/agent-daemon/src/capabilities";
import { DAEMON_INBOUND_MESSAGE_REGISTRY } from "../../../../packages/agent-daemon/src/protocol/registry";
import type {
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
} from "../../../../packages/agent-daemon/src/types";

const bridgePath = fileURLToPath(new URL("./tauri-bridge.ts", import.meta.url));
const rustMainPath = fileURLToPath(new URL("../../src-tauri/src/main.rs", import.meta.url));
const rootPackagePath = fileURLToPath(new URL("../../../../package.json", import.meta.url));

describe("Tauri command registry", () => {
  it("extracts static invoke command names from the bridge", () => {
    const source = `
      await invoke("plain_command");
      await invoke<Result>("typed_command", { ok: true });
      await notInvoke("ignored_command");
      await invoke(dynamicCommand);
    `;

    expect(extractInvokedTauriCommands(source)).toEqual(["plain_command", "typed_command"]);
  });

  it("extracts registered command names from tauri generate_handler", () => {
    const source = `
      tauri::Builder::default().invoke_handler(tauri::generate_handler![
        sidecar::workbench_status,
        config::save_api_config,
      ]);
    `;

    expect(extractRegisteredTauriCommands(source)).toEqual(["save_api_config", "workbench_status"]);
  });

  it("keeps bridge invokes registered or explicitly allowlisted", () => {
    const diff = diffTauriCommandRegistry(
      readFileSync(bridgePath, "utf8"),
      readFileSync(rustMainPath, "utf8")
    );

    expect(diff.missingFrontendRegistry).toEqual([]);
    expect(diff.missingRustRegistration).toEqual([]);
    expect(diff.missing).toEqual([]);
    expect(diff.staleAllowlist).toEqual([]);
    expect(diff.allowedUnwired.map((item) => item.command)).toEqual(
      Object.keys(BACKEND_NOT_WIRED_COMMAND_ALLOWLIST).sort()
    );
    expect(diff.allowedUnwired.every((item) => item.reason.length > 20)).toBe(true);
  });

  it("passes a product command marked implemented when it is present in generate_handler", () => {
    const diff = diffTauriCommandRegistry(
      `await invoke("workbench_status");`,
      readFileSync(rustMainPath, "utf8")
    );

    expect(diff.invoked).toEqual(["workbench_status"]);
    expect(diff.frontendRegistered).toContain("workbench_status");
    expect(diff.frontendProductCommands).toContain("workbench_status");
    expect(diff.frontendWiredCommands).toContain("workbench_status");
    expect(diff.missingFrontendRegistry).toEqual([]);
    expect(diff.missingRustRegistration).toEqual([]);
    expect(diff.missing).toEqual([]);
  });

  it("lists bridge invokes that are missing from the frontend command registry", () => {
    const diff = diffTauriCommandRegistry(
      `
        await invoke("workbench_status");
        await invoke("workbench_missing_command");
      `,
      readFileSync(rustMainPath, "utf8")
    );

    expect(diff.missingFrontendRegistry).toEqual(["workbench_missing_command"]);
    expect(diff.missing).toContain("workbench_missing_command");
  });

  it("keeps the frontend command registry unique", () => {
    const commands = REGISTERED_TAURI_COMMANDS.map((entry) => entry.command);
    expect(commands).toEqual([...new Set(commands)]);
  });

  it("keeps legacy CLI commands isolated behind developer diagnostics names", () => {
    const commands = new Set(REGISTERED_TAURI_COMMANDS.map((entry) => entry.command));
    const legacyProductCommands = [
      "workbench_task_snapshot",
      "workbench_bootstrap",
      "workbench_background_demo",
      "workbench_run_task",
      "workbench_run_goal",
      "workbench_cli_probe",
      "workbench_continuation",
    ];

    for (const command of legacyProductCommands.filter((command) => command !== "workbench_continuation")) {
      expect(commands.has(command)).toBe(false);
    }

    const devCliEntries = REGISTERED_TAURI_COMMANDS.filter((entry) => entry.command.startsWith("workbench_dev_cli_"));
    expect(devCliEntries.map((entry) => entry.command).sort()).toEqual([
      "workbench_dev_cli_background_demo",
      "workbench_dev_cli_bootstrap",
      "workbench_dev_cli_continuation",
      "workbench_dev_cli_probe",
      "workbench_dev_cli_run_goal",
      "workbench_dev_cli_run_task",
      "workbench_dev_cli_task_snapshot",
    ]);
    expect(devCliEntries.every((entry) => entry.surface === "developer-diagnostics")).toBe(true);
    expect(devCliEntries.every((entry) => entry.tauriRegistration === "debug-only")).toBe(true);
    expect(devCliEntries.some(isProductCapabilityCommand)).toBe(false);
    expect(devCliEntries.some(shouldHaveReleaseTauriRegistration)).toBe(false);
  });

  it("does not register legacy CLI continuation as a product command", () => {
    const entry = REGISTERED_TAURI_COMMANDS.find((item) => item.command === "workbench_continuation");

    expect(entry).toMatchObject({
      status: "unsupported",
      capabilityStatus: UNSUPPORTED_CODE,
      tauriRegistration: "not-registered",
    });
  });

  it("keeps external opener discovery on a host command instead of session action targets", () => {
    const openerEntry = REGISTERED_TAURI_COMMANDS.find((item) => item.command === "workbench_list_host_openers");
    const openEntry = REGISTERED_TAURI_COMMANDS.find((item) => item.command === "workbench_open_host_target");
    const rustMain = readFileSync(rustMainPath, "utf8");

    expect(openerEntry).toMatchObject({
      status: "implemented",
      feature: "host external opener discovery",
    });
    expect(openEntry).toMatchObject({
      status: "implemented",
      feature: "host external opener launch",
    });
    expect(rustMain).toContain("host_openers::workbench_list_host_openers");
    expect(rustMain).toContain("host_openers::workbench_open_host_target");
  });

  it("keeps product Tauri run commands on the sidecar path instead of cli_bridge", () => {
    const rustMain = readFileSync(rustMainPath, "utf8");

    for (const command of ["workbench_run_task_stream", "workbench_run_goal_stream", "workbench_get_run_snapshot"]) {
      expect(rustMain).toContain(`sidecar::${command}`);
      expect(rustMain).not.toContain(`cli_bridge::${command}`);
    }

    expect(rustMain).not.toContain("cli_bridge::workbench_continuation");
    expect(rustMain).toContain("cli_bridge::workbench_dev_cli_continuation");
    expect(normalizeLineEndings(rustMain)).toContain("#[cfg(debug_assertions)]\nmod cli_bridge;");
  });

  it("keeps legacy CLI diagnostics out of the release Tauri command surface", () => {
    const rustMain = readFileSync(rustMainPath, "utf8");
    const releaseRegistered = extractRegisteredTauriCommands(readReleaseGenerateHandlerSource(rustMain));
    const debugRegistered = extractRegisteredTauriCommands(rustMain);
    const devCliCommands = REGISTERED_TAURI_COMMANDS
      .filter((entry) => entry.surface === "developer-diagnostics")
      .map((entry) => entry.command)
      .sort();
    const releaseRequired = REGISTERED_TAURI_COMMANDS.filter(shouldHaveReleaseTauriRegistration)
      .map((entry) => entry.command)
      .sort();

    expect(debugRegistered).toEqual(expect.arrayContaining(devCliCommands));
    expect(releaseRegistered).not.toEqual(expect.arrayContaining(devCliCommands));
    for (const command of devCliCommands) {
      expect(releaseRegistered).not.toContain(command);
    }
    expect(releaseRegistered).toEqual(expect.arrayContaining(releaseRequired));
    expect(releaseRegistered).toEqual(expect.arrayContaining([
      "workbench_run_task_stream",
      "workbench_run_goal_stream",
      "workbench_get_run_snapshot",
    ]));
  });

  it("keeps root package scripts focused on product workbench and daemon paths", () => {
    const pkg = JSON.parse(readFileSync(rootPackagePath, "utf8")) as {
      workspaces: string[];
      scripts: Record<string, string>;
    };
    const scriptText = Object.values(pkg.scripts).join("\n");

    expect(pkg.workspaces).toContain("apps/agent-workbench");
    expect(pkg.workspaces).toContain("packages/agent-daemon");
    expect(pkg.workspaces).toContain("packages/agent-orchestrator");
    expect(pkg.workspaces).toContain("packages/agent-runtime");
    expect(pkg.workspaces).not.toContain("apps/web-ui");
    expect(scriptText).not.toContain("apps/web-ui");
    expect(scriptText).not.toContain("@crish/web-ui");
    expect(pkg.scripts["dev:cli"]).toBe("npm --workspace @crish/agent-workbench run cli");
    expect(pkg.scripts.cli).toBe("npm run dev:cli");
    expect(pkg.scripts["build:product"]).toBe("npm run build:daemon && npm run build:workbench");
  });

  it("marks conversation rewind bridge commands as implemented product commands", () => {
    const entries = REGISTERED_TAURI_COMMANDS.filter((entry) =>
      entry.command === "workbench_preview_conversation_rewind" ||
      entry.command === "workbench_apply_conversation_rewind"
    );

    expect(entries).toEqual([
      expect.objectContaining({
        command: "workbench_preview_conversation_rewind",
        status: "implemented",
        feature: "conversation rewind preview",
      }),
      expect.objectContaining({
        command: "workbench_apply_conversation_rewind",
        status: "implemented",
        feature: "conversation rewind apply",
      }),
    ]);
    expect(entries.every((entry) => entry.surface === undefined)).toBe(true);
  });

  it("does not expose unsupported or backend-not-wired entries as fully wired product capabilities", () => {
    const productCommands = REGISTERED_TAURI_COMMANDS.filter(isProductCapabilityCommand);

    expect(productCommands.every((entry) => commandCapabilityStatus(entry) !== UNSUPPORTED_CODE)).toBe(true);
    expect(productCommands.every((entry) => commandCapabilityStatus(entry) !== BACKEND_NOT_WIRED_CODE)).toBe(true);
    expect(productCommands.map((entry) => entry.command)).not.toContain("workbench_send_to_subagent");
    expect(productCommands.map((entry) => entry.command)).not.toContain("workbench_get_subagent_status");
    expect(commandCapabilityStatus(TAURI_COMMAND_REGISTRY.get("workbench_list_background_tasks")!)).toBe("experimental");
    expect(commandCapabilityStatus(TAURI_COMMAND_REGISTRY.get("workbench_cancel_background_task")!)).toBe("experimental");
    expect(commandCapabilityStatus(TAURI_COMMAND_REGISTRY.get("workbench_get_background_task_output")!)).toBe("experimental");
  });

  it("keeps daemon-default unsupported capabilities out of ordinary product command exposure", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: false }),
      now: new Date(timestamp()),
    });
    const unsupportedDaemonCapabilities = new Map(
      snapshot.capabilities
        .filter((capability) => capability.state === UNSUPPORTED_CODE)
        .map((capability) => [capability.id, capability])
    );
    const productCommands = REGISTERED_TAURI_COMMANDS.filter(isProductCapabilityCommand).map((entry) => entry.command);

    expect(unsupportedDaemonCapabilities.get("artifacts")?.relatedTauriCommands).toEqual(
      expect.arrayContaining(["workbench_list_artifacts", "workbench_get_artifact_content"])
    );
    expect(unsupportedDaemonCapabilities.get("checkpoints")?.relatedTauriCommands).toEqual(
      expect.arrayContaining(["workbench_restore_checkpoint"])
    );
    expect(productCommands).not.toContain("workbench_list_artifacts");
    expect(productCommands).not.toContain("workbench_get_artifact_content");
    expect(productCommands).not.toContain("workbench_restore_checkpoint");
  });

  it("keeps daemon capability Tauri command references aligned with the Workbench registry", () => {
    const snapshot = buildDaemonCapabilitySnapshot({
      providerStatus: providerStatus("ready"),
      mcpStatus: mcpStatus({ configured: true, readiness: "ready" }),
      now: new Date(timestamp()),
    });

    for (const capability of snapshot.capabilities) {
      for (const command of capability.relatedTauriCommands) {
        const entry = TAURI_COMMAND_REGISTRY.get(command);
        expect(entry, `${capability.id} references ${command}`).toBeDefined();

        if (capability.state === "implemented" || capability.state === "experimental") {
          expect(commandCapabilityStatus(entry!), `${capability.id} references ${command}`).not.toBe(UNSUPPORTED_CODE);
          expect(commandCapabilityStatus(entry!), `${capability.id} references ${command}`).not.toBe(BACKEND_NOT_WIRED_CODE);
        }
      }
    }
  });

  it("keeps daemon-unsupported subagent commands out of product capabilities while checking their Tauri handlers", () => {
    expect(DAEMON_INBOUND_MESSAGE_REGISTRY["send-to-subagent"].state).toBe("unsupported");
    expect(DAEMON_INBOUND_MESSAGE_REGISTRY["get-subagent-status"].state).toBe("unsupported");

    const diff = diffTauriCommandRegistry(
      `
        await invoke("workbench_send_to_subagent");
        await invoke("workbench_get_subagent_status");
      `,
      readFileSync(rustMainPath, "utf8")
    );

    expect(diff.frontendProductCommands).not.toContain("workbench_send_to_subagent");
    expect(diff.frontendProductCommands).not.toContain("workbench_get_subagent_status");
    expect(diff.frontendWiredCommands).toContain("workbench_send_to_subagent");
    expect(diff.frontendWiredCommands).toContain("workbench_get_subagent_status");
    expect(diff.missingFrontendRegistry).toEqual([]);
    expect(diff.missingRustRegistration).toEqual([]);
    expect(diff.missing).toEqual([]);

    const subagentEntries = REGISTERED_TAURI_COMMANDS.filter((entry) => entry.surface === "subagent-control");
    expect(subagentEntries).toEqual([
      expect.objectContaining({
        command: "workbench_get_subagent_status",
        status: UNSUPPORTED_CODE,
        capabilityStatus: UNSUPPORTED_CODE,
      }),
      expect.objectContaining({
        command: "workbench_send_to_subagent",
        status: UNSUPPORTED_CODE,
        capabilityStatus: UNSUPPORTED_CODE,
      }),
    ]);
  });
});

describe("TauriBridge backend-not-wired behavior", () => {
  const invoke = vi.fn();
  const originalWindow = globalThis.window;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: vi.fn(async () => vi.fn()),
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
    });
    console.warn = vi.fn();
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/api/core");
    vi.doUnmock("@tauri-apps/api/event");
    vi.restoreAllMocks();
    console.warn = originalWarn;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("invokes the daemon-backed background task list command", async () => {
    const { TauriBridge, getBackendNotWiredDiagnostics, clearBackendNotWiredDiagnosticsForTest } =
      await import("./tauri-bridge");
    clearBackendNotWiredDiagnosticsForTest();
    const tasks = [
      {
        id: "task-1",
        kind: "command",
        title: "npm test",
        state: "running",
        command: "npm test",
        updatedAt: timestamp(),
      },
    ];
    invoke.mockResolvedValueOnce(tasks);

    const bridge = new TauriBridge();
    const result = await bridge.listBackgroundTasks();

    expect(result).toEqual(tasks);
    expect(getBackendNotWiredDiagnostics()).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("workbench_list_background_tasks");
  });

  it("invokes the daemon-backed background task output preview command", async () => {
    const { TauriBridge, getBackendNotWiredDiagnostics, clearBackendNotWiredDiagnosticsForTest } =
      await import("./tauri-bridge");
    clearBackendNotWiredDiagnosticsForTest();
    invoke.mockResolvedValueOnce("latest output preview");

    const bridge = new TauriBridge();
    const result = await bridge.getBackgroundTaskOutput("task-1");

    expect(result).toBe("latest output preview");
    expect(getBackendNotWiredDiagnostics()).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("workbench_get_background_task_output", { taskId: "task-1" });
  });

  it("invokes the daemon-backed background task cancellation command", async () => {
    const { TauriBridge, getBackendNotWiredDiagnostics, clearBackendNotWiredDiagnosticsForTest } =
      await import("./tauri-bridge");
    clearBackendNotWiredDiagnosticsForTest();
    invoke.mockResolvedValueOnce({ id: "task-1", state: "cancelled" });

    const bridge = new TauriBridge();
    await bridge.cancelBackgroundTask("task-1");

    expect(getBackendNotWiredDiagnostics()).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("workbench_cancel_background_task", { taskId: "task-1" });
  });

  it("returns daemon-disconnected diagnostics instead of empty artifact data", async () => {
    const { TauriBridge, getBackendDiagnostics, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockRejectedValueOnce("Sidecar not connected");

    const bridge = new TauriBridge();
    const result = await bridge.listArtifacts("session-1");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
    expect(isBackendDiagnosticResult(result)).toBe(true);
    expect(isBackendNotWiredResult(result)).toBe(false);
    if (!isBackendDiagnosticResult(result)) {
      throw new Error("expected backend diagnostic result");
    }
    expect(result.diagnostic).toMatchObject({
      code: DAEMON_DISCONNECTED_CODE,
      command: "workbench_list_artifacts",
    });
    expect(getBackendDiagnostics().map((item) => [item.code, item.command])).toEqual([
      [DAEMON_DISCONNECTED_CODE, "workbench_list_artifacts"],
    ]);
  });

  it("returns protocol-error diagnostics instead of empty MCP data", async () => {
    const { TauriBridge, getBackendDiagnostics, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockResolvedValueOnce({ servers: [] });

    const bridge = new TauriBridge();
    const result = await bridge.listMcpServers();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
    expect(isBackendDiagnosticResult(result)).toBe(true);
    if (!isBackendDiagnosticResult(result)) {
      throw new Error("expected backend diagnostic result");
    }
    expect(result.diagnostic).toMatchObject({
      code: PROTOCOL_ERROR_CODE,
      command: "workbench_list_mcp_servers",
    });
    expect(getBackendDiagnostics().map((item) => [item.code, item.command])).toEqual([
      [PROTOCOL_ERROR_CODE, "workbench_list_mcp_servers"],
    ]);
  });

  it("returns unsupported diagnostics for backend commands that are not registered", async () => {
    const { TauriBridge, getBackendViewStatus, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockRejectedValueOnce("unknown command workbench_list_artifacts");

    const bridge = new TauriBridge();
    const result = await bridge.listArtifacts("session-1");

    expect(Array.isArray(result)).toBe(true);
    expect(isBackendDiagnosticResult(result)).toBe(true);
    expect(getBridgeViewStatus(result).status).toBe(UNSUPPORTED_CODE);
    expect(getBackendViewStatus("workbench_list_artifacts")).toMatchObject({
      status: UNSUPPORTED_CODE,
      ok: false,
      empty: false,
    });
  });

  it("returns unsupported diagnostics for product continuation instead of invoking legacy CLI", async () => {
    const { TauriBridge, getBackendViewStatus, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();

    const bridge = new TauriBridge();
    const result = await bridge.continuation("run-1", { action: "continue", reason: "user requested" });

    expect(isBackendDiagnosticResult(result)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: UNSUPPORTED_CODE,
        command: "workbench_continuation",
      },
    });
    expect(getBackendViewStatus("workbench_continuation")).toMatchObject({
      status: UNSUPPORTED_CODE,
      ok: false,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("records daemon errors separately from real empty checkpoint data", async () => {
    const { TauriBridge, getBackendViewStatus, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockRejectedValueOnce("Sidecar disconnected");

    const bridge = new TauriBridge();
    const failed = await bridge.listCheckpoints("session-1");

    expect(isBackendDiagnosticResult(failed)).toBe(true);
    expect(getBackendViewStatus("workbench_list_checkpoints")).toMatchObject({
      status: DAEMON_DISCONNECTED_CODE,
      ok: false,
    });

    clearBackendDiagnosticsForTest();
    invoke.mockResolvedValueOnce([]);
    const empty = await bridge.listCheckpoints("session-1");

    expect(empty).toEqual([]);
    expect(isBackendDiagnosticResult(empty)).toBe(false);
    expect(getBackendViewStatus("workbench_list_checkpoints")).toMatchObject({
      status: "empty",
      ok: true,
      empty: true,
    });
  });

  it("does not report diagnostics for registered commands that return real empty lists", async () => {
    const { TauriBridge, getBackendDiagnostics, getBackendViewStatus, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockResolvedValueOnce([]);

    const bridge = new TauriBridge();
    const result = await bridge.listArtifacts("session-1");

    expect(result).toEqual([]);
    expect(isBackendDiagnosticResult(result)).toBe(false);
    expect(isBackendNotWiredResult(result)).toBe(false);
    expect(getBackendDiagnostics()).toEqual([]);
    expect(getBackendViewStatus("workbench_list_artifacts")).toMatchObject({
      status: "empty",
      ok: true,
      empty: true,
    });
  });

  it("calls registered plan document commands and returns typed payloads", async () => {
    const { TauriBridge, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke
      .mockResolvedValueOnce({
        type: "plan-documents-listed",
        documents: [
          {
            id: "plan_1",
            title: "Backend plan",
            goal: "Wire bridge commands",
            status: "ready",
            version: 1,
            createdAt: "2026-06-08T00:00:00.000Z",
            updatedAt: "2026-06-08T00:00:00.000Z",
            steps: { total: 0, byStatus: {}, next: [], blocked: [] },
            questions: { total: 0, byStatus: {}, open: [] },
            assumptions: { total: 0, byStatus: {}, unresolved: [] },
            acceptance: { total: 0, byStatus: {} },
            risks: { total: 0, bySeverity: {}, byStatus: {}, open: [] },
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "plan-document-created",
        document: {
          id: "alignment_1",
          title: "Requirements alignment",
          goal: "Align requirements",
          assumptions: [],
          questions: [],
          steps: [],
          acceptance: [],
          risks: [],
          status: "aligning",
          version: 1,
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-08T00:00:00.000Z",
          metadata: { mode: "requirements-alignment" },
        },
      });

    const bridge = new TauriBridge();
    const listed = await bridge.listPlanDocuments();
    const created = await bridge.createRequirementsAlignmentPlan({
      goal: "Align requirements",
      questions: ["What is in scope?"],
      source: "slash-command",
    });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "plan_1", status: "ready" });
    expect(created).toMatchObject({
      id: "alignment_1",
      status: "aligning",
      metadata: { mode: "requirements-alignment" },
    });
    expect(invoke).toHaveBeenNthCalledWith(1, "workbench_list_plan_documents");
    expect(invoke).toHaveBeenNthCalledWith(2, "workbench_create_requirements_alignment_plan", {
      request: {
        goal: "Align requirements",
        questions: ["What is in scope?"],
        source: "slash-command",
      },
    });
  });

  it("calls daemon-backed conversation rewind commands with boundary and explicit targets", async () => {
    const { TauriBridge, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke
      .mockResolvedValueOnce({
        type: "conversation-rewind-boundary",
        status: "ok",
        sessionId: "session-1",
        userMessageId: "user-1",
        latestUserMessage: false,
        mode: "remove-user-message",
        missingFacts: [],
        diagnostics: [],
        plan: rewindPlan(),
      })
      .mockResolvedValueOnce({
        type: "conversation-rewind-applied",
        sessionId: "session-1",
        plan: rewindPlan(),
        stepResults: [
          {
            type: "move-session-leaf",
            status: "applied",
            code: "session-leaf-moved",
            affectedIds: ["leaf-target"],
          },
        ],
      });

    const bridge = new TauriBridge();
    const preview = await bridge.previewConversationRewind({
      sessionId: "session-1",
      runId: "run-1",
      userMessageId: "user-1",
      retainTargetUserMessage: false,
      restorePolicy: "required",
      dryRun: true,
      force: true,
    });
    const applied = await bridge.applyConversationRewind({
      sessionId: "session-1",
      targetLeafId: "leaf-target",
      entries: rewindPlan().targetPath,
      activeSubagents: [{ parentRunId: "run-1", subagentRunId: "subrun-1" }],
    });

    expect(preview).toMatchObject({
      type: "conversation-rewind-boundary",
      mode: "remove-user-message",
      plan: { targetLeafId: "leaf-target" },
    });
    expect(applied).toMatchObject({
      type: "conversation-rewind-applied",
      stepResults: [{ type: "move-session-leaf", status: "applied" }],
    });
    expect(invoke).toHaveBeenNthCalledWith(1, "workbench_preview_conversation_rewind", {
      request: {
        sessionId: "session-1",
        userMessageId: "user-1",
        mode: "remove-user-message",
        restorePolicy: "required",
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "workbench_apply_conversation_rewind", {
      request: {
        sessionId: "session-1",
        targetLeafId: "leaf-target",
        entries: rewindPlan().targetPath,
        activeSubagents: [{ parentRunId: "run-1", subagentRunId: "subrun-1" }],
      },
    });
  });

  it("calls daemon-backed session actions and validates receipts", async () => {
    const { TauriBridge, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockResolvedValueOnce({
      type: "session-action-receipt",
      protocolVersion: 1,
      actionId: "action-rename",
      kind: "rename",
      sessionId: "session-1",
      status: "committed",
      committedAt: "2026-06-08T00:00:00.000Z",
    });

    const bridge = new TauriBridge();
    const action = {
      protocolVersion: 1 as const,
      actionId: "action-rename",
      kind: "rename" as const,
      sessionId: "session-1",
      requestedAt: "2026-06-08T00:00:00.000Z",
      requestedBy: "workbench" as const,
      title: "Renamed session",
    };
    const receipt = await bridge.applySessionAction(action);

    expect(receipt).toMatchObject({
      type: "session-action-receipt",
      actionId: "action-rename",
      kind: "rename",
      status: "committed",
    });
    expect(invoke).toHaveBeenCalledWith("workbench_apply_session_action", { action });
  });

  it("returns diagnostics for malformed session action receipts", async () => {
    const { TauriBridge, getBackendDiagnostics, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockResolvedValueOnce({
      type: "session-action-receipt",
      protocolVersion: 1,
      actionId: "action-delete",
      kind: "delete",
      sessionId: "session-1",
      status: "failed",
    });

    const bridge = new TauriBridge();
    const result = await bridge.applySessionAction({
      protocolVersion: 1,
      actionId: "action-delete",
      kind: "delete",
      sessionId: "session-1",
      requestedAt: "2026-06-08T00:00:00.000Z",
      requestedBy: "workbench",
    });

    expect(isBackendDiagnosticResult(result)).toBe(true);
    expect(getBackendDiagnostics().map((item) => [item.code, item.command])).toEqual([
      [PROTOCOL_ERROR_CODE, "workbench_apply_session_action"],
    ]);
  });

  it("returns diagnostics for malformed conversation rewind responses", async () => {
    const { TauriBridge, getBackendDiagnostics, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockResolvedValueOnce({ type: "conversation-rewind-applied", sessionId: "session-1" });

    const bridge = new TauriBridge();
    const result = await bridge.applyConversationRewind({
      sessionId: "session-1",
      latestUserMessage: true,
    });

    expect(isBackendDiagnosticResult(result)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: PROTOCOL_ERROR_CODE,
        command: "workbench_apply_conversation_rewind",
      },
    });
    expect(getBackendDiagnostics().map((item) => [item.code, item.command])).toEqual([
      [PROTOCOL_ERROR_CODE, "workbench_apply_conversation_rewind"],
    ]);
  });

  it("rejects dry-run apply before invoking daemon mutation commands", async () => {
    const { TauriBridge, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();

    const bridge = new TauriBridge();
    const result = await bridge.applyConversationRewind({
      sessionId: "session-1",
      latestUserMessage: true,
      dryRun: true,
    });

    expect(isBackendDiagnosticResult(result)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: UNSUPPORTED_CODE,
        command: "workbench_apply_conversation_rewind",
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns diagnostics for malformed plan document responses", async () => {
    const { TauriBridge, getBackendDiagnostics, clearBackendDiagnosticsForTest } = await import("./tauri-bridge");
    clearBackendDiagnosticsForTest();
    invoke.mockResolvedValueOnce({ type: "plan-document-created" });

    const bridge = new TauriBridge();
    const result = await bridge.createPlanDocument({
      title: "Plan",
      goal: "Create a plan",
    });

    expect(isBackendDiagnosticResult(result)).toBe(true);
    expect(getBackendDiagnostics().map((item) => [item.code, item.command])).toEqual([
      [PROTOCOL_ERROR_CODE, "workbench_create_plan_document"],
    ]);
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

function timestamp(): string {
  return "2026-06-08T00:00:00.000Z";
}

function readReleaseGenerateHandlerSource(source: string): string {
  const normalized = normalizeLineEndings(source);
  const releaseCfg = "#[cfg(not(debug_assertions))]";
  const start = normalized.indexOf(releaseCfg);
  expect(start).toBeGreaterThanOrEqual(0);
  const macroBlock = normalized.slice(start).match(/macro_rules![\s\S]*?\n\}/)?.[0] ?? "";
  expect(macroBlock).toContain("common_commands");
  return macroBlock;
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n");
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
    accountCenter: {
      configured: false,
      login: "unknown",
      quota: "unknown",
      gateway: "unknown",
      runtimeCredential: "unknown",
    },
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
