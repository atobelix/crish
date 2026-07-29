/**
 * 将外部会话映射为 Crish SessionMessage[]。
 * 有 path 时用 ImportFs 读 JSONL → parse* → mapToCrishSession。
 * 无 path / 读失败时返回空 messages 壳（仍可建会话；错误上抛给批量 map）。
 */

import { mapToCrishSession } from './mapToCrishSession';
import { parseClaudeCodeJsonl } from './parseClaudeCodeJsonl';
import { parseCodexRolloutJsonl } from './parseCodexRolloutJsonl';
import {
  allowRootFromSessionPath,
  createTauriImportFs,
  resolveHostImportEnv,
} from './importFsHost';
import { resolveDefaultImportRoots } from './detectExternalSessions';
import type { SessionMessage } from '../../store/types';
import type {
  DetectedExternalSession,
  ImportFs,
  ImportPathEnv,
  MappedImportSession,
} from './types';
import { toMappedImportSession } from './types';

export type MapExternalOptions = {
  fs?: ImportFs;
  /** Path env（缺 home 时 resolveHostImportEnv 补全） */
  env?: ImportPathEnv;
  /** Max JSONL bytes to read (default 32MB). */
  maxBytes?: number;
};

/** 外部角色 → Crish sender 粗映射 */
export function mapExternalRoleToSender(
  role: string | undefined,
): SessionMessage['sender'] {
  const r = (role || '').toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  return 'assistant';
}

/** Prefer path-derived config root; else resolved default roots. */
export function allowRootFor(
  detected: DetectedExternalSession,
  env?: ImportPathEnv,
): string {
  if (detected.path) {
    const fromPath = allowRootFromSessionPath(detected.path, detected.source);
    if (fromPath) return fromPath;
  }
  const roots = resolveDefaultImportRoots(env);
  return detected.source === 'claude-code' ? roots.claudeConfig : roots.codexHome;
}

/**
 * 将一条检测到的外部会话 map 为可导入结构。
 * 读取 detected.path 并解析源格式 transcript（OPT-1 parsers）。
 */
export async function mapExternalSession(
  detected: DetectedExternalSession,
  opts?: MapExternalOptions,
): Promise<MappedImportSession> {
  const folder =
    detected.project && detected.project.trim()
      ? detected.project.trim()
      : undefined;

  if (!detected.path) {
    return {
      source: detected.source,
      sourceId: detected.id,
      title: detected.title || '导入的对话',
      ...(folder !== undefined ? { folder } : {}),
      messages: [],
    };
  }

  const fs = opts?.fs ?? createTauriImportFs();
  const env = await resolveHostImportEnv(opts?.env ?? {});
  const maxBytes = opts?.maxBytes ?? 32 * 1024 * 1024;
  const allowRoot = allowRootFor(detected, env);
  const { content, truncated } = await fs.readText(detected.path, allowRoot, {
    maxBytes,
  });

  const parsed =
    detected.source === 'claude-code'
      ? parseClaudeCodeJsonl(content, { sourceSessionId: detected.id })
      : parseCodexRolloutJsonl(content, { sourceSessionId: detected.id });

  if (truncated) {
    parsed.warnings.push('Transcript truncated due to size cap');
  }

  const imported = mapToCrishSession(parsed, {
    sourcePath: detected.path,
    title: detected.title,
    ...(folder !== undefined ? { folder } : {}),
  });

  const mapped = toMappedImportSession(imported);
  // Prefer detected project label when provided
  if (folder) mapped.folder = folder;
  if (!mapped.title && detected.title) mapped.title = detected.title;
  return mapped;
}

/** 批量 map；单项失败不阻断其它 */
export async function mapExternalSessions(
  detected: DetectedExternalSession[],
  opts?: MapExternalOptions,
): Promise<{ mapped: MappedImportSession[]; errors: string[] }> {
  const mapped: MappedImportSession[] = [];
  const errors: string[] = [];
  // Resolve host env once for the batch
  const env = await resolveHostImportEnv(opts?.env ?? {});
  const batchOpts: MapExternalOptions = { ...opts, env };
  for (const d of detected) {
    try {
      mapped.push(await mapExternalSession(d, batchOpts));
    } catch (err) {
      // Do not include transcript body in error strings
      errors.push(`${d.title || d.id}：${String(err)}`);
    }
  }
  return { mapped, errors };
}
