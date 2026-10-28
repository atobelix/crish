// 会话签名与网关工厂（D3 §5.1 / pairingWiring 子模块）

import {
  createFrameSigner,
  base64Encode as signerBase64Encode,
  type FrameSigner,
} from '@/network/signer';
import { PROTOCOL_VERSION } from '@/network/protocolVersion';
import type { OutgoingEnvelope } from '@/network/WsEnvelope';
import { WsGateway } from '@/network/WsGateway';
import type { WebSocketFactory } from '@/network/ReconnectingWsClient';
import type { JsonValue } from '@crish/shared-types';
import { ensureObservationWiring } from '../observationWiring';
import type { PairingSessionContext } from './PairingWiring';

/**
 * 随机 nonce（16 字节 → base64；D3 §5.1「随机16字节base64」）。
 * 随机源可注入（缺省 Math.random；RN/Hermes 可用，不依赖 crypto.getRandomValues）。
 */
export function randomNonce(rand: () => number = Math.random): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(rand() * 256);
  }
  return signerBase64Encode(bytes);
}

/**
 * 签名请求帧构建器（WsGateway.buildRequest 注入点）：默认信封（v/kind/msgId/ts/
 * from=mobile/to=desktop）+ auth 注入（deviceId/ts/nonce/sig；sig = HMAC(token_key,
 * canon(header) ∥ canonicalBodyJson)，canonicalSigningPayload 与 Rust 双端一致）。
 */
export function buildSignedRequest(
  signer: FrameSigner,
  deviceId: string,
  kind: string,
  msgId: string,
  body: JsonValue,
  ts: number,
  nonce: string = randomNonce()
): OutgoingEnvelope {
  const env: OutgoingEnvelope = {
    v: PROTOCOL_VERSION,
    kind,
    msgId,
    ts,
    from: 'mobile',
    to: 'desktop',
    body,
  };
  env.auth = {
    deviceId,
    ts,
    nonce,
    sig: signer.sign({
      deviceId,
      ts,
      nonce,
      msgId,
      kind,
      v: PROTOCOL_VERSION,
      body,
    }),
  };
  return env;
}

/**
 * 会话网关构造（SignContext 注入点）：deviceId + tokenKey → 签名器 → 带签名
 * buildRequest 的 WsGateway。会话期所有出站帧（heartbeat/invoke/推流）自动签名。
 */
export function buildSessionGateway(
  deviceId: string,
  tokenKey: string
): WsGateway {
  const signer = createFrameSigner({ deviceId, tokenKey });
  return new WsGateway({
    msgIdPrefix: 'mob',
    buildRequest: (kind, msgId, body, ts) =>
      buildSignedRequest(signer, deviceId, kind, msgId, body, ts),
  });
}

/** 缺省会话连接器（配对成功/冷启动恢复后调用）：经 observationWiring 单例复用
 * 同一连接实例（approvalWiring 消费 getObservationWiring().client.gateway）。
 * opts 为测试注入面（factory 避免 jest 真实 WS；gateway 注入 spy 网关）。 */
export function defaultConnectSession(
  ctx: PairingSessionContext,
  opts: { factory?: WebSocketFactory; gateway?: WsGateway } = {}
): void {
  const gateway =
    opts.gateway ?? buildSessionGateway(ctx.deviceId, ctx.tokenKey);
  ensureObservationWiring({
    token: ctx.token,
    gateway,
    ...(opts.factory ? { factory: opts.factory } : {}),
  });
}
