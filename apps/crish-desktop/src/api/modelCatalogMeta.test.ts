import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onUiEvent } from './uiEvents';
import {
  _getMemoryMetaCacheSnapshot,
  formatModelDisplayName,
  getModelMeta,
  purgeMetaForProfile,
  purgeOrphanMetaKeys,
  resetModelMetaCache,
  setModelCapability,
  setModelContextLength,
  setModelDisplayName,
  setModelEnabled,
  setModelThinkingLevel,
  upsertModelMetaExport,
} from './modelCatalogMeta';

// Node vitest 环境（vitest.config.ts unit 默认为 node）补齐 StorageEvent
if (typeof globalThis.StorageEvent === 'undefined') {
  // @ts-expect-error test env polyfill
  globalThis.StorageEvent = class StorageEvent {
    type: string;
    key?: string | null;
    newValue?: string | null;
    constructor(type: string, init?: { key?: string; newValue?: string }) {
      this.type = type;
      this.key = init?.key ?? null;
      this.newValue = init?.newValue ?? null;
    }
  };
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

describe('modelCatalogMeta with In-Memory Cache', () => {
  beforeEach(() => {
    localStorage.clear();
    resetModelMetaCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('基础元数据存取与默认值', () => {
    it('未设置元数据时返回正确的默认值', () => {
      const meta = getModelMeta('provider-1', 'deepseek-v4-flash');
      expect(meta.profileId).toBe('provider-1');
      expect(meta.model).toBe('deepseek-v4-flash');
      expect(meta.enabled).toBe(true);
      expect(meta.contextLength).toBe(1_048_576);
    });

    it('setModelEnabled 能够正确写入并读取', () => {
      setModelEnabled('provider-1', 'gpt-4o', false);
      const meta = getModelMeta('provider-1', 'gpt-4o');
      expect(meta.enabled).toBe(false);

      setModelEnabled('provider-1', 'gpt-4o', true);
      const updated = getModelMeta('provider-1', 'gpt-4o');
      expect(updated.enabled).toBe(true);
    });

    it('setModelDisplayName 正确修剪空白，纯空白转为 undefined', () => {
      setModelDisplayName('provider-1', 'gpt-4o', '   GPT-4 Omni Custom   ');
      let meta = getModelMeta('provider-1', 'gpt-4o');
      expect(meta.displayName).toBe('GPT-4 Omni Custom');
      expect(formatModelDisplayName('provider-1', 'gpt-4o')).toBe('GPT-4 Omni Custom');

      // 空白修剪后清空
      setModelDisplayName('provider-1', 'gpt-4o', '    ');
      meta = getModelMeta('provider-1', 'gpt-4o');
      expect(meta.displayName).toBeUndefined();
      expect(formatModelDisplayName('provider-1', 'gpt-4o')).toBe('gpt-4o');
    });

    it('支持能力标记、上下文与思考档位更新', () => {
      setModelCapability('provider-1', 'model-x', 'image', true);
      setModelContextLength('provider-1', 'model-x', 128_000);
      setModelThinkingLevel('provider-1', 'model-x', 'high');

      const meta = getModelMeta('provider-1', 'model-x');
      expect(meta.capabilities?.image).toBe(true);
      expect(meta.contextLength).toBe(128_000);
      expect(meta.defaultThinkingLevel).toBe('high');
    });

    it('存量 vision 能力键在首次读取时一次性迁移为 image（幂等）', () => {
      // 预置存量数据：仅含旧 vision 键
      localStorage.setItem(
        'crish_model_meta_v1',
        JSON.stringify({
          'provider-1::legacy-model': {
            profileId: 'provider-1',
            model: 'legacy-model',
            enabled: true,
            capabilities: { tools: true, vision: true, reasoning: false },
          },
          'provider-1::mixed-model': {
            profileId: 'provider-1',
            model: 'mixed-model',
            enabled: true,
            capabilities: { vision: false, image: true },
          },
        })
      );
      resetModelMetaCache();

      const legacy = getModelMeta('provider-1', 'legacy-model');
      expect(legacy.capabilities?.image).toBe(true);
      expect((legacy.capabilities as Record<string, unknown>).vision).toBeUndefined();

      // 双键并存（vision:false + image:true）→ image 保持 true，vision 清除
      const mixed = getModelMeta('provider-1', 'mixed-model');
      expect(mixed.capabilities?.image).toBe(true);
      expect((mixed.capabilities as Record<string, unknown>).vision).toBeUndefined();

      // 迁移写回存储：LS 中不再存在 vision 键
      const stored = JSON.parse(
        localStorage.getItem('crish_model_meta_v1') ?? '{}'
      ) as Record<string, { capabilities: Record<string, unknown> }>;
      expect(stored['provider-1::legacy-model']?.capabilities?.vision).toBeUndefined();
      expect(stored['provider-1::legacy-model']?.capabilities?.image).toBe(true);

      // 幂等：再次重载读取结果不变
      resetModelMetaCache();
      expect(getModelMeta('provider-1', 'legacy-model').capabilities?.image).toBe(true);
    });
  });

  describe('memoryMetaCache 单例内存镜像机制', () => {
    it('内存缓存命中：后续读取不重复执行 localStorage.getItem', () => {
      // 预置数据
      setModelEnabled('provider-1', 'model-a', true);

      // spy localStorage.getItem
      const getItemSpy = spyStorageGetItem();

      // 首次读取：由于 setModelEnabled 已经写穿透，memoryMetaCache 应该已有数据
      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();
      const meta1 = getModelMeta('provider-1', 'model-a');
      expect(meta1.enabled).toBe(true);

      // 多次密集读取
      for (let i = 0; i < 50; i++) {
        getModelMeta('provider-1', 'model-a');
      }

      // 期间应当 0 次调用 getItem
      expect(getItemSpy).toHaveBeenCalledTimes(0);
    });

    it('resetModelMetaCache 会清空内存镜像并在下次读取时触发重新加载', () => {
      setModelEnabled('provider-1', 'model-b', false);
      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

      resetModelMetaCache();
      expect(_getMemoryMetaCacheSnapshot()).toBeNull();

      const getItemSpy = spyStorageGetItem();
      const meta = getModelMeta('provider-1', 'model-b');
      expect(meta.enabled).toBe(false);
      expect(getItemSpy).toHaveBeenCalledTimes(1);
    });

    it('Devil-06: 连续执行 2,000 次 getModelMeta，主线程耗时必须严格小于 5ms', () => {
      // 预先初始化若干模型数据
      for (let i = 0; i < 20; i++) {
        setModelEnabled('provider-1', `model-bench-${i}`, i % 2 === 0);
      }

      // JIT 预热消除冷启动延迟
      for (let i = 0; i < 200; i++) {
        getModelMeta('provider-1', `model-bench-${i % 20}`);
      }

      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) {
        const m = `model-bench-${i % 20}`;
        getModelMeta('provider-1', m);
      }
      const elapsed = performance.now() - t0;

      // 验证极速内存直读（通常 < 1ms，门禁要求 < 5ms）
      expect(elapsed).toBeLessThan(5);
    });
  });

  describe('UI 事件广播联动（model-meta-changed）', () => {
    it('setModelEnabled 变更时精准广播 model-meta-changed 事件', () => {
      const received: unknown[] = [];
      const off = onUiEvent('model-meta-changed', (detail) => {
        received.push(detail);
      });

      setModelEnabled('provider-x', 'claude-3-7-sonnet', false);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        profileId: 'provider-x',
        model: 'claude-3-7-sonnet',
        enabled: false,
        displayName: undefined,
      });

      off();
    });

    it('setModelDisplayName 变更时广播带 displayName 的事件', () => {
      const received: unknown[] = [];
      const off = onUiEvent('model-meta-changed', (detail) => {
        received.push(detail);
      });

      setModelDisplayName('provider-y', 'deepseek-r1', 'DeepSeek R1 Thinking');

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        profileId: 'provider-y',
        model: 'deepseek-r1',
        enabled: true,
        displayName: 'DeepSeek R1 Thinking',
      });

      off();
    });

    it('upsertModelMetaExport 同样触发事件广播', () => {
      const received: unknown[] = [];
      const off = onUiEvent('model-meta-changed', (detail) => {
        received.push(detail);
      });

      upsertModelMetaExport('provider-z', 'qwen-2.5-max', {
        enabled: true,
        displayName: '通义千问 Max',
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        profileId: 'provider-z',
        model: 'qwen-2.5-max',
        enabled: true,
        displayName: '通义千问 Max',
      });

      off();
    });
  });

  describe('跨窗口 StorageEvent 监听与失效机制', () => {
    it('接收到 crish_model_meta_v1 键的 storage 事件时自动使内存缓存过期', () => {
      setModelEnabled('provider-1', 'model-sync', true);
      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

      // 派发 StorageEvent
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'crish_model_meta_v1',
          newValue: JSON.stringify({}),
        })
      );

      // 内存缓存应该已被清空为 null
      expect(_getMemoryMetaCacheSnapshot()).toBeNull();
    });

    it('接收到其他不相干 key 的 storage 事件不会清空内存缓存', () => {
      setModelEnabled('provider-1', 'model-sync', true);
      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'some_other_key',
          newValue: '123',
        })
      );

      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();
    });
  });

  describe('异常防御与边界保护', () => {
    it('LocalStorage 数据损坏（非法 JSON）时静默回退为空对象，不崩溃', () => {
      localStorage.setItem('crish_model_meta_v1', '{ invalid json ...');
      resetModelMetaCache();

      const meta = getModelMeta('provider-1', 'unknown-model');
      expect(meta.enabled).toBe(true);
      expect(meta.model).toBe('unknown-model');
    });

    it('LocalStorage 存储非对象类型时安全回退', () => {
      localStorage.setItem('crish_model_meta_v1', '"a primitive string"');
      resetModelMetaCache();

      const meta = getModelMeta('provider-1', 'unknown-model');
      expect(meta.enabled).toBe(true);
    });

    it('LocalStorage.setItem 抛错时写入不崩溃，内存镜像依然更新', () => {
      spyStorageSetItem().mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      expect(() => {
        setModelEnabled('provider-1', 'model-fail', false);
      }).not.toThrow();

      // 内存镜像依然有效
      expect(getModelMeta('provider-1', 'model-fail').enabled).toBe(false);
    });
  });

  describe('孤儿 meta 键清扫（档案删除 / 历史迁移残留）', () => {
    it('purgeMetaForProfile：删除目标档案全部前缀键，其余档案不受影响', () => {
      setModelEnabled('provider-1', 'model-a', true);
      setModelEnabled('provider-1', 'model-b', false);
      setModelEnabled('provider-2', 'model-x', true);

      purgeMetaForProfile('provider-1');

      const stored = JSON.parse(
        localStorage.getItem('crish_model_meta_v1') ?? '{}'
      ) as Record<string, unknown>;
      expect(stored['provider-1::model-a']).toBeUndefined();
      expect(stored['provider-1::model-b']).toBeUndefined();
      expect(stored['provider-2::model-x']).toBeDefined();

      // 幂等：再次清扫零写回零异常
      purgeMetaForProfile('provider-1');
      expect(getModelMeta('provider-2', 'model-x').enabled).toBe(true);
    });

    it('purgeOrphanMetaKeys：清除不在白名单的档案前缀键，含畸形键', () => {
      setModelEnabled('live-a', 'm1', true);
      setModelEnabled('live-b', 'm2', true);
      setModelEnabled('orphan-x', 'm3', true);
      setModelEnabled('orphan-y', 'm4', true);
      // 无档案前缀的畸形键（历史脏数据）
      const map = JSON.parse(
        localStorage.getItem('crish_model_meta_v1') ?? '{}'
      ) as Record<string, unknown>;
      map['bare-key'] = { profileId: 'orphan-z', model: 'm5', enabled: true };
      localStorage.setItem('crish_model_meta_v1', JSON.stringify(map));
      resetModelMetaCache();

      purgeOrphanMetaKeys(new Set(['live-a', 'live-b']));

      const stored = JSON.parse(
        localStorage.getItem('crish_model_meta_v1') ?? '{}'
      ) as Record<string, unknown>;
      expect(stored['live-a::m1']).toBeDefined();
      expect(stored['live-b::m2']).toBeDefined();
      expect(stored['orphan-x::m3']).toBeUndefined();
      expect(stored['orphan-y::m4']).toBeUndefined();
      expect(stored['bare-key']).toBeUndefined();

      // 幂等：无孤儿时零写回
      purgeOrphanMetaKeys(new Set(['live-a', 'live-b']));
      expect(getModelMeta('live-a', 'm1').enabled).toBe(true);
    });
  });
});
