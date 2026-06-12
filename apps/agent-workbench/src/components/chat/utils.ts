/**
 * Chat 组件共享工具函数
 *
 * 从 ChatPanel.tsx 中提取的纯函数，无组件依赖。
 */

import type { ChatMessage, ToolCall, ChangedFile } from '../../core/app-state';
import type { RuntimeProjectionMessage, RuntimeProjectionToolCall } from '../../core/runtime-event-projector';

/** 工具调用分组接口 */
export interface ToolCallGroup {
  key: string;
  label: string;
  icon: 'file-edit' | 'search' | 'terminal' | 'network';
  toolCalls: ToolCall[];
  summary: string;
}

// ==================== Tool Constants ====================

const PRODUCT_FILE_EDIT_TOOLS = new Set(['edit', 'apply_workspace_edits']);
const LEGACY_FILE_EDIT_TOOLS = new Set(['write_file']);
export const FILE_MODIFYING_TOOLS = new Set([
  ...PRODUCT_FILE_EDIT_TOOLS,
  ...LEGACY_FILE_EDIT_TOOLS,
  'restore_file_snapshot',
  'create_workspace_checkpoint',
  'restore_workspace_checkpoint',
]);

export function isFileEditTool(toolName: string): boolean {
  return PRODUCT_FILE_EDIT_TOOLS.has(toolName) || LEGACY_FILE_EDIT_TOOLS.has(toolName);
}

export function isFileModifyingTool(toolName: string): boolean {
  return FILE_MODIFYING_TOOLS.has(toolName);
}

// ==================== Message Converters ====================

export function chatMessageFromRuntimeProjection(message: RuntimeProjectionMessage): ChatMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map(toolCallFromRuntimeProjection),
  };
}

export function toolCallFromRuntimeProjection(toolCall: RuntimeProjectionToolCall): ToolCall {
  return {
    ...toolCall,
    input: toolCall.input,
  };
}

// ==================== Changed File Extraction ====================

export function changedFileEntriesFromToolResult(result: ToolCall): ChangedFile[] {
  let json: Record<string, unknown> | null = null;
  if (typeof result.output === 'string') {
    try { json = JSON.parse(result.output) as Record<string, unknown>; } catch { /* ignore */ }
  }
  if (result.name === 'apply_workspace_edits' && Array.isArray(json?.files)) {
    return (json!.files as Array<Record<string, unknown>>)
      .filter((file) => file && typeof file.path === 'string' && file.changed !== false)
      .map((file) => ({
        path: file.path as string,
        addedLines: 0,
        removedLines: 0,
        status: (file.existed === false ? 'created' : 'modified') as ChangedFile['status'],
      }));
  }

  const path = (json?.path ?? (json?.resultPreview as Record<string, unknown> | undefined)?.path) as string | undefined;
  if (typeof path !== 'string' || path.length === 0) return [];

  const preview = json?.resultPreview as Record<string, unknown> | undefined;
  const startLine = typeof preview?.startLine === 'number' ? preview.startLine : 0;
  const endLine = typeof preview?.endLine === 'number' ? preview.endLine : 0;
  return [{
    path,
    addedLines: Math.max(0, endLine - startLine),
    removedLines: 0,
    status: (result.name === 'write_file' ? 'created' : 'modified') as ChangedFile['status'],
  }];
}

// ==================== Tool Call Grouping ====================

export function categorizeTool(name: string): ToolCallGroup['icon'] {
  if (isFileEditTool(name)) return 'file-edit';
  const lower = name.toLowerCase();
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find') || lower.includes('read')) return 'search';
  if (lower.includes('exec') || lower.includes('command') || lower.includes('terminal') || lower.includes('shell')) return 'terminal';
  if (lower.includes('fetch') || lower.includes('http') || lower.includes('web')) return 'network';
  return 'terminal';
}

export function groupToolCalls(toolCalls: ToolCall[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];
  let currentGroup: ToolCallGroup | null = null;

  for (const tc of toolCalls) {
    const icon = categorizeTool(tc.name);
    if (currentGroup && currentGroup.icon === icon) {
      currentGroup.toolCalls.push(tc);
    } else {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { key: `${icon}-${groups.length}`, icon, label: '', toolCalls: [tc], summary: '' };
    }
  }
  if (currentGroup) groups.push(currentGroup);

  for (const group of groups) {
    switch (group.icon) {
      case 'file-edit': group.label = '文件编辑'; break;
      case 'search': group.label = '代码搜索'; break;
      case 'terminal': group.label = '终端命令'; break;
      case 'network': group.label = '网络请求'; break;
    }
    group.summary = buildGroupSummary(group);
  }

  return groups;
}

export function buildGroupSummary(group: ToolCallGroup): string {
  const names = group.toolCalls.map(tc => tc.name);
  const uniqueNames = new Set(names);

  if (group.icon === 'file-edit') {
    if (group.toolCalls.length === 1) return group.toolCalls[0].name;
    const filePaths = group.toolCalls.map(tc => {
      const input = tc.input as Record<string, unknown> | undefined;
      return typeof input?.path === 'string' ? input.path : typeof input?.filePath === 'string' ? input.filePath : '';
    }).filter(Boolean);
    if (filePaths.length > 0) {
      return `${group.toolCalls.length} 次编辑 (${filePaths.map(p => p.split(/[/\\]/).pop()).join(', ')})`;
    }
    return `${group.toolCalls.length} 次编辑`;
  }
  if (group.toolCalls.length === 1) return buildSingleToolSummary(group.toolCalls[0]);
  if (uniqueNames.size === 1) return `${group.toolCalls.length} 次${names[0]}调用`;
  return `${group.toolCalls.length} 次调用`;
}

function buildSingleToolSummary(tool: ToolCall): string {
  const input = tool.input as Record<string, unknown> | undefined;
  if (typeof input?.command === 'string') return input.command as string;
  if (typeof input?.query === 'string') return input.query as string;
  if (typeof input?.url === 'string') return input.url as string;
  if (typeof input?.path === 'string') return input.path as string;
  return tool.name;
}

// ==================== Risk / Approval Helpers ====================

export function approvalRiskLabel(level?: string): string {
  switch (level) {
    case 'high': return '高风险';
    case 'medium': return '中风险';
    case 'low': return '低风险';
    default: return '待审核';
  }
}

export function approvalRiskTitle(tool: Pick<ToolCall, 'riskLevel' | 'riskDetail' | 'riskRule' | 'riskSource'>): string {
  const parts: string[] = [];
  if (tool.riskLevel) parts.push(approvalRiskLabel(tool.riskLevel));
  if (tool.riskDetail) parts.push(tool.riskDetail);
  if (tool.riskRule) parts.push(`规则: ${tool.riskRule}`);
  return parts.join(' · ');
}

export function toolInputSummary(tool: ToolCall): string {
  const input = tool.input as Record<string, unknown> | undefined;
  if (!input) return '';
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  const first = entries[0];
  const val = typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1]);
  const truncated = val.length > 80 ? val.slice(0, 80) + '...' : val;
  return `${first[0]}: ${truncated}`;
}

// ==================== Formatting ====================

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function shortRunId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}