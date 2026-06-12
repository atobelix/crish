/**
 * ToolExecutor - 工具执行器
 *
 * 从 AgentRuntime 中拆分出来的独立组件，负责：
 * 1. 工具调用的并行/串行执行（仅保留有事件路径）
 * 2. 工具输入校验与修复
 * 3. 执行超时与取消
 * 4. 批量执行策略
 *
 * 重构（Layer 3）：
 * - 移除无事件路径（executeBatch、executeSingle、executeParallel、executeSequential、executeWithTimeout）
 *   这些方法在运行时管线中从未被行使，runtime 始终走 executeBatchWithEvents
 * - ToolExecutor 重新定位为纯粹的"并发/串行批量调度器"
 * - 导出 ProgressEventQueue（消除跨文件重复）
 * - 业务逻辑（权限、物化、Checkpoint）通过 ToolMiddleware 管线注入
 */

import type {
  AgentEvent,
  JsonObject,
  ToolBatchCall,
  ToolBatchResult,
  ToolBatchFailurePolicy,
  ToolCallBlock,
  ToolExecutionContext,
  ToolOutput,
} from "@crish/shared-types";
import type { AgentTool } from "../types";
import { validateToolInput, repairToolInput } from "../tools";
import { createId, nowIso } from "../session";

// ─── 工具执行完成结果 ─────────────────────────────────────

export type ToolExecutionCompletion =
  | { ok: true; output: ToolOutput }
  | { ok: false; kind: "error" | "timeout" | "cancelled"; cause: unknown };

// ─── 工具执行器配置 ───────────────────────────────────────

export interface ToolExecutorOptions {
  timeoutMs: number;
  parallelFailurePolicy: ToolBatchFailurePolicy;
}

/**
 * 单工具执行钩子
 *
 * 调用方可通过此钩子自定义每个工具调用的完整生命周期（事件 + 结果），
 * 例如注入权限检查、checkpoint 录制、大输出物化等中间件逻辑。
 *
 * 如果不提供此钩子，ToolExecutor 使用内建的 executeSingleWithEvents 作为默认实现。
 */
export type ToolExecuteHook = (
  toolCall: ToolCallBlock,
  tools: AgentTool[],
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
  batchId: string
) => AsyncGenerator<AgentEvent, ToolBatchResult>;

// ─── ProgressEventQueue ───────────────────────────────────

/**
 * 异步事件队列 — 用于并行执行时收集事件。
 *
 * 线程安全（单生产者-单消费者），支持 push/close/next 操作。
 * close 后所有等待的 next() 调用会收到 done=true。
 */
export class ProgressEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

// ─── ToolExecutor ─────────────────────────────────────────

export class ToolExecutor {
  constructor(private readonly options: ToolExecutorOptions) {}

