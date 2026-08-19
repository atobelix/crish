import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from '../../api/providerProfiles';
import {
  foldSettingsProfiles,
  pickSettingsSelectedId,
  resolveSettingsSelectedId,
} from './modelProfilesHelpers';

function profile(
  partial: Partial<ProviderProfile> & Pick<ProviderProfile, 'id' | 'name'>
): ProviderProfile {
  return {
    baseUrl: '',
    models: [],
    hasKey: false,
    enabled: true,
    ...partial,
  };
}

describe('modelProfilesHelpers 设置列表折叠', () => {
  const seed = profile({
    id: 'opencode-go',
    name: 'OpenCode Go 订阅',
    models: ['deepseek-v4-flash'],
  });
  const copy = profile({
    id: 'preset-opencode-go',
    name: 'OpenCode Go 订阅',
    models: [],
  });
  const zen = profile({
    id: 'opencode-zen',
    name: 'OpenCode Zen 订阅',
  });
  const disabled = profile({
    id: 'off',
    name: 'Off',
    enabled: false,
  });

  it('foldSettingsProfiles 同展示名只留一行且保留停用项', () => {
    const folded = foldSettingsProfiles([copy, seed, zen, disabled]);
    expect(folded.map((p) => p.id)).toEqual([
      'opencode-go',
      'opencode-zen',
      'off',
    ]);
    expect(
      folded.filter((p) => p.name === 'OpenCode Go 订阅')
    ).toHaveLength(1);
  });

  it('resolveSettingsSelectedId 把被折叠的拷贝改绑胜者', () => {
    const raw = [seed, copy, zen];
    const folded = foldSettingsProfiles(raw);
    expect(resolveSettingsSelectedId(folded, raw, 'preset-opencode-go')).toBe(
      'opencode-go'
    );
    expect(resolveSettingsSelectedId(folded, raw, 'opencode-go')).toBe(
      'opencode-go'
    );
    expect(resolveSettingsSelectedId(folded, raw, 'missing')).toBe('');
  });

  it('pickSettingsSelectedId：已选拷贝 → 胜者；否则活动；否则首行', () => {
    const raw = [seed, copy, zen];
    const folded = foldSettingsProfiles(raw);
    expect(
      pickSettingsSelectedId(folded, raw, 'preset-opencode-go', 'opencode-zen')
    ).toBe('opencode-go');
    expect(pickSettingsSelectedId(folded, raw, null, 'opencode-zen')).toBe(
      'opencode-zen'
    );
    expect(pickSettingsSelectedId(folded, raw, null, 'gone')).toBe(
      'opencode-go'
    );
  });
});
