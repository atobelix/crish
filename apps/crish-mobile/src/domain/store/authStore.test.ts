// authStore 单测（M5 §3.1.1 authStore 动作面 + D4 §5.2 令牌生命周期）：
// 状态转移合法性 / 配对收口（onPaired + secure-store 写入注记）/ 解除配对 /
// 持久化接口注入（hydrate load / onPaired save / onUnpaired clear）/ 默认持久化注入
import { authStore, configureAuthPersistence } from './authStore';
import { transitionPairState } from './authReducers';
import type { AuthPersist } from './authStore';
import type { PairingCredential } from '../../db/secureStore';

const NOW = 1_800_000_000_000;

const CRED: PairingCredential = {
  tokenKey: 'tok-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  refreshKey: 'ref-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  deviceKeypairPriv: 'priv-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  deviceKeypairPub: 'pub-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
};

const IDENTITY = {
  deviceId: 'dev-mobile-0f3a',
  desktopId: 'desk-9xrt',
  host: '192.168.1.100',
};

/** 可注入 fake 持久化（jest.fn 断言调用面；cred 可传 null 模拟无凭据） */
function makePersist(cred: PairingCredential | null = CRED): AuthPersist & {
  load: jest.Mock;
  save: jest.Mock;
  clear: jest.Mock;
} {
  return {
    load: jest.fn(async () => cred),
    save: jest.fn(async () => {}),
    clear: jest.fn(async () => {}),
  };
}

function resetStore(): void {
  authStore.setState({
    pairState: 'unpaired',
    hydrated: false,
    deviceId: null,
    desktopId: null,
    host: null,
    pairingMeta: null,
    token: { hasToken: false, issuedAt: null, ttlMs: null },
    hasKeyMaterial: false,
  });
}

beforeEach(() => {
  resetStore();
  configureAuthPersistence(null); // 隔离默认持久化注入
});

describe('transitionPairState（D3 §4.2 移动端状态机 + D4 §5.2 令牌生命周期）', () => {
  it('合法转移全量放行', () => {
    expect(transitionPairState('unpaired', 'pairing')).toBe('pairing');
    expect(transitionPairState('unpaired', 'paired')).toBe('paired'); // hydrate 直接恢复
    expect(transitionPairState('pairing', 'paired')).toBe('paired');
    expect(transitionPairState('pairing', 'unpaired')).toBe('unpaired');
    expect(transitionPairState('paired', 'token_expired')).toBe(
      'token_expired'
    );
    expect(transitionPairState('paired', 'unpaired')).toBe('unpaired');
    expect(transitionPairState('paired', 'pairing')).toBe('pairing'); // 重新配对
    expect(transitionPairState('token_expired', 'paired')).toBe('paired'); // 刷新成功
    expect(transitionPairState('token_expired', 'pairing')).toBe('pairing');
    expect(transitionPairState('token_expired', 'unpaired')).toBe('unpaired');
  });

  it('拒绝规则：unpaired / pairing → token_expired 保持原状态（未配对过不可能过期）', () => {
    expect(transitionPairState('unpaired', 'token_expired')).toBe('unpaired');
    expect(transitionPairState('pairing', 'token_expired')).toBe('pairing');
  });
});

describe('setPairState / markTokenExpired（状态转移动作面）', () => {
  it('setPairState 合法转移生效；非法转移保持原状态', () => {
    authStore.getState().setPairState('pairing');
    expect(authStore.getState().pairState).toBe('pairing');
    authStore.getState().setPairState('token_expired'); // pairing → token_expired 非法
    expect(authStore.getState().pairState).toBe('pairing');
  });

  it('markTokenExpired 仅 paired 可进入（M5 §4.3.5 刷新失败路径）', () => {
    authStore.getState().setPairState('paired');
    authStore.getState().markTokenExpired();
    expect(authStore.getState().pairState).toBe('token_expired');
    // 身份/令牌元数据保留供重新配对预填（D4 §5.2 引导重新配对）
    expect(authStore.getState().deviceId).toBeNull(); // 未配对过无身份；paired 路径见下
  });

  it('markTokenExpired 未配对时 no-op', () => {
    authStore.getState().markTokenExpired();
    expect(authStore.getState().pairState).toBe('unpaired');
  });

  it('token_expired → paired 可恢复（刷新成功）', () => {
    authStore.getState().setPairState('paired');
    authStore.getState().markTokenExpired();
    authStore.getState().setPairState('paired');
    expect(authStore.getState().pairState).toBe('paired');
  });
});

