/** 完整配置 IPC 契约：字段无损、修订冲突、坏文档与退役投影拒绝。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../test-setup';
import { catalogSnapshot } from '../test-utils/modelsCatalogSnapshot';
import {
  readModelsYamlIpc,
  saveModelsYamlTextIpc,
  validateModelsYamlIpc,
  writeModelsYamlIpc,
} from './modelsCatalogIpc';
import type {
  ModelsCatalogSnapshot,
  ModelsYamlTree,
} from './modelsCatalogTypes';

function configuredTree(): ModelsYamlTree {
  return {
    version: 2,
    activeModel: { providerId: 'Acme', modelId: 'model::one' },
    providers: {
      Acme: {
        displayName: '示例供应商',
        baseUrl: 'https://example.invalid/v1',
        protocol: 'openai/chat',
        enabled: true,
        stream: true,
        order: 0,
        apiKeyRef: 'env:ACME_KEY',
        headers: { 'X-Title': 'conex' },
        proxyUrl: 'socks5://127.0.0.1:1080',
        compat: { supportsDeveloperRole: false },
        models: [
          {
            id: 'model::one',
            displayName: '示例模型',
            enabled: true,
            contextWindow: 128000,
            maxOutputTokens: 12000,
            supportsTools: false,
            thinking: { Low: 'low', High: 'HIGH' },
            cacheTtl: '30m',
            headers: { 'X-Model': 'one' },
            modalities: { input: ['text', 'image'], output: ['text'] },
            pricing: {
              currency: 'USD',
              unit: 'per_1m_tokens',
              input: 0,
              output: 2,
              cacheRead: 0.1,
              cacheWrite: 0.2,
              perImage: 0.04,
              tiers: [{ inputTokensAbove: 64000, output: 3, cacheRead: 0.15 }],
            },
          },
        ],
      },
    },
  };
}

// 回执夹具统一走 test-utils 的唯一工厂（默认值单一真源，D3 契约防线要求）；
// 本包装只补本文件特有的 tree 默认值（configuredTree()），不再自行拼装回执字段。
const snapshot = (tree: ModelsYamlTree | null = configuredTree()) =>
  catalogSnapshot({ tree });

beforeEach(() => vi.clearAllMocks());

describe('规范配置读取', () => {
  it('直接接受完整树与凭据状态，不把供应商大小写或wire改写', async () => {
    const accepted = snapshot();
    const invoke = vi.fn(() => accepted);
    mockTauriCommand('workbench_read_models_yaml', invoke);
    expect(await readModelsYamlIpc()).toEqual({ ok: true, data: accepted });
    expect(invoke).toHaveBeenCalledWith({});
    expect(accepted.tree?.providers.Acme.models[0].thinking?.High).toBe('HIGH');
  });

  it('诚实空配置与未配置活动模型可以成功读取', async () => {
    const accepted = {
      ...snapshot({ version: 2, activeModel: null, providers: {} }),
      credentialStates: {},
    };
    mockTauriCommand('workbench_read_models_yaml', () => accepted);
    expect(await readModelsYamlIpc()).toEqual({ ok: true, data: accepted });
  });

  it('保留错误原文及定位供编辑器修复，不创建可运行的空树', async () => {
    const document = {
      ...snapshot(null),
      content: ':::bad',
      parseError: { line: 3, column: 1, message: '缩进错误' },
    };
    mockTauriCommand('workbench_read_models_yaml', () => document);
    const result = await readModelsYamlIpc();
    expect(result).toEqual({ ok: true, data: document });
    if (result.ok) expect(result.data.tree).toBeNull();
  });

  it('缺失命令明确拒绝，不尝试第二目录命令', async () => {
    const retired = vi.fn();
    mockTauriCommand('catalog_get', retired);
    expect(await readModelsYamlIpc()).toEqual({
      ok: false,
      kind: 'MISSING',
      error: 'workbench_read_models_yaml 命令未注册',
    });
    expect(retired).not.toHaveBeenCalled();
  });

  it.each([
    { path: 'C:/test/models.yaml', providers: {} },
    { ...snapshot(), revision: '' },
    { ...snapshot(), credentialStates: undefined },
    { ...snapshot(), tree: { version: 2, providers: {} } },
    { ...snapshot(), tree: null },
    { ...snapshot(), credentialStates: { Acme: { hasKey: 'yes' } } },
  ])('拒绝不完整或旧投影回执 %#', async (bad) => {
    mockTauriCommand('workbench_read_models_yaml', () => bad);
    expect(await readModelsYamlIpc()).toMatchObject({
      ok: false,
      code: 'CONTRACT_MISMATCH',
    });
  });
});

describe('结构化配置提交', () => {
  it('完整字段直接传入已注册事务，回执包含实际新修订', async () => {
    const tree = configuredTree();
    const committed = { ...snapshot(tree), revision: 'committed-revision' };
    const invoke = vi.fn(() => committed);
    const textSave = vi.fn();
    mockTauriCommand('workbench_apply_models_config', invoke);
    mockTauriCommand('workbench_save_models_yaml', textSave);
    expect(await writeModelsYamlIpc(tree, 'read-revision')).toEqual({
      ok: true,
      data: committed,
    });
    expect(invoke).toHaveBeenCalledWith({
      tree,
      expectedRevision: 'read-revision',
    });
    expect(textSave).not.toHaveBeenCalled();
  });

  it('价格单位、四价、图片价及阶梯均完整传递', async () => {
    const tree = configuredTree();
    const invoke = vi.fn<(payload: unknown) => ModelsCatalogSnapshot>(() =>
      snapshot(tree)
    );
    mockTauriCommand('workbench_apply_models_config', invoke);
    await writeModelsYamlIpc(tree, 'read-revision');
    expect(invoke.mock.calls[0][0]).toMatchObject({
      tree: {
        providers: {
          Acme: {
            models: [{ pricing: tree.providers.Acme.models[0].pricing }],
          },
        },
      },
    });
  });

  it('明确false、零费率与空阶梯不会被删掉', async () => {
    const tree = configuredTree();
    tree.providers.Acme.models[0].pricing!.tiers = [];
    const invoke = vi.fn<(payload: unknown) => ModelsCatalogSnapshot>(() =>
      snapshot(tree)
    );
    mockTauriCommand('workbench_apply_models_config', invoke);
    await writeModelsYamlIpc(tree, 'read-revision');
    expect(invoke.mock.calls[0][0]).toMatchObject({
      tree: {
        providers: {
          Acme: {
            order: 0,
            compat: { supportsDeveloperRole: false },
            models: [
              { supportsTools: false, pricing: { input: 0, tiers: [] } },
            ],
          },
        },
      },
    });
  });

  it('纯图片价格不补造token费率', async () => {
    const tree = configuredTree();
    tree.providers.Acme.models[0].pricing = {
      currency: 'CNY',
      unit: 'per_image',
      perImage: 0.4,
    };
    const invoke = vi.fn<(payload: unknown) => ModelsCatalogSnapshot>(() =>
      snapshot(tree)
    );
    mockTauriCommand('workbench_apply_models_config', invoke);
    await writeModelsYamlIpc(tree, 'read-revision');
    expect(invoke.mock.calls[0][0]).toMatchObject({ tree });
    expect(tree.providers.Acme.models[0].pricing).not.toHaveProperty('input');
  });

  it('清空活动选择明确传null，不自动找下一个模型', async () => {
    const tree = configuredTree();
    tree.activeModel = null;
    const invoke = vi.fn<(payload: unknown) => ModelsCatalogSnapshot>(() =>
      snapshot(tree)
    );
    mockTauriCommand('workbench_apply_models_config', invoke);
    await writeModelsYamlIpc(tree, 'read-revision');
    expect(invoke).toHaveBeenCalledWith({
      tree,
      expectedRevision: 'read-revision',
    });
  });

  it('过期修订保留冲突类别和实际修订，不转为默认成功', async () => {
    mockTauriError('workbench_apply_models_config', {
      code: 'REVISION_CONFLICT',
      message: '配置已被修改',
      currentRevision: 'newer-revision',
    });
    expect(await writeModelsYamlIpc(configuredTree(), 'old-revision')).toEqual({
      ok: false,
      kind: 'REVISION_CONFLICT',
      code: 'REVISION_CONFLICT',
      error: '配置已被修改',
      currentRevision: 'newer-revision',
    });
  });

  it('写失败只返回明确错误，不返回空providers覆盖数据', async () => {
    mockTauriError('workbench_apply_models_config', {
      code: 'CONFIG_IO',
      message: '磁盘不可写',
    });
    const result = await writeModelsYamlIpc(configuredTree(), 'read-revision');
    expect(result).toMatchObject({
      ok: false,
      code: 'CONFIG_IO',
      error: '磁盘不可写',
    });
    expect(result).not.toHaveProperty('data');
  });

  it('命令缺失不回写旧文本或profile入口', async () => {
    expect(
      await writeModelsYamlIpc(configuredTree(), 'read-revision')
    ).toMatchObject({ ok: false, kind: 'MISSING' });
  });

  it('没有修订号时不发出覆盖请求', async () => {
    const invoke = vi.fn();
    mockTauriCommand('workbench_apply_models_config', invoke);
    expect(await writeModelsYamlIpc(configuredTree(), '')).toMatchObject({
      ok: false,
      code: 'REVISION_REQUIRED',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('保存不能接受解析失败或不完整的回执', async () => {
    mockTauriCommand('workbench_apply_models_config', () => ({
      ...snapshot(null),
      parseError: { message: '无效配置' },
    }));
    expect(
      await writeModelsYamlIpc(configuredTree(), 'read-revision')
    ).toMatchObject({ ok: false, kind: 'PARSE_ERROR' });
  });
});

describe('高级文档保存和校验', () => {
  it('原文和预期修订传给同轨文本入口（写盘前先过校验）', async () => {
    const invoke = vi.fn(() => snapshot());
    mockTauriCommand('workbench_save_models_yaml', invoke);
    // 2026-09-15 接线：保存前先 validate（fail-closed），故本用例须一并 mock 校验面
    mockTauriCommand('workbench_validate_models_yaml', () => ({ valid: true }));
    const content =
      '# 保留用户编辑意图\nversion: 2\nproviders: {}\nactiveModel: null\n';
    expect((await saveModelsYamlTextIpc(content, 'read-revision')).ok).toBe(
      true
    );
    expect(invoke).toHaveBeenCalledWith({
      content,
      expectedRevision: 'read-revision',
    });
  });

  it('校验不通过 → 就地拦下，不打给内核写盘（fail-closed）', async () => {
    const invoke = vi.fn(() => snapshot());
    mockTauriCommand('workbench_save_models_yaml', invoke);
    mockTauriCommand('workbench_validate_models_yaml', () => ({
      valid: false,
      message: '非法 yaml：未知字段',
    }));
    const res = await saveModelsYamlTextIpc('bad: true', 'read-revision');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('PARSE_ERROR');
      expect(res.error).toContain('非法 yaml');
    }
    // 关键：非法内容绝不进写盘面
    expect(invoke).not.toHaveBeenCalled();
  });

  it('文档无修订也拒绝提交', async () => {
    expect(await saveModelsYamlTextIpc('version: 2', '')).toMatchObject({
      ok: false,
      code: 'REVISION_REQUIRED',
    });
  });

  it('校验保留内核错误文案及定位', async () => {
    const diagnostic = {
      valid: false,
      line: 2,
      column: 4,
      message: '未知字段',
    };
    mockTauriCommand('workbench_validate_models_yaml', () => diagnostic);
    expect(await validateModelsYamlIpc('version: 2')).toEqual({
      ok: true,
      data: diagnostic,
    });
  });

  it('校验服务缺失明确失败', async () => {
    expect(await validateModelsYamlIpc('version: 2')).toMatchObject({
      ok: false,
      kind: 'MISSING',
    });
  });

  it('校验不把错误回执当valid', async () => {
    mockTauriCommand('workbench_validate_models_yaml', () => ({
      valid: 'yes',
    }));
    expect(await validateModelsYamlIpc('version: 2')).toMatchObject({
      ok: false,
      code: 'CONTRACT_MISMATCH',
    });
  });
});
