/**
 * C1.5 集中命令名清单 —— Tauri 路径的纯命令名白名单（T18 终态）。
 *
 * C3.1：WS 链路已删除；T18 起不再有「WS 消息 type → 命令名」双命名空间：
 * - 调用方（clientApi / engineStatus / chat-bridge …）统一以 **命令名** 调
 *   `transport.request(cmd, payload)` / `transport.send(cmd, payload)`；
 * - [resolveTauriCommand] 降级为直接校验命令名清单（缺失映射层）：
 *   命令名 ∈ Rust 侧 `core_list_commands` 的 registered 面 → 原样放行，否则 null。
 *
 * PE-03 T03.1 注册表单一化（Rust 侧为唯一真源，本清单由命令名驱动）：
 * - **WS 时代幽灵条目已删除**（AA-02 W-5，9 条）：git-status/git-diff、
 *   list/start/stop-mcp-server、preview/apply-conversation-rewind、
 *   send-to-subagent/get-subagent-status 等 WS 消息 type 不再存在，
 *   一律不建条目（对应调用点裁决归 T03.7，本任务只清映射面）；
 * - 本清单仅保留 transport 域直接依赖的命令名（值必须全部 ∈ 清单 registered）；
 * - [resolveTauriCommand] 解析结果必须落在 `core_list_commands` 清单的
 *   registered 命令内，否则返回 null（显式 missing）；
 * - [checkCommandMapConsistency] 运行时对照：清单内命令名不在注册面 → 警告（不崩）。
 */

import { isRegisteredCommand } from './commandManifest';
import { logger } from '../../services/LoggerService';

/**
 * 纯命令名白名单（T18：WS 双命名空间已删除，条目全部为命令名直传）。
 * 调用方以命令名调用 transport；本清单供
 * [checkCommandMapConsistency] 的幽灵回归门禁使用（每条必须 ∈ 清单 registered 命令）。
 */
export const COMMAND_NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  // ── 查询类（core_*）──
  'core_get_status',
  'core_get_run_snapshot',
  'core_read_run_events',
  'core_read_session_events',
  // ── 审批类（core_*）──
  'core_approve_tool',
  'core_deny_tool',
  // ── 壳命令（config / session，F5 终态名：config_update / list_sessions）──
  'config_update',
  'list_sessions',
]);

/**
 * 命令名解析（T18 终态）：调用方传入的必须是命令名——直接在清单
 * registered 面内校验，命中则原样放行，否则 → null（显式 missing，
 * Tauri 路径抛「命令不可用」，不静默兜底）。
 * 已无 WS 消息 type → 命令名的映射层（双命名空间已消除）。
 */
export function resolveTauriCommand(cmd: string): string | null {
  return isRegisteredCommand(cmd) ? cmd : null;
}

/**
 * 运行时对照（启动拉取清单后调用）：白名单内每个命令名都必须在清单
 * registered 命令内。不一致 → logger.warn（不崩）——用于捕获
 * 「依赖命令已删除/未登记」的幽灵回归（AA-02 W-5 门禁）。
 */
export function checkCommandMapConsistency(): void {
  for (const cmd of COMMAND_NAME_ALLOWLIST) {
    if (!isRegisteredCommand(cmd)) {
      logger.warn(
        `[commandMap] 幽灵条目：命令名 '${cmd}' 不在 core_list_commands 注册面内`,
        { module: 'transport' }
      );
    }
  }
}

/**
 * Tauri 路径 payload 整形（用于壳命令参数形状与协议不一致的场合，
 * 如 config_update 不接受 type 字段）。键为命令名（T18：与调用侧对齐，
 * 无 WS 消息 type 键）。
 * PE-07 T07.4（K-05）：update-config 载荷剥离 apiKey（明文 key 一律走
 * config_secret_set / config_profile_apply，禁止经 config_update 通道）。
 * 幽灵命令（rewind 等）的整形条目已随映射删除（T03.1）。
 */
const PAYLOAD_SHAPERS: Readonly<Record<string, (p: Record<string, unknown>) => Record<string, unknown>>> = {
  config_update: (p) => {
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
