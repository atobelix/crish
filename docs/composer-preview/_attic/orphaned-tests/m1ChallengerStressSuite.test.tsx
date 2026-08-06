import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, screen, cleanup, act } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { getFoundationExtensions } from '../../extensions/foundation';
import { CALLOUT_ICONS } from '../../extensions/foundation/CalloutExtension';
import { SlashMenuPopover, SlashMenuRef } from '../../components/menus/SlashMenuPopover';
import { BubbleMenu } from '../../components/menus/BubbleMenu';
import { DefaultMarkdownService } from '../../services/io/markdownService';
import type { SlashCommandItem } from '../../types/editor';

function createFullEditor(content: string = ''): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);

  return new Editor({
    element: container,
    extensions: getFoundationExtensions(),
    content,
  });
}

function destroyFullEditor(editor: Editor): void {
  const element = editor.options.element;
  editor.destroy();
  if (element && element.parentNode) {
    element.parentNode.removeChild(element);
  }
}

describe('Challenger M1 Edge-Case & Stress-Testing Suite', () => {
  let editor: Editor;
  const markdownService = new DefaultMarkdownService();

  afterEach(() => {
    cleanup();
    if (editor) {
      destroyFullEditor(editor);
    }
  });

  /* -------------------------------------------------------------------- */
  /* 1. Callout Block Custom Icons & Tints                                */
  /* -------------------------------------------------------------------- */
  describe('1. Callout Block Custom Icons & Custom Tints', () => {
    it('1.1 should render standard callout icons for warning, note, info, tip', () => {
      expect(CALLOUT_ICONS.warning).toBe('⚠️');
      expect(CALLOUT_ICONS.note).toBe('💡');
      expect(CALLOUT_ICONS.info).toBe('ℹ️');
      expect(CALLOUT_ICONS.tip).toBe('🚀');
    });

    it('1.2 should support inserting callout with custom icon attribute in AST', () => {
      editor = createFullEditor();
      editor.commands.insertContent({
        type: 'callout',
        attrs: { type: 'warning', icon: '🔥' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Custom flame callout' }] }],
      });

      const json = editor.getJSON();
      const calloutNode = json.content?.find((n) => n.type === 'callout');
      expect(calloutNode).toBeDefined();
      expect(calloutNode?.attrs?.type).toBe('warning');
      expect(calloutNode?.attrs?.icon).toBe('🔥');
    });

    it('1.3 should render callout container with tint classes and data-callout-type attribute', () => {
      editor = createFullEditor('> [!WARNING]\n> High alert warning text');
      
      const calloutElement = editor.options.element.querySelector('.callout-block');
      expect(calloutElement).not.toBeNull();
      expect(calloutElement?.classList.contains('callout-warning')).toBe(true);
      expect(calloutElement?.getAttribute('data-callout-type')).toBe('warning');
    });

    it('1.4 should cycle callout attributes correctly across all callout types', () => {
      editor = createFullEditor('> [!INFO]\n> Cycling callout item');

      const calloutContainer = editor.options.element.querySelector('.callout-block');
      expect(calloutContainer?.getAttribute('data-callout-type')).toBe('info');

      // Update callout attributes sequentially (info -> note -> warning -> tip -> info)
      editor.commands.updateAttributes('callout', { type: 'note', icon: '💡' });
      expect(editor.getJSON().content?.[0].attrs?.type).toBe('note');
      expect(editor.getJSON().content?.[0].attrs?.icon).toBe('💡');

      editor.commands.updateAttributes('callout', { type: 'warning', icon: '⚠️' });
      expect(editor.getJSON().content?.[0].attrs?.type).toBe('warning');
      expect(editor.getJSON().content?.[0].attrs?.icon).toBe('⚠️');

      editor.commands.updateAttributes('callout', { type: 'tip', icon: '🚀' });
      expect(editor.getJSON().content?.[0].attrs?.type).toBe('tip');
      expect(editor.getJSON().content?.[0].attrs?.icon).toBe('🚀');

      editor.commands.updateAttributes('callout', { type: 'info', icon: 'ℹ️' });
      expect(editor.getJSON().content?.[0].attrs?.type).toBe('info');
      expect(editor.getJSON().content?.[0].attrs?.icon).toBe('ℹ️');
    });
  });

  /* -------------------------------------------------------------------- */
  /* 2. Markdown AST Round-Trip Serialization for Task Lists and Callouts */
  /* -------------------------------------------------------------------- */
  describe('2. Markdown AST Round-Trip Serialization (Task Lists & Callouts)', () => {
    it('2.1 should perform case-insensitive callout parsing (> [!warning], > [!WARNING], > [!Note])', () => {
      const inputs = [
        { md: '> [!warning]\n> Warning text', expectedType: 'warning' },
        { md: '> [!WARNING]\n> Uppercase warning', expectedType: 'warning' },
        { md: '> [!Note]\n> Mixed case note', expectedType: 'note' },
        { md: '> [!tip]\n> Lowercase tip', expectedType: 'tip' },
        { md: '> [!INFO]\n> Uppercase info', expectedType: 'info' },
      ];

      inputs.forEach(({ md, expectedType }) => {
        const ast = markdownService.parseMarkdownToAST(md);
        const callout = ast.content?.[0];
        expect(callout?.type).toBe('callout');
        expect(callout?.attrs?.type).toBe(expectedType);
      });
    });

    it('2.2 should round-trip task lists (- [x] and - [ ]) losslessly with checked state integrity', () => {
      const mdInput = '- [x] Checked task item 1\n\n- [ ] Unchecked task item 2\n\n- [x] Checked task item 3';
      
      // Hop 1: MD -> AST
      const ast1 = markdownService.parseMarkdownToAST(mdInput);
      const items1 = ast1.content?.[0].content || [];
      expect(items1[0].attrs?.checked).toBe(true);
      expect(items1[1].attrs?.checked).toBe(false);
      expect(items1[2].attrs?.checked).toBe(true);

      // Hop 2: AST -> MD
      const mdOutput1 = markdownService.serializeASTToMarkdown(ast1);
      expect(mdOutput1).toContain('- [x] Checked task item 1');
      expect(mdOutput1).toContain('- [ ] Unchecked task item 2');
      expect(mdOutput1).toContain('- [x] Checked task item 3');

      // Hop 3: MD -> AST again
      const ast2 = markdownService.parseMarkdownToAST(mdOutput1);
      const items2 = ast2.content?.[0].content || [];
      expect(items2[0].attrs?.checked).toBe(true);
      expect(items2[1].attrs?.checked).toBe(false);
      expect(items2[2].attrs?.checked).toBe(true);
    });

    it('2.3 should parse uppercase - [X] as checked task item', () => {
      const mdInput = '- [X] Task with uppercase X';
      const ast = markdownService.parseMarkdownToAST(mdInput);
      const item = ast.content?.[0].content?.[0];
      expect(item?.type).toBe('taskItem');
      expect(item?.attrs?.checked).toBe(true);
    });

    it('2.4 should round-trip multiline callouts containing formatted text', () => {
      const mdInput = '> [!WARNING]\n> Important alert with **bold**, *italic*, and `inline code`';
      const ast1 = markdownService.parseMarkdownToAST(mdInput);
      
      const serialized = markdownService.serializeASTToMarkdown(ast1);
      expect(serialized).toContain('> [!WARNING]');
      expect(serialized).toContain('**bold**');
      expect(serialized).toContain('*italic*');
      expect(serialized).toContain('`inline code`');

      const ast2 = markdownService.parseMarkdownToAST(serialized);
      expect(ast2.content?.[0].type).toBe('callout');
      expect(ast2.content?.[0].attrs?.type).toBe('warning');
    });

    it('2.5 should handle invalid callout syntax (> [!INVALID]) by falling back gracefully', () => {
      const mdInput = '> [!INVALID]\n> Not a valid callout type';
      const ast = markdownService.parseMarkdownToAST(mdInput);
      expect(ast.content?.[0].type).toBeDefined();
    });
  });

  /* -------------------------------------------------------------------- */
  /* 3. Contextual Bubble Menu & Popover Triggers                        */
  /* -------------------------------------------------------------------- */
  describe('3. Contextual Bubble Menu Popovers & Selection Controls', () => {
    it('3.1 should render BubbleMenu toolbar buttons when text is selected in editor', async () => {
      editor = createFullEditor('Selectable text content');

      render(<BubbleMenu editor={editor} />);

      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 10 });
        editor.commands.focus();
      });

      const toolbar = await screen.findByRole('toolbar', { name: '文本格式化浮动菜单' });
      expect(toolbar).toBeInTheDocument();

      const boldBtn = screen.getByRole('button', { name: '加粗' });
      const italicBtn = screen.getByRole('button', { name: '斜体' });
      const strikeBtn = screen.getByRole('button', { name: '删除线' });
      const underlineBtn = screen.getByRole('button', { name: '下划线' });
      const codeBtn = screen.getByRole('button', { name: '行内代码' });
      const paletteBtn = screen.getByRole('button', { name: '调色盘' });

      expect(boldBtn).toBeInTheDocument();
      expect(italicBtn).toBeInTheDocument();
      expect(strikeBtn).toBeInTheDocument();
      expect(underlineBtn).toBeInTheDocument();
      expect(codeBtn).toBeInTheDocument();
      expect(paletteBtn).toBeInTheDocument();
    });

    it('3.2 should toggle bold formatting mark when bold button clicked', async () => {
      editor = createFullEditor('Hello World');

      render(<BubbleMenu editor={editor} />);

      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 });
        editor.commands.focus();
      });

      const boldBtn = await screen.findByRole('button', { name: '加粗' });
      
      act(() => {
        fireEvent.click(boldBtn);
      });

      const json = editor.getJSON();
      const textNode = json.content?.[0].content?.[0];
      expect(textNode?.marks).toContainEqual(expect.objectContaining({ type: 'bold' }));
    });

    it('3.3 should toggle ColorPickerPopover popover on palette button click', async () => {
      editor = createFullEditor('Text for color picker');

      render(<BubbleMenu editor={editor} />);

      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 5 });
        editor.commands.focus();
      });

      const paletteBtn = await screen.findByRole('button', { name: '调色盘' });
      expect(screen.queryByRole('dialog', { name: '颜色选择器' })).not.toBeInTheDocument();

      act(() => {
        fireEvent.click(paletteBtn);
      });

      const colorDialog = screen.getByRole('dialog', { name: '颜色选择器' });
      expect(colorDialog).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '文本颜色' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '背景高亮' })).toBeInTheDocument();

      act(() => {
        fireEvent.click(paletteBtn);
      });
      expect(screen.queryByRole('dialog', { name: '颜色选择器' })).not.toBeInTheDocument();
    });
  });

  /* -------------------------------------------------------------------- */
  /* 4. Slash Command Menu Keyboard Events                               */
  /* -------------------------------------------------------------------- */
  describe('4. Slash Command Menu Keyboard Navigation (ArrowUp, ArrowDown, Enter, Escape)', () => {
    const mockItems: SlashCommandItem[] = [
      {
        id: 'h1',
        title: 'H1 Title',
        description: 'Heading 1',
        iconName: 'Heading1',
        category: 'basic',
        command: vi.fn(),
      },
      {
        id: 'h2',
        title: 'H2 Title',
        description: 'Heading 2',
        iconName: 'Heading2',
        category: 'basic',
        command: vi.fn(),
      },
      {
        id: 'task-list',
        title: 'Task List',
        description: 'Task List',
        iconName: 'CheckSquare',
        category: 'lists',
        command: vi.fn(),
      },
    ];

    it('4.1 should render slash menu items with initial index 0 selected', () => {
      const commandMock = vi.fn();
      render(<SlashMenuPopover items={mockItems} command={commandMock} />);

      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(3);
      expect(buttons[0].classList.contains('is-selected')).toBe(true);
      expect(buttons[1].classList.contains('is-selected')).toBe(false);
    });

    it('4.2 should navigate selection index down on ArrowDown and wrap around', () => {
      const commandMock = vi.fn();
      const ref = React.createRef<SlashMenuRef>();

      render(<SlashMenuPopover ref={ref} items={mockItems} command={commandMock} />);

      const buttons = screen.getAllByRole('button');
      expect(buttons[0].classList.contains('is-selected')).toBe(true);

      // Press ArrowDown -> index 1
      act(() => {
        const handled = ref.current?.onKeyDown({
          event: new KeyboardEvent('keydown', { key: 'ArrowDown' }),
        });
        expect(handled).toBe(true);
      });
      expect(buttons[1].classList.contains('is-selected')).toBe(true);

      // Press ArrowDown -> index 2
      act(() => {
        ref.current?.onKeyDown({
          event: new KeyboardEvent('keydown', { key: 'ArrowDown' }),
        });
      });
      expect(buttons[2].classList.contains('is-selected')).toBe(true);

      // Press ArrowDown -> wrap around to index 0
      act(() => {
        ref.current?.onKeyDown({
          event: new KeyboardEvent('keydown', { key: 'ArrowDown' }),
        });
      });
      expect(buttons[0].classList.contains('is-selected')).toBe(true);
    });

    it('4.3 should navigate selection index up on ArrowUp and wrap around backwards', () => {
      const commandMock = vi.fn();
      const ref = React.createRef<SlashMenuRef>();

      render(<SlashMenuPopover ref={ref} items={mockItems} command={commandMock} />);

      const buttons = screen.getAllByRole('button');

      // Press ArrowUp -> wrap around to last item (index 2)
      act(() => {
        const handled = ref.current?.onKeyDown({
          event: new KeyboardEvent('keydown', { key: 'ArrowUp' }),
        });
        expect(handled).toBe(true);
      });
      expect(buttons[2].classList.contains('is-selected')).toBe(true);

      // Press ArrowUp -> index 1
      act(() => {
        ref.current?.onKeyDown({
          event: new KeyboardEvent('keydown', { key: 'ArrowUp' }),
        });
      });
      expect(buttons[1].classList.contains('is-selected')).toBe(true);
    });

    it('4.4 should trigger command callback on Enter key without form submission', () => {
      const commandMock = vi.fn();
      const ref = React.createRef<SlashMenuRef>();

      render(<SlashMenuPopover ref={ref} items={mockItems} command={commandMock} />);

      const mockEvent = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      const preventDefaultSpy = vi.spyOn(mockEvent, 'preventDefault');
      const stopPropagationSpy = vi.spyOn(mockEvent, 'stopPropagation');

      act(() => {
        const handled = ref.current?.onKeyDown({ event: mockEvent });
        expect(handled).toBe(true);
      });

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(commandMock).toHaveBeenCalledWith(mockItems[0]);
    });

    it('4.5 should handle empty search results gracefully', () => {
      render(<SlashMenuPopover items={[]} command={vi.fn()} />);
      expect(screen.getByText('无匹配命令')).toBeInTheDocument();
    });
  });

  /* -------------------------------------------------------------------- */
  /* 5. Drag Handle DOM Structure Verification                           */
  /* -------------------------------------------------------------------- */
  describe('5. Block Drag-and-Drop Handle DOM Structure', () => {

    it('5.1 should register GlobalDragHandle extension in Tiptap editor', () => {
      editor = createFullEditor('Paragraph for drag handle check');

      const dragHandleExt = editor.extensionManager.extensions.find(
        (ext) => ext.name === 'globalDragHandle'
      );
      expect(dragHandleExt).toBeDefined();
      expect(dragHandleExt?.options.dragHandleWidth).toBe(24);
      expect(dragHandleExt?.options.scrollTreshold).toBe(100);
    });

    it('5.2 should render drag-handle element in editor DOM container', () => {
      editor = createFullEditor('Content inside canvas');
      const dragHandleNode = editor.options.element.parentNode?.querySelector('.drag-handle');
      expect(dragHandleNode).not.toBeNull();
      expect(dragHandleNode?.getAttribute('draggable')).toBe('true');
      expect(dragHandleNode?.getAttribute('data-drag-handle')).toBe('');
    });
  });
});
