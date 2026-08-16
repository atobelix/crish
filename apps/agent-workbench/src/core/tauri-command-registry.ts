export const UNSUPPORTED_CODE = 'unsupported' as const;

type RegisteredTauriCommandStatus =
  'implemented' | 'experimental' | typeof UNSUPPORTED_CODE;
type RegisteredTauriCommandSurface =
  'product' | 'developer-diagnostics' | 'subagent-control';
type TauriCommandRegistrationStatus =
  'registered' | 'debug-only' | 'not-registered';
export type BackendCapabilityStatus =
  'ok' | 'implemented' | 'experimental' | 'degraded' | typeof UNSUPPORTED_CODE;

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
  {
    command: 'workbench_run_shell',
    status: 'implemented',
    feature: 'interactive terminal shell',
  },
  {
    command: 'workbench_git_run',
    status: 'implemented',
    feature: 'git workspace command execution',
  },
  {
    command: 'workbench_pty_create',
    status: 'implemented',
    feature: 'interactive PTY session creation',
  },
  {
    command: 'workbench_pty_write',
    status: 'implemented',
    feature: 'interactive PTY input write',
  },
  {
    command: 'workbench_pty_resize',
    status: 'implemented',
    feature: 'interactive PTY resize',
  },
  {
    command: 'workbench_pty_kill',
    status: 'implemented',
    feature: 'interactive PTY termination',
  },
  {
    command: 'workbench_list_host_openers',
    status: 'implemented',
    feature: 'host external opener discovery',
  },
  {
    command: 'workbench_open_host_target',
    status: 'implemented',
    feature: 'host external opener launch',
  },
  {
    command: 'workbench_open_path_default',
    status: 'implemented',
    feature: 'host default app open',
  },
  {
    command: 'workbench_list_file_openers',
    status: 'implemented',
    feature: 'file association discovery',
  },
  {
    command: 'workbench_select_folder',
    status: 'implemented',
    feature: 'workspace folder picker',
  },
  {
    command: 'workbench_list_directory',
    status: 'implemented',
    feature: 'workspace directory listing',
  },
  {
    command: 'workbench_read_file_content',
    status: 'implemented',
    feature: 'workspace file preview',
  },
  {
    command: 'workbench_write_file_content',
    status: 'implemented',
    feature: 'workspace file editor save',
  },
  {
    command: 'workbench_discover_skills',
    status: 'implemented',
    feature: 'skill discovery',
  },
  {
    command: 'workbench_http_request',
    status: 'implemented',
    feature: 'HTTP request tool',
  },
  {
    command: 'workbench_apply_update',
    status: 'implemented',
    feature: 'app update application',
  },
  // ── 浏览器面板（S6 接线 + browser 域追加：frame stream / input 管线）──
  {
    command: 'browser_start',
    status: 'implemented',
    feature: 'browser session start',
  },
  {
    command: 'browser_stop',
    status: 'implemented',
    feature: 'browser session stop',
  },
  {
    command: 'browser_status',
    status: 'implemented',
    feature: 'browser session status',
  },
  {
    command: 'browser_input',
    status: 'implemented',
    feature: 'browser input dispatch',
  },
  {
    command: 'browser_start_frames',
    status: 'implemented',
    feature: 'browser frame stream start',
  },
  {
    command: 'browser_stop_frames',
    status: 'implemented',
    feature: 'browser frame stream stop',
  },
  {
    command: 'browser_frame_status',
    status: 'implemented',
    feature: 'browser frame stream status',
  },
  {
    command: 'browser_export_storage_state',
    status: 'implemented',
    feature: 'browser storage state export',
  },
  {
    command: 'browser_import_storage_state',
    status: 'implemented',
    feature: 'browser storage state import',
  },
  // ── 多端互通（R1-07/R1-08 配对 + 设备管理 + R1-09 网络环境）──
  {
    command: 'multi_device_pair_start',
    status: 'implemented',
    feature: 'pairing mode start',
  },
  {
    command: 'multi_device_pair_status',
    status: 'implemented',
    feature: 'pairing state snapshot',
  },
  {
    command: 'multi_device_pair_cancel',
    status: 'implemented',
    feature: 'pairing mode cancel',
  },
  {
    command: 'multi_device_list_devices',
    status: 'implemented',
    feature: 'paired device list',
  },
  {
    command: 'multi_device_revoke_device',
    status: 'implemented',
    feature: 'device revoke',
  },
  {
    command: 'multi_device_rename_device',
    status: 'implemented',
    feature: 'device rename',
  },
  {
    command: 'multi_device_network_info',
    status: 'implemented',
    feature: 'network environment detection',
  },
  // ── 配置族（§2.2-C，F5 终态名：config_get/config_update/config_secret_*）──
  {
    command: 'config_get',
    status: 'implemented',
    feature: 'provider config read',
  },
  {
    command: 'config_update',
    status: 'implemented',
    feature: 'provider config update',
  },
  {
    command: 'config_secret_set',
    status: 'implemented',
    feature: 'secret store write',
  },
  {
    command: 'config_secret_get',
    status: 'implemented',
    feature: 'secret store read',
  },
  {
    command: 'config_secret_has',
    status: 'implemented',
    feature: 'secret presence check',
  },
  {
    command: 'config_secret_clear',
    status: 'implemented',
    feature: 'secret removal',
  },
  {
    command: 'config_profile_apply',
    status: 'implemented',
    feature: 'provider profile apply',
  },
  {
    command: 'config_secret_reveal',
    status: 'implemented',
    feature: 'secret reveal',
  },
  {
    command: 'provider_probe_ping',
    status: 'implemented',
    feature: 'provider probe ping latency check',
  },
  {
    command: 'provider_probe_scan_models',
    status: 'implemented',
    feature: 'provider probe scan models',
  },
  // ── 工具旧组（E1，§2.2-E）──
  {
    command: 'core_check_command',
    status: 'implemented',
    feature: 'command availability check',
  },
  {
    command: 'core_search_files',
    status: 'implemented',
    feature: 'workspace file search',
  },
  {
    command: 'core_rebuild_search_index',
    status: 'implemented',
    feature: 'search index rebuild',
  },
  {
    command: 'core_compact_messages',
    status: 'implemented',
    feature: 'conversation compaction',
  },
  {
    command: 'core_count_tokens',
    status: 'implemented',
    feature: 'token counting',
  },
  {
    command: 'core_compute_diff',
    status: 'implemented',
    feature: 'content diff computation',
  },
  // ── 查询与运行（A/B，§2.2）──
  {
    command: 'core_get_status',
    status: 'implemented',
    feature: 'engine status snapshot',
  },
  {
    command: 'core_get_run_snapshot',
    status: 'implemented',
    feature: 'run snapshot read',
  },
  // T-F 06 退役：core_read_run_events 已被 core_read_session_events 取代（changelog 33）
  {
    command: 'core_read_session_events',
    status: 'implemented',
    feature: 'session event read',
  },
  {
    command: 'core_run_task',
    status: 'implemented',
    feature: 'task run start',
  },
  {
    command: 'core_run_control',
    status: 'implemented',
    feature: 'run control signal',
  },
  {
    command: 'core_session_retract',
    status: 'implemented',
    feature:
      'R1 撤回（统一输入流收敛战役）：停 run + 边界冻结 + timeline-truncate',
  },
  {
    command: 'core_cancel_run',
    status: 'implemented',
    feature: 'run cancellation',
  },
  {
    command: 'core_approve_tool',
    status: 'implemented',
    feature: 'tool approval',
  },
  { command: 'core_deny_tool', status: 'implemented', feature: 'tool denial' },
  // ── 会话持久化（B，§2.2；含 F3 冻结的 upsert_session_entry）──
  // T-F 06 退役：delete_session / touch_session 已从命令面退役（changelog 33；
  // 前端删除走 IndexedDB 本地面，活跃时间戳面无前端依赖）
  {
    command: 'list_sessions',
    status: 'implemented',
    feature: 'session history',
  },
  {
    command: 'load_session_body',
    status: 'implemented',
    feature: 'session body read',
  },
  {
    command: 'save_session_body',
    status: 'implemented',
    feature: 'session body save',
  },
  {
    command: 'load_session_agents',
    status: 'implemented',
    feature: 'session agent list read',
  },
  {
    command: 'save_session_agents',
    status: 'implemented',
    feature: 'session agent list save',
  },
  {
    command: 'get_session_meta',
    status: 'implemented',
    feature: 'session metadata read',
  },
  {
    command: 'set_session_meta',
    status: 'implemented',
    feature: 'session metadata write',
  },
  {
    command: 'cleanup_orphan_sessions',
    status: 'implemented',
    feature: 'orphan session cleanup',
  },
  {
    command: 'import_from_localstorage',
    status: 'implemented',
    feature: 'localstorage session import',
  },
  // ── F 轮新增命令（F1/F3 后台任务 + F10 产出根 + F11b DAG 快照 + catalog/trash）──
  {
    command: 'workbench_list_background_tasks',
    status: 'implemented',
    feature: 'background task list',
  },
  {
    command: 'workbench_get_background_task_output',
    status: 'implemented',
    feature: 'background task output',
  },
  {
    command: 'workbench_cancel_background_task',
    status: 'implemented',
    feature: 'background task cancel',
  },
  {
    command: 'workbench_send_input',
    status: 'implemented',
    feature: 'background task stdin input',
  },
  {
    command: 'config_get_outputs_root',
    status: 'implemented',
    feature: 'outputs root read',
  },
  {
    command: 'config_set_outputs_root',
    status: 'implemented',
    feature: 'outputs root write',
  },
  {
    command: 'set_session_output_root',
    status: 'implemented',
    feature: 'session outputs root override',
  },
  {
    command: 'get_flow_snapshot',
    status: 'implemented',
    feature: 'DAG flow snapshot read',
  },
  {
    command: 'catalog_get',
    status: 'implemented',
    feature: 'model catalog read',
  },
  {
    command: 'catalog_refresh',
    status: 'implemented',
    feature: 'model catalog refresh',
  },
  { command: 'trash_list', status: 'implemented', feature: 'trash list' },
  { command: 'trash_purge', status: 'implemented', feature: 'trash purge' },
  { command: 'trash_restore', status: 'implemented', feature: 'trash restore' },
  // ── workflow 域六条（F9 T-CF-14，wire 名 kebab-case）──
  {
    command: 'create-workflow',
    status: 'implemented',
    feature: 'workflow create',
  },
  {
    command: 'list-workflows',
    status: 'implemented',
    feature: 'workflow list',
  },
  {
    command: 'update-workflow',
    status: 'implemented',
    feature: 'workflow update',
  },
  {
    command: 'delete-workflow',
    status: 'implemented',
    feature: 'workflow delete',
  },
  {
    command: 'trigger-workflow',
    status: 'implemented',
    feature: 'workflow trigger',
  },
  {
    command: 'list-workflow-runs',
    status: 'implemented',
    feature: 'workflow runs list',
  },
  // ── Markdown（D，T03.4 更名 core_md_*，并入 core 族）──
  // T-F 06 退役：core_md_render_stream（流式主路径 JS 零 IPC）/ core_md_clear_cache
  // （moka 自动 LRU，仅测试隔离用途）已退役（changelog 33）
  {
    command: 'core_md_render',
    status: 'implemented',
    feature: 'markdown render',
  },
  {
    command: 'core_md_render_batch',
    status: 'implemented',
    feature: 'markdown batch render',
  },
  // ── 工具 Worker 组（E，§2.2；core_jsonl_append 自 perf 迁移）──
  {
    command: 'core_hash_compute',
    status: 'implemented',
    feature: 'hash computation',
  },
  {
    command: 'core_base64_encode',
    status: 'implemented',
    feature: 'base64 encode',
  },
  {
    command: 'core_base64_decode',
    status: 'implemented',
    feature: 'base64 decode',
  },
  {
    command: 'core_detect_encoding',
    status: 'implemented',
    feature: 'encoding detection',
  },
  {
    command: 'core_decode_text',
    status: 'implemented',
    feature: 'text decode',
  },
  {
    command: 'core_parse_diff',
    status: 'implemented',
    feature: 'diff parsing',
  },
  {
    command: 'core_messages_to_jsonl',
    status: 'implemented',
    feature: 'messages JSONL export',
  },
  {
    command: 'core_jsonl_to_messages',
    status: 'implemented',
    feature: 'JSONL messages import',
  },
  {
    command: 'core_jsonl_append',
    status: 'implemented',
    feature: 'JSONL append',
  },
  // ── 注册表单一化自身（T03.1；经 command_manifest 注册）──
  {
    command: 'core_list_commands',
    status: 'implemented',
    feature: 'command manifest list',
  },
  // ── Wave 2 / 架构演进新注册命令 ──
  {
    command: 'browser_import_bookmarks',
    status: 'implemented',
    feature: 'browser bookmarks import',
  },
  {
    command: 'browser_import_history',
    status: 'implemented',
    feature: 'browser history import',
  },
  {
    command: 'browser_list_bookmarks',
    status: 'implemented',
    feature: 'browser bookmarks list',
  },
  {
    command: 'browser_list_history',
    status: 'implemented',
    feature: 'browser history list',
  },
  {
    command: 'computer_estop',
    status: 'implemented',
    feature: 'computer emergency stop',
  },
  {
    command: 'computer_session_disable',
    status: 'implemented',
    feature: 'computer session disable',
  },
  {
    command: 'computer_session_enable',
    status: 'implemented',
    feature: 'computer session enable',
  },
  {
    command: 'computer_status',
    status: 'implemented',
    feature: 'computer status query',
  },
  {
    command: 'core_compact_now',
    status: 'implemented',
    feature: 'manual conversation compaction',
  },
  {
    command: 'core_read_run_events',
    status: 'implemented',
    feature: 'run events stream read',
  },
  { command: 'kill_all', status: 'implemented', feature: 'kill all subagents' },
  {
    command: 'kill_subagent',
    status: 'implemented',
    feature: 'kill specific subagent',
  },
  {
    command: 'multi_device_set_enabled',
    status: 'implemented',
    feature: 'multi-device gateway state set',
  },
  {
    command: 'note_apply_ops',
    status: 'implemented',
    feature: 'note CRDT ops apply',
  },
  {
    command: 'note_detect_mirror_drift',
    status: 'implemented',
    feature: 'note mirror drift detection',
  },
  {
    command: 'note_document_apply_md',
    status: 'implemented',
    feature: 'note markdown apply',
  },
  {
    command: 'note_document_hydrate',
    status: 'implemented',
    feature: 'note document hydrate',
  },
  {
    command: 'note_import_mirror_proposal',
    status: 'implemented',
    feature: 'note mirror import proposal',
  },
  {
    command: 'note_query_blocks',
    status: 'implemented',
    feature: 'note blocks query',
  },
  {
    command: 'note_redo_text',
    status: 'implemented',
    feature: 'note redo text edit',
  },
  {
    command: 'note_send_to_note',
    status: 'implemented',
    feature: 'send content to note',
  },
  {
    command: 'note_undo_text',
    status: 'implemented',
    feature: 'note undo text edit',
  },
  {
    command: 'resume_subagent',
    status: 'implemented',
    feature: 'resume subagent execution',
  },
  {
    command: 'workbench_pty_attach',
    status: 'implemented',
    feature: 'workbench PTY attach',
  },
  {
    command: 'workbench_pty_detach',
    status: 'implemented',
    feature: 'workbench PTY detach',
  },
  {
    command: 'workbench_pty_ping',
    status: 'implemented',
    feature: 'workbench PTY ping liveness',
  },
];

