import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";
import {
  CheckpointManifestService,
  ConversationBoundaryManifestService,
  createScriptedProvider,
  checkpointToArtifact,
  createWorkspaceCheckpoint,
  type AgentProvider,
  type AgentTool,
} from "@crish/agent-runtime";
import { DaemonServer } from "./server.js";
import { removeTempDirs } from "./test-temp-cleanup.js";
import {
  previewConversationRewindByBoundary,
  resolveConversationRewindBoundary,
} from "./conversation-rewind-boundary.js";
import {
  resolveDaemonCheckpointManifestPath,
  resolveDaemonConversationBoundaryManifestPath,
} from "./persistence.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe("conversation rewind boundary daemon resolver", () => {
  it("reports typed missing facts when a boundary lacks leaves and checkpoint facts", async () => {
    const sessionEventLogDir = await tempDir();
    const boundaries = new ConversationBoundaryManifestService({
      manifestPath: resolveDaemonConversationBoundaryManifestPath({ sessionEventLogDir }),
    });
    await boundaries.append({
      sessionId: "session_missing",
      runId: "run_missing",
      userMessageId: "user_missing",
      eventSequence: 1,
      workspaceRoot: sessionEventLogDir,
      changedPaths: [],
      createdAt: "2026-06-08T00:00:00.000Z",
    });

    const result = await resolveConversationRewindBoundary({
      config: { sessionEventLogDir },
      sessionId: "session_missing",
      userMessageId: "user_missing",
    });

    expect(result.status).toBe("blocked");
    expect(result.missingFacts).toEqual([
      "session-tree-target-leaf",
      "runtime-target-leaf",
      "workspace-checkpoint",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "REWIND_SESSION_TREE_TARGET_MISSING",
      "REWIND_RUNTIME_TARGET_MISSING",
      "REWIND_WORKSPACE_CHECKPOINT_MISSING",
    ]);
  });

  it("selects the latest boundary for a session and matches checkpoint manifest facts", async () => {
    const sessionEventLogDir = await tempDir();
    const boundaries = new ConversationBoundaryManifestService({
      manifestPath: resolveDaemonConversationBoundaryManifestPath({ sessionEventLogDir }),
    });
    const checkpoints = new CheckpointManifestService({
      manifestPath: resolveDaemonCheckpointManifestPath({ sessionEventLogDir }),
    });

    await boundaries.append(boundaryInput(sessionEventLogDir, "session_latest", "run_old", "user_old", "leaf_old", "runtime_old", "2026-06-08T00:00:00.000Z"));
    await boundaries.append(boundaryInput(sessionEventLogDir, "session_latest", "run_new", "user_new", "leaf_new", "runtime_new", "2026-06-08T00:01:00.000Z"));
    await checkpoints.append({
      sessionId: "session_latest",
      runId: "run_new",
      userMessageId: "user_new",
      checkpointId: "checkpoint_new",
      checkpointRef: "checkpoint://runtime/new",
      workspaceRoot: sessionEventLogDir,
      changedPaths: ["a.txt"],
      source: "runtime",
      createdAt: "2026-06-08T00:01:01.000Z",
    });

    const result = await resolveConversationRewindBoundary({
      config: { sessionEventLogDir },
      sessionId: "session_latest",
      latestUserMessage: true,
    });

    expect(result.status).toBe("ok");
    expect(result.boundary?.userMessageId).toBe("user_new");
    expect(result.checkpoint?.checkpointId).toBe("checkpoint_new");
    expect(result.target).toMatchObject({
      sessionTreeTargetLeafId: "leaf_new",
      runtimeTargetLeafId: "runtime_new",
      checkpoint: {
        checkpointId: "checkpoint_new",
        checkpointRef: "checkpoint://runtime/new",
      },
      missingFacts: [],
    });
  });

  it("previews a rewind plan from boundary facts without executing restore", async () => {
    const sessionEventLogDir = await tempDir();
    const workspaceRoot = await tempDir();
    const server = new DaemonServer({
      port: 0,
      sessionEventLogDir,
      workflowSchedulerIntervalMs: 0,
    });
    server.setProviderFactory(() => twoTurnProvider());
    server.setToolFactory(() => []);

    try {
      const port = await server.start();
      const ws = await openClient(port);
      await runAndWait(ws, {
        runId: "run_preview_target",
        sessionId: "session_preview",
        cwd: workspaceRoot,
        prompt: "target",
      });
      await runAndWait(ws, {
        runId: "run_preview_current",
        sessionId: "session_preview",
        cwd: workspaceRoot,
        prompt: "current",
      });

      const runtimeSessionEntries = await readRuntimeSessionEntries(sessionEventLogDir);
      const messageEntries = runtimeSessionEntries.filter((entry) => entry.type === "message");
      const firstUserEntryId = messageEntries[0]!.id;
      const firstAssistantEntryId = messageEntries[1]!.id;
      const runtimeCurrentLeafId = messageEntries.at(-1)!.id;

      const boundaries = new ConversationBoundaryManifestService({
        manifestPath: resolveDaemonConversationBoundaryManifestPath({ sessionEventLogDir }),
      });
      const checkpoints = new CheckpointManifestService({
        manifestPath: resolveDaemonCheckpointManifestPath({ sessionEventLogDir }),
      });
      await boundaries.append({
        sessionId: "session_preview",
        runId: "run_preview_target",
        userMessageId: "user_preview",
        sessionTreeLeafIdBefore: firstUserEntryId,
        sessionTreeLeafIdAfter: firstAssistantEntryId,
        runtimeLeafIdBefore: firstUserEntryId,
        runtimeLeafIdAfter: firstAssistantEntryId,
        eventSequence: 1,
        workspaceRoot,
        changedPaths: ["a.txt"],
        createdAt: "2026-06-08T00:00:00.000Z",
      });
      await checkpoints.append({
        sessionId: "session_preview",
        runId: "run_preview_target",
        userMessageId: "user_preview",
        checkpointId: "checkpoint_preview",
        checkpointRef: "checkpoint://runtime/preview",
        workspaceRoot,
        changedPaths: ["a.txt"],
        source: "runtime",
        createdAt: "2026-06-08T00:00:01.000Z",
      });

      const result = await sendAndCollectMessage(ws, {
        type: "preview-conversation-rewind-by-boundary",
        sessionId: "session_preview",
        userMessageId: "user_preview",
        mode: "keep-user-message",
        restorePolicy: "required",
      }, (message) => message.type === "conversation-rewind-boundary");

      expect(result.status).toBe("ok");
      expect(result.plan).toMatchObject({
        sessionId: "session_preview",
        fromLeafId: runtimeCurrentLeafId,
        targetLeafId: firstAssistantEntryId,
        workspaceRestore: {
          source: "runtime-manifest",
          checkpointId: "checkpoint_preview",
          manifestPath: "checkpoint://runtime/preview",
        },
      });
      expect(result.plan?.steps.map((step: { type: string }) => step.type)).toContain("restore-workspace");
      const afterPreviewEvents = await sendAndCollectMessage(ws, {
        type: "read-session-events",
        sessionId: "session_preview",
        afterSequence: 0,
      }, (message) => message.type === "session-events");
      expect(afterPreviewEvents.events.map((event: { type: string }) => event.type)).not.toContain("session-leaf-moved");
      ws.close();
    } finally {
      await server.stop().catch(() => undefined);
    }
  });

  it("emits user-message boundaries automatically for real daemon runs", async () => {
    const sessionEventLogDir = await tempDir();
    const workspaceRoot = await tempDir();
    const server = new DaemonServer({
      port: 0,
      sessionEventLogDir,
      workflowSchedulerIntervalMs: 0,
    });
    server.setProviderFactory(() => twoTurnProvider());
    server.setToolFactory(() => []);

    try {
      const port = await server.start();
      const ws = await openClient(port);
      await runAndWait(ws, {
        runId: "run_auto_boundary_first",
        sessionId: "session_auto_boundary",
        cwd: workspaceRoot,
        prompt: "first",
      });
      await runAndWait(ws, {
        runId: "run_auto_boundary_second",
        sessionId: "session_auto_boundary",
        cwd: workspaceRoot,
        prompt: "second",
      });

      const boundaries = new ConversationBoundaryManifestService({
        manifestPath: resolveDaemonConversationBoundaryManifestPath({ sessionEventLogDir }),
      });
      const records = await boundaries.list({ sessionId: "session_auto_boundary" });
      const messageEntries = (await readRuntimeSessionEntries(sessionEventLogDir)).filter((entry) => entry.type === "message");
      expect(records.map((record) => record.runId)).toEqual([
        "run_auto_boundary_first",
        "run_auto_boundary_first",
        "run_auto_boundary_second",
        "run_auto_boundary_second",
      ]);
      expect(records.every((record) => record.userMessageId.startsWith("user_boundary_"))).toBe(true);
      const firstBoundary = await boundaries.findLatest({
        sessionId: "session_auto_boundary",
        runId: "run_auto_boundary_first",
      });
      const secondBoundary = await boundaries.findLatest({
        sessionId: "session_auto_boundary",
        runId: "run_auto_boundary_second",
      });
      expect(firstBoundary).toMatchObject({
        userMessageId: messageEntries[0]?.message.id,
        sessionTreeLeafIdAfter: messageEntries[1]?.id,
        runtimeLeafIdAfter: messageEntries[1]?.id,
      });
      expect(secondBoundary).toMatchObject({
        userMessageId: messageEntries[2]?.message.id,
        sessionTreeLeafIdBefore: messageEntries[1]?.id,
        sessionTreeLeafIdAfter: messageEntries[3]?.id,
        runtimeLeafIdBefore: messageEntries[1]?.id,
        runtimeLeafIdAfter: messageEntries[3]?.id,
      });

      const keep = await sendAndCollectMessage(ws, {
        type: "resolve-conversation-rewind-boundary",
        sessionId: "session_auto_boundary",
        latestUserMessage: true,
        mode: "keep-user-message",
      }, (message) => message.type === "conversation-rewind-boundary");
      expect(keep.status).toBe("blocked");
      expect(keep.boundary?.runId).toBe("run_auto_boundary_second");
      expect(keep.target).toMatchObject({
        sessionTreeTargetLeafId: secondBoundary?.sessionTreeLeafIdAfter,
        runtimeTargetLeafId: secondBoundary?.runtimeLeafIdAfter,
      });
      expect(keep.missingFacts).toContain("workspace-checkpoint");

      const remove = await sendAndCollectMessage(ws, {
        type: "resolve-conversation-rewind-boundary",
        sessionId: "session_auto_boundary",
        userMessageId: secondBoundary?.userMessageId,
        mode: "remove-user-message",
      }, (message) => message.type === "conversation-rewind-boundary");
      expect(remove.target).toMatchObject({
        sessionTreeTargetLeafId: secondBoundary?.sessionTreeLeafIdBefore,
        runtimeTargetLeafId: secondBoundary?.runtimeLeafIdBefore,
      });

      const preview = await sendAndCollectMessage(ws, {
        type: "preview-conversation-rewind-by-boundary",
        sessionId: "session_auto_boundary",
        latestUserMessage: true,
        mode: "keep-user-message",
      }, (message) => message.type === "conversation-rewind-boundary");
      expect(preview.status).toBe("blocked");
      expect(preview.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "REWIND_WORKSPACE_CHECKPOINT_MISSING",
          fact: "workspace-checkpoint",
          blocked: true,
        }),
      ]));
      ws.close();
    } finally {
      await server.stop().catch(() => undefined);
    }
  });

  it("associates runtime checkpoint manifests with the active user boundary", async () => {
    const sessionEventLogDir = await tempDir();
    const workspaceRoot = await tempDir();
    await writeFile(join(workspaceRoot, "tracked.txt"), "before", "utf8");
    const server = new DaemonServer({
      port: 0,
      sessionEventLogDir,
      workflowSchedulerIntervalMs: 0,
    });
    server.setProviderFactory(() => checkpointProvider());
    server.setToolFactory(() => [checkpointTool(workspaceRoot)]);

    try {
      const port = await server.start();
      const ws = await openClient(port);
      await runAndWait(ws, {
        runId: "run_auto_checkpoint",
        sessionId: "session_auto_checkpoint",
        cwd: workspaceRoot,
        prompt: "checkpoint tracked file",
        permissionMode: "full-access",
      });

      const boundaries = new ConversationBoundaryManifestService({
        manifestPath: resolveDaemonConversationBoundaryManifestPath({ sessionEventLogDir }),
      });
      const boundary = await boundaries.findLatest({ sessionId: "session_auto_checkpoint" });
      expect(boundary).toBeDefined();
      // Runtime synthesis nudges are role=user but must not become the latest product boundary.
      expect(boundary!.userMessageId.startsWith("user_boundary_")).toBe(true);
      const uniqueUserIds = [
        ...new Set((await boundaries.list({ sessionId: "session_auto_checkpoint" })).map((r) => r.userMessageId)),
      ];
      expect(uniqueUserIds).toEqual([boundary!.userMessageId]);
      const checkpoint = await new CheckpointManifestService({
        manifestPath: resolveDaemonCheckpointManifestPath({ sessionEventLogDir }),
      }).findLatestForRewindBoundary({
        sessionId: "session_auto_checkpoint",
        userMessageId: boundary!.userMessageId,
      });
      expect(checkpoint).toMatchObject({
        sessionId: "session_auto_checkpoint",
        runId: "run_auto_checkpoint",
        userMessageId: boundary!.userMessageId,
        changedPaths: ["tracked.txt"],
        source: "runtime",
      });

      const resolved = await sendAndCollectMessage(ws, {
        type: "resolve-conversation-rewind-boundary",
        sessionId: "session_auto_checkpoint",
        latestUserMessage: true,
      }, (message) => message.type === "conversation-rewind-boundary");
      expect(resolved.status).toBe("ok");
      expect(resolved.checkpoint?.checkpointId).toBe(checkpoint?.checkpointId);
      expect(resolved.target?.checkpoint).toMatchObject({
        checkpointId: checkpoint?.checkpointId,
        checkpointRef: checkpoint?.checkpointRef,
        changedPaths: ["tracked.txt"],
      });
      ws.close();
    } finally {
      await server.stop().catch(() => undefined);
    }
  });
});

