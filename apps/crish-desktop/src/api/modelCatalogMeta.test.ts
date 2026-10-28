// @vitest-environment jsdom
/**
 * modelCatalogMeta：**探测结果面**（`lastTest`）+ 统一配置树为配置唯一权威。
 *
 * 单轨收敛后的新语义（本文件钉的就是它）：
 * - `crish_model_meta_v1` 只存 `lastTest`；**不是** enabled / contextLength /
 *   能力 / 协议的声明真源，落盘 JSON 里不得出现这些字段；
 * - `enabled` / `contextLength` 唯一权威 = `modelsCatalogStore`
 *   （`getState().loaded` + `modelIndex.get(modelRefKey(...))`）；
 * - 旧写口 setModelEnabled / setModelDisplayName / setModelCapability /
 *   setModelContextLength / setModelThinkingLevel 已物理删除，仅剩
 *   `upsertModelMetaExport`（enabled / contextLength → 树，lastTest → LS）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onUiEvent } from './uiEvents';
import { guessContextLength } from './modelCatalogPure';
import {
  _getMemoryMetaCacheSnapshot,
  getModelMeta,
  purgeMetaForProfile,
  purgeOrphanMetaKeys,
  resetModelMetaCache,
  upsertModelMetaExport,
} from './modelCatalogMeta';
import { modelsCatalogStore } from './modelsCatalogStore';
import { modelRefKey } from './modelsCatalogTypes';
import type { ModelMeta } from './modelCatalogTypes';
import type { ModelSpec, ProviderSpec } from './modelsCatalogTypes';
import { catalogSnapshot } from '../test-utils/modelsCatalogSnapshot';

const META_KEY = 'crish_model_meta_v1';
const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'modelCatalogMeta.ts'),
  'utf8'
);

type LastTest = NonNullable<ModelMeta['lastTest']>;

function lastTest(seed: number): LastTest {
  return { ok: true, latencyMs: seed, at: 1_700_000_000_000 + seed };
}

/** 落盘 JSON（本键唯一合法内容面 = 探测结果字典） */
function storedMap(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as Record<
    string,
    unknown
  >;
}

function storedRecord(
  profileId: string,
  model: string
): Record<string, unknown> {
  return (storedMap()[`${profileId}::${model}`] ?? {}) as Record<
    string,
    unknown
  >;
}

function provider(models: ModelSpec[]): ProviderSpec {
  return { protocol: 'openai/chat', enabled: true, stream: false, models };
}

/**
 * 注入统一树（同目录既有惯例：`resetForTesting` + `acceptSnapshot`；
 * 回执夹具走 test-utils 的 `catalogSnapshot` 单一工厂）。
 */
function installTree(providers: Record<string, ProviderSpec>): void {
  modelsCatalogStore.resetForTesting();
  modelsCatalogStore.acceptSnapshot(
    catalogSnapshot({
      tree: { version: 2, activeModel: null, providers },
      revision: 'revision-0',
    })
  );
}

/** 跨环境（node vs jsdom）安全的 Storage spy 适配 */
const spyStorageGetItem = () =>
  typeof Storage !== 'undefined'
    ? vi.spyOn(Storage.prototype, 'getItem')
    : vi.spyOn(localStorage, 'getItem');

const spyStorageSetItem = () =>
  typeof Storage !== 'undefined'
    ? vi.spyOn(Storage.prototype, 'setItem')
    : vi.spyOn(localStorage, 'setItem');

beforeEach(() => {
  localStorage.clear();
  resetModelMetaCache();
  modelsCatalogStore.resetForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
  modelsCatalogStore.resetForTesting();
});

describe('getModelMeta 默认值（树未 loaded）', () => {
  it('enabled 默认 true；contextLength 回落 guessContextLength 的真实取值', () => {
    expect(modelsCatalogStore.getState().loaded).toBe(false);

    const known = getModelMeta('provider-1', 'deepseek-v4-flash');
    expect(known).toEqual({
      profileId: 'provider-1',
      model: 'deepseek-v4-flash',
      enabled: true,
      contextLength: 1_048_576,
    });
    expect(known.contextLength).toBe(guessContextLength('deepseek-v4-flash'));

    // 无已知映射的自建 id：回落 undefined（不发明值、不做 128K 腰斩）
    const custom = getModelMeta('provider-1', 'my-custom-ft-2026');
    expect(custom.enabled).toBe(true);
    expect(custom.contextLength).toBeUndefined();
    expect(custom.contextLength).toBe(guessContextLength('my-custom-ft-2026'));
    expect(custom).not.toHaveProperty('lastTest');
  });
});

