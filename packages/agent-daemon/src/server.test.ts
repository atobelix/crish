// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import WebSocket, { type RawData } from "ws";
import { DaemonServer } from "./server";
import { DaemonClientRegistry } from "./daemon-client-registry";
import { WORKFLOW_STORE_VERSION } from "./workflow-store";
import type { WorkflowDefinition, WorkflowRunEntry, WorkflowRunStatus } from "./types";
import {
  CheckpointManifestService,
  ConversationBoundaryManifestService,
  JsonlMemoryStore,
  McpLifecycleManager,
  createWorkspaceCheckpoint,
  createScriptedProvider,
  type AgentProvider,
  type AgentProviderRequest,
  type AgentTool,
  type ProviderStreamEvent,
} from "@crish/agent-runtime";
import { removeTempDirs } from "./test-temp-cleanup";

const execFileAsync = promisify(execFile);
let server: DaemonServer | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await removeTempDirs(tempDirs);
});

describe("DaemonServer orchestrated runs", () => {
  it("returns NO_PROVIDER without starting a run when provider factory is missing", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_missing_provider",
        sessionId: "session_missing_provider",
        prompt: "hello"
      })
    );

    const messages = await collectMessages(ws, (message) => message.type === "error");
    expect(messages.at(-1)).toMatchObject({
      type: "error",
      code: "NO_PROVIDER",
      runId: "run_missing_provider"
    });
    await expect(server.readRunEvents("run_missing_provider")).resolves.toEqual([]);

    ws.close();
  });

  it("streams runtime events through the orchestrator with the requested session id", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => new TextProvider("hello from daemon"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_daemon_test",
        sessionId: "session_daemon_test",
        prompt: "hello"
      })
    );

    const messages = await collectMessages(ws, (message) => {
      return message.type === "event" && message.event?.type === "agent-end";
    });

    const runtimeEvents = messages.filter((message) => message.type === "event").map((message) => message.event);
    expect(runtimeEvents.map((event) => event.type)).toContain("agent-start");
    expect(runtimeEvents.map((event) => event.type)).toContain("agent-end");
    expect(runtimeEvents.every((event) => event.sessionId === "session_daemon_test")).toBe(true);
    await waitForPersistedRunEvent(server, "run_daemon_test", "run-completed");

    ws.close();
  });

  it("measures daemon streaming first token, throughput, and cancel latency with a local provider", async () => {
    const tokens = Array.from({ length: 16 }, (_, index) => `tok${index} `);
    const expectedText = tokens.join("");
    const provider = new PacedTokenProvider({
      tokens,
      firstDelayMs: 5,
      tokenDelayMs: 2,
    });
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => provider);
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    const runStartedAt = performance.now();
    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_stream_bench_smoke",
        sessionId: "session_stream_bench_smoke",
        prompt: "stream benchmark smoke"
      })
    );

    const messages = await collectMessages(ws, (message) => {
      return message.type === "event" && message.event?.type === "agent-end";
    });
    const totalMs = performance.now() - runStartedAt;
    const textDeltas = messages.filter((message) => isTextDeltaMessage(message));
    const aggregatedText = textFromTextDeltaMessages(textDeltas);
    const firstTextDelta = textDeltas[0]!;
    const firstTokenMs = firstTextDelta.receivedAt - runStartedAt;
    const tokensPerSecond = textDeltas.length / Math.max(totalMs / 1000, 0.001);
    const eventsPerSecond = messages.length / Math.max(totalMs / 1000, 0.001);
    const terminalEvent = messages.find((message) => message.type === "event" && message.event?.type === "agent-end");
    const providerDiagnostics = messages.filter((message) => message.type === "event" && message.event?.type === "provider-diagnostic");
    const streamEndDiagnostic = providerDiagnostics.find((message) => message.event.diagnostic?.phase === "stream-end");

    expect(Number.isFinite(firstTokenMs)).toBe(true);
    expect(Number.isFinite(tokensPerSecond)).toBe(true);
    expect(Number.isFinite(eventsPerSecond)).toBe(true);
    expect(firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(firstTokenMs).toBeLessThanOrEqual(totalMs);
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.length).toBeLessThanOrEqual(tokens.length);
    expect(aggregatedText).toBe(expectedText);
    expect(tokensPerSecond).toBeGreaterThan(0);
    expect(eventsPerSecond).toBeGreaterThan(0);
    expect(terminalEvent).toMatchObject({ event: { type: "agent-end", reason: "stop" } });
    expect(providerDiagnostics).toHaveLength(2);
    expect(providerDiagnostics.every((message) => message.event.diagnostic?.providerId === "paced-token-provider")).toBe(true);
    expect(streamEndDiagnostic).toMatchObject({
      event: {
        diagnostic: {
          phase: "stream-end",
          providerId: "paced-token-provider",
          endpoint: "test-stream",
          chunks: tokens.length,
        },
      },
    });

    const cancelProvider = new PacedTokenProvider({
      tokens: Array.from({ length: 128 }, (_, index) => `cancel${index} `),
      firstDelayMs: 5,
      tokenDelayMs: 20,
    });
    server.setProviderFactory(() => cancelProvider);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_stream_bench_cancel",
        sessionId: "session_stream_bench_cancel",
        prompt: "stream benchmark cancel"
      })
    );
    // 等待 turn-start 事件，确�?cancel-run �?provider streaming 期间被发�?
    await collectMessages(ws, (message) => {
      return message.type === "event" && message.runId === "run_stream_bench_cancel" && message.event?.type === "turn-start";
    });

    const cancelStartedAt = performance.now();
    ws.send(JSON.stringify({ type: "cancel-run", runId: "run_stream_bench_cancel" }));
    const cancelledEvents = await waitForPersistedRunEvent(server, "run_stream_bench_cancel", "run-cancelled");
    const cancelLatencyMs = performance.now() - cancelStartedAt;
    const cancelledProviderEvents = cancelledEvents.filter((event) => event.type === "runtime-event");

    expect(cancelProvider.abortObserved).toBe(true);
    expect(cancelLatencyMs).toBeGreaterThanOrEqual(0);
    expect(cancelLatencyMs).toBeLessThan(2_000);
    expect(cancelledEvents.map((event) => event.type)).toContain("run-cancel-requested");
    expect(cancelledProviderEvents.length).toBeGreaterThan(0);

    ws.close();
  });

  it("returns git status with staged, unstaged, and untracked file summaries", async () => {
    const repo = await tempGitWorkspace();
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Crish Test"]);
    await writeFile(join(repo, "tracked.txt"), "base\n", "utf8");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "initial"]);
    await writeFile(join(repo, "tracked.txt"), "base\nunstaged\n", "utf8");
    await writeFile(join(repo, "staged.txt"), "staged\n", "utf8");
    await git(repo, ["add", "staged.txt"]);
    await writeFile(join(repo, "untracked.txt"), "untracked\n", "utf8");

    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir(), defaultCwd: repo });
    const port = await server.start();
    const ws = await openClient(port);

    const response = (
      await sendAndCollectMessages(
        ws,
        { type: "git-status", cwd: repo, requestId: "git-status-1" },
        (message) => message.type === "git-status-response" && message.requestId === "git-status-1"
      )
    ).at(-1);

    expect(response).toMatchObject({
      type: "git-status-response",
      cwd: repo,
      found: true,
      repositoryRoot: repo,
      clean: false,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 1,
      conflictedCount: 0,
    });
    expect(response.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "tracked.txt",
          status: "M",
          staged: false,
          unstaged: true,
          untracked: false,
        }),
        expect.objectContaining({
          path: "staged.txt",
          status: "A",
          staged: true,
          unstaged: false,
          untracked: false,
        }),
        expect.objectContaining({
          path: "untracked.txt",
          status: "?",
          staged: false,
          unstaged: false,
          untracked: true,
        }),
      ])
    );

    ws.close();
  });

  it("returns found false for git status outside a repository", async () => {
    const cwd = await tempGitWorkspace("daemon-git-status-outside-");
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir(), defaultCwd: cwd });
    const port = await server.start();
    const ws = await openClient(port);

    const response = (
      await sendAndCollectMessages(
        ws,
        { type: "git-status", cwd, requestId: "git-status-missing" },
        (message) => message.type === "git-status-response" && message.requestId === "git-status-missing"
      )
    ).at(-1);

    expect(response).toMatchObject({
      type: "git-status-response",
      cwd,
      found: false,
      files: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
    });
    expect(response.reason).toBeTruthy();

    ws.close();
  });

  it("returns git diff patch and changed file records", async () => {
    const repo = await tempGitWorkspace();
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Crish Test"]);
    await writeFile(join(repo, "tracked.txt"), "base\n", "utf8");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "initial"]);
    await writeFile(join(repo, "tracked.txt"), "base\nafter\n", "utf8");

    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir(), defaultCwd: repo });
    const port = await server.start();
    const ws = await openClient(port);

    const response = (
      await sendAndCollectMessages(
        ws,
        {
          type: "git-diff",
          cwd: repo,
          path: "tracked.txt",
          requestId: "git-diff-1",
        },
        (message) => message.type === "git-diff-response" && message.requestId === "git-diff-1"
      )
    ).at(-1);

    expect(response).toMatchObject({
      type: "git-diff-response",
      cwd: repo,
      repositoryRoot: repo,
      path: "tracked.txt",
      staged: false,
      files: [{ path: "tracked.txt", status: "M" }],
    });
    expect(response.unified).toContain(" base");
    expect(response.unified).toContain("+after");
    expect(response.stat).toContain("tracked.txt");

    ws.close();
  });

  it("keeps daemon-owned chat runs alive after the originating WebSocket disconnects", { timeout: 30_000 }, async () => {
    const provider = new ReleasableTextProvider("finished after reconnect");
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => provider);
    server.setToolFactory(() => []);
    const port = await server.start();
    const first = await openClient(port);

    first.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_disconnect_safe_chat",
        sessionId: "session_disconnect_safe_chat",
        prompt: "survive disconnect"
      })
    );
    await collectMessages(first, (message) => {
      return message.type === "event" && message.runId === "run_disconnect_safe_chat" && message.event?.type === "agent-start";
    });

    await closeClient(first, 1000, "workbench closed");
    const second = await openClient(port);
    const activeStatus = (
      await sendAndCollectMessages(second, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(activeStatus.activeRuns).toEqual([
      expect.objectContaining({
        runId: "run_disconnect_safe_chat",
        status: "running",
      }),
    ]);
    expect(activeStatus.lifecycle.recentError).toMatchObject({
      code: "RUN_STREAM_SUBSCRIPTION_LOST",
      source: "websocket",
      severity: "warning",
      metadata: {
        runId: "run_disconnect_safe_chat",
        sessionId: "session_disconnect_safe_chat",
      },
    });

    provider.release();
    const persistedRunEvents = await waitForPersistedRunEvent(server, "run_disconnect_safe_chat", "run-completed");
    const eventTypes = persistedRunEvents.map((event) => event.type);
    expect(eventTypes).toContain("run-completed");
    expect(eventTypes).not.toContain("run-cancelled");
    expect(JSON.stringify(persistedRunEvents)).not.toContain("client-disconnected");

    const replay = (
      await sendAndCollectMessages(
        second,
        {
          type: "read-run-events",
          runId: "run_disconnect_safe_chat",
          afterSequence: 0,
          includeSnapshot: true
        },
        (message) => message.type === "run-events"
      )
    ).at(-1);
    expect(replay.events).toEqual(persistedRunEvents);
    expect(replay.snapshot).toMatchObject({
      runId: "run_disconnect_safe_chat",
      sessionId: "session_disconnect_safe_chat",
      status: "completed",
    });

    second.close();
  });

  it("keeps explicit cancel-run as a daemon-owned cancellation boundary", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => new BlockingProvider());
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_explicit_cancel_boundary",
        sessionId: "session_explicit_cancel_boundary",
        prompt: "cancel me"
      })
    );
    await collectMessages(ws, (message) => {
      return message.type === "event" && message.runId === "run_explicit_cancel_boundary" && message.event?.type === "agent-start";
    });

    ws.send(JSON.stringify({ type: "cancel-run", runId: "run_explicit_cancel_boundary" }));

    const runEvents = await waitForPersistedRunEvent(server, "run_explicit_cancel_boundary", "run-cancelled");
    expect(runEvents.map((event) => event.type)).toContain("run-cancel-requested");
    expect(JSON.stringify(runEvents)).not.toContain("client-disconnected");

    const status = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(status.activeRuns.map((run: any) => run.runId)).not.toContain("run_explicit_cancel_boundary");

    ws.close();
  });

  it("registers run_subagent and broadcasts bridged child runtime events", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory((runId) => {
      if (runId === "run_parent_subagent") {
        return createScriptedProvider([
          [
            {
              type: "tool-call",
              id: "call_subagent",
              toolName: "run_subagent",
              input: {
                prompt: "child work",
                description: "child task",
                mode: "research"
              }
            },
            { type: "stop", reason: "tool-call" }
          ],
          [{ type: "text-delta", text: "parent saw child result" }, { type: "stop", reason: "stop" }]
        ]);
      }

      return createScriptedProvider([[{ type: "text-delta", text: "child result" }, { type: "stop", reason: "stop" }]]);
    });
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_parent_subagent",
        sessionId: "session_parent_subagent",
        prompt: "delegate"
      })
    );

    const messages = await collectMessages(ws, (message) => {
      return message.type === "event" && message.event?.type === "agent-end";
    });

    const started = messages.find((message) => message.type === "subagent-started");
    const ended = messages.find((message) => message.type === "subagent-ended");
    const subagentEvents = messages.filter((message) => message.type === "subagent-event");
    const runtimeEvents = messages.filter((message) => message.type === "event").map((message) => message.event);

    expect(started).toMatchObject({
      type: "subagent-started",
      runId: "run_parent_subagent",
      parentToolCallId: "call_subagent",
      description: "child task",
      mode: "research"
    });
    expect(started.subagentRunId).not.toBe("run_parent_subagent");
    expect(started.subagentId).not.toBe("session_parent_subagent");
    expect(subagentEvents.map((message) => message.event.type)).toContain("agent-start");
    expect(subagentEvents.map((message) => message.event.type)).toContain("agent-end");
    expect(ended).toMatchObject({
      type: "subagent-ended",
      runId: "run_parent_subagent",
      subagentRunId: started.subagentRunId,
      subagentId: started.subagentId,
      status: "completed"
    });
    expect(runtimeEvents.some((event) => event.type === "tool-start" && event.call.toolName === "run_subagent")).toBe(true);
    expect(runtimeEvents.some((event) => event.type === "tool-update" && event.update.json?.kind === "daemon-subagent-runtime")).toBe(true);

    const childRunEvents = await waitForPersistedRunEvent(server, started.subagentRunId, "run-completed");
    expect(childRunEvents.map((event) => event.type)).toContain("runtime-event");

    ws.close();
  });

  it("restores session and run events from the same event log after restart", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    server = new DaemonServer({ port: 0, sessionEventLogDir });
    server.setProviderFactory(() => new TextProvider("persisted hello"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_daemon_persist",
        sessionId: "session_daemon_persist",
        prompt: "persist"
      })
    );

    await collectMessages(ws, (message) => {
      return message.type === "event" && message.event?.type === "agent-end";
    });
    ws.close();

    const runEventsBefore = await waitForPersistedRunEvent(server, "run_daemon_persist", "run-completed");
    const sessionEventsBefore = await server.readSessionEvents("session_daemon_persist");
    const logText = await readFile(server.getEventLogPath(), "utf8");
    expect(logText).toContain("\"type\":\"orchestrator-event-store\"");
    expect(runEventsBefore.map((event) => event.type)).toContain("runtime-event");
    expect(sessionEventsBefore.map((event) => event.type)).toContain("session-created");

    await server.stop();
    server = undefined;

    server = new DaemonServer({ port: 0, sessionEventLogDir });
    await server.start();

    await expect(server.readSessionEvents("session_daemon_persist")).resolves.toEqual(sessionEventsBefore);
    await expect(server.readRunEvents("run_daemon_persist")).resolves.toEqual(runEventsBefore);
  });

  it("lists sessions and runs and replays events through websocket queries after restart", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    server = new DaemonServer({ port: 0, sessionEventLogDir });
    server.setProviderFactory(() => new TextProvider("query hello"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_daemon_query",
        sessionId: "session_daemon_query",
        prompt: "query"
      })
    );

    await collectMessages(ws, (message) => {
      return message.type === "event" && message.event?.type === "agent-end";
    });
    const persistedRunEvents = await waitForPersistedRunEvent(server, "run_daemon_query", "run-completed");

    const sessionsListed = (
      await sendAndCollectMessages(ws, { type: "list-sessions" }, (message) => message.type === "sessions-listed")
    ).at(-1);
    expect(sessionsListed.sessions.map((session: any) => session.id)).toContain("session_daemon_query");

    const runsListed = (
      await sendAndCollectMessages(
        ws,
        { type: "list-runs", sessionId: "session_daemon_query" },
        (message) => message.type === "runs-listed"
      )
    ).at(-1);
    expect(runsListed).toMatchObject({ type: "runs-listed", sessionId: "session_daemon_query" });
    expect(runsListed.runs.map((run: any) => run.id)).toContain("run_daemon_query");

    const sessionEvents = (
      await sendAndCollectMessages(
        ws,
        { type: "read-session-events", sessionId: "session_daemon_query", afterSequence: 0 },
        (message) => message.type === "session-events"
      )
    ).at(-1);
    expect(sessionEvents.eventLog).toMatchObject({
      eventLogId: expect.stringMatching(/^eventlog_/),
      generation: 1,
      schemaVersion: 1,
      protocolVersion: 1,
    });
    expect(sessionEvents.events.map((event: any) => event.type)).toContain("session-created");
    expect(sessionEvents.events.map((event: any) => event.type)).toContain("run-completed");

    const firstSessionEvent = sessionEvents.events[0];
    const replayAfterEventId = (
      await sendAndCollectMessages(
        ws,
        {
          type: "read-session-events",
          sessionId: "session_daemon_query",
          lastEventId: firstSessionEvent.id
        },
        (message) => message.type === "session-events"
      )
    ).at(-1);
    expect(replayAfterEventId.afterSequence).toBe(firstSessionEvent.sequence);
    expect(replayAfterEventId.events.every((event: any) => event.sequence > firstSessionEvent.sequence)).toBe(true);

    const firstRunEvent = persistedRunEvents[0]!;
    const replayAfterSequence = (
      await sendAndCollectMessages(
        ws,
        {
          type: "read-run-events",
          runId: "run_daemon_query",
          afterSequence: firstRunEvent.sequence
        },
        (message) => message.type === "run-events"
      )
    ).at(-1);
    expect(replayAfterSequence.eventLog).toEqual(sessionEvents.eventLog);
    expect(replayAfterSequence.events).toEqual(
      persistedRunEvents.filter((event) => event.sequence > firstRunEvent.sequence)
    );

    const replayWithStaleCursor = (
      await sendAndCollectMessages(
        ws,
        {
          type: "read-run-events",
          runId: "run_daemon_query",
          afterSequence: firstRunEvent.sequence,
          cursor: {
            eventLogId: "eventlog_stale",
            generation: 1,
            schemaVersion: 1,
            protocolVersion: 1,
            afterSequence: firstRunEvent.sequence,
          },
        },
        (message) => message.type === "run-events"
      )
    ).at(-1);
    expect(replayWithStaleCursor).toMatchObject({
      afterSequence: 0,
      cursorDiagnostic: {
        code: "EVENT_LOG_CURSOR_MISMATCH",
        current: sessionEvents.eventLog,
        replayedFromSequence: 0,
      },
    });
    expect(replayWithStaleCursor.events).toEqual(persistedRunEvents);

    const invalidCursor = (
      await sendAndCollectMessages(
        ws,
        {
          type: "read-run-events",
          runId: "run_daemon_query",
          lastEventId: "event_missing"
        },
        (message) => message.type === "error" && message.code === "INVALID_CURSOR"
      )
    ).at(-1);
    expect(invalidCursor).toMatchObject({
      type: "error",
      code: "INVALID_CURSOR",
      runId: "run_daemon_query"
    });

    ws.close();
    await server.stop();
    server = undefined;

    server = new DaemonServer({ port: 0, sessionEventLogDir });
    const restartedPort = await server.start();
    const restartedWs = await openClient(restartedPort);

    const restartedRunEvents = (
      await sendAndCollectMessages(
        restartedWs,
        { type: "read-run-events", runId: "run_daemon_query", afterSequence: 0 },
        (message) => message.type === "run-events"
      )
    ).at(-1);
    expect(restartedRunEvents.events).toEqual(persistedRunEvents);

    const restartedSessions = (
      await sendAndCollectMessages(
        restartedWs,
        { type: "list-sessions" },
        (message) => message.type === "sessions-listed"
      )
    ).at(-1);
    expect(restartedSessions.sessions.map((session: any) => session.id)).toContain("session_daemon_query");

    const restartedRuns = (
      await sendAndCollectMessages(
        restartedWs,
        { type: "list-runs", sessionId: "session_daemon_query" },
        (message) => message.type === "runs-listed"
      )
    ).at(-1);
    expect(restartedRuns.runs.map((run: any) => run.id)).toContain("run_daemon_query");

    restartedWs.close();
  });

  it("persists daemon-owned pending input queue commands", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    server = new DaemonServer({ port: 0, sessionEventLogDir });
    server.setProviderFactory(() => new TextProvider("pending input setup"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_pending_setup",
        sessionId: "session_pending_queue",
        prompt: "setup"
      })
    );
    await collectMessages(ws, (message) => message.type === "event" && message.event?.type === "agent-end");

    const queued = (
      await sendAndCollectMessages(
        ws,
        {
          type: "enqueue-pending-input",
          inputId: "pending_daemon_1",
          sessionId: "session_pending_queue",
          runId: "run_pending_setup",
          text: "continue after this run",
          mode: "after-current-run"
        },
        (message) => message.type === "pending-input-queued"
      )
    ).at(-1);
    expect(queued).toMatchObject({
      type: "pending-input-queued",
      input: {
        id: "pending_daemon_1",
        sessionId: "session_pending_queue",
        runId: "run_pending_setup",
        text: "continue after this run",
        status: "pending"
      },
      event: {
        type: "pending-input-created"
      }
    });

    const listed = (
      await sendAndCollectMessages(
        ws,
        { type: "list-pending-inputs", sessionId: "session_pending_queue" },
        (message) => message.type === "pending-inputs-listed"
      )
    ).at(-1);
    expect(listed.inputs).toEqual([queued.input]);

    const sessionsListed = (
      await sendAndCollectMessages(ws, { type: "list-sessions" }, (message) => message.type === "sessions-listed")
    ).at(-1);
    expect(sessionsListed.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session_pending_queue",
          pendingInputCount: 1
        })
      ])
    );

    const cancelled = (
      await sendAndCollectMessages(
        ws,
        { type: "cancel-pending-input", inputId: "pending_daemon_1", sessionId: "session_pending_queue" },
        (message) => message.type === "pending-input-cancelled"
      )
    ).at(-1);
    expect(cancelled).toMatchObject({
      type: "pending-input-cancelled",
      input: {
        id: "pending_daemon_1",
        status: "cancelled"
      }
    });

    const queuedForDispatch = (
      await sendAndCollectMessages(
        ws,
        {
          type: "enqueue-pending-input",
          inputId: "pending_daemon_2",
          sessionId: "session_pending_queue",
          text: "dispatch into next run",
          mode: "after-current-run"
        },
        (message) => message.type === "pending-input-queued"
      )
    ).at(-1);
    expect(queuedForDispatch.input).toMatchObject({
      id: "pending_daemon_2",
      status: "pending"
    });

    const dispatched = (
      await sendAndCollectMessages(
        ws,
        {
          type: "dispatch-pending-input",
          inputId: "pending_daemon_2",
          sessionId: "session_pending_queue",
          targetRunId: "run_pending_next"
        },
        (message) => message.type === "pending-input-dispatched"
      )
    ).at(-1);
    expect(dispatched).toMatchObject({
      type: "pending-input-dispatched",
      input: {
        id: "pending_daemon_2",
        status: "dispatched",
        runId: "run_pending_next"
      },
      event: {
        type: "pending-input-dispatched",
        runId: "run_pending_next"
      }
    });

    const empty = (
      await sendAndCollectMessages(
        ws,
        { type: "list-pending-inputs", sessionId: "session_pending_queue" },
        (message) => message.type === "pending-inputs-listed"
      )
    ).at(-1);
    expect(empty.inputs).toEqual([]);

    ws.close();
  });

  it("serves scoped context CRUD and resolve through websocket protocol", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    const port = await server.start();
    const ws = await openClient(port);

    const upserted = (
      await sendAndCollectMessages(
        ws,
        { type: "upsert-scoped-context", record: scopedContextRecord("server-rule", "enabled") },
        (message) => message.type === "scoped-context-upserted"
      )
    ).at(-1);
    expect(upserted).toMatchObject({
      type: "scoped-context-upserted",
      record: { id: "server-rule" },
      persisted: true,
    });

    const listed = (
      await sendAndCollectMessages(
        ws,
        { type: "get-scoped-context", scope: "project" },
        (message) => message.type === "scoped-context-response"
      )
    ).at(-1);
    expect(listed.records.map((record: { id: string }) => record.id)).toEqual(["server-rule"]);

    const resolved = (
      await sendAndCollectMessages(
        ws,
        {
          type: "resolve-scoped-context",
          cwd: "C:/workspace/crish",
          projectRoot: "C:/workspace/crish",
        },
        (message) => message.type === "scoped-context-resolved"
      )
    ).at(-1);
    expect(resolved.stableContext.map((block: { id: string }) => block.id)).toEqual([
      "scoped-context:rules",
    ]);
    expect(resolved.stableContextHash).toMatch(/^[a-f0-9]{64}$/);

    const deleted = (
      await sendAndCollectMessages(
        ws,
        { type: "delete-scoped-context", recordId: "server-rule" },
        (message) => message.type === "scoped-context-deleted"
      )
    ).at(-1);
    expect(deleted).toMatchObject({ recordId: "server-rule", deleted: true });

    ws.close();
  });

  it("resolves project scoped context resources through websocket protocol without auto-enabling skills", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    const projectRoot = await mkdtemp(join(tmpdir(), "daemon-scoped-project-"));
    tempDirs.push(projectRoot);
    await mkdir(join(projectRoot, ".conex", "skills", "reviewer"), { recursive: true });
    await writeFile(
      join(projectRoot, "AGENTS.md"),
      ["---", "id: ws-project-rule", "title: WebSocket Project Rule", "---", "Use the daemon product path."].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, ".conex", "skills", "reviewer", "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Review daemon architecture",
        "---",
        "# Reviewer",
        "Review daemon architecture carefully.",
      ].join("\n"),
      "utf8"
    );

    server = new DaemonServer({ port: 0, sessionEventLogDir });
    const port = await server.start();
    const ws = await openClient(port);

    const recommended = (
      await sendAndCollectMessages(
        ws,
        { type: "resolve-scoped-context", cwd: projectRoot, projectRoot },
        (message) => message.type === "scoped-context-resolved"
      )
    ).at(-1);
    const skillId = recommended.recommended.find((item: { kind: string }) => item.kind === "skill")?.id;

    expect(JSON.stringify(recommended.stableContext)).toContain("Use the daemon product path.");
    expect(JSON.stringify(recommended.stableContext)).not.toContain("Review daemon architecture carefully.");
    expect(recommended).toMatchObject({
      status: "ok",
      storeRecordCount: 0,
      resourceRecordCount: 2,
      resourceDiagnostics: [],
    });
    expect(skillId).toEqual(expect.any(String));

    const enabled = (
      await sendAndCollectMessages(
        ws,
        {
          type: "resolve-scoped-context",
          cwd: projectRoot,
          projectRoot,
          userEnabledIds: [skillId],
        },
        (message) => message.type === "scoped-context-resolved"
      )
    ).at(-1);

    expect(JSON.stringify(enabled.stableContext)).toContain("Use the daemon product path.");
    expect(JSON.stringify(enabled.stableContext)).toContain("Review daemon architecture carefully.");
    expect(enabled.recommended).toEqual([]);

    ws.close();
  });

  it("serves plan document CRUD through websocket protocol with typed failures", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    server = new DaemonServer({ port: 0, sessionEventLogDir });
    const port = await server.start();
    const ws = await openClient(port);

    const created = (
      await sendAndCollectMessages(
        ws,
        {
          type: "create-plan-document",
          id: "plan_server",
          title: "Server plan",
          goal: "Persist daemon-owned editable plan documents.",
          steps: [{ id: "step_store", title: "Wire store" }],
          requestId: "plan-create",
        },
        (message) => message.type === "plan-document-created" && message.requestId === "plan-create"
      )
    ).at(-1);
    expect(created).toMatchObject({
      type: "plan-document-created",
      document: {
        id: "plan_server",
        version: 1,
        steps: [{ id: "step_store", status: "pending" }],
      },
    });

    const listed = (
      await sendAndCollectMessages(
        ws,
        { type: "list-plan-documents", requestId: "plan-list" },
        (message) => message.type === "plan-documents-listed" && message.requestId === "plan-list"
      )
    ).at(-1);
    expect(listed.documents).toMatchObject([{ id: "plan_server", steps: { total: 1 } }]);

    const patched = (
      await sendAndCollectMessages(
        ws,
        {
          type: "patch-plan-document",
          documentId: "plan_server",
          patch: {
            expectedVersion: 1,
            operations: [{ op: "update-step", id: "step_store", update: { status: "completed" } }],
          },
          requestId: "plan-patch",
        },
        (message) => message.type === "plan-document-patched" && message.requestId === "plan-patch"
      )
    ).at(-1);
    expect(patched).toMatchObject({
      type: "plan-document-patched",
      document: {
        id: "plan_server",
        version: 2,
        steps: [{ id: "step_store", status: "completed" }],
      },
    });

    const stale = (
      await sendAndCollectMessages(
        ws,
        {
          type: "patch-plan-document",
          documentId: "plan_server",
          patch: { expectedVersion: 1, operations: [{ op: "set-title", title: "Stale title" }] },
          requestId: "plan-stale",
        },
        (message) => message.type === "error" && message.requestId === "plan-stale"
      )
    ).at(-1);
    expect(stale).toMatchObject({
      type: "error",
      code: "PLAN_DOCUMENT_CONFLICT",
    });

    const fetched = (
      await sendAndCollectMessages(
        ws,
        { type: "get-plan-document", documentId: "plan_server", requestId: "plan-get" },
        (message) => message.type === "plan-document" && message.requestId === "plan-get"
      )
    ).at(-1);
    expect(fetched.document).toMatchObject({ id: "plan_server", version: 2 });

    const deleted = (
      await sendAndCollectMessages(
        ws,
        { type: "delete-plan-document", documentId: "plan_server", requestId: "plan-delete" },
        (message) => message.type === "plan-document-deleted" && message.requestId === "plan-delete"
      )
    ).at(-1);
    expect(deleted).toMatchObject({
      type: "plan-document-deleted",
      documentId: "plan_server",
    });

    const missing = (
      await sendAndCollectMessages(
        ws,
        { type: "get-plan-document", documentId: "plan_server", requestId: "plan-missing" },
        (message) => message.type === "error" && message.requestId === "plan-missing"
      )
    ).at(-1);
    expect(missing).toMatchObject({
      type: "error",
      code: "PLAN_DOCUMENT_NOT_FOUND",
    });

    ws.close();
    await server.stop();
    server = undefined;

    server = new DaemonServer({ port: 0, sessionEventLogDir });
    const restartedPort = await server.start();
    const restartedWs = await openClient(restartedPort);
    const restartedList = (
      await sendAndCollectMessages(
        restartedWs,
        { type: "list-plan-documents" },
        (message) => message.type === "plan-documents-listed"
      )
    ).at(-1);
    expect(restartedList.documents).toEqual([]);

    restartedWs.close();
  });

  it("creates requirements alignment plans through the plan document store", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    const port = await server.start();
    const ws = await openClient(port);

    const created = (
      await sendAndCollectMessages(
        ws,
        {
          type: "create-requirements-alignment-plan",
          id: "alignment_plan",
          title: "Backend alignment",
          goal: "Align daemon backend scope before implementation.",
          context: "User wants product-grade backend reliability.",
          questions: ["Which workflow path should ship first?"],
          assumptions: ["Daemon is the product state source."],
          acceptance: ["Open questions are tracked before execution."],
          risks: ["Unclear scope creates throwaway work."],
          source: "slash-command",
          metadata: { sessionId: "session_alignment" },
          requestId: "alignment-create",
        },
        (message) => message.type === "plan-document-created" && message.requestId === "alignment-create"
      )
    ).at(-1);

    expect(created).toMatchObject({
      type: "plan-document-created",
      document: {
        id: "alignment_plan",
        title: "Backend alignment",
        goal: "Align daemon backend scope before implementation.",
        status: "aligning",
        questions: [
          {
            id: "question_1",
            question: "Which workflow path should ship first?",
            status: "open",
            source: { kind: "slash-command" },
          },
        ],
        assumptions: [
          {
            id: "assumption_1",
            text: "Daemon is the product state source.",
            status: "proposed",
            source: { kind: "slash-command" },
          },
        ],
        acceptance: [
          {
            id: "acceptance_1",
            text: "Open questions are tracked before execution.",
            status: "pending",
            source: { kind: "slash-command" },
          },
        ],
        risks: [
          {
            id: "risk_1",
            title: "Unclear scope creates throwaway work.",
            severity: "medium",
            status: "open",
            source: { kind: "slash-command" },
          },
        ],
        metadata: {
          mode: "requirements-alignment",
          source: "slash-command",
          context: "User wants product-grade backend reliability.",
          sessionId: "session_alignment",
        },
      },
    });

    const listed = (
      await sendAndCollectMessages(
        ws,
        { type: "list-plan-documents" },
        (message) => message.type === "plan-documents-listed"
      )
    ).at(-1);
    expect(listed.documents.map((document: { id: string }) => document.id)).toContain("alignment_plan");

    ws.close();
  });

  it("applies update-config messages through the daemon config handler", async () => {
    const updates: unknown[] = [];
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => new TextProvider("ok"));
    server.setConfigUpdateHandler((update) => updates.push(update));
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "update-config",
        apiKey: "test-key",
        baseUrl: "https://example.test",
        model: "test-model",
        credentialMode: "direct",
        endpoint: "responses",
        stream: true
      })
    );

    const messages = await collectMessages(ws, (message) => message.type === "config-updated");
    expect(messages.at(-1)).toMatchObject({
      type: "config-updated",
      updatedFields: ["apiKey", "baseUrl", "model", "credentialMode", "endpoint", "stream"]
    });
    expect(updates).toEqual([
      {
        apiKey: "test-key",
        baseUrl: "https://example.test",
        model: "test-model",
        credentialMode: "direct",
        endpoint: "responses",
        stream: true
      }
    ]);

    ws.close();
  });

  it("rejects update-config messages with no fields", async () => {
    const updates: unknown[] = [];
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setConfigUpdateHandler((update) => updates.push(update));
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(JSON.stringify({ type: "update-config" }));

    const messages = await collectMessages(ws, (message) => message.type === "error");
    expect(messages.at(-1)).toMatchObject({
      type: "error",
      code: "NO_FIELDS"
    });
    expect(updates).toEqual([]);

    ws.close();
  });

  it("serves daemon capability snapshots without claiming unwired runtime APIs", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    const port = await server.start();
    const ws = await openClient(port);

    const response = (
      await sendAndCollectMessages(
        ws,
        { type: "list-capabilities", requestId: "q-capabilities" },
        (message) => message.type === "capabilities-response" && message.requestId === "q-capabilities"
      )
    ).at(-1);

    expect(response).toMatchObject({
      type: "capabilities-response",
      requestId: "q-capabilities",
      snapshot: {
        schemaVersion: 1,
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            id: "artifacts",
            state: "unsupported",
            relatedMessageTypes: expect.arrayContaining(["list-artifacts"]),
          }),
          expect.objectContaining({
            id: "memory",
            state: "experimental",
            relatedMessageTypes: expect.arrayContaining(["list-memories", "delete-memory"]),
          }),
          expect.objectContaining({
            id: "checkpoints",
            state: "experimental",
            relatedMessageTypes: expect.arrayContaining(["list-checkpoints", "get-checkpoint-diff"]),
          }),
        ]),
      },
    });

    ws.close();
  });

  it("persists daemon session action metadata and keeps delete as a soft tombstone", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    server = new DaemonServer({ port: 0, sessionEventLogDir });
    server.setProviderFactory(() => new TextProvider("session action"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_session_action",
        sessionId: "session_action",
        prompt: "session action",
      })
    );
    await collectMessages(ws, (message) => {
      return message.type === "event" && message.event?.type === "agent-end";
    });
    await waitForPersistedRunEvent(server, "run_session_action", "run-completed");
    const eventLogBeforeDelete = await readFile(server.getEventLogPath(), "utf8");

    const openReceipt = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-session-action",
          requestId: "session-action-open",
          action: {
            protocolVersion: 1,
            actionId: "action_open",
            kind: "open",
            sessionId: "session_action",
            requestedAt: "2026-06-08T00:00:00.000Z",
            requestedBy: "workbench",
            target: "split-view",
            paneId: "pane_main",
          },
        },
        (message) => message.type === "session-action-receipt" && message.requestId === "session-action-open"
      )
    ).at(-1);

    expect(openReceipt).toMatchObject({
      type: "session-action-receipt",
      requestId: "session-action-open",
      protocolVersion: 1,
      actionId: "action_open",
      kind: "open",
      sessionId: "session_action",
      status: "committed",
      resultingSessionId: "session_action",
    });
    expect(openReceipt.committedAt).toEqual(expect.any(String));

    const renameReceipt = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-session-action",
          requestId: "session-action-rename",
          action: {
            protocolVersion: 1,
            actionId: "action_rename",
            kind: "rename",
            sessionId: "session_action",
            requestedAt: "2026-06-08T00:00:00.000Z",
            requestedBy: "workbench",
            title: "Renamed session",
          },
        },
        (message) => message.type === "session-action-receipt" && message.requestId === "session-action-rename"
      )
    ).at(-1);

    expect(renameReceipt).toMatchObject({
      type: "session-action-receipt",
      requestId: "session-action-rename",
      protocolVersion: 1,
      actionId: "action_rename",
      kind: "rename",
      sessionId: "session_action",
      status: "committed",
      resultingSessionId: "session_action",
    });

    const pinReceipt = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-session-action",
          requestId: "session-action-pin",
          action: {
            protocolVersion: 1,
            actionId: "action_pin",
            kind: "pin",
            sessionId: "session_action",
            requestedAt: "2026-06-08T00:00:01.000Z",
            requestedBy: "workbench",
          },
        },
        (message) => message.type === "session-action-receipt" && message.requestId === "session-action-pin"
      )
    ).at(-1);

    expect(pinReceipt).toMatchObject({
      type: "session-action-receipt",
      requestId: "session-action-pin",
      kind: "pin",
      status: "committed",
    });

    const renamedSessions = (
      await sendAndCollectMessages(
        ws,
        { type: "list-sessions", requestId: "session-action-list-renamed" },
        (message) => message.type === "sessions-listed" && message.requestId === "session-action-list-renamed"
      )
    ).at(-1);
    expect(renamedSessions).toMatchObject({
      type: "sessions-listed",
      sessions: [
        {
          id: "session_action",
          metadata: {
            sessionMetadata: {
              title: "Renamed session",
              pinned: true,
              deleted: false,
            },
          },
        },
      ],
      summaries: [
        {
          sessionId: "session_action",
          title: "Renamed session",
          pinned: true,
          deleted: false,
        },
      ],
    });

    const deleteReceipt = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-session-action",
          requestId: "session-action-delete",
          action: {
            protocolVersion: 1,
            actionId: "action_delete",
            kind: "delete",
            sessionId: "session_action",
            requestedAt: "2026-06-08T00:00:02.000Z",
            requestedBy: "workbench",
          },
        },
        (message) => message.type === "session-action-receipt" && message.requestId === "session-action-delete"
      )
    ).at(-1);
    expect(deleteReceipt).toMatchObject({
      type: "session-action-receipt",
      kind: "delete",
      status: "committed",
    });

    const hiddenSessions = (
      await sendAndCollectMessages(
        ws,
        { type: "list-sessions", requestId: "session-action-list-hidden" },
        (message) => message.type === "sessions-listed" && message.requestId === "session-action-list-hidden"
      )
    ).at(-1);
    expect(hiddenSessions.sessions.map((session: any) => session.id)).not.toContain("session_action");

    const includedDeletedSessions = (
      await sendAndCollectMessages(
        ws,
        { type: "list-sessions", includeDeleted: true, requestId: "session-action-list-deleted" },
        (message) => message.type === "sessions-listed" && message.requestId === "session-action-list-deleted"
      )
    ).at(-1);
    expect(includedDeletedSessions.sessions.map((session: any) => session.id)).toContain("session_action");
    expect(await readFile(server.getEventLogPath(), "utf8")).toBe(eventLogBeforeDelete);

    const rewindReceipt = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-session-action",
          requestId: "session-action-rewind",
          action: {
            protocolVersion: 1,
            actionId: "action_rewind",
            kind: "rewind",
            sessionId: "session_action",
            requestedAt: "2026-06-08T00:00:00.000Z",
            requestedBy: "workbench",
            targetEventId: "event_target",
            restoreWorkspace: false,
          },
        },
        (message) => message.type === "session-action-receipt" && message.requestId === "session-action-rewind"
      )
    ).at(-1);

    expect(rewindReceipt).toMatchObject({
      type: "session-action-receipt",
      requestId: "session-action-rewind",
      protocolVersion: 1,
      actionId: "action_rewind",
      kind: "rewind",
      sessionId: "session_action",
      status: "rejected",
      errorCode: "unsupported",
    });
    expect(rewindReceipt.errorMessage).toContain("apply-conversation-rewind");

    const forkReceipt = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-session-action",
          requestId: "session-action-fork",
          action: {
            protocolVersion: 1,
            actionId: "action_fork",
            kind: "fork",
            sessionId: "session_action",
            requestedAt: "2026-06-08T00:00:03.000Z",
            requestedBy: "workbench",
            targetSessionId: "session_action_fork",
          },
        },
        (message) => message.type === "session-action-receipt" && message.requestId === "session-action-fork"
      )
    ).at(-1);
    expect(forkReceipt).toMatchObject({
      type: "session-action-receipt",
      requestId: "session-action-fork",
      kind: "fork",
      status: "rejected",
      errorCode: "unsupported",
    });
    expect(forkReceipt.errorMessage).toContain("does not fake forked history");

    const missingOpenReceipt = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-session-action",
          requestId: "session-action-open-missing",
          action: {
            protocolVersion: 1,
            actionId: "action_open_missing",
            kind: "open",
            sessionId: "session_action_missing",
            requestedAt: "2026-06-08T00:00:04.000Z",
            requestedBy: "workbench",
            target: "split-view",
          },
        },
        (message) => message.type === "session-action-receipt" && message.requestId === "session-action-open-missing"
      )
    ).at(-1);
    expect(missingOpenReceipt).toMatchObject({
      type: "session-action-receipt",
      requestId: "session-action-open-missing",
      kind: "open",
      status: "rejected",
      errorCode: "session-not-found",
    });

    ws.close();
  });

  it("serves daemon JSONL memory list and delete through product adapters", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    const store = new JsonlMemoryStore(join(sessionEventLogDir, "memories.jsonl"));
    const projectMemory = await store.remember({
      scope: "project",
      content: "Prefer cache-stable prompt blocks",
      tags: ["prompt-cache"],
      metadata: { key: "prompt-cache-policy" },
    });
    await store.remember({
      scope: "user",
      content: "User likes concise Chinese summaries",
      tags: ["style"],
    });
    server = new DaemonServer({ port: 0, sessionEventLogDir });
    const port = await server.start();
    const ws = await openClient(port);

    const listed = (
      await sendAndCollectMessages(
        ws,
        { type: "list-memories", scope: "project", requestId: "q-memory-list" },
        (message) => message.type === "memories-listed" && message.requestId === "q-memory-list"
      )
    ).at(-1);
    expect(listed).toMatchObject({
      type: "memories-listed",
      memories: [
        {
          id: projectMemory.id,
          key: "prompt-cache-policy",
          value: "Prefer cache-stable prompt blocks",
          scope: "project",
        },
      ],
    });

    const deleted = (
      await sendAndCollectMessages(
        ws,
        { type: "delete-memory", memoryId: projectMemory.id, requestId: "q-memory-delete" },
        (message) => message.type === "memory-deleted" && message.requestId === "q-memory-delete"
      )
    ).at(-1);
    expect(deleted).toMatchObject({
      type: "memory-deleted",
      memoryId: projectMemory.id,
      requestId: "q-memory-delete",
    });

    const afterDelete = (
      await sendAndCollectMessages(
        ws,
        { type: "list-memories", scope: "project", requestId: "q-memory-after-delete" },
        (message) => message.type === "memories-listed" && message.requestId === "q-memory-after-delete"
      )
    ).at(-1);
    expect(afterDelete).toMatchObject({
      type: "memories-listed",
      memories: [],
    });

    ws.close();
  });

  it("serves checkpoint manifest list and changed paths through daemon adapters", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    const manifest = new CheckpointManifestService({
      manifestPath: join(sessionEventLogDir, "conversation-checkpoints.jsonl"),
    });
    await manifest.append({
      sessionId: "session_checkpoint_query",
      runId: "run_checkpoint_query",
      userMessageId: "user_checkpoint_query",
      checkpointId: "checkpoint_query",
      checkpointRef: "checkpoint://runtime/query",
      workspaceRoot: join(tmpdir(), "conex-checkpoint-query-workspace"),
      changedPaths: ["src/a.ts", "src/b.ts"],
      source: "runtime",
      createdAt: "2026-06-08T00:00:00.000Z",
      metadata: { label: "before query edit" },
    });
    server = new DaemonServer({ port: 0, sessionEventLogDir });
    const port = await server.start();
    const ws = await openClient(port);

    const listed = (
      await sendAndCollectMessages(
        ws,
        { type: "list-checkpoints", sessionId: "session_checkpoint_query", requestId: "q-checkpoints" },
        (message) => message.type === "checkpoints-listed" && message.requestId === "q-checkpoints"
      )
    ).at(-1);
    expect(listed).toMatchObject({
      type: "checkpoints-listed",
      checkpoints: [
        {
          id: "checkpoint_query",
          runId: "run_checkpoint_query",
          sessionId: "session_checkpoint_query",
          label: "before query edit",
          messageCount: 2,
        },
      ],
    });

    const diff = (
      await sendAndCollectMessages(
        ws,
        { type: "get-checkpoint-diff", checkpointId: "checkpoint_query", requestId: "q-checkpoint-diff" },
        (message) => message.type === "checkpoint-diff" && message.requestId === "q-checkpoint-diff"
      )
    ).at(-1);
    expect(diff).toMatchObject({
      type: "checkpoint-diff",
      checkpointId: "checkpoint_query",
      files: [
        { path: "src/a.ts", status: "changed" },
        { path: "src/b.ts", status: "changed" },
      ],
    });

    const restore = (
      await sendAndCollectMessages(
        ws,
        { type: "restore-checkpoint", checkpointId: "checkpoint_query", requestId: "q-checkpoint-restore" },
        (message) => message.type === "error" && message.requestId === "q-checkpoint-restore"
      )
    ).at(-1);
    expect(restore).toMatchObject({
      type: "error",
      code: "UNSUPPORTED_CAPABILITY",
    });

    ws.close();
  });

  it("echoes request correlation on query responses and query errors", { timeout: 30_000 }, async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    const port = await server.start();
    const ws = await openClient(port);

    const status = (
      await sendAndCollectMessages(
        ws,
        { type: "get-status", requestId: "q-status", correlationId: "corr-status" },
        (message) => message.type === "status-response" && message.requestId === "q-status"
      )
    ).at(-1);
    expect(status).toMatchObject({
      type: "status-response",
      requestId: "q-status",
      correlationId: "corr-status",
    });

    const missingRun = (
      await sendAndCollectMessages(
        ws,
        { type: "get-run-snapshot", runId: "missing-run", requestId: "q-missing", correlationId: "corr-missing" },
        (message) => message.type === "error" && message.requestId === "q-missing"
      )
    ).at(-1);
    expect(missingRun).toMatchObject({
      type: "error",
      code: "RUN_NOT_FOUND",
      runId: "missing-run",
      requestId: "q-missing",
      correlationId: "corr-missing",
    });

    const leases = (
      await sendAndCollectMessages(
        ws,
        { type: "list-mutation-leases", requestId: "q-leases", correlationId: "corr-leases" },
        (message) => message.type === "mutation-leases-listed" && message.requestId === "q-leases"
      )
    ).at(-1);
    expect(leases).toMatchObject({
      type: "mutation-leases-listed",
      leases: [],
      requestId: "q-leases",
      correlationId: "corr-leases",
    });

    ws.close();
  });

  it("previews and applies conversation rewind without claiming unsupported restore work", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => new BlockingProvider());
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);
    const entries = conversationRewindEntries();

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_rewind_active",
        sessionId: "session_rewind",
        prompt: "stay active",
      })
    );
    await waitForStatus(ws, (status) =>
      status.activeRuns.some((run: any) => run.runId === "run_rewind_active")
    );

    const preview = (
      await sendAndCollectMessages(
        ws,
        {
          type: "preview-conversation-rewind",
          sessionId: "session_rewind",
          targetLeafId: "leaf_target",
          entries,
          requestId: "rewind-preview",
        },
        (message) =>
          message.type === "conversation-rewind-preview" &&
          message.requestId === "rewind-preview"
      )
    ).at(-1);

    expect(preview).toMatchObject({
      type: "conversation-rewind-preview",
      sessionId: "session_rewind",
      requestId: "rewind-preview",
      plan: {
        fromLeafId: "leaf_current",
        targetLeafId: "leaf_target",
        runCancellations: [
          { runId: "run_rewind_active", reason: "conversation-rewind", role: "session-run" },
        ],
        workspaceRestore: {
          source: "none",
          cleanUntracked: false,
        },
      },
    });

    const applied = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-conversation-rewind",
          sessionId: "session_rewind",
          targetLeafId: "leaf_target",
          entries,
          requestId: "rewind-apply",
        },
        (message) =>
          message.type === "conversation-rewind-applied" &&
          message.requestId === "rewind-apply"
      )
    ).at(-1);

    expect(applied.stepResults).toEqual([
      {
        type: "cancel-runs",
        status: "applied",
        code: "active-runs-cancelled",
        affectedIds: ["run_rewind_active"],
      },
      {
        type: "move-session-leaf",
        status: "applied",
        code: "session-leaf-moved",
        affectedIds: ["leaf_target"],
      },
    ]);
    const sessionEvents = await server.readSessionEvents("session_rewind");
    expect(sessionEvents).toContainEqual(expect.objectContaining({
      type: "session-leaf-moved",
      payload: expect.objectContaining({
        toLeafId: "leaf_target",
        reason: "conversation-rewind",
      }),
    }));

    ws.close();
  });

  it("clears approval waits while applying a rewind that cancels an awaiting run", { timeout: 30_000 }, async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() =>
      createScriptedProvider([
        [
          {
            type: "tool-call",
            id: "approval_rewind_call",
            toolName: "write_sensitive",
            input: { path: "rewind-approval.txt" },
          },
          { type: "stop", reason: "tool-call" },
        ],
      ])
    );
    server.setToolFactory(() => [approvalRequiredTool()]);
    const port = await server.start();
    const ws = await openClient(port);
    const entries = conversationRewindEntries();

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_rewind_approval",
        sessionId: "session_rewind_approval",
        prompt: "wait for approval",
      })
    );

    await collectMessages(
      ws,
      (message) =>
        message.type === "approval-requested" &&
        message.runId === "run_rewind_approval"
    );
    const [pendingApproval] = server.getApprovalQueue().getPendingApprovals();
    expect(pendingApproval).toMatchObject({
      runId: "run_rewind_approval",
      status: "pending",
    });
    const pendingBefore = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(pendingBefore.pendingApprovals).toEqual([
      expect.objectContaining({
        toolCallId: pendingApproval!.toolCallId,
        runId: "run_rewind_approval",
        status: "pending",
      }),
    ]);

    const applied = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-conversation-rewind",
          sessionId: "session_rewind_approval",
          targetLeafId: "leaf_target",
          entries,
          requestId: "rewind-approval-apply",
        },
        (message) =>
          message.type === "conversation-rewind-applied" &&
          message.requestId === "rewind-approval-apply"
      )
    ).at(-1);

    expect(applied.stepResults).toEqual([
      {
        type: "cancel-runs",
        status: "applied",
        code: "active-runs-cancelled",
        affectedIds: ["run_rewind_approval"],
      },
      {
        type: "clear-approvals",
        status: "applied",
        code: "pending-approvals-cleared",
        affectedIds: [pendingApproval!.toolCallId],
      },
      {
        type: "move-session-leaf",
        status: "applied",
        code: "session-leaf-moved",
        affectedIds: ["leaf_target"],
      },
    ]);

    const statusAfter = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(statusAfter.activeRuns.map((run: any) => run.runId)).not.toContain("run_rewind_approval");
    expect(statusAfter.pendingApprovals).toEqual([]);
    expect(statusAfter.recentApprovals).toEqual([
      expect.objectContaining({
        toolCallId: pendingApproval!.toolCallId,
        runId: "run_rewind_approval",
        status: "denied",
        reason: "conversation-rewind",
      }),
    ]);
    await expect(server.readRunEvents("run_rewind_approval")).resolves.toContainEqual(
      expect.objectContaining({ type: "run-cancelled" })
    );

    ws.close();
  });

  it("rejects boundary rewind apply with typed missing facts before changing session state", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    server = new DaemonServer({ port: 0, sessionEventLogDir });
    server.setProviderFactory(() => new TextProvider("ok"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    await sendAndCollectMessages(
      ws,
      {
        type: "run-task",
        runId: "run_rewind_missing",
        sessionId: "session_rewind_missing",
        prompt: "target",
      },
      (message) => message.type === "event" && message.runId === "run_rewind_missing" && message.event?.type === "agent-end"
    );
    // Allow run-completed event to be persisted before reading baseline events.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeEvents = await server.readSessionEvents("session_rewind_missing");

    const runtimeEntries = await readRuntimeSessionEntriesForTest(sessionEventLogDir);
    const messageEntries = runtimeEntries.filter((entry) => entry.type === "message");
    const targetLeafId = messageEntries.at(-1)!.id;

    const boundaries = new ConversationBoundaryManifestService({
      manifestPath: join(sessionEventLogDir, "conversation-boundaries.jsonl"),
    });
    await boundaries.append({
      sessionId: "session_rewind_missing",
      runId: "run_rewind_missing",
      userMessageId: "user_rewind_missing",
      eventSequence: 1,
      workspaceRoot: sessionEventLogDir,
      changedPaths: [],
      createdAt: "2026-06-08T00:00:00.000Z",
      sessionTreeLeafIdAfter: targetLeafId,
      runtimeLeafIdAfter: targetLeafId,
    });

    const error = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-conversation-rewind",
          sessionId: "session_rewind_missing",
          userMessageId: "user_rewind_missing",
          restorePolicy: "required",
          requestId: "rewind-missing-apply",
        },
        (message) => message.type === "error" && message.requestId === "rewind-missing-apply"
      )
    ).at(-1);

    expect(error).toMatchObject({
      type: "error",
      code: "REWIND_WORKSPACE_CHECKPOINT_MISSING",
      requestId: "rewind-missing-apply",
    });
    const afterEvents = await server.readSessionEvents("session_rewind_missing");
    expect(afterEvents.map((event) => event.type)).toEqual(beforeEvents.map((event) => event.type));

    ws.close();
  });

  it("applies boundary rewind by restoring workspace, moving runtime leaf, and writing audit", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    const workspaceRoot = await tempEventLogDir();
    await writeFile(join(workspaceRoot, "tracked.txt"), "before", "utf8");
    const checkpoint = await createWorkspaceCheckpoint({
      workspaceRoot,
      sessionId: "session_rewind_boundary_apply",
      label: "before second turn",
      files: ["tracked.txt"],
    });
    await writeFile(join(workspaceRoot, "tracked.txt"), "after", "utf8");

    server = new DaemonServer({ port: 0, sessionEventLogDir, workflowSchedulerIntervalMs: 0 });
    server.setProviderFactory(() => new TextProvider("ok"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    await sendAndCollectMessages(
      ws,
      {
        type: "run-task",
        runId: "run_rewind_boundary_target",
        sessionId: "session_rewind_boundary_apply",
        cwd: workspaceRoot,
        prompt: "target",
      },
      (message) => message.type === "event" && message.runId === "run_rewind_boundary_target" && message.event?.type === "agent-end"
    );
    await sendAndCollectMessages(
      ws,
      {
        type: "run-task",
        runId: "run_rewind_boundary_current",
        sessionId: "session_rewind_boundary_apply",
        cwd: workspaceRoot,
        prompt: "current",
      },
      (message) => message.type === "event" && message.runId === "run_rewind_boundary_current" && message.event?.type === "agent-end"
    );

    const runtimeEntries = await readRuntimeSessionEntriesForTest(sessionEventLogDir);
    const messageEntries = runtimeEntries.filter((entry) => entry.type === "message");
    const targetUserEntryId = messageEntries[0]!.id;
    const targetAssistantEntryId = messageEntries[1]!.id;
    const currentLeafId = messageEntries.at(-1)!.id;

    const boundaries = new ConversationBoundaryManifestService({
      manifestPath: join(sessionEventLogDir, "conversation-boundaries.jsonl"),
    });
    const checkpoints = new CheckpointManifestService({
      manifestPath: join(sessionEventLogDir, "conversation-checkpoints.jsonl"),
    });
    await boundaries.append({
      sessionId: "session_rewind_boundary_apply",
      runId: "run_rewind_boundary_target",
      userMessageId: "user_rewind_boundary_target",
      sessionTreeLeafIdBefore: targetUserEntryId,
      sessionTreeLeafIdAfter: targetAssistantEntryId,
      runtimeLeafIdBefore: targetUserEntryId,
      runtimeLeafIdAfter: targetAssistantEntryId,
      eventSequence: 1,
      workspaceRoot,
      changedPaths: ["tracked.txt"],
      createdAt: "2026-06-08T00:00:00.000Z",
    });
    await checkpoints.append({
      sessionId: "session_rewind_boundary_apply",
      runId: "run_rewind_boundary_target",
      userMessageId: "user_rewind_boundary_target",
      checkpointId: checkpoint.id,
      checkpointRef: checkpoint.manifestPath,
      workspaceRoot,
      changedPaths: ["tracked.txt"],
      source: "runtime",
      createdAt: "2026-06-08T00:00:01.000Z",
    });

    const applied = (
      await sendAndCollectMessages(
        ws,
        {
          type: "apply-conversation-rewind",
          sessionId: "session_rewind_boundary_apply",
          userMessageId: "user_rewind_boundary_target",
          mode: "keep-user-message",
          restorePolicy: "required",
          requestId: "rewind-boundary-apply",
        },
        (message) => message.type === "conversation-rewind-applied" && message.requestId === "rewind-boundary-apply"
      )
    ).at(-1);

    expect(applied.plan).toMatchObject({
      fromLeafId: currentLeafId,
      targetLeafId: targetAssistantEntryId,
      workspaceRestore: {
        source: "runtime-manifest",
        checkpointId: checkpoint.id,
        manifestPath: checkpoint.manifestPath,
      },
    });
    expect(applied.stepResults).toEqual([
      expect.objectContaining({
        type: "restore-workspace",
        status: "applied",
        code: "workspace-restored",
        affectedIds: ["tracked.txt"],
      }),
      expect.objectContaining({
        type: "move-session-leaf",
        status: "applied",
        code: "session-leaf-moved",
        affectedIds: [targetAssistantEntryId],
        metadata: expect.objectContaining({ runtimePointerId: expect.any(String) }),
      }),
    ]);
    await expect(readFile(join(workspaceRoot, "tracked.txt"), "utf8")).resolves.toBe("before");

    const runtimeEntriesAfter = await readRuntimeSessionEntriesForTest(sessionEventLogDir);
    expect(runtimeEntriesAfter.at(-1)).toMatchObject({
      type: "leaf-pointer",
      targetLeafId: targetAssistantEntryId,
      reason: "conversation-rewind",
    });
    const sessionEvents = await server.readSessionEvents("session_rewind_boundary_apply");
    expect(sessionEvents.map((event) => event.type)).toContain("conversation-rewind-audit");
    expect(sessionEvents).toContainEqual(expect.objectContaining({
      type: "session-leaf-moved",
      payload: expect.objectContaining({ toLeafId: targetAssistantEntryId }),
    }));

    ws.close();
  });

  it("creates workflow runs through the orchestrator path and scopes workflow run history", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => new TextProvider("workflow hello"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    const firstWorkflow = (
      await sendAndCollectMessages(
        ws,
        {
          type: "create-workflow",
          id: "wf_manual_one",
          name: "Manual One",
          prompt: "run workflow one",
          cwd: "C:/workspace/crish",
          mode: "task",
          schedule: { type: "manual" },
          enabled: true,
          metadata: { owner: "daemon" }
        },
        (message) => message.type === "workflow-created"
      )
    ).at(-1);
    expect(firstWorkflow).toMatchObject({
      type: "workflow-created",
      workflow: {
        id: "wf_manual_one",
        schedule: { type: "manual" },
        enabled: true,
        metadata: { owner: "daemon" }
      }
    });

    await sendAndCollectMessages(
      ws,
      {
        type: "create-workflow",
        id: "wf_manual_two",
        name: "Manual Two",
        prompt: "run workflow two",
        cwd: "C:/workspace/crish",
        schedule: { type: "manual" }
      },
      (message) => message.type === "workflow-created"
    );

    ws.send(
      JSON.stringify({
        type: "trigger-workflow",
        workflowId: "wf_manual_one",
        runId: "run_workflow_manual_one",
        sessionId: "session_workflow_manual_one"
      })
    );

    const triggerMessages = await collectMessages(ws, (message) => message.type === "workflow-triggered");
    expect(triggerMessages.at(-1)).toMatchObject({
      type: "workflow-triggered",
      accepted: true,
      runId: "run_workflow_manual_one",
      workflowRunId: "run_workflow_manual_one",
      run: {
        workflowId: "wf_manual_one",
        runId: "run_workflow_manual_one",
        sessionId: "session_workflow_manual_one",
        status: "running"
      }
    });

    const runEvents = await waitForPersistedRunEvent(server, "run_workflow_manual_one", "run-completed");
    expect(runEvents.map((event) => event.type)).toContain("runtime-event");
    expect(
      runEvents
        .filter((event) => event.type === "runtime-event")
        .map((event) => (event.payload.event as { type?: string }).type)
    ).toEqual(expect.arrayContaining(["agent-start", "agent-end"]));

    const scopedRuns = (
      await sendAndCollectMessages(
        ws,
        { type: "list-workflow-runs", workflowId: "wf_manual_one" },
        (message) => message.type === "workflow-runs-listed"
      )
    ).at(-1);
    expect(scopedRuns).toMatchObject({
      type: "workflow-runs-listed",
      workflowId: "wf_manual_one"
    });
    expect(scopedRuns.runs.map((run: any) => run.workflowId)).toEqual(["wf_manual_one"]);
    expect(scopedRuns.runs[0]).toMatchObject({
      runId: "run_workflow_manual_one",
      status: "completed"
    });

    const otherRuns = (
      await sendAndCollectMessages(
        ws,
        { type: "list-workflow-runs", workflowId: "wf_manual_two" },
        (message) => message.type === "workflow-runs-listed"
      )
    ).at(-1);
    expect(otherRuns.runs).toEqual([]);

    ws.close();
  });

  it("accepts workflow triggers without waiting for a long background run", { timeout: 30_000 }, async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => new BlockingProvider());
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    await sendAndCollectMessages(
      ws,
      {
        type: "create-workflow",
        id: "wf_background",
        name: "Background",
        prompt: "hold in background",
        cwd: "C:/workspace/crish",
        schedule: { type: "manual" }
      },
      (message) => message.type === "workflow-created"
    );

    const runningUpdate = collectMessages(
      ws,
      (message) =>
        message.type === "workflow-run-updated" &&
        message.workflowId === "wf_background" &&
        message.runId === "run_workflow_background" &&
        message.run.status === "running"
    );
    const startedAt = Date.now();
    const triggered = (
      await sendAndCollectMessages(
        ws,
        {
          type: "trigger-workflow",
          workflowId: "wf_background",
          runId: "run_workflow_background",
          sessionId: "session_workflow_background"
        },
        (message) => message.type === "workflow-triggered"
      )
    ).at(-1);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(triggered).toMatchObject({
      type: "workflow-triggered",
      accepted: true,
      runId: "run_workflow_background",
      workflowRunId: "run_workflow_background",
      run: {
        status: "running"
      }
    });

    const updateMessages = await runningUpdate;
    expect(updateMessages.at(-1)).toMatchObject({
      type: "workflow-run-updated",
      workflowId: "wf_background",
      runId: "run_workflow_background",
      workflowRunId: "run_workflow_background",
      run: {
        workflowId: "wf_background",
        runId: "run_workflow_background",
        status: "running",
      },
    });

    const runs = await waitForWorkflowRunStatus(ws, "wf_background", "running");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "run_workflow_background",
      status: "running"
    });

    ws.close();
  });

  it("keeps detached workflow approval waits in the background", { timeout: 30_000 }, async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() =>
      createScriptedProvider([
        [
          {
            type: "tool-call",
            id: "approval_call",
            toolName: "write_sensitive",
            input: { path: "approval.txt" }
          },
          { type: "stop", reason: "tool-call" }
        ]
      ])
    );
    server.setToolFactory(() => [approvalRequiredTool()]);
    const port = await server.start();
    const ws = await openClient(port);

    await sendAndCollectMessages(
      ws,
      {
        type: "create-workflow",
        id: "wf_approval",
        name: "Approval",
        prompt: "request approval",
        cwd: "C:/workspace/crish",
        schedule: { type: "manual" }
      },
      (message) => message.type === "workflow-created"
    );

    const awaitingUpdate = collectMessages(
      ws,
      (message) =>
        message.type === "workflow-run-updated" &&
        message.workflowId === "wf_approval" &&
        message.runId === "run_workflow_approval" &&
        message.run.status === "awaiting-approval"
    );
    const approvalRequest = collectMessages(
      ws,
      (message) => message.type === "approval-requested" && message.runId === "run_workflow_approval"
    );

    const startedAt = Date.now();
    const triggered = (
      await sendAndCollectMessages(
        ws,
        {
          type: "trigger-workflow",
          workflowId: "wf_approval",
          runId: "run_workflow_approval",
          sessionId: "session_workflow_approval"
        },
        (message) => message.type === "workflow-triggered"
      )
    ).at(-1);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(triggered).toMatchObject({
      type: "workflow-triggered",
      accepted: true,
      runId: "run_workflow_approval",
      workflowRunId: "run_workflow_approval",
      run: {
        workflowId: "wf_approval",
        status: "running",
      }
    });

    expect((await awaitingUpdate).at(-1)).toMatchObject({
      type: "workflow-run-updated",
      workflowId: "wf_approval",
      runId: "run_workflow_approval",
      workflowRunId: "run_workflow_approval",
      run: {
        status: "awaiting-approval",
      },
    });
    expect((await approvalRequest).at(-1)).toMatchObject({
      type: "approval-requested",
      runId: "run_workflow_approval",
      toolName: "write_sensitive",
    });

    const runs = await waitForWorkflowRunStatus(ws, "wf_approval", "awaiting-approval");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "run_workflow_approval",
      status: "awaiting-approval",
    });

    ws.close();
  });

  it("expires detached workflow approvals and converges background run state", { timeout: 40_000 }, async () => {
    server = new DaemonServer({
      port: 0,
      sessionEventLogDir: await tempEventLogDir(),
      approvalTimeoutMs: 20000,
    });
    server.setProviderFactory(() =>
      createScriptedProvider([
        [
          {
            type: "tool-call",
            id: "approval_call_expire",
            toolName: "write_sensitive",
            input: { path: "approval-expire.txt" }
          },
          { type: "stop", reason: "tool-call" }
        ]
      ])
    );
    server.setToolFactory(() => [approvalRequiredTool()]);
    const port = await server.start();
    const ws = await openClient(port);

    await sendAndCollectMessages(
      ws,
      {
        type: "create-workflow",
        id: "wf_approval_expire",
        name: "Approval Expire",
        prompt: "request approval expiry",
        cwd: "C:/workspace/crish",
        schedule: { type: "manual" }
      },
      (message) => message.type === "workflow-created"
    );

    const approvalRequest = collectMessages(
      ws,
      (message) =>
        message.type === "approval-requested" &&
        message.runId === "run_workflow_approval_expire"
    );
    // approvalTimeoutMs=20000，审批超时在触发 workflow 后才开始计时。
    // collectMessages 的计时器在此处启动（先于触发），需要留足余量避免竞态。
    const expiredApproval = collectMessages(
      ws,
      (message) => message.type === "approval-resolved" && message.decision === "expired",
      35_000
    );
    const failedUpdate = collectMessages(
      ws,
      (message) =>
        message.type === "workflow-run-updated" &&
        message.workflowId === "wf_approval_expire" &&
        message.runId === "run_workflow_approval_expire" &&
        message.run.status === "failed",
      35_000
    );

    const startedAt = Date.now();
    const triggered = (
      await sendAndCollectMessages(
        ws,
        {
          type: "trigger-workflow",
          workflowId: "wf_approval_expire",
          runId: "run_workflow_approval_expire",
          sessionId: "session_workflow_approval_expire"
        },
        (message) => message.type === "workflow-triggered"
      )
    ).at(-1);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(triggered).toMatchObject({
      type: "workflow-triggered",
      accepted: true,
      runId: "run_workflow_approval_expire",
      workflowRunId: "run_workflow_approval_expire",
      run: {
        workflowId: "wf_approval_expire",
        status: "running",
      }
    });

    const request = (await approvalRequest).at(-1);
    expect(request).toMatchObject({
      type: "approval-requested",
      runId: "run_workflow_approval_expire",
      toolName: "write_sensitive",
      timeoutMs: 20000,
      expiresAt: expect.any(Number),
      remainingMs: expect.any(Number),
    });

    const pendingStatus = (
      await sendAndCollectMessages(
        ws,
        { type: "get-status" },
        (message) => message.type === "status-response"
      )
    ).at(-1);
    expect(pendingStatus.pendingApprovals).toEqual([
      expect.objectContaining({
        toolCallId: request.toolCallId,
        runId: "run_workflow_approval_expire",
        status: "pending",
        timeoutMs: 20000,
        expiresAt: request.expiresAt,
      }),
    ]);

    expect((await expiredApproval).at(-1)).toMatchObject({
      type: "approval-resolved",
      toolCallId: request.toolCallId,
      decision: "expired",
      reason: "timeout",
      expiredAt: expect.any(Number),
    });
    expect((await failedUpdate).at(-1)).toMatchObject({
      type: "workflow-run-updated",
      workflowId: "wf_approval_expire",
      runId: "run_workflow_approval_expire",
      workflowRunId: "run_workflow_approval_expire",
      run: {
        status: "failed",
        error: expect.stringMatching(/Approval (expired|timed out)/i),
      },
    });

    const runs = await waitForWorkflowRunStatus(ws, "wf_approval_expire", "failed");
    expect(runs[0]).toMatchObject({
      runId: "run_workflow_approval_expire",
      status: "failed",
      error: expect.stringMatching(/Approval (expired|timed out)/i),
    });

    const resolvedStatus = (
      await sendAndCollectMessages(
        ws,
        { type: "get-status" },
        (message) => message.type === "status-response"
      )
    ).at(-1);
    expect(resolvedStatus.pendingApprovals).toEqual([]);
    expect(resolvedStatus.recentApprovals).toEqual([
      expect.objectContaining({
        toolCallId: request.toolCallId,
        runId: "run_workflow_approval_expire",
        status: "expired",
        reason: "timeout",
        expiredReason: "timeout",
      }),
    ]);

    ws.close();
  });

  it("deduplicates due workflow ticks while background runs are in flight", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    await seedWorkflowStore(sessionEventLogDir, {
      id: "wf_due_daily",
      name: "Due Daily",
      prompt: "scheduled hold",
      cwd: "C:/workspace/crish",
      mode: "task",
      schedule: { type: "daily", time: "00:00", timezone: "UTC" },
      enabled: true,
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
      metadata: {},
    });
    server = new DaemonServer({
      port: 0,
      sessionEventLogDir,
      workflowSchedulerIntervalMs: 20,
    });
    server.setProviderFactory(() => new BlockingProvider());
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    await waitForWorkflowRunCount(ws, "wf_due_daily", 1);
    await delay(75);

    const runs = (
      await sendAndCollectMessages(
        ws,
        { type: "list-workflow-runs", workflowId: "wf_due_daily" },
        (message) => message.type === "workflow-runs-listed"
      )
    ).at(-1).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workflowId: "wf_due_daily",
      status: "running",
    });

    const [firstTick, secondTick] = await Promise.all([
      server.tickScheduler(new Date()),
      server.tickScheduler(new Date()),
    ]);
    expect(firstTick).toBe(secondTick);
    expect(firstTick.triggered).toHaveLength(0);

    ws.close();
  });

  it("returns accepted run handles from scheduler ticks without blocking background workflow work", async () => {
    const sessionEventLogDir = await tempEventLogDir();
    await seedWorkflowStore(sessionEventLogDir, {
      id: "wf_tick_background",
      name: "Tick Background",
      prompt: "scheduled hold",
      cwd: "C:/workspace/crish",
      mode: "task",
      schedule: { type: "daily", time: "00:00", timezone: "UTC" },
      enabled: true,
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
      metadata: {},
    });
    server = new DaemonServer({
      port: 0,
      sessionEventLogDir,
      workflowSchedulerIntervalMs: 0,
    });
    server.setProviderFactory(() => new BlockingProvider());
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    const startedAt = Date.now();
    const result = await server.tickScheduler(new Date("2026-06-08T00:00:00.000Z"));
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.due).toHaveLength(1);
    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]).toMatchObject({
      accepted: true,
      runId: expect.any(String),
      workflowRunId: expect.any(String),
      run: {
        workflowId: "wf_tick_background",
        status: "running",
        scheduledFor: "2026-06-08T00:00:00.000Z",
      },
    });
    expect(result.triggered[0]?.runId).toBe(result.triggered[0]?.workflowRunId);

    const runs = await waitForWorkflowRunStatus(ws, "wf_tick_background", "running");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe(result.triggered[0]?.runId);

    ws.close();
  });

  it("returns daemon-owned provider readiness in get-status", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(statusProviderFactory());
    const port = await server.start();
    const ws = await openClient(port);

    const status = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);

    expect(status).toMatchObject({
      type: "status-response",
      lifecycle: {
        state: "ready",
        currentPort: port,
        connectedClientCount: 1,
        totalClientConnectionCount: 1,
        totalClientDisconnectCount: 0,
        activeRunCount: 0,
        eventStore: {
          status: "ok",
        },
        providerReadiness: "ready",
        mcpReadiness: "unknown",
      },
      activeRuns: [],
      pendingApprovals: [],
      providerStatus: {
        credentialMode: "direct",
        readiness: "ready",
        model: "mimo-v2.5",
        hasDirectApiKey: true,
        gateway: {
          routeDecision: expect.arrayContaining([
            "capability_required_endpoint:responses",
            "capability_required_streaming:streaming",
            "model_route_rejection:endpoint:unsupported:responses:1",
          ]),
          selectedEndpointSupport: "responses",
          selectedStreamingSupport: "streaming",
          selectedCredentialSource: {
            metadata: {
              apiKey: "[redacted]",
              Authorization: "[redacted]",
              token: "[redacted]",
              label: "status-test",
            }
          }
        }
      },
      mcpStatus: {
        configured: false,
        readiness: "unknown",
        serverCount: 0
      }
    });
    expect(JSON.stringify(status)).not.toContain("test-key");
    expect(JSON.stringify(status)).not.toContain("bearer-secret");
    expect(JSON.stringify(status)).not.toContain("token-secret");

    ws.close();
  });

  it("reports daemon-owned client connection and disconnect counters", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(statusProviderFactory());
    const port = await server.start();
    const first = await openClient(port);
    const second = await openClient(port);

    const connectedStatus = (
      await sendAndCollectMessages(first, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(connectedStatus.lifecycle).toMatchObject({
      state: "ready",
      connectedClientCount: 2,
      totalClientConnectionCount: 2,
      totalClientDisconnectCount: 0,
    });

    await closeClient(second, 1000, "client done");
    const disconnectedStatus = await waitForStatus(first, (status) => {
      return status.lifecycle.connectedClientCount === 1 && status.lifecycle.totalClientDisconnectCount === 1;
    });
    expect(disconnectedStatus.lifecycle.recentDisconnect).toMatchObject({
      clientId: "client-2",
      code: 1000,
      reason: "client done",
    });

    first.close();
  });

  it("returns MCP lifecycle status and closes runtime factory during stop", async () => {
    let closed = 0;
    const manager = new McpLifecycleManager({
      servers: [
        {
          name: "mcp_status",
          adapter: {
            connect: () => ({
              listTools: () => [],
              close: () => {
                closed += 1;
              },
            }),
          },
        },
      ],
    });
    server = new DaemonServer(
      { port: 0, sessionEventLogDir: await tempEventLogDir() },
      { mcpLifecycleManagerFactory: () => manager }
    );
    server.setProviderFactory(statusProviderFactory());
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_mcp_status",
        sessionId: "session_mcp_status",
        prompt: "mcp"
      })
    );

    await collectMessages(ws, (message) => {
      return message.type === "event" && message.runId === "run_mcp_status" && message.event?.type === "agent-end";
    });

    const status = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(status.lifecycle).toMatchObject({
      state: "ready",
      mcpReadiness: "ready",
    });
    expect(status.mcpStatus).toMatchObject({
      configured: true,
      readiness: "ready",
      serverCount: 1,
      summary: {
        ready: 1,
      },
    });
    expect(status.mcpStatus.servers[0]).toMatchObject({
      name: "mcp_status",
      state: "ready",
    });

    ws.close();
    await server.stop();
    expect(closed).toBe(1);
    expect(server.getLifecycleSnapshot().state).toBe("stopped");
    server = undefined;
  });

  it("reports event-store failure latch in lifecycle status", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => new TextProvider("event store failure"));
    server.setToolFactory(() => []);
    const port = await server.start();
    await mkdir(server.getEventLogPath());
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_event_store_failure",
        sessionId: "session_event_store_failure",
        prompt: "persist"
      })
    );

    const failed = await collectMessages(ws, (message) => {
      return message.type === "error" && message.runId === "run_event_store_failure";
    });
    expect(failed.at(-1)).toMatchObject({
      type: "error",
      code: "RUN_ERROR",
      runId: "run_event_store_failure",
    });
    expect(String(failed.at(-1).message)).toContain("Failed to append orchestrator event");

    const status = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(status.lifecycle).toMatchObject({
      state: "degraded",
      eventStore: {
        status: "failed",
        failure: {
          code: "EVENT_STORE_WRITE_FAILED",
          source: "event-store",
          severity: "error",
        },
      },
      recentError: {
        code: "EVENT_STORE_WRITE_FAILED",
      },
    });

    await expect(server.stop()).rejects.toMatchObject({
      name: "OrchestratorEventStoreWriteError",
    });
    server = undefined;
  });

  it("rejects new durable runs after the event-store failure latch", async () => {
    server = new DaemonServer({ port: 0, sessionEventLogDir: await tempEventLogDir() });
    server.setProviderFactory(() => new TextProvider("event store degraded"));
    server.setToolFactory(() => []);
    const port = await server.start();
    await mkdir(server.getEventLogPath());
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_event_store_first_failure",
        sessionId: "session_event_store_first_failure",
        prompt: "persist"
      })
    );

    await collectMessages(ws, (message) => {
      return message.type === "error" && message.runId === "run_event_store_first_failure";
    });
    expect(server.getLifecycleSnapshot().state).toBe("degraded");

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_event_store_rejected",
        sessionId: "session_event_store_rejected",
        prompt: "should reject"
      })
    );

    const rejected = await collectMessages(ws, (message) => message.type === "error");
    expect(rejected.at(-1)).toMatchObject({
      type: "error",
      code: "EVENT_STORE_DEGRADED",
      runId: "run_event_store_rejected",
    });
    expect(String(rejected.at(-1).message)).toContain("durable run start rejected");

    const listed = (
      await sendAndCollectMessages(ws, { type: "list-runs" }, (message) => message.type === "runs-listed")
    ).at(-1);
    expect(listed.runs.map((run: { id: string }) => run.id)).not.toContain("run_event_store_rejected");

    const degradedStatus = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(degradedStatus.lifecycle).toMatchObject({
      state: "degraded",
      eventStore: {
        status: "failed",
        failure: {
          code: "EVENT_STORE_WRITE_FAILED",
        },
      },
      recentError: {
        code: "EVENT_STORE_DEGRADED_RUN_REJECTED",
        source: "event-store",
        severity: "warning",
      },
    });

    ws.close();
    await expect(server.stop()).rejects.toMatchObject({
      name: "OrchestratorEventStoreWriteError",
    });
    server = undefined;
  });

  it("records WebSocket backpressure diagnostics when a client cannot accept a response", async () => {
    server = new DaemonServer(
      { port: 0, sessionEventLogDir: await tempEventLogDir() },
      { maxClientBufferedBytes: 64 }
    );
    server.setProviderFactory(() => new TextProvider("ok"));
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    ws.send(JSON.stringify({ type: "get-status" }));

    await expect(closed).resolves.toMatchObject({
      code: 1013,
      reason: "Daemon send backpressure",
    });
    expect(server.getLifecycleSnapshot().recentError).toMatchObject({
      code: "CLIENT_SEND_BACKPRESSURE",
      source: "client",
      severity: "warning",
    });

    await server.stop();
    server = undefined;
  });

  it("allows unlimited concurrent runs when maxConcurrentRuns is 0", async () => {
    server = new DaemonServer({
      port: 0,
      maxConcurrentRuns: 0,
      sessionEventLogDir: await tempEventLogDir(),
    });
    server.setProviderFactory(() => new BlockingProvider());
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_unlimited_a",
        sessionId: "session_a",
        prompt: "hold-a",
      }),
    );
    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_unlimited_b",
        sessionId: "session_b",
        prompt: "hold-b",
      }),
    );
    // Single collector: sequential waits drop the sibling agent-start when both races complete.
    const started = new Set<string>();
    await collectMessages(ws, (message) => {
      if (
        message.type === "event" &&
        message.event?.type === "agent-start" &&
        (message.runId === "run_unlimited_a" || message.runId === "run_unlimited_b")
      ) {
        started.add(message.runId);
      }
      return started.has("run_unlimited_a") && started.has("run_unlimited_b");
    });
    const runningStatus = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(runningStatus.lifecycle.activeRunCount).toBeGreaterThanOrEqual(2);
    const ids = (runningStatus.activeRuns as Array<{ runId: string }>).map((r) => r.runId);
    expect(ids).toEqual(expect.arrayContaining(["run_unlimited_a", "run_unlimited_b"]));

    ws.send(JSON.stringify({ type: "cancel-run", runId: "run_unlimited_a" }));
    ws.send(JSON.stringify({ type: "cancel-run", runId: "run_unlimited_b" }));
    await waitForPersistedRunEvent(server, "run_unlimited_a", "run-cancelled");
    await waitForPersistedRunEvent(server, "run_unlimited_b", "run-cancelled");
    ws.close();
    await server.stop();
    server = undefined;
  });

  it("enforces max concurrent orchestrated runs", async () => {
    server = new DaemonServer({
      port: 0,
      maxConcurrentRuns: 1,
      sessionEventLogDir: await tempEventLogDir()
    });
    server.setProviderFactory(() => new BlockingProvider());
    server.setToolFactory(() => []);
    const port = await server.start();
    const ws = await openClient(port);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_blocking_one",
        sessionId: "session_blocking",
        prompt: "hold"
      })
    );
    await collectMessages(ws, (message) => {
      return message.type === "event" && message.runId === "run_blocking_one" && message.event?.type === "agent-start";
    });
    const runningStatus = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(runningStatus.lifecycle.activeRunCount).toBe(1);
    expect(runningStatus.activeRuns).toHaveLength(1);
    expect(runningStatus.activeRuns[0]).toMatchObject({
      runId: "run_blocking_one",
      status: "running",
    });

    const messages = await sendAndCollectMessages(
      ws,
      {
        type: "run-task",
        runId: "run_blocking_two",
        sessionId: "session_blocking_two",
        prompt: "second"
      },
      (message) => message.type === "error"
    );
    expect(messages.at(-1)).toMatchObject({
      type: "error",
      code: "MAX_CONCURRENT_RUNS",
      runId: "run_blocking_two"
    });

    ws.send(JSON.stringify({ type: "cancel-run", runId: "run_blocking_one" }));
    const runEvents = await waitForPersistedRunEvent(server, "run_blocking_one", "run-cancelled");
    expect(runEvents.map((event) => event.type)).toContain("run-cancelled");
    const cancelledStatus = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(cancelledStatus.lifecycle.activeRunCount).toBe(0);
    expect(cancelledStatus.activeRuns).toHaveLength(0);

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId: "run_blocking_three",
        sessionId: "session_blocking",
        prompt: "after cancel"
      })
    );
    await collectMessages(ws, (message) => {
      return message.type === "event" && message.runId === "run_blocking_three" && message.event?.type === "agent-start";
    });
    const restartedStatus = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(restartedStatus.lifecycle.activeRunCount).toBe(1);
    expect(restartedStatus.activeRuns[0]).toMatchObject({
      runId: "run_blocking_three",
      status: "running",
    });

    ws.send(JSON.stringify({ type: "cancel-run", runId: "run_blocking_three" }));
    await waitForPersistedRunEvent(server, "run_blocking_three", "run-cancelled");
    const settledStatus = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    expect(settledStatus.lifecycle.activeRunCount).toBe(0);

    ws.close();
    await server.stop();
    server = undefined;
  });
});

