// @vitest-environment jsdom
/**
 * Stream F: Tauri invoke mock 基础设施验证
 *
 * 验证 test-setup.ts 提供的三态 mock 工具行为正确：
 *   - mockTauriCommand: ok 状态，返回 impl 结果
 *   - mockTauriMissing: missing 状态，invokeResult 返回 missing
 *   - mockTauriError:   error 状态，invokeResult 返回 error
 *   - 默认未注册命令:    missing
 *   - clearMockTauriCommands: 清空所有注册
 *   - beforeEach 自动重置
 *
 * 同时验证底层 invoke 函数被正确 mock（vi.fn 注入）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  invokeResult,
  invokeCmd,
  type InvokeResult,
} from './api/tauriInvoke';
import {
  mockTauriCommand,
  mockTauriMissing,
  mockTauriError,
  clearMockTauriCommands,
  __inspectMockState,
} from './test-setup';

// test-setup.ts 的 beforeEach 已经在每个用例前调用 clearMockTauriCommands，
// 这里再显式调用一次以防御其他 setup 顺序问题。
beforeEach(() => {
  clearMockTauriCommands();
});

describe('Tauri invoke mock 三态语义', () => {
  describe('mockTauriCommand (ok 状态)', () => {
    it('invoke 直接调用返回 impl 结果', async () => {
      mockTauriCommand('echo', (args) => ({ echoed: args }));

      const result = await invoke('echo', { msg: 'hi' });
      expect(result).toEqual({ echoed: { msg: 'hi' } });
    });

    it('invokeResult 包装层返回 ok 状态', async () => {
      mockTauriCommand('md_render', async (args) => {
        const text = (args as { text?: string })?.text ?? '';
        return `<p>${text}</p>`;
      });

      const res = await invokeResult<string>('md_render', { text: 'hi' });
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.data).toBe('<p>hi</p>');
      }
    });

    it('invokeCmd 宽松包装层返回 data（而非 null）', async () => {
      mockTauriCommand('core_get_status', () => ({
        searchIndexReady: true,
        dbReady: false,
        compactionReady: true,
      }));

      const data = await invokeCmd<{
        searchIndexReady: boolean;
      }>('core_get_status');
      expect(data).not.toBeNull();
      expect(data?.searchIndexReady).toBe(true);
    });

    it('impl 可以返回 undefined / null / 0 等假值', async () => {
      mockTauriCommand('returns_undef', () => undefined);
      mockTauriCommand('returns_null', () => null);
      mockTauriCommand('returns_zero', () => 0);
      mockTauriCommand('returns_empty_str', () => '');

      const u = await invoke('returns_undef');
      const n = await invoke('returns_null');
      const z = await invoke('returns_zero');
      const e = await invoke('returns_empty_str');

      expect(u).toBeUndefined();
      expect(n).toBeNull();
      expect(z).toBe(0);
      expect(e).toBe('');
    });

    it('impl 接收原始 args 对象', async () => {
      let received: unknown = null;
      mockTauriCommand('capture_args', (args) => {
        received = args;
        return 'ok';
      });

      await invoke('capture_args', {
        nested: { value: 42, list: [1, 2, 3] },
        flag: true,
      });
      expect(received).toEqual({
        nested: { value: 42, list: [1, 2, 3] },
        flag: true,
      });
    });
  });

  describe('mockTauriMissing (missing 状态)', () => {
    it('invoke 抛出错误且消息匹配 missing 模式', async () => {
      mockTauriMissing('unregistered_cmd');

      await expect(invoke('unregistered_cmd')).rejects.toThrow(
        /command .* not found/,
      );
    });

    it('invokeResult 包装层返回 missing 状态', async () => {
      mockTauriMissing('md_render');

      const res = await invokeResult('md_render', { text: 'hi' });
      expect(res.status).toBe('missing');
    });

    it('invokeCmd 宽松包装层在 missing 时返回 null', async () => {
      mockTauriMissing('missing_cmd');
      const data = await invokeCmd('missing_cmd');
      expect(data).toBeNull();
    });
  });

  describe('mockTauriError (error 状态)', () => {
    it('invoke 抛出指定错误', async () => {
      mockTauriError('failing_cmd', new Error('invalid input'));

      await expect(invoke('failing_cmd')).rejects.toThrow('invalid input');
    });

    it('invokeResult 包装层返回 error 状态', async () => {
      mockTauriError('core_compact_messages', new Error('OOM'));

      const res = await invokeResult('core_compact_messages', {});
      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.message).toBe('OOM');
      }
    });

    it('非 Error 对象（字符串）也能作为 error 抛出', async () => {
      mockTauriError('string_err', 'plain string error');

      const res = await invokeResult('string_err');
      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.message).toBe('plain string error');
      }
    });

    it('错误消息匹配 missing 模式时被归类为 missing', async () => {
      // 这种情况：调用方故意用 missing 模式消息作为 error
      // tauriInvoke.ts 的 isMissingCommandMessage 会优先归为 missing
      mockTauriError('tricky_cmd', new Error('command fake not found'));

      const res = await invokeResult('tricky_cmd');
      // 注意：这是 invokeResult 的设计行为——missing 模式优先于 error
      expect(res.status).toBe('missing');
    });
  });

  describe('默认行为（未注册命令）', () => {
    it('未注册命令视为 missing', async () => {
      // 不调用任何 mockTauri* 函数
      const res = await invokeResult('never_registered');
      expect(res.status).toBe('missing');
    });

    it('invoke 直接调用未注册命令抛出错误', async () => {
      await expect(invoke('never_registered_direct')).rejects.toThrow(
        /command .* not found/,
      );
    });
  });
});

describe('mock 状态可重置', () => {
  it('clearMockTauriCommands 清空所有注册', async () => {
    mockTauriCommand('temp_cmd', () => 'temp');
    expect(__inspectMockState().ok).toContain('temp_cmd');

    clearMockTauriCommands();
    expect(__inspectMockState().ok).toEqual([]);
    expect(__inspectMockState().missing).toEqual([]);
    expect(__inspectMockState().error).toEqual([]);

    // 清空后未注册命令变回 missing
    const res = await invokeResult('temp_cmd');
    expect(res.status).toBe('missing');
  });

  it('beforeEach 自动重置：前一个用例的注册不影响下一个', async () => {
    mockTauriCommand('leaky_cmd', () => 'should not leak');
    const res1 = await invokeResult('leaky_cmd');
    expect(res1.status).toBe('ok');
  });

  it('前一个用例注册的 leaky_cmd 在新用例中应为 missing', async () => {
    // 注意：这个用例没有显式注册 leaky_cmd
    // 如果 beforeEach 没有自动 clear，前一个用例的注册会泄漏
    const res = await invokeResult('leaky_cmd');
    expect(res.status).toBe('missing');
  });

  it('同用例内可多次重新注册同一 cmd 覆盖实现', async () => {
    mockTauriCommand('override_cmd', () => 'v1');
    const r1 = await invoke('override_cmd');
    expect(r1).toBe('v1');

    mockTauriCommand('override_cmd', () => 'v2');
    const r2 = await invoke('override_cmd');
    expect(r2).toBe('v2');

    mockTauriMissing('override_cmd');
    const res = await invokeResult('override_cmd');
    expect(res.status).toBe('missing');
  });

  it('状态可从 ok 切换到 error 再切换回 ok', async () => {
    mockTauriCommand('flaky_cmd', () => 'ok');
    expect((await invokeResult('flaky_cmd')).status).toBe('ok');

    mockTauriError('flaky_cmd', new Error('fail'));
    expect((await invokeResult('flaky_cmd')).status).toBe('error');

    mockTauriCommand('flaky_cmd', () => 'recovered');
    expect((await invokeResult('flaky_cmd')).status).toBe('ok');
  });
});

describe('invoke mock 函数为 vi.fn 实例', () => {
  it('可以断言 invoke 被调用的次数 / 参数', async () => {
    mockTauriCommand('counted_cmd', () => null);
    await invoke('counted_cmd', { a: 1 });
    await invoke('counted_cmd', { a: 2 });

    const mocked = vi.mocked(invoke);
    expect(mocked).toHaveBeenCalled();
    // 至少 2 次（其他用例可能也调用了 invoke）
    expect(mocked.mock.calls.length).toBeGreaterThanOrEqual(2);
    // 最后一次调用的参数
    const lastCall = mocked.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('counted_cmd');
    expect(lastCall?.[1]).toEqual({ a: 2 });
  });

  it('可以用 mockImplementation 覆盖 invoke 行为（高级用法）', async () => {
    vi.mocked(invoke).mockImplementationOnce(async () => 'one-off');
    const result = await invoke('one_off_cmd');
    expect(result).toBe('one-off');
    // mockImplementationOnce 只生效一次，下一次走 mockTauriCommand 注册表
    mockTauriCommand('one_off_cmd', () => 'table');
    expect(await invoke('one_off_cmd')).toBe('table');
  });
});

describe('rustCore 集成验证（端到端）', () => {
  it('rustCore.searchFilesDetailed 走 mock 路径', async () => {
    // 模拟 Rust 后端未注册 core_search_files 命令
    const { searchFilesDetailed } = await import('./api/rustCore');
    const outcome = await searchFilesDetailed({ query: 'test' });
    expect(outcome.status).toBe('missing');
  });

  it('rustCore.searchFilesDetailed 在 ok 状态返回 hits', async () => {
    // invokeResult 返回的 data 即 Rust command 的返回值；
    // normalizeFileHits 期望数组（而非 { hits: [...] } 包装）。
    mockTauriCommand('core_search_files', () => [
      { path: 'src/a.ts', score: 0.9, matchIndices: [0, 1] },
      { path: 'src/b.ts', score: 0.7, matchIndices: [3] },
    ]);

    const { searchFilesDetailed } = await import('./api/rustCore');
    const outcome = await searchFilesDetailed({ query: 'test' });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.hits).toHaveLength(2);
      expect(outcome.hits[0]?.path).toBe('src/a.ts');
    }
  });

  it('rustCore.getRustCoreStatus 在 error 状态返回 null', async () => {
    mockTauriError('core_get_status', new Error('backend crashed'));

    const { getRustCoreStatus } = await import('./api/rustCore');
    const status = await getRustCoreStatus();
    expect(status).toBeNull();
  });
});
