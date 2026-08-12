// 配对协议层（R2-03）：pair.hello 构造 + pair.ok/pair.error 帧解析
//
// 对齐依据：
// - pair.hello 字段：D3 §4.8 step 1 / crates/conex-types/contracts/
//   device-protocol.json message 1（PairHello：code/deviceId/mobilePub/
//   mobileLongPub/deviceName/platform）与生成类型 PairHello；
// - code 传输形态：Rust PairCode 序列化为 12 位无前缀无分隔符（pair.rs:99-103），
//   入站经 serde 自动标准化（容错前缀/分隔符/大小写）；
// - pair.ok 的 token 扩展：桌面端 pair_endpoint.rs pair_ok_body 在 D3 PairOk
//   {desktopId, ttl} 之外附加 token 明文（R1-11 任务书要求 ok 含 token；
//   生成解析器对未知字段宽松，对拍不受影响）；
// - error 帧：ErrorBody（D3 §6.2 设备错误码），pair.* 错误码映射见
//   pairProtocolErrorKind 的注册表对应关系（errors.ts DEVICE_ERROR_PROTOCOL）。
//
// 类型纪律（M5 §1.3 组合纪律）：wire 形状引用生成面（PairHello/PairOk/
// Platform/ErrorBody），领域附加字段（PairOkResult.token、PairErrorInfo）
// 用「契约类型 & 本地附加」的组合形式，不复制契约字段定义。

import { normalizePairCode, PAIR_CODE_ALPHABET } from './cxnCode';
import {
  parseErr,
  parseOk,
} from '../../../../packages/shared-types/src/generated/device/parser';
import type { ParseResult } from '../../../../packages/shared-types/src/generated/device/parser';
import { parsePairOk as parseWirePairOk } from '../../../../packages/shared-types/src/generated/device/parser';
import type {
  PairHello,
  PairOk,
  Platform,
} from '../../../../packages/shared-types/src/generated/device/types';

/** 设备名上限（注册表 maxLength 64；pair_endpoint.rs:164 同口径截断） */
export const DEVICE_NAME_MAX_LENGTH = 64;
/** 设备名空值兜底（pair_endpoint.rs:165-169 "remote-device" 同口径） */
export const DEVICE_NAME_FALLBACK = 'remote-device';
/** 设备 id 长度下限/上限（D3 §11.3 PairHello deviceId 8-64） */
export const DEVICE_ID_MIN_LENGTH = 8;
export const DEVICE_ID_MAX_LENGTH = 64;

/**
 * 生成设备 id（移动端设备身份，D3 §4.5：移动端生成 UUID；wire 约束 8-64
 * 字符）。随机源可注入（默认 Math.random）——纯计算无副作用。格式
 * `dev-<10 位 base32>`（14 字符，落在 8-64 区间内）。
 */
export function generateDeviceId(rand: () => number = Math.random): string {
  const length = 10;
  const maxIndex = PAIR_CODE_ALPHABET.length - 1;
  let suffix = '';
  for (let i = 0; i < length; i += 1) {
    suffix +=
      PAIR_CODE_ALPHABET[
        Math.min(maxIndex, Math.floor(rand() * PAIR_CODE_ALPHABET.length))
      ];
  }
  return `dev-${suffix}`;
}

/** buildPairHello 入参（code 容错输入；deviceId 可选 = 自动生成） */
export interface BuildPairHelloInput {
  /** 配对码（容错：大小写/前缀/分隔符均可，输出标准化 12 位） */
  code: string;
  /** 设备 id（缺省自动生成；对齐 D3 §4.5 移动端生成） */
  deviceId?: string;
  /** 设备名（≤64，空串兜底 "remote-device"，与桌面端 label 口径一致） */
  deviceName: string;
  /** 端平台（可选，wire lowercase） */
  platform?: Platform;
  /** X25519 一次性公钥 base64（密钥协商接线点：R2-03 未覆盖项，上层注入） */
  mobilePub?: string;
  /** 移动长期公钥 base64（设备身份；同上注入） */
  mobileLongPub?: string;
}

/**
 * 构造 pair.hello 帧载荷（D3 §4.8 step 1 字段全集）。
 * code 经 normalizePairCode 标准化（非法 → 错误，不产出坏帧）；
 * deviceName 对齐 pair_endpoint.rs label 防御（截断 64 / 空兜底）。
 * 纯函数无副作用；真实密钥材料（mobilePub/mobileLongPub）由上层密钥协商
 * 接线点注入（未覆盖项，见 R2-03 汇报），缺省空串保证帧可编码——wire 层
 * 权威校验在桌面网关（pair_endpoint.rs serde 仅要求字符串）。
 */
