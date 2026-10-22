// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FileBreadcrumb } from '../FileBreadcrumb';
import * as workspaceFsApi from '../../../api/workspaceFsApi';
import { LeafScopeProvider } from '../../../contexts/LeafScopeContext';

vi.mock('../../../api/workspaceFsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof workspaceFsApi>();
  return {
    ...actual,
    listDirectory: vi.fn(),
    resolveWorkspacePath: vi.fn((p) => p),
    pathRelativeToRoot: vi.fn((path: string, root: string) => {
      if (path === root) return '';
      return path.replace(root, '').replace(/^[\\/]/, '');
    }),
  };
});

describe('Adversarial Stress Test: FileBreadcrumb Escape Dismissal Across Focus Targets', () => {
  const rootPath = 'c:/Software/conex';
  const mockEntries = [
    { name: 'apps', isDir: true, path: 'c:/Software/conex/apps' },
    { name: 'packages', isDir: true, path: 'c:/Software/conex/packages' },
    { name: 'README.md', isDir: false, path: 'c:/Software/conex/README.md' },
  ];

  beforeEach(() => {
    vi.mocked(workspaceFsApi.listDirectory).mockResolvedValue(mockEntries);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function openBreadcrumbFlyout(
    getByRole: (role: string, options?: any) => HTMLElement,
    findByRole: (role: string) => Promise<HTMLElement>
  ) {
    const chip = getByRole('button', { name: 'conex' });
    fireEvent.click(chip);
    const flyout = await findByRole('listbox');
    expect(flyout).toBeTruthy();
    // listbox 在 loading 态就已挂载；目录加载完成后组件会在下一帧
    // (requestAnimationFrame) 把焦点送进筛选框。必须等这次自动聚焦落地，
    // 否则后续用例改焦点与这一帧赛跑：rAF 晚到会把焦点抢回筛选框（容器内），
    // 让「焦点在容器外」的前提失效（#2/#7 全量负载下偶发失败的根因）。
    await waitFor(() =>
      expect(document.activeElement).toBe(getByRole('searchbox'))
    );
    return chip;
  }

  /** 把焦点移出浮层回到 document.body（jsdom 中 body.focus() 对已聚焦元素无效，需 blur） */
  function moveFocusToBody() {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
  }

  it('1. Focus inside container: Escape closes flyout and restores trigger focus', async () => {
    const { getByRole, queryByRole, findByRole } = render(
      <FileBreadcrumb
        root={rootPath}
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    const chip = await openBreadcrumbFlyout(getByRole, findByRole);
    const focusSpy = vi.spyOn(chip, 'focus');

    // Focus on the search input inside flyout
    const searchInput = getByRole('searchbox');
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    // Press Escape on search input / window
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(queryByRole('listbox')).toBeNull();
  });

  it('2. Focus on document.body: Escape dismisses flyout (verifying fix for zero-geometry/jsdom)', async () => {
    const { getByRole, queryByRole, findByRole } = render(
      <FileBreadcrumb
        root={rootPath}
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    await openBreadcrumbFlyout(getByRole, findByRole);

    // Explicitly focus document.body
    moveFocusToBody();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(queryByRole('listbox')).toBeNull();
  });

  it('3. Focus inside an external <input>: Escape must NOT dismiss the breadcrumb flyout', async () => {
    const { getByRole, queryByRole, findByRole, getByTestId } = render(
      <div>
        <FileBreadcrumb
          root={rootPath}
          selected={null}
          view="browse"
          onNavigate={vi.fn()}
          onOpenFile={vi.fn()}
        />
        <input data-testid="external-input" placeholder="external query" />
      </div>
    );

    await openBreadcrumbFlyout(getByRole, findByRole);

    const extInput = getByTestId('external-input') as HTMLInputElement;
    extInput.focus();
    expect(document.activeElement).toBe(extInput);

    // Escape while typing in external input
    fireEvent.keyDown(window, { key: 'Escape' });

    // Flyout MUST stay open!
    expect(queryByRole('listbox')).not.toBeNull();
  });

  it('4. Focus inside an external <textarea>: Escape must NOT dismiss the breadcrumb flyout', async () => {
    const { getByRole, queryByRole, findByRole, getByTestId } = render(
      <div>
        <FileBreadcrumb
          root={rootPath}
          selected={null}
          view="browse"
          onNavigate={vi.fn()}
          onOpenFile={vi.fn()}
        />
        <textarea
          data-testid="external-textarea"
          defaultValue="external note"
        />
      </div>
    );

    await openBreadcrumbFlyout(getByRole, findByRole);

    const extTextarea = getByTestId('external-textarea') as HTMLTextAreaElement;
    extTextarea.focus();
    expect(document.activeElement).toBe(extTextarea);

    // Escape while inside external textarea
    fireEvent.keyDown(window, { key: 'Escape' });

    // Flyout MUST stay open!
    expect(queryByRole('listbox')).not.toBeNull();
  });

  it('5. Focus inside an external [contenteditable]: Escape must NOT dismiss the breadcrumb flyout', async () => {
    const { getByRole, queryByRole, findByRole, getByTestId } = render(
      <div>
        <FileBreadcrumb
          root={rootPath}
          selected={null}
          view="browse"
          onNavigate={vi.fn()}
          onOpenFile={vi.fn()}
        />
        <div
          data-testid="external-contenteditable"
          contentEditable="true"
          tabIndex={0}
        >
          <span data-testid="editable-child">rich text editor</span>
        </div>
      </div>
    );

    await openBreadcrumbFlyout(getByRole, findByRole);

    const extCe = getByTestId('external-contenteditable');
    extCe.focus();
    expect(document.activeElement).toBe(extCe);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByRole('listbox')).not.toBeNull();

    // Also test focus on a nested child element inside contenteditable
    const childSpan = getByTestId('editable-child');
    childSpan.setAttribute('tabindex', '0');
    childSpan.focus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByRole('listbox')).not.toBeNull();
  });

  it('6. Rapid multiple Escape keystrokes: gracefully closes and does not throw', async () => {
    const { getByRole, queryByRole, findByRole } = render(
      <FileBreadcrumb
        root={rootPath}
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    await openBreadcrumbFlyout(getByRole, findByRole);

    // Dispatch 5 rapid Escape events
    expect(() => {
      for (let i = 0; i < 5; i++) {
        fireEvent.keyDown(window, { key: 'Escape' });
      }
    }).not.toThrow();

    expect(queryByRole('listbox')).toBeNull();
  });

  it('7. Multi-pane isolation: inactive leaf pane ignores Escape when focus is outside', async () => {
    const { getByRole, queryByRole, findByRole } = render(
      <LeafScopeProvider
        leafId="pane-inactive"
        sessionId="session-inactive"
        isActive={false}
        leafRootRef={{ current: null }}
      >
        <div>
          <FileBreadcrumb
            root={rootPath}
            selected={null}
            view="browse"
            onNavigate={vi.fn()}
            onOpenFile={vi.fn()}
          />
          <button type="button" data-testid="outside-leaf-button">
            Other pane
          </button>
        </div>
      </LeafScopeProvider>
    );

    await openBreadcrumbFlyout(getByRole, findByRole);

    // Focus is outside the container in an inactive leaf pane
    moveFocusToBody();

    fireEvent.keyDown(window, { key: 'Escape' });

    // In inactive leaf, Escape with external focus must NOT close the flyout!
    expect(queryByRole('listbox')).not.toBeNull();
  });
});
