export const BACKEND_NOT_WIRED_CODE = "backend-not-wired" as const;
export const DAEMON_DISCONNECTED_CODE = "daemon-disconnected" as const;
export const PROTOCOL_ERROR_CODE = "protocol-error" as const;
export const UNSUPPORTED_CODE = "unsupported" as const;

export interface BackendNotWiredAllowlistEntry {
  feature: string;
  reason: string;
  owner?: string;
}

export type RegisteredTauriCommandStatus =
  | "implemented"
  | "experimental"
  | typeof BACKEND_NOT_WIRED_CODE
  | typeof UNSUPPORTED_CODE;
export type RegisteredTauriCommandSurface = "product" | "developer-diagnostics" | "subagent-control";
export type TauriCommandRegistrationStatus = "registered" | "debug-only" | "not-registered";
export type BackendCapabilityStatus =
  | "ok"
  | "implemented"
  | "experimental"
  | "degraded"
  | typeof BACKEND_NOT_WIRED_CODE
  | typeof UNSUPPORTED_CODE;
export type BridgeViewStatusCode =
  | "ok"
  | "empty"
  | typeof BACKEND_NOT_WIRED_CODE
  | typeof DAEMON_DISCONNECTED_CODE
  | typeof PROTOCOL_ERROR_CODE
  | typeof UNSUPPORTED_CODE;

export interface RegisteredTauriCommand {
  command: string;
  status: RegisteredTauriCommandStatus;
  tauriRegistration?: TauriCommandRegistrationStatus;
  capabilityStatus?: BackendCapabilityStatus;
  surface?: RegisteredTauriCommandSurface;
  feature: string;
  reason?: string;
  owner?: string;
}

