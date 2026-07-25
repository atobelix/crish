import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { PrometheusExporter } from "../observability/prometheus-exporter.js";
import type { DaemonLifecycleSnapshot } from "../types.js";

export function startHealthServer(
  healthPort: number | undefined,
  getSnapshot: () => DaemonLifecycleSnapshot
): HttpServer | undefined {
  if (!healthPort || healthPort <= 0) return undefined;
  const server = createHttpServer((req, res) => {
    if (req.method !== "GET" || !req.url) { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/health") { res.writeHead(404); res.end(); return; }
    try {
      const snapshot = getSnapshot();
      const healthStatus = snapshot.state === "ready" ? "healthy" : snapshot.state === "degraded" ? "degraded" : "unhealthy";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: healthStatus, uptime: snapshot.uptimeMs,
        providers: { readiness: snapshot.providerReadiness, lastProbeOk: undefined, lastProbeAt: undefined },
        eventStore: snapshot.eventStore, mcp: { readiness: snapshot.mcpReadiness },
        version: process.env.CRISH_BUILD_HASH ?? "unknown",
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "unhealthy", error: (error as Error).message }));
    }
  });
  server.listen(healthPort);
  server.unref();
  return server;
}

export function startMetricsServer(
  metricsPort: number | undefined,
  exporter?: PrometheusExporter
): { server: HttpServer | undefined; exporter: PrometheusExporter | undefined } {
  if (!metricsPort || metricsPort <= 0) return { server: undefined, exporter: undefined };
  const promExporter = exporter ?? new PrometheusExporter();
  const server = createHttpServer((req, res) => {
    if (req.method !== "GET" || !req.url) { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/metrics") { res.writeHead(404); res.end(); return; }
    try {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(promExporter.scrape());
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(`# error: ${(error as Error).message}\n`);
    }
  });
  server.listen(metricsPort);
  server.unref();
  return { server, exporter: promExporter };
}

export function startMetricsFlushLoop(
  exporter: PrometheusExporter | undefined,
  getSnapshot: () => DaemonLifecycleSnapshot
): ReturnType<typeof setInterval> | undefined {
  if (!exporter) return undefined;
  const timer = setInterval(() => exporter.updateLifecycle(getSnapshot()), 60_000);
  timer.unref?.();
  return timer;
}
