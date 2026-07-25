import type { DaemonLifecycleSnapshot } from "../types.js";

export interface PrometheusMetricValue {
  value: number;
  labels: Record<string, string>;
}

export class PrometheusExporter {
  readonly name = "prometheus";
  private latestSnapshot: DaemonLifecycleSnapshot | undefined;
  private customMetrics: Map<string, PrometheusMetricValue[]> = new Map();
  private helpTexts: Map<string, string> = new Map();
  private typeTexts: Map<string, string> = new Map();

  updateLifecycle(snapshot: DaemonLifecycleSnapshot): void {
    this.latestSnapshot = snapshot;
  }

  setGauge(name: string, value: number, labels?: Record<string, string>, help?: string): void {
    this.customMetrics.set(name, [{ value, labels: labels ?? {} }]);
    if (help) this.helpTexts.set(name, help);
    this.typeTexts.set(name, "gauge");
  }

  setCounter(name: string, value: number, labels?: Record<string, string>, help?: string): void {
    this.customMetrics.set(name, [{ value, labels: labels ?? {} }]);
    if (help) this.helpTexts.set(name, help);
    this.typeTexts.set(name, "counter");
  }

  scrape(): string {
    const lines: string[] = [];
    const s = this.latestSnapshot;

    if (s) {
      this.renderCounters(lines, s);
      this.renderGauges(lines, s);
    }

    for (const [name, values] of this.customMetrics) {
      const help = this.helpTexts.get(name);
      const typ = this.typeTexts.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      if (typ) lines.push(`# TYPE ${name} ${typ}`);
      for (const mv of values) {
        const labels = mv.labels && Object.keys(mv.labels).length > 0 ? `{${Object.entries(mv.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}` : "";
        lines.push(`${name}${labels} ${mv.value}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  private renderCounters(lines: string[], s: DaemonLifecycleSnapshot): void {
    lines.push("# HELP crish_daemon_uptime_seconds Daemon uptime in seconds");
    lines.push("# TYPE crish_daemon_uptime_seconds gauge");
    lines.push(`crish_daemon_uptime_seconds ${s.uptimeMs / 1000}`);

    lines.push("# HELP crish_daemon_connected_clients Current connected clients");
    lines.push("# TYPE crish_daemon_connected_clients gauge");
    lines.push(`crish_daemon_connected_clients ${s.connectedClientCount}`);

    lines.push("# HELP crish_daemon_active_runs Current active runs");
    lines.push("# TYPE crish_daemon_active_runs gauge");
    lines.push(`crish_daemon_active_runs ${s.activeRunCount}`);

    lines.push("# HELP crish_daemon_state Daemon lifecycle state");
    lines.push("# TYPE crish_daemon_state gauge");
    const stateValues: Record<string, number> = {
      starting: s.state === "starting" ? 1 : 0,
      ready: s.state === "ready" ? 1 : 0,
      stopping: s.state === "stopping" ? 1 : 0,
      stopped: s.state === "stopped" ? 1 : 0,
      degraded: s.state === "degraded" ? 1 : 0,
    };
    for (const [st, v] of Object.entries(stateValues)) {
      lines.push(`crish_daemon_state{state="${st}"} ${v}`);
    }

    const mem = process.memoryUsage();
    lines.push("# HELP crish_runtime_memory_bytes Current runtime memory usage in bytes");
    lines.push("# TYPE crish_runtime_memory_bytes gauge");
    lines.push(`crish_runtime_memory_bytes{type="rss"} ${mem.rss}`);
    lines.push(`crish_runtime_memory_bytes{type="heapTotal"} ${mem.heapTotal}`);
    lines.push(`crish_runtime_memory_bytes{type="heapUsed"} ${mem.heapUsed}`);
    lines.push(`crish_runtime_memory_bytes{type="external"} ${mem.external}`);
  }

  private renderGauges(lines: string[], _s: DaemonLifecycleSnapshot): void {
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