describe("DaemonClientRegistry", () => {
  it("closes clients and reports diagnostics when ws.send reports an error", () => {
    const diagnostics: unknown[] = [];
    const registry = new DaemonClientRegistry({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    let closed: { code: number; reason: string } | undefined;
    const fakeWs = {
      OPEN: 1,
      CONNECTING: 0,
      CLOSING: 2,
      CLOSED: 3,
      readyState: 1,
      bufferedAmount: 0,
      send(_payload: string, callback?: (error?: Error) => void) {
        callback?.(new Error("socket write failed"));
      },
      close(code: number, reason: string) {
        closed = { code, reason };
        fakeWs.readyState = fakeWs.CLOSING;
      },
      terminate() {
        fakeWs.readyState = fakeWs.CLOSED;
      },
    };
    const ws = fakeWs as unknown as WebSocket;

    const client = registry.connect(ws);
    expect(client).not.toBeNull();
    const connectedClient = client!;

    expect(registry.send(ws, { type: "pong" })).toBe(true);
    expect(closed).toEqual({
      code: 1011,
      reason: "Daemon send failed",
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "CLIENT_SEND_FAILED",
      source: "websocket",
      severity: "error",
      clientId: connectedClient.id,
    });
  });
});

class TextProvider implements AgentProvider {
  readonly id = "text-provider";

  constructor(private readonly text: string) {}

  async *stream(_request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    yield { type: "text-delta", text: this.text };
    yield { type: "stop", reason: "stop" };
  }
}

class BlockingProvider implements AgentProvider {
  readonly id = "blocking-provider";

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    if (!request.signal.aborted) {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    yield { type: "stop", reason: "stop" };
  }
}

class ReleasableTextProvider implements AgentProvider {
  readonly id = "releasable-text-provider";
  private releaseStream!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseStream = resolve;
  });

  constructor(private readonly text: string) {}

  release(): void {
    this.releaseStream();
  }

  async *stream(_request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    await this.released;
    yield { type: "text-delta", text: this.text };
    yield { type: "stop", reason: "stop" };
  }
}

