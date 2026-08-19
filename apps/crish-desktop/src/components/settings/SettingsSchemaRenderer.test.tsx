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

    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(onSave).toHaveBeenCalledWith({ theme: 'dark' });
  });
});
