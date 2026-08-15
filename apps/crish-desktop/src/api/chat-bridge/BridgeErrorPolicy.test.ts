import { describe, expect, it, vi } from 'vitest';
import { surfaceStreamFailure } from './BridgeErrorPolicy';
import type { StreamCallbacks } from '../chatApi';
import * as streamDiagModule from '../streamDiag';

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

    surfaceStreamFailure(
      'Network request failed',
      'network',
      callbacks,
      'run-1'
    );

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

    surfaceStreamFailure(
      'checkpoint restore failed',
      'checkpoint',
      callbacks,
      'run-2'
    );

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
      'run-3'
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
      'run-4'
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
      'run-5'
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
      'run-6'
    );

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(msg).toBe('正在恢复上次的会话数据，稍后即可发送。');
    expect(kind).toBe('network');
  });

  it('用户主动取消（aborted / user-cancel / ui-stop）静默收口，不触发 onRunError 报错', () => {
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
      'provider 错误（aborted）：user cancelled',
      'runtime-error',
      callbacks,
      'run-abort-1'
    );
    surfaceStreamFailure(
      'ui-force-cancel',
      'runtime-error',
      callbacks,
      'run-abort-2'
    );
    surfaceStreamFailure('stream stopped', 'ended', callbacks, 'run-abort-3');

    expect(onRunError).not.toHaveBeenCalled();
  });

  it('S7 串行并发排队与 S8 本地存储同步分流正确', () => {
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
      'InvalidInput: 会话 s1 已有活动 run（串行守卫）',
      'runtime-error',
      callbacks,
      'run-s7'
    );
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(onRunError.mock.calls[0][0]).toBe(
      '当前会话上一轮任务仍在收尾中，已自动为您排队。'
    );

    surfaceStreamFailure(
      'Io: database locked (sqlite busy)',
      'runtime-error',
      callbacks,
      'run-s8'
    );
    expect(onRunError).toHaveBeenCalledTimes(2);
    expect(onRunError.mock.calls[1][0]).toBe(
      '本地会话存储正在同步数据，请稍候片刻。'
    );
  });
});

describe('BridgeErrorPolicy per-run 失败去重（04 §5.1-4 / G6/R5）', () => {
  function makeCallbacks(onRunError = vi.fn()): StreamCallbacks {
    return {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };
  }

  it('同 run 同错误指纹（双源不同 scope）只 surface 一次', () => {
    const onRunError = vi.fn();
    const callbacks = makeCallbacks(onRunError);
    surfaceStreamFailure(
      'dup-boom',
      'run-terminal-failed',
      callbacks,
      'run-dedup-1'
    );
    surfaceStreamFailure(
      'dup-boom',
      'agent-end-error',
      callbacks,
      'run-dedup-1'
    );
    expect(onRunError).toHaveBeenCalledTimes(1);
  });

  it('不同 run 同错误互不污染（各自 surface 一次）', () => {
    const onRunError = vi.fn();
    const callbacks = makeCallbacks(onRunError);
    surfaceStreamFailure('boom', 'runtime-error', callbacks, 'run-dedup-2a');
    surfaceStreamFailure('boom', 'runtime-error', callbacks, 'run-dedup-2b');
    expect(onRunError).toHaveBeenCalledTimes(2);
  });

  it('同 run 不同错误指纹各自 surface（不误伤不同失败）', () => {
    const onRunError = vi.fn();
    const callbacks = makeCallbacks(onRunError);
    surfaceStreamFailure('boom-a', 'runtime-error', callbacks, 'run-dedup-3');
    surfaceStreamFailure('boom-b', 'runtime-error', callbacks, 'run-dedup-3');
    expect(onRunError).toHaveBeenCalledTimes(2);
  });

  it('重复失败仅保留 logInternalError，不再 recordStreamDiag / onRunError', () => {
    const onRunError = vi.fn();
    const callbacks = makeCallbacks(onRunError);
    const diagSpy = vi.spyOn(streamDiagModule, 'recordStreamDiag');
    surfaceStreamFailure(
      'dup-boom-4',
      'runtime-error',
      callbacks,
      'run-dedup-4'
    );
    surfaceStreamFailure(
      'dup-boom-4',
      'runtime-error',
      callbacks,
      'run-dedup-4'
    );
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(diagSpy).toHaveBeenCalledTimes(1);
  });
});
