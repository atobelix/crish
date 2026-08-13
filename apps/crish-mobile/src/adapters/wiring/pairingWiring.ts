// 配对流程接线装配（R2-02/R2-03 wiring，D3 §4.2/§4.4/§4.8）：
// - pairMachine 驱动（src/pairing/pairMachine.ts 纯 reducer）：beginPairing（码/QR
//   解析入口）→ submitCode 注入 generateKeys（noblePrimitives 密钥对生成，D3 §4.4
//   第 1 步）→ pair.challenge 到达 → onHelloAck 存 remotePub（完整链）→ pair.ok
//   到达 → onPairOk 注入 deriveKeys（derivePairingKeys，D3 §4.4 三段链）→ 派生
//   sessionKeys → savePairingCredential（secure-store 持久化，M5 §6.3）→ 通知连接层
//   （构造 ReconnectingWsClient token + signer SignContext → 连接）；
// - 配对期连接与会话连接分离：配对期 WS 连接无 token 无签名（D3 §5.2 配对期帧可无
//   auth）；配对成功/冷启动恢复后经 ensureObservationWiring 建立**会话连接单例**
//   （observationWiring/approvalWiring 的复用点：getObservationWiring().client.gateway
//   同一实例），会话网关注入 buildRequest 签名器（signer.ts createFrameSigner +
//   canonicalSigningPayload，D3 §5.1）；
// - 简化链兼容（当前桌面实现 pair_endpoint.rs：hello → pair.ok + device.ready 直接
//   完成，无 challenge/verify，无桌面公钥下发）：pair.ok 到达时若状态仍在
//   sending-hello → 合成 onHelloAck（无 remotePub）→ onPairOk **不注入** deriveKeys
//   （pairMachine 兼容路径：paired 但 sessionKeys=null）→ tokenKey 回退 pair.ok
//   明文 token（当前桌面不验签，D3 完整链落地后由派生值替换）；
// - 错误路径：派生失败 → pairMachine error 态（pair.key_agreement_failed，可重试）；
//   持久化失败 → 错误上报且**不产生连接**；配对期传输失败 → pairing.transport_failed
//   上报；会话重连失败由 connectionStore 相位投影承载（本层只读引用
//   connectionStore.phase，防重复连接守卫 + 诊断快照）；
// - 冷启动恢复：hydrate() 读 loadPairingCredential + 本层持久化的接线元数据
//   （deviceId/desktopId/host——secure-store 凭据本身不含身份字段，M5 §6.3 仅 4 密钥位，
//   db 层扩展前由接线层自管，过渡安排）→ authStore.hydrate 恢复配对态 → 直接连接；
// - 状态同步面：authStore（pairState/onPaired/onUnpaired/configureAuthPersistence）
//   为领域层配对状态出口（并行域 R2-03 store 深化已落地，本层消费其 API）；
//   配对流程阶段（entered/verifying/failed/succeeded）经 setPairingMeta 投影。
//
// 注入模式（observationWiring/approvalWiring 同风格）：driver（secure-store）/工厂/
// generateKeys/deriveKeys/connectSession 全部可注入，测试 mock 各注入点。

import {
  PAIR_INITIAL_STATE,
  reducePairState,
  type PairEvent,
  type PairKeyDeriver,
  type PairMachineState,
} from '@/pairing/pairMachine';
import type { PairOkResult } from '@/pairing/pairProtocol';
import { parsePairError, parsePairOk } from '@/pairing/pairProtocol';
import { base64Encode, derivePairingKeys } from '@/pairing/crypto/keyAgreement';
import { noblePrimitives } from '@/pairing/crypto/noblePrimitives';
import type { KeyPrimitives, LocalKeys } from '@/pairing/crypto/primitives';
import { parsePairChallenge } from '../../../../../packages/shared-types/src/generated/device/parser';
import type { Platform } from '../../../../../packages/shared-types/src/generated/device/types';
import type { JsonValue } from '../../../../../packages/shared-types/src/primitive-types';
import { ReconnectingWsClient } from '@/network/ReconnectingWsClient';
import type { WebSocketFactory } from '@/network/ReconnectingWsClient';
import { WsGateway } from '@/network/WsGateway';
import type { SendFrame } from '@/network/WsGateway';
import { PROTOCOL_VERSION } from '@/network/protocolVersion';
import type { OutgoingEnvelope, InboundEnvelope } from '@/network/WsEnvelope';
import {
  createFrameSigner,
  base64Encode as signerBase64Encode,
} from '@/network/signer';
import type { FrameSigner } from '@/network/signer';
import { resolveWsUrl, DEFAULT_GATEWAY_PORT } from '@/network/EndpointResolver';
import type { WsPhase } from '@/domain/pure/selectors';
import { connectionStore } from '@/domain/store/connectionStore';
import type { ConnectionPhase } from '@/domain/store/connectionStore';
import {
  authStore,
  configureAuthPersistence,
  type AuthIdentityMeta,
  type AuthPersist,
} from '@/domain/store/authStore';
import {
  clearPairing,
  loadPairingCredential,
  savePairingCredential,
  type PairingCredential,
  type SecureStoreDriver,
} from '@/db/secureStore';
import {
  ensureObservationWiring,
  getObservationWiring,
} from './observationWiring';

