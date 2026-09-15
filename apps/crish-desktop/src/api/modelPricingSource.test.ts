/**
 * 价格页单一真源门禁（方案 `docs/provider-single-track-convergence/05-价格页与模型配置
 * 对齐方案.md` §3/§5）：
 *   P-1 名单 = 统一树 `modelIndex`（含确定性排序）
 *   P-2 删模型 ⇒ 价不可解析（`resolveEffectivePrice` → null）
 *   P-4 未收录 ≠ 0（回退链三态：user / estimate / none）
 *   写入面 = 树 `ModelSpec.pricing`（CAS；清除 = 显式 undefined）
 *   旧 LS 价表迁移：幂等 / 歧义丢弃 / 树未加载跳过 / 备份键
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mockTauriCommand } from '../test-setup';
import { catalogSnapshot } from '../test-utils/modelsCatalogSnapshot';
import { modelsCatalogStore } from './modelsCatalogStore';
import { applyCatalogCacheSnapshot, clearCatalogCacheSnapshot } from './pricingResolver';
import { PRICES_KEY } from './pricingTypes';
import {
  PRICES_BACKUP_KEY,
  deriveBillingMode,
  listConfiguredPrices,
  migrateLegacyLsPrices,
  resolveEffectivePrice,
  resolveUserPricing,
  setModelPrice,
} from './modelPricingSource';
import type { ModelRef, ModelsYamlTree, ProviderSpec } from './modelsCatalogTypes';
import { parseModelRefKey } from './modelsCatalogTypes';

const APPLY = 'workbench_apply_models_config';

const ref = (providerId: string, modelId: string): ModelRef => ({
  providerId,
  modelId,
});

function provider(
  overrides: Partial<ProviderSpec> & Pick<ProviderSpec, 'models'>
): ProviderSpec {
  return {
    protocol: 'openai/chat',
    stream: true,
    enabled: true,
    ...overrides,
  };
}

/**
 * 树夹具：order 故意乱序，用于钉死「provider.order → providerId → model.order →
 * modelId」四段排序；含停用供应商与停用模型（树是权威名单，仍应出现）。
 */
function tree(): ModelsYamlTree {
  return {
    version: 2,
    activeModel: null,
    providers: {
      zai: provider({
        displayName: '  智谱 GLM  ',
        order: 2,
        models: [
          { id: 'glm-5-2', enabled: true, order: 2 },
          { id: 'glm-4-5-air', enabled: true, order: 1, displayName: ' Air ' },
        ],
      }),
      deepseek: provider({
        displayName: '   ',
        order: 1,
        models: [
          {
            id: 'deepseek-v4-flash',
            enabled: true,
            pricing: {
              currency: 'USD',
              unit: 'per_1m_tokens',
              input: 0.2,
              output: 0.28,
              cacheRead: 0.002,
            },
          },
        ],
      }),
      // 无 order → 视为大值（排在有 order 者之后）
      zoo: provider({
        displayName: 'Zoo',
        enabled: false,
        models: [
          { id: 'm2', enabled: true, order: -1 },
          { id: 'm1', enabled: false },
        ],
      }),
      // 与 zai 同 order → 按 providerId 决序（'alpha' < 'zai'）
      alpha: provider({
        order: 2,
        models: [
          { id: 'b-model', enabled: true, order: 5 },
          { id: 'a-model', enabled: true, order: 5 },
        ],
      }),
    },
  };
}

let hostTree: ModelsYamlTree;
let hostRevision: string;
let counter: number;

