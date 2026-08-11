// DeviceEnvelope 帧骨架（M5 §4.2 / D3 §5.3 / 裁决修正 2/5）
// 协议真源 = M6 §10.1 DeviceEnvelope；生成面 packages/shared-types/src/generated/device
// （R0-03 产物，已入库）。本文件为 TS 侧编解码落点：R2-02 接 HMAC 验签与类型守卫，
// 若生成面已覆盖同构类型则优先复用生成产物（禁止手写第二套协议类型）

/** 帧种类（D3 消息面注册） */
export type EnvelopeKind =
  | 'pair.*'
  | 'auth.*'
  | 'device.*'
  | 'events.*'
  | 'cmd.*'
  | 'result.*'
  | 'stream.*'
  | 'heartbeat'
  | 'error';

/** 统一帧结构（v/kind/msgId/ts/from/to/auth/body） */
export interface DeviceEnvelope {
  v: 1;
  kind: EnvelopeKind;
  /** 发送方唯一（utils/id.ts nextId） */
  msgId: string;
  /** epoch ms */
  ts: number;
  from: 'mobile' | 'desktop';
  to: 'mobile' | 'desktop';
  /** 会话期必填；配对期可选（D3 §5.2） */
  auth?: AuthHeader;
  body: unknown;
}

/** 消息级 HMAC 认证头（D3 §5.1：canon = deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v） */
export interface AuthHeader {
  deviceId: string;
  ts: number;
  /** 随机 16B base64 */
  nonce: string;
  /** HMAC-SHA256(token_key, canon(header) + bodyJson) */
  sig: string;
}