// ── 接线层自管元数据键（secure-store；凭据本身不含身份字段，见文件头）─────────

/** 本机设备 id（signer SignContext.deviceId 冷启动恢复源） */
export const PAIRING_META_DEVICE_ID_KEY = 'pairing.meta.device_id';
/** 桌面 Hub id（pair.ok desktopId，冷启动恢复） */
export const PAIRING_META_DESKTOP_ID_KEY = 'pairing.meta.desktop_id';
/** 桌面连接主机（冷启动恢复端点） */
export const PAIRING_META_HOST_KEY = 'pairing.meta.host';

/** 缺省设备名（pair.hello deviceName 兜底，对齐 pair/manual.tsx 占位） */
export const DEFAULT_DEVICE_NAME = 'crish-mobile';

/** 引擎传输安全开关（R2-16 联调豁免，裁决-1）：`EXPO_PUBLIC_ENGINE_TLS=false`
 *  → 配对期/会话端点解析为明文 ws（联调 harness tls_enabled=false 场景；
 *   RN WebSocket 无自签证书信任选项，R2-16-e2e-plan §3.1 风险 R-1）；
 *  缺省/其它值 → wss（生产装配语义不变）。与 observationWiring 的
 *  EXPO_PUBLIC_ENGINE_URL env 模式对齐（D8 §6.2 优先级 1）。 */
export function engineTlsEnabled(): boolean {
  return process.env.EXPO_PUBLIC_ENGINE_TLS !== 'false';
}

// ── 领域类型（接线层出入口）─────────────────────────────────────────────────

/** 接线层错误（code 复用 pairMachine/PairErrorInfo 领域码 + 接线层本地码） */
export interface PairingWiringError {
  /** 错误码（pair.* / pairing.*；派生失败 = pairMachine error.code） */
  code: string;
  message: string;
  retryable: boolean;
}

/** 发起配对入参（码 + 端点；QR 载荷 parseQrPayload 解析后同构传入） */
export interface PairingInput {
  /** 配对码（容错：CXN 前缀/分隔符/大小写均可，reducer 内标准化） */
  code: string;
  /** 桌面主机（IP/域名） */
  host: string;
  /** 网关端口（缺省 8765，D3 §3.1） */
  port?: number;
  /** 设备 id（缺省自动生成 dev-<10 位 base32>） */
  deviceId?: string;
  /** 设备名（≤64，空串兜底 remote-device） */
  deviceName?: string;
  /** 端平台（wire lowercase，可选） */
  platform?: Platform;
}

/** beginPairing 结果（ok=false 时 error 为本地拒绝原因，未发起网络） */
export interface PairingStartResult {
  ok: boolean;
  /** 拒绝/校验错误描述（inputError 或状态拒绝） */
  error?: string;
}

/** 会话连接上下文（配对成功/冷启动恢复后通知连接层） */
export interface PairingSessionContext {
  /** 会话端点（wss://host:8765；当前 authStore 无端口字段 → 默认端口） */
  url: string;
  host: string;
  /** 本机设备 id（SignContext.deviceId） */
  deviceId: string;
  /** 桌面 Hub id（pair.ok desktopId） */
  desktopId: string;
  /** 连接层令牌（pair.ok 明文 token；当前桌面 WS 升级鉴权凭证） */
  token: string;
  /** 签名密钥材料（SignContext.tokenKey：D3 派生值或简化链回退明文 token） */
  tokenKey: string;
}

