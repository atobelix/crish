// 配对流程接线装配测试（R2-02/R2-03 wiring）：
// - 全链装配：begin → pair.hello 帧（公钥进帧）→ challenge（remotePub）→ ok →
//   deriveKeys 派生 → secure-store 持久化（4 密钥位 + 接线元数据）→ 会话连接
//   （token + 派生 tokenKey + deviceId）→ 配对期连接断开；
// - 简化链（当前桌面实现：无 challenge）：ok 直接完成 → paired（sessionKeys=null）
//   → tokenKey 回退明文 token → 仍持久化并连接；deriveKeys 不注入；
// - 冷启动恢复：hydrate 读凭据 + 元数据 → authStore 恢复 paired → 直接连接；
//   凭据在但元数据缺失 → 自愈清空 + 上报；
// - unpair 清理：secure-store 全清 + 元数据删除 + 会话断开 + authStore 复位；
// - 错误路径：派生失败 → pairMachine error 态（pair.key_agreement_failed）→ 不
//   持久化不连接；持久化失败 → 上报且不产生连接（半截写入自清理）；pair 错误帧
//   → onPairError（失败计数 +1 可重试）；连接工厂抛错 → transport 上报；
// - connectionStore 相位只读引用：会话已就绪（ready）→ 配对成功不重复连接；
// - 会话签名：buildSignedRequest 与 signer 锚点一致（canon 可验）；
// - 缺省会话连接器：token 注入 observationWiring 单例 + 出站帧自动签名。
// 测试风格对齐 approvalWiring.test.ts：真实 WsGateway + 注入捕获 send + 手工 dispatch 帧。
import {
  InMemorySecureStore,
  KEYS,
  hasPairing,
  savePairingCredential,
} from '@/db/secureStore';
import { noblePrimitives } from '@/pairing/crypto/noblePrimitives';
import { base64Encode, derivePairingKeys } from '@/pairing/crypto/keyAgreement';
import type { PairKeyMaterial } from '@/pairing/crypto/keyAgreement';
import { authStore } from '@/domain/store/authStore';
import { connectionStore } from '@/domain/store/connectionStore';
import {
  createFrameSigner,
  signMessage,
  verifySignature,
} from '@/network/signer';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { JsonValue } from '@crish/shared-types';
import type { WsSocket } from '@/network/ReconnectingWsClient';
import {
  ensureObservationWiring,
  getObservationWiring,
  resetObservationWiringForTest,
} from '../observationWiring';
import {
  buildAuthPersist,
  engineTlsEnabled,
  PAIRING_META_DEVICE_ID_KEY,
  PAIRING_META_DESKTOP_ID_KEY,
  PAIRING_META_HOST_KEY,
} from './pairingPersistence';
import {
  buildSessionGateway,
  buildSignedRequest,
  defaultConnectSession,
  randomNonce,
} from './sessionSigning';
import {
  resetPairingWiringForTest,
  startPairingWiring,
} from './pairingAssembly';
import type {
  PairingSessionContext,
  PairingWiring,
  PairingWiringError,
  PairingWiringOptions,
} from './PairingWiring';

const VALID_CODE = 'CXN-7K4P-Q2MB-9XRT';

/** mock socket（ReconnectingWsClient 工厂注入面） */
type MockSocket = WsSocket & { sent: string[]; closed: boolean };

function makeSocket(): MockSocket {
  const sent: string[] = [];
  const socket: MockSocket = {
    sent,
    closed: false,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data: string) => {
      sent.push(data);
    },
    close: () => {
      socket.closed = true;
    },
  };
  return socket;
}

/** 入站帧构造（desktop → mobile 广播形态） */
function frame(kind: string, body: unknown): InboundEnvelope {
  return {
    v: 1,
    kind,
    msgId: `m-in-${Math.random().toString(36).slice(2)}`,
    ts: 1,
    from: 'desktop',
    to: 'mobile',
    body: body as JsonValue,
  };
}

/** 固定派生值（测试注入点 mock） */
const FIXED_SESSION_KEYS = {
  tokenKey: 'TK-1',
  encKey: 'EK-1',
  refreshKey: 'RK-1',
};

interface Harness {
  driver: InMemorySecureStore;
  wiring: PairingWiring;
  sockets: MockSocket[];
  sessionCtxs: PairingSessionContext[];
  errors: PairingWiringError[];
  deriveCalls: PairKeyMaterial[];
}

/** 装配 harness（各注入点 mock：工厂/连接器/派生/错误回调；可覆盖） */
function makeHarness(opts: Partial<PairingWiringOptions> = {}): Harness {
  const driver = new InMemorySecureStore();
  const sockets: MockSocket[] = [];
  const sessionCtxs: PairingSessionContext[] = [];
  const errors: PairingWiringError[] = [];
  const deriveCalls: PairKeyMaterial[] = [];
  const wiring = track(
    startPairingWiring({
      driver,
      factory: () => {
        const socket = makeSocket();
        sockets.push(socket);
        return socket;
      },
      connectSession: (ctx) => {
        sessionCtxs.push(ctx);
      },
      deriveKeys: (m) => {
        deriveCalls.push(m);
        return (opts.deriveKeys ?? (() => FIXED_SESSION_KEYS))(m);
      },
      onError: (e) => {
        errors.push(e);
      },
      ...opts,
    })
  );
  return { driver, wiring, sockets, sessionCtxs, errors, deriveCalls };
}

