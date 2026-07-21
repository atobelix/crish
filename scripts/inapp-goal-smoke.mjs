#!/usr/bin/env node
/**
 * In-app Goal smoke runner (software-internal contract).
 *
 * Philosophy (plans/03):
 * - Prefer real Tauri WebView2 + local daemon, not browser-only Vite ports.
 * - This script is the **orchestration harness**: it documents required steps,
 *   probes daemon health when CRISH_DAEMON_URL is set, and writes a report.
 * - Full UI automation (WebView2) is opt-in via CRISH_TAURI_SMOKE=1 when a
 *   capture helper is available (see tests/capture-tauri.mjs).
 *
 * Usage:
 *   node scripts/inapp-goal-smoke.mjs
 *   $env:CRISH_DAEMON_URL="ws://127.0.0.1:PORT"; node scripts/inapp-goal-smoke.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const reportDir = join(process.cwd(), "perf-report");
const reportPath = join(reportDir, "inapp-goal-smoke.json");

const scenarios = [
  {
    id: "goal-mode-fields",
    title: "run-task carries mode=goal + visibleGoal + maxRounds",
    kind: "contract",
  },
  {
    id: "done-not-force-checklist",
    title: "Model DONE does not force-mark all tasks without L2/L3 evidence",
    kind: "contract",
  },
  {
    id: "approval-timeout-soft-deny",
    title: "Approval timeout softDenies tool without aborting the run",
    kind: "contract",
  },
];

async function probeDaemon(url) {
  if (!url) {
    return { ok: false, skipped: true, reason: "CRISH_DAEMON_URL not set" };
  }
  try {
    // Dynamic import keeps this script runnable without WS dep in bare envs.
    const { default: WebSocket } = await import("ws");
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve({ ok: false, reason: "timeout connecting to daemon" });
      }, 5_000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping", correlationId: "smoke-1" }));
      });
      ws.on("message", (data) => {
        clearTimeout(timer);
        let parsed;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          parsed = { raw: String(data) };
        }
        ws.close();
        resolve({ ok: true, firstMessage: parsed });
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: err?.message ?? String(err) });
      });
    });
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const daemonUrl = process.env.CRISH_DAEMON_URL ?? process.env.CRISH_WS_URL ?? "";
  const tauriSmoke = process.env.CRISH_TAURI_SMOKE === "1";
  const daemon = await probeDaemon(daemonUrl);

  const report = {
    generatedAt: new Date().toISOString(),
    philosophy: "software-internal (Tauri+daemon), not browser-port only",
    daemonUrl: daemonUrl || null,
    daemonProbe: daemon,
    tauriSmokeRequested: tauriSmoke,
    scenarios: scenarios.map((s) => ({
      ...s,
      status: daemon.ok ? "ready-for-manual-or-e2e" : "blocked-no-daemon",
    })),
    nextSteps: [
      "Start crish-desktop (Tauri) with local daemon",
      "Set CRISH_DAEMON_URL to the daemon WebSocket URL",
      "Re-run this script; then exercise /goal in the app with disk oracle checks",
      "Optional: CRISH_TAURI_SMOKE=1 with tests/capture-tauri.mjs for WebView capture",
    ],
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[inapp-goal-smoke] wrote ${reportPath}`);
  console.log(
    `[inapp-goal-smoke] daemon=${daemon.ok ? "ok" : daemon.skipped ? "skipped" : "fail"}`,
  );
  if (!daemon.ok && !daemon.skipped) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
