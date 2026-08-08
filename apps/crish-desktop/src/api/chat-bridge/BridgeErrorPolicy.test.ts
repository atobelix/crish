import { describe, expect, it, vi } from 'vitest';
import { surfaceStreamFailure } from './BridgeErrorPolicy';
import type { StreamCallbacks } from '../chatApi';

describe('BridgeErrorPolicy', () => {
  it('surfaces stream failures to onRunError callback', () => {
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };

    surfaceStreamFailure('Network request failed', 'network', callbacks, 'run-1');

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(typeof msg).toBe('string');
    expect(kind).toBeDefined();
  });

  it('handles checkpoint scope error formatting', () => {
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };

    surfaceStreamFailure('checkpoint restore failed', 'checkpoint', callbacks, 'run-2');

    expect(onRunError).toHaveBeenCalledTimes(1);
  });

  it('差异化六域优先：S2 门禁文案 → 配置缺失文案 + kind 归 network（持久条面）', () => {
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };

    surfaceStreamFailure(
      'internal: provider 配置缺失（baseUrl/model/apiKey 三件套）',
      'run-failed',
      callbacks,
      'run-3',
    );

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(msg).toBe('模型服务尚未配置，请打开 设置 → 模型 完成配置后再发送。');
    // 展示面按 kind、文案按域：域命中统一归 network → 走持久条面（T-1 分发）
    expect(kind).toBe('network');
  });

  it('差异化六域优先：S5 rate-limit → provider 侧故障文案 + kind network', () => {
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };

    surfaceStreamFailure(
      'provider 错误（rate-limit）：429 Too Many Requests',
      'runtime-error',
      callbacks,
      'run-4',
    );

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(msg).toBe('模型服务商侧出现故障，请稍后重试或切换模型。');
    expect(kind).toBe('network');
  });

  it('未命中六域：保留既有分类（auth → auth kind + auth 文案）', () => {
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };

    surfaceStreamFailure(
      'provider 错误（auth）：invalid api key',
      'runtime-error',
      callbacks,
      'run-5',
    );

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(kind).toBe('auth');
    expect(msg).toContain('模型密钥无效');
  });

  it('S3 restore 门禁文案 → 恢复会话数据文案', () => {
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };

    surfaceStreamFailure(
      'internal: restore in progress：等待重启恢复完成',
      'run-failed',
      callbacks,
      'run-6',
    );

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(msg).toBe('正在恢复上次的会话数据，稍后即可发送。');
    expect(kind).toBe('network');
  });
});
