export interface AgentProvider {
  readonly name: string;
  stream(messages: any[], options: any): AsyncIterable<any>;
  complete(messages: any[], options: any): Promise<any>;
  embed(inputs: string[]): Promise<number[][]>;
  health(): Promise<{ ok: boolean; latency: number }>;
  getCacheStats(): { reads: number; writes: number; hits: number; hitRate: number };
}

export class ProviderFactory {
  private providers = new Map<string, new (config: any) => AgentProvider>();

  register(kind: string, provider: new (config: any) => AgentProvider): void {
    this.providers.set(kind, provider);
  }

  create(kind: string, config: any): AgentProvider {
    const Provider = this.providers.get(kind);
    if (!Provider) throw new Error(`Unknown provider kind: ${kind}`);
    return new Provider(config);
  }
}

export const providerFactory = new ProviderFactory();