/** 安装树（已加载态）+ 写盘 mock（CAS：修订不符即拒绝） */
function install(value: ModelsYamlTree): void {
  modelsCatalogStore.resetForTesting();
  hostTree = structuredClone(value);
  hostRevision = 'revision-0';
  counter = 0;
  modelsCatalogStore.acceptSnapshot(
    catalogSnapshot({ tree: structuredClone(hostTree), revision: hostRevision })
  );
  mockTauriCommand(APPLY, (payload) => {
    const args = payload as { tree: ModelsYamlTree; expectedRevision: string };
    if (args.expectedRevision !== hostRevision) {
      throw { code: 'REVISION_CONFLICT', message: 'revision changed' };
    }
    hostTree = structuredClone(args.tree);
    hostRevision = `revision-${++counter}`;
    return catalogSnapshot({
      tree: structuredClone(hostTree),
      revision: hostRevision,
    });
  });
}

function modelPricing(providerId: string, modelId: string): unknown {
  return hostTree.providers[providerId]?.models.find((m) => m.id === modelId)
    ?.pricing;
}

beforeEach(() => {
  localStorage.clear();
  clearCatalogCacheSnapshot();
  install(tree());
});

describe('P-1 名单真源 = 统一树 modelIndex', () => {
  it('名单条目与身份一一对应（含停用供应商 / 停用模型）', () => {
    const rows = listConfiguredPrices();
    expect(rows.map((r) => `${r.providerId}/${r.modelId}`)).toEqual([
      'deepseek/deepseek-v4-flash',
      'alpha/a-model',
      'alpha/b-model',
      'zai/glm-4-5-air',
      'zai/glm-5-2',
      'zoo/m2',
      'zoo/m1',
    ]);
    // 与树模型集合一一对应（无孤儿、无缺漏）
    const treeKeys = [...modelsCatalogStore.getState().modelIndex.keys()];
    expect(rows).toHaveLength(treeKeys.length);
    expect(rows.map((r) => r.ref)).toEqual(
      expect.arrayContaining(treeKeys.map((k) => parseModelRefKey(k)))
    );
  });

  it('排序确定性：provider.order → providerId → model.order → modelId', () => {
    const rows = listConfiguredPrices();
    // 同 order=2 的 alpha 先于 zai（providerId 决序）；zoo 无 order 排最后
    expect(rows.slice(1, 3).map((r) => r.providerId)).toEqual([
      'alpha',
      'alpha',
    ]);
    // 同 order=5 的模型按 modelId 决序
    expect(rows.slice(1, 3).map((r) => r.modelId)).toEqual([
      'a-model',
      'b-model',
    ]);
    // zoo 内：m2（order=-1）先于 m1（无 order）
    expect(rows.slice(5).map((r) => r.modelId)).toEqual(['m2', 'm1']);
    // 重复调用顺序稳定
    expect(listConfiguredPrices().map((r) => r.modelId)).toEqual(
      rows.map((r) => r.modelId)
    );
  });

  it('展示名回退：displayName 去空白，空/缺省回退 id', () => {
    const rows = listConfiguredPrices();
    const zai = rows.find((r) => r.providerId === 'zai')!;
    expect(zai.providerName).toBe('智谱 GLM');
    expect(rows.find((r) => r.modelId === 'glm-4-5-air')?.displayName).toBe('Air');
    // provider.displayName 全空白 → 回退 providerId
    expect(rows.find((r) => r.providerId === 'deepseek')?.providerName).toBe(
      'deepseek'
    );
    expect(rows.find((r) => r.modelId === 'glm-5-2')?.displayName).toBe('glm-5-2');
  });

  it('名单不含「价表残留」：删模型后名单少一条且价格消失', async () => {
    expect(listConfiguredPrices().some((r) => r.modelId === 'm1')).toBe(true);
    expect((await modelsCatalogStore.removeModel('zoo', 'm1')).ok).toBe(true);
    expect(listConfiguredPrices().some((r) => r.modelId === 'm1')).toBe(false);
  });
});

