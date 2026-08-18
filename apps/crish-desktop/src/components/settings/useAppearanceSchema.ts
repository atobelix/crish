/**
 * 设置 · 外观 · Schema 定义 hook（从 useAppearanceSettings 提取）。
 * 封装外观设置面板的 SchemaSection 结构（主题/密度/窗口/缩进、颜色与皮肤、高级）。
 */
import { useMemo } from 'react';
import type { SchemaSection } from './SettingsSchemaRenderer';
import type { ThemeId } from './useAppearanceSettings';

export interface UseAppearanceSchemaArgs {
  activeTheme: ThemeId;
  skinOptions: { value: string; label: string }[];
  skinPreset: string;
}

export function useAppearanceSchema({
  activeTheme,
  skinOptions,
  skinPreset,
}: UseAppearanceSchemaArgs): SchemaSection[] {
  return useMemo<SchemaSection[]>(
    () => [
      {
        title: '主题与外观',
        properties: [
          {
            key: 'theme',
            type: 'toggle-group' as const,
            title: '主题模式',
            desc: '切换浅色/深色主题',
            toggleOptions: [
              { value: 'default', label: '浅色' },
              { value: 'dark', label: '深色' },
            ],
          },
          {
            key: 'uiSize',
            type: 'toggle-group' as const,
            title: 'UI 密度',
            desc: '控制界面元素的紧凑程度',
            toggleOptions: [
              { value: 'small', label: '紧凑' },
              { value: 'medium', label: '默认' },
              { value: 'large', label: '宽松' },
            ],
          },
          {
            key: 'shellChrome',
            type: 'select' as const,
            title: '窗口风格',
            desc: '选择应用窗口的边框样式',
            options: [
              { value: 'classic', label: '经典' },
              { value: 'inset', label: '工作台' },
            ],
          },
          {
            key: 'codeIndent',
            type: 'select' as const,
            title: '代码缩进',
            desc: '设置代码块中的缩进宽度',
            options: [
              { value: '  ', label: '2 空格' },
              { value: '    ', label: '4 空格' },
              { value: '\t', label: 'Tab' },
            ],
          },
        ],
      },
      {
        title: '颜色与皮肤',
        properties: [
          {
            key: 'skinPreset',
            type: 'select' as const,
            title: '皮肤预设',
            desc:
              activeTheme === 'dark'
                ? '深色模式下可选的高阶主题预设'
                : '浅色模式下可选的高阶主题预设',
            options: skinOptions,
          },
          ...(skinPreset === 'custom'
            ? [
                {
                  key: 'accentColor',
                  type: 'color' as const,
                  title: '自定义背景色',
                  desc: '自定义高阶背景颜色',
                },
                {
                  key: 'customFgColor',
                  type: 'color' as const,
                  title: '自定义文本色',
                  desc: '自适应计算副文本、边框与悬浮文本色',
                },
              ]
            : []),
          {
            key: 'brightness',
            type: 'range' as const,
            title: '亮度微调',
            desc: '调整界面整体亮度',
            min: -5,
            max: 4,
            step: 1,
            showValue: true,
          },
          {
            key: 'fontSize',
            type: 'range' as const,
            title: '界面字号',
            desc: '调整界面基础字号',
            min: 12,
            max: 18,
            step: 1,
            unit: 'px',
            showValue: true,
          },
        ],
      },
      {
        title: '高级',
        properties: [
          {
            key: 'transitionEnabled',
            type: 'boolean' as const,
            title: '智能时光温感过渡',
            desc: '根据当地日出日落时间，自动调节亮度与色温',
          },
          {
            key: 'vibrantMode',
            type: 'boolean' as const,
            title: '氛围色彩融合',
            desc: '调暗时融入暗影，调亮时融入奶霜高光，避免偏灰偏脏',
          },
          {
            key: 'restoreLastWorkspace',
            type: 'boolean' as const,
            title: '启动时恢复上次工作台',
            desc: '默认关闭：每次启动为干净单对话。开启后尝试恢复标签与多 unit 分屏（布局损坏时仍回落干净启动；会话消息始终保留）',
          },
        ],
      },
    ],
    [activeTheme, skinOptions, skinPreset]
  );
}