describe('统一配置树是 enabled / contextLength 的唯一权威', () => {
  it('树 loaded 时读树的 enabled / contextWindow；树无声明则回落默认', () => {
    installTree({
      'provider-1': provider([
        { id: 'gpt-4o', enabled: false, contextWindow: 65_536 },
        { id: 'o3', enabled: true },
      ]),
    });
    expect(modelsCatalogStore.getState().loaded).toBe(true);
    expect(
      modelsCatalogStore
        .getState()
        .modelIndex.has(
          modelRefKey({ providerId: 'provider-1', modelId: 'gpt-4o' })
        )
    ).toBe(true);

    expect(getModelMeta('provider-1', 'gpt-4o')).toEqual({
      profileId: 'provider-1',
      model: 'gpt-4o',
      enabled: false,
      contextLength: 65_536,
    });

    // 树里无 contextWindow → 回落纯启发式
    const o3 = getModelMeta('provider-1', 'o3');
    expect(o3.enabled).toBe(true);
    expect(o3.contextLength).toBe(guessContextLength('o3'));

    // 树里没有该模型 → 无声明即启用
    expect(getModelMeta('provider-1', 'not-in-tree').enabled).toBe(true);

    // 身份精确：大小写不匹配即「树无声明」，不跨身份兜底
    expect(getModelMeta('Provider-1', 'gpt-4o').enabled).toBe(true);
    expect(getModelMeta('provider-1', 'GPT-4o').enabled).toBe(true);
  });

  it('树重新加载后立即生效（读树是实时读，不是启动快照）', () => {
    installTree({
      'provider-1': provider([
        { id: 'm', enabled: true, contextWindow: 1_000 },
      ]),
    });
    expect(getModelMeta('provider-1', 'm')).toMatchObject({
      enabled: true,
      contextLength: 1_000,
    });

    installTree({
      'provider-1': provider([
        { id: 'm', enabled: false, contextWindow: 2_000 },
      ]),
    });
    expect(getModelMeta('provider-1', 'm')).toMatchObject({
      enabled: false,
      contextLength: 2_000,
    });
  });

  it('LS 里残留的 enabled / contextLength / capabilities / protocol 一律不读', () => {
    localStorage.setItem(
      META_KEY,
      JSON.stringify({
        'provider-1::gpt-4o': {
          profileId: 'provider-1',
          model: 'gpt-4o',
          enabled: true,
          contextLength: 128_000,
          capabilities: { image: true },
          protocol: 'openai/chat',
          lastTest: { ok: false, at: 5, error: 'boom' },
        },
      })
    );
    resetModelMetaCache();
    installTree({
      'provider-1': provider([
        { id: 'gpt-4o', enabled: false, contextWindow: 65_536 },
      ]),
    });

    const meta = getModelMeta('provider-1', 'gpt-4o');
    expect(meta.enabled).toBe(false); // 不信 LS 的 enabled: true
    expect(meta.contextLength).toBe(65_536); // 不信 LS 的 128000
    expect(meta).not.toHaveProperty('capabilities');
    expect(meta).not.toHaveProperty('protocol');
    // 探测结果面仍来自 LS
    expect(meta.lastTest).toEqual({ ok: false, at: 5, error: 'boom' });
  });
});

