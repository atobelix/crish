import type { AgentProvider } from './provider-factory';

export class AnthropicProvider implements AgentProvider {
  readonly name = 'Anthropic';
  constructor(private config: any) {}

  async *stream(messages: any[], options: any): AsyncIterable<any> {
    // Implement Anthropic Messages API streaming
    // Use fetch() to POST to https://api.anthropic.com/v1/messages
    // Parse SSE stream
    // Handle cache_control breakpoints
    yield* [];
  }

  async complete(messages: any[], options: any): Promise<any> {
    // Non-streaming API call
    return {};
  }

  async embed(inputs: string[]): Promise<number[][]> {
    throw new Error('Embedding not supported by Anthropic');
  }

  async health(): Promise<{ ok: boolean; latency: number }> {
    const start = Date.now();
    try {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': this.config.apiKey ?? '' }
      });
      return { ok: res.ok, latency: Date.now() - start };
    } catch {
      return { ok: false, latency: Date.now() - start };
    }
  }

  getCacheStats() {
    return { reads: 0, writes: 0, hits: 0, hitRate: 0 };
  }
}
