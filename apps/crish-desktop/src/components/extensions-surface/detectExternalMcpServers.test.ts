import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectExternalMcpServers,
  DEFAULT_FALLBACK_MCP,
} from './detectExternalMcpServers';
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
    expect(item?.toolsCount).toBe(4);
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

  it('provides DEFAULT_FALLBACK_MCP with full 30 tools for chrome-devtools-mcp and 57 for cua-driver', () => {
    const devtools = DEFAULT_FALLBACK_MCP.find(
      (s) => s.name === 'chrome-devtools-mcp'
    );
    expect(devtools).toBeDefined();
    expect(devtools?.toolsCount).toBe(30);
    expect(devtools?.tools).toHaveLength(30);

    const cua = DEFAULT_FALLBACK_MCP.find((s) => s.name === 'cua-driver');
    expect(cua).toBeDefined();
    expect(cua?.toolsCount).toBe(57);
    expect(cua?.tools).toHaveLength(57);
  });
});
