// =======================================================================
// mock daemon v0（R0-06）——连接会话（单客户端生命周期）
//
// 每个 WS 连接一个 Connection 实例，负责：
//   1. 相位推进：pairing（配对）→ handshake（握手）→ session（会话）；
//      相位约束由 device-protocol.json 的 authPhase 登记驱动（入站 kind
//      与当前相位不符 → 拒绝并回 error）；
//   2. 消息路由：pair.* / auth.* / events.* / remote.* / heartbeat /
//      device.unlink / error；
//   3. 会话期订阅注册（events.subscribe / events.subscribeAll）+ 事件推送
//      （events.push 只发给订阅了对应会话的连接）；
//   4. 断线续传：events.resume 从 MockState 会话存储分页（EventPage 契约），
//      末页后补发 events.resume.done（桌面恢复实时推流信号）。
//
// 配对模式开关（pairMode）：
//   - 开启：auth.hello 前必须先完成 pair.hello/verify 配对；
//   - 关闭：跳过配对，auth.hello 直接放行（快速联调/测试）。
// =======================================================================

import type { WebSocket } from 'ws';
import type { JsonValue } from '../../../packages/shared-types/src/primitive-types';
import {
  buildEnvelope,
  MOCK_PAIR_TOKEN,
  parseInbound,
  sendFrame,
} from './envelope.js';
import type { InboundEnvelope, OutboundEnvelope } from './envelope.js';
import type { MockDaemonServer } from './server.js';
import { handleCommand } from './commands.js';
import { debug, info, warn } from './util.js';

/** 会话期相位（authPhase 登记值） */
type Phase = 'pairing' | 'handshake' | 'session';

/** 入站 kind → 要求的最小相位（比登记更宽松：配对期允许握手期消息等） */
const KIND_MIN_PHASE: Partial<Record<string, Phase>> = {
  'pair.hello': 'pairing',
  'pair.verify': 'pairing',
  'auth.hello': 'pairing',
  'auth.refresh': 'pairing',
  'device.unlink': 'session',
  'events.subscribe': 'session',
  'events.subscribeAll': 'session',
  'events.resume': 'session',
  heartbeat: 'session',
};

/** 出站错误帧构造（error kind，带 reqMsgId 关联） */
function errorFrame(
  msgId: string,
  code: string,
  message: string,
  retryable: boolean
): OutboundEnvelope {
  return buildEnvelope('error', { code, message, retryable, reqMsgId: msgId });
}

export class Connection {
  readonly server: MockDaemonServer;
  readonly ws: WebSocket;
  private phase: Phase = 'pairing';
  /** 本连接已登记的 deviceId（pair.hello 或 auth.hello 的 auth.deviceId） */
  private deviceId = '';
  /** 待配对设备信息（pair.hello 后暂存，verify 通过后登记） */
  private pendingPair: {
    deviceId: string;
    deviceName: string;
    platform?: string;
  } | null = null;
  /** 已订阅的会话（events.subscribe） */
  private readonly subscribedSessions = new Set<string>();
  private closed = false;

