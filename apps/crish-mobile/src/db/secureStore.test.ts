// secure-store 封装测试（M5 §6.1-6.3：4 密钥位 + 凭证位；注入模式 + 内存 mock）
import {
  ALL_KEY_SLOTS,
  CORE_KEY_SLOTS,
  InMemorySecureStore,
  clearAccountSession,
  clearPairing,
  hasPairing,
  loadAccountSession,
  loadPairingCredential,
  saveAccountSession,
  savePairingCredential,
} from './secureStore';

describe('InMemorySecureStore（注入 mock 基础行为）', () => {
  it('getItem/setItem/deleteItem 往返', async () => {
    const store = new InMemorySecureStore();
    expect(await store.getItem('k1')).toBeNull();
    await store.setItem('k1', 'v1');
    expect(await store.getItem('k1')).toBe('v1');
    await store.deleteItem('k1');
    expect(await store.getItem('k1')).toBeNull();
    await store.deleteItem('不存在');
  });

  it('keys/clear 测试辅助', async () => {
    const store = new InMemorySecureStore();
    await store.setItem('a', '1');
    await store.setItem('b', '2');
    expect(store.keys().sort()).toEqual(['a', 'b']);
    store.clear();
    expect(store.keys()).toEqual([]);
  });
});

describe('密钥位清单（M5 §6.1 对齐）', () => {
  it('4 个核心密钥位（token_key/refresh_key/keypair priv/pub）', () => {
    expect(CORE_KEY_SLOTS).toEqual([
      'pair.token_key',
      'pair.refresh_key',
      'device.keypair.priv',
      'device.keypair.pub',
    ]);
  });

  it('全量 5 位（含 host_fingerprint 凭证位）', () => {
    expect(ALL_KEY_SLOTS).toHaveLength(5);
    expect(ALL_KEY_SLOTS).toEqual(
      expect.arrayContaining(['pair.host_fingerprint'])
    );
  });
});

describe('savePairingCredential / loadPairingCredential', () => {
  it('保存后读回完整（含可选指纹）', async () => {
    const store = new InMemorySecureStore();
    await savePairingCredential(store, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
      hostFingerprint: 'fp-1',
    });
    const cred = await loadPairingCredential(store);
    expect(cred).toEqual({
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
      hostFingerprint: 'fp-1',
    });
  });

  it('无指纹也能读回（早期配对兼容）', async () => {
    const store = new InMemorySecureStore();
    await savePairingCredential(store, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
    });
    const cred = await loadPairingCredential(store);
    expect(cred?.hostFingerprint).toBeUndefined();
  });

  it('任一核心密钥位缺失 → null（不部分恢复，M5 §6.3 注意 4）', async () => {
    const store = new InMemorySecureStore();
    await savePairingCredential(store, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
    });
    await store.deleteItem('pair.token_key'); // 模拟部分损坏
    expect(await loadPairingCredential(store)).toBeNull();
    // 空库
    const empty = new InMemorySecureStore();
    expect(await loadPairingCredential(empty)).toBeNull();
  });
});

describe('hasPairing / clearPairing / 配对中间态', () => {
  it('hasPairing：核心 4 位齐备才为 true', async () => {
    const store = new InMemorySecureStore();
    expect(await hasPairing(store)).toBe(false);
    await savePairingCredential(store, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
    });
    expect(await hasPairing(store)).toBe(true);
  });

  it('clearPairing 清空全部 pair.* 与 device.keypair.*，M5 §6.2 移除本机语义', async () => {
    const store = new InMemorySecureStore();
    await savePairingCredential(store, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
      hostFingerprint: 'fp-1',
    });
    await clearPairing(store);
    expect(await hasPairing(store)).toBe(false);
    expect(store.keys()).toEqual([]);
  });
});

// ── 云端账号会话（与局域网配对凭据分离；clearPairing 不得清除账号） ──────────

describe('账号会话存取（ACCOUNT_KEYS）', () => {
  const fullSession = {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    deviceId: 'dev-1',
    userId: 'u-1',
    email: 'a@b.c',
  };

  it('save 与 load 往返完整保留字段', async () => {
    const store = new InMemorySecureStore();
    await saveAccountSession(store, fullSession);
    expect(await loadAccountSession(store)).toEqual(fullSession);
  });

  it('refreshToken 或 deviceId 缺失时 load 返回 null（不可恢复会话）', async () => {
    const store = new InMemorySecureStore();
    await store.setItem('account.access_token', 'at-only');
    expect(await loadAccountSession(store)).toBeNull();
  });

  it('可空字段为 null 时删除对应键（不写空串）', async () => {
    const store = new InMemorySecureStore();
    await saveAccountSession(store, {
      accessToken: null,
      refreshToken: 'rt-1',
      deviceId: 'dev-1',
      userId: null,
      email: null,
    });

    expect(await store.getItem('account.access_token')).toBeNull();
    expect(await store.getItem('account.user_id')).toBeNull();
    expect(await store.getItem('account.email')).toBeNull();
    expect(await loadAccountSession(store)).toEqual({
      accessToken: null,
      refreshToken: 'rt-1',
      deviceId: 'dev-1',
      userId: null,
      email: null,
    });
  });

  it('覆盖写入时清掉旧的空字段值', async () => {
    const store = new InMemorySecureStore();
    await saveAccountSession(store, fullSession);
    await saveAccountSession(store, {
      ...fullSession,
      accessToken: null,
      userId: null,
    });

    expect(await store.getItem('account.access_token')).toBeNull();
    expect(await store.getItem('account.user_id')).toBeNull();
  });

  it('clearAccountSession 只清账号键，保留配对凭据', async () => {
    const store = new InMemorySecureStore();
    await savePairingCredential(store, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
    });
    await saveAccountSession(store, fullSession);

    await clearAccountSession(store);

    expect(await loadAccountSession(store)).toBeNull();
    // 账号登出 ≠ 解除配对：配对凭据必须保留
    expect(await hasPairing(store)).toBe(true);
  });

  it('clearPairing 不清除账号会话（账号与配对独立）', async () => {
    const store = new InMemorySecureStore();
    await saveAccountSession(store, fullSession);

    await clearPairing(store);

    expect(await loadAccountSession(store)).toEqual(fullSession);
  });
});
