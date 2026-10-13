import { describe, it, expect, beforeEach } from 'vitest';
import { buildUnifiedItems } from './buildUnifiedItems';
import { useSettingsStore } from '../../store/settingsStore';
import type { DesktopSkill } from '../../api/skillsApi';
import type { McpServerInfo } from '../../api/mcpApi';
import type { McpServer } from '../../api/clientApi';
import type { InstalledExtension } from '../../api/extensionCatalog';

describe('buildUnifiedItems', () => {
  const dummySkill: DesktopSkill = {
    id: 'skill-git',
    name: 'Git Helper',
    description: 'Git commands helper',
    filePath: '/path/to/SKILL.md',
    activation: 'enabled',
    system: false,
  };

  const dummyEngineMcp: McpServerInfo = {
    id: 'engine-sqlite',
    name: 'sqlite',
    state: 'ready',
    status: 'connected',
    tools: ['query', 'execute'],
  };

  beforeEach(() => {
    useSettingsStore.getState().setMcpServers([]);
  });

  it('correctly maps engine MCP servers into UnifiedExtensionItem', () => {
    const items = buildUnifiedItems({
      skills: [dummySkill],
      mcpServers: [dummyEngineMcp],
      installed: [],
      catalogInstalled: new Set(),
    });

    const mcpItem = items.find((i) => i.name === 'sqlite');
    expect(mcpItem).toBeDefined();
    expect(mcpItem?.id).toBe('local-mcp:engine-sqlite');
    expect(mcpItem?.kind).toBe('mcp');
    expect(mcpItem?.isEnabled).toBe(true);
    expect(mcpItem?.rawMcp?.tools).toEqual(['query', 'execute']);
  });

  it('merges settingsMcpServers and constructs valid UnifiedExtensionItem', () => {
    const customMcp: McpServer = {
      id: 'mcp-12345',
      name: 'filesystem',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      status: 'connected',
      tools: ['read_file', 'write_file'],
    };

    const items = buildUnifiedItems({
      skills: [],
      mcpServers: [],
      settingsMcpServers: [customMcp],
      installed: [],
      catalogInstalled: new Set(),
    });

    const mcpItem = items.find((i) => i.name === 'filesystem');
    expect(mcpItem).toBeDefined();
    expect(mcpItem?.id).toBe('local-mcp:filesystem');
    expect(mcpItem?.kind).toBe('mcp');
    expect(mcpItem?.scope).toBe('installed');
    expect(mcpItem?.isEnabled).toBe(true);
    expect(mcpItem?.description).toBe('2 个可用工具');
    expect(mcpItem?.rawMcp?.id).toBe('mcp-12345');
    expect(mcpItem?.rawMcp?.name).toBe('filesystem');
    expect(mcpItem?.rawMcp?.tools).toEqual(['read_file', 'write_file']);
    expect(mcpItem?.rawMcp?.state).toBe('running');
  });

  it('sets isEnabled to false when settingsMcp server status is disconnected', () => {
    const disconnectedMcp: McpServer = {
      id: 'mcp-999',
      name: 'github-api',
      type: 'stdio',
      status: 'disconnected',
      tools: [],
    };

    const items = buildUnifiedItems({
      skills: [],
      mcpServers: [],
      settingsMcpServers: [disconnectedMcp],
      installed: [],
      catalogInstalled: new Set(),
    });

    const mcpItem = items.find((i) => i.name === 'github-api');
    expect(mcpItem).toBeDefined();
    expect(mcpItem?.isEnabled).toBe(false);
    expect(mcpItem?.rawMcp?.state).toBe('stopped');
  });

  it('deduplicates when same MCP server exists in both mcpServers and settingsMcpServers', () => {
    const engineMcp: McpServerInfo = {
      id: 'mcp-fs',
      name: 'filesystem',
      state: 'ready',
      status: 'connected',
      tools: ['read_file'],
    };

    const settingMcp: McpServer = {
      id: 'mcp-fs',
      name: 'filesystem',
      type: 'stdio',
      status: 'connected',
      tools: ['read_file'],
    };

    const items = buildUnifiedItems({
      skills: [],
      mcpServers: [engineMcp],
      settingsMcpServers: [settingMcp],
      installed: [],
      catalogInstalled: new Set(),
    });

    const matching = items.filter((i) => i.name === 'filesystem');
    expect(matching).toHaveLength(1);
  });

  it('falls back to useSettingsStore when settingsMcpServers is not provided', () => {
    const storeMcp: McpServer = {
      id: 'mcp-store-1',
      name: 'slack-mcp',
      type: 'sse',
      status: 'connected',
      tools: ['post_message'],
    };
    useSettingsStore.getState().setMcpServers([storeMcp]);

    const items = buildUnifiedItems({
      skills: [],
      mcpServers: [],
      installed: [],
      catalogInstalled: new Set(),
    });

    const mcpItem = items.find((i) => i.name === 'slack-mcp');
    expect(mcpItem).toBeDefined();
    expect(mcpItem?.id).toBe('local-mcp:slack-mcp');
    expect(mcpItem?.isEnabled).toBe(true);
  });

  it('auto-injects known tools when tools array is empty', () => {
    const fetchMcp: McpServer = {
      id: 'mcp-fetch-1',
      name: 'fetch',
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      status: 'connected',
      tools: [],
    };

    const items = buildUnifiedItems({
      skills: [],
      mcpServers: [],
      settingsMcpServers: [fetchMcp],
      installed: [],
      catalogInstalled: new Set(),
    });

    const mcpItem = items.find((i) => i.name === 'fetch');
    expect(mcpItem).toBeDefined();
    expect(mcpItem?.isEnabled).toBe(true);
    expect(mcpItem?.rawMcp?.tools).toEqual(['fetch_url', 'download_content']);
    expect(mcpItem?.description).toBe('2 个可用工具');
  });

  it('upgrades chrome-devtools-mcp with historical 5 tools to full 30 tools', () => {
    const devtoolsLegacy: McpServer = {
      id: 'mcp-devtools',
      name: 'chrome-devtools-mcp',
      type: 'stdio',
      command: 'npx',
      args: ['chrome-devtools-mcp'],
      status: 'connected',
      tools: [
        'navigate_page',
        'click',
        'take_screenshot',
        'evaluate_script',
        'get_console_message',
      ],
    };

    const items = buildUnifiedItems({
      skills: [],
      mcpServers: [],
      settingsMcpServers: [devtoolsLegacy],
      installed: [],
      catalogInstalled: new Set(),
    });

    const mcpItem = items.find((i) => i.name === 'chrome-devtools-mcp');
    expect(mcpItem).toBeDefined();
    expect(mcpItem?.rawMcp?.tools).toHaveLength(30);
    expect(mcpItem?.description).toBe('30 个可用工具');
  });
});
