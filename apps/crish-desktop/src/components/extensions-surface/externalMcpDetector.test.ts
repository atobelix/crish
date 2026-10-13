// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectExternalMcpServers,
  DEFAULT_MOCK_SERVERS,
  type DetectedExternalMcpServer,
} from './externalMcpDetector';
import * as skillsApiFs from '../../api/skillsApiFs';

describe('externalMcpDetector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports valid DEFAULT_MOCK_SERVERS with 4 core Antigravity MCP tools', () => {
    expect(DEFAULT_MOCK_SERVERS).toHaveLength(4);
    const ids = DEFAULT_MOCK_SERVERS.map((s) => s.id);
    expect(ids).toContain('antigravity:chrome-devtools-mcp');
    expect(ids).toContain('antigravity:cua-driver');
    expect(ids).toContain('antigravity:tauri-mcp');
    expect(ids).toContain('antigravity:tauri-mcp-editor');

    for (const server of DEFAULT_MOCK_SERVERS) {
      expect(server.source).toBe('antigravity');
      expect(server.type).toBe('stdio');
      expect(typeof server.toolsCount).toBe('number');
      expect(server.toolsCount).toBeGreaterThan(0);
      expect(server.description).toBeDefined();
    }
  });

  it('returns DEFAULT_MOCK_SERVERS when no home directory or files exist', async () => {
    vi.spyOn(skillsApiFs, 'tryHomeDir').mockResolvedValue(null);
    const originalEnv = process.env;
    process.env = {};

    try {
      const servers = await detectExternalMcpServers();
      expect(servers).toEqual(DEFAULT_MOCK_SERVERS);
    } finally {
      process.env = originalEnv;
    }
  });

  it('detects Claude Desktop and Cursor mcp configs correctly', async () => {
    vi.spyOn(skillsApiFs, 'tryHomeDir').mockResolvedValue(
      'C:\\Users\\mockuser'
    );
    vi.spyOn(skillsApiFs, 'listDirAny').mockResolvedValue([]);

    const claudeJson = JSON.stringify({
      mcpServers: {
        'filesystem-server': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\'],
          env: { DEBUG: '1' },
        },
        'remote-sse': {
          url: 'http://localhost:3001/sse',
        },
      },
    });

    const cursorJson = JSON.stringify({
      mcpServers: {
        'cursor-tool': {
          command: 'node',
          args: ['server.js'],
        },
      },
    });

    vi.spyOn(skillsApiFs, 'readTextAny').mockImplementation(
      async (path: string) => {
        if (path.includes('claude_desktop_config.json')) return claudeJson;
        if (path.includes('.cursor') && path.includes('mcp.json'))
          return cursorJson;
        return null;
      }
    );

    const servers = await detectExternalMcpServers();
    expect(servers.length).toBe(3);

    const fsServer = servers.find((s) => s.id === 'claude:filesystem-server');
    expect(fsServer).toBeDefined();
    expect(fsServer?.source).toBe('claude');
    expect(fsServer?.type).toBe('stdio');
    expect(fsServer?.command).toBe('npx');
    expect(fsServer?.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      'C:\\',
    ]);
    expect(fsServer?.env).toEqual({ DEBUG: '1' });

    const sseServer = servers.find((s) => s.id === 'claude:remote-sse');
    expect(sseServer).toBeDefined();
    expect(sseServer?.type).toBe('sse');
    expect(sseServer?.url).toBe('http://localhost:3001/sse');

    const cursorServer = servers.find((s) => s.id === 'cursor:cursor-tool');
    expect(cursorServer).toBeDefined();
    expect(cursorServer?.source).toBe('cursor');
    expect(cursorServer?.command).toBe('node');
  });

  it('detects Antigravity MCP directory and counts json tools', async () => {
    vi.spyOn(skillsApiFs, 'tryHomeDir').mockResolvedValue(
      'C:\\Users\\mockuser'
    );
    vi.spyOn(skillsApiFs, 'readTextAny').mockResolvedValue(null);

    vi.spyOn(skillsApiFs, 'listDirAny').mockImplementation(
      async (dirPath: string) => {
        if (dirPath.endsWith('\\mcp') || dirPath.endsWith('/mcp')) {
          return [
            {
              name: 'chrome-devtools-mcp',
              isDir: true,
              path: `${dirPath}\\chrome-devtools-mcp`,
            },
            { name: 'custom-mcp', isDir: true, path: `${dirPath}\\custom-mcp` },
          ];
        }
        if (dirPath.endsWith('chrome-devtools-mcp')) {
          return [
            {
              name: 'click.json',
              isDir: false,
              path: `${dirPath}\\click.json`,
            },
            {
              name: 'hover.json',
              isDir: false,
              path: `${dirPath}\\hover.json`,
            },
            { name: 'README.md', isDir: false, path: `${dirPath}\\README.md` },
          ];
        }
        if (dirPath.endsWith('custom-mcp')) {
          return [
            {
              name: 'tool1.json',
              isDir: false,
              path: `${dirPath}\\tool1.json`,
            },
          ];
        }
        return [];
      }
    );

    const servers = await detectExternalMcpServers();
    expect(servers.length).toBe(2);

    const devtools = servers.find((s) => s.name === 'chrome-devtools-mcp');
    expect(devtools).toBeDefined();
    expect(devtools?.source).toBe('antigravity');
    expect(devtools?.toolsCount).toBe(2);
    expect(devtools?.command).toBe('npx');
    expect(devtools?.description).toBe('浏览器自动化与调试工具');

    const custom = servers.find((s) => s.name === 'custom-mcp');
    expect(custom).toBeDefined();
    expect(custom?.toolsCount).toBe(1);
    expect(custom?.command).toBe('node');
  });
});