/** 会话连接器（注入面：默认 = defaultConnectSession 走 observationWiring 复用） */
export type SessionConnector = (ctx: PairingSessionContext) => void;

/** 配对接线装配选项（全部注入点；driver 必填） */
export interface PairingWiringOptions {
  /** 安全存储驱动（真实环境 expo-secure-store 驱动；测试 InMemorySecureStore） */
  driver: SecureStoreDriver;
  /** 密钥原语（缺省 noblePrimitives；测试可注入确定性实现） */
  primitives?: KeyPrimitives;
  /** 配对期 WS 工厂（缺省 RN 全局 WebSocket；测试注入 mock） */
  factory?: WebSocketFactory;
  /** 时钟（缺省 Date.now；测试固定/推进） */
  now?: () => number;
  /** 密钥对生成注入（缺省 = 原语生成 ephemeral + longTerm；D3 §4.4 第 1 步） */
  generateKeys?: () => LocalKeys;
  /** 密钥派生注入（缺省 = derivePairingKeys + 原语；D3 §4.4 三段链） */
  deriveKeys?: PairKeyDeriver;
  /** 会话连接器（缺省 = defaultConnectSession；测试注入记录 mock） */
  connectSession?: SessionConnector;
  /** 错误上报回调（错误发生时调用；机器 error 态 + 接线层本地错误） */
  onError?: (err: PairingWiringError) => void;
  /** 配对端点覆盖（缺省 resolveWsUrl(host, port)；测试注入固定地址） */
  url?: string;
  /** 缺省设备名（缺省 crish-mobile） */
  deviceName?: string;
}

/** 接线快照（UI 订阅面：机器态 + 最近错误 + 会话相位只读投影） */
export interface PairingSnapshot {
  machine: PairMachineState;
  error: PairingWiringError | null;
  /** connectionStore 相位只读投影（会话连接数据面） */
  sessionPhase: ConnectionPhase;
}

// ── 会话签名（D3 §5.1：buildRequest 注入点）─────────────────────────────────

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

// ── 持久化接口装配（authStore.AuthPersist 注入面，M5 §6.3）──────────────────

/**
 * secure-store 组装 AuthPersist（authStore 注释「接线层组装」落点）：
 * load = loadPairingCredential；save = savePairingCredential；clear = clearPairing。
 */
export function buildAuthPersist(driver: SecureStoreDriver): AuthPersist {
  return {
    load: () => loadPairingCredential(driver),
    save: (cred) => savePairingCredential(driver, cred),
    clear: () => clearPairing(driver),
  };
}

// ── 配对期网关（发送就绪信号）───────────────────────────────────────────────

/**
 * attachSend 感知网关：ReconnectingWsClient.handleOpen 的时序为 setPhase('open')
 * （触发 onPhaseChange 回调）→ gateway.attachSend——相位回调内发送会因 sendFn
 * 未接线被 WsGateway.send 静默丢弃。本网关把「发送管线就绪」（attachSend 完成）
 * 作为一等信号 onSendReady 上抛，配对 hello 据此发送（O(1) 无时序假设）。
 */
class PairingGateway extends WsGateway {
  private sendReadyHooks: Array<() => void> = [];

  attachSend(send: SendFrame): void {
    super.attachSend(send);
    for (const hook of [...this.sendReadyHooks]) {
      hook();
    }
  }

  /** 发送就绪订阅（每次 open 触发一次；返回退订函数） */
  onSendReady(hook: () => void): () => void {
    this.sendReadyHooks.push(hook);
    return () => {
      this.sendReadyHooks = this.sendReadyHooks.filter((h) => h !== hook);
    };
  }
}

// ── 配对接线装配（pairMachine 驱动 + 配对期连接 + 持久化 + 会话连接）─────────

export class PairingWiring {
  private readonly driver: SecureStoreDriver;
  private readonly primitives: KeyPrimitives;
  private readonly generateKeys: () => LocalKeys;
  private readonly deriveKeys: PairKeyDeriver;
  private readonly connectSession: SessionConnector;
  private readonly nowFn: () => number;
  private readonly factory?: WebSocketFactory;
  private readonly urlOverride?: string;
  private readonly deviceName: string;
  private readonly onError?: (err: PairingWiringError) => void;
  /** AuthPersist 装配（authStore 持久化注入面；onPaired/onUnpaired/hydrate 显式传入） */
  private readonly persist: AuthPersist;

