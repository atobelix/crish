// WsGateway（M5 §4.1）：命令/事件分发 + 请求-响应匹配 + 订阅管理
// R2-02 落地范围 = 帧编解码纯函数（encodeFrame/decodeFrame）+
// invoke/on（构建信封 → 发送 → result.* 与 error 按 reqMsgId 匹配 → 归一化错误；
// 事件订阅按 kind 分发，含通配 '*' 与错误帧路由）；
// 依赖 ReconnectingWsClient 的发送能力（分发表注入 send 函数，本文件不触 WS
// 实例），open 后由客户端 attachSend 接线（R2-03 会话签名经 buildRequest 注入）。
//
// 解码策略（对齐 mock-daemon parseInbound 与 D3 §10.3）：
// - 版本校验：v !== 1 → version_mismatch（拒绝，不尝试兼容旧协议，D4 §6.4）；
// - kind 白名单：注册表 DEVICE_KINDS（生成面）；**未知 kind 宽容丢弃 + 记日志，
//   不回 error 帧**（D3 §10.3 旧端收到未来 kind 丢弃不报错；Rust MessageKind::Unknown
//   同语义）；已注册 kind 的 body 严格校验（生成解析器 parseDeviceMessage，
//   必填字段缺省即拒绝——不手写第二套校验）；
// - 帧大小：超 MAX_FRAME_BYTES → frame_too_large（D3 §5.5 超限断链语义）；
// - 配对期帧允许省略 auth（D3 §5.2），会话期验签由上层经 signer 完成。
//
// 请求-响应分发（D3 §5.4 / M6 §6.1，msgId 语义）：
// - invoke 构造带 msgId 的请求帧（M6 §3.3：m-<设备短号>-<序号>-<随机后缀>），
//   注册 pending（msgId → resolve/reject/timer）后发送；
// - 响应帧 result.* 与错误帧 error 以 body.reqMsgId 关联请求（D3 §5.4），
//   命中 pending → 消费（resolve/reject + 清 timer）；未命中 → result 丢弃、
//   error 广播给 'error'/'*' 订阅者（推送路径失败无 reqMsgId，D3 §5.4）；
// - 其余 kind（events.push 等）→ 广播给精确 kind 订阅者 + 通配订阅者。

import type { InboundEnvelope, OutgoingEnvelope } from './WsEnvelope';
import { DEVICE_KINDS } from '@crish/shared-types';
import { parseDeviceMessage } from '@crish/shared-types';
import type { JsonValue } from '@crish/shared-types';
import { PROTOCOL_VERSION } from './protocolVersion';

/** 单帧上限（D3 §5.5 / version.rs MAX_FRAME_BYTES = 1 MiB） */
export const MAX_FRAME_BYTES = 1_048_576;

/**
 * invoke 默认超时（任务书口径 R2-02 部分 2：默认 10s，可配）。
 * 注：D3 §5.4 / M5 §4.3.4 原默认 30s（cmd.timeout 本地超时语义）——接线方
 * 可在 invoke 显式传 timeoutMs 或经 WsGatewayOptions.defaultTimeoutMs 覆盖。
 */
export const DEFAULT_INVOKE_TIMEOUT_MS = 10_000;

