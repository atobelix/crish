/**
 * 设置 · 外观 · 皮肤域 hook（从 useAppearanceSettings 提取）。
 * 封装浅/深色皮肤 ID 集合、皮肤回退校验（#237）与皮肤选项列表。
 */
import { useEffect, useMemo } from 'react';
import type { ThemeId } from './useAppearanceSettings';
import type { PersonalizationSettings } from '../../api/themeStore';

/** 浅/深色主题各自的皮肤 ID 集合，用于皮肤回退校验（#237） */
const DARK_SKIN_IDS = [
  'dark-cozy',
  'deep-night',
  'dark-forest',
  'aurora',
  'cocoa',
  'burgundy',
  'cyber',
  'obsidian',
];
const LIGHT_SKIN_IDS = [
  'warm-gray',
  'cream',
  'paper',
  'classic-gray',
  'sakura',
  'matcha',
  'glacier',
  'pearl',
];

export interface UseSkinSettingsArgs {
  activeTheme: ThemeId;
  personalization: PersonalizationSettings;
  updatePersonalization: (
    updates: Partial<PersonalizationSettings>
  ) => void;
}

export interface UseSkinSettingsResult {
  skinOptions: { value: string; label: string }[];
}

export function useSkinSettings({
  activeTheme,
  personalization,
  updatePersonalization,
}: UseSkinSettingsArgs): UseSkinSettingsResult {
  // 切换主题时，如果当前选中的皮肤不在新主题预设中，自动回退到该主题的第一个预设皮肤（#237）
  // 注意：必须位于 updatePersonalization（const useCallback）之后——
  // 依赖数组在渲染期求值，提前引用会触发 TDZ ReferenceError 导致整个 tab 崩溃。
  useEffect(() => {
    const validSkins = activeTheme === 'dark' ? DARK_SKIN_IDS : LIGHT_SKIN_IDS;
    if (
      personalization.skin !== 'custom' &&
      !validSkins.includes(personalization.skin)
    ) {
      const fallback = activeTheme === 'dark' ? 'dark-cozy' : 'warm-gray';
      updatePersonalization({ skin: fallback });
    }
  }, [activeTheme, personalization.skin, updatePersonalization]);

  const skinOptions = useMemo(() => {
    const list =
      activeTheme === 'dark'
        ? [
            { value: 'dark-cozy', label: '护眼暗灰' },
            { value: 'deep-night', label: '深邃夜空' },
            { value: 'dark-forest', label: '森林绿影' },
            { value: 'aurora', label: '北欧极光' },
            { value: 'cocoa', label: '可可暗香' },
            { value: 'burgundy', label: '暗红丝绒' },
            { value: 'cyber', label: '赛博星空' },
            { value: 'obsidian', label: '黑曜石墨' },
          ]
        : [
            { value: 'warm-gray', label: '护眼暖灰' },
            { value: 'cream', label: '杏仁奶油' },
            { value: 'paper', label: '极简纸质' },
            { value: 'classic-gray', label: '经典浅灰' },
            { value: 'sakura', label: '落樱微风' },
            { value: 'matcha', label: '抹茶拿铁' },
            { value: 'glacier', label: '冰川薄荷' },
            { value: 'pearl', label: '金沙流光' },
          ];

    list.push({ value: 'custom', label: '自定义颜色' });
    return list;
  }, [activeTheme]);

  return { skinOptions };
}
