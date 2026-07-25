import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOCK_DAEMON_PATH = join(__dirname, "mock-daemon-process.js");

interface DaemonProcessInfo {
  child: ChildProcess;
  port: number;
  pid: number;
}

interface MessageQueueHelper {
  nextMessage: (timeoutMs?: number) => Promise<any>;
  close: () => void;
}

/**
 * 启动 Agent Daemon 子进程并等待 daemon-ready 信号
 */
function spawnDaemon(timeoutMs = 5000): Promise<DaemonProcessInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_DAEMON_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdoutData = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Daemon spawn timed out after ${timeoutMs}ms. Output: ${stdoutData}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString();
      const lines = stdoutData.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed && parsed.type === "daemon-ready") {
            clearTimeout(timer);
            resolve({ child, port: parsed.port, pid: parsed.pid });
            return;
          }
        } catch {
          // 忽略非 JSON 日志
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!child.killed) {
        reject(new Error(`Daemon exited prematurely with code ${code}, signal ${signal}`));
      }
    });
  });
}

/**
 * 建立 WebSocket 连接并返回 Promise
 */
function connectClient(port: number, timeoutMs = 3000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket connect timed out to port ${port}`));
    }, timeoutMs);

    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 创建 WebSocket 消息队列辅助工具
 */
function createMessageQueue(ws: WebSocket): MessageQueueHelper {
  const queue: any[] = [];
  const waiters: Array<[(msg: any) => void, (err: Error) => void, NodeJS.Timeout]> = [];

  const handleMessage = (rawData: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      if (waiters.length > 0) {
        const [resolve, , timer] = waiters.shift()!;
        clearTimeout(timer);
        resolve(msg);
      } else {
        queue.push(msg);
      }
    } catch (err) {
      // Ignore unparseable
    }
  };

  ws.on("message", handleMessage);

  const nextMessage = (timeoutMs = 2000): Promise<any> => {
    return new Promise((resolve, reject) => {
      if (queue.length > 0) {
        resolve(queue.shift());
        return;
      }

      const timer = setTimeout(() => {
        const index = waiters.findIndex((w) => w[2] === timer);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timeout waiting for WS message after ${timeoutMs}ms`));
      }, timeoutMs);

      waiters.push([resolve, reject, timer]);
    });
  };

  const close = () => {
    ws.off("message", handleMessage);
    for (const [, reject, timer] of waiters) {
      clearTimeout(timer);
      reject(new Error("Message queue closed"));
    }
    waiters.length = 0;
  };

  return { nextMessage, close };
}

