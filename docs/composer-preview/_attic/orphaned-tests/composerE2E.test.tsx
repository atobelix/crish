import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComposerShell } from '../../components/editor/ComposerShell';

describe('Composer Component E2E Integration Suite (Features 1, 5, 20, 21, 24)', () => {
  it('Feature 1: should render Composer shell with Tiptap editor and Markdown output panes', () => {
    const { container } = render(<ComposerShell />);

    // Verify container and headers render
    expect(screen.getByText('Tiptap Composer Engine')).toBeInTheDocument();
    expect(screen.getByText('Markdown Serialized Output')).toBeInTheDocument();

    // Verify dual-pane layout elements
    const panes = container.querySelectorAll('.composer-pane');
    expect(panes.length).toBe(2);
  });

  it('Feature 5: should render task list checkbox items inside editor view', () => {
    const { container } = render(<ComposerShell />);

    // Check task list elements exist in DOM
    const taskLists = container.querySelectorAll('ul[data-type="taskList"]');
    expect(taskLists.length).toBeGreaterThan(0);

    const taskItems = container.querySelectorAll('li[data-checked]');
    expect(taskItems.length).toBeGreaterThan(0);
  });

  it('Feature 59: should display serialized raw Markdown text in output preview pane', () => {
    const { container } = render(<ComposerShell />);

    // Check output pre element contains serialized markdown content
    const outputPre = container.querySelector('.markdown-code-output');
    expect(outputPre).toBeInTheDocument();
    expect(outputPre?.textContent).toContain('Milestone 1: 核心 Markdown 渲染引擎演示');
    expect(outputPre?.textContent).toContain('- [x] 完美支持 Checkbox 实时点击切换');
  });
});
