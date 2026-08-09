// @vitest-environment jsdom
/**
 * TelemetryMonitor 接线行为单测（T-A 批次 1.2，B7）
 *
 * 锁五项接线后行为（防「改名 / 清双硬编码后缓冲语义被改坏」）：
 *   1. flush 时 invoke 收到真实 wire 键 core_jsonl_append（非旧键 perf_jsonl_append）
 *   2. workspaceRoot 运行时派生：无工作区 → undefined（不再传机器路径）
 *   3. logFilePath 运行时派生：随工作区切换（有 root 时 <root>/logs/telemetry_runtime.jsonl）
 *   4. missing 分支走 logInternalError（console.warn）可观测，不再静默
 *   5. 1000 条缓冲上限保留（对齐 stressFuzzing Probe D）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { telemetryMonitor } from './TelemetryMonitor';
import { getWorkspacePath } from '../api/workspaceFsApi';
import {
  mockTauriCommand,
  mockTauriMissing,
} from '../test-setup';

// TelemetryMonitor 在 flush 时经 getWorkspacePath 运行时派生路径；
// mock 该模块（保留其余导出），默认无工作区。
vi.mock('../api/workspaceFsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/workspaceFsApi')>();
  return { ...actual, getWorkspacePath: vi.fn(() => undefined) };
});

const mockedGetWorkspacePath = vi.mocked(getWorkspacePath);

async function flushOnce(): Promise<void> {
  const tm = telemetryMonitor as unknown as { flush: () => Promise<void> };
  await tm.flush();
}

describe('TelemetryMonitor 接线行为（B7）', () => {
  beforeEach(() => {
    mockedGetWorkspacePath.mockReturnValue(undefined);
    const tm = telemetryMonitor as unknown as { buffer: string[] };
    tm.buffer = [];
  });

  it('flush 以真实键 core_jsonl_append 调用，无工作区时 workspaceRoot 为 undefined', async () => {
    mockTauriCommand('core_jsonl_append', () => null);

    telemetryMonitor.logAction('open-session', 12);
    await flushOnce();

    const mockedInvoke = vi.mocked(invoke);
    expect(mockedInvoke).toHaveBeenCalledWith(
      'core_jsonl_append',
      expect.objectContaining({
        path: 'logs/telemetry_runtime.jsonl',
        flush: true,
        workspaceRoot: undefined,
      }),
    );
    const callArgs = mockedInvoke.mock.calls.at(-1)?.[1] as {
      lines?: string[];
    } | undefined;
    expect(callArgs?.lines).toHaveLength(1);
    expect(callArgs?.lines?.[0]).toContain('open-session');
  });

  it('有工作区时 logFilePath 与 workspaceRoot 随工作区派生（不再传机器路径）', async () => {
    mockTauriCommand('core_jsonl_append', () => null);
    mockedGetWorkspacePath.mockReturnValue('C:/work/my-project');

    telemetryMonitor.logAction('open-session', 5);
    await flushOnce();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      'core_jsonl_append',
      expect.objectContaining({
        path: 'C:/work/my-project/logs/telemetry_runtime.jsonl',
        workspaceRoot: 'C:/work/my-project',
      }),
    );
  });

  it('missing 分支不再静默：logInternalError 输出可观测日志', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockTauriMissing('core_jsonl_append');

    // 非 test 环境守卫下 missing 分支才打印（与 catch 分支同款守卫）
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      telemetryMonitor.logAction('boom', 1);
      await flushOnce();
    } finally {
      process.env.NODE_ENV = origEnv;
    }

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('core_jsonl_append missing'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('missing 分支仍回灌缓冲重试（flush 失败不丢数据）', async () => {
    mockTauriMissing('core_jsonl_append');
    const tm = telemetryMonitor as unknown as { buffer: string[] };

    telemetryMonitor.logAction('retry-me', 1);
    await flushOnce();

    // 回灌后缓冲仍保留该条，等待下一次 flush 重试
    expect(tm.buffer.length).toBe(1);
    expect(tm.buffer[0]).toContain('retry-me');
  });

  it('1000 条缓冲上限保留（对齐 Probe D）', async () => {
    mockTauriCommand('core_jsonl_append', () => null);
    const tm = telemetryMonitor as unknown as { buffer: string[] };
    tm.buffer = [];

    for (let i = 0; i < 2000; i++) {
      telemetryMonitor.logAction(`action_${i}`, 10);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(tm.buffer.length).toBeLessThanOrEqual(1000);
  });
});
