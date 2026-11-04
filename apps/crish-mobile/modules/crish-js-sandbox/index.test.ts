import {
  runJsSandbox,
  DEFAULT_LIMITS,
  type JsSandboxSuccessOutcome,
  type JsSandboxErrorOutcome,
} from './index';

describe('crish-js-sandbox (QuickJS 隔离沙箱模块)', () => {
  describe('1. 正常表达式求值与 JSON 返回', () => {
    test('支持简单算术表达式与基础类型求值', async () => {
      const outcome = await runJsSandbox('1 + 2 * 3');
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(ok.result).toBe('7');
      expect(ok.durationMs).toBeGreaterThanOrEqual(0);
      expect(ok.logs).toBe('');
      expect(ok.logsTruncated).toBe(false);
    });

    test('支持多行语句并返回最后一条表达式值', async () => {
      const code = `
        const a = 15;
        const b = 25;
        const c = a + b;
        c * 2;
      `;
      const outcome = await runJsSandbox(code);
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(ok.result).toBe('80');
    });

    test('支持显式 return 语句与复杂对象/数组返回值', async () => {
      const code = `
        const user = { name: 'Alice', age: 28, tags: ['ai', 'mobile'] };
        return {
          status: 'success',
          data: user,
          count: user.tags.length,
        };
      `;
      const outcome = await runJsSandbox(code);
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(JSON.parse(ok.result!)).toEqual({
        status: 'success',
        data: { name: 'Alice', age: 28, tags: ['ai', 'mobile'] },
        count: 2,
      });
    });

    test('无返回值（或语句返回 undefined）时 result 缺省', async () => {
      const outcome = await runJsSandbox('const x = 1;');
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(ok.result).toBeUndefined();
    });

    test('支持 BigInt, Map, Set 无损序列化返回', async () => {
      const code = `
        return {
          big: 12345678901234567890n,
          map: new Map([['k1', 'v1'], ['k2', 'v2']]),
          set: new Set(['apple', 'banana']),
        };
      `;
      const outcome = await runJsSandbox(code);
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      const parsed = JSON.parse(ok.result!);
      expect(parsed.big).toBe('12345678901234567890');
      expect(parsed.map).toEqual({ k1: 'v1', k2: 'v2' });
      expect(parsed.set).toEqual(['apple', 'banana']);
    });

    test('返回值超限时按 maxResultBytes 刚性截断并标记 resultTruncated', async () => {
      const outcome = await runJsSandbox('"X".repeat(500)', {
        maxResultBytes: 64,
      });
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(ok.resultTruncated).toBe(true);
      expect(ok.result!.length).toBeLessThanOrEqual(64);
    });
  });

  describe('2. console.log 捕获与截断', () => {
    test('捕获 console.log, info, warn, error 输出', async () => {
      const code = `
        console.log('standard log message');
        console.info('info detail', { id: 101 });
        console.warn('warning notice');
        console.error('error notification');
        return 'done';
      `;
      const outcome = await runJsSandbox(code);
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(ok.logs).toContain('standard log message\n');
      expect(ok.logs).toContain('[info] info detail {"id":101}\n');
      expect(ok.logs).toContain('[warn] warning notice\n');
      expect(ok.logs).toContain('[error] error notification\n');
      expect(ok.logsTruncated).toBe(false);
      expect(ok.result).toBe('"done"');
    });

    test('print 函数等价映射为 console.log', async () => {
      const outcome = await runJsSandbox('print("print via global print"); 42');
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(ok.logs).toBe('print via global print\n');
      expect(ok.result).toBe('42');
    });

    test('日志超出 maxLogBytes 时刚性截断并标记 logsTruncated', async () => {
      const code = `
        for (let i = 0; i < 50; i++) {
          console.log('Long log line payload index ' + i);
        }
        return 'logged';
      `;
      const outcome = await runJsSandbox(code, { maxLogBytes: 64 });
      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(ok.logsTruncated).toBe(true);
      expect(new TextEncoder().encode(ok.logs).length).toBeLessThanOrEqual(64);
    });
  });

  describe('3. 死循环 while(true) 超时熔断', () => {
    test('同步死循环 while(true) 触发硬超时熔断并抛出 timeout', async () => {
      const startTime = Date.now();
      const outcome = await runJsSandbox('while (true) {}', {
        timeoutMs: 100,
      });
      const elapsed = Date.now() - startTime;

      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('timeout');
      expect(err.message).toMatch(/time limit|timed out/i);
      expect(elapsed).toBeLessThan(1500);
    });

    test('异步悬挂 Promise 触发超时熔断', async () => {
      const code = `
        await new Promise((resolve) => {
          // 悬挂永远不 resolve
        });
      `;
      const outcome = await runJsSandbox(code, { timeoutMs: 150 });
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('timeout');
      expect(err.message).toMatch(/time limit|timed out/i);
    });
  });

  describe('4. 内存超限保护（抛出 memory / OOM）', () => {
    test('申请超限 TypedArray 触发内存熔断', async () => {
      // 限制 1024 字节内存，申请 4096 字节 Uint8Array
      const outcome = await runJsSandbox('new Uint8Array(4096)', {
        memoryBytes: 1024,
      });
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('memory');
      expect(err.message).toMatch(/memory limit/i);
    });

    test('申请超限 ArrayBuffer 触发内存熔断', async () => {
      const outcome = await runJsSandbox('new ArrayBuffer(1024 * 1024)', {
        memoryBytes: 64 * 1024,
      });
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('memory');
      expect(err.message).toMatch(/memory limit/i);
    });

    test('申请巨型 Array 触发内存保护', async () => {
      const outcome = await runJsSandbox('new Array(5000000)', {
        memoryBytes: 1024 * 1024,
      });
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('memory');
      expect(err.message).toMatch(/memory limit/i);
    });
  });

  describe('5. 语法错误抛出 syntax 错误', () => {
    test('语法不合法（如未闭合的花括号）抛出 syntax 错误', async () => {
      const outcome = await runJsSandbox('function badSyntax( {');
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('syntax');
      expect(err.message.length).toBeGreaterThan(0);
    });

    test('意外的非法 token 抛出 syntax 错误', async () => {
      const outcome = await runJsSandbox('const x = %%%;');
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('syntax');
    });
  });

  describe('6. 运行时异常、取消与选项完整性', () => {
    test('代码内部抛出普通异常捕获为 exception', async () => {
      const outcome = await runJsSandbox(
        'throw new Error("Custom calculation failure");'
      );
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('exception');
      expect(err.message).toContain('Custom calculation failure');
    });

    test('支持 AbortSignal 取消执行并返回 cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      const outcome = await runJsSandbox({
        code: '1 + 1',
        signal: controller.signal,
      });
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('cancelled');
    });

    test('执行完成无论成败均触发 onSettled 回调', async () => {
      const onSettled = jest.fn();
      await runJsSandbox({
        code: 'return 100',
        onSettled,
      });
      expect(onSettled).toHaveBeenCalledTimes(1);

      const onSettledError = jest.fn();
      await runJsSandbox({
        code: 'bad syntax {{{',
        onSettled: onSettledError,
      });
      expect(onSettledError).toHaveBeenCalledTimes(1);
    });

    test('默认限制参数 DEFAULT_LIMITS 具备合理基准值', () => {
      expect(DEFAULT_LIMITS.timeoutMs).toBe(5000);
      expect(DEFAULT_LIMITS.memoryBytes).toBe(64 * 1024 * 1024);
      expect(DEFAULT_LIMITS.maxResultBytes).toBe(256 * 1024);
      expect(DEFAULT_LIMITS.maxLogBytes).toBe(4 * 1024);
    });
  });
});
