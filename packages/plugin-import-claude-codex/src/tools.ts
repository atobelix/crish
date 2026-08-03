/**
 * 插件工具声明与执行体（只读纯函数工具）。
 *
 * 工具契约（对齐 03 生态插件方案 E3）：
 * - 入参：内容字符串 + 选项（sourceSessionId / maxLines / title / folder / sessionId）
 * - 出参：中立载荷 SessionImportPayload（消息为 ImportMessageDraft，宿主再适配写库）
 * 文件读取属宿主能力（ImportFs 注入面），本包工具只收文本内容。
 */

import { parseClaudeCodeJsonl, type ParseClaudeCodeOptions } from './parse/claude-code';
import { parseCodexRolloutJsonl, type ParseCodexRolloutOptions } from './parse/codex';
import { mapToCrishSession } from './map';
import { TOOL_PARSE_CLAUDE_CODE, TOOL_PARSE_CODEX_ROLLOUT } from './manifest';
import type { ParsedExternalConversation, SessionImportPayload } from './types';

/** parse-claude-code-jsonl 工具入参。 */
export type ParseClaudeCodeToolInput = {
  /** JSONL 文本内容（宿主读取文件后注入；纯函数工具不收路径）。 */
  content: string;
  /** 来源会话 id 兜底（文件名主干）。 */
  sourceSessionId?: string;
  /** 最大处理行数。 */
  maxLines?: number;
  /** 会话标题覆盖。 */
  title?: string;
  /** 会话文件夹标签覆盖。 */
  folder?: string;
  /** 目标会话 id 覆盖。 */
  sessionId?: string;
  /** 来源路径（仅展示/溯源）。 */
  sourcePath?: string;
};

/** parse-codex-rollout-jsonl 工具入参。 */
export type ParseCodexRolloutToolInput = {
  /** JSONL 文本内容（宿主读取文件后注入；纯函数工具不收路径）。 */
  content: string;
  sourceSessionId?: string;
  maxLines?: number;
  title?: string;
  folder?: string;
  sessionId?: string;
  sourcePath?: string;
};

function requireContent(input: unknown, toolName: string): string {
  const content =
    input != null && typeof input === 'object' && 'content' in input
      ? (input as { content?: unknown }).content
      : undefined;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error(`${toolName}：缺少必填参数 content（JSONL 文本）`);
  }
  return content;
}

/** 工具执行体：解析 + 映射 → 中立会话载荷（Claude Code）。 */
export function parseClaudeCodeTool(input: ParseClaudeCodeToolInput): SessionImportPayload {
  const content = requireContent(input, TOOL_PARSE_CLAUDE_CODE);
  const options: ParseClaudeCodeOptions = {};
  if (input.sourceSessionId) options.sourceSessionId = input.sourceSessionId;
  if (input.maxLines != null) options.maxLines = input.maxLines;
  const parsed = parseClaudeCodeJsonl(content, options);
  return mapToCrishSession(parsed, {
    sourcePath: input.sourcePath ?? 'memory://claude-code',
    ...(input.title ? { title: input.title } : {}),
    ...(input.folder ? { folder: input.folder } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
}

/** 工具执行体：解析 + 映射 → 中立会话载荷（Codex）。 */
export function parseCodexRolloutTool(input: ParseCodexRolloutToolInput): SessionImportPayload {
  const content = requireContent(input, TOOL_PARSE_CODEX_ROLLOUT);
  const options: ParseCodexRolloutOptions = {};
  if (input.sourceSessionId) options.sourceSessionId = input.sourceSessionId;
  if (input.maxLines != null) options.maxLines = input.maxLines;
  const parsed = parseCodexRolloutJsonl(content, options);
  return mapToCrishSession(parsed, {
    sourcePath: input.sourcePath ?? 'memory://codex',
    ...(input.title ? { title: input.title } : {}),
    ...(input.folder ? { folder: input.folder } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
}

/** 工具级低层入口（返回解析中间载荷；供宿主按需定制映射）。 */
export function parseClaudeCodeConversation(
  content: string,
  options: ParseClaudeCodeOptions = {},
): ParsedExternalConversation {
  return parseClaudeCodeJsonl(content, options);
}

/** 工具级低层入口（返回解析中间载荷；供宿主按需定制映射）。 */
export function parseCodexRolloutConversation(
  content: string,
  options: ParseCodexRolloutOptions = {},
): ParsedExternalConversation {
  return parseCodexRolloutJsonl(content, options);
}

/** 工具声明（name/description/inputSchema 子集，供宿主注册与展示）。 */
export function toolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'JSONL 文本内容' },
      sourceSessionId: { type: 'string', description: '来源会话 id 兜底' },
      maxLines: { type: 'number', description: '最大处理行数' },
      title: { type: 'string', description: '会话标题覆盖' },
      folder: { type: 'string', description: '会话文件夹标签覆盖' },
      sessionId: { type: 'string', description: '目标会话 id 覆盖' },
      sourcePath: { type: 'string', description: '来源路径（仅溯源）' },
    },
    required: ['content'],
  } as Record<string, unknown>;
}

/** 两个工具的统一声明清单（name/description/inputSchema）。 */
export function getToolDeclarations(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: TOOL_PARSE_CLAUDE_CODE,
      description: '解析 Claude Code 会话 JSONL 内容，输出结构化会话载荷（纯函数只读）',
      inputSchema: toolInputSchema(),
    },
    {
      name: TOOL_PARSE_CODEX_ROLLOUT,
      description: '解析 Codex CLI rollout JSONL 内容，输出结构化会话载荷（纯函数只读）',
      inputSchema: toolInputSchema(),
    },
  ];
}