export function buildPairHello(
  input: BuildPairHelloInput
): ParseResult<PairHello> {
  const codeCheck = normalizePairCode(input.code);
  if (!codeCheck.ok) {
    return codeCheck;
  }
  const deviceId = input.deviceId ?? generateDeviceId();
  if (
    deviceId.length < DEVICE_ID_MIN_LENGTH ||
    deviceId.length > DEVICE_ID_MAX_LENGTH
  ) {
    return parseErr(
      `deviceId 长度必须为 ${DEVICE_ID_MIN_LENGTH}-${DEVICE_ID_MAX_LENGTH} 字符`
    );
  }
  const name = input.deviceName.trim();
  const deviceName =
    name.length === 0
      ? DEVICE_NAME_FALLBACK
      : name.slice(0, DEVICE_NAME_MAX_LENGTH);
  const hello: PairHello = {
    code: codeCheck.data,
    deviceId,
    mobilePub: input.mobilePub ?? '',
    mobileLongPub: input.mobileLongPub ?? '',
    deviceName,
  };
  if (input.platform !== undefined) {
    hello.platform = input.platform;
  }
  return parseOk(hello);
}

/**
 * pair.ok 解析结果（组合类型：wire PairOk 骨架 + token 明文扩展）。
 * token 为桌面端 pair_endpoint.rs pair_ok_body 附加字段（R1-11 仅此一次
 * 明文下发，移动端必须提取后立即持久化）。
 */
export interface PairOkResult extends PairOk {
  token: string;
}

/**
 * 解析 pair.ok 帧载荷：骨架（desktopId/ttl）复用生成解析器 parsePairOk
 * （组合纪律：不重写 wire 校验），token 从附加字段提取（缺失 → 错误——
 * 桌面端简化链承诺 ok 含 token 明文）。
 */
export function parsePairOk(body: unknown): ParseResult<PairOkResult> {
  const wire = parseWirePairOk(body);
  if (!wire.ok) {
    return wire;
  }
  const record = body as Record<string, unknown>;
  const token = record['token'];
  if (typeof token !== 'string' || token.length === 0) {
    return parseErr('pair.ok 缺少 token 明文（桌面端 pair_ok_body 扩展字段）');
  }
  return parseOk({ ...wire.data, token });
}

/** 配对流程领域错误类别（由 wire 错误码映射，D3 §6.2 pair.* 全表） */
export type PairErrorKind =
  /** 配对码格式非法 / 码不匹配（桌面标准化失败或校验失败） */
  | 'invalid-code'
  /** 码已过期（10 分钟 TTL，需桌面重新生成） */
  | 'expired'
  /** 码已被使用（一次性，并发配对第二个失败） */
  | 'used'
  /** 失败次数超限 / 限速（冷却 5 分钟） */
  | 'too-many-attempts'
  /** 挑战签名不匹配（完整密钥交换链，R2-03 未覆盖项的预留映射） */
  | 'challenge-mismatch'
  /** 无对应挑战（乱序/重放） */
  | 'no-challenge'
  /** 设备数超上限（默认 8） */
  | 'registry-full'
  /** 非 pair.* 错误码或未知（网络/传输等，可重试） */
  | 'unknown';

/** 领域错误信息（组合类型：wire ErrorBody 字段 + 领域类别） */
export interface PairErrorInfo {
  /** 领域错误类别（错误码映射产物） */
  kind: PairErrorKind;
  /** 原始 wire 错误码（如 pair.invalid_code / auth.unknown_device） */
  code: string;
  /** 服务端描述（ErrorBody.message，可为空串） */
  message: string;
  /** 服务端 retryable 标志（缺省 false） */
  retryable: boolean;
}

/** wire 错误码 → 领域类别映射表（D3 §6.2 / errors.ts DEVICE_ERROR_PROTOCOL） */
const PAIR_ERROR_KIND_MAP: Readonly<Record<string, PairErrorKind>> = {
  'pair.invalid_code': 'invalid-code',
  'pair.expired': 'expired',
  'pair.used': 'used',
  'pair.too_many_attempts': 'too-many-attempts',
  'pair.challenge_mismatch': 'challenge-mismatch',
  'pair.no_challenge': 'no-challenge',
  'pair.registry_full': 'registry-full',
};

/**
 * 解析 error 帧载荷（ErrorBody 形状）→ 领域错误信息。
 * 形状非法（缺 code）→ 错误；非 pair.* 错误码 → kind='unknown' 兜底
 * （保留原始 code/message/retryable，供接线层区分网络类可重试错误）。
 */
export function parsePairError(body: unknown): ParseResult<PairErrorInfo> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return parseErr('error 帧载荷必须是对象（ErrorBody 形状）');
  }
  const record = body as Record<string, unknown>;
  if (typeof record['code'] !== 'string' || record['code'].length === 0) {
    return parseErr('error 帧载荷缺少 code（错误码）');
  }
  const code = record['code'];
  const message =
    typeof record['message'] === 'string' ? record['message'] : '';
  const retryable = record['retryable'] === true;
  return parseOk({
    kind: PAIR_ERROR_KIND_MAP[code] ?? 'unknown',
    code,
    message,
    retryable,
  });
}
