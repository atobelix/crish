import { describe, it, expect } from 'vitest';
import { KNOWN_MCP_TOOL_MAP, resolveMcpTools } from './knownMcpTools';
import {
  KNOWN_MCP_TOOL_MAP as EXPORTED_TOOL_MAP,
  resolveMcpTools as exportedResolve,
} from './McpConnectModal';

describe('knownMcpTools and KNOWN_MCP_TOOL_MAP', () => {
  it('re-exports identical KNOWN_MCP_TOOL_MAP and resolveMcpTools from McpConnectModal', () => {
    expect(EXPORTED_TOOL_MAP).toBe(KNOWN_MCP_TOOL_MAP);
    expect(exportedResolve).toBe(resolveMcpTools);
  });

  it('contains full 30 tools for chrome-devtools-mcp', () => {
    const tools = KNOWN_MCP_TOOL_MAP['chrome-devtools-mcp'];
    expect(tools).toHaveLength(30);
    expect(tools).toContain('click');
    expect(tools).toContain('navigate_page');
    expect(tools).toContain('take_screenshot');
    expect(tools).toContain('get_console_message');
    expect(tools).toContain('evaluate_script');
    expect(tools).toContain('performance_analyze_insight');
    expect(tools).toContain('lighthouse_audit');
    expect(tools).toContain('wait_for');
  });

  it('contains full 19 tools for tauri-mcp and tauri-mcp-editor', () => {
    const tauriTools = KNOWN_MCP_TOOL_MAP['tauri-mcp'];
    expect(tauriTools).toHaveLength(19);
    expect(tauriTools).toContain('app_bridge');
    expect(tauriTools).toContain('manage_ipc');
    expect(tauriTools).toContain('query_logs');
    expect(tauriTools).toContain('dispatch_pointer');

    const editorTools = KNOWN_MCP_TOOL_MAP['tauri-mcp-editor'];
    expect(editorTools).toHaveLength(19);
  });

  it('contains full 57 tools for cua-driver', () => {
    const cuaTools = KNOWN_MCP_TOOL_MAP['cua-driver'];
    expect(cuaTools).toHaveLength(57);
    expect(cuaTools).toContain('browser_click');
    expect(cuaTools).toContain('health_report');
    expect(cuaTools).toContain('get_accessibility_tree');
    expect(cuaTools).toContain('zoom');
  });

  it('contains standard tools for filesystem, fetch, sqlite, and git', () => {
    expect(KNOWN_MCP_TOOL_MAP.filesystem.length).toBeGreaterThanOrEqual(8);
    expect(KNOWN_MCP_TOOL_MAP.fetch).toEqual(['fetch_url', 'download_content']);
    expect(KNOWN_MCP_TOOL_MAP.sqlite).toHaveLength(4);
    expect(KNOWN_MCP_TOOL_MAP.git).toHaveLength(4);
  });

  it('resolves all 30 tools for chrome-devtools variations via resolveMcpTools', () => {
    const res1 = resolveMcpTools('chrome-devtools-mcp');
    expect(res1).toHaveLength(30);

    const res2 = resolveMcpTools('custom-name', 'npx', ['chrome-devtools-mcp']);
    expect(res2).toHaveLength(30);

    const res3 = resolveMcpTools('devtools');
    expect(res3).toHaveLength(30);
  });

  it('resolves all 19 tools for tauri-mcp and 57 tools for cua-driver', () => {
    expect(resolveMcpTools('tauri-mcp')).toHaveLength(19);
    expect(resolveMcpTools('cua-driver')).toHaveLength(57);
  });

  it('preserves explicit tools when provided', () => {
    const explicit = ['custom_1', 'custom_2'];
    expect(resolveMcpTools('chrome-devtools-mcp', 'npx', [], explicit)).toEqual(
      explicit
    );
  });
});
