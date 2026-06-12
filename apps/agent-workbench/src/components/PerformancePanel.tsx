import { useEffect, useMemo, useState } from 'preact/hooks';
import { appState, type PerformanceSnapshot, type WorkbenchMetricsSnapshotState } from '../core/app-state';
import { tauriBridge } from '../core/tauri-bridge';
import { isBackendDiagnosticResult } from '../core/tauri-command-registry';
import type {
  WorkbenchMetricsQueryResult,
  WorkbenchRuntimeMetricsSnapshot,
  WorkbenchToolNameMetricsSnapshot,
} from '../shared/workbench-contract';
import { IconRefresh, IconSpinner } from './icons';

function MemoryBar({ used, total, label }: { used: number; total: number; label: string }) {
  const percent = total > 0 ? (used / total) * 100 : 0;
  const level = percent > 80 ? 'danger' : percent > 60 ? 'warn' : 'normal';
  return (
    <div class="repl-perf-mem-bar">
      <div class="repl-perf-mem-label">
        <span>{label}</span>
        <span>{used.toFixed(0)} MB</span>
      </div>
      <div class="repl-perf-mem-track">
        <div
          class={`repl-perf-mem-fill ${level}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  detail,
  tone = 'normal',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'normal' | 'good' | 'warn' | 'danger';
}) {
  return (
    <div class={`repl-perf-metric ${tone}`}>
      <span class="repl-perf-metric-label">{label}</span>
      <span class="repl-perf-metric-value">{value}</span>
      {detail && <span class="repl-perf-metric-detail">{detail}</span>}
    </div>
  );
}

function DiagnosticBanner({ message, detail }: { message: string; detail?: string }) {
  return (
    <div class="repl-perf-diagnostic">
      <span>{message}</span>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export default function PerformancePanel() {
  const [perf, setPerf] = useState<PerformanceSnapshot | null>(appState.getState().performanceSnapshot);
  const [metrics, setMetrics] = useState<WorkbenchMetricsSnapshotState>(appState.getState().metricsSnapshot);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const perfUnsub = appState.subscribe('performanceSnapshot', setPerf);
    const metricsUnsub = appState.subscribe('metricsSnapshot', setMetrics);
    return () => {
      perfUnsub();
      metricsUnsub();
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const poll = async () => {
      if (disposed) return;
      setLoading(true);
      appState.setState('metricsSnapshot', {
        ...appState.getState().metricsSnapshot,
        loading: true,
        error: null,
      });

      const [perfSnap, metricsSnap] = await Promise.all([
        tauriBridge.getPerformanceSnapshot(),
        tauriBridge.getMetrics({ includeRuns: true }),
      ]);

      if (disposed) return;

      if (perfSnap) {
        appState.setState('performanceSnapshot', perfSnap);
      }

      if (isBackendDiagnosticResult(metricsSnap)) {
        appState.setState('metricsSnapshot', {
          result: null,
          loading: false,
          error: metricsSnap.diagnostic.message,
          updatedAt: Date.now(),
        });
      } else {
        appState.setState('metricsSnapshot', {
          result: metricsSnap,
          loading: false,
          error: null,
          updatedAt: Date.now(),
        });
      }

      setLoading(false);
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const result = metrics.result;
  const summary = result?.summary;
  const snapshot = summary?.snapshot;
  const topTools = useMemo(() => topToolMetrics(snapshot), [snapshot]);
  const cacheTone = cacheHealthTone(snapshot);
  const streamTone = streamHealthTone(snapshot);
  const toolTone = toolHealthTone(snapshot);

  if (!perf && !result && !metrics.error) {
    return (
      <div class="repl-task-empty">
        <div class="repl-task-empty-text">Loading diagnostics...</div>
      </div>
    );
  }

  return (
    <div class="repl-task-panel">
      <div class="repl-task-header repl-perf-header">
        <div>
          <div class="repl-task-title">Runtime Diagnostics</div>
          <div class="repl-perf-subtitle">process, stream, cache, tools</div>
        </div>
        <div class="repl-task-meta">
          {(loading || metrics.loading) && <IconSpinner />}
          <button class="repl-rs-btn-icon" title="Refresh diagnostics" onClick={() => void refreshDiagnostics()}>
            <IconRefresh />
          </button>
        </div>
      </div>

      {metrics.error && <DiagnosticBanner message="Daemon metrics unavailable" detail={metrics.error} />}
      {result?.diagnostic && <DiagnosticBanner message={result.diagnostic.code} detail={result.diagnostic.message} />}

      {snapshot && (
        <>
          <div class="repl-task-section">
            <div class="repl-task-section-header">
              <span class="repl-task-section-title">Run Metrics</span>
              <span class="repl-task-section-badge">{summary?.runCount ?? 0} runs</span>
            </div>
            <div class="repl-task-section-body">
              <div class="repl-perf-metric-grid">
                <MetricTile label="events" value={formatInt(snapshot.eventCount)} detail={`${formatInt(snapshot.turnCount)} turns`} />
                <MetricTile
                  label="provider p95"
                  value={formatMs(snapshot.providerLatencyMs.p95)}
                  detail={`${formatInt(snapshot.providerLatencyMs.count)} samples`}
                />
                <MetricTile
                  label="failures"
                  value={formatInt(snapshot.failures.errorCount)}
                  detail={`provider ${formatInt(snapshot.failures.providerErrorCount)}`}
                  tone={snapshot.failures.errorCount > 0 ? 'danger' : 'normal'}
                />
                <MetricTile
                  label="sessions"
                  value={formatInt(summary?.sessionCount ?? 0)}
                  detail={result?.source ? `log gen ${result.source.generation}` : undefined}
                  tone={result?.status === 'degraded' ? 'warn' : 'normal'}
                />
              </div>
            </div>
          </div>

          <div class="repl-task-section">
            <div class="repl-task-section-header">
              <span class="repl-task-section-title">Cache</span>
              <span class={`repl-task-section-badge repl-perf-badge-${cacheTone}`}>{formatPercent(snapshot.cache.hitRatio)}</span>
            </div>
            <div class="repl-task-section-body">
              <div class="repl-perf-metric-grid">
                <MetricTile
                  label="hit ratio"
                  value={formatPercent(snapshot.cache.hitRatio)}
                  detail={`${formatInt(snapshot.cache.readTokens)} read`}
                  tone={cacheTone}
                />
                <MetricTile
                  label="prompt"
                  value={formatCompact(snapshot.cache.promptTokens)}
                  detail={`${formatCompact(snapshot.cache.missTokens)} miss`}
                />
                <MetricTile
                  label="write"
                  value={formatCompact(snapshot.cache.writeTokens)}
                  detail={formatPercent(snapshot.cache.writeRatio)}
                />
                <MetricTile
                  label="samples"
                  value={formatInt(snapshot.cache.sampleCount)}
                  detail={latestModelLabel(snapshot)}
                />
              </div>
            </div>
          </div>

          <div class="repl-task-section">
            <div class="repl-task-section-header">
              <span class="repl-task-section-title">Streaming</span>
              <span class={`repl-task-section-badge repl-perf-badge-${streamTone}`}>
                {formatMs(snapshot.streaming.firstTextDeltaLatencyMs)}
              </span>
            </div>
            <div class="repl-task-section-body">
              <div class="repl-perf-metric-grid">
                <MetricTile
                  label="first text"
                  value={formatMs(snapshot.streaming.firstTextDeltaLatencyMs)}
                  detail={`provider ${formatMs(snapshot.streaming.firstProviderResponseLatencyMs)}`}
                  tone={streamTone}
                />
                <MetricTile
                  label="delta rate"
                  value={formatRate(snapshot.streaming.tokensPerSecond)}
                  detail={`${formatInt(snapshot.streaming.textDeltaCount)} deltas`}
                />
                <MetricTile
                  label="stream span"
                  value={formatMs(snapshot.streaming.providerStreamDurationMs)}
                  detail={`${formatInt(snapshot.streaming.providerDiagnosticCount)} diagnostics`}
                />
                <MetricTile
                  label="interrupts"
                  value={formatInt(snapshot.streaming.interruptedCount ?? 0)}
                  detail={terminalReasonLabel(snapshot)}
                  tone={(snapshot.streaming.errorCount ?? 0) > 0 || (snapshot.streaming.interruptedCount ?? 0) > 0 ? 'warn' : 'normal'}
                />
              </div>
            </div>
          </div>

          <div class="repl-task-section">
            <div class="repl-task-section-header">
              <span class="repl-task-section-title">Tools</span>
              <span class={`repl-task-section-badge repl-perf-badge-${toolTone}`}>{formatPercent(snapshot.tools.errorRate)}</span>
            </div>
            <div class="repl-task-section-body">
              <div class="repl-perf-metric-grid">
                <MetricTile label="calls" value={formatInt(snapshot.tools.callCount)} detail={`${formatInt(snapshot.tools.errorCount)} errors`} />
                <MetricTile label="p99" value={formatMs(snapshot.tools.durationMs.p99)} detail={`p95 ${formatMs(snapshot.tools.durationMs.p95)}`} />
                <MetricTile
                  label="timeouts"
                  value={formatInt(snapshot.tools.timeoutCount)}
                  detail={formatPercent(snapshot.tools.timeoutRate)}
                  tone={snapshot.tools.timeoutCount > 0 ? 'warn' : 'normal'}
                />
                <MetricTile
                  label="cancels"
                  value={formatInt(snapshot.tools.cancelCount)}
                  detail={formatPercent(snapshot.tools.cancelRate)}
                />
              </div>
              {topTools.length > 0 && (
                <div class="repl-perf-tool-list">
                  {topTools.map((tool) => (
                    <div key={tool.toolName} class="repl-perf-tool-row">
                      <span class="repl-perf-tool-name" title={tool.toolName}>{tool.toolName}</span>
                      <span>{formatInt(tool.callCount)} calls</span>
                      <span class={tool.errorCount > 0 ? 'repl-perf-danger-text' : ''}>{formatPercent(tool.errorRate)}</span>
                      <span>{formatMs(tool.durationMs.p99 ?? tool.durationMs.p95 ?? tool.durationMs.max)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {perf?.mainProcess && (
        <div class="repl-task-section">
          <div class="repl-task-section-header">
            <span class="repl-task-section-title">Process</span>
            <span class="repl-task-section-badge">PID {perf.mainProcess.pid}</span>
          </div>
          <div class="repl-task-section-body">
            <MemoryBar used={perf.mainProcess.memoryMb} total={perf.mainProcess.memoryMb * 2} label="memory" />
            <MemoryBar used={perf.mainProcess.pageFileMb} total={perf.mainProcess.pageFileMb * 2} label="page file" />
          </div>
        </div>
      )}

      {perf?.runs && perf.runs.length > 0 && (
        <div class="repl-task-section">
          <div class="repl-task-section-header">
            <span class="repl-task-section-title">Active Processes</span>
            <span class="repl-task-section-badge">{perf.runs.length}</span>
          </div>
          <div class="repl-task-section-body">
            {perf.runs.map((run) => (
              <div key={run.runId} class="repl-perf-run">
                <div class="repl-perf-run-header">
                  <span>{run.runId.slice(0, 8)}</span>
                  <span>PID {run.pid}</span>
                </div>
                <MemoryBar used={run.workingSetMb} total={run.peakWorkingSetMb || run.workingSetMb * 2} label="working set" />
                <div class="repl-perf-run-detail">
                  <span>peak {run.peakWorkingSetMb?.toFixed(0) || '-'} MB</span>
                  <span>page {run.pageFileMb?.toFixed(0) || '-'} MB</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div class="repl-perf-timestamp">
        updated {formatTime(metrics.updatedAt ?? (perf?.timestamp ? Date.parse(perf.timestamp) : undefined))}
      </div>
    </div>
  );
}

async function refreshDiagnostics(): Promise<void> {
  appState.setState('metricsSnapshot', {
    ...appState.getState().metricsSnapshot,
    loading: true,
    error: null,
  });
  const [perfSnap, metricsSnap] = await Promise.all([
    tauriBridge.getPerformanceSnapshot(),
    tauriBridge.getMetrics({ includeRuns: true }),
  ]);
  if (perfSnap) appState.setState('performanceSnapshot', perfSnap);
  if (isBackendDiagnosticResult(metricsSnap)) {
    appState.setState('metricsSnapshot', {
      result: null,
      loading: false,
      error: metricsSnap.diagnostic.message,
      updatedAt: Date.now(),
    });
  } else {
    appState.setState('metricsSnapshot', {
      result: metricsSnap,
      loading: false,
      error: null,
      updatedAt: Date.now(),
    });
  }
}

function topToolMetrics(snapshot: WorkbenchRuntimeMetricsSnapshot | undefined): WorkbenchToolNameMetricsSnapshot[] {
  if (!snapshot) return [];
  return Object.values(snapshot.tools.byName ?? {})
    .sort((left, right) => {
      const rightSlow = right.durationMs.p99 ?? right.durationMs.p95 ?? right.durationMs.max ?? 0;
      const leftSlow = left.durationMs.p99 ?? left.durationMs.p95 ?? left.durationMs.max ?? 0;
      return right.errorCount - left.errorCount || rightSlow - leftSlow || right.callCount - left.callCount;
    })
    .slice(0, 6);
}

function cacheHealthTone(snapshot: WorkbenchRuntimeMetricsSnapshot | undefined): 'normal' | 'good' | 'warn' | 'danger' {
  if (!snapshot || snapshot.cache.promptTokens <= 0) return 'normal';
  if (snapshot.cache.hitRatio >= 0.65) return 'good';
  if (snapshot.cache.hitRatio >= 0.25) return 'warn';
  return 'danger';
}

function streamHealthTone(snapshot: WorkbenchRuntimeMetricsSnapshot | undefined): 'normal' | 'good' | 'warn' | 'danger' {
  if (!snapshot) return 'normal';
  const firstText = snapshot.streaming.firstTextDeltaLatencyMs;
  if ((snapshot.streaming.errorCount ?? 0) > 0) return 'danger';
  if (firstText === undefined) return 'normal';
  if (firstText <= 1200) return 'good';
  if (firstText <= 5000) return 'warn';
  return 'danger';
}

function toolHealthTone(snapshot: WorkbenchRuntimeMetricsSnapshot | undefined): 'normal' | 'good' | 'warn' | 'danger' {
  if (!snapshot || snapshot.tools.callCount <= 0) return 'normal';
  if (snapshot.tools.errorRate >= 0.15 || snapshot.tools.timeoutRate >= 0.05) return 'danger';
  if (snapshot.tools.errorRate > 0 || snapshot.tools.timeoutCount > 0) return 'warn';
  return 'good';
}

function latestModelLabel(snapshot: WorkbenchRuntimeMetricsSnapshot): string | undefined {
  const latest = snapshot.latestDimensions;
  const label = latest?.actualModel ?? latest?.configuredModel ?? latest?.modelFamily;
  return label ? shortLabel(label, 28) : undefined;
}

function terminalReasonLabel(snapshot: WorkbenchRuntimeMetricsSnapshot): string | undefined {
  const entries = Object.entries(snapshot.streaming.terminalReasons ?? {});
  if (entries.length === 0) return undefined;
  const [reason, count] = entries.sort((left, right) => right[1] - left[1])[0]!;
  return `${reason} ${count}`;
}

function formatInt(value: number | undefined): string {
  if (!Number.isFinite(value)) return '-';
  return Math.trunc(value as number).toLocaleString();
}

function formatCompact(value: number | undefined): string {
  if (!Number.isFinite(value)) return '-';
  const n = Math.trunc(value as number);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatMs(value: number | undefined): string {
  if (!Number.isFinite(value)) return '-';
  const n = value as number;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(n)}ms`;
}

function formatPercent(value: number | undefined): string {
  if (!Number.isFinite(value)) return '-';
  return `${Math.round((value as number) * 100)}%`;
}

function formatRate(value: number | undefined): string {
  if (!Number.isFinite(value)) return '-';
  return `${(value as number).toFixed((value as number) >= 10 ? 0 : 1)}/s`;
}

function formatTime(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return '-';
  return new Date(value).toLocaleTimeString();
}

function shortLabel(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}
