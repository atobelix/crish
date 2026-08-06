import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { Editor } from '@tiptap/core';
import { getFoundationExtensions } from '../../extensions/foundation';
import { BubbleMenu } from '../../components/menus/BubbleMenu';

describe('BubbleMenu Genuine Tiptap Floating Popover Unit & Integration Tests', () => {
  let editor: Editor | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (editor) {
      editor.destroy();
      editor = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
      container = null;
    }
  });

  function setupEditor(content = 'Hello Tiptap Selection Test') {
    container = document.createElement('div');
    document.body.appendChild(container);

    editor = new Editor({
      element: container,
      extensions: getFoundationExtensions(),
      content,
    });
    return editor;
  }

  it('renders BubbleMenu toolbar and attaches Tiptap BubbleMenu floating plugin to editor', async () => {
    const testEditor = setupEditor('Sample text for selection');

    render(<BubbleMenu editor={testEditor} />);

    // Initially with no selection / non-focused selection in JSDOM, plugin is registered on editor
    const registeredPluginNames = testEditor.state.plugins.map((p) => (p as any).key);
    expect(registeredPluginNames.some((key) => key && key.includes('bubbleMenu'))).toBe(true);

    // Select text range from 1 to 10
    act(() => {
      testEditor.commands.setTextSelection({ from: 1, to: 10 });
      testEditor.commands.focus();
    });

    // The toolbar should be rendered inside the portal with accessible role
    const toolbar = await screen.findByRole('toolbar', { name: '文本格式化浮动菜单' });
    expect(toolbar).toBeInTheDocument();

    // Verify all formatting buttons exist in the floating selection menu
    expect(screen.getByRole('button', { name: /加粗/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /斜体/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /删除线/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下划线/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /行内代码/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /超链接/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /标签/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /调色盘/i })).toBeInTheDocument();
  });

  it('interacts with bold button when clicked on selected text', async () => {
    const testEditor = setupEditor('Bold selection test');

    render(<BubbleMenu editor={testEditor} />);

    act(() => {
      testEditor.commands.setTextSelection({ from: 1, to: 5 });
      testEditor.commands.focus();
    });

    const boldBtn = await screen.findByRole('button', { name: /加粗/i });
    expect(boldBtn).toBeInTheDocument();

    act(() => {
      boldBtn.click();
    });

    expect(testEditor.isActive('bold')).toBe(true);
  });
});