/** 等待配对收口异步链（finalize 的微任务/宏任务全部落定） */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 已创建接线实例（afterEach 统一 dispose：断开配对连接防心跳定时器挂住 jest） */
const trackedWirings: PairingWiring[] = [];

function track(wiring: PairingWiring): PairingWiring {
  trackedWirings.push(wiring);
  return wiring;
}

function pushDesktopPub(): string {
  return base64Encode(noblePrimitives.generateKeyPair().publicKey);
}

/** 标准配对流程：begin → open → hello → challenge → ok（完整链） */
async function runFullChain(
  h: Harness,
  opts: { host?: string; desktopPub?: string; token?: string } = {}
): Promise<void> {
  const host = opts.host ?? '10.0.0.2';
  h.wiring.beginPairing({ code: VALID_CODE, host });
  h.sockets[0]!.onopen!();
  h.wiring.getPairingClient()!.gateway.dispatchFrame(
    frame('pair.challenge', {
      challenge: 'ch-1',
      desktopPub: opts.desktopPub ?? pushDesktopPub(),
      desktopId: 'crish-desktop',
      tlsFingerprint: 'fp-1',
    })
  );
  h.wiring.getPairingClient()!.gateway.dispatchFrame(
    frame('pair.ok', {
      desktopId: 'crish-desktop',
      ttl: 86400,
      token: opts.token ?? 'tok-abc',
    })
  );
  await flush();
}

beforeEach(() => {
  authStore.getState().clearPairing();
  connectionStore.getState().reset();
  resetObservationWiringForTest();
  resetPairingWiringForTest();
});

afterEach(() => {
  for (const wiring of trackedWirings) {
    wiring.dispose();
  }
  trackedWirings.length = 0;
  resetObservationWiringForTest();
  resetPairingWiringForTest();
});

