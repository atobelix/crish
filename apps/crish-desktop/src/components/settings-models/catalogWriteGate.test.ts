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
  selectProvider,
} from '../../api/modelsCatalogStore';
import { resetLsImportForTesting } from '../../api/modelsLsImport';

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
