import type { MetricsExporter } from "./metrics-exporter";

export interface PrometheusExportableSnapshot {
  eventCount: number;
  providerUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  tools: {
    callCount: number;
    errorCount: number;
    timeoutCount: number;
    cancelCount: number;
    byName: Record<string, {
      toolName: string;
      callCount: number;
      errorCount: number;
    }>;
  };
  failures: {
    providerErrorCount: number;
    runtimeErrorCount: number;
    agentErrorCount: number;
  };
}

export class PrometheusMetricsExporter implements MetricsExporter<PrometheusExportableSnapshot> {
  readonly name = "prometheus";
  private latestSnapshot: PrometheusExportableSnapshot | undefined;

  async export(snapshot: PrometheusExportableSnapshot): Promise<void> {
    this.latestSnapshot = snapshot;
  }

  scrape(): string {
    const s = this.latestSnapshot;
    if (!s) return "# no metrics yet\n";

    const lines: string[] = [];
    lines.push("# HELP crish_token_total Total token consumption");
    lines.push("# TYPE crish_token_total counter");
    lines.push(`crish_token_total{type="prompt"} ${s.providerUsage.promptTokens}`);
    lines.push(`crish_token_total{type="completion"} ${s.providerUsage.completionTokens}`);
    lines.push(`crish_token_total{type="total"} ${s.providerUsage.totalTokens}`);

    lines.push("# HELP crish_tool_calls_total Total tool call count");
    lines.push("# TYPE crish_tool_calls_total counter");
    lines.push(`crish_tool_calls_total{status="total"} ${s.tools.callCount}`);
    lines.push(`crish_tool_calls_total{status="error"} ${s.tools.errorCount}`);
    lines.push(`crish_tool_calls_total{status="timeout"} ${s.tools.timeoutCount}`);

    for (const [_name, tm] of Object.entries(s.tools.byName)) {
      lines.push(`crish_tool_calls_by_name_total{tool="${escapeLabel(tm.toolName)}",status="total"} ${tm.callCount}`);
      lines.push(`crish_tool_calls_by_name_total{tool="${escapeLabel(tm.toolName)}",status="error"} ${tm.errorCount}`);
    }

    lines.push("# HELP crish_provider_errors_total Provider error count");
    lines.push("# TYPE crish_provider_errors_total counter");
    lines.push(`crish_provider_errors_total ${s.failures.providerErrorCount}`);

    lines.push("# HELP crish_event_count Total event count");
    lines.push("# TYPE crish_event_count counter");
    lines.push(`crish_event_count ${s.eventCount}`);

    return lines.join("\n") + "\n";
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
