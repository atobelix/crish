// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactNotebookSurface } from './ArtifactNotebookSurface';

vi.mock('../../components/chat-message-row/AsyncMarkdownBlock', () => ({
  AsyncMarkdownBlock: ({ text }: { text: string }) =>
    React.createElement('div', { 'data-testid': 'async-markdown-block' }, text),
}));

describe('ArtifactNotebookSurface', () => {
  it('阅读面走 AsyncMarkdownBlock，根不在 document.body', () => {
    const { container } = render(
      <ArtifactNotebookSurface
        title="纪要.md"
        content="# 标题"
        mime="markdown"
        pinned={false}
        onPin={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const root = container.querySelector('[data-flow-artifact-notebook="reading"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-notebook-host')).toBe('leaf-body');
    expect(container.querySelector('[data-artifact-md="async-markdown-block"]')).not.toBeNull();
    expect(screen.getByTestId('async-markdown-block').textContent).toBe('# 标题');
    expect(document.body.querySelector(':scope > [data-flow-artifact-notebook]')).toBeNull();
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('无 docId 不调 onOpenNote', () => {
    const onOpenNote = vi.fn();
    const { container } = render(
      <ArtifactNotebookSurface
        title="纪要.md"
        content="# x"
        mime="markdown"
        pinned
        onPin={vi.fn()}
        onClose={vi.fn()}
        onOpenNote={onOpenNote}
      />
    );
    expect(container.querySelector('[data-artifact-edit]')).toBeNull();
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it('有 docId 点编辑交给 onOpenNote', () => {
    const onOpenNote = vi.fn();
    render(
      <ArtifactNotebookSurface
        title="纪要.md"
        content="# x"
        mime="markdown"
        pinned
        docId="doc-exist"
        onPin={vi.fn()}
        onClose={vi.fn()}
        onOpenNote={onOpenNote}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(onOpenNote).toHaveBeenCalledWith('doc-exist');
  });
});
