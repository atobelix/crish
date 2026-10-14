/**
 * 常见与内置 MCP 服务工具清单映射与解析工具（已拔除静态死字典）
 *
 * 契约：BC11-1 全动态真实反射体系。
 * 历史硬编码死字典 KNOWN_MCP_TOOL_MAP 与基于关键词匹配的 resolveMcpTools
 * 伪造逻辑已彻底物理拔除。MCP 工具必须由后端 tools/list 真实反射。
 */

export const KNOWN_MCP_TOOL_MAP: Record<string, string[]> = {};

/**
 * 拔除伪工具匹配逻辑：不再根据名称/命令猜测虚假工具，仅透传 explicitTools。
 */
export function resolveMcpTools(
  _name: string,
  _command?: string,
  _args?: string[],
  explicitTools?: string[]
): string[] {
  if (Array.isArray(explicitTools) && explicitTools.length > 0) {
    return explicitTools;
  }
  return [];
}