class PacedTokenProvider implements AgentProvider {
  readonly id = "paced-token-provider";
  abortObserved = false;

  constructor(
    private readonly options: {
      tokens: string[];
      firstDelayMs: number;
      tokenDelayMs: number;
    }
  ) {}

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    let chunks = 0;
    request.signal.addEventListener(
      "abort",
      () => {
        this.abortObserved = true;
      },
      { once: true }
    );

    await delay(this.options.firstDelayMs, request.signal);
    yield {
      type: "provider-diagnostic",
      diagnostic: {
        phase: "response-start",
        providerId: this.id,
        endpoint: "test-stream",
        elapsedMs: this.options.firstDelayMs,
      },
    };
    for (const token of this.options.tokens) {
      if (request.signal.aborted) return;
      chunks += 1;
      yield { type: "text-delta", text: token };
      await delay(this.options.tokenDelayMs, request.signal);
    }
    yield {
      type: "provider-diagnostic",
      diagnostic: {
        phase: "stream-end",
        providerId: this.id,
        endpoint: "test-stream",
        elapsedMs: this.options.firstDelayMs + this.options.tokenDelayMs * chunks,
        chunks,
      },
    };
    yield { type: "stop", reason: "stop" };
  }
}

function usageProvider(): AgentProvider {
  return createScriptedProvider([
    [
      {
        type: "provider-diagnostic",
        diagnostic: {
          phase: "model-selected",
          providerId: "diagnostic-provider",
          configuredModel: "diagnostic-model",
          actualModel: "actual-model",
        },
      },
      {
        type: "tool-call",
        id: "call_metrics",
        toolName: "metrics_tool",
        input: {},
      },
      { type: "stop", reason: "tool-call" },
    ],
    [
      { type: "text-delta", text: "done" },
      {
        type: "stop",
        reason: "stop",
        usage: {
          promptTokens: 20,
          completionTokens: 7,
          totalTokens: 27,
          cacheReadTokens: 4,
          cacheWriteTokens: 3,
        },
      },
    ],
  ]);
}