describe('全链装配（begin → hello → ok → 派生 → 持久化 → 连接）', () => {
  it('完整链（challenge 携带桌面公钥）：公钥进帧 → remotePub → 派生 → 持久化 → 会话连接 → 断开配对连接', async () => {
    const h = makeHarness({
      deriveKeys: (m) => derivePairingKeys(m, noblePrimitives),
    });
    const desktopPub = pushDesktopPub();
    const r = h.wiring.beginPairing({
      code: 'cxn-7k4p-q2mb-9xrt',
      host: '192.168.1.5',
    });
    expect(r.ok).toBe(true);
    expect(h.wiring.getMachineState().state).toBe('sending-hello');
    // open → pair.hello 帧（无 auth：配对期帧，D3 §5.2）
    h.sockets[0]!.onopen!();
    const helloEnv = JSON.parse(h.sockets[0]!.sent[0]!) as {
      kind: string;
      body: Record<string, unknown>;
    };
    expect(helloEnv.kind).toBe('pair.hello');
    expect(helloEnv.body['code']).toBe('7K4PQ2MB9XRT');
    expect(helloEnv.body['deviceId']).toMatch(/^dev-/);
    expect(helloEnv.body['mobilePub']).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(helloEnv.body['mobileLongPub']).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // challenge → waiting-verify（remotePub 落态）
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'ch-1',
        desktopPub,
        desktopId: 'crish-desktop',
        tlsFingerprint: 'fp-1',
      })
    );
    expect(h.wiring.getMachineState().state).toBe('waiting-verify');
    expect(h.wiring.getMachineState().pendingRemotePub).toBe(desktopPub);
    // ok → paired + 派生 sessionKeys
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-abc',
      })
    );
    await flush();
    const s = h.wiring.getMachineState();
    expect(s.state).toBe('paired');
    expect(s.sessionKeys).not.toBeNull();
    expect(s.failedAttempts).toBe(0);
    // 持久化：4 密钥位 + 接线元数据（deviceId/desktopId/host）
    expect(h.driver.keys()).toEqual(
      expect.arrayContaining([
        KEYS.PAIR_TOKEN_KEY,
        KEYS.PAIR_REFRESH_KEY,
        KEYS.DEVICE_KEYPAIR_PRIV,
        KEYS.DEVICE_KEYPAIR_PUB,
        PAIRING_META_DEVICE_ID_KEY,
        PAIRING_META_DESKTOP_ID_KEY,
        PAIRING_META_HOST_KEY,
      ])
    );
    expect(await h.driver.getItem(KEYS.PAIR_TOKEN_KEY)).toBe(
      s.sessionKeys!.tokenKey
    );
    expect(await h.driver.getItem(KEYS.PAIR_REFRESH_KEY)).toBe(
      s.sessionKeys!.refreshKey
    );
    expect(await h.driver.getItem(PAIRING_META_HOST_KEY)).toBe('192.168.1.5');
    expect(await h.driver.getItem(PAIRING_META_DESKTOP_ID_KEY)).toBe(
      'crish-desktop'
    );
    // 会话连接：token + 派生 tokenKey + deviceId
    expect(h.sessionCtxs).toHaveLength(1);
    expect(h.sessionCtxs[0]).toMatchObject({
      host: '192.168.1.5',
      url: 'wss://192.168.1.5:8765/v1/events',
      deviceId: s.pendingHello!.deviceId,
      desktopId: 'crish-desktop',
      token: 'tok-abc',
      tokenKey: s.sessionKeys!.tokenKey,
    });
    // authStore 收口
    expect(authStore.getState().pairState).toBe('paired');
    expect(authStore.getState().deviceId).toBe(s.pendingHello!.deviceId);
    expect(authStore.getState().desktopId).toBe('crish-desktop');
    expect(authStore.getState().host).toBe('192.168.1.5');
    // 配对期连接已断开（会话连接另行建立）
    expect(h.sockets[0]!.closed).toBe(true);
  });

  it('装配 mock 注入点：固定 generateKeys/deriveKeys → 派生材料透传 → 持久化注入值', async () => {
    const priv = new Uint8Array(32).fill(7);
    const pub = new Uint8Array(32).fill(8);
    const deriveMaterial: PairKeyMaterial[] = [];
    const h = makeHarness({
      generateKeys: () => ({
        ephemeral: {
          privateKey: new Uint8Array(32).fill(1),
          publicKey: new Uint8Array(32).fill(2),
        },
        longTerm: { privateKey: priv, publicKey: pub },
      }),
      deriveKeys: (m) => {
        deriveMaterial.push(m);
        return FIXED_SESSION_KEYS;
      },
    });
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    const hello = (
      JSON.parse(h.sockets[0]!.sent[0]!) as { body: Record<string, unknown> }
    ).body;
    // 注入的固定公钥进 pair.hello（wire base64 形态）
    expect(hello['mobilePub']).toBe(base64Encode(new Uint8Array(32).fill(2)));
    expect(hello['mobileLongPub']).toBe(base64Encode(pub));
    const desktopPub = base64Encode(new Uint8Array(32).fill(9));
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'c',
        desktopPub,
        desktopId: 'd',
        tlsFingerprint: 'fp',
      })
    );
    h.wiring
      .getPairingClient()!
      .gateway.dispatchFrame(
        frame('pair.ok', { desktopId: 'd', ttl: 60, token: 'tok' })
      );
    await flush();
    // 派生材料透传（pairMachine 密钥材料全集）
    expect(deriveMaterial).toHaveLength(1);
    expect(deriveMaterial[0]).toMatchObject({
      code: '7K4PQ2MB9XRT',
      desktopId: 'd',
      remotePub: desktopPub,
      mobilePub: hello['mobilePub'],
      mobileLongPub: hello['mobileLongPub'],
    });
    expect(deriveMaterial[0]!.localKeys.longTerm.privateKey).toEqual(priv);
    // 持久化 = 注入派生值 + 注入密钥对
    expect(await h.driver.getItem(KEYS.PAIR_TOKEN_KEY)).toBe('TK-1');
    expect(await h.driver.getItem(KEYS.PAIR_REFRESH_KEY)).toBe('RK-1');
    expect(await h.driver.getItem(KEYS.DEVICE_KEYPAIR_PRIV)).toBe(
      base64Encode(priv)
    );
    expect(await h.driver.getItem(KEYS.DEVICE_KEYPAIR_PUB)).toBe(
      base64Encode(pub)
    );
    expect(h.sessionCtxs[0]).toMatchObject({
      token: 'tok',
      tokenKey: 'TK-1',
      desktopId: 'd',
    });
  });

  it('简化链（当前桌面实现：无 challenge，hello → ok 直接完成）：paired 但 sessionKeys=null，token 回退持久化并连接', async () => {
    const h = makeHarness();
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    expect(h.sockets[0]!.sent.length).toBeGreaterThan(0);
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-plain',
      })
    );
    await flush();
    const s = h.wiring.getMachineState();
    expect(s.state).toBe('paired');
    expect(s.sessionKeys).toBeNull();
    expect(h.deriveCalls).toHaveLength(0); // 简化链不注入 deriveKeys（无桌面公钥）
    // token 回退明文（当前桌面不验签；D3 完整链落地后由派生值替换）
    expect(await h.driver.getItem(KEYS.PAIR_TOKEN_KEY)).toBe('tok-plain');
    expect(await h.driver.getItem(KEYS.PAIR_REFRESH_KEY)).toBe('tok-plain');
    expect(await h.driver.getItem(KEYS.DEVICE_KEYPAIR_PRIV)).not.toBeNull();
    expect(h.sessionCtxs[0]).toMatchObject({
      token: 'tok-plain',
      tokenKey: 'tok-plain',
    });
    expect(authStore.getState().pairState).toBe('paired');
  });
});

