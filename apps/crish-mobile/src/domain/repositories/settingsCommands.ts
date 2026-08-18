// F6 设置与账户域命令构造与响应解析（R2-11 命令批 B5：5 条设置命令）
//
// 对齐依据：
// - 字段真源：crates/conex-types/contracts/device-protocol.json（C28-C32 参数/响应
//   类型 + commands 段 name/kind/paramsType/resultType/tauriCommand；M6 §4.5 逐条展开）；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params, timeoutMs?}
//   （M6 §3.1 / 生成解析器 parseCommandRequest，parser.ts:422-435），kind 与
//   body.command 后缀必须一致（生成解析器校验，drift.test.ts:161-175）；
// - 响应解析：复用生成解析器（parseGetSettingsResult 等，parser.ts:1784-1891）——
//   不手写第二套字段校验（M5 §1.3 组合纪律：响应类型从 @crish/shared-types
//   生成包引用，不手抄字段）；本文件只做「命令名 → 解析器」的分发与类型收口；
// - 只读纪律：本轮只构造命令体不发送（WsGateway.invoke 接线在后续轮次）；
// - 桌面端核对（只读，R2-07 映射表「B5 设置批」节）：C28/C29 ↔ /v1/settings
//   GET/PUT（R1-04 直调面），C30/C31/C32 无对应端点（registered=false 待接线），
//   差异清单与判定见映射表；
// - B5 条数裁定：queryPresence（C32）注册表 commands 段 domain=settings
//   （device-protocol.json:2883），归本批 B5，共 5 条（与 M6 §4.5.0 总表一致）；
// - fail-closed 语义：REST PUT /v1/settings 对 credentialMode/endpoint/stream
//   显式拒绝 cmd.invalid（core_run_commands.rs:7102-7106，不静默忽略）；
//   协议层 setSettings 的 key 白名单恒 3 键（SettingsKey，M6 §4.5.2）。

import type {
  GetSettingsParams,
  GetSettingsResult,
  SetSettingsParams,
  SetSettingsResult,
  SettingsConfirmParams,
  SettingsConfirmResult,
  PauseAutomationParams,
  PauseAutomationResult,
  PresenceResult,
  CommandRequest,
} from '@crish/shared-types';
import {
  parseGetSettingsResult as parseWireGetSettingsResult,
  parseSetSettingsResult as parseWireSetSettingsResult,
  parseSettingsConfirmResult as parseWireSettingsConfirmResult,
  parsePauseAutomationResult as parseWirePauseAutomationResult,
  parsePresenceResult as parseWirePresenceResult,
} from '@crish/shared-types';
import type { ParseResult } from '@crish/shared-types';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** F6 设置域 5 条命令名（C28-C32，M6 §4.5.0 总表；含 queryPresence——
 * 注册表 commands 段 domain=settings，归本批 B5） */
export type SettingsCommandName =
  | 'getSettings'
  | 'setSettings'
  | 'settingsConfirm'
  | 'pauseAutomation'
  | 'queryPresence';

/** F6 设置域 5 条命令 kind（协议层消息类别，M6 §3.1） */
export type SettingsCommandKind =
  | 'remote.getSettings'
  | 'remote.setSettings'
  | 'remote.settingsConfirm'
  | 'remote.pauseAutomation'
  | 'remote.queryPresence';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.，M6 §4.0） */
export const SETTINGS_COMMAND_KIND: Record<
  SettingsCommandName,
  SettingsCommandKind