describe('落盘面只允许探测结果（负向断言）', () => {
  it('落盘 JSON 里不含 enabled / contextLength / capabilities / protocol', () => {
    upsertModelMetaExport('provider-1', 'model-x', { lastTest: lastTest(1) });

    const record = storedRecord('provider-1', 'model-x');
    expect(Object.keys(record)).toEqual(['lastTest']);
    for (const field of [
      'enabled',
      'contextLength',
      'capabilities',
      'protocol',
      'displayName',
      'defaultThinkingLevel',
      'maxOutputTokens',
      'modalities',
      'thinking',
      'pricing',
    ]) {
      expect(record).not.toHaveProperty(field);
      expect(localStorage.getItem(META_KEY)).not.toContain(`"${field}"`);
    }
  });

  it('upsert 同时传 enabled / contextLength 时落盘内容仍只有 lastTest', () => {
    upsertModelMetaExport('provider-1', 'model-x', { lastTest: lastTest(2) });
    const before = localStorage.getItem(META_KEY);
    expect(before).toContain('"lastTest"');

    const updateSpy = vi
      .spyOn(modelsCatalogStore, 'updateModel')
      .mockResolvedValue({ ok: true });
    upsertModelMetaExport('provider-1', 'model-x', {
      enabled: false,
      contextLength: 32_768,
      lastTest: lastTest(3),
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const record = storedRecord('provider-1', 'model-x');
    expect(Object.keys(record)).toEqual(['lastTest']);
    expect(record.lastTest).toEqual(lastTest(3));
    expect(localStorage.getItem(META_KEY)).not.toContain('"enabled"');
    expect(localStorage.getItem(META_KEY)).not.toContain('"contextLength"');
  });
});

describe('upsertModelMetaExport 的写路由', () => {
  it('enabled / contextLength 不落 LS，路由到树 updateModel（contextLength → contextWindow）', () => {
    const setItemSpy = spyStorageSetItem();
    const updateSpy = vi
      .spyOn(modelsCatalogStore, 'updateModel')
      .mockResolvedValue({ ok: true });

    upsertModelMetaExport('provider-1', 'model-x', { enabled: false });
    expect(updateSpy).toHaveBeenNthCalledWith(1, 'provider-1', 'model-x', {
      enabled: false,
    });

    upsertModelMetaExport('provider-1', 'model-x', { contextLength: 128_000 });
    expect(updateSpy).toHaveBeenNthCalledWith(2, 'provider-1', 'model-x', {
      contextWindow: 128_000,
    });

    upsertModelMetaExport('provider-1', 'model-x', {
      enabled: true,
      contextLength: 65_536,
    });
    expect(updateSpy).toHaveBeenNthCalledWith(3, 'provider-1', 'model-x', {
      enabled: true,
      contextWindow: 65_536,
    });

    expect(updateSpy).toHaveBeenCalledTimes(3);
    // 不写 LS：meta 键一次都没被 setItem，内容仍为空
    expect(
      setItemSpy.mock.calls.filter(([key]) => key === META_KEY)
    ).toHaveLength(0);
    expect(localStorage.getItem(META_KEY)).toBeNull();
  });
});

describe('lastTest 落盘、内存镜像与 UI 事件广播', () => {
  it('lastTest → 落 LS + 同步内存镜像 + 广播 model-meta-changed（不触树写）', () => {
    const updateSpy = vi
      .spyOn(modelsCatalogStore, 'updateModel')
      .mockResolvedValue({ ok: true });
    const received: unknown[] = [];
    const off = onUiEvent('model-meta-changed', (detail) => {
      received.push(detail);
    });

    const lt = lastTest(7);
    const meta = upsertModelMetaExport('provider-1', 'model-x', {
      lastTest: lt,
    });

    expect(meta.profileId).toBe('provider-1');
    expect(meta.model).toBe('model-x');
    expect(meta.enabled).toBe(true);
    expect(meta.lastTest).toEqual(lt);
    expect(storedMap()).toEqual({ 'provider-1::model-x': { lastTest: lt } });
    expect(_getMemoryMetaCacheSnapshot()).toEqual({
      'provider-1::model-x': { lastTest: lt },
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(received).toEqual([
      { profileId: 'provider-1', model: 'model-x', enabled: true },
    ]);

    off();
  });
});

describe('memoryMetaCache 单例内存镜像机制', () => {
  it('内存镜像命中：后续读取不重复执行 localStorage.getItem', () => {
    upsertModelMetaExport('provider-1', 'model-a', { lastTest: lastTest(1) });
    expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

    const getItemSpy = spyStorageGetItem();
    for (let i = 0; i < 50; i++) {
      getModelMeta('provider-1', 'model-a');
    }
    expect(getItemSpy).toHaveBeenCalledTimes(0);
  });

  it('resetModelMetaCache 清空镜像，下次读取重新加载并读到真实落盘值', () => {
    const lt = lastTest(9);
    upsertModelMetaExport('provider-1', 'model-b', { lastTest: lt });
    expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

    resetModelMetaCache();
    expect(_getMemoryMetaCacheSnapshot()).toBeNull();

    const getItemSpy = spyStorageGetItem();
    const meta = getModelMeta('provider-1', 'model-b');
    expect(getItemSpy).toHaveBeenCalledTimes(1);
    expect(meta.lastTest).toEqual(lt);
    expect(_getMemoryMetaCacheSnapshot()).toEqual({
      'provider-1::model-b': { lastTest: lt },
    });
  });

  it('Devil-06: 连续执行 2,000 次 getModelMeta 仍走内存镜像，不读盘或反复解码', () => {
    for (let i = 0; i < 20; i++) {
      upsertModelMetaExport('provider-1', `model-bench-${i}`, {
        lastTest: lastTest(i),
      });
    }

    // JIT 预热消除冷启动延迟
    for (let i = 0; i < 200; i++) {
      getModelMeta('provider-1', `model-bench-${i % 20}`);
    }

    const getItemSpy = spyStorageGetItem();
    const parseSpy = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < 2000; i++) {
      getModelMeta('provider-1', `model-bench-${i % 20}`);
    }

    // 计数约束验证性能根因：缓存命中不得退回同步 LocalStorage 读取或全量 JSON 解码。
    expect(getItemSpy).not.toHaveBeenCalled();
    expect(parseSpy).not.toHaveBeenCalled();
  });
});

describe('跨窗口 StorageEvent 监听与失效机制', () => {
  it('接收到 crish_model_meta_v1 键的 storage 事件时自动使内存缓存过期', () => {
    upsertModelMetaExport('provider-1', 'model-sync', {
      lastTest: lastTest(1),
    });
    expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: META_KEY,
        newValue: JSON.stringify({}),
      })
    );

    expect(_getMemoryMetaCacheSnapshot()).toBeNull();
    // 失效后下次读取重新落盘读取，且读到的是真实存量
    const getItemSpy = spyStorageGetItem();
    expect(getModelMeta('provider-1', 'model-sync').lastTest).toEqual(
      lastTest(1)
    );
    expect(getItemSpy).toHaveBeenCalledTimes(1);
  });

  it('接收到其他不相干 key 的 storage 事件不会清空内存缓存', () => {
    upsertModelMetaExport('provider-1', 'model-sync', {
      lastTest: lastTest(1),
    });
    const before = _getMemoryMetaCacheSnapshot();
    expect(before).not.toBeNull();

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'some_other_key',
        newValue: '123',
      })
    );

    expect(_getMemoryMetaCacheSnapshot()).toBe(before);
  });
});

