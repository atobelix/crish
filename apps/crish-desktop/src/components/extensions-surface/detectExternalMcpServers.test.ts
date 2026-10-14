import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectExternalMcpServers,
  DEFAULT_FALLBACK_MCP,
} from './detectExternalMcpServers';
import { parseCodexToml } from './codexTomlParser';
import * as tauriInvoke from '../../api/tauriInvoke';

describe('detectExternalMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses Antigravity / Claude config format correctly', async () => {
    const mockConfig = JSON.stringify({
      mcpServers: {
        'test-sqlite': {
          command: 'uvx',
          args: ['mcp-server-sqlite', '--db-path', './test.db'],
          env: { DEBUG: '1' },
        },
      },
    });

    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('Claude')
        ) {
          return { status: 'ok', data: { content: mockConfig } } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalMcpServers();
    expect(result.length).toBeGreaterThan(0);
    const item = result.find((s) => s.name === 'test-sqlite');
    expect(item).toBeDefined();
    expect(item?.command).toBe('uvx');
    expect(item?.args).toEqual(['mcp-server-sqlite', '--db-path', './test.db']);
    expect(item?.env).toEqual({ DEBUG: '1' });
    expect(item?.source).toBe('Claude Desktop');
    expect(item?.toolsCount).toBeUndefined();
  });

  it('handles empty or malformed files gracefully without crashing', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockResolvedValue({
      status: 'ok',
      data: { content: 'INVALID JSON {[[' },
    } as any);

    const result = await detectExternalMcpServers();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('provides DEFAULT_FALLBACK_MCP without fake tools or static guesswork', () => {
    const devtools = DEFAULT_FALLBACK_MCP.find(
      (s) => s.name === 'chrome-devtools-mcp'
    );
    expect(devtools).toBeDefined();
    expect(devtools?.toolsCount).toBeUndefined();
    expect(devtools?.tools).toBeUndefined();

    const cua = DEFAULT_FALLBACK_MCP.find((s) => s.name === 'cua-driver');
    expect(cua).toBeDefined();
    expect(cua?.toolsCount).toBeUndefined();
    expect(cua?.tools).toBeUndefined();

    const claudecode = DEFAULT_FALLBACK_MCP.find(
      (s) => s.source === 'Claude Code' && s.name === 'chrome-devtools'
    );
    expect(claudecode).toBeDefined();
    expect(claudecode?.toolsCount).toBeUndefined();

    const codexRepl = DEFAULT_FALLBACK_MCP.find(
      (s) => s.source === 'Codex' && s.name === 'node_repl'
    );
    expect(codexRepl).toBeDefined();
    expect(codexRepl?.toolsCount).toBeUndefined();
  });

  it('detects Claude Code MCP servers from ~/.claude.json', async () => {
    const claudeJson = JSON.stringify({
      mcpServers: {
        'chrome-devtools': {
          command: 'cmd',
          args: ['/c', 'chrome-devtools-mcp.js'],
          type: 'stdio',
        },
      },
    });

    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('.claude.json')
        ) {
          return { status: 'ok', data: { content: claudeJson } } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalMcpServers();
    const item = result.find(
      (s) => s.source === 'Claude Code' && s.name === 'chrome-devtools'
    );
    expect(item).toBeDefined();
    expect(item?.command).toBe('cmd');
    expect(item?.toolsCount).toBeUndefined();
    expect(item?.tools).toBeUndefined();
  });

  it('detects Codex MCP servers from ~/.codex/config.toml', async () => {
    const codexToml = `
[mcp_servers]

[mcp_servers.chrome-devtools]
type = "stdio"
command = "cmd"
args = ["/c", "node.exe", "chrome-devtools-mcp.js"]

[mcp_servers.node_repl]
command = "node_repl.exe"
args = []

[mcp_servers.node_repl.env]
NODE_ENV = "production"

[mcp_servers.disabled_tool]
command = "disabled.exe"
enabled = false
`;

    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('config.toml')
        ) {
          return { status: 'ok', data: { content: codexToml } } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalMcpServers();
    const devtools = result.find(
      (s) => s.source === 'Codex' && s.name === 'chrome-devtools'
    );
    expect(devtools).toBeDefined();
    expect(devtools?.toolsCount).toBeUndefined();
    expect(devtools?.command).toBe('cmd');

    const repl = result.find(
      (s) => s.source === 'Codex' && s.name === 'node_repl'
    );
    expect(repl).toBeDefined();
    expect(repl?.command).toBe('node_repl.exe');
    expect(repl?.env).toEqual({ NODE_ENV: 'production' });
    expect(repl?.toolsCount).toBeUndefined();

    const disabled = result.find((s) => s.name === 'disabled_tool');
    expect(disabled).toBeUndefined();
  });

  // 回归：env 子节截断 lookahead 曾误写为 \Z（JS 非 unicode 模式下是字面字母 Z），
  // 导致 Z 开头的 env 变量（如 ZHIPU_API_KEY）及之后的变量在 lazy 匹配处被整段截断丢失。
  it('parseCodexToml keeps Z-prefixed env keys and handles file-end env sections', () => {
    const toml = [
      '[mcp_servers.zhipu]',
      'command = "npx"',
      'args = ["zhipu-mcp"]',
      '',
      '[mcp_servers.zhipu.env]',
      'ZHIPU_API_KEY = "secret-abc"',
      'BASE_URL = "https://open.bigmodel.cn"',
      '',
      '[mcp_servers.other.env]',
      'NODE_ENV = "production"',
    ].join('\n');

    const results = parseCodexToml(toml);

    const zhipu = results.find((s) => s.name === 'zhipu');
    expect(zhipu).toBeDefined();
    expect(zhipu?.command).toBe('npx');
    // Z 开头键必须完整保留，且后续键不被截断
    expect(zhipu?.env).toEqual({
      ZHIPU_API_KEY: 'secret-abc',
      BASE_URL: 'https://open.bigmodel.cn',
    });

    // env 子节位于文件末尾（无后续 section）时同样完整解析
    const trailingToml = [
      '[mcp_servers.tail]',
      'command = "tail.exe"',
      '',
      '[mcp_servers.tail.env]',
      'ZED_TOKEN = "tkn"',
      'API_KEY = "key"',
    ].join('\n');
    const tail = parseCodexToml(trailingToml).find((s) => s.name === 'tail');
    expect(tail?.env).toEqual({
      ZED_TOKEN: 'tkn',
      API_KEY: 'key',
    });
  });

  // ---- 以下用例语义迁移自已删除的 externalMcpDetector.test.ts（双源收敛） ----

  it('detects sse-type servers from url field in Claude Desktop config', async () => {
    const claudeDesktopJson = JSON.stringify({
      mcpServers: {
        'fs-server': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
        'remote-sse': {
          url: 'http://localhost:3001/sse',
        },
      },
    });

    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('Claude')
        ) {
          return { status: 'ok', data: { content: claudeDesktopJson } } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalMcpServers();
    const sse = result.find((s) => s.name === 'remote-sse');
    expect(sse).toBeDefined();
    expect(sse?.source).toBe('Claude Desktop');
    expect(sse?.type).toBe('sse');
    expect(sse?.url).toBe('http://localhost:3001/sse');

    const stdio = result.find((s) => s.name === 'fs-server');
    expect(stdio).toBeDefined();
    expect(stdio?.type).toBe('stdio');
    expect(stdio?.id).toBe('detected-claude-desktop-fs-server');
  });

  it('counts Antigravity mcp dir tools from json files with knownMcpTools fallback', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (cmd === 'workbench_list_directory') {
          const p = String(args?.path ?? '');
          if (p.endsWith('/mcp')) {
            return {
              status: 'ok',
              data: {
                items: [
                  { name: 'chrome-devtools-mcp', isDir: true },
                  { name: 'custom-mcp', isDir: true },
                ],
              },
            } as any;
          }
          if (p.endsWith('/mcp/chrome-devtools-mcp')) {
            return {
              status: 'ok',
              data: {
                items: [
                  { name: 'click.json', isDir: false },
                  { name: 'hover.json', isDir: false },
                  { name: 'README.md', isDir: false },
                ],
              },
            } as any;
          }
          if (p.endsWith('/mcp/custom-mcp')) {
            return {
              status: 'ok',
              data: { items: [{ name: 'tool1.json', isDir: false }] },
            } as any;
          }
          return { status: 'missing' } as any;
        }
        // 所有配置文件均不存在，仅走目录探测
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalMcpServers();
    expect(result.length).toBe(2);

    const devtools = result.find((s) => s.name === 'chrome-devtools-mcp');
    expect(devtools).toBeDefined();
    expect(devtools?.source).toBe('Antigravity');
    // 工具计数优先取子目录 json 定义文件名（README.md 不计入）
    expect(devtools?.tools).toEqual(['click', 'hover']);
    expect(devtools?.toolsCount).toBe(2);
    expect(devtools?.command).toBe('npx');
    expect(devtools?.description).toBe('浏览器自动化与调试工具');

    const custom = result.find((s) => s.name === 'custom-mcp');
    expect(custom).toBeDefined();
    expect(custom?.tools).toEqual(['tool1']);
    expect(custom?.toolsCount).toBe(1);
    expect(custom?.command).toBe('node');
  });

  it('tolerates line comments and trailing commas in json configs', async () => {
    const messy = `// crish test config
{
  // mcp servers below
  "mcpServers": {
    "tolerant-server": {
      "command": "node",
      "args": ["a.js",],
    },
  },
}`;

    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('.cursor')
        ) {
          return { status: 'ok', data: { content: messy } } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalMcpServers();
    const tolerant = result.find((s) => s.name === 'tolerant-server');
    expect(tolerant).toBeDefined();
    expect(tolerant?.source).toBe('Cursor');
    expect(tolerant?.command).toBe('node');
    expect(tolerant?.args).toEqual(['a.js']);
  });

  it('dedupes same-name servers detected across multiple candidate files', async () => {
    const dupJson = JSON.stringify({
      mcpServers: {
        'dup-tool': { command: 'node', args: ['dup.js'] },
      },
    });

    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('.claude')
        ) {
          // .claude.json 与 .claude/settings.json / config.json 同时命中同名服务
          return { status: 'ok', data: { content: dupJson } } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalMcpServers();
    const dupHits = result.filter((s) => s.name === 'dup-tool');
    expect(dupHits).toHaveLength(1);
    expect(dupHits[0]?.source).toBe('Claude Code');
    expect(dupHits[0]?.command).toBe('node');
  });
});
