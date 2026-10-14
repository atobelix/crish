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

  describe('external platform adaptation (Claude Code / Codex / Antigravity / Cursor)', () => {
    it('adapts Antigravity skill and MCP with sparkles icon and Antigravity source', () => {
      const antigravitySkill: DesktopSkill = {
        id: 'agy-cleanup',
        name: 'disk-cleanup',
        description: '',
        filePath: '/home/user/.gemini/antigravity/skills/disk-cleanup/SKILL.md',
        activation: 'enabled',
        system: false,
      };
      const antigravityMcp: McpServer = {
        id: 'agy-mcp',
        name: 'antigravity-crawler',
        type: 'stdio',
        status: 'connected',
        tools: [],
      };

      const items = buildUnifiedItems({
        skills: [antigravitySkill],
        mcpServers: [],
        settingsMcpServers: [antigravityMcp],
        installed: [],
        catalogInstalled: new Set(),
      });

      const skillItem = items.find((i) => i.name === 'disk-cleanup');
      expect(skillItem).toBeDefined();
      expect(skillItem?.source).toBe('Antigravity');
      expect(skillItem?.icon).toBe('sparkles');
      expect(skillItem?.description).toContain('来自 Antigravity 的');

      const mcpItem = items.find((i) => i.name === 'antigravity-crawler');
      expect(mcpItem).toBeDefined();
      expect(mcpItem?.source).toBe('Antigravity');
      expect(mcpItem?.icon).toBe('sparkles');
      expect(mcpItem?.description).toBe('来自 Antigravity 的 MCP 服务');
    });

    it('adapts Claude Code skill and MCP with bot icon and Claude Code source', () => {
      const claudeSkill: DesktopSkill = {
        id: 'claude-skill',
        name: 'claude-analyzer',
        description: '',
        filePath: '/home/user/.claude/skills/analyzer.md',
        activation: 'enabled',
        system: false,
      };
      const claudeMcp: McpServer = {
        id: 'claude-mcp',
        name: 'claude-code-helper',
        type: 'stdio',
        source: 'Claude Code',
        status: 'connected',
        tools: ['search_docs'],
      };

      const items = buildUnifiedItems({
        skills: [claudeSkill],
        mcpServers: [],
        settingsMcpServers: [claudeMcp],
        installed: [],
        catalogInstalled: new Set(),
      });

      const skillItem = items.find((i) => i.name === 'claude-analyzer');
      expect(skillItem).toBeDefined();
      expect(skillItem?.source).toBe('Claude Code');
      expect(skillItem?.icon).toBe('bot');
      expect(skillItem?.description).toContain('来自 Claude Code 的');

      const mcpItem = items.find((i) => i.name === 'claude-code-helper');
      expect(mcpItem).toBeDefined();
      expect(mcpItem?.source).toBe('Claude Code');
      expect(mcpItem?.icon).toBe('bot');
      expect(mcpItem?.description).toBe('1 个可用工具');
    });

    it('adapts Codex skill and MCP with terminal icon and Codex source', () => {
      const codexSkill: DesktopSkill = {
        id: 'codex-skill',
        name: 'codex-test-runner',
        description: '',
        filePath: '/home/user/.codex/skills/runner.md',
        activation: 'enabled',
        system: false,
      };
      const codexMcp: McpServerInfo = {
        id: 'mcp-codex',
        name: 'codex-eval',
        source: 'Codex',
        state: 'ready',
        status: 'connected',
        tools: [],
      };

      const items = buildUnifiedItems({
        skills: [codexSkill],
        mcpServers: [codexMcp],
        installed: [],
        catalogInstalled: new Set(),
      });

      const skillItem = items.find((i) => i.name === 'codex-test-runner');
      expect(skillItem).toBeDefined();
      expect(skillItem?.source).toBe('Codex');
      expect(skillItem?.icon).toBe('terminal');
      expect(skillItem?.description).toContain('来自 Codex 的');

      const mcpItem = items.find((i) => i.name === 'codex-eval');
      expect(mcpItem).toBeDefined();
      expect(mcpItem?.source).toBe('Codex');
      expect(mcpItem?.icon).toBe('terminal');
      expect(mcpItem?.description).toBe('来自 Codex 的 MCP 服务');
    });

    it('adapts Cursor skill and MCP with code icon and Cursor source', () => {
      const cursorSkill: DesktopSkill = {
        id: 'cursor-skill',
        name: 'cursor-navigation',
        description: '精准跳转源码定义',
        filePath: '/home/user/.cursor/skills/nav.md',
        activation: 'enabled',
        system: false,
      };
      const cursorMcp: McpServer = {
        id: 'cursor-mcp',
        name: 'cursor-lens',
        type: 'stdio',
        source: 'Cursor',
        status: 'connected',
        tools: ['lens_symbol'],
      };

      const items = buildUnifiedItems({
        skills: [cursorSkill],
        mcpServers: [],
        settingsMcpServers: [cursorMcp],
        installed: [],
        catalogInstalled: new Set(),
      });

      const skillItem = items.find((i) => i.name === 'cursor-navigation');
      expect(skillItem).toBeDefined();
      expect(skillItem?.source).toBe('Cursor');
      expect(skillItem?.icon).toBe('code');
      // Preserves existing explicit description
      expect(skillItem?.description).toBe('精准跳转源码定义');

      const mcpItem = items.find((i) => i.name === 'cursor-lens');
      expect(mcpItem).toBeDefined();
      expect(mcpItem?.source).toBe('Cursor');
      expect(mcpItem?.icon).toBe('code');
      expect(mcpItem?.description).toBe('1 个可用工具');
    });

    it('supports customPlugins parameter with platform adaptation and deduplication', () => {
      const items = buildUnifiedItems({
        skills: [],
        mcpServers: [],
        installed: [],
        catalogInstalled: new Set(),
        customPlugins: [
          {
            id: 'cursor-plugin-1',
            name: 'Cursor Quick Fix',
            version: '1.2.0',
            description: '快速自动修复代码问题',
            type: 'custom',
            createdAt: Date.now(),
          },
        ],
      });

      const pluginItem = items.find(
        (i) => i.id === 'custom-plugin:cursor-plugin-1'
      );
      expect(pluginItem).toBeDefined();
      expect(pluginItem?.source).toBe('Cursor');
      expect(pluginItem?.icon).toBe('code');
      expect(pluginItem?.description).toBe('快速自动修复代码问题');
    });
  });

  describe('catalog and market shelf integration', () => {
    it('always provides catalogEntry and scope for canonical import plugin when installed', () => {
      const items = buildUnifiedItems({
        skills: [],
        mcpServers: [],
        installed: [],
        catalogInstalled: new Set(),
      });

      const importItem = items.find(
        (i) => i.id === '@crish/plugin-import-claude-codex'
      );
      expect(importItem).toBeDefined();
      expect(importItem?.scope).toBe('both');
      expect(importItem?.isInstalled).toBe(true);
      expect(importItem?.catalogEntry).toBeDefined();
      expect(importItem?.catalogEntry?.name).toBe('外部历史对话接续与导入');
    });

    it('marks canonical import plugin as catalog with isInstalled: false when uninstalled', () => {
      localStorage.setItem(
        'crish_official_plugins_uninstalled_v1',
        JSON.stringify(['@crish/plugin-import-claude-codex'])
      );

      const items = buildUnifiedItems({
        skills: [],
        mcpServers: [],
        installed: [],
        catalogInstalled: new Set(),
      });

      const importItem = items.find(
        (i) => i.id === '@crish/plugin-import-claude-codex'
      );
      expect(importItem).toBeDefined();
      expect(importItem?.scope).toBe('catalog');
      expect(importItem?.isInstalled).toBe(false);
      expect(importItem?.isEnabled).toBe(false);
      expect(importItem?.catalogEntry).toBeDefined();

      localStorage.removeItem('crish_official_plugins_uninstalled_v1');
    });
  });
});
