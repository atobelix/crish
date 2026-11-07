// 内置端侧供应商条目同步测试（O4）：models[] 只同步已下载且校验在案
// 的模型；删除活动模型清空不悬空（L3 口径：不回退推荐档）；条目无
// 端点/密钥/厂商假字段；LocalVendorKey 不含 'ondevice' 的边界钉死
// （O4 裁决回归守卫）。
import { InMemorySecureStore } from '@/db/secureStore';
import type { SettingsPersist } from '@/domain/store/settingsStore';
import {
  LOCAL_CHAT_CONFIG_KEY,
  configureLocalChatPersistence,
  configureLocalChatSecure,
  localChatStore,
} from '@/domain/store/localChatStore';
import {
  ON_DEVICE_MODEL_CATALOG,
  type OnDeviceModelSpec,
} from './onDeviceModelCatalog';
import type { OnDeviceModelState } from './onDeviceModelManager';
import {
  ON_DEVICE_PROVIDER_ID,
  buildOnDeviceProviderSpec,
  syncOnDeviceProvider,
  type OnDeviceProviderSyncManager,
} from './onDeviceProviderSync';
import { PROVIDER_PRESETS } from '../localChat/providerPresets';
import { isLocalVendorKey } from '@/presentation/components/localChat/ui/vendorLogosData';

class MemoryPersist implements SettingsPersist {
  readonly map = new Map<string, string>();
  setCount = 0;
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.setCount += 1;
    this.map.set(key, value);
  }
  async getAll(): Promise<ReadonlyArray<{ key: string; value: string }>> {
    return [...this.map.entries()].map(([key, value]) => ({ key, value }));
  }
}

const M15 = 'qwen2.5-1.5b-instruct-q4_k_m';
const M3B = 'qwen2.5-3b-instruct-q4_k_m';

function specOf(id: string): OnDeviceModelSpec {
  const spec = ON_DEVICE_MODEL_CATALOG.find((s) => s.id === id);
  if (!spec) throw new Error(`catalog missing ${id}`);
  return spec;
}

/** 假管理器：checkAll 按给定就绪集回状态（与 O2 管理器同形） */
function fakeManager(
  readyIds: readonly string[]
): OnDeviceProviderSyncManager {
  return {
    listSpecs: () => ON_DEVICE_MODEL_CATALOG,
    checkAll: async (): Promise<OnDeviceModelState[]> =>
      ON_DEVICE_MODEL_CATALOG.map((s) =>
        readyIds.includes(s.id)
          ? {
              kind: 'ready',
              modelId: s.id,
              path: `/models/${s.fileName}`,
              sizeBytes: s.size,
            }
          : { kind: 'missing', modelId: s.id }
      ),
  };
}

let persist: MemoryPersist;

beforeEach(() => {
  persist = new MemoryPersist();
  configureLocalChatPersistence(persist);
  configureLocalChatSecure(new InMemorySecureStore());
  localChatStore.setState({
    config: { version: 2, providers: {}, activeModel: null },
    hydrated: true,
    keyPresence: {},
  });
});

afterAll(() => {
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
});

describe('buildOnDeviceProviderSpec', () => {
  it('条目由代码构造：无 baseUrl / apiKeyRef / vendor 假字段', () => {
    const spec = buildOnDeviceProviderSpec([specOf(M15), specOf(M3B)]);
    expect(spec.protocol).toBe('ondevice/gguf');
    expect(spec.displayName).toBe('本机模型');
    expect(spec.baseUrl).toBeUndefined();
    expect(spec.apiKeyRef).toBeUndefined();
    expect(spec.vendor).toBeUndefined();
    expect(spec.models.map((m) => m.id)).toEqual([M15, M3B]);
    // 默认模型 = 推荐档（1.5B），不因入参顺序漂移
    expect(spec.defaultModelId).toBe(M15);
    expect(
      buildOnDeviceProviderSpec([specOf(M3B), specOf(M15)]).defaultModelId
    ).toBe(M15);
    // 上下文真值：3B 取目录 2048，其余缺省 4096（与 O3 客户端一致）
    expect(spec.models.find((m) => m.id === M3B)?.contextWindow).toBe(2048);
    expect(spec.models.find((m) => m.id === M15)?.contextWindow).toBe(4096);
    expect(spec.models[0]?.modalities).toEqual({
      input: ['text'],
      output: ['text'],
    });
  });
});

