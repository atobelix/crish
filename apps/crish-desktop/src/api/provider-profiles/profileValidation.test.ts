/**
 * profileValidation 纯函数单测：pickDefaultModelSelection 的模型身份契约。
 *
 * 战役：模型配置 SSOT 收敛（W1）——INV-1 / INV-3 / 用户裁决 U1。
 * 核心负向断言：两个供应商都含同名模型时，缺少 providerId 的选择提示
 * **不得**跨供应商回落，必须返回 null（交由 UI 引导用户重配）。
 */

import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from './profileCatalog';
import { pickDefaultModelId, pickDefaultModelSelection } from './profileValidation';

const profiles: ProviderProfile[] = [
  {
    id: 'a',
    name: 'A',
    baseUrl: 'https://a.example/v1',
    models: ['same-model', 'a-second'],
    hasKey: true,
    enabled: true,
  },
  {
    id: 'b',
    name: 'B',
    baseUrl: 'https://b.example/v1',
    models: ['same-model', 'b-second'],
    hasKey: true,
    enabled: true,
  },
];

describe('pickDefaultModelSelection · 模型身份 = (providerId, modelId)', () => {
  it('同名模型跨供应商 + 无 providerId → 返回 null（不命中 A 或 B）', () => {
    expect(
      pickDefaultModelSelection(profiles, { storedModel: 'same-model' })
    ).toBeNull();
  });

  it('有 providerId + 同名模型 → 命中该 provider，不串味到 B', () => {
    expect(
      pickDefaultModelSelection(profiles, {
        storedProfileId: 'a',
        storedModel: 'same-model',
      })
    ).toEqual({ profileId: 'a', model: 'same-model', source: 'stored_active' });
    expect(
      pickDefaultModelSelection(profiles, {
        storedProfileId: 'b',
        storedModel: 'same-model',
      })
    ).toEqual({ profileId: 'b', model: 'same-model', source: 'stored_active' });
  });

  it('有 providerId 无 storedModel → 取该 provider 首个模型', () => {
    expect(pickDefaultModelSelection(profiles, { storedProfileId: 'a' })).toEqual({
      profileId: 'a',
      model: 'same-model',
      source: 'active_profile_first',
    });
    expect(pickDefaultModelSelection(profiles, { storedProfileId: 'b' })).toEqual({
      profileId: 'b',
      model: 'same-model',
      source: 'active_profile_first',
    });
  });

  it('无任何选择提示 → 返回 null（不自动选「第一个可用」）', () => {
    expect(pickDefaultModelSelection(profiles, {})).toBeNull();
    expect(pickDefaultModelSelection(profiles)).toBeNull();
  });

  it('空 profiles → 返回 null', () => {
    expect(pickDefaultModelSelection([], {})).toBeNull();
    expect(pickDefaultModelSelection(null, {})).toBeNull();
    expect(pickDefaultModelSelection(undefined, {})).toBeNull();
  });

  it('engineModel 不参与定位（不带 provider 信息）→ 返回 null', () => {
    expect(
      pickDefaultModelSelection(profiles, { engineModel: 'same-model' })
    ).toBeNull();
  });

  it('pickDefaultModelId 仅包一层，语义同步收敛', () => {
    expect(pickDefaultModelId(profiles, {})).toBeNull();
    expect(
      pickDefaultModelId(profiles, {
        storedProfileId: 'b',
        storedModel: 'same-model',
      })
    ).toBe('same-model');
  });
});
