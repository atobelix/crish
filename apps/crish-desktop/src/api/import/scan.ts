/**
 * 扫描本机 Claude Code / Codex 会话目录（元数据 only）。
 * 真实探测：插件包 detectExternalSessions + Tauri allow-root FS（importFsHost）。
 * 仅在用户点击扫描时调用；禁止启动自动扫描。
 * 自定义根目录经 resolveHostImportEnv → mergeImportPathEnv（localStorage）注入。
 */

import { detectExternalSessions } from '@crish/plugin-import-claude-codex';
import { createTauriImportFs, resolveHostImportEnv } from './importFsHost';
import {
  getPersistedImportRoots,
  type PersistedImportRoots,
} from './importRootSettings';
import type {
  DetectedExternalSession,
  ExternalSessionScanIssue,
  ExternalSessionScanBatch,
  ExternalSessionSource,
  ExternalSessionSourceScan,
  ImportFs,
  ImportPathEnv,
} from './types';
import { metaToDetected } from './types';

export type ScanExternalOptions = {
  /** 注入扫描结果（单测 / 演示） */
  inject?: DetectedExternalSession[];
  /** 注入 FS（单测）；默认 Tauri host */
  fs?: ImportFs;
  /** 路径环境覆盖（缺 home 时 resolveHostImportEnv 补全） */
  env?: ImportPathEnv;
  /** 本次请求固定使用的自定义根目录快照 */
  persistedRoots?: PersistedImportRoots;
  limit?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scanError(
  source: ExternalSessionSource,
  error: unknown
): ExternalSessionSourceScan {
  return {
    source,
    sessions: [],
    issues: [{ source, kind: 'error', message: errorMessage(error) }],
  };
}

export function combineExternalSessionScans(
  scans: ExternalSessionSourceScan[]
): ExternalSessionScanBatch {
  return {
    sessions: scans.flatMap((scan) => scan.sessions),
    issues: scans.flatMap((scan) => scan.issues),
  };
}

/**
 * 扫描 Claude Code 本机会话。
 */
export async function scanClaudeCodeSessions(
  opts?: ScanExternalOptions
): Promise<ExternalSessionSourceScan> {
  if (opts?.inject) {
    return {
      source: 'claude-code',
      sessions: opts.inject.filter((s) => s.source === 'claude-code'),
      issues: [],
    };
  }
  try {
    const persistedRoots = opts?.persistedRoots ?? getPersistedImportRoots();
    const fs = opts?.fs ?? createTauriImportFs();
    const env = await resolveHostImportEnv(opts?.env ?? {}, persistedRoots);
    const result = await detectExternalSessions({
      fs,
      env,
      sources: ['claude-code'],
      limit: opts?.limit,
    });
    return {
      source: 'claude-code',
      sessions: result.sessions.map(metaToDetected),
      issues: [
        ...result.errors.map((message): ExternalSessionScanIssue => ({
          source: 'claude-code',
          kind: 'error',
          message,
        })),
        ...result.warnings.map((message): ExternalSessionScanIssue => ({
          source: 'claude-code',
          kind: 'warning',
          message,
        })),
      ],
    };
  } catch (error) {
    return scanError('claude-code', error);
  }
}

/**
 * 扫描 Codex 本机会话。
 */
export async function scanCodexSessions(
  opts?: ScanExternalOptions
): Promise<ExternalSessionSourceScan> {
  if (opts?.inject) {
    return {
      source: 'codex',
      sessions: opts.inject.filter((s) => s.source === 'codex'),
      issues: [],
    };
  }
  try {
    const persistedRoots = opts?.persistedRoots ?? getPersistedImportRoots();
    const fs = opts?.fs ?? createTauriImportFs();
    const env = await resolveHostImportEnv(opts?.env ?? {}, persistedRoots);
    const result = await detectExternalSessions({
      fs,
      env,
      sources: ['codex'],
      limit: opts?.limit,
    });
    return {
      source: 'codex',
      sessions: result.sessions.map(metaToDetected),
      issues: [
        ...result.errors.map((message): ExternalSessionScanIssue => ({
          source: 'codex',
          kind: 'error',
          message,
        })),
        ...result.warnings.map((message): ExternalSessionScanIssue => ({
          source: 'codex',
          kind: 'warning',
          message,
        })),
      ],
    };
  } catch (error) {
    return scanError('codex', error);
  }
}