/** 通配订阅 kind（接收全部广播帧，错误帧路由同此分发面） */
export const WILDCARD_KIND = '*';

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
export function encodeFrame(frame: OutgoingEnvelope): string {
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

// ── 请求-响应分发（D3 §5.4 / M5 §4.3.4）─────────────────────────────────────

/**
 * 网关错误（协议错误码归一化，D3 §6.2 / M6 §6.2 错误码表）。
 * 超时 = cmd.timeout（retryable=true，M6 §6.2.2：幂等重发 msgId 不变）；
 * 未连接 = transport.closed（retryable=true，重连兜底，M6 §6.2.1）；
 * 服务端错误帧 error 原样归一化（code/message/retryable/detail）。
 */
export class GatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: JsonValue;
  constructor(
    code: string,
    message: string,
    retryable: boolean,
    detail?: JsonValue
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.retryable = retryable;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 出站发送函数（原始帧字符串；R2-03 由 ReconnectingWsClient open 后注入） */
export type SendFrame = (raw: string) => void;

/** 订阅处理器（入站已解码信封） */
export type FrameHandler = (frame: InboundEnvelope) => void;

/**
 * 请求帧构建器（R2-03 接线点：信封签名 + auth 注入——构建信封走 signer
 * canonicalSigningPayload；缺省 = 配对期无签名形态，D3 §5.2）。
 */
export type RequestBuilder = (
  kind: string,
  msgId: string,
  body: JsonValue,
  ts: number
) => OutgoingEnvelope;

export interface WsGatewayOptions {
  /** 出站发送注入（R2-03：连接 open 后 attachSend；也可构造期注入便于单测） */
  send?: SendFrame;
  /** 时钟注入（缺省 Date.now；测试可固定时间戳） */
  now?: () => number;
  /** msgId 前缀（M6 §3.3 设备短号；缺省 'mob'，R2-03 可注入真实短号） */
  msgIdPrefix?: string;
  /** 请求帧构建（R2-03 接线点：签名 + auth；缺省无 auth 配对期形态） */
  buildRequest?: RequestBuilder;
  /** invoke 默认超时（缺省 10s，任务书口径；D3 §5.4 原 30s 由接线方覆盖） */
  defaultTimeoutMs?: number;
}

/** 挂起请求（msgId → resolve/reject/timer；M5 §4.3.4 PendingRequest 形态） */
interface PendingRequest {
  msgId: string;
  kind: string;
  resolve: (value: unknown) => void;
  reject: (err: GatewayError) => void;
  timer: ReturnType<typeof setTimeout>;
}

let msgIdSeq = 0;

/**
 * 消息编号生成（M6 §3.3：`m-<设备短号>-<自增序号>-<随机后缀>`，8-64 字符）。
 * 发送方唯一；重发幂等时保持 msgId 不变（D3 §5.4 / M6 §9.2，由 outbox 层保证）。
 */
export function nextMsgId(prefix = 'mob'): string {
  msgIdSeq = (msgIdSeq + 1) % 1_000_000;
  const suffix = Math.random().toString(36).slice(2, 8);
  return `m-${prefix}-${String(msgIdSeq).padStart(4, '0')}-${suffix}`;
}

/** 缺省请求帧构建器：配对期无签名形态（from=mobile/to=desktop，D3 §5.3） */
function defaultRequestBuilder(
  kind: string,
  msgId: string,
  body: JsonValue,
  ts: number
): OutgoingEnvelope {
  return {
    v: PROTOCOL_VERSION,
    kind,
    msgId,
    ts,
    from: 'mobile',
    to: 'desktop',
    body,
  };
}

/** 错误体 → GatewayError（防御性取值：字段缺失回退内部错误） */
function gatewayErrorFromBody(body: Record<string, unknown>): GatewayError {
  return new GatewayError(
    typeof body['code'] === 'string' ? body['code'] : 'internal',
    typeof body['message'] === 'string' ? body['message'] : '未知错误',
    body['retryable'] === true,
    body['detail'] as JsonValue | undefined
  );
}

export class WsGateway {
  /** 挂起请求表（msgId → 挂起；断线/超时清理，不残留——M5 §4.3.4 关键） */
  private readonly pending = new Map<string, PendingRequest>();
  /** 订阅分发表（kind → handler 集合；'*' = 通配接收全部广播帧） */
  private readonly handlers = new Map<string, Set<FrameHandler>>();
  private sendFn: SendFrame | null;
  private readonly nowFn: () => number;
  private readonly msgIdPrefix: string;
  private readonly buildRequestFn: RequestBuilder;
  private readonly defaultTimeoutMs: number;

  constructor(opts: WsGatewayOptions = {}) {
    this.sendFn = opts.send ?? null;
    this.nowFn = opts.now ?? (() => Date.now());
    this.msgIdPrefix = opts.msgIdPrefix ?? 'mob';
    this.buildRequestFn = opts.buildRequest ?? defaultRequestBuilder;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  }

  /** 挂起请求数（诊断 / 单测断言） */
  pendingCount(): number {
    return this.pending.size;
  }

  /** R2-03 接线：连接 open 后注入发送（每次 open 重注入指向当前 socket 的闭包） */
  attachSend(send: SendFrame): void {
    this.sendFn = send;
  }

  /** 请求-响应分发（D3 §5.4）：构造带 msgId 请求帧 → 注册 pending → 发送；
   *  响应帧/错误帧按 reqMsgId 回填，超时 reject（cmd.timeout，可重发幂等）。 */
  invoke<T>(kind: string, body: unknown, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.sendFn) {
        reject(
          new GatewayError('transport.closed', '连接未就绪，无法发送请求', true)
        );
        return;
      }
      const msgId = nextMsgId(this.msgIdPrefix);
      const ts = this.nowFn();
      let env: OutgoingEnvelope;
      try {
        env = this.buildRequestFn(kind, msgId, body as JsonValue, ts);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(
          new GatewayError(
            'cmd.timeout',
            `请求 ${kind} 超时（${timeoutMs ?? this.defaultTimeoutMs}ms）`,
            true
          )
        );
      }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(msgId, {
        msgId,
        kind,
        // resolve 参数收窄为 unknown（分发面类型）；实际值按调用方 T 期望回填
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.sendFn(encodeFrame(env));
      } catch (e) {
        this.pending.delete(msgId);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 无响应推流发送（心跳等推送类消息，M6 §3.2：无响应）；未接线时静默丢弃 */
  send(kind: string, body: unknown): void {
    if (!this.sendFn) return;
    const msgId = nextMsgId(this.msgIdPrefix);
    const env = this.buildRequestFn(
      kind,
      msgId,
      body as JsonValue,
      this.nowFn()
    );
    this.sendFn(encodeFrame(env));
  }

  /** 订阅分发（精确 kind + 通配 '*'；返回退订函数）。
   *  响应帧（result.* 与 error 命中 pending）被消费不广播；错误帧未命中广播。 */
  on(kind: string, handler: FrameHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** 入站分发入口（ReconnectingWsClient onmessage → decodeFrame → 此处）：
   *  result.* / error 按 reqMsgId 匹配 pending；其余按 kind 广播。 */
  dispatchFrame(frame: InboundEnvelope): void {
    if (frame.kind === 'error' || frame.kind.startsWith('result.')) {
      if (this.routeResponse(frame)) return; // 命中 pending → 消费（resolve/reject）
      if (frame.kind === 'error') this.broadcast(frame); // 无关联请求的错误帧 → 广播
      return; // result.* 未命中 → 丢弃（响应帧不进入事件流）
    }
    this.broadcast(frame);
  }

  /** 断线清理：reject 全部挂起并清表（主动断开 → cmd.cancelled；意外断开 → transport.closed） */
  abortAllPending(err: GatewayError): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
  }

  /** 响应帧路由：读取 body.reqMsgId 匹配 pending；命中消费返回 true */
  private routeResponse(frame: InboundEnvelope): boolean {
    const body = (frame.body ?? {}) as Record<string, unknown>;
    const reqMsgId =
      typeof body['reqMsgId'] === 'string' ? body['reqMsgId'] : undefined;
    if (!reqMsgId) return false;
    const req = this.pending.get(reqMsgId);
    if (!req) return false;
    this.pending.delete(reqMsgId);
    clearTimeout(req.timer);
    if (frame.kind === 'error') {
      req.reject(gatewayErrorFromBody(body));
      return true;
    }
    // result.*：CommandResult 三态信封（M6 §6.1：success / error / partial）
    if (body['ok'] === true) {
      req.resolve(body['result']);
    } else {
      const errBody =
        body['error'] !== undefined && typeof body['error'] === 'object'
          ? (body['error'] as Record<string, unknown>)
          : body;
      req.reject(gatewayErrorFromBody(errBody));
    }
    return true;
  }

  /** kind 广播（精确 + 通配；遍历拷贝快照防分发中退订变更集合） */
  private broadcast(frame: InboundEnvelope): void {
    const exact = this.handlers.get(frame.kind);
    if (exact) for (const h of [...exact]) h(frame);
    const wildcard = this.handlers.get(WILDCARD_KIND);
    if (wildcard) for (const h of [...wildcard]) h(frame);
  }
}
