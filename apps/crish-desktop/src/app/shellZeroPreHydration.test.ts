import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CAPTURED_EVENTS,
  SHELL_ZERO_MAX_HTML_BYTES,
  SHELL_ZERO_MAX_LCP_MS,
  SHELL_ZERO_MAX_TTI_MS,
  ShellZeroPreHydrationEngine,
  verifyShellZeroColdStartSla,
} from './shellZeroPreHydration';

describe('ShellZeroPreHydrationEngine (Wave 4 · W4-4)', () => {
  it('挂载前连续打字与多次切换会话在 drainAndReplay 时单帧合并回放且清空队列', () => {
    const engine = new ShellZeroPreHydrationEngine();
    expect(engine.isHydrated).toBe(false);

    expect(
      engine.capture({ type: 'composer-input', text: 'hello', timestamp: 10 })
    ).toBe(true);
    expect(
      engine.capture({
        type: 'session-select',
        sessionId: 'sess-1',
        timestamp: 15,
      })
    ).toBe(true);
    expect(
      engine.capture({
        type: 'shortcut-key',
        shortcut: 'Ctrl+K',
        timestamp: 20,
      })
    ).toBe(true);
    expect(
      engine.capture({ type: 'composer-input', text: ' world', timestamp: 25 })
    ).toBe(true);
    expect(
      engine.capture({
        type: 'session-select',
        sessionId: 'sess-2',
        timestamp: 30,
      })
    ).toBe(true);
    expect(
      engine.capture({
        type: 'shortcut-key',
        key: 'n',
        ctrlKey: true,
        timestamp: 35,
      })
    ).toBe(true);

    expect(engine.size).toBe(6);

    const onComposerInput = vi.fn();
    const onSessionSelect = vi.fn();
    const onShortcutKey = vi.fn();

    const result = engine.drainAndReplay({
      onComposerInput,
      onSessionSelect,
      onShortcutKey,
    });

    expect(engine.isHydrated).toBe(true);
    expect(engine.size).toBe(0);
    expect(engine.getCapturedEvents()).toHaveLength(0);

    expect(result).toEqual({
      replayedCount: 6,
      droppedCount: 0,
      mergedComposerText: 'hello world',
      targetSessionId: 'sess-2',
      triggeredShortcuts: ['Ctrl+K', 'Ctrl+N'],
    });

    expect(onComposerInput).toHaveBeenCalledTimes(1);
    expect(onComposerInput).toHaveBeenCalledWith('hello world');

    expect(onSessionSelect).toHaveBeenCalledTimes(1);
    expect(onSessionSelect).toHaveBeenCalledWith('sess-2');

    expect(onShortcutKey).toHaveBeenCalledTimes(2);
    expect(onShortcutKey).toHaveBeenNthCalledWith(
      1,
      'Ctrl+K',
      expect.objectContaining({ type: 'shortcut-key', shortcut: 'Ctrl+K' })
    );
    expect(onShortcutKey).toHaveBeenNthCalledWith(
      2,
      'Ctrl+N',
      expect.objectContaining({ type: 'shortcut-key', shortcut: 'Ctrl+N' })
    );
  });

  it('按时间戳顺序排序合并，并忽略空白无效会话选择', () => {
    const engine = new ShellZeroPreHydrationEngine();

    engine.captureComposerInput('world', 200);
    engine.captureComposerInput('hello ', 100);
    engine.captureSessionSelect('sess-early', 50);
    engine.captureSessionSelect('sess-final', 150);
    // 空白会话 ID 应被忽略，不得覆盖最后一次有效会话
    expect(engine.captureSessionSelect('   ', 300)).toBe(false);

    const result = engine.drainAndReplay();
    expect(result.mergedComposerText).toBe('hello world');
    expect(result.targetSessionId).toBe('sess-final');
  });

  it('超过 64 条事件（MAX_CAPTURED_EVENTS = 64）时触发有界队列保护，绝不溢出内存', () => {
    const engine = new ShellZeroPreHydrationEngine();
    expect(ShellZeroPreHydrationEngine.MAX_CAPTURED_EVENTS).toBe(64);
    expect(MAX_CAPTURED_EVENTS).toBe(64);

    for (let i = 0; i < 80; i++) {
      const accepted = engine.capture({
        type: 'composer-input',
        text: 'a',
        timestamp: i,
      });
      if (i < MAX_CAPTURED_EVENTS) {
        expect(accepted).toBe(true);
      } else {
        expect(accepted).toBe(false);
      }
    }

    expect(engine.size).toBe(MAX_CAPTURED_EVENTS);
    expect(engine.droppedCount).toBe(16);

    const result = engine.drainAndReplay();
    expect(result.replayedCount).toBe(MAX_CAPTURED_EVENTS);
    expect(result.droppedCount).toBe(16);
    expect(result.mergedComposerText).toBe('a'.repeat(MAX_CAPTURED_EVENTS));
    expect(engine.size).toBe(0);
  });

  it('支持 drop-oldest 溢出淘汰策略且严格保持 64 条上限', () => {
    const engine = new ShellZeroPreHydrationEngine({
      overflowStrategy: 'drop-oldest',
    });

    for (let i = 1; i <= 70; i++) {
      expect(engine.captureSessionSelect(`sess-${i}`, i)).toBe(true);
    }

    expect(engine.size).toBe(MAX_CAPTURED_EVENTS);
    expect(engine.droppedCount).toBe(6);

    const result = engine.drainAndReplay();
    expect(result.targetSessionId).toBe('sess-70');
    expect(result.replayedCount).toBe(MAX_CAPTURED_EVENTS);
  });

  it('水合完成后捕获器自动关闭，后续 capture 调用全部返回 false 且忽略', () => {
    const engine = new ShellZeroPreHydrationEngine();
    engine.captureComposerInput('initial');

    const firstReplay = engine.drainAndReplay();
    expect(firstReplay.mergedComposerText).toBe('initial');
    expect(engine.isHydrated).toBe(true);

    expect(engine.captureComposerInput('after-hydration')).toBe(false);
    expect(engine.captureSessionSelect('sess-after')).toBe(false);
    expect(engine.captureShortcutKey('Ctrl+P')).toBe(false);
    expect(engine.size).toBe(0);

    const onComposerInput = vi.fn();
    const secondReplay = engine.drainAndReplay({ onComposerInput });
    expect(secondReplay.replayedCount).toBe(0);
    expect(secondReplay.mergedComposerText).toBeNull();
    expect(onComposerInput).not.toHaveBeenCalled();
  });
});

