import { describe, expect, it } from 'vitest';
import type { ControlMetricKey } from '../api/controlMetrics';
import {
  formatControlMetricsLines,
  formatControlMetricsStrip,
  type ControlMetricsSnapshot,
} from './devHealthFormat';

function snap(
  partial: Partial<Record<ControlMetricKey, number>> = {},
): ControlMetricsSnapshot {
  return {
    run_control_L1: 0,
    run_control_L2: 0,
    run_control_L3: 0,
    draft_enter: 0,
    draft_commit: 0,
    message_upsert: 0,
    hydrate_prune: 0,
    shell_empty_assert: 0,
    silent_complete: 0,
    transport_degraded_direct_fetch: 0,
    ...partial,
  };
}

describe('formatControlMetricsLines / strip (D2-3)', () => {
  it('formats zeros as compact strip', () => {
    expect(formatControlMetricsStrip(snap())).toBe(
      'L1:0 L2:0 L3:0 draft:0/0 up:0 prune:0 shell:0',
    );
  });

  it('includes L1/L2/L3, draft enter/commit, upsert, prune, shell', () => {
    const lines = formatControlMetricsLines(
      snap({
        run_control_L1: 1,
        run_control_L2: 2,
        run_control_L3: 3,
        draft_enter: 4,
        draft_commit: 5,
        message_upsert: 6,
        hydrate_prune: 7,
        shell_empty_assert: 8,
      }),
    );
    expect(lines.map((l) => l.text)).toEqual([
      'L1:1',
      'L2:2',
      'L3:3',
      'draft:4/5',
      'up:6',
      'prune:7',
      'shell:8',
    ]);
    expect(lines.find((l) => l.id === 'shell')?.warn).toBe(true);
    expect(lines.find((l) => l.id === 'L1')?.warn).toBeFalsy();
  });

  it('strip joins cell texts with spaces', () => {
    expect(
      formatControlMetricsStrip(
        snap({
          run_control_L1: 9,
          message_upsert: 1,
          shell_empty_assert: 2,
        }),
      ),
    ).toBe('L1:9 L2:0 L3:0 draft:0/0 up:1 prune:0 shell:2');
  });

  it('shell warn only when shell_empty_assert > 0', () => {
    expect(formatControlMetricsLines(snap()).find((l) => l.id === 'shell')?.warn).toBe(
      false,
    );
    expect(
      formatControlMetricsLines(snap({ shell_empty_assert: 1 })).find(
        (l) => l.id === 'shell',
      )?.warn,
    ).toBe(true);
  });
});
