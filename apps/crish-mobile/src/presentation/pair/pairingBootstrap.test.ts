// 配对装配引导测试（R2-03 部分 3 / R-3 真实驱动落地）：
// - configurePairingDriver 注入驱动 → ensurePairingController 装配单例（幂等，
//   重复调用返回同一实例）；
// - 未配置驱动 → 回退 expoSecureStoreDriver（真实环境默认，expo-secure-store
//   经 jest.setup 全局 mock——内存 Map，M5 §10.4.5；冷启动恢复持久化可用，
//   R2-16 §3.3 注记）；InMemorySecureStore 仅测试注入使用；
// - ensurePairingWiringForApp = 装配 + 冷启动恢复水合：有凭据 + 接线元数据
//   → authStore 恢复 paired（(tabs) AuthGuard 放行依据）；无凭据 → 保持
//   未配对（走配对引导）。
import {
  expoSecureStoreDriver,
  InMemorySecureStore,
  savePairingCredential,
} from '@/db/secureStore';
import { authStore } from '@/domain/store/authStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { resetObservationWiringForTest } from '@/adapters/wiring/observationWiring';
import {
  getPairingWiring,
  PAIRING_META_DEVICE_ID_KEY,
  PAIRING_META_DESKTOP_ID_KEY,
  PAIRING_META_HOST_KEY,
  resetPairingWiringForTest,
} from '@/adapters/wiring/pairing';
import {
  configurePairingDriver,
  ensurePairingController,
  ensurePairingWiringForApp,
} from './pairingBootstrap';

const CRED = {
  tokenKey: 'tk-1',
  refreshKey: 'rk-1',
  deviceKeypairPriv: 'priv-1',
  deviceKeypairPub: 'pub-1',
};

beforeEach(() => {
  resetPairingWiringForTest();
  resetObservationWiringForTest();
  configurePairingDriver(null);
  authStore.getState().clearPairing();
  connectionStore.setState({ phase: 'disconnected' });
});

afterEach(() => {
  resetPairingWiringForTest();
  // 冷启动恢复会拉起会话连接（observationWiring 单例 + mock socket + invoke 定时器）：
  // 不复位则 10s 超时定时器挂住 jest worker（force-exit 告警源头）
  resetObservationWiringForTest();
  configurePairingDriver(null);
  authStore.getState().clearPairing();
});

describe('ensurePairingController（装配单例）', () => {
  it('configurePairingDriver 注入驱动后装配；重复调用返回同一实例（幂等）', () => {
    configurePairingDriver(new InMemorySecureStore());
    const wiring = ensurePairingController();
    expect(getPairingWiring()).toBe(wiring);
    expect(ensurePairingController()).toBe(wiring);
  });

  it('未配置驱动时回退 expoSecureStoreDriver（真实环境默认；expo 层 jest 全局 mock）', () => {
    const wiring = ensurePairingController();
    expect(wiring).not.toBeNull();
    expect(ensurePairingController()).toBe(wiring);
  });
});

describe('ensurePairingWiringForApp（装配 + 冷启动恢复水合）', () => {
  it('有凭据 + 接线元数据 → 恢复 paired（AuthGuard 自动放行依据）', async () => {
    const driver = new InMemorySecureStore();
    await savePairingCredential(driver, CRED);
    await driver.setItem(PAIRING_META_DEVICE_ID_KEY, 'dev-cold-0001');
    await driver.setItem(PAIRING_META_DESKTOP_ID_KEY, 'crish-desktop');
    await driver.setItem(PAIRING_META_HOST_KEY, '10.0.2.2');
    configurePairingDriver(driver);
    // 会话已就绪 → connectSessionOnce 守卫跳过真实连接（防 Node WS 后台重连）
    connectionStore.setState({ phase: 'ready' });

    const wiring = await ensurePairingWiringForApp();

    expect(wiring).toBe(getPairingWiring());
    expect(authStore.getState().pairState).toBe('paired');
    expect(authStore.getState().hydrated).toBe(true);
    expect(authStore.getState().deviceId).toBe('dev-cold-0001');
    expect(authStore.getState().desktopId).toBe('crish-desktop');
    expect(authStore.getState().host).toBe('10.0.2.2');
    expect(authStore.getState().hasKeyMaterial).toBe(true);
  });

  it('无凭据 → 保持未配对（走配对引导，不连接）', async () => {
    configurePairingDriver(new InMemorySecureStore());

    const wiring = await ensurePairingWiringForApp();

    expect(authStore.getState().pairState).toBe('unpaired');
    expect(authStore.getState().hasKeyMaterial).toBe(false);
    expect(wiring.getMachineState().state).toBe('idle');
  });

  it('默认真实驱动（expo 层 mock）冷启动：无凭据 → 未配对；注入凭据后 → 恢复 paired', async () => {
    // 未配置驱动 → 回退 expoSecureStoreDriver（expo-secure-store 全局 mock）
    connectionStore.setState({ phase: 'ready' });
    await ensurePairingWiringForApp();
    expect(authStore.getState().pairState).toBe('unpaired');

    // 经真实驱动（expo mock）写入凭据 + 接线元数据 → 重新装配水合恢复 paired
    resetPairingWiringForTest();
    const driver = expoSecureStoreDriver();
    await savePairingCredential(driver, CRED);
    await driver.setItem(PAIRING_META_DEVICE_ID_KEY, 'dev-expo-0001');
    await driver.setItem(PAIRING_META_DESKTOP_ID_KEY, 'crish-desktop');
    await driver.setItem(PAIRING_META_HOST_KEY, '10.0.2.2');

    await ensurePairingWiringForApp();
    expect(authStore.getState().pairState).toBe('paired');
    expect(authStore.getState().deviceId).toBe('dev-expo-0001');
    expect(authStore.getState().hydrated).toBe(true);
  });
});