> = {
  getSettings: 'remote.getSettings',
  setSettings: 'remote.setSettings',
  settingsConfirm: 'remote.settingsConfirm',
  pauseAutomation: 'remote.pauseAutomation',
  queryPresence: 'remote.queryPresence',
};

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface SettingsCommandRequest {
  kind: SettingsCommandKind;
  body: CommandRequest;
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────
// 注：params 以展开字面量 { ...params } 传给 CommandRequest.params（JsonValue）——
// 生成接口类型无隐式索引签名，展开后为对象字面量类型可赋给索引签名面（TS2322 规避）。

/** C28 设置镜像拉取：keys 白名单子集可选（responseStyle/enableAnalytics/
 * enableCrashTelemetry/permissionMode/trustedCommandCount/activeProfileId/
 * defaultModel/usageSummary）；apiKey 恒空串脱敏由桌面端保证 */
export function buildGetSettingsRequest(
  params?: GetSettingsParams
): SettingsCommandRequest {
  return {
    kind: 'remote.getSettings',
    body: { command: 'getSettings', params: { ...params } },
  };
}

/** C29 非安全设置变更：key 白名单恒 3 键（SettingsKey，其余 settings.key_denied）；
 * value 为 string | boolean；两态响应（直接生效 / pending 60s 超时视为拒绝） */
export function buildSetSettingsRequest(
  params: SetSettingsParams
): SettingsCommandRequest {
  return {
    kind: 'remote.setSettings',
    body: { command: 'setSettings', params: { ...params } },
  };
}

/** C30 桌面确认请求撤回/查询：confirmRequestId 必填 + action ∈ withdraw/query；
 * withdraw 幂等（撤回已撤回 = 成功） */
export function buildSettingsConfirmRequest(
  params: SettingsConfirmParams
): SettingsCommandRequest {
  return {
    kind: 'remote.settingsConfirm',
    body: { command: 'settingsConfirm', params: { ...params } },
  };
}

/** C31 临时暂停自动执行：durationSec 可选（默认 3600、上限 86400）；一次性
 * 指令不改变持久化配置；重复暂停刷新 pausedUntil（msgId 幂等） */
export function buildPauseAutomationRequest(
  params?: PauseAutomationParams
): SettingsCommandRequest {
  return {
    kind: 'remote.pauseAutomation',
    body: { command: 'pauseAutomation', params: { ...params } },
  };
}

/** C32 桌面在场查询：参数恒空对象（双因素「桌面在场」信号源，F2 §9.2） */
export function buildQueryPresenceRequest(): SettingsCommandRequest {
  return {
    kind: 'remote.queryPresence',
    body: { command: 'queryPresence', params: {} },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** F6 设置域 5 条命令响应载荷联合（生成 resultType 全集） */
export type SettingsCommandResultPayload =
  | GetSettingsResult
  | SetSettingsResult
  | SettingsConfirmResult
  | PauseAutomationResult
  | PresenceResult;

/** 命令名 → 响应载荷类型映射（生成 resultType，M6 §4.5 总表） */
export interface SettingsCommandResultMap {
  getSettings: GetSettingsResult;
  setSettings: SetSettingsResult;
  settingsConfirm: SettingsConfirmResult;
  pauseAutomation: PauseAutomationResult;
  queryPresence: PresenceResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷，M6 §6.1；
 * WsGateway.invoke 已解信封并校验 CommandResult 骨架，此处校验 result 内容）。
 * 解析器全部来自生成面（parser.ts），必填字段缺省/类型错 → 拒绝；
 * 桌面端多余字段（注册表未登记）被宽容忽略（生成解析器仅按注册表字段抽取）。
 */
export function parseSettingsCommandResult<T extends SettingsCommandName>(
  command: T,
  raw: unknown
): ParseResult<SettingsCommandResultMap[T]> {
  const result = parseAnySettingsCommandResult(command, raw);
  return result as ParseResult<SettingsCommandResultMap[T]>;
}

function parseAnySettingsCommandResult(
  command: SettingsCommandName,
  raw: unknown
): ParseResult<SettingsCommandResultPayload> {
  switch (command) {
    case 'getSettings':
      return parseWireGetSettingsResult(raw);
    case 'setSettings':
      return parseWireSetSettingsResult(raw);
    case 'settingsConfirm':
      return parseWireSettingsConfirmResult(raw);
    case 'pauseAutomation':
      return parseWirePauseAutomationResult(raw);
    case 'queryPresence':
      return parseWirePresenceResult(raw);
  }
}