describe('setPairingMeta（配对流程元数据，host/port/code 状态）', () => {
  it('首次写入创建完整元数据（端口缺省 8765 = 裁决 P-1；stage 缺省 entered）', () => {
    authStore.getState().setPairingMeta({ host: '192.168.1.50' });
    expect(authStore.getState().pairingMeta).toEqual({
      host: '192.168.1.50',
      port: 8765,
      code: '',
      stage: 'entered',
    });
  });

  it('partial 合并只更新给定字段', () => {
    authStore.getState().setPairingMeta({
      host: '192.168.1.50',
      port: 8765,
      code: 'CXN-7K4P-Q2MB-9XRT',
    });
    authStore.getState().setPairingMeta({ code: 'CXN-AAAA-BBBB-CCCC' });
    const meta = authStore.getState().pairingMeta;
    expect(meta?.code).toBe('CXN-AAAA-BBBB-CCCC');
    expect(meta?.host).toBe('192.168.1.50');
    expect(meta?.port).toBe(8765);
  });

  it('stage 可独立推进（entered → verifying → failed → succeeded）', () => {
    authStore.getState().setPairingMeta({ host: 'h' });
    authStore.getState().setPairingMeta({ stage: 'verifying' });
    expect(authStore.getState().pairingMeta?.stage).toBe('verifying');
    authStore.getState().setPairingMeta({ stage: 'failed' });
    expect(authStore.getState().pairingMeta?.stage).toBe('failed');
  });
});

describe('onPaired（配对成功收口，D3 §4.8 pair.ok）', () => {
  it('状态面：paired + 身份/令牌元数据 + hasKeyMaterial（不变量 paired ⟹ hasKeyMaterial）', async () => {
    await authStore
      .getState()
      .onPaired(IDENTITY, { issuedAt: NOW, ttlMs: 24 * 3_600_000 });
    const s = authStore.getState();
    expect(s.pairState).toBe('paired');
    expect(s.deviceId).toBe(IDENTITY.deviceId);
    expect(s.desktopId).toBe(IDENTITY.desktopId);
    expect(s.host).toBe(IDENTITY.host);
    expect(s.token).toEqual({
      hasToken: true,
      issuedAt: NOW,
      ttlMs: 24 * 3_600_000,
    });
    expect(s.hasKeyMaterial).toBe(true);
  });

  it('持久化接口注入：注入 persist + 凭据 → 写 secure-store（save 收到完整凭据）', async () => {
    const persist = makePersist();
    await authStore
      .getState()
      .onPaired(
        IDENTITY,
        { issuedAt: NOW, ttlMs: null },
        { persist, cred: CRED }
      );
    expect(persist.save).toHaveBeenCalledTimes(1);
    expect(persist.save).toHaveBeenCalledWith(CRED);
    expect(authStore.getState().pairState).toBe('paired');
  });

  it('未注入凭据 → 不写 secure-store（配对流程已在接线层落库的场景）', async () => {
    const persist = makePersist();
    await authStore
      .getState()
      .onPaired(IDENTITY, { issuedAt: NOW, ttlMs: null });
    expect(persist.save).not.toHaveBeenCalled();
    expect(authStore.getState().hasKeyMaterial).toBe(true);
  });

  it('写入失败 → 状态不变并上抛（接线层捕获引导重试）', async () => {
    const persist = makePersist();
    persist.save.mockRejectedValueOnce(new Error('secure-store 写入失败'));
    await expect(
      authStore
        .getState()
        .onPaired(
          IDENTITY,
          { issuedAt: NOW, ttlMs: null },
          { persist, cred: CRED }
        )
    ).rejects.toThrow('secure-store 写入失败');
    expect(authStore.getState().pairState).toBe('unpaired');
    expect(authStore.getState().hasKeyMaterial).toBe(false);
  });

  it('进行中配对收口 → pairingMeta.stage 置 succeeded', async () => {
    authStore.getState().setPairState('pairing');
    authStore.getState().setPairingMeta({ host: IDENTITY.host, code: 'CXN-X' });
    await authStore
      .getState()
      .onPaired(IDENTITY, { issuedAt: NOW, ttlMs: null });
    expect(authStore.getState().pairingMeta?.stage).toBe('succeeded');
  });
});

