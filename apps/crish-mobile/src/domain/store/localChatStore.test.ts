// 本地供应商配置 store 测试：凭据引用纪律（配置只存 ref、密钥只进
// SecureStore）、水合、水合后活动选择、删除连带清理。
import { InMemorySecureStore, type SecureStoreDriver } from '@/db/secureStore';
import type { SettingsPersist } from './settingsStore';
import {
  LOCAL_CHAT_CONFIG_KEY,
  decodeLocalModelsConfig,
  localChatStore,
} from './localChatStore';
import { apiKeySlotFor } from '../pure/localChatProtocol';
import {
  configureLocalChatPersistence,
  configureLocalChatSecure,
} from './localChatStore';
import type { LocalProviderSpec } from '../types/localChat';

class MemoryPersist implements SettingsPersist {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async getAll(): Promise<ReadonlyArray<{ key: string; value: string }>> {
    return [...this.map.entries()].map(([key, value]) => ({ key, value }));
  }
}

const spec = (name: string): LocalProviderSpec => ({
  displayName: name,
  baseUrl: 'https://api.example.com/v1',
  protocol: 'openai/chat',
  stream: true,
  enabled: true,
  models: [{ id: 'm1', enabled: true }],
});

let persist: MemoryPersist;
let secure: SecureStoreDriver;

beforeEach(async () => {
  persist = new MemoryPersist();
  secure = new InMemorySecureStore();
  configureLocalChatPersistence(persist);
  configureLocalChatSecure(secure);
  localChatStore.setState({
    config: { version: 2, providers: {}, activeModel: null },
    hydrated: false,
    keyPresence: {},
  });
});

afterAll(() => {
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
});

describe('localChatStore', () => {
  it('upsertProvider：密钥只进 SecureStore，配置与 kv 仅存 apiKeyRef', async () => {
    await localChatStore
      .getState()
      .upsertProvider('p1', spec('甲'), 'sk-secret');
    const state = localChatStore.getState();
    expect(state.config.providers.p1?.apiKeyRef).toBe('secure:p1');
    expect(state.keyPresence.p1).toBe(true);
    expect(await secure.getItem(apiKeySlotFor('p1'))).toBe('sk-secret');
    const raw = persist.map.get(LOCAL_CHAT_CONFIG_KEY) ?? '';
    expect(raw).toContain('secure:p1');
    expect(raw).not.toContain('sk-secret');
    expect(await state.readApiKey('p1')).toBe('sk-secret');
  });

  it('首个供应商落位活动选择；setActiveModel 切换二元身份', async () => {
    await localChatStore.getState().upsertProvider('p1', spec('甲'), 'k');
    await localChatStore.getState().upsertProvider('p2', spec('乙'), 'k');
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'p1',
      modelId: 'm1',
    });
    localChatStore.getState().setActiveModel('p2', 'm1');
    expect(localChatStore.getState().config.activeModel?.providerId).toBe('p2');
  });

  it('apiKey=undefined 不触碰既有密钥；null 清除密钥与 ref', async () => {
    const s = localChatStore.getState();
    await s.upsertProvider('p1', spec('甲'), 'sk-1');
    await s.upsertProvider('p1', spec('甲改名'), undefined);
    expect(await secure.getItem(apiKeySlotFor('p1'))).toBe('sk-1');
    expect(localChatStore.getState().config.providers.p1?.apiKeyRef).toBe(
      'secure:p1'
    );
    await s.upsertProvider('p1', spec('甲改名'), null);
    expect(await secure.getItem(apiKeySlotFor('p1'))).toBeNull();
    expect(
      localChatStore.getState().config.providers.p1?.apiKeyRef
    ).toBeUndefined();
    expect(localChatStore.getState().keyPresence.p1).toBe(false);
  });

  it('deleteProvider：连带清密钥与失效活动选择', async () => {
    const s = localChatStore.getState();
    await s.upsertProvider('p1', spec('甲'), 'sk-1');
    await s.deleteProvider('p1');
    expect(localChatStore.getState().config.providers.p1).toBeUndefined();
    expect(localChatStore.getState().config.activeModel).toBeNull();
    expect(await secure.getItem(apiKeySlotFor('p1'))).toBeNull();
  });

  it('hydrate：从 kv 回填配置 + 密钥存在性（不读明文进状态）', async () => {
    await localChatStore.getState().upsertProvider('p1', spec('甲'), 'sk-9');
    localChatStore.setState({
      config: { version: 2, providers: {}, activeModel: null },
      hydrated: false,
      keyPresence: {},
    });
    await localChatStore.getState().hydrate();
    const state = localChatStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.config.providers.p1?.displayName).toBe('甲');
    expect(state.keyPresence.p1).toBe(true);
    expect(JSON.stringify(state.config)).not.toContain('sk-9');
  });

  it('decodeLocalModelsConfig：非法输入回退空配置；活动指向不存在供应商则清空', () => {
    expect(decodeLocalModelsConfig(null).providers).toEqual({});
    expect(decodeLocalModelsConfig('{bad json').activeModel).toBeNull();
    const decoded = decodeLocalModelsConfig(
      JSON.stringify({
        version: 2,
        providers: { p1: spec('甲') },
        activeModel: { providerId: 'nope', modelId: 'm1' },
      })
    );
    expect(decoded.activeModel).toBeNull();
    expect(decoded.providers.p1?.models[0]?.id).toBe('m1');
  });
});
