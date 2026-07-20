/**
 * MCP Tool Name Normalizer & Billing Compliance Transformer
 * 
 * 职责：
 * - 将 MCP 工具名规范化为 Anthropic 双下划线命名 (`mcp__{server}__{tool}`)
 * - 规避 Anthropic API 将单下划线 `mcp_` 识别为 Extra Usage 高阶计费项的问题
 * - 限制工具名最大长度为 64 字符（符合 Anthropic & OpenAI API 契约）
 */

const MAX_TOOL_NAME_LENGTH = 64;

export interface ParsedMcpTool {
  isMcp: boolean;
  serverName?: string;
  toolName?: string;
}

/** 清理与规范化标识符字符 `[a-zA-Z0-9_-]` */
function sanitizeIdentifier(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** 格式化为双下划线 Anthropic 计费兼容工具名 (`mcp__server__tool`) */
export function normalizeMcpToolName(serverName: string, rawToolName: string): string {
  const cleanServer = sanitizeIdentifier(serverName).toLowerCase() || 'server';
  const cleanTool = sanitizeIdentifier(rawToolName).toLowerCase() || 'tool';

  let formatted = `mcp__${cleanServer}__${cleanTool}`;

  // 超长截断（64 字符限制）
  if (formatted.length > MAX_TOOL_NAME_LENGTH) {
    const prefix = `mcp__${cleanServer}__`;
    const remainingLength = MAX_TOOL_NAME_LENGTH - prefix.length;
    if (remainingLength > 8) {
      formatted = `${prefix}${cleanTool.slice(0, remainingLength)}`;
    } else {
      formatted = formatted.slice(0, MAX_TOOL_NAME_LENGTH);
    }
  }

  return formatted;
}

/** 解析格式化的 `mcp__server__tool` 名称 */
export function parseMcpToolName(formattedToolName: string): ParsedMcpTool {
  if (!formattedToolName.startsWith('mcp__')) {
    return { isMcp: false };
  }

  const parts = formattedToolName.slice(5).split('__');
  if (parts.length >= 2) {
    return {
      isMcp: true,
      serverName: parts[0],
      toolName: parts.slice(1).join('__'),
    };
  }

  return { isMcp: false };
}
