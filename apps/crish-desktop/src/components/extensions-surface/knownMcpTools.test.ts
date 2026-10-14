import { describe, it, expect } from 'vitest';
import { KNOWN_MCP_TOOL_MAP, resolveMcpTools } from './knownMcpTools';
import {
  KNOWN_MCP_TOOL_MAP as EXPORTED_TOOL_MAP,
  resolveMcpTools as exportedResolve,
} from './McpConnectModal';

describe('knownMcpTools and KNOWN_MCP_TOOL_MAP (BC11-1 物理拔除死字典)', () => {
  it('re-exports identical KNOWN_MCP_TOOL_MAP and resolveMcpTools from McpConnectModal', () => {
    expect(EXPORTED_TOOL_MAP).toBe(KNOWN_MCP_TOOL_MAP);
    expect(exportedResolve).toBe(resolveMcpTools);
  });

  it('verifies KNOWN_MCP_TOOL_MAP is completely empty (no static hardcoded fake tools)', () => {
    expect(Object.keys(KNOWN_MCP_TOOL_MAP)).toHaveLength(0);
    expect(KNOWN_MCP_TOOL_MAP['chrome-devtools-mcp']).toBeUndefined();
    expect(KNOWN_MCP_TOOL_MAP['tauri-mcp']).toBeUndefined();
    expect(KNOWN_MCP_TOOL_MAP['cua-driver']).toBeUndefined();
    expect(KNOWN_MCP_TOOL_MAP['filesystem']).toBeUndefined();
  });

  it('no longer resolves fake tools for chrome-devtools, tauri, or cua-driver variations', () => {
    expect(resolveMcpTools('chrome-devtools-mcp')).toEqual([]);
    expect(
      resolveMcpTools('custom-name', 'npx', ['chrome-devtools-mcp'])
    ).toEqual([]);
    expect(resolveMcpTools('devtools')).toEqual([]);
    expect(resolveMcpTools('tauri-mcp')).toEqual([]);
    expect(resolveMcpTools('cua-driver')).toEqual([]);
    expect(resolveMcpTools('node_repl')).toEqual([]);
  });

  it('preserves explicit tools when provided by server or backend reflection', () => {
    const explicit = ['custom_1', 'custom_2'];
    expect(resolveMcpTools('chrome-devtools-mcp', 'npx', [], explicit)).toEqual(
      explicit
    );
  });
});