export const REGISTERED_TAURI_COMMANDS: readonly RegisteredTauriCommand[] = [
  { command: "get_api_config", status: "implemented", feature: "provider config read" },
  { command: "list_directory", status: "implemented", feature: "workspace file browser" },
  {
    command: "open_file_in_folder",
    status: "unsupported",
    tauriRegistration: "not-registered",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "workspace file reveal",
    reason: "The frontend bridge references this desktop shell command, but the current Tauri backend does not register it.",
  },
  {
    command: "open_file_with_default_app",
    status: "unsupported",
    tauriRegistration: "not-registered",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "workspace file open",
    reason: "The frontend bridge references this desktop shell command, but the current Tauri backend does not register it.",
  },
  { command: "read_file_content", status: "implemented", feature: "workspace file preview" },
  { command: "write_file_content", status: "implemented", feature: "workspace file editor save" },
  { command: "save_api_config", status: "implemented", feature: "provider config save" },
  { command: "select_folder", status: "implemented", feature: "workspace folder picker" },
  { command: "update_daemon_config", status: "implemented", feature: "daemon provider config update" },
  { command: "workbench_approve_tool", status: "implemented", feature: "tool approval" },
  {
    command: "workbench_cancel_background_task",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "background task cancellation",
    reason: "Tauri forwards cancellation to the daemon background task manager; output and history remain preview-oriented.",
  },
  { command: "workbench_cancel_run", status: "implemented", feature: "run cancellation" },
  { command: "workbench_connection_status", status: "implemented", feature: "sidecar connection status" },
  {
    command: "workbench_cancel_pending_input",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "pending input cancellation",
    reason: "Tauri forwards cancellation to the daemon-owned pending input queue; automatic dispatch and live steering are still being productized.",
  },
  {
    command: "workbench_continuation",
    status: "unsupported",
    tauriRegistration: "not-registered",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "run continuation",
    reason: "Legacy CLI continuation has a different runId/decision contract. Product continuation must be daemon-backed before this bridge command is re-enabled.",
  },
  {
    command: "workbench_delete_memory",
    status: "experimental",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "memory deletion",
    reason: "The daemon exposes this command only when a memory adapter reports experimental or implemented support.",
  },
  { command: "workbench_deny_tool", status: "implemented", feature: "tool denial" },
  {
    command: "workbench_dispatch_pending_input",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "pending input dispatch",
    reason: "Workbench marks queued input as daemon-dispatched when it starts the follow-up run; safe-boundary steering remains follow-up work.",
  },
  {
    command: "workbench_enqueue_pending_input",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "pending input queue",
    reason: "Running-session input is persisted through the daemon queue, while dispatch and safe-boundary steering remain follow-up work.",
  },
  {
    command: "workbench_get_artifact_content",
    status: "experimental",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "artifact content",
    reason: "The daemon default capability snapshot marks artifacts unsupported until an artifact adapter is wired.",
  },
  {
    command: "workbench_get_background_task_output",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "background task output",
    reason: "Tauri returns the daemon task output preview; full persisted output is not available yet.",
  },
  {
    command: "workbench_get_checkpoint_diff",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "checkpoint diff",
    reason: "Checkpoint diff is available when the daemon checkpoint manifest adapter is configured.",
  },
  { command: "workbench_git_diff", status: "implemented", feature: "git workspace diff" },
  { command: "workbench_git_status", status: "implemented", feature: "git workspace status" },
  { command: "workbench_create_plan_document", status: "implemented", feature: "plan document creation" },
  {
    command: "workbench_create_requirements_alignment_plan",
    status: "implemented",
    feature: "requirements alignment plan creation",
  },
  { command: "workbench_delete_plan_document", status: "implemented", feature: "plan document deletion" },
  { command: "workbench_get_plan_document", status: "implemented", feature: "plan document read" },
  { command: "workbench_get_run_snapshot", status: "implemented", feature: "run snapshot" },
  { command: "workbench_get_metrics", status: "implemented", feature: "run and provider stream metrics" },
  { command: "workbench_open_host_target", status: "implemented", feature: "host external opener launch" },
  {
    command: "workbench_get_subagent_status",
    status: "implemented",
    capabilityStatus: "implemented",
    surface: "subagent-control",
    feature: "subagent status",
    reason: "Daemon get-subagent-status returns collaborative subagent runtime status.",
  },
  {
    command: "workbench_list_artifacts",
    status: "experimental",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "artifact listing",
    reason: "The daemon default capability snapshot marks artifacts unsupported until an artifact adapter is wired.",
  },
  {
    command: "workbench_list_background_tasks",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "background task listing",
    reason: "Tauri lists daemon-owned background task snapshots, including history and output previews.",
  },
  {
    command: "workbench_list_checkpoints",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "checkpoint listing",
    reason: "Checkpoint listing is backed by the daemon checkpoint manifest adapter in the default server.",
  },
  { command: "workbench_list_host_openers", status: "implemented", feature: "host external opener discovery" },
  { command: "workbench_list_mcp_servers", status: "implemented", feature: "MCP server listing" },
  {
    command: "workbench_list_memories",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "memory listing",
    reason: "Memory listing is backed by the daemon JSONL memory adapter in the default server.",
  },
  { command: "workbench_list_mutation_leases", status: "implemented", feature: "workspace mutation leases" },
  { command: "workbench_list_plan_documents", status: "implemented", feature: "plan document listing" },
  {
    command: "workbench_list_pending_inputs",
    status: "experimental",
    capabilityStatus: "experimental",
    feature: "pending input listing",
    reason: "Workbench can hydrate pending input state from the daemon queue; richer queue ordering controls are still follow-up work.",
  },
  { command: "workbench_list_runs", status: "implemented", feature: "run history" },
  { command: "workbench_list_sessions", status: "implemented", feature: "session history" },
  { command: "workbench_apply_session_action", status: "implemented", feature: "session metadata action" },
  { command: "workbench_patch_plan_document", status: "implemented", feature: "plan document patch" },
  { command: "workbench_performance_snapshot", status: "implemented", feature: "performance diagnostics" },
  {
    command: "workbench_run_shell",
    status: "implemented",
    surface: "product",
    feature: "interactive terminal shell",
    reason: "Runs user-typed terminal commands via system PowerShell (Windows) or bash (Unix).",
  },
  { command: "workbench_provider_diagnostics", status: "implemented", feature: "provider diagnostics" },
  {
    command: "workbench_dev_cli_probe",
    status: "implemented",
    tauriRegistration: "debug-only",
    surface: "developer-diagnostics",
    feature: "legacy CLI probe diagnostics",
    reason: "Developer-only diagnostics for probing the legacy npm CLI. Not part of the product run path.",
  },
  {
    command: "workbench_dev_cli_task_snapshot",
    status: "implemented",
    tauriRegistration: "debug-only",
    surface: "developer-diagnostics",
    feature: "legacy CLI snapshot diagnostics",
    reason: "Developer-only diagnostics for comparing legacy CLI snapshots. Product snapshots use workbench_get_run_snapshot.",
  },
  {
    command: "workbench_dev_cli_bootstrap",
    status: "implemented",
    tauriRegistration: "debug-only",
    surface: "developer-diagnostics",
    feature: "legacy CLI bootstrap diagnostics",
    reason: "Developer-only diagnostics for the legacy CLI bootstrap path.",
  },
  {
    command: "workbench_dev_cli_continuation",
    status: "implemented",
    tauriRegistration: "debug-only",
    surface: "developer-diagnostics",
    feature: "legacy CLI continuation diagnostics",
    reason: "Developer-only diagnostics; product continuation is not wired to the legacy CLI contract.",
  },
  {
    command: "workbench_dev_cli_run_task",
    status: "implemented",
    tauriRegistration: "debug-only",
    surface: "developer-diagnostics",
    feature: "legacy CLI task run diagnostics",
    reason: "Developer-only diagnostics. Product task runs use workbench_run_task_stream.",
  },
  {
    command: "workbench_dev_cli_run_goal",
    status: "implemented",
    tauriRegistration: "debug-only",
    surface: "developer-diagnostics",
    feature: "legacy CLI goal run diagnostics",
    reason: "Developer-only diagnostics. Product goal runs use workbench_run_goal_stream.",
  },
  { command: "workbench_read_run_events", status: "implemented", feature: "run event read" },
  { command: "workbench_read_session_events", status: "implemented", feature: "session event read" },
  { command: "workbench_restart_daemon", status: "implemented", feature: "daemon restart" },
  {
    command: "workbench_restore_checkpoint",
    status: "experimental",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "checkpoint restore",
    reason: "The default daemon checkpoint adapter supports list and diff; restore remains unsupported until a restore adapter is wired.",
  },
  { command: "workbench_preview_conversation_rewind", status: "implemented", feature: "conversation rewind preview" },
  { command: "workbench_apply_conversation_rewind", status: "implemented", feature: "conversation rewind apply" },
  {
    command: "workbench_answer_question",
    status: "unsupported",
    tauriRegistration: "not-registered",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "interactive ask answer",
    reason: "Interactive ask mechanism (BE-16) is not yet implemented in the backend.",
  },
  { command: "workbench_run_goal_stream", status: "implemented", feature: "goal run stream" },
  { command: "workbench_run_task_stream", status: "implemented", feature: "task run stream" },
  {
    command: "workbench_send_to_subagent",
    status: "implemented",
    capabilityStatus: "implemented",
    surface: "subagent-control",
    feature: "subagent messaging",
    reason: "Daemon steerRun accepts send-to-subagent for collaborative subagent control.",
  },
  { command: "workbench_start_mcp_server", status: "experimental", feature: "MCP server start" },
  { command: "workbench_status", status: "implemented", feature: "workbench status" },
  { command: "workbench_stop_daemon", status: "implemented", feature: "daemon stop" },
  { command: "workbench_stop_mcp_server", status: "experimental", feature: "MCP server stop" },
];

