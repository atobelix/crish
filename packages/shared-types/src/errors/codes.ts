// packages/shared-types/src/errors/codes.ts
// 错误码权威定义，来源：./03-ERROR-MIGRATION.md §2.2
// 实测码数：82 正式码 + 10 reserved 码 = 92 码 / 20 域
// （R6 扩展：新增 goal 域 3 码，event_store.read_failed 已在 R1 注册；
//  PE-03 T03.3 补 store.io / common.invalid_input / common.encoding；
//  F8-02：tool.write_path_conflict 并入（写路径互斥，agent-tools 局部码注册）；
//  R13/B3：tool.browser.* 9 码并入 tool 域（维度 17 §1.3 码表 + 22 裁决 U-12，
//  三段式点分码，isCrishErrorCode 放宽为多段形态））

export type CrishErrorCode =
  // ── config 域（3 正式码）──
  | 'config.invalid'
  | 'config.missing'
  | 'config.parse_failed'
  // ── session 域（6 正式码）──
  | 'session.not_found'
  | 'session.invalid_session'
  | 'session.invalid_entry'
  | 'session.invalid_state'
  | 'session.storage_failed'
  | 'session.rewind_failed'
  // ── agent 域（3 reserved 码，无真实 throw 场景）──
  | 'agent.max_turns_reached'
  | 'agent.no_progress'
  | 'agent.intervention_required'
  // ── runtime 域（4 正式码）──
  | 'runtime.unexpected_state'
  | 'runtime.transition_failed'
  | 'runtime.aborted'
  | 'runtime.timeout'
  // ── provider 域（17 正式码）──
  | 'provider.network'
  | 'provider.gateway_challenge'
  | 'provider.rate_limit'
  | 'provider.auth'
  | 'provider.quota'
  | 'provider.endpoint_unavailable'
  | 'provider.schema'
  | 'provider.server'
  | 'provider.timeout'
  | 'provider.cancelled'
  | 'provider.stream_interrupted'
  | 'provider.unknown'
  | 'provider.connection_error'
  | 'provider.no_token'
  | 'provider.reauth_required'
  | 'provider.fatal'
  | 'provider.refresh_failed'
  // ── context 域（2 正式码 + 1 reserved）──
  | 'context.length_exceeded'
  | 'context.compaction_failed'
  | 'context.heal_failed'
  // ── tool 域（7 正式码）──
  | 'tool.not_found'
  | 'tool.invalid_input'
  | 'tool.execution_failed'
  | 'tool.path_escape'
  | 'tool.version_conflict'
  | 'tool.write_not_allowed'
  // F8-02：写路径互斥冲突（I4-M3：同路径被其他持有者声明，与
  // write_not_allowed 越权语义独立——白名单放行但被占用仍返回本码）
  | 'tool.write_path_conflict'
  // ── tool.browser 子域（9 正式码，维度 17 §1.3 码表 + 22 裁决 U-12；
  //    浏览器工具面：恢复期 gating（R-9）/域名门禁/能力位红线/急停 等）──
  | 'tool.browser.not_ready'
  | 'tool.browser.gate_blocked'
  | 'tool.browser.capability_disabled'
  | 'tool.browser.stale_snapshot'
  | 'tool.browser.node_gone'
  | 'tool.browser.cancelled'
  | 'tool.browser.eval_forbidden'
  | 'tool.browser.tab_limit_exceeded'
  | 'tool.browser.unwired'
  // ── mcp 域（3 正式码）──
  | 'mcp.connection_failed'
  | 'mcp.protocol_violation'
  | 'mcp.server_not_found'
  // ── store 域（5 正式码）──
  | 'store.write_failed'
  | 'store.read_failed'
  | 'store.corrupted'
  | 'store.capacity_exceeded'
  // PE-03 T03.3：存储/IO 失败（CoreError::Io 显式映射主码，与 store.write_failed 分流）
  | 'store.io'
  // ── subagent 域（3 正式码 + 1 reserved）──
  | 'subagent.depth_exceeded'
  | 'subagent.nesting_denied'
  | 'subagent.deadlock_detected'
  | 'subagent.timeout'
  // ── plugin 域（3 正式码）──
  | 'plugin.not_found'
  | 'plugin.activation_failed'
  | 'plugin.permission_denied'
  // ── approval 域（2 reserved 码）──
  | 'approval.timeout'
  | 'approval.rejected'
  // ── event_store 域（4 正式码）──
  | 'event_store.append_failed'
  | 'event_store.consistency_violation'
  | 'event_store.read_failed'
  | 'event_store.degraded'
  // ── artifact 域（2 正式码）──
  | 'artifact.not_found'
  | 'artifact.invalid_uri'
  // ── run 域（3 正式码）──
  | 'run.not_found'
  | 'run.invalid_state'
  | 'run.not_goal_run'
  // ── network 域（1 正式码 + 1 reserved）──
  | 'network.unreachable'
  | 'network.daemon_dead'
  // ── telemetry 域（1 正式码 + 2 reserved，含 log.write_failed）──
  // log.write_failed 归入 telemetry 域（@crish/logger 是 telemetry 基础设施）
  | 'telemetry.export_failed'
  | 'telemetry.trace_lost'
  | 'log.write_failed'
  // ── common 域（5 正式码）──
  | 'common.unknown'
  | 'common.unsupported'
  | 'common.not_found'
  // PE-03 T03.3：参数校验失败 / 编解码失败（CoreError::InvalidInput/Encoding 映射主码）
  | 'common.invalid_input'
  | 'common.encoding'
  // ── security 域（1 正式码，新增域）──
  | 'security.ssrf_rejected'
  // ── goal 域（3 正式码，R6 新增域）──
  // 用于 GoalLoopStrategy 的 FNV-1a 进度签名检测（与 agent.no_progress 语义不同）
  | 'goal.stalled'
  | 'goal.loop_detected'
  | 'goal.max_rounds';

/** 故障类别，保留现有 4 类（设计约束 1） */
export type CrishErrorCategory =
  'transient' | 'permanent' | 'security' | 'protocol';

/** 错误域枚举（20 域），用于按域聚合与路由 */
export const CRISH_ERROR_DOMAINS = [
  'config',
  'session',
  'agent',
  'runtime',
  'provider',
  'context',
  'tool',
  'mcp',
  'store',
  'subagent',
  'plugin',
  'approval',
  'event_store',
  'artifact',
  'run',
  'network',
  'telemetry',
  'common',
  'security',
  'goal',
] as const;

export type CrishErrorDomain = (typeof CRISH_ERROR_DOMAINS)[number];

/** 从错误码提取域前缀 */
export function domainOf(code: CrishErrorCode): CrishErrorDomain {
  return code.split('.')[0] as CrishErrorDomain;
}

/** 判断字符串是否为合法 CrishErrorCode（小写点分形态，两段或三段） */
export function isCrishErrorCode(value: string): value is CrishErrorCode {
  return /^[a-z_]+\.[a-z_]+(\.[a-z_]+)*$/.test(value);
}
