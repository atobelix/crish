/**
 * 扫描本机 Claude Code / Codex 会话目录（元数据 only）。
 * 真实探测：插件包 detectExternalSessions + Tauri allow-root FS（importFsHost）。
 * 仅在用户点击扫描时调用；禁止启动自动扫描。
 * 自定义根目录经 resolveHostImportEnv → mergeImportPathEnv（localStorage）注入。
 */

import { detectExternalSessions } from '@crish/plugin-import-claude-codex';
import { createTauriImportFs, resolveHostImportEnv } from './importFsHost';
import type { DetectedExternalSession, ImportFs, ImportPathEnv } from './types';
import { metaToDetected } from './types';

export type ScanExternalOptions = {
  /** 注入扫描结果（单测 / 演示） */
  inject?: DetectedExternalSession[];
  /** 注入 FS（单测）；默认 Tauri host */
  fs?: ImportFs;
  /** 路径环境覆盖（缺 home 时 resolveHostImportEnv 补全） */
  env?: ImportPathEnv;
  limit?: number;
};

/**
 * 扫描 Claude Code 本机会话。
 */
export async function scanClaudeCodeSessions(
  opts?: ScanExternalOptions,
): Promise<DetectedExternalSession[]> {
  if (opts?.inject) {
    return opts.inject.filter((s) => s.source === 'claude-code');
  }
  const fs = opts?.fs ?? createTauriImportFs();
  const env = await resolveHostImportEnv(opts?.env ?? {});
  const result = await detectExternalSessions({
    fs,
    env,
    sources: ['claude-code'],
    limit: opts?.limit,
  });
  return result.sessions.map(metaToDetected);
}

/**
 * 扫描 Codex 本机会话。
 */
export async function scanCodexSessions(
  opts?: ScanExternalOptions,
): Promise<DetectedExternalSession[]> {
  if (opts?.inject) {
    return opts.inject.filter((s) => s.source === 'codex');
  }
  const fs = opts?.fs ?? createTauriImportFs();
  const env = await resolveHostImportEnv(opts?.env ?? {});
  const result = await detectExternalSessions({
    fs,
    env,
    sources: ['codex'],
    limit: opts?.limit,
  });
  return result.sessions.map(metaToDetected);
}