  constructor(server: MockDaemonServer, ws: WebSocket) {
    this.server = server;
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.onClose());
    ws.on('error', (e) => warn(`连接异常：${String(e)}`));
  }

  isSubscribed(sessionId: string): boolean {
    return this.subscribedSessions.has(sessionId);
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** 推送事件帧（server 广播时调用；未订阅不发） */
  pushEvent(sessionId: string, event: JsonValue, preview: boolean): void {
    if (!this.subscribedSessions.has(sessionId)) return;
    const body = preview
      ? { sessionId, preview: true, event }
      : { sessionId, event };
    sendFrame(this.ws, buildEnvelope('events.push', body));
  }

  private onMessage(data: unknown): void {
    const raw =
      typeof data === 'string'
        ? data
        : data instanceof Buffer
          ? data.toString('utf8')
          : '';
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      warn(`入站帧拒绝：${parsed.error.message}`);
      sendFrame(
        this.ws,
        errorFrame('', parsed.error.code, parsed.error.message, false)
      );
      return;
    }
    this.route(parsed.frame);
  }

  private route(frame: InboundEnvelope): void {
    const kind = frame.kind;
    const minPhase = KIND_MIN_PHASE[kind];
    if (minPhase && phaseOrder(this.phase) < phaseOrder(minPhase)) {
      warn(`相位拒绝：${kind} 需要 ${minPhase} 相位，当前 ${this.phase}`);
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'auth.unknown_device',
          `相位错误：${kind} 需要 ${minPhase} 相位（当前 ${this.phase}）`,
          false
        )
      );
      return;
    }

    switch (kind) {
      case 'pair.hello':
        this.onPairHello(frame);
        return;
      case 'pair.verify':
        this.onPairVerify(frame);
        return;
      case 'auth.hello':
        void this.onAuthHello(frame);
        return;
      case 'auth.refresh':
        this.onAuthRefresh(frame);
        return;
      case 'events.subscribe':
        this.onSubscribe(frame);
        return;
      case 'events.subscribeAll':
        this.onSubscribeAll(frame);
        return;
      case 'events.resume':
        this.onResume(frame);
        return;
      case 'heartbeat':
        this.onHeartbeat(frame);
        return;
      case 'device.unlink':
        this.onUnlink(frame);
        return;
      case 'error':
        // 客户端上报错误：记录即可（联调观察用）
        debug(`客户端上报 error：${JSON.stringify(frame.body)}`);
        return;
      default:
        if (kind.startsWith('remote.')) {
          this.onRemoteCommand(frame);
          return;
        }
        warn(`未处理的入站 kind：${kind}`);
        sendFrame(
          this.ws,
          errorFrame(
            frame.msgId,
            'cmd.unknown',
            `mock v0 不支持入站 kind ${kind}`,
            false
          )
        );
    }
  }

  // ── 配对期（pair.*）───────────────────────────────────────────────────

  private onPairHello(frame: InboundEnvelope): void {
    const body = frame.body as {
      code?: string;
      deviceId?: string;
      mobilePub?: string;
      mobileLongPub?: string;
      deviceName?: string;
      platform?: string;
    };
    // 码比对走 PairCode::normalize 语义（去空白/分隔符 → 大写 → CXN 前缀剥离
    // → 12 位校验）：移动端 wire 形态为 12 位无前缀（device-protocol.json:856
    // 「传输统一无前缀无分隔符」），展示形态带 CXN- 前缀——两者都必须可配对
    // （与 Rust pair.rs:52-74 对齐，对拍裁决 2026-08-11）
    const code =
      typeof body.code === 'string' ? normalizePairCode(body.code) : null;
    const expected = normalizePairCode(this.server.state.pairCode);
    // 入站格式非法（标准化失败）或与展示码不一致 → pair.invalid_code
    if (code === null || expected === null || code !== expected) {
      warn(
        `配对码错误：收到 ${String(body.code)}（预期 ${this.server.state.pairCode}）`
      );
      sendFrame(
        this.ws,
        errorFrame(frame.msgId, 'pair.invalid_code', '配对码不正确', false)
      );
      return;
    }
    if (
      typeof body.deviceId !== 'string' ||
      typeof body.mobilePub !== 'string' ||
      typeof body.mobileLongPub !== 'string' ||
      typeof body.deviceName !== 'string'
    ) {
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'cmd.invalid',
          'pair.hello 缺少必需字段（code/deviceId/mobilePub/mobileLongPub/deviceName）',
          false
        )
      );
      return;
    }
    this.pendingPair = {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      ...(body.platform !== undefined ? { platform: body.platform } : {}),
    };
    this.deviceId = body.deviceId;
    debug(`收到配对请求：${body.deviceName}（${body.deviceId}）`);
    // 配对挑战：challenge + 桌面公钥 + 证书指纹（tlsFingerprint 经配对码信道带外传递）
    sendFrame(
      this.ws,
      buildEnvelope('pair.challenge', {
        challenge: this.server.challenge,
        desktopPub: this.server.desktopPub,
        desktopId: this.server.state.desktopId,
        tlsFingerprint: this.server.tlsFingerprint,
      })
    );
  }

  private onPairVerify(frame: InboundEnvelope): void {
    const body = frame.body as { challengeSig?: string; devicePubSig?: string };
    if (
      typeof body.challengeSig !== 'string' ||
      typeof body.devicePubSig !== 'string' ||
      body.challengeSig === '' ||
      body.devicePubSig === ''
    ) {
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'pair.challenge_mismatch',
          '挑战签名缺失（mock 不验签，但要求非空字段）',
          false
        )
      );
      return;
    }
    if (!this.pendingPair) {
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'pair.no_challenge',
          '未发起配对请求（缺 pair.hello）',
          false
        )
      );
      return;
    }
    const device = this.pendingPair;
    this.pendingPair = null;
    // 配对成功：登记设备 + pair.ok + device.ready（D3 §4.8 step 5/6）
    this.server.state.pairDevice(
      device.deviceId,
      device.deviceName,
      device.platform
    );
    this.phase = 'handshake';
    info(`配对成功：${device.deviceName}（${device.deviceId}）`);
    // pair.ok 对齐 Rust pair_ok_body 形状 {desktopId, ttl, token}（token 为
    // 协议注册表之外的扩展，pair_endpoint.rs:177-186；移动端 parsePairOk 要求
    // token 明文——对拍裁决 2026-08-11；mock 用固定令牌占位，ttl 对齐
    // PAIR_TTL_SECONDS=86400，pair_endpoint.rs:37）
    sendFrame(
      this.ws,
      buildEnvelope('pair.ok', {
        desktopId: this.server.state.desktopId,
        ttl: 86400,
        token: MOCK_PAIR_TOKEN,
      })
    );
    sendFrame(
      this.ws,
      buildEnvelope('device.ready', { deviceId: device.deviceId })
    );
    this.server.onDeviceReady(device.deviceId);
  }

  // ── 握手期（auth.*）───────────────────────────────────────────────────

  private async onAuthHello(frame: InboundEnvelope): Promise<void> {
    const body = frame.body as {
      protocolVersions?: number[];
      capabilities?: string[];
      appVersion?: string;
      platform?: string;
      resume?: JsonValue;
    };
    // 版本协商：协议版本必须包含 1（M6 §10.2 版本协商语义）
    const versions = Array.isArray(body.protocolVersions)
      ? body.protocolVersions
      : [];
    if (!versions.includes(1)) {
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'version_mismatch',
          `协议版本不兼容：客户端 ${JSON.stringify(versions)}，mock 仅支持 1`,
          false
        )
      );
      return;
    }
    // 配对模式强制：未配对设备拒绝握手
    const candidateId = frame.auth?.deviceId ?? this.deviceId;
    if (candidateId === '') {
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'cmd.invalid',
          'auth.hello 缺少 deviceId（信封 auth.deviceId）',
          false
        )
      );
      return;
    }
    if (
      this.server.state.pairMode &&
      !this.server.state.isPaired(candidateId)
    ) {
      warn(`握手拒绝：设备未配对（${candidateId}）`);
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'auth.unknown_device',
          '设备未配对，请先完成配对流程',
          false
        )
      );
      return;
    }
    this.deviceId = candidateId;
    this.phase = 'session';
    this.server.state.touchDevice(candidateId);
    debug(
      `握手成功：device=${candidateId} app=${String(body.appVersion ?? '')} platform=${String(body.platform ?? '')}`
    );
    // 握手响应：协议版本 + manifest + serverTime 时钟校准
    sendFrame(
      this.ws,
      buildEnvelope('auth.hello.ok', {
        protocolVersion: 1,
        minProtocolVersion: 1,
        desktopId: this.server.state.desktopId,
        serverTime: Date.now(),
        capabilities: {
          streams: false,
          fileRead: true,
          taskInput: false,
          runTask: false,
          approval: ['approve', 'deny'],
        },
        manifest: this.server.state.manifest,
      })
    );
    this.server.onSessionReady(candidateId);
    // 断线重连：hello 携带逐会话游标时，直接触发场景续接（server 负责）
    if (body.resume) {
      debug(`握手携带 resume 游标：${JSON.stringify(body.resume)}`);
      await this.server.onResumeCursor(candidateId, body.resume as JsonValue);
    }
  }

  private onAuthRefresh(frame: InboundEnvelope): void {
    const body = frame.body as { refreshToken?: string };
    if (typeof body.refreshToken !== 'string' || body.refreshToken === '') {
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'auth.expired',
          'refreshToken 缺失（mock 不验签）',
          false
        )
      );
      return;
    }
    // 重连刷新成功：协议未定义 ack 帧，静默通过（失败才回 error）
    debug('auth.refresh 通过（mock 不验签）');
    if (this.phase === 'pairing') this.phase = 'session';
  }

  // ── 会话期（events.*）─────────────────────────────────────────────────

  private onSubscribe(frame: InboundEnvelope): void {
    const body = frame.body as {
      sessions?: string[];
      lastSequences?: JsonValue;
    };
    const sessions = Array.isArray(body.sessions)
      ? body.sessions.filter((s): s is string => typeof s === 'string')
      : [];
    if (sessions.length === 0 || sessions.length > 32) {
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'cmd.invalid',
          `events.subscribe：sessions 必填且 ≤32（收到 ${sessions.length}）`,
          false
        )
      );
      return;
    }
    // 订阅登记 + 逐会话 nextSequence（对齐 events.subscribe.ok 形状）
    const okSessions: {
      sessionId: string;
      nextSequence: number;
      stale: boolean;
    }[] = [];
    for (const sessionId of sessions) {
      this.subscribedSessions.add(sessionId);
      const store = this.server.state.store(sessionId);
      const max = store.maxSequence();
      const lastSeq = lastSequenceOf(body.lastSequences, sessionId);
      okSessions.push({ sessionId, nextSequence: max, stale: lastSeq > max });
      debug(`订阅会话：${sessionId}（本地游标 ${lastSeq} → 服务端 ${max}）`);
    }
    sendFrame(
      this.ws,
      buildEnvelope('events.subscribe.ok', { sessions: okSessions })
    );
    // 场景驱动：首次订阅场景会话时启动对应夹具时间线
    this.server.onSessionSubscribed(this.deviceId, sessions);
  }

  private onSubscribeAll(frame: InboundEnvelope): void {
    const body = frame.body as { events?: string[] };
    const events = Array.isArray(body.events)
      ? body.events.filter((e): e is string => typeof e === 'string')
      : [];
    // 协议未定义 subscribeAll 的 ack：静默登记（README 说明；v0 不按白名单推送）
    debug(`全局轻订阅（${events.length} 类）：${events.join(', ')}`);
  }

  private onResume(frame: InboundEnvelope): void {
    const body = frame.body as {
      sessionId?: string;
      afterSequence?: number;
      maxEvents?: number;
    };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (sessionId === '') {
      sendFrame(
        this.ws,
        errorFrame(
          frame.msgId,
          'cmd.invalid',
          'events.resume：sessionId 缺失',
          false
        )
      );
      return;
    }
    const store = this.server.state.store(sessionId);
    const after =
      typeof body.afterSequence === 'number' &&
      Number.isInteger(body.afterSequence)
        ? body.afterSequence
        : 0;
    const maxEvents =
      typeof body.maxEvents === 'number'
        ? Math.min(Math.max(1, body.maxEvents), 1000)
        : 200;
    const page = store.since(after, maxEvents);
    sendFrame(
      this.ws,
      buildEnvelope('events.resume.page', {
        sessionId,
        events: page.events.map((it) => it.event),
        nextAfterSequence: page.nextAfterSequence,
        hasMore: page.hasMore,
      })
    );
    // 末页收口：resume.done（resumedTo = 会话当前 max，桌面恢复实时推流信号）
    if (!page.hasMore) {
      sendFrame(
        this.ws,
        buildEnvelope('events.resume.done', {
          sessionId,
          resumedTo: store.maxSequence(),
        })
      );
    }
  }

  // ── 会话期（heartbeat / device.unlink / remote.*）─────────────────────

  private onHeartbeat(frame: InboundEnvelope): void {
    const body = frame.body as { ts?: number; deviceTimeMs?: number };
    if (this.deviceId !== '') this.server.state.touchDevice(this.deviceId);
    sendFrame(
      this.ws,
      buildEnvelope('heartbeat.ok', {
        ts: typeof body.ts === 'number' ? body.ts : 0,
        serverTime: Date.now(),
      })
    );
  }

  private onUnlink(frame: InboundEnvelope): void {
    const body = frame.body as { deviceId?: string };
    const target =
      typeof body.deviceId === 'string' ? body.deviceId : this.deviceId;
    this.server.state.devices.delete(target);
    info(`设备解除配对：${target}`);
    // 协议未定义 unlink 的 ack：静默（README 说明）
  }

  private onRemoteCommand(frame: InboundEnvelope): void {
    const kind = frame.kind;
    const body = frame.body as { params: JsonValue };
    const outcome = handleCommand(kind, body, {
      state: this.server.state,
      deviceId: this.deviceId,
      msgId: frame.msgId,
      emitEvent: (sessionId, event) =>
        this.server.emitEvent(sessionId, event, false),
    });
    if (outcome.ok) {
      // 回显请求 msgId（请求-响应关联键，M6 §3.3）
      sendFrame(
        this.ws,
        buildEnvelope(outcome.replyKind, {
          ...outcome.replyBody,
          reqMsgId: frame.msgId,
        })
      );
    } else {
      sendFrame(
        this.ws,
        buildEnvelope('error', { ...outcome.replyBody, reqMsgId: frame.msgId })
      );
    }
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    info(`连接关闭（device=${this.deviceId || '未标识'}）`);
    this.server.onConnectionClosed(this);
  }
}

