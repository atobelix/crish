// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactChip } from './ArtifactChip';

vi.mock('../../components/chat-message-row/AsyncMarkdownBlock', () => ({
  AsyncMarkdownBlock: ({ text }: { text: string }) =>
    React.createElement('div', { 'data-testid': 'async-markdown-block' }, text),
}));

describe('ArtifactChip', () => {
  it('悬停打开阅读面，单击钉住；无原生 title；不走 onOpenPath', () => {
    const onOpenNote = vi.fn();
    const { container } = render(
      <ArtifactChip
        label="纪要.md"
        path="docs/纪要.md"
        content="# 纪要\n\n正文"
        onOpenNote={onOpenNote}
      />
    );
    const chip = screen.getByRole('button', { name: /已生成/ });
    expect(container.querySelector('[data-flow-artifact="document"]')).not.toBeNull();
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.querySelector('[data-flow-artifact-notebook]')).toBeNull();

    fireEvent.pointerEnter(container.querySelector('[data-flow-artifact-wrap]')!);
    const notebook = container.querySelector('[data-flow-artifact-notebook="reading"]');
    expect(notebook).not.toBeNull();
    expect(notebook?.getAttribute('data-notebook-host')).toBe('leaf-body');
    expect(notebook?.getAttribute('data-notebook-pinned')).toBe('false');
    expect(screen.getByTestId('async-markdown-block').textContent).toMatch(/纪要/);

    fireEvent.click(chip);
    expect(container.querySelector('[data-notebook-pinned="true"]')).not.toBeNull();
    expect(onOpenNote).not.toHaveBeenCalled();
    expect(document.body.querySelector(':scope > [data-flow-artifact-notebook]')).toBeNull();
  });

  it('无 docId 不出现编辑钮', () => {
    const onOpenNote = vi.fn();
    const { container } = render(
      <ArtifactChip label="纪要.md" content="# x" onOpenNote={onOpenNote} />
    );
    fireEvent.click(screen.getByRole('button', { name: /已生成/ }));
    expect(container.querySelector('[data-artifact-edit]')).toBeNull();
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it('已有 docId 点编辑才走 onOpenNote', () => {
    const onOpenNote = vi.fn();
    render(
      <ArtifactChip
        label="纪要.md"
        content="# x"
        docId="doc-exist"
        onOpenNote={onOpenNote}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /已生成/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(onOpenNote).toHaveBeenCalledWith('doc-exist');
  });
});