function approvalRequiredTool(): AgentTool {
  return {
    name: "write_sensitive",
    label: "write sensitive",
    description: "write sensitive data",
    category: "filesystem",
    concurrency: "exclusive",
    isReadOnly: () => false,
    summarize: (input) => `write ${String(input.path ?? "")}`,
    async execute() {
      return { text: "written" };
    },
  };
}

function conversationRewindEntries() {
  return [
    {
      type: "node",
      id: "root",
      parentId: null,
      createdAt: "2026-06-08T00:00:00.000Z",
      payload: { text: "root" },
    },
    {
      type: "node",
      id: "leaf_target",
      parentId: "root",
      createdAt: "2026-06-08T00:00:01.000Z",
      payload: { text: "target" },
    },
    {
      type: "node",
      id: "leaf_current",
      parentId: "root",
      createdAt: "2026-06-08T00:00:02.000Z",
      payload: { text: "current" },
    },
  ];
}

function scopedContextRecord(id: string, activation: "enabled" | "recommended" | "disabled") {
  return {
    id,
    kind: "rule",
    title: "Server scoped rule",
    content: "Use daemon scoped context APIs.",
    scope: "project",
    activation,
    appliesTo: [],
    tags: ["server"],
    source: { type: "user", label: "test" },
    sourceMetadata: { origin: "server-test" },
    order: 1,
    updatedAt: "2026-06-08T00:00:00.000Z",
  };
}