  /** pairMachine 状态（本层持有，纯 reducer 驱动） */
  private machine: PairMachineState = { ...PAIR_INITIAL_STATE };
  /** 最近一次接线层错误（机器 error 态 + 本地错误；UI 诊断展示） */
  private lastError: PairingWiringError | null = null;
  /** 配对期连接（无 token 无签名；配对成功/重置时关闭） */
  private pairingClient: ReconnectingWsClient | null = null;
  /** 配对期网关退订 */
  private pairingUnsubs: Array<() => void> = [];
  /** 当前配对目标（beginPairing 记录；finalize/hydrate 消费） */
  private pairingHost = '';
  private pairingPort = DEFAULT_GATEWAY_PORT;
  /** 会话连接 device.revoked 退订（桌面撤销 → 自动解除） */
  private revokedUnsub: (() => void) | null = null;
  /** 订阅者（UI 快照通知） */
  private readonly listeners = new Set<() => void>();
  /** hydrate 在途去重（并发调用共享同一 Promise） */
  private hydrateInflight: Promise<boolean> | null = null;

  constructor(opts: PairingWiringOptions) {
    this.driver = opts.driver;
    this.primitives = opts.primitives ?? noblePrimitives;
    this.generateKeys =
      opts.generateKeys ??
      (() => ({
        ephemeral: this.primitives.generateKeyPair(),
        longTerm: this.primitives.generateKeyPair(),
      }));
    this.deriveKeys =
      opts.deriveKeys ?? ((m) => derivePairingKeys(m, this.primitives));
    this.connectSession = opts.connectSession ?? defaultConnectSession;
    this.nowFn = opts.now ?? (() => Date.now());
    this.factory = opts.factory;
    this.urlOverride = opts.url;
    this.deviceName = opts.deviceName ?? DEFAULT_DEVICE_NAME;
    this.onError = opts.onError;
    this.persist = buildAuthPersist(this.driver);
  }

  // ── 快照 / 订阅（UI 数据面）───────────────────────────────────────────────

  /** 订阅配对状态变化（返回退订函数） */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 当前快照（machine + 错误 + 会话相位只读投影） */
  getSnapshot(): PairingSnapshot {
    return {
      machine: this.machine,
      error: this.lastError,
      sessionPhase: connectionStore.getState().phase,
    };
  }

  /** pairMachine 状态直读（测试/诊断） */
  getMachineState(): PairMachineState {
    return this.machine;
  }

  /** 最近错误直读（测试/诊断） */
  getLastError(): PairingWiringError | null {
    return this.lastError;
  }

  /** 配对期连接直读（测试注入帧 dispatch 入口） */
  getPairingClient(): ReconnectingWsClient | null {
    return this.pairingClient;
  }

  /** 注入 authStore 默认持久化（应用侧 authStore.hydrate() 无参调用即恢复配对态；
   *  仅单例装配路径调用，测试实例不产生全局副作用） */
  configure(): void {
    configureAuthPersistence(this.persist);
  }

  // ── 冷启动恢复（M5 §7.1 步骤 2 / 任务书「冷启动已配对 → 直接连接」）─────────

  /** 启动水合：loadPairingCredential + 接线元数据 → 恢复配对态 → 直接连接。
   *  无凭据 → false（走配对引导）；凭据存在但接线元数据缺失 → 自愈清空 + 上报。 */
  async hydrate(): Promise<boolean> {
    if (this.hydrateInflight) return this.hydrateInflight;
    this.hydrateInflight = this.doHydrate();
    try {
      return await this.hydrateInflight;
    } finally {
      this.hydrateInflight = null;
    }
  }

  private async doHydrate(): Promise<boolean> {
    const cred = await loadPairingCredential(this.driver);
    if (!cred) return false;
    const [deviceId, desktopId, host] = await Promise.all([
      this.driver.getItem(PAIRING_META_DEVICE_ID_KEY),
      this.driver.getItem(PAIRING_META_DESKTOP_ID_KEY),
      this.driver.getItem(PAIRING_META_HOST_KEY),
    ]);
    if (!deviceId || !desktopId || !host) {
      // 凭据在但身份元数据缺失（旧版本/写半截）→ 不可恢复 signer 上下文，自愈清空
      await clearPairing(this.driver);
      this.reportError({
        code: 'pairing.stale_credential',
        message: '配对凭据不完整（缺少设备身份），已清理——请重新配对',
        retryable: true,
      });
      return false;
    }
    await authStore
      .getState()
      .hydrate(this.persist, { deviceId, desktopId, host });
    // 冷启动已配对 → 直接连接（tokenKey 即持久化的会话密钥材料）
    this.connectSessionOnce({
      url: resolveWsUrl(host, DEFAULT_GATEWAY_PORT, engineTlsEnabled()),
      host,
      deviceId,
      desktopId,
      token: cred.tokenKey,
      tokenKey: cred.tokenKey,
    });
    return true;
  }

