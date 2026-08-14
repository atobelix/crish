/**
 * thinkingGear：思考档位单源（描述接口 offered → 档位面板）专项测试。
 * 单源 = Rust describe_model 的 offered_levels()（R2 C9），前端不再自造档位表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tauriInvoke', () => ({
  invokeResult: vi.fn(async () => ({ status: 'missing' as const })),
}));

import {
  applyCatalogEfforts,
  clearCatalogEfforts,
  fetchDescribeEffortsSnapshot,
  resolveCatalogEfforts,
  thinkingLevelOptionsFor,
} from './thinkingGear';
import { invokeResult } from './tauriInvoke';

beforeEach(() => {
  clearCatalogEfforts();
  vi.mocked(invokeResult).mockReset();
  vi.mocked(invokeResult).mockImplementation(async () => ({
    status: 'missing' as const,
  }));
});

afterEach(() => {
  clearCatalogEfforts();
});

describe('fetchDescribeEffortsSnapshot（catalog_get → 档位快照单源）', () => {
  const wire = {
    entries: [
      {
        model: 'deepseek-v4-flash',
        reasoningEffortTiers: { low: 'low', medium: 'medium', high: 'high' },
      },
      {
        model: 'gpt-5',
        apiModel: 'gpt-5.2',
        thinkingLevelMap: { low: 'low', medium: 'medium' },
      },
    ],
  };

  it('成功：invoke(catalog_get) → applyCatalogEfforts → resolveCatalogEfforts 单源可用', async () => {
    vi.mocked(invokeResult).mockImplementation(async (cmd: string) =>
      cmd === 'catalog_get'
        ? { status: 'ok' as const, data: wire }
        : { status: 'missing' as const }
    );
    expect(await fetchDescribeEffortsSnapshot()).toBe(true);
    expect(resolveCatalogEfforts('deepseek-v4-flash')).toEqual({
      offered: ['high', 'low', 'medium'],
      defaultEffort: 'high',
    });
    expect(resolveCatalogEfforts('gpt-5.2')).toEqual({
      offered: ['low', 'medium'],
      defaultEffort: 'low',
    });
    // 档位面板仅渲染这些档位 + 提供方默认
    expect(
      thinkingLevelOptionsFor(resolveCatalogEfforts('deepseek-v4-flash')).map(
        (o) => o.value
      )
    ).toEqual(['default', 'high', 'low', 'medium']);
  });

  it('失败降级：missing / error → false，档位面板仅提供方默认（不渲染自造档位）', async () => {
    // missing（非 Tauri / 命令未注册）
    expect(await fetchDescribeEffortsSnapshot()).toBe(false);
    // error
    vi.mocked(invokeResult).mockImplementation(async () => ({
      status: 'error' as const,
      message: 'x',
    }));
    expect(await fetchDescribeEffortsSnapshot()).toBe(false);
    // 全程未注入 → resolve 空 offered → 仅提供方默认项
    expect(thinkingLevelOptionsFor(undefined).map((o) => o.value)).toEqual([
      'default',
    ]);
    expect(resolveCatalogEfforts('deepseek-v4-flash')).toEqual({ offered: [] });
  });
});

describe('applyCatalogEfforts / resolveCatalogEfforts 边界', () => {
  it('非法载荷（entries 缺失 / 非数组 / 全隐藏）→ 不落快照，档位面板回落提供方默认', () => {
    applyCatalogEfforts(null);
    applyCatalogEfforts({});
    applyCatalogEfforts({ entries: [] as never[] });
    applyCatalogEfforts({
      entries: [{ model: 'x', thinkingLevelMap: { low: null } }],
    });
    expect(resolveCatalogEfforts('anything')).toEqual({ offered: [] });
    expect(thinkingLevelOptionsFor(null)).toEqual([
      { value: 'default', label: '提供方默认', isProviderDefault: true },
    ]);
  });
});
