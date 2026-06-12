#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const args = parseArgs(process.argv.slice(2));
const iterations = positiveInteger(args.iterations ?? args.i, 5, "iterations");
const runtime = String(args.runtime ?? "tsx");
const command = resolveCommand(runtime, args);
const timeoutMs = positiveInteger(args.timeoutMs ?? args.timeout, 20_000, "timeoutMs");
const statusTimeoutMs = positiveInteger(args.statusTimeoutMs, 5_000, "statusTimeoutMs");
const keepLogs = Boolean(args.keepLogs);

const samples = [];
const activeChildren = new Set();
installShutdownHandlers();

for (let index = 0; index < iterations; index++) {
  samples.push(await runSample({ index, command, timeoutMs, statusTimeoutMs, keepLogs }));
}

const failedSamples = samples.filter((sample) => sample.error);
const summary = {
  runtime,
  command: command.display,
  iterations,
  sampleCount: samples.length,
  successCount: samples.length - failedSamples.length,
  failureCount: failedSamples.length,
  failures: failedSamples.map((sample) => ({
    index: sample.index,
    pid: sample.pid,
    port: sample.port,
    error: sample.error,
    stdoutTail: sample.stdoutTail,
    stderrTail: sample.stderrTail
  })),
  samples,
  metrics: {
    readyMs: summarize(samples.map((sample) => sample.readyMs)),
    wsConnectMs: summarize(samples.map((sample) => sample.wsConnectMs)),
    statusRoundTripMs: summarize(samples.map((sample) => sample.statusRoundTripMs)),
    totalMs: summarize(samples.map((sample) => sample.totalMs))
  }
};

console.log(JSON.stringify(summary, null, 2));
if (failedSamples.length > 0) {
  process.exitCode = 1;
}

