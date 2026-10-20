import React, { useMemo } from 'react';
import type { MessageToolCall } from '../../store/types';
import {
  isShellToolName,
  parseToolArgsSafe,
  extractToolCommand,
  toolHumanLabel,
} from '../../api/toolPresentation';
import { ModernJsonToolCall } from './ModernJsonToolCall';
import { ModernTerminalToolCall } from './ModernTerminalToolCall';

export interface ModernToolCallProps {
  tool: Partial<MessageToolCall> & {
    id?: string;
    name?: string;
    arguments?: string;
    output?: string;
    status?: string;
  };
  defaultOpen?: boolean;
  isOpen?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
}

/**
 * 从入参中提取适合展示在头部胶囊中的高频关键参数（如 query, path, pattern 等）
 */
function extractParamPill(rawArgs: string | undefined): string | undefined {
  if (!rawArgs) return undefined;
  const parsed = parseToolArgsSafe(rawArgs);
  const obj = parsed.rawObject;
  if (!obj || typeof obj !== 'object') {
    return parsed.primaryTarget || undefined;
  }

  // 优先级检索：query > pattern > path > file > target
  if (typeof obj.query === 'string' && obj.query.trim())
    return obj.query.trim();
  if (typeof obj.pattern === 'string' && obj.pattern.trim())
    return obj.pattern.trim();
  if (typeof obj.path === 'string' && obj.path.trim()) return obj.path.trim();
  if (typeof obj.filePath === 'string' && obj.filePath.trim())
    return obj.filePath.trim();
  if (typeof obj.file === 'string' && obj.file.trim()) return obj.file.trim();
  if (typeof obj.targetFile === 'string' && obj.targetFile.trim())
    return obj.targetFile.trim();

  // 若无上述标准字段，取第一个字符串类型的属性值
  for (const [_, val] of Object.entries(obj)) {
    if (typeof val === 'string' && val.trim() && val.length <= 40) {
      return val.trim();
    }
  }

  return parsed.primaryTarget || undefined;
}

/**
 * 智能工具调用调度分发组件（统一入口）
 * - 终端命令行工具（shell, bash, run_command 等）→ 渲染 ModernTerminalToolCall（截图 2）
 * - 结构化 JSON 工具（search, read, api 等）→ 渲染 ModernJsonToolCall（截图 1）
 */
export const ModernToolCall: React.FC<ModernToolCallProps> = ({
  tool,
  defaultOpen,
  isOpen,
  onToggle,
  className = '',
}) => {
  const name = tool.name || 'tool';
  const argsStr = tool.arguments || '';
  const output = tool.output || '';
  const status = tool.status || 'success';

  // 1. 嗅探是否为终端命令行
  const isShell = useMemo(() => isShellToolName(name), [name]);

  // 2. 若为终端命令：提取 CLI 命令行并渲染 Terminal 卡片
  if (isShell) {
    const command = extractToolCommand(argsStr) || argsStr || name;
    return (
      <ModernTerminalToolCall
        id={tool.id}
        command={command}
        output={output}
        status={status}
        className={className}
      />
    );
  }

  // 3. 结构化 JSON 工具：提取胶囊关键参数与动作文本
  const actionText = toolHumanLabel(tool as MessageToolCall) || name;
  const paramPill = extractParamPill(argsStr);

  return (
    <ModernJsonToolCall
      id={tool.id}
      name={name}
      actionText={actionText}
      paramPill={paramPill}
      request={argsStr}
      result={output}
      status={status}
      defaultOpen={defaultOpen}
      isOpen={isOpen}
      onToggle={onToggle}
      className={className}
    />
  );
};
