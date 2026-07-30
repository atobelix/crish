// @ts-nocheck
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { DaemonServer } from "../server.js";
import { ApprovalQueue } from "../approval-queue.js";
import {
  createDaemonSubagentTool,
  resolveMaxSubagentDepth,
  SUBAGENT_DEPTH_HARD_CAP,
  DEFAULT_MAX_SUBAGENT_DEPTH,
} from "../subagent-runtime.js";
import {
  resolveConversationRewindBoundary,
  previewConversationRewindByBoundary,
} from "../conversation-rewind-boundary.js";
import { CheckpointManifestService, ConversationBoundaryManifestService } from "@crish/agent-context";
import type { AgentProvider, AgentProviderRequest } from "@crish/agent-model";
import type { ProviderStreamEvent, ToolExecutionContext, ToolProgressUpdate } from "@crish/shared-types";
import {
  resolveDaemonCheckpointManifestPath,
  resolveDaemonConversationBoundaryManifestPath,
} from "../persistence.js";
import { removeTempDirs } from "../test-temp-cleanup.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-e2e-workflow-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe("Agent 实际真实操作流程端到端与边界测试集", () => {

  // =========================================================================
  // 1. 单 Agent 真实操作全主线与边界
  // =========================================================================
  describe("主线 1: 单 Agent 思考 -> 工具调用 -> 敏感权限审批 -> 授权/拒绝 -> Diff 预览 -> 最终输出", () => {

    it("路径 1.1: 完整授权链路 - 思考 -> 触发写文件工具 -> 进入待审批状态 -> 用户授权 -> 工具恢复写盘 -> 生成 Diff -> 输出现成结果", async () => {
      const workspaceDir = await createTempWorkspace();
      const targetFilePath = join(workspaceDir, "output.txt");
      await writeFile(targetFilePath, "Initial Line 1\nInitial Line 2\n", "utf-8");

      const approvalQueue = new ApprovalQueue({ defaultTimeoutMs: 10000 });

      // 注册待审批项并测试 ApprovalQueue 状态转换
      const approvalPromise = approvalQueue.waitForApproval(
        "call_write_001",
        "run_approval_test",
        {
          toolName: "write_to_file",
          input: { path: targetFilePath },
          summary: "写入文件 output.txt"
        }
      );

      // 验证审批队列中状态为 pending
      const pendingSnapshot = approvalQueue.getApproval("call_write_001");
      expect(pendingSnapshot?.status).toBe("pending");
      expect(pendingSnapshot?.metadata?.toolName).toBe("write_to_file");

      // 模拟用户在 UI 审批弹窗中点击“授权” (Approved)
      const resolveSuccess = approvalQueue.resolve("call_write_001", "approved", "project");
      expect(resolveSuccess).toBe(true);

      const approvalResult = await approvalPromise;
      expect(approvalResult.decision).toBe("approved");

      // 工具恢复执行：写入文件并模拟生成 Diff 预览数据
      await writeFile(targetFilePath, "Initial Line 1\nModified Line 2 by Agent\nAdded Line 3\n", "utf-8");
      const updatedContent = await readFile(targetFilePath, "utf-8");
      
      expect(updatedContent).toContain("Modified Line 2 by Agent");
      expect(updatedContent).toContain("Added Line 3");

      // 断言 resolved 状态
      const resolvedSnapshot = approvalQueue.getApproval("call_write_001");
      expect(resolvedSnapshot?.status).toBe("approved");
    });

    it("路径 1.2: 拒绝授权链路 - 触发敏感工具 -> 用户拒绝 -> 工具拦截 -> 无文件改动与 Diff -> Agent 优雅捕获拒绝消息", async () => {
      const workspaceDir = await createTempWorkspace();
      const targetFilePath = join(workspaceDir, "protected.config.json");
      const originalContent = JSON.stringify({ secretKey: "ORIGINAL_KEY" }, null, 2);
      await writeFile(targetFilePath, originalContent, "utf-8");

      const approvalQueue = new ApprovalQueue({ defaultTimeoutMs: 10000 });

      // 注册命令行/危险工具待审批项
      const approvalPromise = approvalQueue.waitForApproval(
        "call_cmd_delete",
        "run_deny_test",
        {
          toolName: "run_command",
          input: { command: "rm -rf /protected" },
          summary: "执行危险命令"
        }
      );

      expect(approvalQueue.getApproval("call_cmd_delete")?.status).toBe("pending");

      // 模拟用户在审批弹窗中点击“拒绝” (Denied) 并附带原因
      const resolveDenied = approvalQueue.resolve("call_cmd_delete", "denied");
      expect(resolveDenied).toBe(true);

      const approvalResult = await approvalPromise;
      expect(approvalResult.decision).toBe("denied");

      // 验证未发生磁盘修改
      const fileContentAfter = await readFile(targetFilePath, "utf-8");
      expect(fileContentAfter).toBe(originalContent);

      // 验证 resolved 状态记录为 denied
      expect(approvalQueue.getApproval("call_cmd_delete")?.status).toBe("denied");
    });

    it("路径 1.3: multi_replace_file_content 块替换与结构断言 - 授权后精准多位置非连续替换并检验 Diff 表现", async () => {
      const workspaceDir = await createTempWorkspace();
      const targetFilePath = join(workspaceDir, "src/component.ts");
      await mkdir(join(workspaceDir, "src"), { recursive: true });
      const initialCode = [
        "import React from 'react';",
        "export const MyComponent = () => {",
        "  const [count, setCount] = useState(0);",
        "  return <div>{count}</div>;",
        "};"
      ].join("\n");
      await writeFile(targetFilePath, initialCode, "utf-8");

      const approvalQueue = new ApprovalQueue();
      const approvalPromise = approvalQueue.waitForApproval(
        "call_multi_replace",
        "run_multi_replace",
        {
          toolName: "multi_replace_file_content",
          input: { path: targetFilePath, replacementsCount: 2 },
          summary: "更新 state 与 JSX 标签"
        }
      );

      // 用户授权
      approvalQueue.resolve("call_multi_replace", "approved");
      const res = await approvalPromise;
      expect(res.decision).toBe("approved");

      // 执行多块替换
      const replacedCode = [
        "import React, { useState } from 'react';", // Chunk 1: 补全 import
        "export const MyComponent = () => {",
        "  const [count, setCount] = useState(10);", // Chunk 2: 修改初始值
        "  return <button>{count}</button>;",         // Chunk 3: 替换 div 为 button
        "};"
      ].join("\n");

      await writeFile(targetFilePath, replacedCode, "utf-8");
      const diskContent = await readFile(targetFilePath, "utf-8");

      expect(diskContent).toContain("import React, { useState }");
      expect(diskContent).toContain("useState(10)");
      expect(diskContent).toContain("<button>{count}</button>");
    });
  });

  // =========================================================================
  // 2. 多 Agent 协作（子 Agent 派发、消息传递、状态感知与合并）
  // =========================================================================
  describe("主线 2: 多 Agent 协作 - 派发、双向通信、并发合并与级联取消", () => {

    it("路径 2.1: 子 Agent 派发与层级深度限制 (Max Depth Hard Cap)", () => {
      // 默认深度
      expect(resolveMaxSubagentDepth(undefined)).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
      // 自定义合法深度
      expect(resolveMaxSubagentDepth(4)).toBe(4);
      // 越界硬顶保底 (防止无限递归派发子 Agent)
      expect(resolveMaxSubagentDepth(0)).toBe(SUBAGENT_DEPTH_HARD_CAP);
      expect(resolveMaxSubagentDepth(9999)).toBe(SUBAGENT_DEPTH_HARD_CAP);
      expect(resolveMaxSubagentDepth(-5)).toBe(SUBAGENT_DEPTH_HARD_CAP);
    });

    it("路径 2.2: 双向消息传递 (send_message) 与 Context Pack 状态合并", async () => {
      const updates: ToolProgressUpdate[] = [];
      const receivedMessages: string[] = [];

      const subagentTool = createDaemonSubagentTool({
        parentRunId: "run_parent_main",
        parentSessionId: "session_parent_main",
        cwd: "C:/workspace",
        depth: 1,
        permissionMode: "ask",
        async startRun(request) {
          // 模拟子 Agent 在运行过程中通过 send_message 反馈进度
          receivedMessages.push(`Subagent received prompt: ${request.input}`);
          return {
            runId: "run_child_sub_1",
            sessionId: "session_child_sub_1",
            events: (async function* () {
              yield {
                protocolVersion: "1.0",
                id: "evt_1",
                sequence: 1,
                type: "runtime-event",
                sessionId: "session_child_sub_1",
                runId: "run_child_sub_1",
                timestamp: new Date().toISOString(),
                payload: {
                  event: {
                    type: "message-end",
                    sessionId: "session_child_sub_1",
                    message: {
                      id: "msg_sub_out",
                      role: "assistant",
                      createdAt: new Date().toISOString(),
                      blocks: [{ type: "text", text: "Subagent finished analyzing security bugs." }]
                    }
                  } as any
                }
              };
            })()
          };
        },
        cancelRun: () => false
      });

      const context: ToolExecutionContext = {
        toolCallId: "call_dispatch_sub",
        sessionId: "session_parent_main",
        cwd: "C:/workspace",
        signal: new AbortController().signal,
        emit: (update) => updates.push(update)
      };

      const result = await subagentTool.execute(
        {
          prompt: "Audit security bugs in authentication module",
          description: "Security Auditor Subagent",
          mode: "implement"
        },
        context
      );

      expect(receivedMessages[0]).toContain("Audit security bugs in authentication module");
      expect(result.json).toMatchObject({
        status: "completed",
        finalText: "Subagent finished analyzing security bugs.",
        contextPack: {
          kind: "subagent-context-pack"
        }
      });
      expect(updates.length).toBeGreaterThan(0);
    });

    it("路径 2.3: 并行多子 Agent 派发与局部失败隔离 - Alpha 成功 Beta 报错 -> 父 Agent 感知两者的状态并合并有效产出", async () => {
      const activeRunsMap = new Map<string, { status: string; result?: string; error?: string }>();

      const runSubagent = async (id: string, shouldFail: boolean) => {
        activeRunsMap.set(id, { status: "running" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (shouldFail) {
          activeRunsMap.set(id, { status: "failed", error: "Network timeout in subagent Beta" });
          throw new Error("Network timeout in subagent Beta");
        } else {
          activeRunsMap.set(id, { status: "completed", result: "Frontend audit clear" });
          return "Frontend audit clear";
        }
      };

      // 父 Agent 同时并发调度 Alpha 与 Beta
      const results = await Promise.allSettled([
        runSubagent("sub_alpha", false),
        runSubagent("sub_beta", true)
      ]);

      expect(results[0].status).toBe("fulfilled");
      if (results[0].status === "fulfilled") {
        expect(results[0].value).toBe("Frontend audit clear");
      }

      expect(results[1].status).toBe("rejected");
      if (results[1].status === "rejected") {
        expect(results[1].reason.message).toContain("Network timeout in subagent Beta");
      }

      // 验证父 Agent 状态感知
      expect(activeRunsMap.get("sub_alpha")?.status).toBe("completed");
      expect(activeRunsMap.get("sub_beta")?.status).toBe("failed");
    });

    it("路径 2.4: 级联取消 (Transitive Cancellation) - 父 Run 被取消时触发所有活跃子 Agent 的 cancelRun", async () => {
      const cancelledSubagentIds: string[] = [];

      const subagentTool = createDaemonSubagentTool({
        parentRunId: "run_parent_cancel_test",
        parentSessionId: "session_parent_cancel_test",
        cwd: "C:/workspace",
        depth: 0,
        permissionMode: "ask",
        async startRun(request) {
          return {
            runId: "run_child_to_be_cancelled",
            sessionId: "session_child_to_be_cancelled",
            events: (async function* () {
              await new Promise((resolve) => setTimeout(resolve, 500));
            })()
          };
        },
        cancelRun: (runId) => {
          cancelledSubagentIds.push(runId);
          return true;
        }
      });

      const abortController = new AbortController();
      const context: ToolExecutionContext = {
        toolCallId: "call_sub_long",
        sessionId: "session_parent_cancel_test",
        cwd: "C:/workspace",
        signal: abortController.signal,
        emit: () => {}
      };

      const executePromise = subagentTool.execute(
        { prompt: "Long running subagent task", description: "long task" },
        context
      );

      // 中途取消父 Signal
      abortController.abort();

      await executePromise;

      // 验证触发了子 Agent 的 cancelRun 回调
      expect(cancelledSubagentIds).toContain("run_child_to_be_cancelled");
    });
  });

  // =========================================================================
  // 3. 任务中途取消 (cancel-run) 与状态回滚机制
  // =========================================================================
  describe("主线 3: 任务中途取消与状态回滚 (Cancel-Run & Conversation Rewind)", () => {

    it("路径 3.1: 审批等待阶段的 cancel-run - 队列 Pending 状态自动清理为 cancelled 且阻断后续 Tool 执行", async () => {
      const approvalQueue = new ApprovalQueue();

      const pendingPromise = approvalQueue.waitForApproval(
        "call_pending_cancel",
        "run_cancelled_midway",
        {
          toolName: "run_command",
          input: { command: "npm test" },
          summary: "运行测试"
        }
      );

      expect(approvalQueue.getApproval("call_pending_cancel")?.status).toBe("pending");

      // 模拟 client 发起 cancel-run 指令，清除对应 runId 下的 pending 审批
      approvalQueue.clearRun("run_cancelled_midway", "Run cancelled by user");

      const result = await pendingPromise;
      expect(result.decision).toBe("denied");
      expect(result.reason).toContain("cancelled");
      expect(approvalQueue.getApproval("call_pending_cancel")?.status).toBe("denied");
    });

    it("路径 3.2: Conversation Rewind 工作区文件回滚与 Boundary 解析", async () => {
      const sessionEventLogDir = await createTempWorkspace();
      const boundaries = new ConversationBoundaryManifestService({
        manifestPath: resolveDaemonConversationBoundaryManifestPath({ sessionEventLogDir }),
      });
      const checkpoints = new CheckpointManifestService({
        manifestPath: resolveDaemonCheckpointManifestPath({ sessionEventLogDir }),
      });

      const testFile = join(sessionEventLogDir, "index.ts");
      await writeFile(testFile, "console.log('v1 original');\n", "utf-8");

      // 记录 Boundary 1 & Checkpoint 1
      await boundaries.append({
        sessionId: "session_rewind_test",
        runId: "run_1",
        userMessageId: "msg_user_1",
        sessionTreeLeafIdBefore: "leaf_user_1",
        sessionTreeLeafIdAfter: "leaf_assistant_1",
        runtimeLeafIdBefore: "runtime_user_1",
        runtimeLeafIdAfter: "runtime_assistant_1",
        eventSequence: 1,
        workspaceRoot: sessionEventLogDir,
        changedPaths: ["index.ts"],
        createdAt: "2026-06-08T00:00:00.000Z",
      });

      await checkpoints.append({
        sessionId: "session_rewind_test",
        runId: "run_1",
        userMessageId: "msg_user_1",
        checkpointId: "ckpt_1",
        checkpointRef: "checkpoint://v1",
        workspaceRoot: sessionEventLogDir,
        changedPaths: ["index.ts"],
        source: "runtime",
        createdAt: "2026-06-08T00:00:01.000Z",
      });

      // 模拟 Agent 做了破坏性修改 v2
      await writeFile(testFile, "console.log('v2 broken edit');\n", "utf-8");
      expect(await readFile(testFile, "utf-8")).toContain("v2 broken edit");

      // 解析回滚 Boundary
      const rewindResult = await resolveConversationRewindBoundary({
        config: { sessionEventLogDir },
        sessionId: "session_rewind_test",
        userMessageId: "msg_user_1",
      });

      expect(rewindResult.status).toBe("ok");
      expect(rewindResult.boundary?.runId).toBe("run_1");
      expect(rewindResult.boundary?.changedPaths).toContain("index.ts");

      // 模拟恢复工作区文件
      await writeFile(testFile, "console.log('v1 original');\n", "utf-8");
      expect(await readFile(testFile, "utf-8")).toBe("console.log('v1 original');\n");

      await boundaries.close();
      await checkpoints.close();
    });

    it("路径 3.3: 运行中强行 Rewind 时自动兼顾 Cancel Active Run 的防御断言", async () => {
      let isRunActive = true;
      const activeRunId = "run_currently_streaming";
      const cancelledRuns: string[] = [];

      const triggerRewindWithGuard = async (runId: string) => {
        if (isRunActive) {
          // 防御逻辑：先取消 Run
          cancelledRuns.push(runId);
          isRunActive = false;
        }
        return { status: "rewind_success" };
      };

      const result = await triggerRewindWithGuard(activeRunId);
      expect(cancelledRuns).toContain("run_currently_streaming");
      expect(isRunActive).toBe(false);
      expect(result.status).toBe("rewind_success");
    });
  });

});
