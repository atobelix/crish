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
// - 证书指纹（D3 §4.6 证书固定）：tlsFingerprint 的**权威载体 = pair.challenge**
//   （生成面 PairChallenge 必填字段，桌面自签证书 SHA-256(SPKI) 小写 hex 64
//   位，desktop multi_device/tls.rs spki_sha256_hex）；pair.ok 上预留可选扩展
//   字段（与 token 同模式，桌面端未来可附加下发）。**缺口记录**：当前桌面
//   pair_endpoint.rs 简化链（hello → ok 直接完成）不发送 pair.challenge，
//   指纹实际未下发——移动端 host_fingerprint 位暂空（AU5 S-1 修复的诚实边界）；
// - error 帧：ErrorBody（D3 §6.2 设备错误码），pair.* 错误码映射见
//   pairProtocolErrorKind 的注册表对应关系（errors.ts DEVICE_ERROR_PROTOCOL）。
//
// 类型纪律（M5 §1.3 组合纪律）：wire 形状引用生成面（PairHello/PairOk/
// Platform/ErrorBody），领域附加字段（PairOkResult.token、PairErrorInfo）
// 用「契约类型 & 本地附加」的组合形式，不复制契约字段定义。

import { normalizePairCode, PAIR_CODE_ALPHABET } from '@/domain/pure/cxnCode';
import { parseErr, parseOk } from '@crish/shared-types';
import type { ParseResult } from '@crish/shared-types';
import { parsePairOk as parseWirePairOk } from '@crish/shared-types';
import type { PairHello, PairOk, Platform } from '@crish/shared-types';

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
  /** 桌面证书指纹（可选扩展：D3 §4.6 权威载体是 pair.challenge；pair.ok
   *  附加下发是预留路径——当前桌面两处均不下发，见文件头缺口记录） */
  tlsFingerprint?: string;
}

/**
 * 解析 pair.ok 帧载荷：骨架（desktopId/ttl）复用生成解析器 parsePairOk
 * （组合纪律：不重写 wire 校验），token 从附加字段提取（缺失 → 错误——
 * 桌面端简化链承诺 ok 含 token 明文）；tlsFingerprint 可选（缺失/空串/非
 * 字符串 → 不携带，宽容不报错——当前桌面不下发，语义与缺口记录一致）。
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
  const fingerprint = record['tlsFingerprint'];
  if (typeof fingerprint === 'string' && fingerprint.length > 0) {
    return parseOk({ ...wire.data, token, tlsFingerprint: fingerprint });
  }
  return parseOk({ ...wire.data, token });
}

// ── 证书指纹（D3 §4.6：应用层固定最小面）───────────────────────────────────

/**
 * 桌面自签证书指纹格式（desktop multi_device/tls.rs spki_sha256_hex）：
 * SHA-256(SubjectPublicKeyInfo) 小写 hex，64 字符（tls.rs:712 断言长度 64）。
 * 配对载荷（pair.challenge 必填 / pair.ok 扩展）携带该指纹，移动端持久化到
 * secure-store host_fingerprint 位（证书固定信任锚）。
 */
export const TLS_FINGERPRINT_RE = /^[0-9a-f]{64}$/i;

/** 指纹格式校验（桌面 spki_sha256_hex 形态；格式不符 → 不可钉扎，诚实放弃） */
export function isValidTlsFingerprint(value: string): boolean {
  return TLS_FINGERPRINT_RE.test(value);
}

/**
 * 指纹一致性校验结果（应用层比对：配对期下发值 vs 存储值）。
 * RN WebSocket 不暴露证书、无信任注入面（ReconnectingWsClient 工厂只收
 * url），TLS 层真钉扎不可达——最小正确防御面 = 对本机存储值与配对载荷
 * 下发值的一致性做比对（防本地篡改 / 捕获证书轮换），见 checkHostFingerprint。
 */
export type FingerprintCheck =
  /** 两值一致（大小写不敏感，桌面输出小写 hex） */
  | { ok: true; defense: 'verified' }
  /** 无历史存储值（首次配对：以本次下发值落锚，TOFU） */
  | { ok: true; defense: 'no-stored' }
  /** 桌面未下发指纹 → 拒绝（fail-closed；实现波总方案 H1：
   *  桌面 pair.ok 已强制下发，缺失 = 桌面端过旧或载荷被篡改） */
  | { ok: false; defense: 'no-delivered' }
  /** 不一致（证书轮换/本地篡改）→ 拒绝（失败关闭） */
  | { ok: false; defense: 'mismatch' };

/**
 * 指纹一致性校验（纯函数，O(1) 无副作用）：
 * stored = secure-store host_fingerprint 位（历史配对存储）；
 * delivered = 本次配对载荷下发的指纹（pair.ok 权威载体）。
 * 判定顺序：桌面未下发 → no-delivered（fail-closed 拒绝）；无存储 →
 * no-stored（首次配对落锚）；两者齐备 → 大小写不敏感比对，一致
 * verified / 不一致 mismatch。
 */
export function checkHostFingerprint(
  stored: string | undefined,
  delivered: string | undefined
): FingerprintCheck {
  if (!delivered || delivered.length === 0) {
    return { ok: false, defense: 'no-delivered' };
  }
  if (!stored || stored.length === 0) {
    return { ok: true, defense: 'no-stored' };
  }
  const same = stored.trim().toLowerCase() === delivered.trim().toLowerCase();
  return same
    ? { ok: true, defense: 'verified' }
    : { ok: false, defense: 'mismatch' };
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
