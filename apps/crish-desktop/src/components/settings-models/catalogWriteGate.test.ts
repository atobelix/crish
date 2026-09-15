// @vitest-environment jsdom
/**
 * catalogWriteGate —— 协议 SSOT 派生一致性 + 缺省协议落盘。
 *
 * 断言目标（W4 / U4）：
 * 1. YAML_PROTOCOL_SELECT_OPTIONS 的 value 集合与 PROTOCOLS 一致（派生，非手写清单）；
 *    label 一律来自 PROTOCOL_LABELS，无本地文案。
 * 2. 新建供应商不填 protocol → 落盘供应商 protocol = DEFAULT_PROTOCOL。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  DEFAULT_YAML_PROTOCOL,
  YAML_PROTOCOL_SELECT_OPTIONS,
  addDraftToModelInput,
  ensureProviderShell,
  protocolForProviderWrite,
} from './catalogWriteGate';
import {
  DEFAULT_PROTOCOL,
  PROTOCOLS,
  PROTOCOL_LABELS,
} from '../../api/modelsNormalize';
import {
  modelsCatalogStore,
  resetModelsCatalogMirror,
  selectModel,
  selectProvider,
} from '../../api/modelsCatalogStore';
import { resetLsImportForTesting } from '../../api/modelsLsImport';
import { calculateAutofillDraft } from './manualAddAutofill';
import { emptyAddDraft } from './modelsIpcHelpers';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

describe('catalogWriteGate 协议 SSOT 派生', () => {
  beforeEach(() => {
    resetModelsCatalogMirror();
    resetLsImportForTesting();
    localStorage.clear();
  });

  it('YAML_PROTOCOL_SELECT_OPTIONS 的 value 集合与 PROTOCOLS 完全一致', () => {
    const values = YAML_PROTOCOL_SELECT_OPTIONS.map((o) => o.value);
    expect(values).toEqual([...PROTOCOLS]);
    expect(new Set(values).size).toBe(PROTOCOLS.length);
  });

  it('label 全部来自 PROTOCOL_LABELS，无本地自写文案', () => {
    for (const o of YAML_PROTOCOL_SELECT_OPTIONS) {
      expect(o.label).toBe(PROTOCOL_LABELS[o.value]);
      expect(o.id).toBe(o.value);
    }
  });

  it('DEFAULT_YAML_PROTOCOL 恒等于 SSOT DEFAULT_PROTOCOL', () => {
    expect(DEFAULT_YAML_PROTOCOL).toBe(DEFAULT_PROTOCOL);
  });

  it('protocolForProviderWrite：缺省 / 非法 → DEFAULT_PROTOCOL', () => {
    expect(protocolForProviderWrite(undefined)).toBe(DEFAULT_PROTOCOL);
    expect(protocolForProviderWrite(null)).toBe(DEFAULT_PROTOCOL);
    expect(protocolForProviderWrite('')).toBe(DEFAULT_PROTOCOL);
    expect(protocolForProviderWrite('乱写的协议')).toBe(DEFAULT_PROTOCOL);
    // 合法值原样保留
    expect(protocolForProviderWrite('anthropic/messages')).toBe(
      'anthropic/messages'
    );
  });

  it('ensureProviderShell：不填 protocol → 落盘供应商 protocol = DEFAULT_PROTOCOL', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      revision: 'revision-0',
      content: '',
      template: '',
      credentialStates: {},
      parseError: null,
      tree: { version: 2, activeModel: null, providers: {} },
    }));
    let submittedTree: unknown = null;
    mockTauriCommand('workbench_apply_models_config', (args) => {
      submittedTree = (args as { tree: unknown }).tree;
      return {
        path: CATALOG_PATH,
        revision: 'revision-1',
        content: '',
        template: '',
        credentialStates: {},
        parseError: null,
        tree: submittedTree,
      };
    });

    const res = await ensureProviderShell({
      providerId: 'custom-x',
      displayName: 'Custom X',
      baseUrl: 'https://x.invalid/v1',
      // protocol 故意缺省
    });

    expect(res.ok).toBe(true);
    expect(selectProvider('custom-x')?.protocol).toBe(DEFAULT_PROTOCOL);
    // 提交给内核事务的规范树亦为 SSOT 默认协议（序列化在内核）
    const tree = submittedTree as { providers: Record<string, { protocol: string }> } | null;
    expect(tree?.providers['custom-x']?.protocol).toBe(DEFAULT_PROTOCOL);
  });
});

/**
 * 用户裁决「模型字典只做参考，实际以用户配置为准」的落库闸门：
 * 手动新增走完真实 store 落盘后，统一树里不得出现字典预估价。
 */
