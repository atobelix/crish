// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsSchemaRenderer } from './SettingsSchemaRenderer';

describe('SettingsSchemaRenderer I4 死皮拉回', () => {
  it('toggle-group 走 SegmentedControl，不再渲染 .ui-segment 裸按钮', () => {
    const onSave = vi.fn();
    render(
      <SettingsSchemaRenderer
        ready
        onSave={onSave}
        values={{ theme: 'default' }}
        schema={[
          {
            title: '主题与外观',
            properties: [
              {
                key: 'theme',
                type: 'toggle-group',
                title: '主题模式',
                toggleOptions: [
                  { value: 'default', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ],
              },
            ],
          },
        ]}
      />
    );

    expect(document.querySelector('.ui-segment')).toBeNull();
    expect(document.querySelector('.ui-segment-item')).toBeNull();
    expect(
      screen.getByRole('radiogroup', { name: '主题模式' })
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '浅色' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(onSave).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('boolean 走 Switch，ready 时能拨且上报', () => {
    const onSave = vi.fn();
    render(
      <SettingsSchemaRenderer
        ready
        onSave={onSave}
        values={{ queueMode: false }}
        schema={[
          {
            title: '对话偏好',
            properties: [
              {
                key: 'queueMode',
                type: 'boolean',
                title: '排队发送模式',
              },
            ],
          },
        ]}
      />
    );

    const sw = screen.getByRole('switch');
    expect(sw).not.toBeDisabled();
    fireEvent.click(sw);
    expect(onSave).toHaveBeenCalledWith({ queueMode: true });
  });

  it('ready=false 时开关禁用，避免未加载就写', () => {
    const onSave = vi.fn();
    render(
      <SettingsSchemaRenderer
        ready={false}
        onSave={onSave}
        values={{ queueMode: false }}
        schema={[
          {
            title: '对话偏好',
            properties: [
              {
                key: 'queueMode',
                type: 'boolean',
                title: '排队发送模式',
              },
            ],
          },
        ]}
      />
    );

    expect(screen.getByRole('switch')).toBeDisabled();
    fireEvent.click(screen.getByRole('switch'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('select 走 ui/Select，不贴死 class settings-personalize-select', () => {
    const onSave = vi.fn();
    render(
      <SettingsSchemaRenderer
        ready
        onSave={onSave}
        values={{ responseStyle: 'medium' }}
        schema={[
          {
            title: '对话偏好',
            properties: [
              {
                key: 'responseStyle',
                type: 'select',
                title: '回答风格',
                options: [
                  { value: 'minimal', label: '简洁' },
                  { value: 'medium', label: '详细' },
                ],
              },
            ],
          },
        ]}
      />
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger).not.toBeDisabled();
    expect(trigger.className).not.toMatch(/settings-personalize-select/);
    expect(screen.getByText('详细')).toBeInTheDocument();
  });

  it('range 走 ui/Slider，不再渲染裸 input[type=range]', () => {
    const onSave = vi.fn();
    render(
      <SettingsSchemaRenderer
        ready
        onSave={onSave}
        values={{ fontSize: 14 }}
        schema={[
          {
            title: '颜色与皮肤',
            properties: [
              {
                key: 'fontSize',
                type: 'range',
                title: '界面字号',
                min: 12,
                max: 18,
                step: 1,
                unit: 'px',
                showValue: true,
              },
            ],
          },
        ]}
      />
    );

    expect(document.querySelector('input[type="range"]')).toBeNull();
    expect(
      screen.getByRole('slider', { name: '界面字号' })
    ).toBeInTheDocument();
    expect(screen.getByText('14px')).toBeInTheDocument();
  });

  it('支持 i18n 键动态解析与 fallback 回退', () => {
    const onSave = vi.fn();
    render(
      <SettingsSchemaRenderer
        ready
        onSave={onSave}
        values={{ theme: 'dark', size: 16 }}
        schema={[
          {
            title: '外观设置',
            titleKey: 'settings.theme',
            properties: [
              {
                key: 'theme',
                type: 'select',
                title: '主题',
                titleKey: 'settings.theme',
                desc: '界面主题外观',
                descKey: 'custom.unmatched.desc',
                placeholder: '请选择主题',
                placeholderKey: 'custom.unmatched.placeholder',
                options: [
                  {
                    value: 'dark',
                    label: '深色模式',
                    labelKey: 'settings.dark',
                  },
                ],
              },
              {
                key: 'size',
                type: 'range',
                title: '字体大小',
                titleKey: 'settings.fontSize',
                unit: 'px',
                unitKey: 'custom.unmatched.unit',
                showValue: true,
              },
              {
                key: 'skin',
                type: 'preset-grid',
                title: '预设',
                presets: [
                  {
                    id: 'dark-preset',
                    name: '深色主题预设',
                    nameKey: 'settings.dark',
                    preview: '#000',
                  },
                ],
              },
            ],
          },
        ]}
      />
    );

    // Section title matched via settings.theme -> '主题' (in default zh-CN)
    expect(screen.getAllByText('主题').length).toBeGreaterThanOrEqual(1);
    // Unmatched descKey falls back to static desc '界面主题外观'
    expect(screen.getByText('界面主题外观')).toBeInTheDocument();
    // Options labelKey and Preset nameKey both matched settings.dark -> '深色'
    expect(screen.getAllByText('深色').length).toBe(2);
    // Range slider name matched settings.fontSize -> '字体大小'
    expect(
      screen.getByRole('slider', { name: '字体大小' })
    ).toBeInTheDocument();
    // Unmatched unitKey falls back to static unit 'px'
    expect(screen.getByText('16px')).toBeInTheDocument();
  });
});