  // ── 配对流程驱动（pairMachine 事件出口）───────────────────────────────────

  /**
   * 发起配对（码/QR 解析入口）：状态归一 → submitCode（注入 generateKeys）→
   * 建立配对期连接 → open 相位发送 pair.hello。本地校验失败/状态拒绝返回错误
   * （不发起网络）；locked 需先 reset；paired 需先 unpair。
   */
  beginPairing(input: PairingInput): PairingStartResult {
    this.lastError = null;
    const host = input.host.trim();
    if (host.length === 0) {
      return { ok: false, error: '主机不能为空' };
    }
    let s = this.machine;
    // 状态归一：任何非终态可重新发起（换码 = 换会话语义，机器内部重置失败计数）
    if (s.state === 'paired') {
      return { ok: false, error: '已配对：请先解除配对（unpair）再重新配对' };
    }
    if (s.state === 'locked') {
      return { ok: false, error: '配对已锁定：请先 reset 重置' };
    }
    if (s.state === 'idle') {
      s = reducePairState(s, { type: 'begin' });
    } else if (s.state === 'error') {
      s = reducePairState(s, { type: 'retry' });
    } else {
      // sending-hello / waiting-verify：取消在途流程重新开始
      s = reducePairState(s, { type: 'reset' });
      s = reducePairState(s, { type: 'begin' });
    }
    s = reducePairState(s, {
      type: 'submitCode',
      code: input.code,
      deviceId: input.deviceId,
      deviceName: input.deviceName ?? this.deviceName,
      platform: input.platform,
      generateKeys: this.generateKeys,
    });
    if (s.inputError) {
      this.machine = s;
      this.emit();
      return { ok: false, error: s.inputError };
    }
    if (s.state !== 'sending-hello' || !s.pendingHello) {
      this.machine = s;
      this.emit();
      return { ok: false, error: '配对流程内部错误（pair.hello 未产出）' };
    }
    this.machine = s;
    this.pairingHost = host;
    this.pairingPort = input.port ?? DEFAULT_GATEWAY_PORT;
    authStore.getState().setPairingMeta({
      host,
      port: this.pairingPort,
      code: input.code,
      stage: 'entered',
    });
    this.emit();
    this.openPairingConnection();
    return { ok: true };
  }

  /** 错误态重试（error → waiting-input；保留失败计数与错误展示，改码重提交） */
  retry(): void {
    if (this.machine.state !== 'error') return;
    this.dispatch({ type: 'retry' });
  }

  /** 重置配对流程（清机器态 + 断开配对期连接；paired 终态需走 unpair） */
  reset(): void {
    this.closePairingConnection();
    this.machine = reducePairState(this.machine, { type: 'reset' });
    this.emit();
  }

  /**
   * 解除配对（主动移除/桌面撤销）：通知桌面解除（best-effort，失败不回滚本地
   * 清除——M5 §6.2「无论桌面撤销是否成功都清空」）→ clearPairing + 接线元数据
   * 删除 → 断开会话连接 → 机器态复位（paired 为终态拒绝 reset，解绑属外部
   * 生命周期重置，直接回初始态）。
   */
  async unpair(): Promise<void> {
    if (this.machine.state === 'paired') {
      const obs = getObservationWiring();
      if (obs) {
        void obs.client.gateway
          .invoke('device.unlink', {
            deviceId: this.machine.pendingHello?.deviceId ?? '',
          })
          .catch(() => {
            // 桌面未实现/失败：本地清除权威（M5 §6.2）
          });
      }
    }
    await authStore.getState().onUnpaired(this.persist);
    await Promise.all([
      this.driver.deleteItem(PAIRING_META_DEVICE_ID_KEY),
      this.driver.deleteItem(PAIRING_META_DESKTOP_ID_KEY),
      this.driver.deleteItem(PAIRING_META_HOST_KEY),
    ]);
    this.detachRevokedHandler();
    getObservationWiring()?.client.disconnect();
    this.closePairingConnection();
    this.machine = { ...PAIR_INITIAL_STATE };
    this.lastError = null;
    this.emit();
  }