function statusProviderFactory() {
  const factory = () => new TextProvider("ok");
  factory.getProviderStatusSnapshot = () => ({
    credentialMode: "direct" as const,
    readiness: "ready" as const,
    providerId: "crish",
    routeId: "default:crish:mimo-v2.5",
    baseUrl: "https://gateway.example/v1",
    model: "mimo-v2.5",
    upstreamModel: "mimo-v2.5",
    endpoint: "auto" as const,
    stream: true,
    systemPromptWireMode: "user-prefix" as const,
    apiKey: {
      hasApiKey: true,
      source: "env" as const,
    },
    hasDirectApiKey: true,
    apiKeySource: "env" as const,
    gateway: {
      ready: true,
      credentialConfigured: true,
      routeDecision: [
        "capability_required_endpoint:responses",
        "capability_required_streaming:streaming",
        "model_route_rejection:endpoint:unsupported:responses:1",
        "selected_route"
      ],
      selectedEndpointSupport: "responses" as const,
      selectedStreamingSupport: "streaming" as const,
      selectedCredentialSource: {
        type: "api-key",
        metadata: {
          apiKey: "[redacted]",
          Authorization: "[redacted]",
          token: "[redacted]",
          label: "status-test",
        },
      },
    },
    updatedAt: "2026-06-08T00:00:00.000Z",
  });
  return factory;
}