export interface BackendNotWiredDiagnostic extends BackendNotWiredAllowlistEntry {
  code: typeof BACKEND_NOT_WIRED_CODE;
  command: string;
  message: string;
  severity: "warning";
  source: "tauri-command-registry";
}

export interface BackendCommandDiagnostic {
  code:
    | typeof BACKEND_NOT_WIRED_CODE
    | typeof DAEMON_DISCONNECTED_CODE
    | typeof PROTOCOL_ERROR_CODE
    | typeof UNSUPPORTED_CODE;
  command: string;
  feature: string;
  message: string;
  severity: "warning" | "error";
  source: "tauri-bridge" | "tauri-command-registry";
  cause?: unknown;
}

export interface BridgeViewStatus {
  status: BridgeViewStatusCode;
  ok: boolean;
  empty: boolean;
  command?: string;
  diagnostic?: BackendCommandDiagnostic;
}

export interface BackendDiagnosticResult {
  ok: false;
  diagnostic: BackendCommandDiagnostic;
}

export interface BackendNotWiredResult {
  notWired: true;
  diagnostic: BackendNotWiredDiagnostic;
}

export interface BackendNotWiredTextResult extends BackendNotWiredResult {
  content: string;
}

export type BackendNotWiredArrayResult<T> = T[] & BackendNotWiredResult;
export type BackendDiagnosticArrayResult<T> = T[] & BackendDiagnosticResult;

