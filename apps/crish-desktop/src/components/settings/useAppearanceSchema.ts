/**
 * 设置 · 外观 · Schema 定义 hook（从 useAppearanceSettings 提取）。
 * 封装外观设置面板的 SchemaSection 结构（主题与外观、颜色与皮肤）。
 * 分区口径（R2 整改）：原「高级」分区删除——智能时光温感过渡并入「主题与外观」、
 * 氛围色彩融合并入「颜色与皮肤」；「代码缩进」移通用设置对话偏好、
 * 「界面字号」移「字体与排版」手写区（FontSettingsSection）、
 * 「启动时恢复上次工作台」移通用设置界面偏好。标题全部走 titleKey（settingsParts 补键）。
 */
import React, { useMemo } from 'react';
import type { SchemaSection } from './SettingsSchemaRenderer';
import type { ThemeId } from './useAppearanceSettings';

// 自研原生 Sun / Moon 微图标 (14x14)，零外部 npm 依赖
const SunIcon: React.FC = () =>
  React.createElement(
    'svg',
    {
      width: '14',
      height: '14',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '2',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    React.createElement('circle', { cx: '12', cy: '12', r: '5' }),
    React.createElement('line', { x1: '12', y1: '1', x2: '12', y2: '3' }),
    React.createElement('line', { x1: '12', y1: '21', x2: '12', y2: '23' }),
    React.createElement('line', {
      x1: '4.22',
      y1: '4.22',
      x2: '5.64',
      y2: '5.64',
    }),
    React.createElement('line', {
      x1: '18.36',
      y1: '18.36',
      x2: '19.78',
      y2: '19.78',
    }),
    React.createElement('line', { x1: '1', y1: '12', x2: '3', y2: '12' }),
    React.createElement('line', { x1: '21', y1: '12', x2: '23', y2: '12' }),
    React.createElement('line', {
      x1: '4.22',
      y1: '19.78',
      x2: '5.64',
      y2: '18.36',
    }),
    React.createElement('line', {
      x1: '18.36',
      y1: '5.64',
      x2: '19.78',
      y2: '4.22',
    })
  );

const MoonIcon: React.FC = () =>
  React.createElement(
    'svg',
    {
      width: '14',
      height: '14',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '2',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    React.createElement('path', {
      d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    })
  );

export interface UseAppearanceSchemaArgs {
  activeTheme: ThemeId;
  skinOptions: { value: string; label: string }[];
  skinPreset: string;
  isWin11?: boolean;
}

export function useAppearanceSchema({
  activeTheme,
  skinOptions,
  skinPreset,
  isWin11 = false,
}: UseAppearanceSchemaArgs): SchemaSection[] {
  return useMemo<SchemaSection[]>(
    () => [
      {
        title: '主题与外观',
        titleKey: 'settings.appearance.schemaSectionTheme',
        properties: [
          {
            key: 'theme',
            type: 'toggle-group' as const,
            title: '主题模式',
            titleKey: 'settings.appearance.schemaThemeMode',
            toggleOptions: [
              {
                value: 'default',
                label: '浅色',
                labelKey: 'settings.appearance.schemaThemeLight',
                icon: React.createElement(SunIcon),
              },
              {
                value: 'dark',
                label: '深色',
                labelKey: 'settings.appearance.schemaThemeDark',
                icon: React.createElement(MoonIcon),
              },
            ],
          },
          ...(isWin11
            ? [
                {
                  key: 'enableMicaEffect',
                  type: 'boolean' as const,
                  title: 'Mica Effect (Windows 11)',
                  titleKey: 'appearance.micaTitle',
                },
              ]
            : []),
          {
            key: 'uiSize',
            type: 'toggle-group' as const,
            title: 'UI 密度',
            titleKey: 'settings.appearance.schemaUiSize',
            toggleOptions: [
              {
                value: 'small',
                label: '紧凑',
                labelKey: 'settings.appearance.schemaUiSizeCompact',
              },
              {
                value: 'medium',
                label: '默认',
                labelKey: 'settings.appearance.schemaUiSizeDefault',
              },
              {
                value: 'large',
                label: '宽松',
                labelKey: 'settings.appearance.schemaUiSizeLoose',
              },
            ],
          },
          {
            key: 'shellChrome',
            type: 'select' as const,
            title: '窗口风格',
            titleKey: 'settings.appearance.schemaWindowStyle',
            options: [
              {
                value: 'classic',
                label: '经典',
                labelKey: 'settings.appearance.schemaWindowClassic',
              },
              {
                value: 'inset',
                label: '工作台',
                labelKey: 'settings.appearance.schemaWindowWorkbench',
              },
            ],
          },
          {
            // 原「高级」分区的视觉效果项并入本区（主题自动化）
            key: 'transitionEnabled',
            type: 'boolean' as const,
            title: '智能时光温感过渡',
            titleKey: 'settings.appearance.schemaAutoTime',
            desc: '根据当地日出日落时间，自动调节亮度与色温',
            descKey: 'settings.appearance.schemaAutoTimeDesc',
          },
        ],
      },
      {
        title: '颜色与皮肤',
        titleKey: 'settings.appearance.schemaSectionColorSkin',
        properties: [
          {
            key: 'skinPreset',
            type: 'select' as const,
            title: '皮肤预设',
            titleKey: 'settings.appearance.schemaSkinPreset',
            options: skinOptions,
          },
          ...(skinPreset === 'custom'
            ? [
                {
                  key: 'accentColor',
                  type: 'color' as const,
                  title: '自定义背景色',
                  titleKey: 'settings.appearance.schemaCustomBg',
                },
                {
                  key: 'customFgColor',
                  type: 'color' as const,
                  title: '自定义文本色',
                  titleKey: 'settings.appearance.schemaCustomFg',
                },
              ]
            : []),
          {
            key: 'brightness',
            type: 'range' as const,
            title: '亮度微调',
            titleKey: 'settings.appearance.schemaBrightness',
            min: -4,
            max: 4,
            step: 1,
            showValue: true,
          },
          {
            // 原「高级」分区的视觉效果项并入本区（色彩融合）
            key: 'vibrantMode',
            type: 'boolean' as const,
            title: '氛围色彩融合',
            titleKey: 'settings.appearance.schemaVibrant',
            desc: '调暗时融入暗影，调亮时融入奶霜高光，避免偏灰偏脏',
            descKey: 'settings.appearance.schemaVibrantDesc',
          },
        ],
      },
    ],
    [activeTheme, skinOptions, skinPreset, isWin11]
  );
}