async function tempEventLogDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-events-"));
  tempDirs.push(dir);
  return dir;
}

async function tempGitWorkspace(prefix = "daemon-git-workspace-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function readRuntimeSessionEntriesForTest(sessionEventLogDir: string): Promise<Array<Record<string, any>>> {
  const runtimeSessionDir = join(sessionEventLogDir, "runtime-sessions");
  const files = await readdir(runtimeSessionDir);
  const entries: Array<Record<string, any>> = [];
  for (const file of files) {
    const text = await readFile(join(runtimeSessionDir, file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const entry = JSON.parse(line);
      if (entry.type !== "session") entries.push(entry);
    }
  }
  return entries;
}

async function openClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function collectMessages(ws: WebSocket, done: (message: any) => boolean, timeoutMs: number = 20_000): Promise<any[]> {
  const messages: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString());
      message.receivedAt = performance.now();
      if (process.env.DEBUG_BATCHER === '1') {
        console.error('[TestClient] recv:', message?.type, message?.code ?? '', message?.event?.type ?? '', message?.runId ?? '');
      }
      messages.push(message);
      if (done(message)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for daemon message"));
    }, timeoutMs);
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
  return messages;
}

async function sendAndCollectMessages(
  ws: WebSocket,
  payload: Record<string, unknown>,
  done: (message: any) => boolean,
  timeoutMs?: number
): Promise<any[]> {
  const messages = collectMessages(ws, done, timeoutMs);
  ws.send(JSON.stringify(payload));
  return messages;
}