function boundaryInput(
  workspaceRoot: string,
  sessionId: string,
  runId: string,
  userMessageId: string,
  leaf: string,
  runtimeLeaf: string,
  createdAt: string
) {
  return {
    sessionId,
    runId,
    userMessageId,
    sessionTreeLeafIdAfter: leaf,
    runtimeLeafIdAfter: runtimeLeaf,
    eventSequence: 1,
    workspaceRoot,
    changedPaths: ["a.txt"],
    createdAt,
  };
}

function twoTurnProvider(): AgentProvider {
  return createScriptedProvider([
    [{ type: "text-delta", text: "ok" }, { type: "stop", reason: "stop" }],
  ]);
}

function checkpointProvider(): AgentProvider {
  return createScriptedProvider([
    [
      {
        type: "tool-call",
        id: "call_checkpoint",
        toolName: "checkpoint_fixture",
        input: {},
      },
      { type: "stop", reason: "tool-call" },
    ],
    [{ type: "text-delta", text: "checkpoint done" }, { type: "stop", reason: "stop" }],
  ]);
}

function checkpointTool(workspaceRoot: string): AgentTool {
  return {
    name: "checkpoint_fixture",
    label: "Checkpoint fixture",
    description: "Create a workspace checkpoint for resolver tests.",
    category: "filesystem",
    concurrency: "exclusive",
    isReadOnly: () => false,
    summarize: () => "checkpoint tracked.txt",
    async execute(_input, context) {
      const checkpoint = await createWorkspaceCheckpoint({
        workspaceRoot,
        sessionId: context.sessionId,
        label: "before fixture mutation",
        files: ["tracked.txt"],
      });
      return {
        text: `Created checkpoint ${checkpoint.id}`,
        artifacts: [checkpointToArtifact(checkpoint)],
        json: {
          checkpointId: checkpoint.id,
          manifestPath: checkpoint.manifestPath,
          files: checkpoint.files.map((file) => file.path),
        },
      };
    },
  };
}

async function runAndWait(
  ws: WebSocket,
  input: { runId: string; sessionId: string; cwd: string; prompt: string; permissionMode?: "ask" | "full-access" }
): Promise<void> {
  await sendAndCollectMessage(ws, { type: "run-task", ...input }, (message) => {
    return message.type === "event" && message.runId === input.runId && message.event?.type === "agent-end";
  });
}

async function readRuntimeSessionEntries(sessionEventLogDir: string): Promise<Array<Record<string, any>>> {
  const runtimeSessionDir = join(sessionEventLogDir, "runtime-sessions");
  const [file] = await readdir(runtimeSessionDir);
  const text = await readFile(join(runtimeSessionDir, file!), "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "session");
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-rewind-boundary-"));
  tempDirs.push(dir);
  return dir;
}

async function openClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function sendAndCollectMessage(
  ws: WebSocket,
  payload: Record<string, unknown>,
  done: (message: any) => boolean
): Promise<any> {
  const messages = collectMessages(ws, done);
  ws.send(JSON.stringify(payload));
  return (await messages).at(-1);
}

async function collectMessages(ws: WebSocket, done: (message: any) => boolean): Promise<any[]> {
  const messages: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString());
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
    }, 5_000);
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
  return messages;
}