describe('回退链三态：树用户声明 → 出厂字典预估 → 未收录', () => {
  it('user：树声明价（权威），逐字段直取', () => {
    const price = resolveEffectivePrice(ref('deepseek', 'deepseek-v4-flash'));
    expect(price).toEqual({
      currency: 'USD',
      inputPerMTok: 0.2,
      outputPerMTok: 0.28,
      cacheReadPerMTok: 0.002,
      source: 'user',
    });
    // 未声明字段保持「未配置」（不是 0）
    expect(price?.cacheWritePerMTok).toBeUndefined();
    expect(resolveUserPricing(ref('deepseek', 'deepseek-v4-flash'))).toEqual(
      tree().providers.deepseek!.models[0]!.pricing
    );
  });

  it('estimate：无树声明时用字典快照（预估），并保留未声明字段为空', () => {
    applyCatalogCacheSnapshot({
      version: 1,
      prices: {
        'glm-5-2': {
          inputPerMTok: 0.6,
          outputPerMTok: 2.2,
          readPerMTok: 0.11,
          writeFree: true,
          currency: 'CNY',
        },
      },
    });
    expect(resolveEffectivePrice(ref('zai', 'glm-5-2'))).toEqual({
      currency: 'CNY',
      inputPerMTok: 0.6,
      outputPerMTok: 2.2,
      cacheReadPerMTok: 0.11,
      cacheWritePerMTok: 0,
      source: 'estimate',
    });
    // 用户声明优先于字典（覆盖同一模型）
    expect(
      resolveEffectivePrice(ref('deepseek', 'deepseek-v4-flash'))?.source
    ).toBe('user');
  });

  it('none：树无声明且字典未收录 → null（不得渲染为 0）', () => {
    const none = ref('zai', 'glm-5-2');
    expect(resolveEffectivePrice(none)).toBeNull();
    expect(resolveEffectivePrice(none)).not.toBe(0);
    // 字典只有缓存价、无输入/输出价 → 不足以构成可用价 → 未收录
    applyCatalogCacheSnapshot({
      version: 2,
      prices: { 'glm-5-2': { readPerMTok: 0.11 } },
    });
    expect(resolveEffectivePrice(none)).toBeNull();
  });

  it('精确 id 查表：substring / 版本后缀 / 大小写一律不命中', () => {
    applyCatalogCacheSnapshot({
      version: 1,
      prices: {
        'deepseek-v4-flash': { inputPerMTok: 0.14, outputPerMTok: 0.28 },
      },
    });
    expect(
      resolveEffectivePrice(ref('zai', 'deepseek-v4-flash'))?.source
    ).toBe('estimate');
    for (const id of [
      'flash',
      'deepseek-v4-flash-0731',
      'DEEPSEEK-V4-FLASH',
      'deepseek',
    ]) {
      expect(resolveEffectivePrice(ref('zai', id))).toBeNull();
    }
  });

  it('树声明缺输入/输出价 → 非「0 费率」，回退链落字典（禁止补零）', () => {
    const partial = provider({
      models: [{ id: 'only-currency', enabled: true, pricing: { currency: 'CNY' } }],
    });
    install({
      version: 2,
      activeModel: null,
      providers: { p: partial },
    });
    applyCatalogCacheSnapshot({
      version: 3,
      prices: { 'only-currency': { inputPerMTok: 1, outputPerMTok: 2 } },
    });
    // 用户声明本身仍按 user 呈现（currency 权威），但不补零
    expect(resolveEffectivePrice(ref('p', 'only-currency'))).toMatchObject({
      currency: 'CNY',
      source: 'user',
      inputPerMTok: undefined,
      outputPerMTok: undefined,
    });
    expect(
      resolveEffectivePrice(ref('p', 'only-currency'))?.inputPerMTok
    ).not.toBe(0);
  });
});

