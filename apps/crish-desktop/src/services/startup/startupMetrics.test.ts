import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStartupBagForTest,
  crishStartupReport,
  markPaneHydrateDone,
  markPaneHydrateEnqueued,
  markStartupEntry,
  markStartupPhase,
} from './startupMetrics';

function t0(): number {
  return (window as unknown as { __crish_startup_bag: { t0: number } })
    .__crish_startup_bag.t0;
}

describe('startupMetrics', () => {
  beforeEach(() => {
    __resetStartupBagForTest();
    localStorage.removeItem('crish_startup_report_v1');
  });

  it('输出关键状态耗时纯文字', () => {
    markStartupEntry();
    const base = t0();
    markStartupPhase('preloadSnapshotDone', base + 40);
    markStartupPhase('reactMounted', base + 55);
    markStartupPhase('reactInteractiveReady', base + 70);
    const text = crishStartupReport({
      log: false,
      record: true,
      history: false,
      copy: true,
    });
    expect(text).toContain('preload: 40ms');
    expect(text).toContain('mount after preload: 15ms');
    expect(text).toContain('TTI from entry: 70ms');
    expect(text).not.toContain('|');
  });

  it('分片水合计数写入 panes 行', () => {
    markStartupEntry();
    markPaneHydrateEnqueued();
    markPaneHydrateEnqueued();
    markPaneHydrateDone(12);
    markPaneHydrateDone(8);
    const text = crishStartupReport({
      log: false,
      record: false,
      history: false,
      copy: true,
    });
    expect(text).toContain('panes: enqueued=2 done=2 last=8ms');
    expect(text).toContain('paneQueueIdle:');
  });
});
