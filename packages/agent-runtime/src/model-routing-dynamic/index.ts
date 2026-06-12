/**
 * Model Routing 动态权重 - 上下文感知路由 + 健康探测
 *
 * 解决的问题：
 * 1. 静态路由无法适应模型可用性变化
 * 2. 没有健康探测，失败后才知道模型不可用
 * 3. 路由决策不考虑上下文特征（如代码任务 vs 对话任务）
 * 4. 缺乏路由策略的可配置性
 *
 * 设计原则：
 * 1. 动态权重：基于健康状态、响应时间、成功率动态调整
 * 2. 上下文感知：根据任务特征选择最合适的模型
 * 3. 健康探测：定期检查模型可用性
 * 4. 优雅降级：首选模型不可用时自动回退
 */

// ─── 模型端点 ─────────────────────────────────────────────

export interface ModelEndpoint {
  id: string;
  modelId: string;
  provider: string;
  baseUrl: string;
  /** 模型能力标签 */
  capabilities: ModelCapability[];
  /** 最大上下文长度 */
  maxContextTokens: number;
  /** 最大输出 token 数 */
  maxOutputTokens: number;
  /** 是否启用 */
  enabled: boolean;
  /** 优先级（越高越优先） */
  priority: number;
}

export type ModelCapability =
  | "code-generation"
  | "code-analysis"
  | "conversation"
  | "reasoning"
  | "tool-use"
  | "streaming"
  | "vision";

// ─── 健康状态 ─────────────────────────────────────────────

export interface ModelEndpointHealthStatus {
  endpointId: string;
  healthy: boolean;
  /** 最近一次成功请求时间 */
  lastSuccessAt?: string;
  /** 最近一次失败时间 */
  lastFailureAt?: string;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 平均响应时间（ms） */
  averageResponseMs: number;
  /** 成功率（0-1） */
  successRate: number;
  /** 最后一次探测时间 */
  lastProbeAt?: string;
  /** 探测结果 */
  probeResult?: "ok" | "degraded" | "down";
}

// ─── 路由上下文 ───────────────────────────────────────────

export interface RoutingContext {
  /** 任务类型 */
  taskType?: ModelCapability;
  /** 估算的输入 token 数 */
  estimatedInputTokens: number;
  /** 估算的输出 token 数 */
  estimatedOutputTokens: number;
  /** 是否需要流式响应 */
  requiresStreaming: boolean;
  /** 是否需要工具使用 */
  requiresToolUse: boolean;
  /** 会话 ID */
  sessionId: string;
}

// ─── 路由结果 ─────────────────────────────────────────────

export interface RoutingResult {
  selectedEndpoint: ModelEndpoint;
  alternatives: ModelEndpoint[];
  routingReason: string;
  weight: number;
  healthStatus: ModelEndpointHealthStatus;
}

// ─── DynamicModelRouter ───────────────────────────────────

export class DynamicModelRouter {
  private endpoints = new Map<string, ModelEndpoint>();
  private healthStatus = new Map<string, ModelEndpointHealthStatus>();
  private responseTimeHistory = new Map<string, number[]>();
  private readonly maxHistoryLength = 20;

  constructor() {}