describe('写入面：setModelPrice 落树（CAS）', () => {
  it('写入用户声明价 → 落树并可回读', async () => {
    const target = ref('zai', 'glm-5-2');
    expect(resolveEffectivePrice(target)).toBeNull();
    expect(
      await setModelPrice(target, {
        currency: 'CNY',
        unit: 'per_1m_tokens',
        input: 1,
        output: 2,
      })
    ).toEqual({ ok: true });
    expect(modelPricing('zai', 'glm-5-2')).toEqual({
      currency: 'CNY',
      unit: 'per_1m_tokens',
      input: 1,
      output: 2,
    });
    expect(resolveEffectivePrice(target)).toMatchObject({
      source: 'user',
      currency: 'CNY',
      inputPerMTok: 1,
      outputPerMTok: 2,
    });
    expect(listConfiguredPrices().find((r) => r.modelId === 'glm-5-2')?.userPricing)
      .toEqual({ currency: 'CNY', unit: 'per_1m_tokens', input: 1, output: 2 });
  });

  it('pricing=undefined → 从树中删除 pricing 键（回落字典预估）', async () => {
    applyCatalogCacheSnapshot({
      version: 1,
      prices: { 'glm-5-2': { inputPerMTok: 9, outputPerMTok: 9 } },
    });
    const target = ref('zai', 'glm-5-2');
    await setModelPrice(target, { currency: 'USD', input: 1, output: 2 });
    expect(
      Object.hasOwn(hostTree.providers.zai!.models.find((m) => m.id === 'glm-5-2')!, 'pricing')
    ).toBe(true);
    expect(await setModelPrice(target, undefined)).toEqual({ ok: true });
    // 键被真正删除（不是留一个 undefined 占位）
    expect(
      Object.hasOwn(hostTree.providers.zai!.models.find((m) => m.id === 'glm-5-2')!, 'pricing')
    ).toBe(false);
    expect(modelPricing('zai', 'glm-5-2')).toBeUndefined();
    expect(resolveUserPricing(target)).toBeUndefined();
    expect(resolveEffectivePrice(target)).toMatchObject({
      source: 'estimate',
      inputPerMTok: 9,
    });
  });

  it('未加载 / 模型不存在 → 显式失败（禁止静默降级）', async () => {
    modelsCatalogStore.resetForTesting();
    const notLoaded = await setModelPrice(ref('zai', 'glm-5-2'), {
      currency: 'USD',
      input: 1,
      output: 2,
    });
    expect(notLoaded.ok).toBe(false);
    expect(notLoaded.ok === false && notLoaded.error).toContain('尚未成功加载');

    install(tree());
    // 模型不存在 → 明确错误文本
    const missing = await setModelPrice(ref('zai', 'no-such-model'), {
      currency: 'USD',
      input: 1,
      output: 2,
    });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.error).toContain('模型不存在');
    // 非法价（负数）→ 校验失败，同样显式回传
    const invalid = await setModelPrice(ref('zai', 'glm-5-2'), {
      currency: 'CNY',
      input: -1,
    });
    expect(invalid.ok).toBe(false);
  });

  it('P-2：删模型后 resolveEffectivePrice 返回 null（价格挂在模型上）', async () => {
    const target = ref('zai', 'glm-5-2');
    await setModelPrice(target, { currency: 'CNY', input: 1, output: 2 });
    expect(resolveEffectivePrice(target)?.source).toBe('user');
    expect((await modelsCatalogStore.removeModel('zai', 'glm-5-2')).ok).toBe(true);
    expect(resolveUserPricing(target)).toBeUndefined();
    expect(resolveEffectivePrice(target)).toBeNull();
    // 整条供应商删除同样使价格消失
    const other = ref('zoo', 'm2');
    await setModelPrice(other, { currency: 'USD', input: 3, output: 4 });
    expect((await modelsCatalogStore.removeProvider('zoo')).ok).toBe(true);
    expect(resolveEffectivePrice(other)).toBeNull();
  });
});

