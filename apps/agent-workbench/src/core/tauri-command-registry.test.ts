import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKEND_NOT_WIRED_CODE,
  BACKEND_NOT_WIRED_COMMAND_ALLOWLIST,
  REGISTERED_TAURI_COMMANDS,
  TAURI_COMMAND_REGISTRY,
  UNSUPPORTED_CODE,
  commandCapabilityStatus,
  diffTauriCommandRegistry,
  extractInvokedTauriCommands,
  extractRegisteredTauriCommands,
  isProductCapabilityCommand,
  shouldHaveReleaseTauriRegistration,
} from "./tauri-command-registry";
import { buildDaemonCapabilitySnapshot } from "../../../../packages/agent-daemon/src/capabilities";
import { DAEMON_INBOUND_MESSAGE_REGISTRY } from "../../../../packages/agent-daemon/src/protocol/registry";
import type {
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
} from "../../../../packages/agent-daemon/src/types";

const rustMainPath = fileURLToPath(new URL("../../src-tauri/src/main.rs", import.meta.url));
const rootPackagePath = fileURLToPath(new URL("../../../../package.json", import.meta.url));

describe("Tauri command registry", () => {
  it("extracts static invoke command names from source text", () => {
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

  it("keeps registry-declared wired commands registered in Tauri generate_handler", () => {
    // Product command truth is REGISTERED_TAURI_COMMANDS + Rust handlers (not legacy Preact bridge).
    const syntheticFrontendInvokes = REGISTERED_TAURI_COMMANDS.map(
      (entry) => `await invoke("${entry.command}");`,
    ).join("\n");
    const diff = diffTauriCommandRegistry(
      syntheticFrontendInvokes,
      readFileSync(rustMainPath, "utf8"),
    );

    expect(diff.missingFrontendRegistry).toEqual([]);
    expect(diff.missingRustRegistration).toEqual([]);
    expect(diff.missing).toEqual([]);
    expect(diff.staleAllowlist).toEqual([]);
    expect(diff.allowedUnwired.map((item) => item.command)).toEqual(
      Object.keys(BACKEND_NOT_WIRED_COMMAND_ALLOWLIST).sort(),
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

  it("lists invokes that are missing from the frontend command registry", () => {
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
    expect(pkg.scripts["build:product"]).toBe(
      "npm run build:daemon && npm run build:desktop && npm run build:daemon-binary",
    );
    expect(pkg.scripts["build:desktop"]).toContain("crish-desktop");
    expect(pkg.scripts["dev:workbench"]).toContain("agent-workbench");
    // Preact legacy UI entry must not remain as a product script
    expect(pkg.scripts["dev:workbench:legacy-ui"] ?? null).toBeNull();
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
    // Subagent control stays on the dedicated surface, not ordinary product exposure.
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
    const checkpoints = snapshot.capabilities.find((capability) => capability.id === "checkpoints");

    expect(unsupportedDaemonCapabilities.get("artifacts")?.relatedTauriCommands).toEqual(
      expect.arrayContaining(["workbench_list_artifacts", "workbench_get_artifact_content"])
    );
    // Default checkpoint surface is experimental (list/diff); restore stays non-product.
    expect(checkpoints?.state).toBe("experimental");
    expect(checkpoints?.relatedTauriCommands).toEqual(
      expect.arrayContaining(["workbench_list_checkpoints", "workbench_get_checkpoint_diff"])
    );
    expect(checkpoints?.relatedTauriCommands).not.toContain("workbench_restore_checkpoint");
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

  it("keeps daemon-implemented subagent commands wired but off ordinary product surface", () => {
    expect(DAEMON_INBOUND_MESSAGE_REGISTRY["send-to-subagent"].state).toBe("implemented");
    expect(DAEMON_INBOUND_MESSAGE_REGISTRY["get-subagent-status"].state).toBe("implemented");

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
        status: "implemented",
        capabilityStatus: "implemented",
        surface: "subagent-control",
      }),
      expect.objectContaining({
        command: "workbench_send_to_subagent",
        status: "implemented",
        capabilityStatus: "implemented",
        surface: "subagent-control",
      }),
    ]);
  });
});



function timestamp(): string {
  return "2026-06-08T00:00:00.000Z";
}

function readReleaseGenerateHandlerSource(source: string): string {
  const normalized = normalizeLineEndings(source);
  const match = normalized.match(/macro_rules!\s+register_handlers\s*\{([\s\S]*?)\}\s*fn main\(\)/);
  if (!match) {
    throw new Error("Could not find macro_rules! register_handlers in main.rs");
  }
  const macroContent = match[1];
  // Extract the () => { ... } block
  const branchMatch = macroContent.match(/\(\)\s*=>\s*\{([\s\S]*?)\}\s*;/);
  if (!branchMatch) {
    throw new Error("Could not find () branch in register_handlers macro");
  }
  return branchMatch[1];
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
