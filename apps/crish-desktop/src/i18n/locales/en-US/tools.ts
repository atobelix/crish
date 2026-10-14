export const tools: Record<string, string> = {
  // MCP Extensions & Service Workbench
  'mcp.statusRunning': 'Connected and running in background',
  'mcp.statusStopped': 'Disconnected / Stopped',
  'mcp.connected': 'Connected',
  'mcp.disconnected': 'Disconnected',
  'mcp.latencyNormal': 'Connected, latency {latency}ms',
  'mcp.serviceDisabled': 'Service not enabled',
  'mcp.testConnectivity': 'Test Connectivity',
  'mcp.unconnectedReflectTitle': 'Disconnected. Tools reflect after startup',
  'mcp.unconnectedReflectDesc':
    'Service not connected. Enable the switch above to dynamically reflect tools/list and schema.',
  'mcp.noExportedTools': 'No exported tools found',
  'mcp.noToolsDeclared': 'Service connected, but remote declared no tools',
  'mcp.noMatchingTools': 'No tools matching "{query}"',
  'mcp.clearSearch': 'Clear Search',
  'mcp.toggleTool': 'Toggle tool {name}',
  'mcp.inputSchema': 'Input Schema',
};

export default tools;