describe('旧 LS 价表一次性迁移', () => {
  /** 目标模型（zai/glm-5-2）在树中**无** pricing 声明 → 可迁移 */
  const legacyRow = {
    model: 'glm-5-2',
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 0.2,
  };

  it('树未加载 → skipped 且绝不改动 LS', async () => {
    const raw = JSON.stringify([legacyRow]);
    localStorage.setItem(PRICES_KEY, raw);
    modelsCatalogStore.resetForTesting();
    expect(await migrateLegacyLsPrices()).toEqual({
      migrated: 0,
      dropped: 0,
      skipped: true,
    });
    expect(localStorage.getItem(PRICES_KEY)).toBe(raw);
    expect(localStorage.getItem(PRICES_BACKUP_KEY)).toBeNull();
  });

  it('唯一持有者 → 写树；原键置 []（不 removeItem）且备份原值', async () => {
    const raw = JSON.stringify([legacyRow]);
    localStorage.setItem(PRICES_KEY, raw);
    expect(await migrateLegacyLsPrices()).toEqual({
      migrated: 1,
      dropped: 0,
      skipped: false,
    });
    expect(modelPricing('zai', 'glm-5-2')).toEqual({
      currency: 'USD',
      unit: 'per_1m_tokens',
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
    });
    // 键保留但置空（可辨识「已迁移」），原值进备份键
    expect(localStorage.getItem(PRICES_KEY)).toBe('[]');
    expect(localStorage.getItem(PRICES_BACKUP_KEY)).toBe(raw);
    expect(resolveEffectivePrice(ref('zai', 'glm-5-2'))).toMatchObject({
      source: 'user',
      inputPerMTok: 1,
      outputPerMTok: 2,
    });
  });

  it('幂等：第二次调用不再迁移，备份键不被覆盖', async () => {
    localStorage.setItem(PRICES_KEY, JSON.stringify([legacyRow]));
    await migrateLegacyLsPrices();
    const backup = localStorage.getItem(PRICES_BACKUP_KEY);
    expect(await migrateLegacyLsPrices()).toEqual({
      migrated: 0,
      dropped: 0,
      skipped: false,
    });
    expect(localStorage.getItem(PRICES_BACKUP_KEY)).toBe(backup);
    // 已有备份（更早一次迁移的痕迹）不被本轮覆盖
    localStorage.setItem(PRICES_BACKUP_KEY, 'ORIGINAL');
    localStorage.setItem(
      PRICES_KEY,
      JSON.stringify([{ model: 'm2', inputPerMTok: 5, outputPerMTok: 6 }])
    );
    expect(await migrateLegacyLsPrices()).toEqual({
      migrated: 1,
      dropped: 0,
      skipped: false,
    });
    expect(modelPricing('zoo', 'm2')).toMatchObject({ input: 5, output: 6 });
    expect(localStorage.getItem(PRICES_BACKUP_KEY)).toBe('ORIGINAL');
  });

  it('歧义 / 未知 modelId → 丢弃（不猜供应商），不写任何树', async () => {
    install({
      version: 2,
      activeModel: null,
      providers: {
        p1: provider({ models: [{ id: 'shared-model', enabled: true }] }),
        p2: provider({ models: [{ id: 'shared-model', enabled: true }] }),
        p3: provider({ models: [{ id: 'known-model', enabled: true }] }),
      },
    });
    localStorage.setItem(
      PRICES_KEY,
      JSON.stringify([
        { model: 'shared-model', inputPerMTok: 1, outputPerMTok: 2 },
        { model: 'ghost-model', inputPerMTok: 1, outputPerMTok: 2 },
        { model: '   ', inputPerMTok: 1, outputPerMTok: 2 },
        { model: 'known-model', inputPerMTok: 3, outputPerMTok: 4 },
      ])
    );
    expect(await migrateLegacyLsPrices()).toEqual({
      migrated: 1,
      dropped: 3,
      skipped: false,
    });
    expect(modelPricing('p1', 'shared-model')).toBeUndefined();
    expect(modelPricing('p2', 'shared-model')).toBeUndefined();
    expect(modelPricing('p3', 'known-model')).toMatchObject({ input: 3, output: 4 });
  });

  it('树已有用户声明 → 不覆盖（权威源优先），计入 dropped', async () => {
    localStorage.setItem(
      PRICES_KEY,
      JSON.stringify([
        { model: 'deepseek-v4-flash', inputPerMTok: 99, outputPerMTok: 99 },
      ])
    );
    expect(await migrateLegacyLsPrices()).toEqual({
      migrated: 0,
      dropped: 1,
      skipped: false,
    });
    expect(modelPricing('deepseek', 'deepseek-v4-flash')).toMatchObject({
      input: 0.2,
      output: 0.28,
    });
  });

  it('脏行（缺输入/输出价）丢弃；坏 JSON 抛错且原键不动', async () => {
    localStorage.setItem(
      PRICES_KEY,
      JSON.stringify([
        { model: 'deepseek-v4-flash', inputPerMTok: 'x', outputPerMTok: 2 },
      ])
    );
    expect(await migrateLegacyLsPrices()).toEqual({
      migrated: 0,
      dropped: 1,
      skipped: false,
    });
    expect(modelPricing('deepseek', 'deepseek-v4-flash')).toMatchObject({
      input: 0.2,
    });

    localStorage.setItem(PRICES_KEY, 'not-json');
    await expect(migrateLegacyLsPrices()).rejects.toThrow(/无法解析/);
    expect(localStorage.getItem(PRICES_KEY)).toBe('not-json');
  });
});

