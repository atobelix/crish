// WsGateway（M5 §4.1）：命令/事件分发 + 请求-响应匹配 + 订阅管理
// R2-02 落地范围 = 帧编解码纯函数（encodeFrame/decodeFrame）；
// invoke/on（构建信封 → 发送 → result.* 匹配 → 归一化错误；事件订阅广播）
// 依赖 ReconnectingWsClient 的发送能力，属 R2-03 接线（本任务仅深化其纯逻辑）。
//
// 解码策略（对齐 mock-daemon parseInbound 与 D3 §10.3）：
// - 版本校验：v !== 1 → version_mismatch（拒绝，不尝试兼容旧协议，D4 §6.4）；
// - kind 白名单：注册表 DEVICE_KINDS（生成面）；**未知 kind 宽容丢弃 + 记日志，
//   不回 error 帧**（D3 §10.3 旧端收到未来 kind 丢弃不报错；Rust MessageKind::Unknown
//   同语义）；已注册 kind 的 body 严格校验（生成解析器 parseDeviceMessage，
//   必填字段缺省即拒绝——不手写第二套校验）；
// - 帧大小：超 MAX_FRAME_BYTES → frame_too_large（D3 §5.5 超限断链语义）；
// - 配对期帧允许省略 auth（D3 §5.2），会话期验签由上层经 signer 完成。

import type { InboundEnvelope, OutboundEnvelope } from './WsEnvelope';
import { DEVICE_KINDS } from '../../../../packages/shared-types/src/generated/device/kinds';
import { parseDeviceMessage } from '../../../../packages/shared-types/src/generated/device/parser';
import type { JsonValue } from '../../../../packages/shared-types/src/primitive-types';

/** 单帧上限（D3 §5.5 / version.rs MAX_FRAME_BYTES = 1 MiB） */
export const MAX_FRAME_BYTES = 1_048_576;

/** 解码失败描述（上层据 drop 决定：true = 宽容丢弃+日志，false = 需回 error 帧/断链） */
export interface FrameDecodeError {
  /** 跨端错误码（D3 §6.2 分层错误码） */
  code: string;
  message: string;
  retryable: boolean;
  /** true = 宽容丢弃（不打断连接）；false = 需按协议处理（断链/上报） */
  drop: boolean;
}

export type FrameDecodeResult =
  { ok: true; frame: InboundEnvelope } | { ok: false; error: FrameDecodeError };

/** 编码失败（超限；协议要求断链） */
export class FrameEncodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'FrameEncodeError';
  }
}

/** 出站信封编码：JSON.stringify（紧凑，与 serde_json 字节形态对齐），超限抛错 */
export function encodeFrame(frame: OutboundEnvelope): string {
  const raw = JSON.stringify(frame);
  if (raw.length > MAX_FRAME_BYTES) {
    throw new FrameEncodeError(
      'frame_too_large',
      `帧超上限（${raw.length} > ${MAX_FRAME_BYTES} 字节）：${frame.kind}`
    );
  }
  return raw;
}

/** 入站帧解码：版本校验 + kind 白名单（未知宽容丢弃）+ body 严格校验（生成解析器） */
export function decodeFrame(raw: string): FrameDecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: '帧不是合法 JSON',
        retryable: false,
        drop: true,
      },
    };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: '帧必须是 JSON 对象',
        retryable: false,
        drop: true,
      },
    };
  }
  const obj = json as Record<string, unknown>;

  // 版本校验（D3 §10.2：主版本协商，不兼容即拒绝并提示升级）
  if (obj['v'] !== 1) {
    return {
      ok: false,
      error: {
        code: 'version_mismatch',
        message: `不支持的协议版本 ${String(obj['v'])}（仅支持 1）`,
        retryable: false,
        drop: true,
      },
    };
  }

  // kind 白名单：未知 kind 宽容丢弃 + 记日志（D3 §10.3），不打断连接
  if (
    typeof obj['kind'] !== 'string' ||
    !(DEVICE_KINDS as readonly string[]).includes(obj['kind'])
  ) {
    return {
      ok: false,
      error: {
        code: 'cmd.unknown',
        message: `未知 kind ${String(obj['kind'])}，宽容丢弃（D3 §10.3）`,
        retryable: false,
        drop: true,
      },
    };
  }
  const kind = obj['kind'] as (typeof DEVICE_KINDS)[number];

  if (typeof obj['msgId'] !== 'string' || obj['msgId'].length === 0) {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: 'msgId 缺失或非法',
        retryable: false,
        drop: true,
      },
    };
  }
  if (
    typeof obj['ts'] !== 'number' ||
    !Number.isInteger(obj['ts']) ||
    obj['ts'] < 0
  ) {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: 'ts 必须为非负整数（epoch ms）',
        retryable: false,
        drop: true,
      },
    };
  }
  if (obj['from'] !== 'desktop' && obj['from'] !== 'mobile') {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: 'from 必须为 desktop/mobile',
        retryable: false,
        drop: true,
      },
    };
  }
  if (obj['to'] !== 'desktop' && obj['to'] !== 'mobile') {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: 'to 必须为 desktop/mobile',
        retryable: false,
        drop: true,
      },
    };
  }

  // 配对期帧允许省略 auth（D3 §5.2 / mock-daemon 先例）；存在时按形状提取
  let auth: InboundEnvelope['auth'];
  if (typeof obj['auth'] === 'object' && obj['auth'] !== null) {
    const a = obj['auth'] as Record<string, unknown>;
    auth = {
      deviceId: typeof a['deviceId'] === 'string' ? a['deviceId'] : '',
      ts: typeof a['ts'] === 'number' ? a['ts'] : 0,
      nonce: typeof a['nonce'] === 'string' ? a['nonce'] : '',
      sig: typeof a['sig'] === 'string' ? a['sig'] : '',
    };
  }

  // 载荷校验：复用生成解析器（必填字段缺省/类型错 → 拒绝），不手写第二套校验
  const bodyCheck = parseDeviceMessage(kind, obj['body'] as JsonValue);
  if (!bodyCheck.ok) {
    return {
      ok: false,
      error: {
        code: 'cmd.invalid',
        message: `body 解析失败（${kind}）：${bodyCheck.error}`,
        retryable: false,
        drop: true,
      },
    };
  }

  const frame: InboundEnvelope = {
    v: 1,
    kind,
    msgId: obj['msgId'],
    ts: obj['ts'],
    from: obj['from'],
    to: obj['to'],
    body: obj['body'] as JsonValue,
  };
  if (auth !== undefined) frame.auth = auth;
  return { ok: true, frame };
}

export class WsGateway {
  /** R2-03 接线：构建信封（signer 签名）→ ReconnectingWsClient 发送 → result.* 匹配 → 归一化错误 */
  invoke<T>(_kind: string, _body: unknown, _timeoutMs = 30_000): Promise<T> {
    throw new Error(
      'WsGateway.invoke 未实现（R2-03 接线：帧编码 + 签名 + 请求-响应匹配）'
    );
  }

  /** R2-03 接线：事件订阅注册（decodeFrame 解析后广播），返回退订函数 */
  on(_cb: (env: InboundEnvelope) => void): () => void {
    return () => {};
  }
}
