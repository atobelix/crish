// 默认模型纪律（L3）：config.activeModel 是唯一真源，任何写入路径
// 都不得替用户落位或回退——
// - 活动为空时，写任何供应商（含本机条目同步）都不自动选默认；
// - 云端默认与本机默认互不改投（保存另一方不移动既有选择）；
// - 活动模型被删除或禁用 → 清空为未设置，绝不回退到同供应商的
//   建议项，更不跨供应商改投（失效解释在默认模型页呈现）。
import { InMemorySecureStore } from '@/db/secureStore';
import type { SettingsPersist } from './settingsStore';
import {
  configureLocalChatPersistence,
  configureLocalChatSecure,
  localChatStore,
} from './localChatStore';
import type { LocalProviderSpec } from '../types/localChat';
import {
  ON_DEVICE_PROVIDER_ID,
  buildOnDeviceProviderSpec,
} from '@/adapters/onDevice/onDeviceProviderSync';
import { ON_DEVICE_MODEL_CATALOG } from '@/adapters/onDevice/onDeviceModelCatalog';

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

function cloudSpec(modelIds: readonly string[]): LocalProviderSpec {
  return {
    displayName: '云厂商',
    protocol: 'openai/chat',
    baseUrl: 'https://example.invalid/v1',
    models: modelIds.map((id) => ({ id, displayName: id })),
  };
}

function onDeviceSpec(readyIds: readonly string[]): LocalProviderSpec {
  return buildOnDeviceProviderSpec(
    ON_DEVICE_MODEL_CATALOG.filter((s) => readyIds.includes(s.id))
  );
}

const M15 = 'qwen2.5-1.5b-instruct-q4_k_m';
const M3B = 'qwen2.5-3b-instruct-q4_k_m';

function activeModel() {
  return localChatStore.getState().config.activeModel;
}

beforeEach(() => {
  configureLocalChatPersistence(new MemoryPersist());
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

describe('localChatStore 默认模型纪律（L3）', () => {
  it('活动为空：写入首个云供应商不自动落位默认', async () => {
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1', 'm2']));
    expect(activeModel()).toBeNull();
  });

  it('活动为空：本机条目首次同步（有就绪模型）不自动落位默认', async () => {
    await localChatStore
      .getState()
      .upsertProvider(ON_DEVICE_PROVIDER_ID, onDeviceSpec([M15, M3B]));
    expect(activeModel()).toBeNull();
  });

  it('云端默认已选：本机条目同步不改投', async () => {
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1']));
    localChatStore.getState().setActiveModel('cloud-a', 'm1');
    await localChatStore
      .getState()
      .upsertProvider(ON_DEVICE_PROVIDER_ID, onDeviceSpec([M15]));
    expect(activeModel()).toEqual({ providerId: 'cloud-a', modelId: 'm1' });
  });

  it('本机默认已选：保存云供应商不改投', async () => {
    await localChatStore
      .getState()
      .upsertProvider(ON_DEVICE_PROVIDER_ID, onDeviceSpec([M15, M3B]));
    localChatStore.getState().setActiveModel(ON_DEVICE_PROVIDER_ID, M3B);
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1', 'm2']));
    expect(activeModel()).toEqual({
      providerId: ON_DEVICE_PROVIDER_ID,
      modelId: M3B,
    });
  });

  it('活动模型被删除：清空为未设置，不回退同供应商其他模型', async () => {
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1', 'm2']));
    localChatStore.getState().setActiveModel('cloud-a', 'm2');
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1']));
    expect(activeModel()).toBeNull();
  });

  it('活动模型被禁用：清空为未设置，不回退', async () => {
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1', 'm2']));
    localChatStore.getState().setActiveModel('cloud-a', 'm2');
    const disabled: LocalProviderSpec = {
      ...cloudSpec(['m1']),
      models: [
        { id: 'm1', displayName: 'm1' },
        { id: 'm2', displayName: 'm2', enabled: false },
      ],
    };
    await localChatStore.getState().upsertProvider('cloud-a', disabled);
    expect(activeModel()).toBeNull();
  });

  it('本机活动模型被同步移除：清空为未设置，不回退推荐档', async () => {
    await localChatStore
      .getState()
      .upsertProvider(ON_DEVICE_PROVIDER_ID, onDeviceSpec([M15, M3B]));
    localChatStore.getState().setActiveModel(ON_DEVICE_PROVIDER_ID, M3B);
    await localChatStore
      .getState()
      .upsertProvider(ON_DEVICE_PROVIDER_ID, onDeviceSpec([M15]));
    expect(activeModel()).toBeNull();
  });

  it('无关供应商写入不触碰活动选择（活动模型仍在）', async () => {
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1', 'm2']));
    localChatStore.getState().setActiveModel('cloud-a', 'm2');
    await localChatStore
      .getState()
      .upsertProvider('cloud-b', cloudSpec(['x1']));
    expect(activeModel()).toEqual({ providerId: 'cloud-a', modelId: 'm2' });
    // 活动供应商的无害更新（模型仍在且启用）也不清空
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1', 'm2']));
    expect(activeModel()).toEqual({ providerId: 'cloud-a', modelId: 'm2' });
  });

  it('删除活动供应商：活动选择清空（既有口径回归）', async () => {
    await localChatStore
      .getState()
      .upsertProvider('cloud-a', cloudSpec(['m1']));
    localChatStore.getState().setActiveModel('cloud-a', 'm1');
    await localChatStore.getState().deleteProvider('cloud-a');
    expect(activeModel()).toBeNull();
  });
});