describe('冷启动恢复（hydrate：已配对 → 直接连接）', () => {
  it('凭据 + 接线元数据齐备 → authStore 恢复 paired → 会话连接（tokenKey 还原）', async () => {
    const driver = new InMemorySecureStore();
    await savePairingCredential(driver, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
    });
    await driver.setItem(PAIRING_META_DEVICE_ID_KEY, 'dev-cold-0001');
    await driver.setItem(PAIRING_META_DESKTOP_ID_KEY, 'crish-desktop');
    await driver.setItem(PAIRING_META_HOST_KEY, '10.0.0.2');
    const sessionCtxs: PairingSessionContext[] = [];
    const wiring = track(
      startPairingWiring({
        driver,
        connectSession: (ctx) => {
          sessionCtxs.push(ctx);
        },
      })
    );
    const restored = await wiring.hydrate();
    expect(restored).toBe(true);
    expect(authStore.getState().pairState).toBe('paired');
    expect(authStore.getState().deviceId).toBe('dev-cold-0001');
    expect(authStore.getState().desktopId).toBe('crish-desktop');
    expect(authStore.getState().host).toBe('10.0.0.2');
    expect(authStore.getState().hasKeyMaterial).toBe(true);
    // 直接连接：token/tokenKey = 持久化的会话密钥材料
    expect(sessionCtxs).toHaveLength(1);
    expect(sessionCtxs[0]).toMatchObject({
      deviceId: 'dev-cold-0001',
      desktopId: 'crish-desktop',
      host: '10.0.0.2',
      url: 'wss://10.0.0.2:8765/v1/events',
      token: 'tk-1',
      tokenKey: 'tk-1',
    });
  });

  it('无凭据 → false（走配对引导，不连接）', async () => {
    const sessionCtxs: PairingSessionContext[] = [];
    const wiring = track(
      startPairingWiring({
        driver: new InMemorySecureStore(),
        connectSession: (ctx) => {
          sessionCtxs.push(ctx);
        },
      })
    );
    expect(await wiring.hydrate()).toBe(false);
    expect(sessionCtxs).toHaveLength(0);
    expect(authStore.getState().pairState).toBe('unpaired');
  });

  it('凭据在但接线元数据缺失 → 自愈清空 + 错误上报 + 不连接', async () => {
    const driver = new InMemorySecureStore();
    await savePairingCredential(driver, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
    });
    const errors: PairingWiringError[] = [];
    const sessionCtxs: PairingSessionContext[] = [];
    const wiring = track(
      startPairingWiring({
        driver,
        onError: (e) => {
          errors.push(e);
        },
        connectSession: (ctx) => {
          sessionCtxs.push(ctx);
        },
      })
    );
    expect(await wiring.hydrate()).toBe(false);
    expect(await hasPairing(driver)).toBe(false); // 自愈清空
    expect(errors[0]?.code).toBe('pairing.stale_credential');
    expect(sessionCtxs).toHaveLength(0);
  });
});

describe('unpair 清理（onUnpaired → 清 secure-store + 断开）', () => {
  it('配对后解绑：secure-store 全清 + 元数据删除 + 会话断开 + authStore 复位 + 机器回初始态', async () => {
    const h = makeHarness();
    await runFullChain(h);
    expect(authStore.getState().pairState).toBe('paired');
    // 会话连接（连接复用点）：observationWiring 单例真实装配
    const obs = ensureObservationWiring({
      factory: () => {
        const socket = makeSocket();
        h.sockets.push(socket);
        return socket;
      },
    });
    expect(obs).not.toBeNull();
    expect(obs!.client.phase).toBe('connecting');
    await h.wiring.unpair();
    // secure-store 全清（含接线元数据）
    expect(await hasPairing(h.driver)).toBe(false);
    expect(await h.driver.getItem(PAIRING_META_DEVICE_ID_KEY)).toBeNull();
    expect(await h.driver.getItem(PAIRING_META_DESKTOP_ID_KEY)).toBeNull();
    expect(await h.driver.getItem(PAIRING_META_HOST_KEY)).toBeNull();
    // authStore 复位 + 机器回初始态 + 会话连接断开（phase → idle）
    expect(authStore.getState().pairState).toBe('unpaired');
    expect(authStore.getState().host).toBeNull();
    expect(h.wiring.getMachineState().state).toBe('idle');
    expect(obs!.client.phase).toBe('idle');
  });
});