async function closeClient(ws: WebSocket, code: number, reason: string): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
  });
  ws.close(code, reason);
  await closed;
}

async function waitForStatus(ws: WebSocket, done: (status: any) => boolean): Promise<any> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = (
      await sendAndCollectMessages(ws, { type: "get-status" }, (message) => message.type === "status-response")
    ).at(-1);
    if (done(status)) return status;
    await delay(25);
  }
  throw new Error("Timed out waiting for daemon status");
}

async function waitForWorkflowRunStatus(
  ws: WebSocket,
  workflowId: string,
  status: WorkflowRunStatus
): Promise<WorkflowRunEntry[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = (
      await sendAndCollectMessages(
        ws,
        { type: "list-workflow-runs", workflowId },
        (message) => message.type === "workflow-runs-listed"
      )
    ).at(-1);
    const runs = response.runs as WorkflowRunEntry[];
    if (runs.some((run) => run.status === status)) return runs;
    await delay(25);
  }
  throw new Error(`Timed out waiting for workflow ${workflowId} run status ${status}`);
}

async function waitForWorkflowRunCount(
  ws: WebSocket,
  workflowId: string,
  count: number
): Promise<WorkflowRunEntry[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = (
      await sendAndCollectMessages(
        ws,
        { type: "list-workflow-runs", workflowId },
        (message) => message.type === "workflow-runs-listed"
      )
    ).at(-1);
    const runs = response.runs as WorkflowRunEntry[];
    if (runs.length === count) return runs;
    await delay(25);
  }
  throw new Error(`Timed out waiting for workflow ${workflowId} run count ${count}`);
}