// ── 配对码标准化（与 Rust PairCode::normalize 对齐，对拍裁决 2026-08-11）──

/** 配对码有效字符集（D3 §4.1 唯一真源：conex-types pair.rs:18 PAIR_CODE_ALPHABET） */
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 配对码有效字符数（12 × 2^5 = 60bit 熵；pair.rs:20 PAIR_CODE_LENGTH） */
const PAIR_CODE_LENGTH = 12;
/** 人读前缀（仅展示用；输入时忽略；pair.rs:22 PAIR_CODE_PREFIX） */
const PAIR_CODE_PREFIX = 'CXN';

/**
 * 标准化配对码（镜像 Rust PairCode::normalize，pair.rs:52-74）：
 * 去空白与分隔符 → 大写 → 长度 > 12 且以 CXN 起头才剥前缀（裸 12 位码以
 * CXN 起头属正常码，不得误剥）→ 校验长度 12 → 校验字符集。
 * 失败返回 null（对应跨端错误码 pair.invalid_code）。
 */
function normalizePairCode(input: string): string | null {
  const cleaned = input
    .split('')
    .filter((c) => c !== '-' && c.trim().length > 0)
    .join('')
    .toUpperCase();
  const body =
    cleaned.length > PAIR_CODE_LENGTH && cleaned.startsWith(PAIR_CODE_PREFIX)
      ? cleaned.slice(PAIR_CODE_PREFIX.length)
      : cleaned;
  if (body.length !== PAIR_CODE_LENGTH) return null;
  for (const c of body) {
    if (!PAIR_CODE_ALPHABET.includes(c)) return null;
  }
  return body;
}

function phaseOrder(phase: Phase): number {
  switch (phase) {
    case 'pairing':
      return 0;
    case 'handshake':
      return 1;
    case 'session':
      return 2;
  }
}

/** 从 lastSequences 映射中取指定会话的游标（缺省 0 = 从头续） */
function lastSequenceOf(
  lastSequences: JsonValue | undefined,
  sessionId: string
): number {
  if (
    typeof lastSequences !== 'object' ||
    lastSequences === null ||
    Array.isArray(lastSequences)
  )
    return 0;
  const v = (lastSequences as Record<string, unknown>)[sessionId];
  return typeof v === 'number' && Number.isInteger(v) ? v : 0;
}
