import { describe, test, expect } from 'vitest';
import { OpenAICompatibleProvider } from '@crish/agent-runtime';

describe('Real Live LLM Provider E2E Integration', () => {
  test('应向真实 OpenCode Zen 供应商 (https://opencode.ai/zen/go/v1) 发起真实 HTTP 流式请求并获得真实 Token', async () => {
    const apiKey = 'sk-4AtRgbObFKWBB0UZJfddwcxCjLWJ4UppExWePVKcB0F4EFtN4rDpde1FKgfCwdIb';
    const baseUrl = 'https://opencode.ai/zen/go/v1';
    const model = 'deepseek-v4-flash';

    const provider = new OpenAICompatibleProvider({
      id: 'opencode-go-live',
      name: 'OpenCode Go Real Provider',
      baseUrl,
      apiKey,
      model,
    });

    const stream = provider.stream({
      messages: [
        { role: 'system', blocks: [{ type: 'text', text: 'You are an AI assistant.' }] },
        { role: 'user', blocks: [{ type: 'text', text: 'Confirm real API connection by saying "Real DeepSeek Provider Operational!"' }] },
      ],
      tools: [],
    });

    let fullText = '';
    let receivedChunks = 0;

    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        fullText += chunk.text;
        receivedChunks++;
      } else if (chunk.type === 'thought-delta') {
        fullText += chunk.text;
        receivedChunks++;
      }
    }

    console.log(`\n🎉 真实 API 响应返回 (${receivedChunks} chunks):`, fullText);

    // 断言收到真实的非空字符串，零 Mock 造假！
    expect(fullText.length).toBeGreaterThan(0);
    expect(receivedChunks).toBeGreaterThan(0);
  }, 30000);
});
