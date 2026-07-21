/**
 * @deprecated DEPRECATED — 勿用于生产。
 *
 * 本文件是旁路注册表式工厂，定义了一套**宽接口** `AgentProvider`
 *（`name` / `stream(messages, options)` / `complete` / `embed` / `health`），
 * 与正式运行时契约 **不一致**：
 *
 *   packages/agent-runtime/src/types.ts → AgentProvider
 *     readonly id: string
 *     stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent>
 *
 * 生产主链请走：
 *   - `provider-gateway.ts`（ProviderFactoryPlan + materialize）
 *   - `provider-openai-compatible.ts`（当前唯一真实现）
 *
 * 原生 family（anthropic / gemini）未接线前，引擎仅 OpenAI-compatible。
 * 真实契约见 `types.AgentProvider`；勿在此宽接口上「补全 stub」冒充已支持。
 */

/** @deprecated 宽接口；真实契约见 types.AgentProvider */
export interface AgentProvider {
  readonly name: string;
  stream(messages: unknown[], options: unknown): AsyncIterable<unknown>;
  complete(messages: unknown[], options: unknown): Promise<unknown>;
  embed(inputs: string[]): Promise<number[][]>;
  health(): Promise<{ ok: boolean; latency: number }>;
  getCacheStats(): {
    reads: number;
    writes: number;
    hits: number;
    hitRate: number;
  };
}

/** @deprecated 旁路工厂；勿用于 daemon / session loop */
export class ProviderFactory {
  private providers = new Map<
    string,
    new (config: Record<string, unknown>) => AgentProvider
  >();

  register(
    kind: string,
    provider: new (config: Record<string, unknown>) => AgentProvider
  ): void {
    this.providers.set(kind, provider);
  }

  create(kind: string, config: Record<string, unknown>): AgentProvider {
    const Provider = this.providers.get(kind);
    if (!Provider) throw new Error(`Unknown provider kind: ${kind}`);
    return new Provider(config);
  }
}

/** @deprecated 旁路单例；勿用于生产 */
export const providerFactory = new ProviderFactory();