export const TAURI_COMMAND_REGISTRY: ReadonlyMap<
  string,
  RegisteredTauriCommand
> = new Map(REGISTERED_TAURI_COMMANDS.map((entry) => [entry.command, entry]));

export interface TauriCommandRegistryDiff {
  invoked: string[];
  registered: string[];
  frontendRegistered: string[];
  frontendProductCommands: string[];
  frontendWiredCommands: string[];
  missingFrontendRegistry: string[];
  missingRustRegistration: string[];
  missing: string[];
}

export function extractInvokedTauriCommands(source: string): string[] {
  const commands = new Set<string>();
  let index = 0;

  while (index < source.length) {
    const invokeIndex = source.indexOf('invoke', index);
    if (invokeIndex === -1) break;

    const before = source[invokeIndex - 1];
    const after = source[invokeIndex + 'invoke'.length];
    if (isIdentifierChar(before) || isIdentifierChar(after)) {
      index = invokeIndex + 'invoke'.length;
      continue;
    }

    let cursor = skipWhitespace(source, invokeIndex + 'invoke'.length);
    if (source[cursor] === '<') {
      cursor = skipTypeArguments(source, cursor);
      if (cursor === -1) {
        index = invokeIndex + 'invoke'.length;
        continue;
      }
      cursor = skipWhitespace(source, cursor);
    }

    if (source[cursor] !== '(') {
      index = invokeIndex + 'invoke'.length;
      continue;
    }

    cursor = skipWhitespace(source, cursor + 1);
    const quote = source[cursor];
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      index = invokeIndex + 'invoke'.length;
      continue;
    }

    const end = source.indexOf(quote, cursor + 1);
    if (end === -1) {
      index = invokeIndex + 'invoke'.length;
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
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
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
  if (blocks.length === 0 && !source.includes('make_handlers!')) return [];

  const macros = extractMacroDefinitions(source);

  const commands = new Set<string>();
  for (const rawBlock of blocks) {
    const block = expandMacrosInBlock(rawBlock, macros);
    const withoutComments = block
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    for (const part of withoutComments.split(',')) {
      const commandPath = part.trim();
      if (!commandPath) continue;
      const match = commandPath.match(/(?:^|::)([A-Za-z_][A-Za-z0-9_]*)$/);
      if (match) commands.add(match[1] as string);
    }
  }

  // make_handlers!(args) is a thin wrapper around generate_handler! — any command
  // paths passed as arguments are registered Tauri commands (e.g. debug-only dev
  // CLI commands injected via register_handlers!(dev) => make_handlers!(...)).
  for (const cmd of extractMacroCallCommands(source, 'make_handlers')) {
    commands.add(cmd);
  }

  return [...commands].sort();
}

export function diffTauriCommandRegistry(
  bridgeSource: string,
  rustMainSource: string
): TauriCommandRegistryDiff {
  const invoked = extractInvokedTauriCommands(bridgeSource);
  const registered = extractRegisteredTauriCommands(rustMainSource);
  const frontendWiredCommands = REGISTERED_TAURI_COMMANDS.filter(
    shouldHaveTauriRegistration
  )
    .map((entry) => entry.command)
    .sort();
  const frontendProductCommands = REGISTERED_TAURI_COMMANDS.filter(
    isProductCapabilityCommand
  )
    .map((entry) => entry.command)
    .sort();
  const frontendRegistered = frontendProductCommands;
  const registeredSet = new Set(registered);
  const frontendRegistrySet = new Set<string>(
    REGISTERED_TAURI_COMMANDS.map((entry) => entry.command)
  );

  const missingFrontendRegistry = invoked.filter(
    (command) => !frontendRegistrySet.has(command)
  );
  const missingRustRegistration = frontendWiredCommands.filter(
    (command) => !registeredSet.has(command)
  );
  const missing = [
    ...new Set([...missingFrontendRegistry, ...missingRustRegistration]),
  ].sort();

  return {
    invoked,
    registered,
    frontendRegistered,
    frontendProductCommands,
    frontendWiredCommands,
    missingFrontendRegistry,
    missingRustRegistration,
    missing,
  };
}

export function commandCapabilityStatus(
  entry: RegisteredTauriCommand
): BackendCapabilityStatus {
  return entry.capabilityStatus ?? entry.status;
}

export function isProductCapabilityCommand(
  entry: RegisteredTauriCommand
): boolean {
  return (
    (entry.surface ?? 'product') === 'product' &&
    (entry.status === 'implemented' || entry.status === 'experimental') &&
    commandCapabilityStatus(entry) !== UNSUPPORTED_CODE
  );
}

export function shouldHaveTauriRegistration(
  entry: RegisteredTauriCommand
): boolean {
  return entry.tauriRegistration !== 'not-registered';
}

function readAllGenerateHandlerBlocks(source: string): string[] {
  const marker = 'generate_handler!';
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const markerIndex = source.indexOf(marker, searchFrom);
    if (markerIndex === -1) break;

    const start = source.indexOf('[', markerIndex + marker.length);
    if (start === -1) break;

    let depth = 0;
    let found = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === '[') depth += 1;
      if (char === ']') {
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
  const marker = 'command_registry!';
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const markerIndex = source.indexOf(marker, searchFrom);
    if (markerIndex === -1) break;

    // Skip the macro definition itself: `macro_rules! command_registry {`
    const prefix = source.slice(
      Math.max(0, markerIndex - 'macro_rules! '.length),
      markerIndex
    );
    if (prefix.endsWith('macro_rules! ')) {
      searchFrom = markerIndex + marker.length;
      continue;
    }

    const cursor = skipWhitespace(source, markerIndex + marker.length);
    const open = source[cursor];
    if (open !== '[' && open !== '(') {
      searchFrom = markerIndex + marker.length;
      continue;
    }
    const close = open === '[' ? ']' : ')';

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

function expandMacrosInBlock(
  block: string,
  macros: Map<string, string>
): string {
  let result = block;
  for (const [name, body] of macros) {
    const invocationPattern = new RegExp(name + '!\\(\\)', 'g');
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
    const prefix = source.slice(Math.max(0, idx - 'macro_rules! '.length), idx);
    if (prefix.endsWith('macro_rules! ')) {
      searchFrom = idx + marker.length;
      continue;
    }

    let cursor = idx + marker.length;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '(') {
      searchFrom = idx + marker.length;
      continue;
    }

    // Balanced paren matching to handle multi-line / nested call args.
    let depth = 0;
    let parenEnd = -1;
    for (let i = cursor; i < source.length; i += 1) {
      const char = source[i];
      if (char === '(') depth += 1;
      if (char === ')') {
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
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    for (const part of withoutComments.split(',')) {
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
  while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  return cursor;
}

function skipTypeArguments(source: string, start: number): number {
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === '<') depth += 1;
    if (char === '>') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return -1;
}

function isIdentifierChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_$]/.test(char));
}
