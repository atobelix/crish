/**
 * 命令清单（PE-03 T03.1）—— Rust 侧 `core_list_commands` 的前端镜像层。
 *
 * 真源声明：Rust 侧 `src-tauri/src/command_manifest.rs` 为唯一真源；本模块：
 * - [BUILTIN_COMMAND_MANIFEST]：内置快照（镜像 Rust `COMMAND_MANIFEST`，启动拉取
 *   失败 / 非 Tauri 环境的回退面；双端手工同步，条数由本模块测试锁定）；
 * - [initCommandManifest]：启动时经 `invokeTyped('core_list_commands')` 拉取真源并缓存；
 * - [isRegisteredCommand]：`resolveTauriCommand` 的清单校验——只有 `registered: true`
 *   的命令可调用（登记先行命令 registered=false，调用即显式 missing）。
 *
 * 运行时对照：拉取成功后由 transport 层调用 commandMap 的
 * `checkCommandMapConsistency`，发现幽灵回归 → logger.warn（不崩）。
 */

import { invokeTyped } from '../tauriInvoke';

/** 契约版本（semver，§2.5 约定；与 Rust COMMAND_MANIFEST_CONTRACT_VERSION 同步） */
export const COMMAND_MANIFEST_CONTRACT_VERSION = '1.0.0';

/** 清单条目（对应 Rust CommandManifestEntry，serde camelCase） */
export interface CommandManifestEntry {
  name: string;
  /** 分组（core / config / session / md / perf / workbench） */
  family: string;
  /** 契约面：engine = 引擎契约面（三端共用）；gui = GUI 专属面 */
  surface: string;
  /** 是否已挂入 Rust invoke_handler（登记先行命令为 false） */
  registered: boolean;
}

/** 命令清单（对应 Rust CommandManifest） */
export interface CommandManifest {
  contractVersion: string;
  commands: CommandManifestEntry[];
}

/** 条目构造 helper（内置快照缩排用） */
function entry(
  name: string,
  family: string,
  surface: 'engine' | 'gui',
  registered = true
): CommandManifestEntry {
  return { name, family, surface, registered };
}

/**
 * 内置快照：镜像 Rust `COMMAND_MANIFEST`（75 = 注册面 71 + 登记先行 4；§7.2 推算 ≈75）。
 * 维护规则与 Rust 侧一致：registered 子集 = `make_handlers!` 注册面；新命令经
 * §7.2 登记表登记后追加在表尾（registered 随接线状态翻转）；双端漂移由
 * commandManifest.test.ts 的条数/登记断言拦截。
 */
