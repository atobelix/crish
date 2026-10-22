import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleTransport,
  Logger,
  redactSensitive,
  setLogRedactor,
  shouldLog,
  type LogEntry,
} from './logger';

afterEach(() => {
  setLogRedactor(undefined);
  vi.restoreAllMocks();
});

function capture(): { entries: LogEntry[]; transport: (e: LogEntry) => void } {
  const entries: LogEntry[] = [];
  return { entries, transport: (e) => entries.push(e) };
}

describe('shouldLog', () => {
  it('仅当条目级别 ≥ 配置级别时输出', () => {
    expect(shouldLog('info', 'debug')).toBe(false);
    expect(shouldLog('info', 'info')).toBe(true);
    expect(shouldLog('info', 'fatal')).toBe(true);
    expect(shouldLog('fatal', 'error')).toBe(false);
    expect(shouldLog('debug', 'debug')).toBe(true);
  });
});

describe('redactSensitive / setLogRedactor', () => {
  it('未设置脱敏器时原样返回；设置后生效；置空后恢复', () => {
    expect(redactSensitive('sk-secret')).toBe('sk-secret');
    setLogRedactor((t) => t.replace(/sk-\w+/g, '[REDACTED]'));
    expect(redactSensitive('key=sk-secret')).toBe('key=[REDACTED]');
    setLogRedactor(undefined);
    expect(redactSensitive('sk-secret')).toBe('sk-secret');
  });
});

describe('Logger', () => {
  it('默认级别 info：debug 被过滤，其余写入所有 transport', () => {
    const a = capture();
    const b = capture();
    const log = new Logger({ transports: [a.transport, b.transport] });
    expect(log.level).toBe('info');
    log.debug('hidden');
    log.info('shown');
    expect(a.entries.map((e) => e.msg)).toEqual(['shown']);
    expect(b.entries).toHaveLength(1);
  });

  it('条目包含 level/ISO 时间/module/meta，消息经过脱敏', () => {
    setLogRedactor((t) => t.replace('token123', '***'));
    const c = capture();
    const log = new Logger({
      level: 'debug',
      module: 'core',
      transports: [c.transport],
    });
    log.warn('auth token123 failed', {
      sessionId: 's1',
      err: { message: 'x', code: 'E1' },
    });
    const e = c.entries[0]!;
    expect(e).toMatchObject({
      level: 'warn',
      msg: 'auth *** failed',
      module: 'core',
      sessionId: 's1',
      err: { message: 'x', code: 'E1' },
    });
    expect(new Date(e.time).toISOString()).toBe(e.time);
  });

  it('无 module 时条目不含 module 键', () => {
    const c = capture();
    new Logger({ transports: [c.transport] }).error('e');
    expect('module' in c.entries[0]!).toBe(false);
  });

  it('setLevel 动态调整过滤；addTransport 追加输出', () => {
    const a = capture();
    const b = capture();
    const log = new Logger({ transports: [a.transport] });
    log.setLevel('error');
    log.warn('dropped');
    log.addTransport(b.transport);
    log.fatal('boom');
    expect(a.entries.map((e) => e.level)).toEqual(['fatal']);
    expect(b.entries.map((e) => e.msg)).toEqual(['boom']);
  });

  it('child 继承级别/module/transport，可覆盖并追加 transport，不影响父 logger', () => {
    const parent = capture();
    const extra = capture();
    const log = new Logger({
      level: 'warn',
      module: 'parent',
      transports: [parent.transport],
    });
    const child = log.child({ module: 'child', transports: [extra.transport] });
    child.warn('w');
    child.info('i');
    expect(parent.entries).toEqual([
      expect.objectContaining({ module: 'child', msg: 'w' }),
    ]);
    expect(extra.entries).toHaveLength(1);
    const inherit = log.child({ level: 'debug' });
    inherit.debug('d');
    expect(parent.entries.at(-1)).toMatchObject({
      module: 'parent',
      level: 'debug',
    });
    log.debug('parent still warn');
    expect(parent.entries.at(-1)!.msg).toBe('d');
  });
});

describe('createConsoleTransport', () => {
  it('按级别路由到对应 console 方法并输出 JSON 行', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createConsoleTransport();
    const mk = (level: LogEntry['level']): LogEntry => ({
      level,
      time: 't',
      msg: level,
    });
    t(mk('debug'));
    t(mk('info'));
    t(mk('warn'));
    t(mk('error'));
    t(mk('fatal'));
    expect(debug).toHaveBeenCalledWith(JSON.stringify(mk('debug')));
    expect(log).toHaveBeenCalledWith(JSON.stringify(mk('info')));
    expect(warn).toHaveBeenCalledWith(JSON.stringify(mk('warn')));
    expect(
      error.mock.calls.map((c) => JSON.parse(c[0] as string).level)
    ).toEqual(['error', 'fatal']);
  });
});
