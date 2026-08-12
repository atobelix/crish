// 设备域命令构造与响应解析（R2-12 命令批 B6：设备域 5 条）
//
// 对齐依据：
// - 字段真源：crates/conex-types/contracts/device-protocol.json（C33-C37 参数/响应
//   类型 + commands 段 name/kind/paramsType/resultType/tauriCommand；M6 §4.6
//   逐条展开）；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params, timeoutMs?}
//   （M6 §3.1 / 生成解析器 parseCommandRequest，parser.ts:422-435），kind 与
//   body.command 后缀必须一致（生成解析器校验，drift.test.ts:161-175）；
// - 响应解析：复用生成解析器（parseListDevicesResult / parseGenericOkResult /
//   parsePairStateResult / parseUnlinkResult，parser.ts:458, 1937-1998）——
//   不手写第二套字段校验（M5 §1.3 组合纪律：响应类型从 @crish/shared-types
//   生成包引用，不手抄字段）；本文件只做「命令名 → 解析器」的分发与类型收口；
// - 只读纪律：本轮只构造命令体不发送（WsGateway.invoke 接线在后续轮次）；
//   C33-C37 均为 registered=false 的新增面（服务端 device_registry_* /
//   pairing_service_query 未接线，M6 §12.4），移动端构造侧先行、桌面端
//   新增面待接线；
// - queryPresence（C32）归属裁定：注册表 commands 段 domain=settings
//   （device-protocol.json:2883，M6 §4.5.0 F6 设置域总表）——**归 B5 设置批**
//   （settingsCommands.ts 已实现 buildQueryPresenceRequest），本批不重复实现
//   （R2-07 映射表 B6 节备注「queryPresence 归属判定」）；
// - 桌面端核对（只读，R2-07 映射表「B6 设备域」节）：C33-C36 与
//   multi_device_list_devices / multi_device_rename_device / multi_device_revoke_device /
//   multi_device_pair_status 语义对齐——身份键（令牌哈希 hash vs 注册表 deviceId）、
//   名称上限（桌面 label 1-40 vs 注册表 name ≤64）等差异见映射表 D-08~D-11；
// - 撤销 401 语义：revoke/unlink 后本设备令牌立即失效 → 后续请求 401
//   （auth.device_revoked / auth.unknown_device，errors.ts DEVICE_ERROR_PROTOCOL；
//   桌面端 multi_device_commands.rs:47-49 注释「令牌全部失效后 REST 鉴权自然 401」
//   同口径）。

import type {
  ListDevicesResult,
  RenameDeviceParams,
  RevokeDeviceParams,
  GenericOkResult,
  PairStateResult,
  UnlinkResult,
  CommandRequest,
} from '../../../../../packages/shared-types/src/generated/device/types';
import {
  parseListDevicesResult as parseWireListDevicesResult,
  parseGenericOkResult as parseWireGenericOkResult,
  parsePairStateResult as parseWirePairStateResult,
  parseUnlinkResult as parseWireUnlinkResult,
} from '../../../../../packages/shared-types/src/generated/device/parser';
import type { ParseResult } from '../../../../../packages/shared-types/src/generated/device/parser';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** B6 设备域 5 条命令名（C33-C37，M6 §4.6.0 总表；注册表 domain=devices） */
export type DeviceCommandName =
  'listDevices' | 'renameDevice' | 'revokeDevice' | 'getPairState' | 'unlink';

/** B6 设备域 5 条命令 kind（协议层消息类别，M6 §3.1） */
export type DeviceCommandKind =
  | 'remote.listDevices'
  | 'remote.renameDevice'
  | 'remote.revokeDevice'
  | 'remote.getPairState'
  | 'remote.unlink';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.，M6 §4.0） */
