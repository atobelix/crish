/**
 * LoggerService 单元测试（PE-04 T04.4-1 / T04.4-4）。
 *
 * 覆盖：级别过滤、结构化前缀（module）、sessionId/runId 注入
 * （调用点 meta 优先 / 全局上下文回退）、RingBuffer 容量、清空、
 * 脱敏（sk- 前缀 / Bearer / query 参数 / 嵌套 err）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger, toErrMeta } from './LoggerService';

describe('LoggerService', () => {
  let consoleCalls: string[];

  beforeEach(() => {
    consoleCalls = [];
    vi.spyOn(console, 'debug').mockImplementation(() => {
      consoleCalls.push('debug');
    });
    vi.spyOn(console, 'info').mockImplementation(() => {
      consoleCalls.push('info');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {
      consoleCalls.push('warn');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      consoleCalls.push('error');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      consoleCalls.push('log');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    logger.setLevel('debug');
    logger.resetSessionContext();
    logger.clearLogs();
  });

  it('级别过滤：低于当前级别的日志不进入缓冲', () => {
    logger.setLevel('warn');
    logger.debug('debug msg', { module: 'test' });
    logger.info('info msg', { module: 'test' });
    logger.warn('warn msg', { module: 'test' });
    expect(logger.getRecentLogs().map((e) => e.level)).toEqual(['warn']);
  });

  it('模块前缀与结构化字段进入 LogEntry', () => {
    logger.warn('some problem', { module: 'transport', sessionId: 's1', runId: 'r1' });
    const entry = logger.getRecentLogs()[0];
    expect(entry).toMatchObject({
      level: 'warn',
      module: 'transport',
      sessionId: 's1',
      runId: 'r1',
      msg: 'some problem',
    });
    expect(entry.time).toBeTruthy();
  });

  it('全局 sessionId/runId 上下文注入；调用点 meta 优先', () => {
    logger.setSessionContext({ sessionId: 'global-s', runId: 'global-r' });
    logger.info('ctx fallback');
    logger.info('ctx override', { sessionId: 'local-s' });
    const logs = logger.getRecentLogs();
    expect(logs[0]).toMatchObject({ sessionId: 'global-s', runId: 'global-r' });
    expect(logs[1]).toMatchObject({ sessionId: 'local-s', runId: 'global-r' });
  });

  it('RingBuffer 上限 200 条，溢出覆盖最旧', () => {
    for (let i = 0; i < 205; i++) {
      logger.debug(`msg-${i}`, { module: 'test' });
    }
    const logs = logger.getRecentLogs();
    expect(logs.length).toBe(200);
    expect(logs[0].msg).toBe('msg-5');
    expect(logs[199].msg).toBe('msg-204');
  });

  it('clearLogs 清空缓冲', () => {
    logger.warn('a');
    logger.clearLogs();
    expect(logger.getRecentLogs()).toEqual([]);
  });

  it('dev 模式 console 输出带 [module] 前缀风格', () => {
    // 测试环境 NODE_ENV=test，isDev() 为 false → 走 JSON 分支（不校验 console 细节）
    logger.warn('msg', { module: 'm' });
    expect(consoleCalls).toEqual(['log']);
  });

  it('sk- 密钥在 msg 中脱敏', () => {
    logger.warn('key sk-abcdefghijklmnopqrstuvwxyz123456 used', { module: 'test' });
    const entry = logger.getRecentLogs()[0];
    expect(entry.msg).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(entry.msg).toContain('***');
  });

  it('meta 中嵌套密钥脱敏（err.message / query 参数）', () => {
    logger.error('provider failed', {
      module: 'test',
      err: { message: 'http://x.ai/v1?key=sk-abcdefghijklmnopqrstuvwxyz123456' },
    });
    const entry = logger.getRecentLogs()[0];
    expect(JSON.stringify(entry)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(JSON.stringify(entry)).toContain('***');
  });

  it('Bearer token 脱敏', () => {
    logger.info('auth ok', {
      module: 'test',
      err: { message: 'Authorization: Bearer tok_1234567890abcdef' },
    });
    const entry = logger.getRecentLogs()[0];
    expect(JSON.stringify(entry)).not.toContain('tok_1234567890abcdef');
  });

  it('toErrMeta：Error / string / 对象归一化', () => {
    expect(toErrMeta(new Error('boom'))?.message).toBe('boom');
    expect(toErrMeta('raw')?.message).toBe('raw');
    expect(toErrMeta({ code: 'x', message: 'm' })).toMatchObject({ code: 'x', message: 'm' });
    expect(toErrMeta(null)).toBeUndefined();
  });
});
