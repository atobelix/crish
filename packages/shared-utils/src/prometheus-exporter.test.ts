import { describe, expect, it } from 'vitest';
import {
  PrometheusMetricsExporter,
  type PrometheusExportableSnapshot,
} from './prometheus-exporter';

function snapshot(
  overrides: Partial<PrometheusExportableSnapshot> = {}
): PrometheusExportableSnapshot {
  return {
    eventCount: 12,
    providerUsage: {
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
      reasoningTokens: 7,
    },
    tools: {
      callCount: 3,
      errorCount: 1,
      timeoutCount: 0,
      cancelCount: 0,
      byName: {},
    },
    failures: {
      providerErrorCount: 2,
      runtimeErrorCount: 0,
      agentErrorCount: 0,
    },
    ...overrides,
  };
}

describe('PrometheusMetricsExporter', () => {
  it('未导出过快照时返回占位注释', () => {
    const e = new PrometheusMetricsExporter();
    expect(e.name).toBe('prometheus');
    expect(e.scrape()).toBe('# no metrics yet\n');
  });

  it('输出 Prometheus 文本格式：HELP/TYPE 头 + 计数行，末尾换行', async () => {
    const e = new PrometheusMetricsExporter();
    await e.export(snapshot());
    const text = e.scrape();
    const lines = text.split('\n');
    expect(text.endsWith('\n')).toBe(true);
    expect(lines).toContain('# TYPE crish_token_total counter');
    expect(lines).toContain('crish_token_total{type="prompt"} 100');
    expect(lines).toContain('crish_token_total{type="completion"} 40');
    expect(lines).toContain('crish_token_total{type="total"} 140');
    expect(lines).toContain('crish_tool_calls_total{status="error"} 1');
    expect(lines).toContain('crish_tool_calls_total{status="timeout"} 0');
    expect(lines).toContain('crish_provider_errors_total 2');
    expect(lines).toContain('crish_event_count 12');
    expect(text).not.toContain('crish_tool_calls_by_name_total');
  });

  it('按工具名输出，并转义标签中的反斜杠/引号/换行（防标签注入）', async () => {
    const e = new PrometheusMetricsExporter();
    await e.export(
      snapshot({
        tools: {
          callCount: 2,
          errorCount: 1,
          timeoutCount: 0,
          cancelCount: 0,
          byName: {
            a: { toolName: 'read_file', callCount: 1, errorCount: 0 },
            b: { toolName: 'evil"}\nx\\y', callCount: 1, errorCount: 1 },
          },
        },
      })
    );
    const lines = e.scrape().split('\n');
    expect(lines).toContain(
      'crish_tool_calls_by_name_total{tool="read_file",status="total"} 1'
    );
    expect(lines).toContain(
      'crish_tool_calls_by_name_total{tool="evil\\"}\\nx\\\\y",status="error"} 1'
    );
    // 转义后不会出现被换行拆开的伪造行
    expect(lines.some((l) => l.startsWith('x'))).toBe(false);
  });

  it('后一次 export 覆盖前一次', async () => {
    const e = new PrometheusMetricsExporter();
    await e.export(snapshot({ eventCount: 1 }));
    await e.export(snapshot({ eventCount: 99 }));
    expect(e.scrape()).toContain('crish_event_count 99\n');
  });
});