  /** 测试隔离：断开配对期连接 + 退订会话撤销处理 + 机器复位（不碰 secure-store） */
  dispose(): void {
    this.closePairingConnection();
    this.detachRevokedHandler();
    this.machine = { ...PAIR_INITIAL_STATE };
    this.lastError = null;
    this.listeners.clear();
  }

  // ── 机器驱动内部（事件分发 + 侧效应）─────────────────────────────────────

  /** 统一事件分发：reduce → 快照通知 → 错误态上报（error/locked 衔接 onError） */
  private dispatch(event: PairEvent): void {
    this.machine = reducePairState(this.machine, event);
    this.emit();
    if (
      (this.machine.state === 'error' || this.machine.state === 'locked') &&
      this.machine.error
    ) {
      this.reportError({
        code: this.machine.error.code,
        message: this.machine.error.message,
        retryable: this.machine.error.retryable,
      });
      authStore.getState().setPairingMeta({ stage: 'failed' });
    }
  }

  // ── 配对期连接（无 token 无签名；D3 §5.2 配对期帧可无 auth）────────────────

  /** 建立配对期连接（先断旧）并订阅配对帧；连接失败 → transport 错误上报 */
  private openPairingConnection(): void {
    this.closePairingConnection();
    const url =
      this.urlOverride ??
      resolveWsUrl(this.pairingHost, this.pairingPort, engineTlsEnabled());
    const gateway = new PairingGateway({ msgIdPrefix: 'mob' });
    const client = new ReconnectingWsClient({
      url,
      gateway,
      ...(this.factory ? { factory: this.factory } : {}),
      onPhaseChange: (phase) => this.handlePairingPhase(phase),
    });
    this.pairingClient = client;
    this.pairingUnsubs = [
      gateway.on('pair.challenge', (f) => this.handleChallenge(f)),
      gateway.on('pair.ok', (f) => this.handlePairOk(f)),
      gateway.on('error', (f) => this.handlePairError(f)),
      // 发送管线就绪（attachSend 完成）→ 发送 pair.hello；相位回调早于 attachSend
      // 不可用（WsGateway.send 对未接线 sendFn 静默丢弃），见 PairingGateway 注释
      gateway.onSendReady(() => this.sendHello()),
    ];
    try {
      client.connect();
    } catch (e) {
      this.reportError({
        code: 'pairing.transport_failed',
        message: e instanceof Error ? e.message : '配对连接建立失败',
        retryable: true,
      });
    }
  }

  /** 断开配对期连接（退订 + disconnect；配对成功/重置/解绑调用） */
  private closePairingConnection(): void {
    for (const unsub of this.pairingUnsubs) {
      unsub();
    }
    this.pairingUnsubs = [];
    this.pairingClient?.disconnect();
    this.pairingClient = null;
  }

  /** 配对期连接相位：dead → 传输失败上报（机器保持 sending-hello，用户可重新
   *  beginPairing；重连计数语义在连接层）。hello 发送不在相位回调内（早于
   *  attachSend，见 PairingGateway），由发送就绪信号驱动。 */
  private handlePairingPhase(phase: WsPhase): void {
    if (phase === 'dead') {
      this.reportError({
        code: 'pairing.transport_failed',
        message: '配对连接失败（多次重连未恢复），请重试',
        retryable: true,
      });
    }
  }

  /** 发送 pair.hello（open 相位调用；D3 §4.8 step 1 + §4.4 公钥进帧） */
  private sendHello(): void {
    const s = this.machine;
    if (s.state !== 'sending-hello' || !s.pendingHello) return;
    this.pairingClient?.gateway.send('pair.hello', s.pendingHello);
    authStore.getState().setPairingMeta({ stage: 'verifying' });
  }

  // ── 配对帧消费（pair.challenge / pair.ok / error）─────────────────────────