  /**
   * 将工具调用按并行/串行分区
   *
   * 并行工具会被分到同一组，其他工具按顺序执行。
   * 此方法为公共方法，供外部调用者使用分区逻辑而不委托执行。
   */
  partitionBatch(toolCalls: ToolCallBlock[], tools: AgentTool[]): ToolCallBlock[][] {
    // 简单分区：将并行工具分到一组，其他按顺序执行
    const groups: ToolCallBlock[][] = [];
    let currentParallelGroup: ToolCallBlock[] = [];

    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.toolName);
      if (tool?.concurrency === "parallel") {
        currentParallelGroup.push(call);
      } else {
        if (currentParallelGroup.length > 0) {
          groups.push(currentParallelGroup);
          currentParallelGroup = [];
        }
        groups.push([call]);
      }
    }

    if (currentParallelGroup.length > 0) {
      groups.push(currentParallelGroup);
    }

    return groups;
  }

  /**
   * 判断分组是否全部可并行执行
   */
  isFullyParallel(group: ToolCallBlock[], tools: AgentTool[]): boolean {
    return group.every((call) => {
      const tool = tools.find((t) => t.name === call.toolName);
      return tool?.concurrency === "parallel";
    });
  }

  /**
   * 批量执行工具调用，同时生成事件流
   *
   * 这是 ToolExecutor 的唯一执行入口。
   * 在执行过程中逐步产出 AgentEvent，最终返回 ToolBatchResult[]。
   * 这使得调用者可以在工具执行过程中实时获取进度事件。
   */
  async *executeBatchWithEvents(
    toolCalls: ToolCallBlock[],
    tools: AgentTool[],
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
    onToolExecute?: ToolExecuteHook
  ): AsyncGenerator<AgentEvent, ToolBatchResult[]> {
    const executeOne = onToolExecute ?? this.executeSingleWithEvents.bind(this);

    // ── 串行污染预检 ─────────────────────────────────────
    if (shouldExecuteSequential(toolCalls, tools)) {
      const batchId = createId("batch");
      const calls = toolCalls.map((call) => this.toBatchCall(call, tools));
      yield {
        type: "tool-batch-start",
        sessionId,
        batchId,
        timestamp: nowIso(),
        summary: this.summarizeBatch(calls),
        calls
      };
      const batchResults = yield* this.executeSequentialWithEvents(
        toolCalls, tools, sessionId, cwd, signal, batchId, executeOne
      );
      yield {
        type: "tool-batch-end",
        sessionId,
        batchId,
        timestamp: nowIso(),
        calls: batchResults
      };
      return batchResults;
    }

    const batches = this.partitionBatch(toolCalls, tools);
    const allResults: ToolBatchResult[] = [];

    for (const batch of batches) {
      const batchId = createId("batch");
      const calls = batch.map((call) => this.toBatchCall(call, tools));

      yield {
        type: "tool-batch-start",
        sessionId,
        batchId,
        timestamp: nowIso(),
        summary: this.summarizeBatch(calls),
        calls
      };

      const isParallel = this.isFullyParallel(batch, tools);
      const batchResults = isParallel
        ? yield* this.executeParallelWithEvents(batch, tools, sessionId, cwd, signal, batchId, executeOne)
        : yield* this.executeSequentialWithEvents(batch, tools, sessionId, cwd, signal, batchId, executeOne);

      yield {
        type: "tool-batch-end",
        sessionId,
        batchId,
        timestamp: nowIso(),
        calls: batchResults
      };

      allResults.push(...batchResults);
    }

    return allResults;
  }

  private async *executeSequentialWithEvents(
    toolCalls: ToolCallBlock[],
    tools: AgentTool[],
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
    batchId: string,
    executeOne: ToolExecuteHook
  ): AsyncGenerator<AgentEvent, ToolBatchResult[]> {
    const results: ToolBatchResult[] = [];
    for (const call of toolCalls) {
      if (signal.aborted) break;
      const result = yield* executeOne(call, tools, sessionId, cwd, signal, batchId);
      results.push(result);
      if (result.isError && this.options.parallelFailurePolicy === "cancel-siblings") break;
    }
    return results;
  }

  private async *executeParallelWithEvents(
    toolCalls: ToolCallBlock[],
    tools: AgentTool[],
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
    batchId: string,
    executeOne: ToolExecuteHook
  ): AsyncGenerator<AgentEvent, ToolBatchResult[]> {
    // 并行执行需要使用 ProgressEventQueue 来收集事件
    type ParallelItem =
      | { type: "event"; event: AgentEvent }
      | { type: "result"; index: number; result: ToolBatchResult }
      | { type: "error"; error: unknown };

    const queue = new ProgressEventQueue<ParallelItem>();
    const results: Array<ToolBatchResult | undefined> = new Array(toolCalls.length);
    const batchController = new AbortController();

    // 链接外部 signal
    const onAbort = (): void => batchController.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    let completed = 0;
    for (let index = 0; index < toolCalls.length; index++) {
      const iterator = executeOne(
        toolCalls[index]!, tools, sessionId, cwd, batchController.signal, batchId
      );
      void (async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              queue.push({ type: "result", index, result: next.value });
              break;
            }
            queue.push({ type: "event", event: next.value });
          }
        } catch (error) {
          queue.push({ type: "error", error });
        }
      })();
    }

    while (completed < toolCalls.length) {
      const next = await queue.next();
      if (next.done) break;
      if (next.value.type === "event") {
        yield next.value.event;
        continue;
      }
      if (next.value.type === "error") {
        batchController.abort();
        signal.removeEventListener("abort", onAbort);
        queue.close();
        throw next.value.error;
      }
      results[next.value.index] = next.value.result;
      if (
        this.options.parallelFailurePolicy === "cancel-siblings" &&
        next.value.result.isError &&
        !batchController.signal.aborted
      ) {
        batchController.abort();
      }
      completed += 1;
    }

    signal.removeEventListener("abort", onAbort);
    queue.close();
    return results.filter((result): result is ToolBatchResult => Boolean(result));
  }

  private async *executeSingleWithEvents(
    toolCall: ToolCallBlock,
    tools: AgentTool[],
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
    batchId: string
  ): AsyncGenerator<AgentEvent, ToolBatchResult> {
    const startedAt = Date.now();
    const call = this.toBatchCall(toolCall, tools);

    yield { type: "tool-start", sessionId, batchId, call, timestamp: nowIso() };

    const tool = tools.find((t) => t.name === toolCall.toolName);
    if (!tool) {
      const result: ToolBatchResult = {
        id: call.id,
        toolName: call.toolName,
        output: { text: `Tool not found: ${toolCall.toolName}` },
        isError: true,
        durationMs: Date.now() - startedAt
      };
      yield { type: "tool-end", sessionId, batchId, result, timestamp: nowIso() };
      return result;
    }

    // 输入校验
    const validationErrors = validateToolInput(tool, toolCall.input);
    if (validationErrors.length > 0) {
      const result: ToolBatchResult = {
        id: call.id,
        toolName: call.toolName,
        output: { text: `Tool input validation failed:\n${validationErrors.join("\n")}` },
        isError: true,
        durationMs: Date.now() - startedAt
      };
      yield { type: "tool-end", sessionId, batchId, result, timestamp: nowIso() };
      return result;
    }

    // 输入修复
    const repair = repairToolInput(tool, toolCall.input);

    // 执行并收集进度事件
    const progressQueue = new ProgressEventQueue<AgentEvent>();
    const context: ToolExecutionContext = {
      toolCallId: toolCall.id,
      sessionId,
      cwd,
      signal,
      emit(update) {
        progressQueue.push({
          type: "tool-update",
          sessionId,
          batchId,
          toolCallId: toolCall.id,
          update,
          timestamp: nowIso()
        });
      }
    };

    const executionPromise = (async (): Promise<ToolExecutionCompletion> => {
      try {
        const output = await tool.execute(repair.input, context);
        return { ok: true, output };
      } catch (cause) {
        return {
          ok: false,
          kind: signal.aborted ? "cancelled" : "error",
          cause
        };
      }
    })().finally(() => {
      progressQueue.close();
    });

    // 产出进度事件
    while (true) {
      const next = await progressQueue.next();
      if (next.done) break;
      yield next.value;
    }

    const completed = await executionPromise;
    const result: ToolBatchResult = {
      id: call.id,
      toolName: call.toolName,
      output: completed.ok ? completed.output : { text: String(completed.cause ?? "Unknown error") },
      isError: !completed.ok,
      durationMs: Date.now() - startedAt
    };

    yield { type: "tool-end", sessionId, batchId, result, timestamp: nowIso() };
    return result;
  }

  private toBatchCall(call: ToolCallBlock, tools: AgentTool[]): ToolBatchCall {
    const tool = tools.find((t) => t.name === call.toolName);
    return {
      id: call.id,
      toolName: call.toolName,
      input: call.input,
      summary: tool ? this.summarizeToolCall(tool, call.input) : call.toolName,
      category: tool?.category ?? "internal",
      concurrency: tool?.concurrency ?? "exclusive"
    };
  }

  private summarizeToolCall(tool: AgentTool, input: JsonObject): string {
    try {
      const summary = tool.summarize(input);
      return summary.trim() || tool.name;
    } catch {
      return `${tool.name} (invalid input)`;
    }
  }

  private summarizeBatch(calls: ToolBatchCall[]): string {
    if (calls.length === 1) {
      return calls[0]!.summary;
    }
    const counts = new Map<string, number>();
    for (const call of calls) {
      counts.set(call.category, (counts.get(call.category) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([category, count]) => `${count} ${category}`)
      .join(", ");
  }
}

// ─── 串行污染预检 ─────────────────────────────────────────

/**
 * 检查批次中是否有任何工具不允许并行执行。
 *
 * 串行污染策略：如果批处理中有任意一个工具设置了 allowParallel === false，
 * 整个批次串行执行。这是因为：
 * - 串行工具通常有副作用依赖（如写文件后读文件）
 * - 要求所有工具声明并行安全是合理的防御
 * - 不需要 Claude Code 的完整五件套
 */
function shouldExecuteSequential(
  toolCalls: ToolCallBlock[],
  tools: AgentTool[]
): boolean {
  for (const call of toolCalls) {
    const tool = tools.find((t) => t.name === call.toolName);
    if (tool?.allowParallel === false) {
      return true;
    }
  }
  return false;
}