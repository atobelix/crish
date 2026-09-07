// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileEditor } from './FileEditor';

describe('FileEditor Pure White Paper Surface', () => {
  it('renders textarea with editor class and no inline bg-primary style', () => {
    render(
      <FileEditor
        editBuf="const a = 1;"
        content="const a = 1;"
        dirty={false}
        onChange={vi.fn()}
      />
    );

    const textarea = screen.getByRole('textbox', { name: '源码编辑区域' });
    expect(textarea).toBeDefined();
    // 验证内联样式中绝对没有 'var(--bg-primary)'
    expect(textarea.style.background).not.toContain('var(--bg-primary)');
  });

  it('renders textarea inside editorWrapper container', () => {
    const { container } = render(
      <FileEditor
        editBuf="const a = 1;"
        content="const a = 1;"
        dirty={false}
        onChange={vi.fn()}
      />
    );

    const textarea = screen.getByRole('textbox', { name: '源码编辑区域' });
    expect(textarea.parentElement?.className).toContain('editorWrapper');
  });
});
