// 日志门面契约（工程健康审计 M-5）：分级路由、生产降噪、脱敏与格式。
import { configureLoggerForTest, createLogger, scrubLogString } from './logger';

describe('logger 门面', () => {
  const lines: { level: string; line: string }[] = [];
  const sink = (level: string, line: string) => {
    lines.push({ level, line });
  };

  beforeEach(() => {
    lines.length = 0;
    configureLoggerForTest({ sink });
  });

  afterEach(() => {
    configureLoggerForTest();
  });

  it('域标签 + 消息组成单行，级别透传', () => {
    const log = createLogger('wiring');
    log.warn('会话索引对账失败：超时');
    expect(lines).toEqual([
      { level: 'warn', line: '[wiring] 会话索引对账失败：超时' },
    ]);
  });

  it('开发口径四级全量发出', () => {
    const log = createLogger('db');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.level)).toEqual([
      'debug',
      'info',
      'warn',
      'error',
    ]);
  });

  it('生产降噪：debug/info 不发，warn/error 必留痕', () => {
    configureLoggerForTest({ minLevel: 'warn', sink });
    const log = createLogger('ws');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('Error 上下文渲染 name 与 message（不丢错误信息）', () => {
    const log = createLogger('approvalWiring');
    log.error('outbox 持久化失败，离线决策可能丢失', new Error('disk full'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toContain('outbox 持久化失败');
    expect(lines[0]!.line).toContain('Error: disk full');
  });

  it('字符串/数字上下文直接附后（旧 (msg, err) 形态等价迁移）', () => {
    const log = createLogger('outbox');
    log.warn('清除旧 secure-store 队列失败', 'timeout');
    expect(lines[0]!.line).toBe(
      '[outbox] 清除旧 secure-store 队列失败 timeout'
    );
  });

  it('敏感键打码：token/ticket/apiKey/authorization 一律 ***', () => {
    const log = createLogger('account');
    log.info('请求完成', {
      accessToken: 'tok-123',
      ticket: 'tick-9',
      nested: { apiKey: 'key-7', authorization: 'Bearer x' },
      keep: 'visible',
    });
    const line = lines[0]!.line;
    expect(line).not.toContain('tok-123');
    expect(line).not.toContain('tick-9');
    expect(line).not.toContain('key-7');
    expect(line).toContain('visible');
    expect(line).toContain('***');
  });

  it('消息内 Bearer 凭据与 URL 票据参数被 scrub（外部错误文本折入防线）', () => {
    expect(scrubLogString('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer ***'
    );
    expect(scrubLogString('wss://relay.example/v1?ticket=sekret&lang=zh')).toBe(
      'wss://relay.example/v1?ticket=***&lang=zh'
    );
    const log = createLogger('account');
    log.warn(
      '发现失败',
      new Error('GET https://h/v1/devices?token=sekret 401')
    );
    expect(lines[0]!.line).not.toContain('sekret');
  });

  it('循环引用上下文不抛、超长上下文截断', () => {
    const log = createLogger('db');
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    expect(() => log.warn('循环', circular)).not.toThrow();
    expect(lines[0]!.line).toContain('[Circular]');
    log.warn('超长', { blob: 'x'.repeat(5000) });
    expect(lines[1]!.line.length).toBeLessThan(1200);
  });

  it('默认 sink 按级路由到对应 console 方法（既有 spy 断言口径）', () => {
    configureLoggerForTest();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const log = createLogger('wiring');
      log.warn('会话索引对账失败：x');
      log.error('水合失败');
      log.debug('忽略入站动作：y');
      // 单字符串参数 + stringContaining 兼容（feedBridge/dbBootstrap 等既有断言形态）
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('会话索引对账失败')
      );
      expect(warn.mock.calls[0]).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('水合失败'));
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('忽略入站动作')
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
      debug.mockRestore();
    }
  });
});