  /** pair.challenge（完整链，D3 §4.8 step 2）：桌面公钥 → onHelloAck 存 remotePub */
  private handleChallenge(frame: InboundEnvelope): void {
    if (this.machine.state !== 'sending-hello') return; // 乱序/重复挑战忽略
    const parsed = parsePairChallenge(frame.body);
    if (!parsed.ok) {
      this.reportError({
        code: 'pairing.bad_challenge',
        message: `pair.challenge 载荷解析失败：${parsed.error}`,
        retryable: true,
      });
      return;
    }
    this.dispatch({ type: 'onHelloAck', remotePub: parsed.data.desktopPub });
  }

  /**
   * pair.ok（D3 §4.8 step 5，含 token 明文扩展）：
   * - 简化链（当前桌面实现，无 challenge）：sending-hello → 合成 onHelloAck →
   *   onPairOk **不注入** deriveKeys（无桌面公钥，D3 ECDH 无法完成）→ paired 但
   *   sessionKeys=null，tokenKey 回退明文 token；
   * - 完整链（challenge 已收 remotePub）：onPairOk 注入 deriveKeys → 派生
   *   sessionKeys → paired；
   * - 派生失败 → 机器 error（pair.key_agreement_failed，可重试，dispatch 上报）。
   */
  private handlePairOk(frame: InboundEnvelope): void {
    let s = this.machine;
    if (s.state === 'sending-hello') {
      s = reducePairState(s, { type: 'onHelloAck' });
      this.machine = s;
    }
    if (s.state !== 'waiting-verify') return; // 乱序/重复 ok → 忽略
    const parsed = parsePairOk(frame.body);
    if (!parsed.ok) {
      this.reportError({
        code: 'pairing.bad_ok',
        message: `pair.ok 载荷解析失败：${parsed.error}`,
        retryable: true,
      });
      return;
    }
    const hasRemotePub = s.pendingRemotePub !== null;
    const next = reducePairState(s, {
      type: 'onPairOk',
      desktopId: parsed.data.desktopId,
      ttl: parsed.data.ttl,
      token: parsed.data.token,
      ...(hasRemotePub ? { deriveKeys: this.deriveKeys } : {}),
    });
    this.machine = next;
    this.emit();
    if (next.state === 'paired' && next.result) {
      void this.finalizePairing(next.result);
    } else if (next.state === 'error' && next.error) {
      this.reportError({
        code: next.error.code,
        message: next.error.message,
        retryable: next.error.retryable,
      });
      authStore.getState().setPairingMeta({ stage: 'failed' });
    }
  }

  /** error 帧（D3 §6.2）：pair.* 错误码 → onPairError（error/locked 转移） */
  private handlePairError(frame: InboundEnvelope): void {
    const parsed = parsePairError(frame.body);
    if (!parsed.ok) return; // 畸形错误帧：宽容丢弃（协议层同语义）
    this.dispatch({ type: 'onPairError', error: parsed.data });
  }

  // ── 配对收口（持久化 → 状态收口 → 会话连接）──────────────────────────────