export interface BackendDiagnosticTextResult extends BackendDiagnosticResult {
  content: string;
}

export class BackendNotWiredError extends Error {
  readonly code = BACKEND_NOT_WIRED_CODE;
  readonly command: string;
  readonly diagnostic: BackendNotWiredDiagnostic;

  constructor(diagnostic: BackendNotWiredDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.command} is not wired (${diagnostic.feature})`);
    this.name = "BackendNotWiredError";
    this.command = diagnostic.command;
    this.diagnostic = diagnostic;
  }
}

export const TAURI_COMMAND_REGISTRY: ReadonlyMap<string, RegisteredTauriCommand> = new Map(
  REGISTERED_TAURI_COMMANDS.map((entry) => [entry.command, entry])
);

export const BACKEND_NOT_WIRED_COMMAND_ALLOWLIST: Record<string, BackendNotWiredAllowlistEntry> =
  Object.fromEntries(
    REGISTERED_TAURI_COMMANDS.filter((entry) => entry.capabilityStatus === BACKEND_NOT_WIRED_CODE).map((entry) => [
      entry.command,
      {
        feature: entry.feature,
        reason: entry.reason ?? "This Workbench bridge command is intentionally marked unsupported.",
      },
    ])
  );

export interface TauriCommandRegistryDiff {
  invoked: string[];
  registered: string[];
  frontendRegistered: string[];
  frontendProductCommands: string[];
  frontendWiredCommands: string[];
  frontendUnsupported: BackendNotWiredDiagnostic[];
  allowedUnwired: BackendNotWiredDiagnostic[];
  missingFrontendRegistry: string[];
  missingRustRegistration: string[];
  missing: string[];
  staleAllowlist: string[];
}

export function extractInvokedTauriCommands(source: string): string[] {
  const commands = new Set<string>();
  let index = 0;

  while (index < source.length) {
    const invokeIndex = source.indexOf("invoke", index);
    if (invokeIndex === -1) break;

    const before = source[invokeIndex - 1];
    const after = source[invokeIndex + "invoke".length];
    if (isIdentifierChar(before) || isIdentifierChar(after)) {
      index = invokeIndex + "invoke".length;
      continue;
    }

    let cursor = skipWhitespace(source, invokeIndex + "invoke".length);
    if (source[cursor] === "<") {
      cursor = skipTypeArguments(source, cursor);
      if (cursor === -1) {
        index = invokeIndex + "invoke".length;
        continue;
      }
      cursor = skipWhitespace(source, cursor);
    }

    if (source[cursor] !== "(") {
      index = invokeIndex + "invoke".length;
      continue;
    }

    cursor = skipWhitespace(source, cursor + 1);
    const quote = source[cursor];
    if (quote !== "'" && quote !== '"' && quote !== "`") {
      index = invokeIndex + "invoke".length;
      continue;
    }

    const end = source.indexOf(quote, cursor + 1);
    if (end === -1) {
      index = invokeIndex + "invoke".length;
      continue;
    }

    const command = source.slice(cursor + 1, end);
    if (/^[A-Za-z0-9_:-]+$/.test(command)) {
      commands.add(command);
    }
    index = end + 1;
  }

  return [...commands].sort();
}

export function extractRegisteredTauriCommands(source: string): string[] {
  const blocks = readAllGenerateHandlerBlocks(source);
  if (blocks.length === 0 && !source.includes("make_handlers!")) return [];

  const macros = extractMacroDefinitions(source);

  const commands = new Set<string>();
  for (const rawBlock of blocks) {
    const block = expandMacrosInBlock(rawBlock, macros);
    const withoutComments = block
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    for (const part of withoutComments.split(",")) {
      const commandPath = part.trim();
      if (!commandPath) continue;
      const match = commandPath.match(/(?:^|::)([A-Za-z_][A-Za-z0-9_]*)$/);
      if (match) commands.add(match[1] as string);
    }
  }

  // make_handlers!(args) is a thin wrapper around generate_handler! — any command
  // paths passed as arguments are registered Tauri commands (e.g. debug-only dev
  // CLI commands injected via register_handlers!(dev) => make_handlers!(...)).
  for (const cmd of extractMacroCallCommands(source, "make_handlers")) {
    commands.add(cmd);
  }

  return [...commands].sort();
}

