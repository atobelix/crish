/**
 * ContextInjectionCard —— 对话流可见上下文注入卡片组件。
 *
 * 规范承载 9 类系统上下文注入项（file_context / rule / skill / git_status /
 * terminal_output / runtime_steering / schedule_trigger / memory / workspace_env）。
 * 极简单行 Header + 快捷动作（打开文件/查看 Diff/失败重试）+ Markdown 展开保护。
 */
import React from 'react';
import { CompactInjectionRow } from './CompactInjectionRow';
import type { ContextInjectionCardProps } from './contextInjectionTypes';

export type { ContextInjectionCardProps } from './contextInjectionTypes';

export const ContextInjectionCard: React.FC<ContextInjectionCardProps> = CompactInjectionRow;

export default ContextInjectionCard;
export { CompactInjectionRow };
