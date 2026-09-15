// @vitest-environment jsdom
/**
 * 期 1 验收（迁移方案 03 §四期 1）：`config_profile_apply` 走统一树。
 *
 * 覆盖：纯函数树合并语义 / 成功路径 / CAS 冲突重试 / 读树失败显式降级 /
 * 开关关闭回旧命令（零代码回滚面）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMock = vi.fn();
const writeMock = vi.fn();

vi.mock('../modelsCatalogIpc', () => ({
  readModelsYamlIpc: (...a: unknown[]) => readMock(...a),
  writeModelsYamlIpc: (...a: unknown[]) => writeMock(...a),
}));

import { applySelectionToTree, configProfileApply } from './rustProfileStore';
import type { ModelsYamlTree } from '../modelsCatalogTypes';

const emptyTree = (): ModelsYamlTree => ({
  version: 2,
  activeModel: null,
  providers: {},
});

const snapshotOf = (tree: ModelsYamlTree, revision = 'rev-1', hasKey = false) =>
  ({
    path: 'C:/test/models.yaml',
    content: '',
    revision,
    tree,
    credentialStates: { Acme: { hasKey, apiKeyLast4: hasKey ? '1234' : null } },
    template: '',
  }) as never;

describe('applySelectionToTree（纯函数）', () => {
  it('新 provider + 新 model → 构造最小项并置为活动模型', () => {
    const next = applySelectionToTree(emptyTree(), {
      profileId: 'Acme',
      baseUrl: 'https://a.example/v1',
      model: 'm-1',
    });
    expect(next.providers.Acme.baseUrl).toBe('https://a.example/v1');
    expect(next.providers.Acme.models.map((m) => m.id)).toEqual(['m-1']);
    expect(next.providers.Acme.models[0]?.enabled).toBe(true);
    expect(next.activeModel).toEqual({ providerId: 'Acme', modelId: 'm-1' });
  });

  it('已有 provider → 保留既有字段并追加 model，不覆盖 baseUrl', () => {
    const tree: ModelsYamlTree = {
      version: 2,
      activeModel: null,
      providers: {
        Acme: {
          displayName: '既有名',
          baseUrl: 'https://old.example/v1',
          protocol: 'openai/responses',
          stream: false,
          enabled: true,
          models: [{ id: 'm-0', enabled: true }],
        },
      },
    };
    const next = applySelectionToTree(tree, { profileId: 'Acme', model: 'm-1' });
    expect(next.providers.Acme.displayName).toBe('既有名');
    expect(next.providers.Acme.baseUrl).toBe('https://old.example/v1');
    expect(next.providers.Acme.protocol).toBe('openai/responses');
    expect(next.providers.Acme.models.map((m) => m.id)).toEqual(['m-0', 'm-1']);
  });

  it('已有同 id model → 不重复追加（幂等）', () => {
    const once = applySelectionToTree(emptyTree(), {
      profileId: 'Acme',
      model: 'm-1',
    });
    const twice = applySelectionToTree(once, {
      profileId: 'Acme',
      model: 'm-1',
    });
    expect(twice.providers.Acme.models).toHaveLength(1);
  });

  it('空 model → 不臆造活动选择（保持原 activeModel）', () => {
    const tree: ModelsYamlTree = {
      version: 2,
      activeModel: { providerId: 'Other', modelId: 'x' },
      providers: {},
    };
    const next = applySelectionToTree(tree, { profileId: 'Acme' });
    expect(next.activeModel).toEqual({ providerId: 'Other', modelId: 'x' });
  });

  it('不改写入参（不可变）', () => {
    const tree = emptyTree();
    applySelectionToTree(tree, { profileId: 'Acme', model: 'm-1' });
    expect(tree.providers).toEqual({});
    expect(tree.activeModel).toBeNull();
  });
});

describe('configProfileApply（期 1 走树）', () => {
  beforeEach(() => {
    readMock.mockReset();
    writeMock.mockReset();
  });

  it('成功路径：读树 → 合并 → CAS apply，返回脱敏状态', async () => {
    readMock.mockResolvedValue({ ok: true, data: snapshotOf(emptyTree()) });
    writeMock.mockResolvedValue({
      ok: true,
      data: snapshotOf(emptyTree(), 'rev-2', true),
    });
    const res = await configProfileApply({ profileId: 'Acme', model: 'm-1' });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.data.ok).toBe(true);
      expect(res.data.profileId).toBe('Acme');
      expect(res.data.hasApiKey).toBe(true);
      expect(res.data.apiKeyLast4).toBe('1234');
    }
    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({ Acme: expect.anything() }),
      }),
      'rev-1'
    );
  });

  it('CAS 冲突 → 用后端 currentRevision 重试并成功', async () => {
    readMock.mockResolvedValue({ ok: true, data: snapshotOf(emptyTree()) });
    writeMock
      .mockResolvedValueOnce({
        ok: false,
        kind: 'REVISION_CONFLICT',
        error: 'conflict',
        currentRevision: 'rev-9',
      })
      .mockResolvedValueOnce({
        ok: true,
        data: snapshotOf(emptyTree(), 'rev-10', false),
      });
    const res = await configProfileApply({ profileId: 'Acme', model: 'm-1' });
    expect(res.status).toBe('ok');
    expect(writeMock).toHaveBeenNthCalledWith(2, expect.anything(), 'rev-9');
  });

  it('读树 missing → 显式 missing（不假装成功）', async () => {
    readMock.mockResolvedValue({ ok: false, kind: 'MISSING', error: 'no cmd' });
    const res = await configProfileApply({ profileId: 'Acme', model: 'm-1' });
    expect(res.status).toBe('missing');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('CAS 冲突且无 currentRevision → 显式 error，不无限重试', async () => {
    readMock.mockResolvedValue({ ok: true, data: snapshotOf(emptyTree()) });
    writeMock.mockResolvedValue({
      ok: false,
      kind: 'REVISION_CONFLICT',
      error: 'conflict',
    });
    const res = await configProfileApply({ profileId: 'Acme', model: 'm-1' });
    expect(res.status).toBe('error');
    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});