describe('异常防御与边界保护', () => {
  it('LocalStorage 数据损坏（非法 JSON）时静默回退为空对象，不崩溃', () => {
    localStorage.setItem(META_KEY, '{ invalid json ...');
    resetModelMetaCache();

    const meta = getModelMeta('provider-1', 'unknown-model');
    expect(meta.enabled).toBe(true);
    expect(meta.model).toBe('unknown-model');
    expect(meta.contextLength).toBe(guessContextLength('unknown-model'));
    expect(meta).not.toHaveProperty('lastTest');
    expect(_getMemoryMetaCacheSnapshot()).toEqual({});
  });

  it('LocalStorage 存储非对象类型时安全回退', () => {
    localStorage.setItem(META_KEY, '"a primitive string"');
    resetModelMetaCache();
    expect(getModelMeta('provider-1', 'unknown-model').enabled).toBe(true);
    expect(_getMemoryMetaCacheSnapshot()).toEqual({});

    localStorage.setItem(META_KEY, 'null');
    resetModelMetaCache();
    expect(getModelMeta('provider-1', 'unknown-model').enabled).toBe(true);
    expect(_getMemoryMetaCacheSnapshot()).toEqual({});
  });

  it('LocalStorage.setItem 抛错时写入不崩溃，内存镜像依然更新', () => {
    const setItemSpy = spyStorageSetItem().mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const lt = lastTest(4);
    expect(() => {
      upsertModelMetaExport('provider-1', 'model-fail', { lastTest: lt });
    }).not.toThrow();

    // 真实尝试过落盘（否则本用例不成立），但 LS 内容确为空
    expect(setItemSpy).toHaveBeenCalledWith(META_KEY, expect.any(String));
    expect(localStorage.getItem(META_KEY)).toBeNull();

    // 内存镜像依然有效
    expect(_getMemoryMetaCacheSnapshot()).toEqual({
      'provider-1::model-fail': { lastTest: lt },
    });
    expect(getModelMeta('provider-1', 'model-fail').lastTest).toEqual(lt);
  });
});

