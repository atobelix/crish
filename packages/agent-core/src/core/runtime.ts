import {
  type AgentEvent,
  type AgentMessage,
} from "@crish/shared-types";
import { RingBuffer, STEER_INPUT_CAPACITY } from "@crish/shared-utils";
import type { AgentTool, RuntimePermissionPolicy } from '@crish/shared-types';
import type { AgentRuntimeOptions, SessionHeader } from './runtime-options';
import { ConversationEngine, ProviderCallGateway, ContextManager } from "../runtime-components";
import { TokenTracker } from "@crish/agent-model";
import { TokenLedger } from "@crish/agent-model";
import { PricingEngine } from "@crish/agent-model";
import { createTrustZonePermissionPolicy } from "@crish/agent-permissions";
import { buildSessionContextFromEntries, createId, findSessionLeafId, InMemorySessionStore, nowIso, SessionRecorder } from '@crish/agent-context';
import { AgentInputQueue } from "../agent-input-queue";
import { DEFAULT_MAX_TURNS, DEFAULT_TOOL_EXECUTION_TIMEOUT_MS } from "@crish/shared-types";
import { AgentSessionLoop } from "../agent-session-loop";
import { ToolRegistry } from '@crish/agent-tools';
import { ControlBus } from "../control";
import type { IAgentRuntime } from "./IAgentRuntime";

export type { IAgentRuntime };
export { DEFAULT_TOOL_EXECUTION_TIMEOUT_MS };

/** Default product policy: TrustZone "ask" (project-mode semantics). No default-allow bypass. */
function createDefaultPermissionPolicy(): RuntimePermissionPolicy {
  return createTrustZonePermissionPolicy("ask");
}

export class AgentRuntime implements IAgentRuntime {
  private readonly sessionId: string;
  private readonly abortController = new AbortController();
  private readonly permissionPolicy: RuntimePermissionPolicy;
  private readonly providerGateway: ProviderCallGateway;
  private readonly contextManager: ContextManager;
  private readonly tokenTracker: TokenTracker;
  /**
   * 跨 run() 生命周期的控制总线（L1/L2/L3）。
   * 注入到 AgentSessionLoop，供 daemon cancel-run mode=cooperative 对接。
   */
  private readonly controlBus = new ControlBus();