describe('错误路径（派生失败 / 持久化失败 / 错误帧 / 传输失败）', () => {
  it('派生失败 → pairMachine error 态（pair.key_agreement_failed，可重试）→ 不持久化不连接', async () => {
    const h = makeHarness({
      deriveKeys: () => {
        throw new Error('派生异常');
      },
    });
    await runFullChain(h);
    const s = h.wiring.getMachineState();
    expect(s.state).toBe('error');
    expect(s.error?.code).toBe('pair.key_agreement_failed');
    expect(s.error?.retryable).toBe(true);
    expect(s.sessionKeys).toBeNull();
    expect(h.errors[0]?.code).toBe('pair.key_agreement_failed');
    expect(h.driver.keys()).toHaveLength(0); // 无持久化
    expect(h.sessionCtxs).toHaveLength(0); // 无连接
    // 可重试：retry → 等待输入
    h.wiring.retry();
    expect(h.wiring.getMachineState().state).toBe('waiting-input');
  });

  it('持久化失败（secure-store 写入抛错）→ 上报且不产生连接，半截写入自清理', async () => {
    class FailingOnKeyStore extends InMemorySecureStore {
      constructor(private readonly failKey: string) {
        super();
      }
      async setItem(key: string, value: string): Promise<void> {
        if (key === this.failKey) {
          throw new Error(`写入失败：${key}`);
        }
        return super.setItem(key, value);
      }
    }
    const driver = new FailingOnKeyStore(KEYS.PAIR_TOKEN_KEY);
    const sessionCtxs: PairingSessionContext[] = [];
    const errors: PairingWiringError[] = [];
    const sockets: MockSocket[] = [];
    const wiring = track(
      startPairingWiring({
        driver,
        factory: () => {
          const socket = makeSocket();
          sockets.push(socket);
          return socket;
        },
        connectSession: (ctx) => {
          sessionCtxs.push(ctx);
        },
        onError: (e) => {
          errors.push(e);
        },
      })
    );
    wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    sockets[0]!.onopen!();
    wiring
      .getPairingClient()!
      .gateway.dispatchFrame(
        frame('pair.ok', { desktopId: 'd', ttl: 60, token: 'tok' })
      );
    await flush();
    expect(errors[0]?.code).toBe('pairing.persist_failed');
    expect(sessionCtxs).toHaveLength(0); // 持久化失败：不产生连接
    expect(await hasPairing(driver)).toBe(false); // 半截写入自清理
    expect(await driver.getItem(PAIRING_META_DEVICE_ID_KEY)).toBeNull();
    expect(sockets[0]!.closed).toBe(true); // 配对期连接已断开
  });

  it('pair 错误帧 → onPairError（invalid-code，失败计数 +1，可重试）', () => {
    const h = makeHarness();
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('error', {
        code: 'pair.invalid_code',
        message: '配对码错误',
        retryable: false,
      })
    );
    const s = h.wiring.getMachineState();
    expect(s.state).toBe('error');
    expect(s.failedAttempts).toBe(1);
    expect(s.error?.kind).toBe('invalid-code');
    expect(h.errors[0]?.code).toBe('pair.invalid_code');
    h.wiring.retry();
    expect(h.wiring.getMachineState().state).toBe('waiting-input');
  });

  it('连接工厂抛错（配对连接建立失败）→ transport 错误上报，机器保持 sending-hello', () => {
    const errors: PairingWiringError[] = [];
    const wiring = track(
      startPairingWiring({
        driver: new InMemorySecureStore(),
        factory: () => {
          throw new Error('socket boom');
        },
        connectSession: () => {},
        onError: (e) => {
          errors.push(e);
        },
      })
    );
    const r = wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    expect(r.ok).toBe(true);
    expect(errors[0]?.code).toBe('pairing.transport_failed');
    expect(errors[0]?.retryable).toBe(true);
    expect(wiring.getMachineState().state).toBe('sending-hello');
  });
});

describe('connectionStore 相位只读引用（防重复连接守卫）', () => {
  it('会话已就绪（ready）→ 配对成功不再重复建立会话连接', async () => {
    connectionStore.getState().setPhase('ready');
    const h = makeHarness();
    await runFullChain(h);
    expect(h.wiring.getMachineState().state).toBe('paired');
    expect(h.sessionCtxs).toHaveLength(0); // 守卫跳过
    // 快照投影 connectionStore 相位（只读）
    expect(h.wiring.getSnapshot().sessionPhase).toBe('ready');
  });

  it('会话连接中（connecting）→ 同样跳过重复连接', async () => {
    connectionStore.getState().setPhase('connecting');
    const h = makeHarness();
    await runFullChain(h);
    expect(h.sessionCtxs).toHaveLength(0);
  });
});