describe('孤儿探测键清扫（档案删除 / 历史迁移残留）', () => {
  it('purgeMetaForProfile：删除目标档案全部前缀键，其余档案不受影响；幂等零广播', () => {
    const a = lastTest(1);
    const b = lastTest(2);
    const x = lastTest(3);
    upsertModelMetaExport('provider-1', 'model-a', { lastTest: a });
    upsertModelMetaExport('provider-1', 'model-b', { lastTest: b });
    upsertModelMetaExport('provider-2', 'model-x', { lastTest: x });

    const events: unknown[] = [];
    const off = onUiEvent('model-meta-changed', (detail) => {
      events.push(detail);
    });

    purgeMetaForProfile('provider-1');

    expect(storedMap()).toEqual({ 'provider-2::model-x': { lastTest: x } });
    expect(_getMemoryMetaCacheSnapshot()).toEqual({
      'provider-2::model-x': { lastTest: x },
    });
    expect(events).toEqual([
      { profileId: 'provider-1', model: '', enabled: true },
    ]);

    // 幂等：再次清扫零写回零广播
    purgeMetaForProfile('provider-1');
    expect(storedMap()).toEqual({ 'provider-2::model-x': { lastTest: x } });
    expect(events).toHaveLength(1);

    off();
  });

  it('purgeOrphanMetaKeys：清除白名单外档案键与畸形键（无 :: / 空档案前缀）', () => {
    const m1 = lastTest(1);
    const m2 = lastTest(2);
    upsertModelMetaExport('live-a', 'm1', { lastTest: m1 });
    upsertModelMetaExport('live-b', 'm2', { lastTest: m2 });
    upsertModelMetaExport('orphan-x', 'm3', { lastTest: lastTest(3) });

    const map = storedMap();
    map['bare-key'] = { lastTest: lastTest(4) }; // 无 :: 的历史脏键
    map['::m9'] = { lastTest: lastTest(5) }; // 空档案前缀
    localStorage.setItem(META_KEY, JSON.stringify(map));
    resetModelMetaCache();

    const events: unknown[] = [];
    const off = onUiEvent('model-meta-changed', (detail) => {
      events.push(detail);
    });

    purgeOrphanMetaKeys(new Set(['live-a', 'live-b']));

    expect(storedMap()).toEqual({
      'live-a::m1': { lastTest: m1 },
      'live-b::m2': { lastTest: m2 },
    });
    expect(events).toHaveLength(1);

    // 幂等：无孤儿时零写回
    const frozen = localStorage.getItem(META_KEY);
    purgeOrphanMetaKeys(new Set(['live-a', 'live-b']));
    expect(localStorage.getItem(META_KEY)).toBe(frozen);
    expect(events).toHaveLength(1);

    off();
  });
});

describe('退役写口不可复活（源码文本负向断言）', () => {
  it('modelCatalogMeta.ts 不再导出任何 setModel* 写口，且唯一写口/读口在位', () => {
    for (const name of [
      'setModelEnabled',
      'setModelDisplayName',
      'setModelCapability',
      'setModelContextLength',
      'setModelThinkingLevel',
    ]) {
      expect(SRC).not.toContain(`export function ${name}`);
      expect(SRC).not.toContain(`export const ${name}`);
    }
    // 泛化哨兵：任何新造的 setModel* 导出同样不允许
    expect(SRC).not.toMatch(/export\s+(?:function|const)\s+setModel\w+/);

    // 反向哨兵：唯一写口与清扫口必须在位（防「文件被清空也算绿」）
    for (const kept of [
      'export function upsertModelMetaExport',
      'export function getModelMeta',
      'export function purgeMetaForProfile',
      'export function purgeOrphanMetaKeys',
      'export function resetModelMetaCache',
    ]) {
      expect(SRC).toContain(kept);
    }
  });
});