export function diffTauriCommandRegistry(
  bridgeSource: string,
  rustMainSource: string,
  allowlist: Record<string, BackendNotWiredAllowlistEntry> = BACKEND_NOT_WIRED_COMMAND_ALLOWLIST
): TauriCommandRegistryDiff {
  const invoked = extractInvokedTauriCommands(bridgeSource);
  const registered = extractRegisteredTauriCommands(rustMainSource);
  const frontendWiredCommands = REGISTERED_TAURI_COMMANDS.filter(shouldHaveTauriRegistration)
    .map((entry) => entry.command)
    .sort();
  const frontendProductCommands = REGISTERED_TAURI_COMMANDS.filter(isProductCapabilityCommand)
    .map((entry) => entry.command)
    .sort();
  const frontendRegistered = frontendProductCommands;
  const registeredSet = new Set(registered);
  const invokedSet = new Set(invoked);
  const frontendRegistrySet = new Set<string>(REGISTERED_TAURI_COMMANDS.map((entry) => entry.command));

  const allowedUnwired = invoked
    .filter((command) => allowlist[command])
    .map((command) => createBackendNotWiredDiagnostic(command, allowlist));
  const missingFrontendRegistry = invoked.filter((command) => !frontendRegistrySet.has(command));
  const missingRustRegistration = frontendWiredCommands.filter((command) => !registeredSet.has(command));
  const missing = [...new Set([...missingFrontendRegistry, ...missingRustRegistration])].sort();
  const staleAllowlist = Object.keys(allowlist)
    .filter((command) => !invokedSet.has(command))
    .sort();

  return {
    invoked,
    registered,
    frontendRegistered,
    frontendProductCommands,
    frontendWiredCommands,
    frontendUnsupported: allowedUnwired,
    allowedUnwired,
    missingFrontendRegistry,
    missingRustRegistration,
    missing,
    staleAllowlist,
  };
}

export function commandCapabilityStatus(entry: RegisteredTauriCommand): BackendCapabilityStatus {
  return entry.capabilityStatus ?? entry.status;
}

export function isProductCapabilityCommand(entry: RegisteredTauriCommand): boolean {
  return (
    (entry.surface ?? "product") === "product" &&
    (entry.status === "implemented" || entry.status === "experimental") &&
    commandCapabilityStatus(entry) !== UNSUPPORTED_CODE &&
    commandCapabilityStatus(entry) !== BACKEND_NOT_WIRED_CODE
  );
}

export function shouldHaveTauriRegistration(entry: RegisteredTauriCommand): boolean {
  return entry.tauriRegistration !== "not-registered";
}

export function shouldHaveReleaseTauriRegistration(entry: RegisteredTauriCommand): boolean {
  return shouldHaveTauriRegistration(entry) && entry.tauriRegistration !== "debug-only";
}

export function createBackendNotWiredDiagnostic(
  command: string,
  allowlist: Record<string, BackendNotWiredAllowlistEntry> = BACKEND_NOT_WIRED_COMMAND_ALLOWLIST
): BackendNotWiredDiagnostic {
  const entry = allowlist[command] ?? {
    feature: command,
    reason: "The Workbench bridge references this Tauri command, but it is not registered in the backend.",
  };
  return {
    code: BACKEND_NOT_WIRED_CODE,
    command,
    message: `${BACKEND_NOT_WIRED_CODE}: ${command} is not wired to the Tauri backend.`,
    severity: "warning",
    source: "tauri-command-registry",
    ...entry,
  };
}

export function createBackendNotWiredError(command: string): BackendNotWiredError {
  return new BackendNotWiredError(createBackendNotWiredDiagnostic(command));
}

export function createBackendNotWiredResult(command: string): BackendNotWiredResult {
  return {
    notWired: true,
    diagnostic: createBackendNotWiredDiagnostic(command),
  };
}

export function createBackendNotWiredArrayResult<T>(command: string): BackendNotWiredArrayResult<T> {
  return Object.assign([] as unknown as T[], createBackendNotWiredResult(command));
}

export function createBackendNotWiredTextResult(command: string): BackendNotWiredTextResult {
  return {
    content: "",
    ...createBackendNotWiredResult(command),
  };
}

