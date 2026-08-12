// =======================================================================
// mock daemon v0（R0-06）——信封层
//
// 职责：
//   1. 出站帧构造（DeviceEnvelope，D3 §5.3）：所有 mock 下发的消息统一
//      走本模块，保证 v/kind/msgId/ts/from/to/auth/body 齐全；
//   2. 出站自检：发送前用 generated/device 的解析器（parseDeviceMessage /
//      parseDeviceFrame）校验 body 与整帧——夹具事件与注册表漂移会当场报错，
//      而不是静默把坏帧发给移动端；
//   3. 入站解析：先宽松校验信封（配对期帧允许无 auth，D3 §5.2「配对期可选」），
//      再交给生成解析器做 body 严格校验（未知 kind / 缺字段 → 拒绝并回 error）。
//
// 说明：mock 是纯测试基建，不验签（不校验 HMAC sig），收到任何非空 sig 都放行；
// 出站帧的 auth.sig 固定为 mock 占位串，移动端联调时按「接受任意签名」处理。
// =======================================================================

import type { WebSocket } from 'ws';
import {
  parseDeviceFrame,
  parseDeviceMessage,
} from '../../../packages/shared-types/src/generated/device/parser';
import type { AuthHeader } from '../../../packages/shared-types/src/generated/device/types';
import type { DeviceKind } from '../../../packages/shared-types/src/generated/device/kinds';
import { DEVICE_KINDS } from '../../../packages/shared-types/src/generated/device/kinds';
import type { JsonValue } from '../../../packages/shared-types/src/primitive-types';
import { nextMsgId } from './util.js';

/** mock 固定身份（桌面 Hub 侧，与真实网关的 desktopId 形态对齐） */
export const MOCK_DESKTOP_ID = 'desktop-mock-0001';
/** mock 固定证书指纹占位（真实实现来自桌面自签证书 SHA-256） */
export const MOCK_TLS_FINGERPRINT =
  'mock-tls-fingerprint-0000000000000000000000000000000000000000';
/** mock 固定挑战占位（真实实现为 32B 随机挑战 base64） */
export const MOCK_CHALLENGE =
  'bW9jay1jaGFsbGVuZ2UtMzJiYXNlNjQtcGxhY2Vob2xkZXI=';
/** mock 固定桌面 X25519 公钥占位（真实实现由配对密码学生成） */
export const MOCK_DESKTOP_PUB = 'mock-desktop-x25519-pub-placeholder';
/** mock 固定配对令牌占位（64 hex 明文；真实实现 = TokenStore 一次性明文签发）。
 * pair.ok 的 token 字段为协议注册表之外的扩展，与 Rust pair_endpoint.rs
 * pair_ok_body（{desktopId, ttl, token}，pair_endpoint.rs:177-186）对齐——
 * 移动端 parsePairOk 拒绝无 token 帧（对拍裁决 2026-08-11）。 */
export const MOCK_PAIR_TOKEN =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** mock 出站帧的固定签名占位（mock 不实现 HMAC，见文件头说明） */
export const MOCK_SIG = 'mock-sig-placeholder';

export interface OutboundEnvelope {
  v: 1;
  kind: DeviceKind;
  msgId: string;
  ts: number;
  from: 'desktop';
  to: 'mobile';
  auth: AuthHeader;
  body: unknown;
}

export interface InboundEnvelope {
  v: number;
  kind: DeviceKind;
  msgId: string;
  ts: number;
  from: string;
  to: string;
  auth?: AuthHeader;
  body: JsonValue;
}

/** 入站解析失败后的错误描述（供上层回 error 帧） */
export interface InboundError {
  code: string;
  message: string;
}

/**
 * 构造出站帧。deviceId 缺省用 mock 桌面身份；签名固定占位（不验签侧）。
 */
export function buildEnvelope(
  kind: DeviceKind,
  body: unknown,
  deviceId = MOCK_DESKTOP_ID
): OutboundEnvelope {
  return {
    v: 1,
    kind,
    msgId: nextMsgId('d'),
    ts: Date.now(),
    from: 'desktop',
    to: 'mobile',
    auth: {
      deviceId,
      ts: Date.now(),
      nonce: 'mock-nonce',
      sig: MOCK_SIG,
    },
    body,
  };
}

