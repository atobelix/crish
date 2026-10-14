// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExtensionsCatalogGrid } from './ExtensionsCatalogGrid';
import type { UnifiedExtensionItem } from './buildUnifiedItems';

describe('ExtensionsCatalogGrid', () => {
  const dummyInstalledItem: UnifiedExtensionItem = {
    id: 'plugin-installed-1',
    kind: 'plugin',
    scope: 'both',
    name: '代码审计助手',
    description: '自动化审查代码健康度',
    icon: 'shield-check',
    isOfficial: true,
    isEnabled: true,
    isInstalled: true,
    nativeItem: {
      id: 'plugin-installed-1',
      kind: 'plugin',
      source: 'official',
      name: '代码审计助手',
      description: '自动化审查代码健康度',
    },
  };

  const dummyUninstalledItem: UnifiedExtensionItem = {
    id: 'plugin-uninstalled-2',
    kind: 'plugin',
    scope: 'catalog',
    name: '文档生成插件',
    description: '自动提取上下文并生成文档',
    icon: 'file-text',
    isOfficial: false,
    isEnabled: false,
    isInstalled: false,
    nativeItem: {
      id: 'plugin-uninstalled-2',
      kind: 'plugin',
      source: 'community',
      name: '文档生成插件',
      description: '自动提取上下文并生成文档',
      installRef: 'npm:@conex/doc-generator',
    },
  };

  it('renders header title and description based on sidebarNav and categoryFilter', () => {
    const { rerender } = render(
      <ExtensionsCatalogGrid
        catalogItems={[]}
        sidebarNav="explore"
        categoryFilter="plugins"
        searchQuery=""
        busyId={null}
        onSelectDetail={vi.fn()}
        onInstall={vi.fn()}
      />
    );

    expect(screen.getByText('发现生态')).toBeInTheDocument();
    expect(
      screen.getByText('浏览并一键配置社区与官方扩展插件')
    ).toBeInTheDocument();
    expect(screen.getByText('当前分类下暂无发现条目')).toBeInTheDocument();

    rerender(
      <ExtensionsCatalogGrid
        catalogItems={[]}
        sidebarNav="featured"
        categoryFilter="skills"
        searchQuery="test query"
        busyId={null}
        onSelectDetail={vi.fn()}
        onInstall={vi.fn()}
      />
    );

    expect(screen.getByText('精选推荐')).toBeInTheDocument();
    expect(
      screen.getByText('发现预设提示词工作流与专业技能包')
    ).toBeInTheDocument();
    expect(screen.getByText('未找到匹配搜索条件的扩展')).toBeInTheDocument();
  });

  it('renders calm 已安装 tag for installed plugins and invokes onSelectDetail when clicked', () => {
    const onSelectDetail = vi.fn();
    const onInstall = vi.fn();

    render(
      <ExtensionsCatalogGrid
        catalogItems={[dummyInstalledItem]}
        sidebarNav="explore"
        categoryFilter="plugins"
        searchQuery=""
        busyId={null}
        onSelectDetail={onSelectDetail}
        onInstall={onInstall}
      />
    );

    expect(screen.getByText('代码审计助手')).toBeInTheDocument();
    expect(screen.getByText('自动化审查代码健康度')).toBeInTheDocument();
    expect(screen.getByText('官方')).toBeInTheDocument();

    const installedTag = screen.getByLabelText('代码审计助手 已安装');
    expect(installedTag).toBeInTheDocument();
    expect(installedTag).toHaveTextContent('已安装');

    // Does not render install button
    expect(
      screen.queryByRole('button', { name: /安装 代码审计助手/ })
    ).not.toBeInTheDocument();

    fireEvent.click(installedTag);
    expect(onSelectDetail).toHaveBeenCalledWith(dummyInstalledItem.nativeItem);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it('renders 安装 button for uninstalled plugins and invokes onInstall when clicked', () => {
    const onSelectDetail = vi.fn();
    const onInstall = vi.fn();

    render(
      <ExtensionsCatalogGrid
        catalogItems={[dummyUninstalledItem]}
        sidebarNav="explore"
        categoryFilter="plugins"
        searchQuery=""
        busyId={null}
        onSelectDetail={onSelectDetail}
        onInstall={onInstall}
      />
    );

    expect(screen.getByText('文档生成插件')).toBeInTheDocument();
    expect(screen.getByText('精选')).toBeInTheDocument();

    // Does not render installed label
    expect(screen.queryByLabelText(/已安装/)).not.toBeInTheDocument();

    const installBtn = screen.getByRole('button', {
      name: '安装 文档生成插件',
    });
    expect(installBtn).toBeInTheDocument();

    fireEvent.click(installBtn);
    expect(onInstall).toHaveBeenCalledWith(dummyUninstalledItem);
    // Clicking action button does not trigger card detail click due to stopPropagation
    expect(onSelectDetail).not.toHaveBeenCalled();
  });

  it('disables install button and shows spinning icon when busyId matches', () => {
    render(
      <ExtensionsCatalogGrid
        catalogItems={[dummyUninstalledItem]}
        sidebarNav="explore"
        categoryFilter="plugins"
        searchQuery=""
        busyId={dummyUninstalledItem.id}
        onSelectDetail={vi.fn()}
        onInstall={vi.fn()}
      />
    );

    const installBtn = screen.getByRole('button', {
      name: '安装 文档生成插件',
    });
    expect(installBtn).toBeDisabled();
  });

  it('invokes onSelectDetail when card is clicked or activated with keyboard', () => {
    const onSelectDetail = vi.fn();

    render(
      <ExtensionsCatalogGrid
        catalogItems={[dummyUninstalledItem]}
        sidebarNav="explore"
        categoryFilter="plugins"
        searchQuery=""
        busyId={null}
        onSelectDetail={onSelectDetail}
        onInstall={vi.fn()}
      />
    );

    const card = screen.getByText('文档生成插件').closest('[role="button"]')!;
    expect(card).toBeInTheDocument();

    fireEvent.click(card);
    expect(onSelectDetail).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onSelectDetail).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(card, { key: ' ' });
    expect(onSelectDetail).toHaveBeenCalledTimes(3);
  });
});