describe('hydrate（M5 §7.1 步骤 2 启动水合 + SplashGate）', () => {
  it('有完整凭据 → paired + hasKeyMaterial + hydrated；meta 回填身份字段', async () => {
    await authStore.getState().hydrate(makePersist(), IDENTITY);
    const s = authStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.pairState).toBe('paired');
    expect(s.hasKeyMaterial).toBe(true);
    expect(s.deviceId).toBe(IDENTITY.deviceId);
    expect(s.host).toBe(IDENTITY.host);
  });

  it('无凭据 → unpaired + hydrated（启动走配对引导，M5 §7.1）', async () => {
    await authStore.getState().hydrate(makePersist(null));
    const s = authStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.pairState).toBe('unpaired');
    expect(s.hasKeyMaterial).toBe(false);
  });

  it('读取失败 → 视为未配对不阻塞启动（M5 §7.1 secure-store 读取失败 → 配对引导）', async () => {
    const persist = makePersist();
    persist.load.mockRejectedValueOnce(new Error('secure-store 读取失败'));
    await authStore.getState().hydrate(persist);
    expect(authStore.getState().hydrated).toBe(true);
    expect(authStore.getState().pairState).toBe('unpaired');
  });

  it('未注入持久化 → 优雅降级 unpaired + hydrated（不崩溃；接线层注入前骨架期语义）', async () => {
    await authStore.getState().hydrate();
    expect(authStore.getState().hydrated).toBe(true);
    expect(authStore.getState().pairState).toBe('unpaired');
  });
});

describe('onUnpaired（被动解除配对：auth.revoked / unknown_desktop / 刷新失败）', () => {
  async function seedPaired(): Promise<void> {
    await authStore
      .getState()
      .onPaired(IDENTITY, { issuedAt: NOW, ttlMs: null });
  }

  it('持久化接口注入：清 secure-store + 状态面全清（SQLite 业务缓存保留由接线层保证）', async () => {
    await seedPaired();
    const persist = makePersist();
    await authStore.getState().onUnpaired(persist);
    expect(persist.clear).toHaveBeenCalledTimes(1);
    const s = authStore.getState();
    expect(s.pairState).toBe('unpaired');
    expect(s.deviceId).toBeNull();
    expect(s.desktopId).toBeNull();
    expect(s.host).toBeNull();
    expect(s.pairingMeta).toBeNull();
    expect(s.token.hasToken).toBe(false);
    expect(s.hasKeyMaterial).toBe(false);
  });

  it('secure-store 清除失败 → 状态仍复位（M5 §6.2「无论成败」）', async () => {
    await seedPaired();
    const persist = makePersist();
    persist.clear.mockRejectedValueOnce(new Error('secure-store 清除失败'));
    await expect(
      authStore.getState().onUnpaired(persist)
    ).resolves.toBeUndefined();
    expect(authStore.getState().pairState).toBe('unpaired');
  });

  it('未注入持久化 → 仅状态复位（接线层负责持久化清理）', async () => {
    await seedPaired();
    await authStore.getState().onUnpaired();
    expect(authStore.getState().pairState).toBe('unpaired');
  });
});

describe('clearPairing / revokeLocal（主动清除本地配对）', () => {
  it('clearPairing 纯内存复位（重新配对前重置表单，不触持久化）', async () => {
    await authStore
      .getState()
      .onPaired(IDENTITY, { issuedAt: NOW, ttlMs: null });
    authStore.getState().setPairingMeta({ host: IDENTITY.host });
    authStore.getState().clearPairing();
    const s = authStore.getState();
    expect(s.pairState).toBe('unpaired');
    expect(s.pairingMeta).toBeNull();
    expect(s.deviceId).toBeNull();
    expect(s.host).toBeNull();
    expect(s.hasKeyMaterial).toBe(false);
  });

  it('revokeLocal（M5 §3.1.1 移除本机）与 clearPairing 同复位面', () => {
    authStore.getState().setPairState('paired');
    authStore.getState().revokeLocal();
    expect(authStore.getState().pairState).toBe('unpaired');
    expect(authStore.getState().hasKeyMaterial).toBe(false);
  });
});

describe('configureAuthPersistence（默认持久化注入，接线层启动装配）', () => {
  it('hydrate() 无参调用走默认持久化（app/_layout.tsx 调用形态）', async () => {
    configureAuthPersistence(makePersist(CRED));
    await authStore.getState().hydrate();
    expect(authStore.getState().pairState).toBe('paired');
    expect(authStore.getState().hasKeyMaterial).toBe(true);
  });

  it('参数注入优先于默认持久化', async () => {
    configureAuthPersistence(makePersist(CRED));
    await authStore.getState().hydrate(makePersist(null));
    expect(authStore.getState().pairState).toBe('unpaired');
  });

  it('onUnpaired 无参调用走默认持久化清理', async () => {
    const persist = makePersist(CRED);
    configureAuthPersistence(persist);
    await authStore
      .getState()
      .onPaired(IDENTITY, { issuedAt: NOW, ttlMs: null });
    await authStore.getState().onUnpaired();
    expect(persist.clear).toHaveBeenCalledTimes(1);
  });
});