/**
 * 出站自检：body 必须能被生成解析器接受（parseDeviceMessage），否则视为
 * 夹具漂移直接抛错。发送路径统一走 sendFrame，保证 mock 永不外发坏帧。
 */
export function assertOutgoingBody(kind: DeviceKind, body: unknown): void {
  const r = parseDeviceMessage(kind, body);
  if (!r.ok) {
    throw new Error(
      `mock 出站帧自检失败（kind=${kind}）：${r.error}\n` +
        `body=${JSON.stringify(body)}。夹具事件与 device-protocol.json 注册表漂移，` +
        `请检查 scripts/mock-daemon/src/fixtures/ 下的夹具定义。`
    );
  }
}

/** 发送一帧（发送前做 body 自检；编码失败视为编程错误直接抛） */
export function sendFrame(ws: WebSocket, frame: OutboundEnvelope): void {
  assertOutgoingBody(frame.kind, frame.body);
  ws.send(JSON.stringify(frame));
}

/** 发送并校验整帧（测试自检用；正常发送路径用 sendFrame 即可） */
export function sendFrameChecked(ws: WebSocket, frame: OutboundEnvelope): void {
  assertOutgoingBody(frame.kind, frame.body);
  const parsed = parseDeviceFrame(JSON.parse(JSON.stringify(frame)));
  if (!parsed.ok) {
    throw new Error(`mock 整帧自检失败（kind=${frame.kind}）：${parsed.error}`);
  }
  ws.send(JSON.stringify(frame));
}

/**
 * 入站解析：宽松信封 + 生成解析器 body 严格校验。
 * 返回 { ok: true, frame } 或 { ok: false, error }（error 携带跨端错误码）。
 */
export function parseInbound(
  raw: string
): { ok: true; frame: InboundEnvelope } | { ok: false; error: InboundError } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: { code: 'cmd.invalid', message: '帧不是合法 JSON' },
    };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      ok: false,
      error: { code: 'cmd.invalid', message: '帧必须是 JSON 对象' },
    };
  }
  const obj = json as Record<string, unknown>;
  if (obj['v'] !== 1) {
    return {
      ok: false,
      error: {
        code: 'version_mismatch',
        message: `不支持的协议版本 ${String(obj['v'])}`,
      },
    };
  }
  if (
    typeof obj['kind'] !== 'string' ||
    !(DEVICE_KINDS as readonly string[]).includes(obj['kind'])
  ) {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: `未知 kind ${String(obj['kind'])}`,
      },
    };
  }
  const kind = obj['kind'] as DeviceKind;
  if (typeof obj['msgId'] !== 'string' || obj['msgId'].length === 0) {
    return {
      ok: false,
      error: { code: 'cmd.invalid', message: 'msgId 缺失或非法' },
    };
  }
  const frame: InboundEnvelope = {
    v: 1,
    kind,
    msgId: obj['msgId'],
    ts: typeof obj['ts'] === 'number' ? obj['ts'] : 0,
    from: typeof obj['from'] === 'string' ? obj['from'] : '',
    to: typeof obj['to'] === 'string' ? obj['to'] : '',
    body: obj['body'] as JsonValue,
  };
  // 配对期帧允许省略 auth（D3 §5.2）；会话期帧必须携带 auth（宽松校验：有则记录）
  if (typeof obj['auth'] === 'object' && obj['auth'] !== null) {
    const a = obj['auth'] as Record<string, unknown>;
    frame.auth = {
      deviceId: typeof a['deviceId'] === 'string' ? a['deviceId'] : '',
      ts: typeof a['ts'] === 'number' ? a['ts'] : 0,
      nonce: typeof a['nonce'] === 'string' ? a['nonce'] : '',
      sig: typeof a['sig'] === 'string' ? a['sig'] : '',
    };
  }
  const bodyCheck = parseDeviceMessage(kind, frame.body);
  if (!bodyCheck.ok) {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: `body 解析失败（${kind}）：${bodyCheck.error}`,
      },
    };
  }
  return { ok: true, frame };
}

/** 帧体类型守卫：CommandRequest 的形状检查（parseDeviceMessage 已保证 command 字段存在） */
export function isCommandRequest(
  body: unknown
): body is { command: string; params: JsonValue } {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b['command'] === 'string' &&
    typeof b['params'] === 'object' &&
    b['params'] !== null
  );
}