  /**
   * 配对成功收口：装配凭据（tokenKey/refreshKey = 派生值，简化链回退明文 token；
   * 设备密钥对 = 长期对 base64）→ 接线元数据落库 → authStore.onPaired（写
   * secure-store + 状态收口）→ 断开配对期连接 → 通知连接层（会话连接）。任何
   * 持久化失败 → 错误上报且**不产生连接**。
   */
  private async finalizePairing(ok: PairOkResult): Promise<void> {
    const s = this.machine;
    const hello = s.pendingHello;
    const localKeys = s.localKeys;
    if (!hello || !localKeys) {
      this.reportError({
        code: 'pairing.internal',
        message: '配对收口缺少密钥材料（hello/本地密钥对）',
        retryable: false,
      });
      return;
    }
    const deviceId = hello.deviceId;
    const tokenKey = s.sessionKeys?.tokenKey ?? ok.token; // 简化链回退
    const refreshKey = s.sessionKeys?.refreshKey ?? ok.token;
    const cred: PairingCredential = {
      tokenKey,
      refreshKey,
      deviceKeypairPriv: base64Encode(localKeys.longTerm.privateKey),
      deviceKeypairPub: base64Encode(localKeys.longTerm.publicKey),
    };
    const meta: AuthIdentityMeta = {
      deviceId,
      desktopId: ok.desktopId,
      host: this.pairingHost,
    };
    try {
      await Promise.all([
        this.driver.setItem(PAIRING_META_DEVICE_ID_KEY, deviceId),
        this.driver.setItem(PAIRING_META_DESKTOP_ID_KEY, ok.desktopId),
        this.driver.setItem(PAIRING_META_HOST_KEY, this.pairingHost),
      ]);
      // authStore 收口：写 secure-store（persist+cred）+ 状态面（paired/身份/令牌）
      await authStore
        .getState()
        .onPaired(
          meta,
          { issuedAt: this.nowFn(), ttlMs: ok.ttl * 1000 },
          { persist: this.persist, cred }
        );
    } catch (e) {
      // 持久化失败：错误上报 + **不产生连接**（任务书错误路径）；半截写入的
      // 凭据/元数据自清理（防止冷启动读到不完整凭据后误恢复）
      await Promise.all([
        clearPairing(this.driver),
        this.driver.deleteItem(PAIRING_META_DEVICE_ID_KEY),
        this.driver.deleteItem(PAIRING_META_DESKTOP_ID_KEY),
        this.driver.deleteItem(PAIRING_META_HOST_KEY),
      ]).catch(() => {
        // 清理失败不阻断错误上报（尽力而为）
      });
      this.reportError({
        code: 'pairing.persist_failed',
        message: `配对凭据持久化失败：${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
      });
      authStore.getState().setPairingMeta({ stage: 'failed' });
      this.closePairingConnection();
      return; // 持久化失败：不产生连接
    }
    this.closePairingConnection();
    this.connectSessionOnce({
      url:
        this.urlOverride ??
        resolveWsUrl(
          this.pairingHost,
          DEFAULT_GATEWAY_PORT,
          engineTlsEnabled()
        ),
      host: this.pairingHost,
      deviceId,
      desktopId: ok.desktopId,
      token: ok.token,
      tokenKey,
    });
  }

  /** 会话连接（防重复守卫）：connectionStore 相位只读引用——连接中/已就绪不再
   *  重复建立（配对成功与冷启动恢复同源路径，重连中相位同样跳过避免打断退避） */
  private connectSessionOnce(ctx: PairingSessionContext): void {
    const phase = connectionStore.getState().phase;
    if (phase === 'connecting' || phase === 'ready') return;
    this.connectSession(ctx);
    this.attachRevokedHandler(ctx.deviceId);
  }

  /** 桌面撤销监听（device.revoked 匹配本机 → 自动解除；被动事件，M5 §6.2） */
  private attachRevokedHandler(deviceId: string): void {
    this.detachRevokedHandler();
    const gateway = getObservationWiring()?.client.gateway;
    if (!gateway) return;
    this.revokedUnsub = gateway.on('device.revoked', (frame) => {
      const body = frame.body as Record<string, unknown> | null;
      const revokedId = body?.['deviceId'];
      if (typeof revokedId === 'string' && revokedId === deviceId) {
        void this.unpair();
      }
    });
  }

  private detachRevokedHandler(): void {
    this.revokedUnsub?.();
    this.revokedUnsub = null;
  }

  // ── 错误上报 / 快照通知 ───────────────────────────────────────────────────

  private reportError(err: PairingWiringError): void {
    this.lastError = err;
    this.onError?.(err);
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

// ── 装配出口（observationWiring 同风格：start 组合 / ensure 单例 / reset 隔离）──

let singleton: PairingWiring | null = null;

/** 装配配对接线（注入点全可测；driver 必填） */
export function startPairingWiring(opts: PairingWiringOptions): PairingWiring {
  return new PairingWiring(opts);
}

/**
 * 配对接线单例（应用启动时调用；幂等）。装配时注入 authStore 默认持久化
 * （configureAuthPersistence：应用侧 authStore.hydrate() 无参调用即可恢复配对态）
 * 并触发冷启动恢复（fire-and-forget，已配对 → 直接连接）。
 */
export function ensurePairingWiring(opts: PairingWiringOptions): PairingWiring {
  if (singleton) return singleton;
  singleton = startPairingWiring(opts);
  singleton.configure();
  void singleton.hydrate();
  return singleton;
}

/** 当前接线单例读取（测试/诊断；未装配返回 null） */
export function getPairingWiring(): PairingWiring | null {
  return singleton;
}

/** 测试隔离：清空配对接线单例（仅测试调用；authStore 默认持久化一并复位） */
export function resetPairingWiringForTest(): void {
  singleton?.dispose();
  singleton = null;
  configureAuthPersistence(null);
}
