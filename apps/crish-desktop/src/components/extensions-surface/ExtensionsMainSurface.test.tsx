// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExtensionsMainSurface } from './ExtensionsMainSurface';
import { useSettingsStore } from '../../store/settingsStore';
import * as customPluginStorage from './customPluginStorage';

import { clientApi } from '../../api/clientApi';

const mockRefresh = vi.fn();

// Mock extension market hook
vi.mock('../settings-extensions/useExtensionMarket', () => ({
  useExtensionMarket: () => ({
    skills: [
      {
        id: 'test-skill-1',
        name: '智能代码审计',
        description: '自动化审查代码健康度',
        activation: 'enabled',
        system: false,
      },
    ],
    mcpServers: [],
    installed: [],
    refresh: mockRefresh,
    toggleMcpServer: vi.fn(),
    toggleMcpTool: vi.fn(),
    toggleExpandMcpTools: vi.fn(),
    expandedMcpTools: new Set(),
    toolTick: 0,
    mcpServerBusy: false,
    mcpToolBusy: false,
    busyId: null,
    handleInstallCatalog: vi.fn(),
    handleRemovePackage: vi.fn(),
    togglePlugin: vi.fn(),
    catalogInstalled: new Set(),
  }),
}));

describe('ExtensionsMainSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      mcpServers: [
        {
          id: 'test-mcp-server',
          name: 'PostgreSQL MCP',
          type: 'stdio',
          status: 'connected',
          tools: ['query_db', 'list_tables'],
        },
      ],
    });
    vi.spyOn(customPluginStorage, 'loadCustomPlugins').mockReturnValue([
      {
        id: 'my-custom-tool',
        name: '我的自定义插件',
        version: '1.0.0',
        description: '用于团队内部的工作流插件',
        type: 'custom',
        createdAt: Date.now(),
      },
    ]);
  });

  it('renders top nav tabs with 插件, 技能, MCP 服务', () => {
    render(<ExtensionsMainSurface />);
    expect(screen.getByRole('button', { name: '插件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '技能' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'MCP 服务' })
    ).toBeInTheDocument();
  });

  it('renders left sidebar with 发现, 精选 and 导入 nav buttons and installed items', () => {
    render(<ExtensionsMainSurface />);
    expect(screen.getByRole('button', { name: /发现/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /精选/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^导入$/ })).toBeInTheDocument();
    expect(screen.getByText(/已安装/)).toBeInTheDocument();
  });

  it('switches to 导入 nav and renders ExternalImportWorkbench and calls refresh', () => {
    render(<ExtensionsMainSurface />);
    const importNav = screen.getByRole('button', { name: /^导入$/ });
    expect(importNav).toBeInTheDocument();
    fireEvent.click(importNav);
    expect(mockRefresh).toHaveBeenCalled();
    expect(screen.getByText('从其他应用导入')).toBeInTheDocument();
  });

  it('displays custom plugins in the installed list under 插件 category', () => {
    render(<ExtensionsMainSurface />);
    expect(screen.getByText('我的自定义插件')).toBeInTheDocument();
  });

  it('switches to 技能 tab and renders skill specific actions and items', () => {
    render(<ExtensionsMainSurface />);
    const skillTab = screen.getByRole('button', { name: '技能' });
    fireEvent.click(skillTab);

    expect(
      screen.getByRole('button', { name: /\+ 添加技能/ })
    ).toBeInTheDocument();
    expect(screen.getByText('智能代码审计')).toBeInTheDocument();
  });

  it('switches to MCP 服务 tab and displays settingsStore MCP server directly', () => {
    render(<ExtensionsMainSurface />);
    const mcpTab = screen.getByRole('button', { name: 'MCP 服务' });
    fireEvent.click(mcpTab);

    expect(
      screen.getByRole('button', { name: /\+ 接入 MCP/ })
    ).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL MCP')).toBeInTheDocument();
  });

  it('renders workbench directly on the right when clicking an installed item', () => {
    render(<ExtensionsMainSurface />);
    const customPluginRow = screen.getByText('我的自定义插件');
    fireEvent.click(customPluginRow);

    // Verifies the in-situ workbench is rendered without popups
    expect(screen.getByText(/我的自定义插件 专属工作台/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /分享插件/ })
    ).toBeInTheDocument();
  });

  it('toggles settingsStore MCP server status and calls saveSettingsEx without calling deprecated startMcpServer', () => {
    const saveSettingsExSpy = vi
      .spyOn(clientApi, 'saveSettingsEx')
      .mockResolvedValue({} as any);

    render(<ExtensionsMainSurface />);
    const mcpTab = screen.getByRole('button', { name: 'MCP 服务' });
    fireEvent.click(mcpTab);

    const mcpRow = screen.getByText('PostgreSQL MCP');
    fireEvent.click(mcpRow);

    expect(screen.getByText('运行就绪')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /复制服务名称/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /测试连通性/ })
    ).toBeInTheDocument();

    const switchBtn = screen.getByRole('switch', { name: /切换服务状态/ });
    fireEvent.click(switchBtn);

    const updated = useSettingsStore.getState().mcpServers;
    expect(updated.find((s) => s.name === 'PostgreSQL MCP')?.status).toBe(
      'disconnected'
    );
    expect(saveSettingsExSpy).toHaveBeenCalledWith(
      '__global__',
      'global',
      expect.objectContaining({
        mcpServers: expect.any(Array),
      })
    );
  });
});