export const BUILTIN_COMMAND_MANIFEST: CommandManifest = {
  contractVersion: COMMAND_MANIFEST_CONTRACT_VERSION,
  commands: [
    // ── GUI 专属面（workbench_*，§2.3）──
    entry('workbench_run_shell', 'workbench', 'gui'),
    // PE-07 T07.3（C-02/C-03/C-04）：git 参数数组执行 + 参数 schema 白名单；删除走 Rust 侧
    entry('workbench_git_run', 'workbench', 'gui'),
    entry('workbench_fs_delete_file', 'workbench', 'gui'),
    entry('workbench_pty_create', 'workbench', 'gui'),
    entry('workbench_pty_write', 'workbench', 'gui'),
    entry('workbench_pty_resize', 'workbench', 'gui'),
    entry('workbench_pty_kill', 'workbench', 'gui'),
    entry('workbench_list_host_openers', 'workbench', 'gui'),
    entry('workbench_open_host_target', 'workbench', 'gui'),
    entry('workbench_open_path_default', 'workbench', 'gui'),
    entry('workbench_list_file_openers', 'workbench', 'gui'),
    entry('workbench_select_folder', 'workbench', 'gui'),
    entry('workbench_list_directory', 'workbench', 'gui'),
    entry('workbench_read_file_content', 'workbench', 'gui'),
    entry('workbench_write_file_content', 'workbench', 'gui'),
    entry('workbench_discover_skills', 'workbench', 'gui'),
    entry('workbench_http_request', 'workbench', 'gui'),
    entry('workbench_apply_update', 'workbench', 'gui'),
    // ── 配置族（§2.2-C，F5 终态名：config_get/config_update/config_secret_*）──
    // PE-07 T07.4（K-01/K-02）：config_profile_apply / config_secret_reveal 已接线
    entry('config_get', 'config', 'engine'),
    entry('config_update', 'config', 'engine'),
    entry('config_secret_set', 'config', 'engine'),
    entry('config_secret_get', 'config', 'engine'),
    entry('config_secret_has', 'config', 'engine'),
    entry('config_secret_clear', 'config', 'engine'),
    entry('config_profile_apply', 'config', 'engine'),
    entry('config_secret_reveal', 'config', 'engine'),
    // ── 工具旧组（E1，§2.2-E）──
    entry('core_check_command', 'core', 'engine'),
    entry('core_search_files', 'core', 'engine'),
    entry('core_rebuild_search_index', 'core', 'engine'),
    entry('core_compact_messages', 'core', 'engine'),
    entry('core_count_tokens', 'core', 'engine'),
    entry('core_compute_diff', 'core', 'engine'),
    // ── 查询与运行（A/B，§2.2）──
    entry('core_get_status', 'core', 'engine'),
    entry('core_get_run_snapshot', 'core', 'engine'),
    entry('core_read_run_events', 'core', 'engine'),
    entry('core_read_session_events', 'core', 'engine'),
    entry('core_run_task', 'core', 'engine'),
    entry('core_run_control', 'core', 'engine'),
    entry('core_cancel_run', 'core', 'engine'),
    entry('core_approve_tool', 'core', 'engine'),
    entry('core_deny_tool', 'core', 'engine'),
    // ── 会话持久化（B，§2.2；含 F3 冻结的 upsert_session_entry）──
    entry('list_sessions', 'session', 'engine'),
    entry('load_session_body', 'session', 'engine'),
    entry('save_session_body', 'session', 'engine'),
    entry('delete_session', 'session', 'engine'),
    entry('load_session_agents', 'session', 'engine'),
    entry('save_session_agents', 'session', 'engine'),
    entry('get_session_meta', 'session', 'engine'),
    entry('set_session_meta', 'session', 'engine'),
    entry('cleanup_orphan_sessions', 'session', 'engine'),
    entry('import_from_localstorage', 'session', 'engine'),
    entry('touch_session', 'session', 'engine'),
    entry('upsert_session_entry', 'session', 'engine'),
    // ── Markdown（D，T03.4 更名 core_md_*，并入 core 族）──
    entry('core_md_render', 'core', 'engine'),
    entry('core_md_render_batch', 'core', 'engine'),
    entry('core_md_render_stream', 'core', 'engine'),
    entry('core_highlight_code', 'core', 'engine'),
    entry('core_md_clear_cache', 'core', 'engine'),
    // ── 工具 Worker 组（E，§2.2；core_jsonl_append 自 perf 迁移）──
    entry('core_hash_compute', 'core', 'engine'),
    entry('core_base64_encode', 'core', 'engine'),
    entry('core_base64_decode', 'core', 'engine'),
    entry('core_detect_encoding', 'core', 'engine'),
    entry('core_decode_text', 'core', 'engine'),
    entry('core_parse_diff', 'core', 'engine'),
    entry('core_messages_to_jsonl', 'core', 'engine'),
    entry('core_jsonl_to_messages', 'core', 'engine'),
    entry('core_text_encode', 'core', 'engine'),
    entry('core_jsonl_append', 'core', 'engine'),
    // ── 注册表单一化自身（T03.1）──
    entry('core_list_commands', 'core', 'engine'),
    // ── 模型目录（P3 步骤 5：catalog_get / catalog_refresh；C7 三处登记 ③）──
    entry('catalog_get', 'core', 'engine'),
    entry('catalog_refresh', 'core', 'engine'),
    // ── 登记先行（§7.2 登记表，AU-04 F12-C13；实现方各自负责，接线后翻 true）──
    // PE-07 T07.4：config_profile_apply / config_secret_reveal 已接线（registered=true）
    entry('append_session_messages', 'session', 'engine', false),
    entry('workbench_open_workspace', 'workbench', 'gui', false),
    entry('workbench_list_workspaces', 'workbench', 'gui', false),
    entry('workbench_dev_mcp_enabled', 'workbench', 'gui', false),
  ],
};

/** 启动拉取到的真源清单（null = 未拉取成功，回退内置快照） */
let cachedManifest: CommandManifest | null = null;
/** 拉取进行中/已完成的 promise（幂等防并发） */
let manifestInitStarted: Promise<CommandManifest> | null = null;

/** 当前生效清单：拉取成功用真源，否则内置快照 */
export function getEffectiveManifest(): CommandManifest {
  return cachedManifest ?? BUILTIN_COMMAND_MANIFEST;
}

/** 已 registered 命令名集合缓存（按清单实例记忆） */
const registeredNameCache = new WeakMap<CommandManifest, ReadonlySet<string>>();

function registeredNamesOf(manifest: CommandManifest): ReadonlySet<string> {
  let set = registeredNameCache.get(manifest);
  if (!set) {
    set = new Set(
      manifest.commands.filter((c) => c.registered).map((c) => c.name)
    );
    registeredNameCache.set(manifest, set);
  }
  return set;
}

/**
 * 清单校验：命令名必须在清单内且 registered=true 才可调用。
 * （登记先行命令 registered=false——尚未接线，调用即显式 missing。）
 */
export function isRegisteredCommand(name: string): boolean {
  return registeredNamesOf(getEffectiveManifest()).has(name);
}

/**
 * 启动拉取：`core_list_commands` 拉取真源清单并缓存（幂等）。
 * 失败 / 非 Tauri 环境 / 载荷非法 → 保持内置快照回退（不崩，不重试）。
 */
export async function initCommandManifest(): Promise<CommandManifest> {
  if (manifestInitStarted) return manifestInitStarted;
  manifestInitStarted = (async () => {
    try {
      const res = await invokeTyped<CommandManifest>('core_list_commands', {});
      if (
        res.status === 'ok' &&
        Array.isArray(res.data?.commands) &&
        res.data.commands.length > 0
      ) {
        cachedManifest = res.data;
      }
    } catch {
      // 拉取异常：回退内置快照（getEffectiveManifest 兜底，不崩）
    }
    return getEffectiveManifest();
  })();
  return manifestInitStarted;
}

/**
 * 测试钩子：注入 / 重置清单状态。
 * - 无参或传 null：回退内置快照（默认行为）；
 * - 传自定义清单：模拟 Rust 真源（mock 清单对照测试用）。
 */
export function resetCommandManifestForTests(
  manifest?: CommandManifest | null
): void {
  manifestInitStarted = null;
  cachedManifest = manifest ?? null;
}
