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

// B6.4 注册面（73 = 注册面 69 + 登记先行 4；与 command_manifest.rs
// `COMMAND_MANIFEST` 及前端 `BUILTIN_COMMAND_MANIFEST` 三方对齐）：
// - 注册面：`command_registry!` 宏已注册的命令，status=implemented；
// - 登记先行（registered=false）：已登记未接线，tauriRegistration=not-registered。
export const REGISTERED_TAURI_COMMANDS: readonly RegisteredTauriCommand[] = [
  // ── GUI 专属面（workbench_*，§2.3）──
  { command: "workbench_run_shell", status: "implemented", feature: "interactive terminal shell" },
  { command: "workbench_git_run", status: "implemented", feature: "git workspace command execution" },
  { command: "workbench_fs_delete_file", status: "implemented", feature: "workspace file deletion" },
  { command: "workbench_pty_create", status: "implemented", feature: "interactive PTY session creation" },
  { command: "workbench_pty_write", status: "implemented", feature: "interactive PTY input write" },
  { command: "workbench_pty_resize", status: "implemented", feature: "interactive PTY resize" },
  { command: "workbench_pty_kill", status: "implemented", feature: "interactive PTY termination" },
  { command: "workbench_list_host_openers", status: "implemented", feature: "host external opener discovery" },
  { command: "workbench_open_host_target", status: "implemented", feature: "host external opener launch" },
  { command: "workbench_open_path_default", status: "implemented", feature: "host default app open" },
  { command: "workbench_list_file_openers", status: "implemented", feature: "file association discovery" },
  { command: "workbench_select_folder", status: "implemented", feature: "workspace folder picker" },
  { command: "workbench_list_directory", status: "implemented", feature: "workspace directory listing" },
  { command: "workbench_read_file_content", status: "implemented", feature: "workspace file preview" },
  { command: "workbench_write_file_content", status: "implemented", feature: "workspace file editor save" },
  { command: "workbench_discover_skills", status: "implemented", feature: "skill discovery" },
  { command: "workbench_http_request", status: "implemented", feature: "HTTP request tool" },
  { command: "workbench_apply_update", status: "implemented", feature: "app update application" },
  // ── 配置族（§2.2-C，F5 终态名：config_get/config_update/config_secret_*）──
  { command: "config_get", status: "implemented", feature: "provider config read" },
  { command: "config_update", status: "implemented", feature: "provider config update" },
  { command: "config_secret_set", status: "implemented", feature: "secret store write" },
  { command: "config_secret_get", status: "implemented", feature: "secret store read" },
  { command: "config_secret_has", status: "implemented", feature: "secret presence check" },
  { command: "config_secret_clear", status: "implemented", feature: "secret removal" },
  { command: "config_profile_apply", status: "implemented", feature: "provider profile apply" },
  { command: "config_secret_reveal", status: "implemented", feature: "secret reveal" },
  // ── 工具旧组（E1，§2.2-E）──
  { command: "core_check_command", status: "implemented", feature: "command availability check" },
  { command: "core_search_files", status: "implemented", feature: "workspace file search" },
  { command: "core_rebuild_search_index", status: "implemented", feature: "search index rebuild" },
  { command: "core_compact_messages", status: "implemented", feature: "conversation compaction" },
  { command: "core_count_tokens", status: "implemented", feature: "token counting" },
  { command: "core_compute_diff", status: "implemented", feature: "content diff computation" },
  // ── 查询与运行（A/B，§2.2）──
  { command: "core_get_status", status: "implemented", feature: "engine status snapshot" },
  { command: "core_get_run_snapshot", status: "implemented", feature: "run snapshot read" },
  { command: "core_read_run_events", status: "implemented", feature: "run event read" },
  { command: "core_read_session_events", status: "implemented", feature: "session event read" },
  { command: "core_run_task", status: "implemented", feature: "task run start" },
  { command: "core_run_control", status: "implemented", feature: "run control signal" },
  { command: "core_cancel_run", status: "implemented", feature: "run cancellation" },
  { command: "core_approve_tool", status: "implemented", feature: "tool approval" },
  { command: "core_deny_tool", status: "implemented", feature: "tool denial" },
  // ── 会话持久化（B，§2.2；含 F3 冻结的 upsert_session_entry）──
  { command: "list_sessions", status: "implemented", feature: "session history" },
  { command: "load_session_body", status: "implemented", feature: "session body read" },
  { command: "save_session_body", status: "implemented", feature: "session body save" },
  { command: "delete_session", status: "implemented", feature: "session deletion" },
  { command: "load_session_agents", status: "implemented", feature: "session agent list read" },
  { command: "save_session_agents", status: "implemented", feature: "session agent list save" },
  { command: "get_session_meta", status: "implemented", feature: "session metadata read" },
  { command: "set_session_meta", status: "implemented", feature: "session metadata write" },
  { command: "cleanup_orphan_sessions", status: "implemented", feature: "orphan session cleanup" },
  { command: "import_from_localstorage", status: "implemented", feature: "localstorage session import" },
  { command: "touch_session", status: "implemented", feature: "session touch" },
  { command: "upsert_session_entry", status: "implemented", feature: "session entry upsert" },
  // ── Markdown（D，T03.4 更名 core_md_*，并入 core 族）──
  { command: "core_md_render", status: "implemented", feature: "markdown render" },
  { command: "core_md_render_batch", status: "implemented", feature: "markdown batch render" },
  { command: "core_md_render_stream", status: "implemented", feature: "markdown stream render" },
  { command: "core_highlight_code", status: "implemented", feature: "code highlight" },
  { command: "core_md_clear_cache", status: "implemented", feature: "markdown cache clear" },
  // ── 工具 Worker 组（E，§2.2；core_jsonl_append 自 perf 迁移）──
  { command: "core_hash_compute", status: "implemented", feature: "hash computation" },
  { command: "core_base64_encode", status: "implemented", feature: "base64 encode" },
  { command: "core_base64_decode", status: "implemented", feature: "base64 decode" },
  { command: "core_detect_encoding", status: "implemented", feature: "encoding detection" },
  { command: "core_decode_text", status: "implemented", feature: "text decode" },
  { command: "core_parse_diff", status: "implemented", feature: "diff parsing" },
  { command: "core_messages_to_jsonl", status: "implemented", feature: "messages JSONL export" },
  { command: "core_jsonl_to_messages", status: "implemented", feature: "JSONL messages import" },
  { command: "core_text_encode", status: "implemented", feature: "text encoding" },
  { command: "core_jsonl_append", status: "implemented", feature: "JSONL append" },
  // ── 注册表单一化自身（T03.1；经 command_manifest 注册）──
  { command: "core_list_commands", status: "implemented", feature: "command manifest list" },
  // ── 登记先行（§7.2 登记表；registered=false，实现方接线后翻 true）──
  {
    command: "append_session_messages",
    status: "experimental",
    tauriRegistration: "not-registered",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "session message append",
    reason: "Registered in the command manifest but not yet wired to a Tauri handler.",
  },
  {
    command: "workbench_open_workspace",
    status: "experimental",
    tauriRegistration: "not-registered",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "workspace open",
    reason: "Registered in the command manifest but not yet wired to a Tauri handler.",
  },
  {
    command: "workbench_list_workspaces",
    status: "experimental",
    tauriRegistration: "not-registered",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "workspace listing",
    reason: "Registered in the command manifest but not yet wired to a Tauri handler.",
  },
  {
    command: "workbench_dev_mcp_enabled",
    status: "experimental",
    tauriRegistration: "not-registered",
    capabilityStatus: UNSUPPORTED_CODE,
    feature: "dev MCP socket status",
    reason: "Registered in the command manifest but not yet wired to a Tauri handler.",
  },
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
  // B6.4 真源：command_registry![ ("name", path), ... ] 宏调用（注册面同源
  // COMMAND_REGISTRY_NAMES）。wire 名取二元组第一个字符串字面量；实现路径
  // 只做形态校验不提取（防 path 与 wire 名混淆）。
  const registryBlocks = readAllCommandRegistryBlocks(source);
  if (registryBlocks.length > 0) {
    const commands = new Set<string>();
    for (const rawBlock of registryBlocks) {
      const withoutComments = rawBlock
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      // ("name", path) 二元组：wire 名取字符串字面量，实现路径只做形态校验
      const tuplePattern = /\(\s*"([^"]+)",\s*[^()]+\)/g;
      let match: RegExpExecArray | null;
      while ((match = tuplePattern.exec(withoutComments)) !== null) {
        commands.add(match[1] as string);
      }
    }
    return [...commands].sort();
  }

  // 回退：旧式 generate_handler! 解析（历史代码库 / 合成样例）。
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

