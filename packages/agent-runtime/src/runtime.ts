import {
  type AgentEvent,
  type AgentMessage,
} from "@crish/shared-types";
import {
  type AgentRuntimeOptions,
  type AgentTool,
  type RuntimePermissionPolicy,
  type RuntimePermissionRequest,
  type SessionHeader,
} from "./types";
import { ConversationEngine, ProviderCallGateway, ContextManager } from "./runtime-components";
import { TokenTracker } from "./provider-transport/token-tracker";
import { PermissionEngine, HardlineBlockRule, DEFAULT_HARDLINE_REGISTRY } from "@crish/decision-engine";
import { buildSessionContextFromEntries, createId, findSessionLeafId, InMemorySessionStore, nowIso, SessionRecorder } from "./session";
import { AgentInputQueue } from "./agent-input-queue";
import { DEFAULT_MAX_TURNS, DEFAULT_TOOL_EXECUTION_TIMEOUT_MS } from "@crish/shared-types";
import { AgentSessionLoop } from "./agent-session-loop";
import { ToolRegistry } from "./tools/tool-definition";

export { DEFAULT_TOOL_EXECUTION_TIMEOUT_MS };

function createDefaultPermissionPolicy(): RuntimePermissionPolicy {
  const engine = new PermissionEngine([new HardlineBlockRule(DEFAULT_HARDLINE_REGISTRY)]);
  return {
    decide(request: RuntimePermissionRequest) {
      const converted: import("@crish/shared-types").PermissionRequest = {
        id: request.id,
        sessionId: request.sessionId,
        cwd: request.cwd,
        toolCallId: request.id,
        toolName: request.tool.name,
        parameters: request.input,
        summary: request.summary,
        toolMetadata: {
          category: request.tool.category,
          isReadOnly: request.tool.isReadOnly(request.input),
          fatalOnError: request.tool.fatalOnError,
          concurrency: request.tool.concurrency,
        },
        metadata: request.metadata,
      };
      return engine.decide(converted);
    },
  };
}

export class AgentRuntime {
  private readonly sessionId: string;
  private readonly abortController = new AbortController();
  private readonly permissionPolicy: RuntimePermissionPolicy;
  private readonly providerGateway: ProviderCallGateway;
  private readonly contextManager: ContextManager;
  private readonly tokenTracker: TokenTracker;

  /** 待处理的用户 steer 输入缓冲区（run() 调用前暂存） */
  private readonly pendingSteerInputs: AgentMessage[] = [];
  /** 当前活跃的输入队列（run() 创建后设置，用于外部 steer 转发） */
  private activeInputQueue: AgentInputQueue | null = null;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.sessionId = options.sessionId ?? createId("session");
    this.permissionPolicy = options.permissionPolicy ?? createDefaultPermissionPolicy();
    this.tokenTracker = options.tokenTracker ?? new TokenTracker();
    this.providerGateway = new ProviderCallGateway({
      connectionManager: options.connectionManager,
      tokenTracker: this.tokenTracker,
    });
    this.contextManager = new ContextManager({
      compression: options.contextCompression,
      toolOutputBudget: options.toolOutputBudget,
      cwd: options.cwd,
      sessionId: this.sessionId,
    });
  }

  abort(reason?: string): void {
    this.abortController.abort(reason);
  }

  /**
   * 获取 TokenTracker 实例（用于查询上下文压力、压缩阈值等）。
   */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  /**
   * 将用户 steer 输入加入待处理队列。
   *
   * 如果 AgentSessionLoop 已激活，直接转发到其统一输入队列；
   * 否则暂存到本地缓冲区，在 run() 调用时一并注入。
   */
  enqueueSteerInput(message: AgentMessage): void {
    if (this.activeInputQueue) {
      this.activeInputQueue.enqueue(message);
    } else {
      this.pendingSteerInputs.push(message);
    }
  }

  /**
   * 检查是否有待处理的用户 steer 输入。
   */
  hasPendingSteerInput(): boolean {
    if (this.activeInputQueue) return this.activeInputQueue.hasPending();
    return this.pendingSteerInputs.length > 0;
  }

  /**
   * 预览下一个待处理的 steer 输入（不移除）。
   */
  peekSteerInput(): AgentMessage | null {
    if (this.activeInputQueue) return this.activeInputQueue.peek();
    return this.pendingSteerInputs.length > 0 ? this.pendingSteerInputs[0]! : null;
  }

  /**
   * 取出并移除下一个待处理的 steer 输入。
   */
  dequeueSteerInput(): AgentMessage | undefined {
    if (this.activeInputQueue) return this.activeInputQueue.dequeue();
    return this.pendingSteerInputs.shift();
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

    // 将缓冲区中的 steer 输入转移到统一队列
    for (const msg of this.pendingSteerInputs) {
      inputQueue.enqueue(msg);
    }
    this.pendingSteerInputs.length = 0;

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
      this.permissionPolicy,
      this.options.extensionRegistry,
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
      registry.registerAgentTool(tool);
    }

    // 注册 toolSources 提供的工具
    const fromSources = await Promise.all((this.options.toolSources ?? []).map((source) => source.listTools()));
    for (const tool of fromSources.flat()) {
      registry.registerAgentTool(tool);
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