describe('verifyShellZeroColdStartSla 冷启动 SLA 预算验证器', () => {
  it('静态壳 <= 60KB、LCP <= 80ms、TTI <= 120ms 时精确判定合规（含临界值）', () => {
    expect(SHELL_ZERO_MAX_HTML_BYTES).toBe(60 * 1024);
    expect(SHELL_ZERO_MAX_LCP_MS).toBe(80);
    expect(SHELL_ZERO_MAX_TTI_MS).toBe(120);

    const report = verifyShellZeroColdStartSla({
      shellHtmlBytes: 60 * 1024,
      lcpMs: 80,
      ttiMs: 120,
    });

    expect(report.passed).toBe(true);
    expect(report.compliant).toBe(true);
    expect(report.checks).toEqual({
      shellHtmlBytesOk: true,
      lcpOk: true,
      ttiOk: true,
    });
    expect(report.violations).toHaveLength(0);
    expect(report.diagnostics.length).toBeGreaterThan(0);
  });

  it('任一指标超出 60KB / 80ms LCP / 120ms TTI 预算时精确返回违规明细', () => {
    const report = verifyShellZeroColdStartSla({
      shellHtmlBytes: 60 * 1024 + 1,
      lcpMs: 80.5,
      ttiMs: 125,
    });

    expect(report.passed).toBe(false);
    expect(report.compliant).toBe(false);
    expect(report.checks).toEqual({
      shellHtmlBytesOk: false,
      lcpOk: false,
      ttiOk: false,
    });
    expect(report.violations).toHaveLength(3);
    expect(report.violations.map((v) => v.metric)).toEqual([
      'shellHtmlBytes',
      'lcpMs',
      'ttiMs',
    ]);
    expect(report.diagnostics).toHaveLength(3);
  });

  it('单项超标或非法负数/NaN 时准确识别对应违规项', () => {
    const ttiOnlyFail = verifyShellZeroColdStartSla({
      shellHtmlBytes: 42 * 1024,
      lcp: 55,
      tti: 121,
    });

    expect(ttiOnlyFail.passed).toBe(false);
    expect(ttiOnlyFail.checks.shellHtmlBytesOk).toBe(true);
    expect(ttiOnlyFail.checks.lcpOk).toBe(true);
    expect(ttiOnlyFail.checks.ttiOk).toBe(false);
    expect(ttiOnlyFail.violations).toHaveLength(1);
    expect(ttiOnlyFail.violations[0]?.metric).toBe('ttiMs');
  });
});