export function isBackendNotWiredCommand(command: string): boolean {
  return command in BACKEND_NOT_WIRED_COMMAND_ALLOWLIST;
}

export function createBackendCommandDiagnostic(
  command: string,
  cause: unknown,
  options: { feature?: string; message?: string } = {}
): BackendCommandDiagnostic {
  const entry = TAURI_COMMAND_REGISTRY.get(command);
  const code = classifyBackendFailure(cause);
  return {
    code,
    command,
    feature: options.feature ?? entry?.feature ?? command,
    message: options.message ?? backendFailureMessage(code, command, cause),
    severity: code === UNSUPPORTED_CODE ? "warning" : "error",
    source: "tauri-bridge",
    cause,
  };
}

export function createUnsupportedCommandDiagnostic(
  command: string,
  cause: unknown = "This Workbench bridge feature is unsupported in the current frontend environment.",
  options: { feature?: string; message?: string } = {}
): BackendCommandDiagnostic {
  const entry = TAURI_COMMAND_REGISTRY.get(command);
  return {
    code: UNSUPPORTED_CODE,
    command,
    feature: options.feature ?? entry?.feature ?? command,
    message: options.message ?? `Unsupported Workbench bridge command ${command}: ${stringifyCause(cause)}`,
    severity: "warning",
    source: "tauri-bridge",
    cause,
  };
}

export function createBackendDiagnosticResult(
  command: string,
  cause: unknown,
  options?: { feature?: string; message?: string }
): BackendDiagnosticResult {
  return {
    ok: false,
    diagnostic: createBackendCommandDiagnostic(command, cause, options),
  };
}

export function createBackendDiagnosticArrayResult<T>(
  command: string,
  cause: unknown,
  options?: { feature?: string; message?: string }
): BackendDiagnosticArrayResult<T> {
  return Object.assign([] as unknown as T[], createBackendDiagnosticResult(command, cause, options));
}

export function createBackendDiagnosticTextResult(
  command: string,
  cause: unknown,
  options?: { feature?: string; message?: string }
): BackendDiagnosticTextResult {
  return {
    content: "",
    ...createBackendDiagnosticResult(command, cause, options),
  };
}

export function isBackendDiagnosticResult(value: unknown): value is BackendDiagnosticResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { ok?: unknown }).ok === false &&
      typeof (value as { diagnostic?: { code?: unknown } }).diagnostic?.code === "string"
  );
}

export function getBridgeViewStatus(value: unknown, command: string | undefined): BridgeViewStatus {
  if (isBackendDiagnosticResult(value)) {
    return {
      status: value.diagnostic.code,
      ok: false,
      empty: Array.isArray(value) ? value.length === 0 : false,
      command: value.diagnostic.command,
      diagnostic: value.diagnostic,
    };
  }

  if (isBackendNotWiredResult(value)) {
    return {
      status: BACKEND_NOT_WIRED_CODE,
      ok: false,
      empty: Array.isArray(value) ? value.length === 0 : false,
      command: value.diagnostic.command,
      diagnostic: value.diagnostic,
    };
  }

  return {
    status: Array.isArray(value) && value.length === 0 ? "empty" : "ok",
    ok: true,
    empty: Array.isArray(value) && value.length === 0,
    ...(command !== undefined ? { command } : {}),
  };
}

export function isBackendNotWiredResult(value: unknown): value is BackendNotWiredResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { notWired?: unknown }).notWired === true &&
      (value as { diagnostic?: { code?: unknown } }).diagnostic?.code === BACKEND_NOT_WIRED_CODE
  );
}

function classifyBackendFailure(
  cause: unknown
): typeof DAEMON_DISCONNECTED_CODE | typeof PROTOCOL_ERROR_CODE | typeof UNSUPPORTED_CODE {
  const message = stringifyCause(cause).toLowerCase();
  if (
    message.includes("unsupported") ||
    message.includes("not supported") ||
    message.includes("not wired") ||
    message.includes("unknown command") ||
    message.includes("command not found") ||
    message.includes("not registered")
  ) {
    return UNSUPPORTED_CODE;
  }
  if (
    message.includes("sidecar not connected") ||
    message.includes("sidecar disconnected") ||
    message.includes("daemon disconnected") ||
    message.includes("not connected") ||
    message.includes("connection closed") ||
    message.includes("websocket") ||
    message.includes("timed out waiting for") ||
    message.includes("channel closed")
  ) {
    return DAEMON_DISCONNECTED_CODE;
  }
  return PROTOCOL_ERROR_CODE;
}