describe('addDraftToModelInput 价格闸门（默认拒收参考价）', () => {
  beforeEach(() => {
    resetModelsCatalogMirror();
    resetLsImportForTesting();
    localStorage.clear();
  });

  function mockCatalog(readTree: unknown) {
    let submitted: unknown = null;
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      revision: 'revision-0',
      content: '',
      template: '',
      credentialStates: {},
      parseError: null,
      tree: readTree,
    }));
    mockTauriCommand('workbench_apply_models_config', (args) => {
      submitted = (args as { tree: unknown }).tree;
      return {
        path: CATALOG_PATH,
        revision: 'revision-1',
        content: '',
        template: '',
        credentialStates: {},
        parseError: null,
        tree: submitted,
      };
    });
    return () => submitted as { providers: Record<string, { models: unknown[] }> } | null;
  }

  it('负向断言：手动新增 + 未编辑价格 → 落树补丁与持久化树都不含 pricing', async () => {
    const getSubmitted = mockCatalog({
      version: 2,
      activeModel: null,
      providers: {},
    });
    await ensureProviderShell({
      providerId: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai/chat',
    });

    // 真实链路：字典预填 → 闸门 → addModel
    const draft = calculateAutofillDraft(
      'deepseek-v4-pro',
      'deepseek',
      emptyAddDraft()
    );
    const input = addDraftToModelInput('deepseek-v4-pro', draft);
    expect(Object.hasOwn(input, 'pricing')).toBe(false);

    const res = await modelsCatalogStore.addModel('deepseek', input);
    expect(res.ok).toBe(true);

    const persisted = getSubmitted();
    const model = persisted?.providers['deepseek']?.models[0] as Record<
      string,
      unknown
    >;
    expect(model).toBeTruthy();
    expect(Object.hasOwn(model!, 'pricing')).toBe(false);
    expect(model!['displayName']).toBe('DeepSeek V4 Pro');
    // 内存镜像同样不得有 pricing
    expect(Object.hasOwn(selectModel('deepseek', 'deepseek-v4-pro')!, 'pricing')).toBe(
      false
    );
  });

  it('正向断言：用户显式声明价格 → 落树补丁与持久化树都含正确 pricing', async () => {
    const getSubmitted = mockCatalog({
      version: 2,
      activeModel: null,
      providers: {},
    });
    await ensureProviderShell({
      providerId: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai/chat',
    });

    const input = addDraftToModelInput('user-priced', {
      ...emptyAddDraft(),
      modelId: 'user-priced',
      contextWindow: '128000',
      pricing: { currency: 'CNY', input: '3', output: '12' },
      pricingExplicit: true,
    });
    expect(input.pricing).toEqual({
      currency: 'CNY',
      input: 3,
      output: 12,
    });

    const res = await modelsCatalogStore.addModel('deepseek', input);
    expect(res.ok).toBe(true);

    const model = getSubmitted()?.providers['deepseek']?.models[0] as Record<
      string,
      unknown
    >;
    expect(model!['pricing']).toEqual({
      currency: 'CNY',
      input: 3,
      output: 12,
    });
  });

  it('安全点：编辑已有模型且未动价格 → 持久化树中原有 pricing 保持不变', async () => {
    const existingPricing = {
      currency: 'CNY',
      unit: 'per_1m_tokens',
      input: 3,
      output: 12,
      cacheRead: 0.3,
    };
    const getSubmitted = mockCatalog({
      version: 2,
      activeModel: null,
      providers: {
        deepseek: {
          displayName: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          protocol: 'openai/chat',
          stream: true,
          enabled: true,
          models: [
            {
              id: 'deepseek-v4-pro',
              displayName: 'DeepSeek V4 Pro',
              enabled: true,
              contextWindow: 1048576,
              pricing: existingPricing,
            },
          ],
        },
      },
    });

    const loaded = await modelsCatalogStore.ensureLoaded();
    expect(loaded).toBe(true);
    expect(selectModel('deepseek', 'deepseek-v4-pro')?.pricing).toEqual(
      existingPricing
    );

    // 真实场景：模型列表启用/停用开关只发 { enabled }，不含 pricing
    const res = await modelsCatalogStore.updateModel(
      'deepseek',
      'deepseek-v4-pro',
      { enabled: false }
    );
    expect(res.ok).toBe(true);

    const persisted = getSubmitted()?.providers['deepseek']?.models[0] as Record<
      string,
      unknown
    >;
    expect(persisted!['pricing']).toEqual(existingPricing);
    expect(persisted!['enabled']).toBe(false);
    // 内存镜像同步保持
    expect(selectModel('deepseek', 'deepseek-v4-pro')?.pricing).toEqual(
      existingPricing
    );
  });
});
