import {
  beginInteraction,
  configureInteractionTimingForTest,
  isInteractionTimingEnabled,
  readInteractionRecordsForTest,
} from './interactionTiming';

describe('交互计时', () => {
  afterEach(() => {
    configureInteractionTimingForTest();
  });

  it('关闭时开始、记点、结束都是空操作，不留记录也不输出', () => {
    const lines: string[] = [];
    configureInteractionTimingForTest({
      enabled: false,
      sink: (line) => lines.push(line),
    });
    expect(isInteractionTimingEnabled()).toBe(false);
    const span = beginInteraction('model-sheet');
    span.mark('request');
    expect(span.end('mount')).toBeNull();
    expect(readInteractionRecordsForTest()).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('显式开关 0 关闭、1 开启，不看开发默认', () => {
    const previous = process.env.CRISH_INTERACTION_TIMING;
    process.env.CRISH_INTERACTION_TIMING = '0';
    configureInteractionTimingForTest({ enabled: null });
    expect(isInteractionTimingEnabled()).toBe(false);
    process.env.CRISH_INTERACTION_TIMING = '1';
    expect(isInteractionTimingEnabled()).toBe(true);
    if (previous === undefined) delete process.env.CRISH_INTERACTION_TIMING;
    else process.env.CRISH_INTERACTION_TIMING = previous;
  });

  it('记录按下到挂载的毫秒，完成相位为 mount 时标明不是可见等待', () => {
    let now = 1000;
    const lines: string[] = [];
    configureInteractionTimingForTest({
      enabled: true,
      now: () => now,
      sink: (line) => lines.push(line),
    });
    const span = beginInteraction('model-sheet');
    now = 1008;
    span.mark('request');
    now = 1024;
    span.mark('mount');
    const record = span.end('mount');
    expect(record).toEqual({
      name: 'model-sheet',
      durationMs: 24,
      completion: 'mount',
      visibility: 'not-visible',
      marks: [
        { phase: 'request', elapsedMs: 8 },
        { phase: 'mount', elapsedMs: 24 },
      ],
    });
    expect(lines).toEqual(['model-sheet mount 24ms not-visible']);
    expect(span.end('mount')).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it('只有真实可见相位才标成 visible', () => {
    let now = 0;
    configureInteractionTimingForTest({
      enabled: true,
      now: () => now,
      sink: () => undefined,
    });
    now = 40;
    const record = beginInteraction('sheet').end('visible');
    expect(record?.visibility).toBe('visible');
    expect(record?.completion).toBe('visible');
  });

  it('取消的短按不留记录、不输出', () => {
    const lines: string[] = [];
    configureInteractionTimingForTest({
      enabled: true,
      sink: (line) => lines.push(line),
    });
    const span = beginInteraction('session-row-long-press');
    span.mark('press');
    span.cancel();
    expect(span.end('request')).toBeNull();
    expect(readInteractionRecordsForTest()).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('输出不含令牌、票据或设备字段', () => {
    const lines: string[] = [];
    configureInteractionTimingForTest({
      enabled: true,
      sink: (line) => lines.push(line),
      now: () => 5,
    });
    const record = beginInteraction('model-sheet');
    record.mark('request');
    const done = record.end('request');
    const dumped = JSON.stringify({ done, lines });
    expect(dumped).not.toMatch(/token|cookie|authorization|deviceId|apiKey/i);
    expect(Object.keys(done ?? {}).sort()).toEqual([
      'completion',
      'durationMs',
      'marks',
      'name',
      'visibility',
    ]);
  });
});