describe('计费模式派生（能力为唯一真源；用户裁决 2026-09-15：不再手选）', () => {
  it('deriveBillingMode：仅 modalities.output 含 image ⇒ per_image', () => {
    expect(deriveBillingMode({ id: 'm', enabled: true })).toBe(
      'per_1m_tokens'
    );
    expect(
      deriveBillingMode({
        id: 'm',
        enabled: true,
        modalities: { input: ['text'], output: ['text'] },
      })
    ).toBe('per_1m_tokens');
    expect(
      deriveBillingMode({
        id: 'm',
        enabled: true,
        modalities: { input: ['text'], output: ['image'] },
      })
    ).toBe('per_image');
    // 反向：只有**输入**含 image（视觉理解模型）不是生图模型
    expect(
      deriveBillingMode({
        id: 'm',
        enabled: true,
        modalities: { input: ['image'], output: ['text'] },
      })
    ).toBe('per_1m_tokens');
    // 文本 + 图片双输出 → 含 image 即按张（能力优先）
    expect(
      deriveBillingMode({
        id: 'm',
        enabled: true,
        modalities: { input: ['text'], output: ['text', 'image'] },
      })
    ).toBe('per_image');
  });

  it('名单行携带派生计费模式；与树 pricing.unit 无关（防「两个真源」）', () => {
    install(
      provider_(
        {
          // 显式声明 unit 为 per_image，但能力是纯文本 ⇒ 派生结果仍为按 Token
          id: 'text-but-claims-image-unit',
          enabled: true,
          pricing: {
            currency: 'CNY',
            unit: 'per_image',
            input: 1,
            output: 2,
            perImage: 0.5,
          },
        },
        {
          // 未声明 unit，但能力是生图 ⇒ 派生结果为按张
          id: 'image-but-no-unit',
          enabled: true,
          modalities: { input: ['text'], output: ['image'] },
        }
      )
    );

    const rows = listConfiguredPrices();
    // 两者均无 order ⇒ 同档，按 modelId 码元序（'i' < 't'）决序
    expect(rows.map((r) => `${r.modelId}=${r.billingMode}`)).toEqual([
      'image-but-no-unit=per_image',
      'text-but-claims-image-unit=per_1m_tokens',
    ]);
  });
});

/** 单供应商夹具（本 describe 专用；不扰动上方排序夹具）。 */
function provider_(...models: ProviderSpec['models']): ModelsYamlTree {
  return {
    version: 2,
    activeModel: null,
    providers: {
      p: {
        protocol: 'openai/chat',
        stream: true,
        enabled: true,
        models,
      },
    },
  };
}
