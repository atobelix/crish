import type { McpServer } from '../../api/clientApi';
import type { McpServerInfo, McpToolDefinitionDto } from '../../api/mcpApi';

/** 连通性探测结果状态机 */
export interface McpProbeResult {
  status: 'idle' | 'success' | 'failed' | 'offline';
  latencyMs?: number;
  message?: string;
}

/** 从字符串或定义对象中解析工具名（无法解析时回退 tool_{idx+1}） */
export function getToolName(tool: unknown, idx: number): string {
  if (typeof tool === 'string') return tool;
  if (tool && typeof tool === 'object') {
    const obj = tool as { name?: string };
    if (typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim();
  }
  return `tool_${idx + 1}`;
}

/** 从定义对象中解析工具描述（缺失时返回空串） */
export function getToolDesc(tool: unknown): string {
  if (tool && typeof tool === 'object') {
    const obj = tool as { description?: string };
    if (typeof obj.description === 'string' && obj.description.trim()) {
      return obj.description.trim();
    }
  }
  return '';
}

/** 从定义对象中解析入参 Schema（缺失时返回 null） */
export function getToolSchema(tool: unknown): Record<string, unknown> | null {
  if (tool && typeof tool === 'object') {
    const obj = tool as { inputSchema?: Record<string, unknown> };
    if (obj.inputSchema && typeof obj.inputSchema === 'object') {
      return obj.inputSchema;
    }
  }
  return null;
}

/** 兼容多种 id/name 前缀（local-mcp: / mcp:）匹配 store 中的服务 */
export function matchesServerId(
  s: McpServer,
  targetId: string,
  targetName?: string
): boolean {
  return (
    s.id === targetId ||
    s.name === targetName ||
    `local-mcp:${s.id}` === targetId ||
    `local-mcp:${s.name}` === targetName ||
    `mcp:${s.id}` === targetId ||
    `mcp:${s.name}` === targetName
  );
}

/** 汇总服务当前状态（store 优先，其次 props，最后由 state 推导） */
export function deriveCurrentStatus(
  matchedStoreStatus: string | undefined,
  server: McpServerInfo
): string {
  return (
    matchedStoreStatus ||
    server.status ||
    (server.state === 'ready' || server.state === 'running'
      ? 'connected'
      : server.state) ||
    ''
  ).toLowerCase();
}

/** 判定服务是否处于在线（connected/ready/running） */
export function isOnlineStatus(currentStatus: string): boolean {
  return (
    currentStatus === 'connected' ||
    currentStatus === 'ready' ||
    currentStatus === 'running'
  );
}

/** 按关键字过滤工具（匹配名称或描述，大小写不敏感；空关键字原样返回） */
export function filterTools(
  tools: Array<string | McpToolDefinitionDto>,
  toolDefs: McpToolDefinitionDto[],
  searchQuery: string
): Array<string | McpToolDefinitionDto> {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return tools;
  return tools.filter((tool, idx) => {
    const name = getToolName(tool, idx).toLowerCase();
    const def = toolDefs.find(
      (d) =>
        d &&
        typeof d === 'object' &&
        typeof d.name === 'string' &&
        d.name.toLowerCase() === name
    );
    const desc = (def?.description || getToolDesc(tool)).toLowerCase();
    return name.includes(q) || desc.includes(q);
  });
}

/** 单个工具卡的展示数据 */
export interface McpToolDisplay {
  name: string;
  desc: string;
  schema: Record<string, unknown> | null;
  hasSchemaProps: boolean;
}

/** 解析单个工具卡的展示数据（定义对象优先，回退到原始工具解析） */
export function resolveToolDisplay(
  tool: unknown,
  idx: number,
  toolDefs: McpToolDefinitionDto[]
): McpToolDisplay {
  const name = getToolName(tool, idx);
  const def = toolDefs.find(
    (d) =>
      d &&
      typeof d === 'object' &&
      typeof d.name === 'string' &&
      d.name === name
  );
  const desc = def?.description || getToolDesc(tool);
  const schema = def?.inputSchema || getToolSchema(tool);
  const hasSchemaProps = Boolean(
    schema &&
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties) &&
    Object.keys(schema.properties).length > 0
  );
  return { name, desc, schema, hasSchemaProps };
}