describe('会话签名（signer SignContext 构造注入点）', () => {
  it('buildSignedRequest：auth 注入 + 签名与 signer 锚点一致（canon 可验）', () => {
    const ctx = { deviceId: 'dev-01HZ', tokenKey: 'k-test' };
    const signer = createFrameSigner(ctx);
    const env = buildSignedRequest(
      signer,
      'dev-01HZ',
      'events.push',
      'm-iph-002-34',
      { ok: true },
      1754651200000,
      'nonce-abcdef'
    );
    expect(env.kind).toBe('events.push');
    expect(env.from).toBe('mobile');
    expect(env.to).toBe('desktop');
    expect(env.auth).toBeDefined();
    expect(env.auth!.deviceId).toBe('dev-01HZ');
    expect(env.auth!.nonce).toBe('nonce-abcdef');
    // 签名 = signMessage 同参数结果（canon：deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v ∥ body）
    expect(env.auth!.sig).toBe(
      signMessage(ctx, {
        deviceId: 'dev-01HZ',
        ts: 1754651200000,
        nonce: 'nonce-abcdef',
        msgId: 'm-iph-002-34',
        kind: 'events.push',
        v: 1,
        body: { ok: true },
      })
    );
    // 验签通过
    expect(
      verifySignature(
        ctx,
        { ...env, deviceId: env.auth!.deviceId, nonce: env.auth!.nonce },
        env.auth!.sig
      )
    ).toBe(true);
    // 随机 nonce：16 字节 → 24 字符 base64（D3 §5.1）
    expect(randomNonce(() => 0.5)).toHaveLength(24);
    expect(randomNonce(() => 0.1)).not.toBe(randomNonce(() => 0.2));
  });

  it('buildSessionGateway：会话网关出站帧自动签名（SignContext 注入）', () => {
    const gateway = buildSessionGateway('dev-x', 'k-session');
    const sent: string[] = [];
    gateway.attachSend((raw) => {
      sent.push(raw);
    });
    gateway.send('heartbeat', { ts: 1 });
    const env = JSON.parse(sent[0]!) as {
      kind: string;
      v: number;
      ts: number;
      msgId: string;
      body: Record<string, unknown>;
      auth?: { deviceId: string; sig: string; nonce: string };
    };
    expect(env.kind).toBe('heartbeat');
    expect(env.auth?.deviceId).toBe('dev-x');
    expect(
      verifySignature(
        { deviceId: 'dev-x', tokenKey: 'k-session' },
        {
          deviceId: 'dev-x',
          ts: env.ts,
          nonce: env.auth!.nonce,
          msgId: env.msgId,
          kind: env.kind,
          v: env.v,
          body: { ts: 1 },
        },
        env.auth!.sig
      )
    ).toBe(true);
  });

  it('defaultConnectSession：token 注入 observationWiring 单例 + 出站帧自动签名（连接复用点）', async () => {
    const driver = new InMemorySecureStore();
    // authStore 需已配对（ensureObservationWiring 经 authStore.host 解析端点）
    await authStore.getState().onPaired(
      { deviceId: 'dev-x', desktopId: 'crish-desktop', host: '10.0.0.2' },
      { issuedAt: 1, ttlMs: 1000 },
      {
        persist: buildAuthPersist(driver),
        cred: {
          tokenKey: 'k-1',
          refreshKey: 'rk-1',
          deviceKeypairPriv: 'priv',
          deviceKeypairPub: 'pub',
        },
      }
    );
    const sockets: MockSocket[] = [];
    defaultConnectSession(
      {
        url: 'wss://10.0.0.2:8765',
        host: '10.0.0.2',
        deviceId: 'dev-x',
        desktopId: 'crish-desktop',
        token: 'tok-1',
        tokenKey: 'k-1',
      },
      {
        factory: () => {
          const socket = makeSocket();
          sockets.push(socket);
          return socket;
        },
      }
    );
    const obs = getObservationWiring();
    expect(obs).not.toBeNull();
    // 同一连接实例（approvalWiring 复用点）：token 注入 + 签名网关
    expect(obs!.client.token).toBe('tok-1');
    sockets[0]!.onopen!();
    obs!.client.gateway.send('heartbeat', { ts: 1 });
    const env = JSON.parse(sockets[0]!.sent.at(-1)!) as {
      kind: string;
      v: number;
      ts: number;
      msgId: string;
      body: Record<string, unknown>;
      auth?: { deviceId: string; sig: string; nonce: string };
    };
    expect(env.kind).toBe('heartbeat');
    expect(env.auth?.deviceId).toBe('dev-x');
    expect(
      verifySignature(
        { deviceId: 'dev-x', tokenKey: 'k-1' },
        {
          deviceId: 'dev-x',
          ts: env.ts,
          nonce: env.auth!.nonce,
          msgId: env.msgId,
          kind: env.kind,
          v: env.v,
          body: { ts: 1 },
        },
        env.auth!.sig
      )
    ).toBe(true);
  });
});

