/**
 * C1.5 集中命令映射表 —— WS 消息 type → Tauri 命令名的唯一真源。
 *
 * C3.1：WS 链路删除后仅服务 Tauri 路径：
 * - 调用方（clientApi / engineStatus / gitApi …）统一以 **WS 消息 type** 调
 *   `transport.request(type, payload)`，TauriTransport 经 [resolveTauriCommand]
 *   换命令名后 invoke；
 * - 已迁移调用方直接传命令名（core_* 等）：清单校验通过则原样放行。
 *
 * PE-03 T03.1 注册表单一化（Rust 侧为唯一真源，本表由清单驱动）：
 * - **幽灵条目已删除**（AA-02 W-5，9 条）：git-status/git-diff、
 *   list/start/stop-mcp-server、preview/apply-conversation-rewind、
 *   send-to-subagent/get-subagent-status——Rust 侧不存在，一律不建条目；
 *   （对应调用方 gitApi / mcpApi / conversationRewindApi / subagentApi 的
 *   调用点裁决归 T03.7，本任务只清映射面。）
 * - [resolveTauriCommand] 解析结果必须落在 `core_list_commands` 清单的
 *   registered 命令内，否则返回 null（显式 missing）；
 * - `KNOWN_COMMAND_PREFIX` 前缀正则与 `RUN_LIFECYCLE_COMMANDS` 白名单删除
 *   （清单校验取代前缀正则，T03.1 动作 3）；
 * - [checkCommandMapConsistency] 运行时对照：映射值不在清单内 → 警告（不崩）。
 */

import { isRegisteredCommand } from './commandManifest';
import { logger } from '../../services/LoggerService';

/** ①/② 映射：WS 消息 type → Tauri 命令名（值必须全部 ∈ 清单 registered 命令） */
export const WS_TYPE_TO_TAURI_COMMAND: Readonly<Record<string, string>> = {
  // ── C1.4 查询类（① core_*）──
  'get-status': 'core_get_status',
  'get-run-snapshot': 'core_get_run_snapshot',
  'read-run-events': 'core_read_run_events',
  'read-session-events': 'core_read_session_events',
  // ── C1.3 审批类（① core_*）──
  'approve-tool': 'core_approve_tool',
  'deny-tool': 'core_deny_tool',
  // ── C1.5 杂项：② Tauri 壳命令 ──
  // 'update-config' → config_update（F5 终态名，PE-03 T03.4 已随 Rust 更名同步落地）
  'update-config': 'config_update',
  'list-sessions': 'list_sessions',
} as const;

/**
 * Tauri 路径命令解析：调用方传的 type 可能有两种形状——
 * 1. WS 消息 type（C1.5 新约定）→ 查表换命令名；
 * 2. 已经是命令名（清单 registered 内，含 run 生命周期）→ 原样放行。
 * 解析结果必须在清单内（清单校验取代前缀正则/白名单），否则 → null，
 * Tauri 路径抛「命令不可用」（显式 missing，不静默兜底）。
 */
export function resolveTauriCommand(type: string): string | null {
  const mapped = WS_TYPE_TO_TAURI_COMMAND[type];
  if (mapped) return isRegisteredCommand(mapped) ? mapped : null;
  if (isRegisteredCommand(type)) return type;
  return null;
}

/**
 * 运行时对照（启动拉取清单后调用）：commandMap 每个映射值都必须在清单
 * registered 命令内。不一致 → logger.warn（不崩）——用于捕获
 * 「映射指向已删除/未登记命令」的幽灵回归（AA-02 W-5 门禁）。
 */
export function checkCommandMapConsistency(): void {
  for (const [wsType, cmd] of Object.entries(WS_TYPE_TO_TAURI_COMMAND)) {
    if (!isRegisteredCommand(cmd)) {
      logger.warn(
        `[commandMap] 幽灵条目：'${wsType}' 映射到 '${cmd}'，但不在 core_list_commands 注册面内`,
        { module: 'transport' }
      );
    }
  }
}

/**
 * Tauri 路径 payload 整形（用于壳命令参数形状与 WS 协议不一致的场合，
 * 如 config_update 不接受 type 字段）。
 * PE-07 T07.4（K-05）：update-config 载荷剥离 apiKey（明文 key 一律走
 * config_secret_set / config_profile_apply，禁止经 update-config 通道）。
 * 幽灵命令（rewind 等）的整形条目已随映射删除（T03.1）。
 */
const PAYLOAD_SHAPERS: Readonly<Record<string, (p: Record<string, unknown>) => Record<string, unknown>>> = {
  'update-config': (p) => {
    const { type: _type, apiKey: _apiKey, ...rest } = p;
    return rest;
  },
};

/** Tauri 路径 payload 整形（无整形条目 → 原样） */
export function shapeTauriPayload(
  type: string,
  payload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const shaper = PAYLOAD_SHAPERS[type];
  if (!shaper || !payload) return payload;
  return shaper(payload);
}