export const DEVICE_COMMAND_KIND: Record<DeviceCommandName, DeviceCommandKind> =
  {
    listDevices: 'remote.listDevices',
    renameDevice: 'remote.renameDevice',
    revokeDevice: 'remote.revokeDevice',
    getPairState: 'remote.getPairState',
    unlink: 'remote.unlink',
  };

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface DeviceCommandRequest {
  kind: DeviceCommandKind;
  body: CommandRequest;
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────
// 注：params 以展开字面量 { ...params } 传给 CommandRequest.params（JsonValue）——
// 生成接口类型无隐式索引签名，展开后为对象字面量类型可赋给索引签名面（TS2322 规避）。

/** C33 设备列表（F6 §6.2 / M6 §4.6.1）：参数恒空对象；响应 devices 条目 =
 * DeviceEntry（deviceId 短显前 4 后 2；needsReauth = 桌面重装后配对失效标记） */
export function buildListDevicesRequest(): DeviceCommandRequest {
  return {
    kind: 'remote.listDevices',
    body: { command: 'listDevices', params: {} },
  };
}

/** C34 设备重命名（M6 §4.6.2）：deviceId 必填、name 必填（注册表 name ≤64；
 * 构造侧原样透传不重算——长度校验归属服务端新增面 device_registry_update） */
export function buildRenameDeviceRequest(
  params: RenameDeviceParams
): DeviceCommandRequest {
  return {
    kind: 'remote.renameDevice',
    body: { command: 'renameDevice', params: { ...params } },
  };
}

/** C35 撤销设备（M6 §4.6.2）：deviceId 必填；响应 GenericOkResult（撤销已撤销
 * = 成功，幂等天然）；桌面撤销后该设备令牌立即失效 → 后续请求 401 */
export function buildRevokeDeviceRequest(
  params: RevokeDeviceParams
): DeviceCommandRequest {
  return {
    kind: 'remote.revokeDevice',
    body: { command: 'revokeDevice', params: { ...params } },
  };
}

/** C36 配对状态查询（配对页多端一致性核对，M6 §4.6.3）：参数恒空对象；
 * 响应 state ∈ none/scanning/inputting/handshaking/done/failed（F6 §6.4）+
 * desktopId 可选；本地状态机为主，本命令用于跨端核对（接线层映射，见测试） */
export function buildGetPairStateRequest(): DeviceCommandRequest {
  return {
    kind: 'remote.getPairState',
    body: { command: 'getPairState', params: {} },
  };
}

/** C37 解除本设备配对（M6 §4.6.2）：参数恒空对象（UnlinkParams 空——解除本设备，
 * 桌面删除本设备表条目 + 广播 device.revoked，令牌立即失效 → 后续请求 401） */
export function buildUnlinkRequest(): DeviceCommandRequest {
  return {
    kind: 'remote.unlink',
    body: { command: 'unlink', params: {} },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** B6 设备域 5 条命令响应载荷联合（生成 resultType 全集；
 * renameDevice/revokeDevice 共用 GenericOkResult） */
export type DeviceCommandResultPayload =
  ListDevicesResult | GenericOkResult | PairStateResult | UnlinkResult;

/** 命令名 → 响应载荷类型映射（生成 resultType，M6 §4.6 总表） */
export interface DeviceCommandResultMap {
  listDevices: ListDevicesResult;
  renameDevice: GenericOkResult;
  revokeDevice: GenericOkResult;
  getPairState: PairStateResult;
  unlink: UnlinkResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷，M6 §6.1；
 * WsGateway.invoke 已解信封并校验 CommandResult 骨架，此处校验 result 内容）。
 * 解析器全部来自生成面（parser.ts），必填字段缺省/类型错 → 拒绝；
 * 桌面端多余字段（注册表未登记）被宽容忽略（生成解析器仅按注册表字段抽取）。
 */
export function parseDeviceCommandResult<T extends DeviceCommandName>(
  command: T,
  raw: unknown
): ParseResult<DeviceCommandResultMap[T]> {
  const result = parseAnyDeviceCommandResult(command, raw);
  return result as ParseResult<DeviceCommandResultMap[T]>;
}

function parseAnyDeviceCommandResult(
  command: DeviceCommandName,
  raw: unknown
): ParseResult<DeviceCommandResultPayload> {
  switch (command) {
    case 'listDevices':
      return parseWireListDevicesResult(raw);
    case 'renameDevice':
      return parseWireGenericOkResult(raw);
    case 'revokeDevice':
      return parseWireGenericOkResult(raw);
    case 'getPairState':
      return parseWirePairStateResult(raw);
    case 'unlink':
      return parseWireUnlinkResult(raw);
  }
}