describe("L1 Agent Protocol Headless E2E Test Suite", () => {
  const activeProcesses: ChildProcess[] = [];
  const activeSockets: WebSocket[] = [];

  afterEach(() => {
    for (const ws of activeSockets) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch {
        // Silent cleanup
      }
    }
    activeSockets.length = 0;

    for (const child of activeProcesses) {
      try {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      } catch {
        // Silent cleanup
      }
    }
    activeProcesses.length = 0;
  });

  it("1. run-task 主循环测试: 发任务文本 -> 依次收到 run-started -> stream-chunk -> run-completed", async () => {
    const daemon = await spawnDaemon();
    activeProcesses.push(daemon.child);

    const ws = await connectClient(daemon.port);
    activeSockets.push(ws);
    const mq = createMessageQueue(ws);

    const runId = "e2e-run-task-1";
    ws.send(
      JSON.stringify({
        type: "run-task",
        runId,
        prompt: "Execute normal task",
      })
    );

    const msg1 = await mq.nextMessage();
    expect(msg1).toMatchObject({
      type: "run-started",
      runId,
    });

    const msg2 = await mq.nextMessage();
    expect(msg2).toMatchObject({
      type: "stream-chunk",
      runId,
      chunk: "Processing task: Execute normal task",
    });

    const msg3 = await mq.nextMessage();
    expect(msg3).toMatchObject({
      type: "run-completed",
      runId,
      status: "completed",
      result: "Task executed successfully",
    });

    mq.close();
  });

  it("2. approve-tool 敏感权限审批挂起与响应回复测试", async () => {
    const daemon = await spawnDaemon();
    activeProcesses.push(daemon.child);

    const ws = await connectClient(daemon.port);
    activeSockets.push(ws);
    const mq = createMessageQueue(ws);

    const runId = "e2e-approve-run-1";
    const toolCallId = "call-approve-999";

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId,
        toolCallId,
        prompt: "trigger-approval: remove system logs",
      })
    );

    const msg1 = await mq.nextMessage();
    expect(msg1).toMatchObject({
      type: "run-started",
      runId,
    });

    const msg2 = await mq.nextMessage();
    expect(msg2).toMatchObject({
      type: "approval-requested",
      runId,
      toolCallId,
      toolName: "execute_sensitive_command",
      risk: "high",
    });

    // 发送审批回复
    ws.send(
      JSON.stringify({
        type: "approve-tool",
        toolCallId,
      })
    );

    const msg3 = await mq.nextMessage();
    expect(msg3).toMatchObject({
      type: "approval-resolved",
      toolCallId,
      decision: "approved",
      reason: "user-approved",
    });

    const msg4 = await mq.nextMessage();
    expect(msg4).toMatchObject({
      type: "stream-chunk",
      runId,
      chunk: "Approved action executed.",
    });

    const msg5 = await mq.nextMessage();
    expect(msg5).toMatchObject({
      type: "run-completed",
      runId,
      status: "completed",
    });

    mq.close();
  });

  it("3. subagent 父子 Agent 消息派发与状态拦截测试", async () => {
    const daemon = await spawnDaemon();
    activeProcesses.push(daemon.child);

    const ws = await connectClient(daemon.port);
    activeSockets.push(ws);
    const mq = createMessageQueue(ws);

    const runId = "e2e-subagent-run-1";
    const subagentRunId = "sub-run-888";

    ws.send(
      JSON.stringify({
        type: "run-task",
        runId,
        subagentRunId,
        prompt: "trigger-subagent: execute background subtask",
      })
    );

    const msg1 = await mq.nextMessage();
    expect(msg1).toMatchObject({
      type: "run-started",
      runId,
    });

    const msg2 = await mq.nextMessage();
    expect(msg2).toMatchObject({
      type: "subagent-started",
      runId,
      subagentId: "sub-1",
      subagentRunId,
    });

    const msg3 = await mq.nextMessage();
    expect(msg3).toMatchObject({
      type: "subagent-event",
      runId,
      subagentId: "sub-1",
      subagentRunId,
    });

    // 查询 Subagent 状态
    ws.send(
      JSON.stringify({
        type: "get-subagent-status",
        subagentRunId,
      })
    );

    const msg4 = await mq.nextMessage();
    expect(msg4).toMatchObject({
      type: "subagent-status",
      subagentRunId,
      status: "running",
      activeCount: 1,
    });

    // 派发消息至 Subagent
    ws.send(
      JSON.stringify({
        type: "send-to-subagent",
        subagentRunId,
        message: "Continue subtask execution",
      })
    );

    const msg5 = await mq.nextMessage();
    expect(msg5).toMatchObject({
      type: "subagent-message-sent",
      subagentRunId,
      accepted: true,
    });

    const msg6 = await mq.nextMessage();
    expect(msg6).toMatchObject({
      type: "subagent-ended",
      runId,
      subagentId: "sub-1",
      subagentRunId,
      status: "completed",
    });

    const msg7 = await mq.nextMessage();
    expect(msg7).toMatchObject({
      type: "run-completed",
      runId,
      status: "completed",
    });

    mq.close();
  });

  it("4. 异常恢复测试: 网络断开重连", async () => {
    const daemon = await spawnDaemon();
    activeProcesses.push(daemon.child);

    // 初始连接 1
    const ws1 = await connectClient(daemon.port);
    activeSockets.push(ws1);
    const mq1 = createMessageQueue(ws1);

    ws1.send(JSON.stringify({ type: "ping" }));
    const pong1 = await mq1.nextMessage();
    expect(pong1.type).toBe("pong");
    mq1.close();

    // 模拟网络异常断开
    ws1.terminate();

    // 重连 2
    const ws2 = await connectClient(daemon.port);
    activeSockets.push(ws2);
    const mq2 = createMessageQueue(ws2);

    ws2.send(JSON.stringify({ type: "ping" }));
    const pong2 = await mq2.nextMessage();
    expect(pong2.type).toBe("pong");

    // 重连后正常执行任务
    const runId = "e2e-reconnect-run";
    ws2.send(
      JSON.stringify({
        type: "run-task",
        runId,
        prompt: "Post-reconnect task",
      })
    );

    const msgStarted = await mq2.nextMessage();
    expect(msgStarted).toMatchObject({ type: "run-started", runId });

    const msgChunk = await mq2.nextMessage();
    expect(msgChunk).toMatchObject({ type: "stream-chunk", runId });

    const msgCompleted = await mq2.nextMessage();
    expect(msgCompleted).toMatchObject({ type: "run-completed", runId, status: "completed" });

    mq2.close();
  });

  it("5. 异常恢复测试: 进程 SIGTERM/SIGKILL 崩溃与重启恢复", async () => {
    // 启动 实例 1
    const daemon1 = await spawnDaemon();
    activeProcesses.push(daemon1.child);

    const ws1 = await connectClient(daemon1.port);
    activeSockets.push(ws1);
    const mq1 = createMessageQueue(ws1);

    ws1.send(JSON.stringify({ type: "ping" }));
    const pong1 = await mq1.nextMessage();
    expect(pong1.type).toBe("pong");
    mq1.close();

    // 强行关闭 SIGTERM / SIGKILL
    const exitPromise = new Promise<void>((resolve) => {
      daemon1.child.on("exit", () => resolve());
    });
    daemon1.child.kill("SIGTERM");
    await exitPromise;

    // 守护进程拉起新实例 2
    const daemon2 = await spawnDaemon();
    activeProcesses.push(daemon2.child);

    const ws2 = await connectClient(daemon2.port);
    activeSockets.push(ws2);
    const mq2 = createMessageQueue(ws2);

    ws2.send(JSON.stringify({ type: "ping" }));
    const pong2 = await mq2.nextMessage();
    expect(pong2.type).toBe("pong");

    const runId = "e2e-recovered-proc-run";
    ws2.send(
      JSON.stringify({
        type: "run-task",
        runId,
        prompt: "Recovered daemon task",
      })
    );

    const msgStarted = await mq2.nextMessage();
    expect(msgStarted).toMatchObject({ type: "run-started", runId });

    const msgChunk = await mq2.nextMessage();
    expect(msgChunk).toMatchObject({ type: "stream-chunk", runId });

    const msgCompleted = await mq2.nextMessage();
    expect(msgCompleted).toMatchObject({ type: "run-completed", runId, status: "completed" });

    mq2.close();
  });
});