describe('syncOnDeviceProvider', () => {
  it('无就绪模型且条目不存在：不造空条目', async () => {
    const ready = await syncOnDeviceProvider(fakeManager([]));
    expect(ready).toEqual([]);
    expect(
      localChatStore.getState().config.providers[ON_DEVICE_PROVIDER_ID]
    ).toBeUndefined();
  });

  it('下载完成 → 条目出现且只含就绪模型，并落盘', async () => {
    const ready = await syncOnDeviceProvider(fakeManager([M15, M3B]));
    expect(ready).toEqual([M15, M3B]);
    const entry =
      localChatStore.getState().config.providers[ON_DEVICE_PROVIDER_ID];
    expect(entry?.protocol).toBe('ondevice/gguf');
    expect(entry?.models.map((m) => m.id)).toEqual([M15, M3B]);
    const raw = persist.map.get(LOCAL_CHAT_CONFIG_KEY) ?? '';
    expect(raw).toContain('ondevice/gguf');
    expect(raw).not.toContain('apiKeyRef');
    // 引擎读密钥走既有路径：无密钥材料，如实返回 null
    expect(await localChatStore.getState().readApiKey(ON_DEVICE_PROVIDER_ID))
      .toBeNull();
  });

  it('就绪集未变：不重复回写（kv 写入次数不变）', async () => {
    await syncOnDeviceProvider(fakeManager([M15]));
    const writes = persist.setCount;
    await syncOnDeviceProvider(fakeManager([M15]));
    expect(persist.setCount).toBe(writes);
  });

  it('删除当前活动模型：活动选择清空为未设置，不回退推荐档（L3）', async () => {
    await syncOnDeviceProvider(fakeManager([M15, M3B]));
    localChatStore.getState().setActiveModel(ON_DEVICE_PROVIDER_ID, M3B);
    await syncOnDeviceProvider(fakeManager([M15]));
    const state = localChatStore.getState();
    expect(
      state.config.providers[ON_DEVICE_PROVIDER_ID]?.models.map((m) => m.id)
    ).toEqual([M15]);
    // 默认失效即未设置：不自动改投同条目的推荐档（用户在默认模型页重选）
    expect(state.config.activeModel).toBeNull();
  });

  it('首次同步出条目：不替用户落位默认（活动仍为空，L3）', async () => {
    await syncOnDeviceProvider(fakeManager([M15, M3B]));
    expect(localChatStore.getState().config.activeModel).toBeNull();
  });

  it('全部删除：条目保留空 models[]，活动选择清空不悬空', async () => {
    await syncOnDeviceProvider(fakeManager([M15]));
    localChatStore.getState().setActiveModel(ON_DEVICE_PROVIDER_ID, M15);
    await syncOnDeviceProvider(fakeManager([]));
    const state = localChatStore.getState();
    expect(state.config.providers[ON_DEVICE_PROVIDER_ID]?.models).toEqual([]);
    expect(state.config.activeModel).toBeNull();
  });

  it('校验失效（checkAll 不再报 ready）与删除同路收敛', async () => {
    await syncOnDeviceProvider(fakeManager([M15, M3B]));
    // 模拟 3B 的 verified.json 被外部删除：管理器 check 转 missing
    await syncOnDeviceProvider(fakeManager([M15]));
    expect(
      localChatStore
        .getState()
        .config.providers[ON_DEVICE_PROVIDER_ID]?.models.map((m) => m.id)
    ).toEqual([M15]);
  });
});

describe('vendor 边界（O4 裁决回归守卫）', () => {
  it("LocalVendorKey 不含 'ondevice'：预置字典无假条目、徽标守卫不认", () => {
    expect(Object.keys(PROVIDER_PRESETS)).toEqual([
      'deepseek',
      'siliconflow',
      'ollama',
      'openai',
      'anthropic',
      'google',
      'custom',
    ]);
    expect(
      (PROVIDER_PRESETS as Record<string, unknown>)['ondevice']
    ).toBeUndefined();
    expect(isLocalVendorKey('ondevice')).toBe(false);
  });
});
