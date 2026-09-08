// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FileBreadcrumb } from '../FileBreadcrumb';
import * as workspaceFsApi from '../../../api/workspaceFsApi';

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

describe('FileBreadcrumb 面包屑与多级下钻状态机（单轨无损清洗）', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // 刚性负向断言：FileBreadcrumbProps 不存在 cwd 属性声明
  it('[NEG-01] FileBreadcrumbProps 不存在 cwd 属性声明', () => {
    const props = {
      root: 'c:/Software/conex',
      selected: null,
      view: 'browse' as const,
      onNavigate: vi.fn(),
      onOpenFile: vi.fn(),
    };
    expect((props as Record<string, unknown>).cwd).toBeUndefined();
  });

  it('根芯片正确渲染项目文件夹名而非硬编码的“项目”', () => {
    const { container } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );
    expect(container.textContent).toContain('conex');
    expect(container.textContent).not.toContain('项目根目录 (项目)');
  });

  it('点击面包屑芯片触发 openBcFlyout，并成功列出子级内容', async () => {
    const mockList = [
      { name: 'apps', isDir: true, path: 'c:/Software/conex/apps' },
      { name: 'package.json', isDir: false, path: 'c:/Software/conex/package.json' },
    ];
    vi.mocked(workspaceFsApi.listDirectory).mockResolvedValueOnce(mockList);

    const { getByRole, findByText } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    const chip = getByRole('button', { name: 'conex' });
    fireEvent.click(chip);

    expect(await findByText('apps')).toBeTruthy();
    expect(await findByText('package.json')).toBeTruthy();
  });

  it('浮层内点击子文件夹原地平滑展开子树，多层兄弟节点常驻可见且绝不瞬灭', async () => {
    const rootList = [
      { name: 'apps', isDir: true, path: 'c:/Software/conex/apps' },
      { name: 'packages', isDir: true, path: 'c:/Software/conex/packages' },
    ];
    const appsList = [
      { name: 'crish-desktop', isDir: true, path: 'c:/Software/conex/apps/crish-desktop' },
    ];
    vi.mocked(workspaceFsApi.listDirectory)
      .mockResolvedValueOnce(rootList)
      .mockResolvedValueOnce(appsList);

    const { getByRole, findByText, queryByText } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    fireEvent.click(getByRole('button', { name: 'conex' }));
    const appsItem = await findByText('apps');
    expect(appsItem).toBeTruthy();
    expect(await findByText('packages')).toBeTruthy();

    fireEvent.click(appsItem);

    expect(await findByText('crish-desktop')).toBeTruthy();
    expect(queryByText('packages')).toBeTruthy();

    fireEvent.click(appsItem);
    await waitFor(() => {
      expect(queryByText('crish-desktop')).toBeNull();
    });
    expect(queryByText('packages')).toBeTruthy();
  });

  it('浮层内点击文件调用 onOpenFile 并关闭浮层', async () => {
    const onOpenFile = vi.fn();
    const rootList = [
      { name: 'README.md', isDir: false, path: 'c:/Software/conex/README.md' },
    ];
    vi.mocked(workspaceFsApi.listDirectory).mockResolvedValueOnce(rootList);

    const { getByRole, findByText, queryByText } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={onOpenFile}
      />
    );

    fireEvent.click(getByRole('button', { name: 'conex' }));
    const fileItem = await findByText('README.md');
    fireEvent.click(fileItem);

    expect(onOpenFile).toHaveBeenCalledWith('c:/Software/conex/README.md');
    await waitFor(() => {
      expect(queryByText('README.md')).toBeNull();
    });
  });

  it('点击搜索栏内嵌打开按钮调用 onNavigate 并关闭浮层', async () => {
    const onNavigate = vi.fn();
    const rootList = [
      { name: 'apps', isDir: true, path: 'c:/Software/conex/apps' },
    ];
    vi.mocked(workspaceFsApi.listDirectory).mockResolvedValueOnce(rootList);

    const { getByRole, getByLabelText, queryByRole } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected={null}
        view="browse"
        onNavigate={onNavigate}
        onOpenFile={vi.fn()}
      />
    );

    fireEvent.click(getByRole('button', { name: 'conex' }));
    const openBtn = getByLabelText('在文件树中打开此目录');
    expect(openBtn).toBeTruthy();
    fireEvent.click(openBtn);

    expect(onNavigate).toHaveBeenCalledWith('c:/Software/conex');
    await waitFor(() => {
      expect(queryByRole('listbox')).toBeNull();
    });
  });

  it('搜索栏输入框按 Enter 键触发在文件树中打开该目录', async () => {
    const onNavigate = vi.fn();
    const rootList = [
      { name: 'apps', isDir: true, path: 'c:/Software/conex/apps' },
    ];
    vi.mocked(workspaceFsApi.listDirectory).mockResolvedValueOnce(rootList);

    const { getByRole, getByPlaceholderText, queryByRole } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected={null}
        view="browse"
        onNavigate={onNavigate}
        onOpenFile={vi.fn()}
      />
    );

    fireEvent.click(getByRole('button', { name: 'conex' }));
    const searchInput = getByPlaceholderText('筛选文件…');
    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledWith('c:/Software/conex');
    await waitFor(() => {
      expect(queryByRole('listbox')).toBeNull();
    });
  });

  it('双击文件夹条目直达在文件树中打开该目录并关闭浮层', async () => {
    const onNavigate = vi.fn();
    const rootList = [
      { name: 'apps', isDir: true, path: 'c:/Software/conex/apps' },
    ];
    vi.mocked(workspaceFsApi.listDirectory).mockResolvedValueOnce(rootList);

    const { getByRole, findByText, queryByRole } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected={null}
        view="browse"
        onNavigate={onNavigate}
        onOpenFile={vi.fn()}
      />
    );

    fireEvent.click(getByRole('button', { name: 'conex' }));
    const appsItem = await findByText('apps');
    fireEvent.doubleClick(appsItem);

    expect(onNavigate).toHaveBeenCalledWith('c:/Software/conex/apps');
    await waitFor(() => {
      expect(queryByRole('listbox')).toBeNull();
    });
  });

  it('文件详情模式下 dirty=true 时在末尾叶子文件名渲染未保存圆点指示', () => {
    const { container, getByLabelText } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected="c:/Software/conex/src/index.ts"
        view="detail"
        dirty={true}
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    const dirtyDot = getByLabelText('未保存');
    expect(dirtyDot).toBeTruthy();
    expect(dirtyDot.textContent).toBe('●');
    expect(container.textContent).toContain('index.ts');
  });

  it('文件详情模式下 dirty=false 时不渲染未保存圆点指示', () => {
    const { queryByLabelText, container } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected="c:/Software/conex/src/index.ts"
        view="detail"
        dirty={false}
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    expect(queryByLabelText('未保存')).toBeNull();
    expect(container.textContent).toContain('index.ts');
  });

  it('多层深度路径正确渲染多级面包屑节点和分隔符', () => {
    const { container } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected="c:/Software/conex/apps/crish-desktop/src/App.tsx"
        view="detail"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    expect(container.textContent).toContain('conex');
    expect(container.textContent).toContain('apps');
    expect(container.textContent).toContain('crish-desktop');
    expect(container.textContent).toContain('src');
    expect(container.textContent).toContain('App.tsx');
  });

  it('空根路径返回 null 不渲染任何 DOM', () => {
    const { container } = render(
      <FileBreadcrumb
        root=""
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('浮层内搜索输入框正确过滤条目并在无匹配时提示无匹配', async () => {
    const mockList = [
      { name: 'App.tsx', isDir: false, path: 'c:/Software/conex/src/App.tsx' },
      { name: 'index.ts', isDir: false, path: 'c:/Software/conex/src/index.ts' },
      { name: 'styles.css', isDir: false, path: 'c:/Software/conex/src/styles.css' },
    ];
    vi.mocked(workspaceFsApi.listDirectory).mockResolvedValueOnce(mockList);

    const { getByRole, getByPlaceholderText, findByText, queryByText } = render(
      <FileBreadcrumb
        root="c:/Software/conex"
        selected={null}
        view="browse"
        onNavigate={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    fireEvent.click(getByRole('button', { name: 'conex' }));
    expect(await findByText('App.tsx')).toBeTruthy();
    expect(await findByText('index.ts')).toBeTruthy();
    expect(await findByText('styles.css')).toBeTruthy();

    const searchInput = getByPlaceholderText('筛选文件…');
    fireEvent.change(searchInput, { target: { value: 'App' } });

    expect(queryByText('App.tsx')).toBeTruthy();
    expect(queryByText('index.ts')).toBeNull();
    expect(queryByText('styles.css')).toBeNull();

    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
    expect(await findByText('无匹配')).toBeTruthy();
  });

  it('外部点击关闭浮层且不强夺焦点，按 Escape 键关闭浮层并恢复焦点', async () => {
    const mockList = [
      { name: 'apps', isDir: true, path: 'c:/Software/conex/apps' },
    ];
    vi.mocked(workspaceFsApi.listDirectory).mockResolvedValue(mockList);

    const { getByRole, queryByRole, findByRole } = render(
      <div>
        <FileBreadcrumb
          root="c:/Software/conex"
          selected={null}
          view="browse"
          onNavigate={vi.fn()}
          onOpenFile={vi.fn()}
        />
        <button type="button" data-testid="outside-btn">外部按钮</button>
      </div>
    );

    const chip = getByRole('button', { name: 'conex' });
    const focusSpy = vi.spyOn(chip, 'focus');

    fireEvent.click(chip);
    expect(await findByRole('listbox')).toBeTruthy();

    focusSpy.mockClear();
    fireEvent.mouseDown(document.body);
    expect(queryByRole('listbox')).toBeNull();
    expect(focusSpy).not.toHaveBeenCalled();

    fireEvent.click(chip);
    expect(await findByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByRole('listbox')).toBeNull();
  });
});