async function runSample({ index, command, timeoutMs, statusTimeoutMs, keepLogs }) {
  const eventDir = await mkdtemp(join(tmpdir(), `conex-daemon-bench-${index}-`));
  const startedAt = performance.now();
  let readyAt;
  let wsConnectedAt;
  let statusAt;
  let port;
  let pid;
  let stdout = "";
  let stderr = "";
  let ws;
  let settled = false;

  const child = spawn(command.file, command.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      DAEMON_PORT: "0",
      DAEMON_SESSION_EVENT_LOG_DIR: eventDir,
      CONEX_BENCHMARK: "1",
      PATH: process.env.PATH ? `${join(repoRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH}` : join(repoRoot, "node_modules", ".bin")
    },
    shell: command.shell,
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeChildren.add(child);

  const cleanup = async () => {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close(1000, "benchmark complete");
    }
    await stopChild(child);
    activeChildren.delete(child);
    if (!keepLogs) {
      await rm(eventDir, { recursive: true, force: true });
    }
  };

  try {
    const ready = await withTimeout(
      waitForReady(child, {
        onStdout: (chunk) => {
          stdout += chunk;
        },
        onStderr: (chunk) => {
          stderr += chunk;
        }
      }),
      timeoutMs,
      "daemon-ready"
    );
    readyAt = performance.now();
    port = ready.port;
    pid = ready.pid;

    ws = await withTimeout(openClient(port), timeoutMs, "websocket connect");
    wsConnectedAt = performance.now();

    await withTimeout(queryStatus(ws), statusTimeoutMs, "get-status");
    statusAt = performance.now();
    settled = true;

    return {
      index,
      pid,
      port,
      eventDir: keepLogs ? eventDir : undefined,
      readyMs: round(readyAt - startedAt),
      wsConnectMs: round(wsConnectedAt - readyAt),
      statusRoundTripMs: round(statusAt - wsConnectedAt),
      totalMs: round(statusAt - startedAt)
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return {
      index,
      pid,
      port,
      eventDir: keepLogs ? eventDir : undefined,
      error,
      readyMs: readyAt === undefined ? undefined : round(readyAt - startedAt),
      wsConnectMs: readyAt === undefined || wsConnectedAt === undefined ? undefined : round(wsConnectedAt - readyAt),
      statusRoundTripMs: wsConnectedAt === undefined || statusAt === undefined ? undefined : round(statusAt - wsConnectedAt),
      totalMs: round(performance.now() - startedAt),
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr)
    };
  } finally {
    await cleanup();
    if (!settled && !keepLogs) {
      await rm(eventDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function resolveCommand(runtime, args) {
  if (args.cmd) {
    const parsed = splitCommand(String(args.cmd));
    return { file: parsed[0], args: parsed.slice(1), shell: process.platform === "win32", display: parsed.join(" ") };
  }

  if (runtime === "tsx") {
    const cli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const commandArgs = [cli, "--conditions", "development", "packages/agent-daemon/src/index.ts"];
    return { file: process.execPath, args: commandArgs, shell: false, display: `${process.execPath} ${commandArgs.join(" ")}` };
  }

  if (runtime === "node-dist") {
    return {
      file: process.execPath,
      args: ["packages/agent-daemon/dist/index.js"],
      shell: false,
      display: `${process.execPath} packages/agent-daemon/dist/index.js`
    };
  }

  if (runtime === "bun-ts") {
    return {
      file: "bun",
      args: ["--conditions", "development", "packages/agent-daemon/src/index.ts"],
      shell: false,
      display: "bun --conditions development packages/agent-daemon/src/index.ts"
    };
  }

  if (runtime === "bun-compiled") {
    const binary = resolve(String(args.binary ?? join(repoRoot, "packages", "agent-daemon", "dist-bin", process.platform === "win32" ? "agent-daemon-bun.exe" : "agent-daemon-bun")));
    return {
      file: binary,
      args: [],
      shell: false,
      display: binary
    };
  }

  throw new Error(`Unknown runtime "${runtime}". Use tsx, node-dist, bun-ts, bun-compiled, or --cmd.`);
}

function waitForReady(child, hooks) {
  return new Promise((resolveReady, rejectReady) => {
    let stdoutBuffer = "";
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onStdout = (chunk) => {
      const text = chunk.toString("utf8");
      hooks.onStdout(text);
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        const parsed = parseJson(trimmed);
        if (parsed?.type === "daemon-ready" && typeof parsed.port === "number") {
          settle(resolveReady, parsed);
          return;
        }
      }
    };
    const onStderr = (chunk) => {
      hooks.onStderr(chunk.toString("utf8"));
    };
    const onExit = (code, signal) => {
      settle(rejectReady, new Error(`Daemon exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    };
    const onError = (error) => {
      settle(rejectReady, error);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function openClient(port) {
  return new Promise((resolveClient, rejectClient) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => resolveClient(ws));
    ws.once("error", rejectClient);
  });
}

function queryStatus(ws) {
  return new Promise((resolveStatus, rejectStatus) => {
    const requestId = `bench_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const onMessage = (data) => {
      const parsed = parseJson(data.toString("utf8"));
      if (!parsed) return;
      if (parsed.type === "status-response" && parsed.requestId === requestId) {
        cleanup();
        resolveStatus(parsed);
      }
      if (parsed.type === "error" && parsed.requestId === requestId) {
        cleanup();
        rejectStatus(new Error(parsed.error ?? "daemon returned an error"));
      }
    };
    const onClose = (code, reason) => {
      cleanup();
      rejectStatus(new Error(`WebSocket closed before status-response (code=${code}, reason=${reason.toString("utf8")})`));
    };
    const onError = (error) => {
      cleanup();
      rejectStatus(error);
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
    ws.send(JSON.stringify({ type: "get-status", requestId }));
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await taskkillTree(child.pid);
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolveStop();
    }, 1_500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
}

function taskkillTree(pid) {
  return new Promise((resolveKill) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.once("exit", () => resolveKill());
    killer.once("error", () => resolveKill());
  });
}

function installShutdownHandlers() {
  const shutdown = async () => {
    const children = [...activeChildren];
    activeChildren.clear();
    await Promise.allSettled(children.map((child) => stopChild(child)));
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(143));
  });
  process.once("beforeExit", () => {
    void shutdown();
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function positiveInteger(value, fallback, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function splitCommand(command) {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
  if (parts.length === 0) throw new Error("--cmd cannot be empty");
  return parts;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function summarize(values) {
  const clean = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return undefined;
  return {
    min: round(clean[0]),
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    p99: percentile(clean, 0.99),
    max: round(clean[clean.length - 1]),
    mean: round(clean.reduce((sum, value) => sum + value, 0) / clean.length)
  };
}

function percentile(values, rank) {
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1));
  return round(values[index]);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function tail(text, max = 2_000) {
  return text.length <= max ? text : text.slice(-max);
}
