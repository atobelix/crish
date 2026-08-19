/**
 * @@ 目录树：真 listDirectory 数据源；点文件插入 mention；无假 src/components DOM。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposerDirTree } from './ComposerDirTree';

const listDirectory = vi.fn();
const getWorkspacePath = vi.fn(() => '/ws');

vi.mock('../../api/workspaceFsApi', () => ({
  getWorkspacePath: () => getWorkspacePath(),
  listDirectory: (...args: unknown[]) => listDirectory(...args),
}));

function fakeRect() {
  return {
    top: 80,
    left: 40,
    width: 12,
    height: 16,
    bottom: 96,
    right: 52,
    x: 40,
    y: 80,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('ComposerDirTree（S4 @@ 树）', () => {
  beforeEach(() => {
    getWorkspacePath.mockReturnValue('/ws');
    listDirectory.mockReset();
    listDirectory.mockResolvedValue([
      { name: 'src', isDir: true, path: '/ws/src' },
      { name: 'README.md', isDir: false, path: '/ws/README.md' },
    ]);
  });

  it('列出工作区目录，点文件插入 mention', async () => {
    const run = vi.fn();
    const insertContent = vi.fn(() => ({ run }));
    const api: {
      deleteRange: ReturnType<typeof vi.fn>;
      insertContent: typeof insertContent;
    } = {
      deleteRange: vi.fn(),
      insertContent,
    };
    api.deleteRange.mockImplementation(() => api);
    const editor = {
      chain: () => ({
        focus: () => api,
      }),
      view: { dom: document.createElement('div') },
    };
    const onClose = vi.fn();
    render(
      <ComposerDirTree
        items={[]}
        command={() => undefined}
        editor={editor}
        range={{ from: 1, to: 3 }}
        isOpen
        onClose={onClose}
        clientRect={fakeRect}
      />
    );
    const tree = await screen.findByTestId('composer-dir-tree');
    expect(tree.getAttribute('role')).toBe('tree');
    expect(tree.textContent).not.toContain('src/components/');
    await screen.findByRole('treeitem', { name: /README.md/ });
    fireEvent.click(screen.getByRole('treeitem', { name: /README.md/ }));
    expect(insertContent).toHaveBeenCalled();
    const payload = insertContent.mock.calls[0][0] as Array<{
      type?: string;
      attrs?: { id?: string; kind?: string };
    }>;
    expect(payload[0]?.type).toBe('mention');
    expect(payload[0]?.attrs?.id).toBe('/ws/README.md');
    expect(payload[0]?.attrs?.kind).toBe('file');
    expect(onClose).toHaveBeenCalled();
  });

  it('无工作区时诚实空态，不造假树', async () => {
    getWorkspacePath.mockReturnValue('');
    render(
      <ComposerDirTree
        items={[]}
        command={() => undefined}
        editor={{ view: { dom: document.createElement('div') } }}
        range={{ from: 0, to: 0 }}
        isOpen
        onClose={() => undefined}
        clientRect={fakeRect}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('composer-dir-tree').textContent).toContain(
        '未打开项目工作区'
      );
    });
    expect(listDirectory).not.toHaveBeenCalled();
  });
});
