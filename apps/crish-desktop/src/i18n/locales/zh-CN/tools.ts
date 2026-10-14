export const tools: Record<string, string> = {
  // MCP 扩展与服务工作台
  'mcp.statusRunning': '已连接并在后台运行',
  'mcp.statusStopped': '未连接/已停止',
  'mcp.connected': '已连接',
  'mcp.disconnected': '未连接',
  'mcp.latencyNormal': '连通正常，延迟 {latency}ms',
  'mcp.serviceDisabled': '服务未启用',
  'mcp.testConnectivity': '连通性测试',
  'mcp.unconnectedReflectTitle': '未连接，启动后动态反射',
  'mcp.unconnectedReflectDesc':
    '服务未连接。请开启上方运行状态开关，启动后将自动动态反射真实的 tools/list 与入参 Schema',
  'mcp.noExportedTools': '暂未发现导出的工具',
  'mcp.noToolsDeclared': '服务已连接，但远端未声明任何工具',
  'mcp.noMatchingTools': '未找到匹配「{query}」的工具',
  'mcp.clearSearch': '清空搜索',
  'mcp.toggleTool': '切换工具 {name}',
  'mcp.inputSchema': '入参 Schema',
};

export default tools;