async function seedWorkflowStore(
  sessionEventLogDir: string,
  workflow: WorkflowDefinition
): Promise<void> {
  // WorkflowStore 拆分?workflows.json (workflows only) + workflows-runs.json (runs only)?
  // seed 时无 runs，仅?workflows 文件；runs 文件不存在时 store 会按空数组处理?
  await writeFile(
    join(sessionEventLogDir, "workflows.json"),
    `${JSON.stringify(
      {
        version: WORKFLOW_STORE_VERSION,
        workflows: [workflow],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function waitForPersistedRunEvent(
  daemon: DaemonServer,
  runId: string,
  eventType: string
): Promise<Awaited<ReturnType<DaemonServer["readRunEvents"]>>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const events = await daemon.readRunEvents(runId);
    if (events.some((event) => event.type === eventType)) {
      return events;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for persisted orchestrator event ${eventType}`);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => cleanup();
    timeout = setTimeout(cleanup, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTextDeltaMessage(message: any): boolean {
  return (
    message.type === "event" &&
    message.event?.type === "message-end" &&
    message.event?.message?.role === "assistant" &&
    Array.isArray(message.event?.message?.blocks) &&
    message.event.message.blocks.some((block: any) => block.type === "text")
  );
}

function textFromTextDeltaMessages(messages: any[]): string {
  return messages
    .flatMap((message) => (Array.isArray(message.event?.message?.blocks) ? message.event.message.blocks : []))
    .filter((block: any) => block.type === "text")
    .map((block: any) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}
