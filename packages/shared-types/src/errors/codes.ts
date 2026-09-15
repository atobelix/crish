// packages/shared-types/src/errors/codes.ts
// 错误码权威定义，来源：./03-ERROR-MIGRATION.md §2.2
// 实测码数：92 正式码 + 10 reserved 码 = 102 码 / 20 域
// （R6 扩展：新增 goal 域 3 码，event_store.read_failed 已在 R1 注册；
//  PE-03 T03.3 补 store.io / common.invalid_input / common.encoding；
//  F8-02：tool.write_path_conflict 并入（写路径互斥，agent-tools 局部码注册）；
//  R13/B3：tool.browser.* 9 码并入 tool 域（维度 17 §1.3 码表 + 22 裁决 U-12，
//  三段式点分码，isCrishErrorCode 放宽为多段形态）；
//  S5：tool.computer.* 8 码 + tool.session.exclusive + subagent.not_found 并入
//  （06 文档 §5 码表，码表同步轮；tool.session.exclusive 为跨线共享码））

export type CrishErrorCode =
  // ── config 域（3 正式码）──
  | 'config.invalid'
  | 'config.missing'
  | 'config.parse_failed'
  // ── session 域（6 正式码 + 1 跨线共享码）──
  | 'session.not_found'
  | 'session.invalid_session'
  | 'session.invalid_entry'
  | 'session.invalid_state'
  | 'session.storage_failed'
  | 'session.rewind_failed'
  // S5：会话互斥（S3 ActivationGate 跨线共享码：browser_* 与 computer_* 共用；
  // 登记归属 session 域，守卫检查点在审批之前）
  | 'tool.session.exclusive'
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
  // ── tool 域（10 正式码）──
  | 'tool.not_found'
  | 'tool.invalid_input'
  | 'tool.execution_failed'
  | 'tool.path_escape'
  | 'tool.version_conflict'
  | 'tool.write_not_allowed'
  // F8-02：写路径互斥冲突（I4-M3：同路径被其他持有者声明，与
  // write_not_allowed 越权语义独立——白名单放行但被占用仍返回本码）
  | 'tool.write_path_conflict'
  // session-integrity-repair 02 §4.1 F01：中断/取消/未知三码。
  // Rust 侧早已在 codes 模块与 CRISH_ERROR_REGISTRY 注册
  // （crates/conex-types/src/error.rs:115-119 与 :721-747），并在
  // session-loop 真实抛出（executing_tools.rs:58 aborted_before_dispatch /
  // exec_single.rs:98 + exec_verdict.rs:266 cancelled / hydrate.rs:378
  // outcome_unknown），但 TS 侧长期漏注册 ⇒ getErrorInfo 回退
  // common.unknown、动作建议丢失。F8-42 双向漂移门禁（codes-drift.test.ts）
  // 捕获此漏码，本次补齐。
  | 'tool.aborted_before_dispatch'
  | 'tool.cancelled'
  | 'tool.outcome_unknown'
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
  // ── tool.computer 子域（8 正式码，06 文档 §5 码表 + 04/18 文档语义）──
  // 电脑操作工具面：参数校验/坐标边界/提权窗口隔离/会话准入/恢复期 gating/
  // 急停取消/能力通道缺失/未接线占位
  | 'tool.computer.invalid_params'
  | 'tool.computer.coords_out_of_bounds'
  | 'tool.computer.elevated_window'
  | 'tool.computer.not_enabled'
  | 'tool.computer.not_ready'
  | 'tool.computer.cancelled'
  | 'tool.computer.capability_unavailable'
  | 'tool.computer.unwired'
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
  // ── subagent 域（4 正式码 + 1 reserved）──
  | 'subagent.depth_exceeded'
  | 'subagent.nesting_denied'
  | 'subagent.deadlock_detected'
  // S5：子代理不存在（D4 D-5：kill_subagent 等单目标操作的 NotFound 结构化错误码）
  | 'subagent.not_found'
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