  /** 待处理的用户 steer（soft）输入缓冲区（run() 调用前暂存）。RingBuffer 提供 O(1) shift 与背压保护。 */
  private readonly pendingSteerInputs = new RingBuffer<AgentMessage>(STEER_INPUT_CAPACITY);
  /** 待处理的 force 输入（run() 前暂存；仅 enqueueForceInput 写入） */
  private readonly pendingForceInputs = new RingBuffer<AgentMessage>(STEER_INPUT_CAPACITY);
  /** 当前活跃的输入队列（run() 创建后设置，用于外部 steer/force 转发） */
  private activeInputQueue: AgentInputQueue | null = null;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.sessionId = options.sessionId ?? createId("session");
    this.permissionPolicy = options.permissionPolicy ?? createDefaultPermissionPolicy();
    this.tokenTracker = options.tokenTracker ?? new TokenTracker();
    this.providerGateway = new ProviderCallGateway({
      ...(options.connectionManager !== undefined ? { connectionManager: options.connectionManager } : {}),
      tokenTracker: this.tokenTracker,
    });
    this.contextManager = new ContextManager({
      ...(options.contextCompression !== undefined ? { compression: options.contextCompression } : {}),
      ...(options.toolOutputBudget !== undefined ? { toolOutputBudget: options.toolOutputBudget } : {}),
      cwd: options.cwd,
      sessionId: this.sessionId,
    });
  }

  abort(reason?: string): void {
    this.abortController.abort(reason);
  }

  /**
   * L2 协作停：入队 ControlBus，session-loop 在安全点干净收尾（不立刻 abort provider）。
   * @see packages/agent-runtime/src/control/control-bus.ts
   */
  requestCooperativeStop(reason?: string): void {
    this.controlBus.requestCooperativeStop(reason, "external");
  }

  /** 暴露控制总线（测试 / 高级对接） */
  getControlBus(): ControlBus {
    return this.controlBus;
  }

  /**
   * 获取 TokenTracker 实例（用于查询上下文压力、压缩负载等）。
   */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  /**
   * 将用户 steer 输入加入待处理队列（pi soft steer：安全点注入，不 mid-stream 打断）。
   *
   * 如果 AgentSessionLoop 已激活，直接转发到其统一输入队列的 **steer** 环；
   * 否则暂存到本地缓冲区，在 run() 调用时以 steer 模式注入。
   *
   * 需要 mid-stream 可打断时请用 {@link enqueueForceInput}；L3 硬停走 abort / ControlBus force_cancel。
   * @see docs/architecture/run-control.md
   */
  enqueueSteerInput(message: AgentMessage): void {
    if (this.activeInputQueue) {
      this.activeInputQueue.enqueueSteer(message);
    } else {
      this.pendingSteerInputs.pushOverwritingOldest(message);
    }
  }

  /**
   * 显式 force 入队：streaming 中途可打断（legacy mid-stream 行为）。
   * 公共 steer 路径不得走此通道；仅 force 语义或测试需要时使用。
   */
  enqueueForceInput(message: AgentMessage): void {
    if (this.activeInputQueue) {
      this.activeInputQueue.enqueueForce(message);
    } else {
      // 无活跃 loop：pre-run 缓冲；run() 启动时转入 force 环
      this.pendingForceInputs.pushOverwritingOldest(message);
    }
  }

  /**
   * 检查是否有待处理的用户 steer 输入。
   */
  hasPendingSteerInput(): boolean {
    if (this.activeInputQueue) return this.activeInputQueue.hasPending();
    return this.pendingSteerInputs.size > 0 || this.pendingForceInputs.size > 0;
  }

  /**
   * 预览下一个待处理的 steer 输入（不移除）。
   */
  peekSteerInput(): AgentMessage | null {
    if (this.activeInputQueue) return this.activeInputQueue.peek();
    // force 优先，与 AgentInputQueue.peek 一致
    return this.pendingForceInputs.peekFirst() ?? this.pendingSteerInputs.peekFirst() ?? null;
  }

  /**
   * 取出并移除下一个待处理的 steer 输入。
   */
  dequeueSteerInput(): AgentMessage | undefined {
    if (this.activeInputQueue) return this.activeInputQueue.dequeue();
    return this.pendingForceInputs.shift() ?? this.pendingSteerInputs.shift();
  }

  async *run(userInput: string | AgentMessage): AsyncGenerator<AgentEvent, AgentMessage[]> {
    // ─── 会话初始化 ─────────────────────────────────────────
    const sessionStore = this.options.sessionStore ?? new InMemorySessionStore();
    const header: SessionHeader = {
      type: "session",
      id: this.sessionId,
      cwd: this.options.cwd,
      createdAt: nowIso(),
      version: 1
    };
    await sessionStore.open(header);

    const resumedEntries = this.options.resumeSession && sessionStore.readAll ? await sessionStore.readAll() : [];
    const recorder = new SessionRecorder(sessionStore, findSessionLeafId(resumedEntries));
    const conversation = new ConversationEngine({
      sessionId: this.sessionId,
      maxTurns: this.options.maxTurns ?? DEFAULT_MAX_TURNS,
      modelId: this.options.provider.id,
      systemPrompt: this.options.systemPrompt ?? "",
      cwd: this.options.cwd,
    });

    // 注入历史消息（会话恢复 + 初始消息）
    const initialMessages: AgentMessage[] = [
      ...(this.options.resumeSession ? buildSessionContextFromEntries(resumedEntries) : []),
      ...(this.options.initialMessages ?? [])
    ];
    for (const msg of initialMessages) {
      conversation.appendMessage(msg);
    }

    const tools = await this.resolveTools();

    // ─── 创建统一输入队列 + 会话循环 ────────────────────────
    const inputQueue = new AgentInputQueue();
    this.activeInputQueue = inputQueue;

    // 将 pre-run 缓冲转入统一队列：force 环与 steer 环分轨（对齐 pi soft steer）
    this.pendingForceInputs.forEach((msg) => {
      inputQueue.enqueueForce(msg);
    });
    this.pendingForceInputs.clear();
    this.pendingSteerInputs.forEach((msg) => {
      inputQueue.enqueueSteer(msg);
    });
    this.pendingSteerInputs.clear();

    const ledger = new TokenLedger(new PricingEngine());
    const loop = new AgentSessionLoop(
      this.options,
      inputQueue,
      conversation,
      this.contextManager,
      this.providerGateway,
      tools,
      this.abortController,
      recorder,
      this.sessionId,
      this.tokenTracker,
      ledger,
      this.permissionPolicy,
      this.options.extensionRegistry,
      this.controlBus,
    );

    try {
      // ─── 委托给状态机驱动的核心循环 ──────────────────────────
      return yield* loop.run(userInput);
    } finally {
      this.activeInputQueue = null;
      // 释放会话存储的持久化句柄（如 JsonlSessionStore 缓存的文件句柄）
      if (sessionStore.close) {
        await sessionStore.close().catch(() => undefined);
      }
    }
  }

  private async resolveTools(): Promise<AgentTool[]> {
    const registry = new ToolRegistry();

    // 注册 options.tools 中的工具（向后兼容 AgentTool[]）
    for (const tool of this.options.tools ?? []) {
      registry.register(tool);
    }

    // 注册 toolSources 提供的工具
    const fromSources = await Promise.all((this.options.toolSources ?? []).map((source) => source.listTools()));
    for (const tool of fromSources.flat()) {
      registry.register(tool);
    }

    // 注册 extensionRegistry 提供的 ToolDefinition
    if (this.options.extensionRegistry) {
      for (const def of this.options.extensionRegistry.collectTools()) {
        registry.register(def);
      }
    }

    return registry.list();
  }
}
