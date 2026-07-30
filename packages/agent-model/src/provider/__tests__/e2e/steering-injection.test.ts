/**
 * @alpha Round 4 共存阶段 — 此 e2e 测试依赖 agent-core 模块（recovery-pipeline / provider-call-gateway / AgentRuntime / types），
        将在 Round 5（agent-core 创建）后重新启用。依据 ROUND-04-split-phase-B.md §8.3。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LlmApiMockServer, Scenarios } from './mock-server';
import { createTextMessage, InMemorySessionStore } from '@crish/agent-context';
// @ts-expect-error Round 4: agent-core 模块未创建，Round 5 重新启用
import { AgentRuntime } from '../../..';
import type { AgentEvent } from '@crish/shared-types';
import type { AgentProvider } from '../../types';

describe.skip('E2E: Steering injection during streaming tool calls', () => {
  // ── Smoke test: mock server scenario produces the right stream format ──
  describe('mock-server steeringInjectionScenario', () => {
    const server = new LlmApiMockServer();
    beforeAll(async () => {
      server.on('/v1/chat/completions', Scenarios.steeringInjectionScenario(0));
      await server.start(0);
    });
    afterAll(async () => {
      await server.stop();
    });

    it('streams text + tool-call + finish_reason + [DONE]', async () => {
      const response = await fetch(
        `${server.getBaseUrl()}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer test-key',
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'search' }],
            stream: true,
          }),
        }
      );
      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }

      expect(text).toContain('I will help you');
      expect(text).toContain('"tool_calls"');
      expect(text).toContain('search');
      expect(text).toContain('[DONE]');
    });
  });

  // ── Steering injection during tool execution ──
  it('does not interrupt current tool execution and picks up steering on next turn', async () => {
    let requestCount = 0;
    const provider: AgentProvider = {
      id: 'scripted-steer',
      async *stream() {
        requestCount++;
        if (requestCount === 1) {
          yield { type: 'text-delta', text: 'I will help you' };
          yield {
            type: 'tool-call',
            id: 'call_1',
            toolName: 'search',
            input: { q: 'hello' },
          };
          yield { type: 'stop', reason: 'tool-call' };
          return;
        }
        yield {
          type: 'text-delta',
          text: 'Adjusted plan based on your direction',
        };
        yield { type: 'stop', reason: 'stop' };
      },
    };

    // @ts-expect-error Round 4: agent-core 模块未创建，Round 5 重新启用
    const searchTool: import('../../../types').AgentTool = {
      name: 'search',
      label: 'Search',
      description: 'Search for information',
      category: 'filesystem',
      concurrency: 'parallel',
      isReadOnly: () => true,
      summarize: (input: any) => `search(${JSON.stringify(input)})`,
      async execute() {
        return { text: 'search result: hello world' };
      },
    };

    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: 's_steer_e2e',
      cwd: 'C:/repo',
      provider,
      tools: [searchTool],
      sessionStore: store,
      maxTurns: 4,
    });

    const events: AgentEvent[] = [];
    let steeringInjected = false;

    for await (const event of runtime.run('find information')) {
      events.push(event);

      if (
        (event.type === 'tool-start' || event.type === 'tool-batch-start') &&
        !steeringInjected
      ) {
        steeringInjected = true;
        runtime.enqueueSteerInput(
          createTextMessage('user', 'Actually, search for world instead')
        );
      }

      if (event.type === 'agent-end') break;
    }

    // Tool events should be present (tool execution completed, not interrupted)
    const toolStartEvents = events.filter(
      (e) => e.type === 'tool-start' || e.type === 'tool-batch-start'
    );
    const toolEndEvents = events.filter(
      (e) => e.type === 'tool-end' || e.type === 'tool-batch-end'
    );
    expect(toolStartEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolEndEvents.length).toBeGreaterThanOrEqual(1);

    // Steering message should be in the transcript (message-end for user role with steering text)
    const userMessages = events.filter(
      (e) => e.type === 'message-end' && e.message.role === 'user'
    );
    const steeringUserMsg = userMessages.find((e) =>
      (e as any).message?.blocks?.some(
        (b: any) => b.type === 'text' && b.text?.includes('search for world')
      )
    );
    expect(steeringUserMsg).toBeDefined();

    // Provider should have been called twice (first call + steering-injected second call)
    expect(requestCount).toBeGreaterThanOrEqual(2);
  });

  it('steers during tool-args-delta window without interrupting streaming', async () => {
    let requestCount = 0;
    const provider: AgentProvider = {
      id: 'scripted-steer-args',
      async *stream() {
        requestCount++;
        if (requestCount === 1) {
          yield { type: 'text-delta', text: 'Let me search' };
          yield {
            type: 'tool-call',
            id: 'call_1',
            toolName: 'search',
            input: { q: 'hello' },
          };
          yield { type: 'stop', reason: 'tool-call' };
          return;
        }
        yield { type: 'text-delta', text: 'Steering acknowledged, continuing' };
        yield { type: 'stop', reason: 'stop' };
      },
    };

    // @ts-expect-error Round 4: agent-core 模块未创建，Round 5 重新启用
    const searchTool: import('../../../types').AgentTool = {
      name: 'search',
      label: 'Search',
      description: 'Search',
      category: 'filesystem',
      concurrency: 'parallel',
      isReadOnly: () => true,
      summarize: (input: any) => `search(${JSON.stringify(input)})`,
      async execute() {
        return { text: 'result ok' };
      },
    };

    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: 's_steer_args',
      cwd: 'C:/repo',
      provider,
      tools: [searchTool],
      sessionStore: store,
      maxTurns: 4,
    });

    const events: AgentEvent[] = [];
    let steeringInjected = false;

    for await (const event of runtime.run('do search')) {
      events.push(event);

      if (
        (event.type === 'tool-start' || event.type === 'tool-batch-start') &&
        !steeringInjected
      ) {
        steeringInjected = true;
        runtime.enqueueSteerInput(
          createTextMessage('user', 'Change direction, search for world')
        );
      }

      if (event.type === 'agent-end') break;
    }

    // Tool completed
    const toolEnds = events.filter(
      (e) => e.type === 'tool-end' || e.type === 'tool-batch-end'
    );
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);

    // Steering message recorded
    const steeringFound = events.some(
      (e) =>
        e.type === 'message-end' &&
        (e as any).message?.role === 'user' &&
        (e as any).message?.blocks?.some(
          (b: any) => b.type === 'text' && b.text?.includes('Change direction')
        )
    );
    expect(steeringFound).toBe(true);

    // Second provider call happened
    expect(requestCount).toBeGreaterThanOrEqual(2);
  });
});