describe('接线装配面（订阅快照 / 状态拒绝）', () => {
  it('订阅：beginPairing / 配对成功触发快照通知', async () => {
    const h = makeHarness();
    let notified = 0;
    h.wiring.subscribe(() => {
      notified += 1;
    });
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    expect(notified).toBeGreaterThan(0);
    const snap = h.wiring.getSnapshot();
    expect(snap.machine.state).toBe('sending-hello');
    expect(snap.error).toBeNull();
  });

  it('状态拒绝：paired 拒绝 beginPairing（需先 unpair）', async () => {
    const h = makeHarness();
    await runFullChain(h);
    const r = h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('非法码（submitCode 本地校验失败）：不发起连接（无 socket 创建）', () => {
    const h = makeHarness();
    const r = h.wiring.beginPairing({ code: 'BAD', host: '10.0.0.2' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(h.wiring.getMachineState().state).toBe('waiting-input');
    expect(h.sockets).toHaveLength(0);
  });
});

describe('证书指纹链路（D3 §4.6：配对载荷下发 → secure-store host_fingerprint 位）', () => {
  const FP_A = 'ab'.repeat(32); // 64 位 hex（桌面 spki_sha256_hex 形态）
  const FP_B = 'cd'.repeat(32);

  it('完整链：pair.challenge tlsFingerprint（权威载体）→ 配对成功写入 host_fingerprint 位', async () => {
    const h = makeHarness();
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'ch-1',
        desktopPub: pushDesktopPub(),
        desktopId: 'crish-desktop',
        tlsFingerprint: FP_A,
      })
    );
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-abc',
      })
    );
    await flush();
    expect(h.wiring.getMachineState().state).toBe('paired');
    expect(await h.driver.getItem(KEYS.HOST_FINGERPRINT)).toBe(FP_A);
  });

  it('简化链且 pair.ok 扩展携带指纹 → 同样落位（桌面端未来 ok 下发路径）', async () => {
    const h = makeHarness();
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-plain',
        tlsFingerprint: FP_A,
      })
    );
    await flush();
    expect(h.wiring.getMachineState().state).toBe('paired');
    expect(await h.driver.getItem(KEYS.HOST_FINGERPRINT)).toBe(FP_A);
  });

  it('简化链且不下发指纹（当前桌面现状）→ host_fingerprint 位保持空（缺口记录）', async () => {
    const h = makeHarness();
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-plain',
      })
    );
    await flush();
    expect(h.wiring.getMachineState().state).toBe('paired');
    expect(await h.driver.getItem(KEYS.HOST_FINGERPRINT)).toBeNull();
  });

  it('重配对证书轮换：已存储指纹与本次下发不一致 → pairing.fingerprint_mismatch，不覆盖不连接', async () => {
    const driver = new InMemorySecureStore();
    await savePairingCredential(driver, {
      tokenKey: 'tk-old',
      refreshKey: 'rk-old',
      deviceKeypairPriv: 'priv-old',
      deviceKeypairPub: 'pub-old',
      hostFingerprint: FP_A,
    });
    const sessionCtxs: PairingSessionContext[] = [];
    const errors: PairingWiringError[] = [];
    const sockets: MockSocket[] = [];
    const wiring = track(
      startPairingWiring({
        driver,
        factory: () => {
          const socket = makeSocket();
          sockets.push(socket);
          return socket;
        },
        connectSession: (ctx) => {
          sessionCtxs.push(ctx);
        },
        onError: (e) => {
          errors.push(e);
        },
      })
    );
    wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    sockets[0]!.onopen!();
    wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'ch-1',
        desktopPub: pushDesktopPub(),
        desktopId: 'crish-desktop',
        tlsFingerprint: FP_B,
      })
    );
    wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-new',
      })
    );
    await flush();
    expect(errors[0]?.code).toBe('pairing.fingerprint_mismatch');
    expect(errors[0]?.retryable).toBe(false); // 安全不一致：不可重试
    expect(sessionCtxs).toHaveLength(0); // 不产生连接
    expect(await driver.getItem(KEYS.HOST_FINGERPRINT)).toBe(FP_A); // 不覆盖旧值
    expect(sockets[0]!.closed).toBe(true); // 配对期连接已断开
  });

  it('pair.challenge 与 pair.ok 双信道指纹冲突 → 拒绝完成配对（fingerprint_mismatch）', async () => {
    const h = makeHarness();
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'ch-1',
        desktopPub: pushDesktopPub(),
        desktopId: 'crish-desktop',
        tlsFingerprint: FP_A,
      })
    );
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok',
        tlsFingerprint: FP_B,
      })
    );
    await flush();
    expect(h.errors[0]?.code).toBe('pairing.fingerprint_mismatch');
    expect(h.wiring.getMachineState().state).toBe('waiting-verify'); // 未进入 paired
    expect(h.sessionCtxs).toHaveLength(0);
    expect(await h.driver.getItem(KEYS.HOST_FINGERPRINT)).toBeNull();
  });

  it('双信道齐备且一致 → 正常落位（verified 不冲突）', async () => {
    const h = makeHarness();
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'ch-1',
        desktopPub: pushDesktopPub(),
        desktopId: 'crish-desktop',
        tlsFingerprint: FP_A,
      })
    );
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok',
        tlsFingerprint: FP_A,
      })
    );
    await flush();
    expect(h.wiring.getMachineState().state).toBe('paired');
    expect(await h.driver.getItem(KEYS.HOST_FINGERPRINT)).toBe(FP_A);
  });

  it('非法格式指纹（非 64 位 hex）→ 放弃钉扎（缺口记录）但不阻断配对', async () => {
    const h = makeHarness();
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.0.2' });
    h.sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'ch-1',
        desktopPub: pushDesktopPub(),
        desktopId: 'crish-desktop',
        tlsFingerprint: 'not-a-fingerprint',
      })
    );
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok',
      })
    );
    await flush();
    expect(h.wiring.getMachineState().state).toBe('paired');
    expect(await h.driver.getItem(KEYS.HOST_FINGERPRINT)).toBeNull();
  });
});

