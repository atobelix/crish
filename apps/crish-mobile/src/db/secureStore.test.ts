// secure-store 封装测试（M5 §6.1-6.3：4 密钥位 + 凭证位；注入模式 + 内存 mock）
import {
  ALL_KEY_SLOTS,
  CORE_KEY_SLOTS,
  InMemorySecureStore,
  clearPairing,
  hasPairing,
  loadPairingCredential,
  saveExchangeNonce,
  loadExchangeNonce,
  clearExchangeNonce,
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

  it('全量 6 位（含 host_fingerprint 凭证位 + exchange_nonce 中间态位）', () => {
    expect(ALL_KEY_SLOTS).toHaveLength(6);
    expect(ALL_KEY_SLOTS).toEqual(
      expect.arrayContaining(['pair.host_fingerprint', 'pair.exchange_nonce'])
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

  it('clearPairing 清空全部 pair.* 与 device.keypair.*（含中间态），M5 §6.2 移除本机语义', async () => {
    const store = new InMemorySecureStore();
    await savePairingCredential(store, {
      tokenKey: 'tk-1',
      refreshKey: 'rk-1',
      deviceKeypairPriv: 'priv-1',
      deviceKeypairPub: 'pub-1',
      hostFingerprint: 'fp-1',
    });
    await saveExchangeNonce(store, 'nonce-1');
    await clearPairing(store);
    expect(await hasPairing(store)).toBe(false);
    expect(await loadExchangeNonce(store)).toBeNull();
    expect(store.keys()).toEqual([]);
  });

  it('exchange_nonce 生命周期：写 → 读 → 清（配对完成后删除）', async () => {
    const store = new InMemorySecureStore();
    expect(await loadExchangeNonce(store)).toBeNull();
    await saveExchangeNonce(store, 'nonce-abc');
    expect(await loadExchangeNonce(store)).toBe('nonce-abc');
    await clearExchangeNonce(store);
    expect(await loadExchangeNonce(store)).toBeNull();
  });
});
