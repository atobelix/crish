/**
 * AI 代码变更与消息撤回 Checkpoint API
 */
import { discardGitPath } from './gitApi';
import type { SessionMessage } from '../store/layoutStore';

export interface ModifiedFileInfo {
  path: string;
  action: 'create' | 'modify' | 'delete';
}

export interface SessionStateLike {
  messages?: SessionMessage[];
}

/**
 * 提取自某条消息 (messageId) 起，后续所有 AI 工具调用所修改或新建的文件列表
 */
export function getModifiedFilesSinceMessage(
  session: SessionStateLike,
  targetMessageId: string
): ModifiedFileInfo[] {
  const messages = session.messages || [];
  const idx = messages.findIndex((m: SessionMessage) => m.id === targetMessageId);
  if (idx === -1) return [];

  const subsequentMessages = messages.slice(idx);
  const fileMap = new Map<string, 'create' | 'modify' | 'delete'>();

  for (const msg of subsequentMessages) {
    if ((msg.sender !== 'assistant' && (msg as { role?: string }).role !== 'assistant') || !msg.toolCalls?.length) {
      continue;
    }
    for (const tool of msg.toolCalls) {
      const name = tool.name || '';
      let args: Record<string, unknown> = {};
      try {
        if (typeof tool.arguments === 'string' && tool.arguments.trim()) {
          args = JSON.parse(tool.arguments);
        } else if (typeof tool.arguments === 'object' && tool.arguments) {
          args = tool.arguments as Record<string, unknown>;
        }
      } catch {
        /* fail parsing JSON string */
      }

      const targetPath = args.TargetFile || args.path || args.targetPath || args.file;

      if (typeof targetPath === 'string' && targetPath.trim()) {
        const p = targetPath.trim();
        if (name.includes('write_to_file') || name.includes('create_file')) {
          if (!fileMap.has(p)) fileMap.set(p, 'create');
        } else if (name.includes('replace_file_content') || name.includes('multi_replace') || name.includes('edit')) {
          fileMap.set(p, 'modify');
        } else if (name.includes('delete') || name.includes('remove')) {
          fileMap.set(p, 'delete');
        }
      }
    }
  }

  return Array.from(fileMap.entries()).map(([path, action]) => ({ path, action }));
}

/**
 * 执行代码撤回与 Git 修改丢弃
 */
export async function rollbackFiles(cwd: string, files: string[]): Promise<number> {
  let count = 0;
  for (const f of files) {
    try {
      const ok = await discardGitPath(cwd, f);
      if (ok) count++;
    } catch {
      /* ignore single file discard error */
    }
  }
  return count;
}