/**
 * Reads the call bodies of the `command_registry![...]` macro (B6.4 注册面真源).
 *
 * The macro *definition* (`macro_rules! command_registry { ... }`) is skipped —
 * only call sites (`command_registry![...]`) are processed. Call bodies are
 * delimited by balanced `[`/`]` (and `(`/`)` when invoked with paren syntax),
 * so multi-line tuples and nested tokens survive intact.
 */
function readAllCommandRegistryBlocks(source: string): string[] {
  const marker = "command_registry!";
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const markerIndex = source.indexOf(marker, searchFrom);
    if (markerIndex === -1) break;

    // Skip the macro definition itself: `macro_rules! command_registry {`
    const prefix = source.slice(Math.max(0, markerIndex - "macro_rules! ".length), markerIndex);
    if (prefix.endsWith("macro_rules! ")) {
      searchFrom = markerIndex + marker.length;
      continue;
    }

    const cursor = skipWhitespace(source, markerIndex + marker.length);
    const open = source[cursor];
    if (open !== "[" && open !== "(") {
      searchFrom = markerIndex + marker.length;
      continue;
    }
    const close = open === "[" ? "]" : ")";

    let depth = 0;
    let found = false;
    for (let index = cursor; index < source.length; index += 1) {
      const char = source[index];
      if (char === open) depth += 1;
      if (char === close) {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(cursor + 1, index));
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