function backendFailureMessage(
  code: typeof DAEMON_DISCONNECTED_CODE | typeof PROTOCOL_ERROR_CODE | typeof UNSUPPORTED_CODE,
  command: string,
  cause: unknown
): string {
  const detail = stringifyCause(cause);
  const prefix =
    code === UNSUPPORTED_CODE
      ? "Backend command is unsupported while running"
      : code === DAEMON_DISCONNECTED_CODE
        ? "Daemon is disconnected while running"
        : "Backend protocol failed while running";
  return detail ? `${prefix} ${command}: ${detail}` : `${prefix} ${command}.`;
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export function isBackendNotWiredError(value: unknown): value is BackendNotWiredError {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { code?: unknown }).code === BACKEND_NOT_WIRED_CODE &&
      typeof (value as { command?: unknown }).command === "string" &&
      (value as { diagnostic?: { code?: unknown } }).diagnostic?.code === BACKEND_NOT_WIRED_CODE
  );
}

function readAllGenerateHandlerBlocks(source: string): string[] {
  const marker = "generate_handler!";
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const markerIndex = source.indexOf(marker, searchFrom);
    if (markerIndex === -1) break;

    const start = source.indexOf("[", markerIndex + marker.length);
    if (start === -1) break;

    let depth = 0;
    let found = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === "[") depth += 1;
      if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(start + 1, index));
          searchFrom = index + 1;
          found = true;
          break;
        }
      }
    }
    if (!found) break;
  }

  return blocks;
}

function extractMacroDefinitions(source: string): Map<string, string> {
  const macros = new Map<string, string>();
  const macroPattern = /macro_rules!\s+(\w+)\s*\{[^}]*\(\)\s*=>\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = macroPattern.exec(source)) !== null) {
    macros.set(match[1] as string, match[2] as string);
  }
  return macros;
}

function expandMacrosInBlock(block: string, macros: Map<string, string>): string {
  let result = block;
  for (const [name, body] of macros) {
    const invocationPattern = new RegExp(name + "!\\(\\)", "g");
    result = result.replace(invocationPattern, body);
  }
  return result;
}

/**
 * Finds `macroName!(...)` call sites in `source` and extracts command paths from
 * the call arguments. Used to resolve thin wrapper macros like `make_handlers!`
 * that inject extra commands into `generate_handler!` via `$($extra,)*`.
 *
 * The macro *definition* (`macro_rules! macroName { ... }`) is skipped — only
 * call sites (`macroName!(...)`) are processed. Arguments are split by comma and
 * matched against the same `::path` trailing-segment pattern used for
 * `generate_handler!` blocks.
 */
function extractMacroCallCommands(source: string, macroName: string): string[] {
  const marker = `${macroName}!`;
  const commands = new Set<string>();
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const idx = source.indexOf(marker, searchFrom);
    if (idx === -1) break;

    // Skip the macro definition itself: `macro_rules! macroName {`
    const prefix = source.slice(Math.max(0, idx - "macro_rules! ".length), idx);
    if (prefix.endsWith("macro_rules! ")) {
      searchFrom = idx + marker.length;
      continue;
    }

    let cursor = idx + marker.length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "(") {
      searchFrom = idx + marker.length;
      continue;
    }

    // Balanced paren matching to handle multi-line / nested call args.
    let depth = 0;
    let parenEnd = -1;
    for (let i = cursor; i < source.length; i += 1) {
      const char = source[i];
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          parenEnd = i;
          break;
        }
      }
    }
    if (parenEnd === -1) {
      searchFrom = idx + marker.length;
      continue;
    }

    const argsText = source.slice(cursor + 1, parenEnd);
    const withoutComments = argsText
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    for (const part of withoutComments.split(",")) {
      const commandPath = part.trim();
      if (!commandPath) continue;
      const match = commandPath.match(/(?:^|::)([A-Za-z_][A-Za-z0-9_]*)$/);
      if (match) commands.add(match[1] as string);
    }

    searchFrom = parenEnd + 1;
  }

  return [...commands].sort();
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function skipTypeArguments(source: string, start: number): number {
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "<") depth += 1;
    if (char === ">") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return -1;
}

function isIdentifierChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_$]/.test(char));
}