describe('配对端点明文开关（EXPO_PUBLIC_ENGINE_TLS，R2-16 裁决-1 联调豁免）', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_ENGINE_TLS;
  });

  it('缺省（未设置 env）：配对期连接 + 会话连接均解析 wss（生产语义不变）', async () => {
    const urls: string[] = [];
    const sockets: MockSocket[] = [];
    const h = makeHarness({
      factory: (url) => {
        urls.push(url);
        const s = makeSocket();
        sockets.push(s);
        return s;
      },
    });
    h.wiring.beginPairing({ code: VALID_CODE, host: '192.168.1.5' });
    expect(urls[0]).toBe('wss://192.168.1.5:8765/v1/events');
    sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'ch-1',
        desktopPub: pushDesktopPub(),
        desktopId: 'crish-desktop',
        tlsFingerprint: 'fp-1',
      })
    );
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-abc',
      })
    );
    await flush();
    expect(h.sessionCtxs).toHaveLength(1);
    expect(h.sessionCtxs[0]!.url).toBe('wss://192.168.1.5:8765/v1/events');
  });

  it('EXPO_PUBLIC_ENGINE_TLS=false：配对期连接解析 ws（明文豁免生效）', () => {
    process.env.EXPO_PUBLIC_ENGINE_TLS = 'false';
    const urls: string[] = [];
    const h = makeHarness({
      factory: (url) => {
        urls.push(url);
        return makeSocket();
      },
    });
    h.wiring.beginPairing({ code: VALID_CODE, host: '10.0.2.2' });
    expect(urls[0]).toBe('ws://10.0.2.2:8765/v1/events');
    expect(h.wiring.getPairingClient()!.url).toBe(
      'ws://10.0.2.2:8765/v1/events'
    );
  });

  it('EXPO_PUBLIC_ENGINE_TLS=false：配对成功会话连接解析 ws', async () => {
    process.env.EXPO_PUBLIC_ENGINE_TLS = 'false';
    const urls: string[] = [];
    const sockets: MockSocket[] = [];
    const h = makeHarness({
      factory: (url) => {
        urls.push(url);
        const s = makeSocket();
        sockets.push(s);
        return s;
      },
    });
    h.wiring.beginPairing({ code: VALID_CODE, host: '192.168.1.5' });
    sockets[0]!.onopen!();
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.challenge', {
        challenge: 'ch-1',
        desktopPub: pushDesktopPub(),
        desktopId: 'crish-desktop',
        tlsFingerprint: 'fp-1',
      })
    );
    h.wiring.getPairingClient()!.gateway.dispatchFrame(
      frame('pair.ok', {
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-abc',
      })
    );
    await flush();
    expect(h.sessionCtxs).toHaveLength(1);
    expect(h.sessionCtxs[0]!.url).toBe('ws://192.168.1.5:8765/v1/events');
  });

  it('EXPO_PUBLIC_ENGINE_TLS=false：冷启动恢复（hydrate）会话连接解析 ws', async () => {
    process.env.EXPO_PUBLIC_ENGINE_TLS = 'false';
    const driver = new InMemorySecureStore();
    await savePairingCredential(driver, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
    });
    await driver.setItem(PAIRING_META_DEVICE_ID_KEY, 'dev-cold-0001');
    await driver.setItem(PAIRING_META_DESKTOP_ID_KEY, 'crish-desktop');
    await driver.setItem(PAIRING_META_HOST_KEY, '10.0.2.2');
    const sessionCtxs: PairingSessionContext[] = [];
    const wiring = track(
      startPairingWiring({
        driver,
        connectSession: (ctx) => {
          sessionCtxs.push(ctx);
        },
      })
    );
    expect(await wiring.hydrate()).toBe(true);
    expect(sessionCtxs).toHaveLength(1);
    expect(sessionCtxs[0]!.url).toBe('ws://10.0.2.2:8765/v1/events');
  });

  it('engineTlsEnabled：仅精确值 false 关闭 TLS（缺省/其它值 → true）', () => {
    delete process.env.EXPO_PUBLIC_ENGINE_TLS;
    expect(engineTlsEnabled()).toBe(true);
    process.env.EXPO_PUBLIC_ENGINE_TLS = '0';
    expect(engineTlsEnabled()).toBe(true);
    process.env.EXPO_PUBLIC_ENGINE_TLS = 'FALSE';
    expect(engineTlsEnabled()).toBe(true);
    process.env.EXPO_PUBLIC_ENGINE_TLS = 'false';
    expect(engineTlsEnabled()).toBe(false);
  });
});