  /**
   * 注册模型端点
   */
  registerEndpoint(endpoint: ModelEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint);
    this.healthStatus.set(endpoint.id, {
      endpointId: endpoint.id,
      healthy: true,
      consecutiveFailures: 0,
      averageResponseMs: 0,
      successRate: 1.0
    });
  }

  /**
   * 移除模型端点
   */
  removeEndpoint(endpointId: string): void {
    this.endpoints.delete(endpointId);
    this.healthStatus.delete(endpointId);
    this.responseTimeHistory.delete(endpointId);
  }

  /**
   * 路由选择
   */
  route(context: RoutingContext): RoutingResult {
    const candidates = this.getEligibleEndpoints(context);

    if (candidates.length === 0) {
      throw new Error("No eligible model endpoints available");
    }

    // 计算动态权重
    const weighted = candidates.map((endpoint) => ({
      endpoint,
      weight: this.calculateWeight(endpoint, context)
    }));

    // 按权重排序
    weighted.sort((a, b) => b.weight - a.weight);

    const selected = weighted[0]!;
    const alternatives = weighted.slice(1).map((w) => w.endpoint);

    return {
      selectedEndpoint: selected.endpoint,
      alternatives,
      routingReason: this.explainRouting(selected.endpoint, context),
      weight: selected.weight,
      healthStatus: this.healthStatus.get(selected.endpoint.id)!
    };
  }

  /**
   * 记录请求成功
   */
  recordSuccess(endpointId: string, responseTimeMs: number): void {
    const health = this.healthStatus.get(endpointId);
    if (!health) return;

    health.healthy = true;
    health.lastSuccessAt = new Date().toISOString();
    health.consecutiveFailures = 0;
    health.successRate = this.updateSuccessRate(health.successRate, true);

    // 更新响应时间
    const history = this.responseTimeHistory.get(endpointId) ?? [];
    history.push(responseTimeMs);
    if (history.length > this.maxHistoryLength) history.shift();
    this.responseTimeHistory.set(endpointId, history);
    health.averageResponseMs = history.reduce((a, b) => a + b, 0) / history.length;
  }

  /**
   * 记录请求失败
   */
  recordFailure(endpointId: string): void {
    const health = this.healthStatus.get(endpointId);
    if (!health) return;

    health.lastFailureAt = new Date().toISOString();
    health.consecutiveFailures++;
    health.successRate = this.updateSuccessRate(health.successRate, false);

    // 连续失败超过阈值标记为不健康
    if (health.consecutiveFailures >= 3) {
      health.healthy = false;
      health.probeResult = "down";
    }
  }

  /**
   * 健康探测
   */
  async probe(endpointId: string): Promise<ModelEndpointHealthStatus> {
    const health = this.healthStatus.get(endpointId);
    if (!health) throw new Error(`Endpoint "${endpointId}" not found`);

    health.lastProbeAt = new Date().toISOString();

    // 简单的健康评估
    if (health.consecutiveFailures === 0) {
      health.probeResult = "ok";
      health.healthy = true;
    } else if (health.consecutiveFailures < 3) {
      health.probeResult = "degraded";
      health.healthy = true;
    } else {
      health.probeResult = "down";
      health.healthy = false;
    }

    return health;
  }

  /**
   * 获取所有端点的健康状态
   */
  getHealthStatuses(): ModelEndpointHealthStatus[] {
    return [...this.healthStatus.values()];
  }

  // ─── 内部方法 ────────────────────────────────────────────

  private getEligibleEndpoints(context: RoutingContext): ModelEndpoint[] {
    return [...this.endpoints.values()].filter((endpoint) => {
      if (!endpoint.enabled) return false;

      const health = this.healthStatus.get(endpoint.id);
      if (!health?.healthy) return false;

      // 检查上下文长度
      if (context.estimatedInputTokens + context.estimatedOutputTokens > endpoint.maxContextTokens) {
        return false;
      }

      // 检查能力需求
      if (context.requiresStreaming && !endpoint.capabilities.includes("streaming")) {
        return false;
      }
      if (context.requiresToolUse && !endpoint.capabilities.includes("tool-use")) {
        return false;
      }

      return true;
    });
  }

  private calculateWeight(endpoint: ModelEndpoint, context: RoutingContext): number {
    let weight = endpoint.priority * 10;

    const health = this.healthStatus.get(endpoint.id);
    if (health) {
      // 成功率权重
      weight *= health.successRate;

      // 响应时间权重（越快越高）
      if (health.averageResponseMs > 0) {
        const speedFactor = Math.max(0.1, 1 - health.averageResponseMs / 30000);
        weight *= speedFactor;
      }
    }

    // 上下文匹配权重
    if (context.taskType && endpoint.capabilities.includes(context.taskType)) {
      weight *= 1.5;
    }

    return weight;
  }

  private explainRouting(endpoint: ModelEndpoint, context: RoutingContext): string {
    const reasons: string[] = [];
    if (context.taskType && endpoint.capabilities.includes(context.taskType)) {
      reasons.push(`supports ${context.taskType}`);
    }
    const health = this.healthStatus.get(endpoint.id);
    if (health?.successRate === 1.0) {
      reasons.push("100% success rate");
    }
    if (endpoint.priority >= 80) {
      reasons.push("high priority");
    }
    return reasons.length > 0 ? reasons.join(", ") : "highest dynamic weight";
  }

  private updateSuccessRate(current: number, success: boolean): number {
    const alpha = 0.2; // EMA 平滑因子
    return alpha * (success ? 1 : 0) + (1 - alpha) * current;
  }
}
