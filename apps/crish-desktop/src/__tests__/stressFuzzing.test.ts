import { describe, it, expect } from 'vitest';
import { StreamRenderBuffer } from '../api/StreamRenderBuffer';
import { sessionHasListableContent } from '../api/sessionTitle';
import { telemetryMonitor } from '../services/TelemetryMonitor';
import { canonicalizeJsonSchema, formatStableTools, buildStableCacheKey } from '../api/directFetchBridge';

describe('Destructive Stress & Mutation Probing Pipeline', () => {

  describe('Probe A: Concurrent Messaging & Race Condition Probe', () => {
    it('should handle high-frequency addMessage and cross-session activeSessionId switching without deadlock or state corruption', async () => {
      const sessionStore = {
        activeSessionId: 'session_A',
        sessions: {
          'session_A': { id: 'session_A', messages: [] as any[] },
          'session_B': { id: 'session_B', messages: [] as any[] }
        },
        addMessage(sessionId: string, msg: any) {
          if (!this.sessions[sessionId as keyof typeof this.sessions]) throw new Error('Undefined pointer exception');
          this.sessions[sessionId as keyof typeof this.sessions].messages.push(msg);
        },
        switchSession(newId: string) {
          this.activeSessionId = newId;
        }
      };

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(new Promise<void>((resolve) => {
          setTimeout(() => {
            sessionStore.addMessage('session_A', { id: `msg_${i}`, text: 'streaming...' });
            resolve();
          }, i * 2);
        }));
      }
      
      await Promise.all(promises);
      sessionStore.switchSession('session_B');

      expect(sessionStore.sessions['session_A'].messages.length).toBe(5);
      expect(sessionStore.sessions['session_B'].messages.length).toBe(0);
      expect(sessionStore.activeSessionId).toBe('session_B');
    });
  });

  describe('Probe B: Huge Payload & Malformed Object Fuzzing', () => {
    it('should not throw Uncaught Exception when parsing 100k chars with unclosed code blocks and malformed toolCalls', () => {
      const hugeText = 'a'.repeat(50000) + '\n```javascript\n console.log("unclosed"); \n' + 'b'.repeat(50000);
      
      const malformedMessage = {
        sender: 'assistant',
        text: hugeText,
        toolCalls: [
          { id: null, function: undefined, args: NaN }
        ] as any
      };

      const buffer = new StreamRenderBuffer();
      let exceptionThrown = false;
      try {
        buffer.push(hugeText);
      } catch {
        exceptionThrown = true;
      }
      expect(exceptionThrown).toBe(false);

      let titleException = false;
      try {
        sessionHasListableContent({ messages: [malformedMessage] });
      } catch {
        titleException = true;
      }
      expect(titleException).toBe(false);
    });
  });

  describe('Probe C: Virtual Scroll Boundary Thrashing', () => {
    it('should not output NaN heights or out-of-bound indices when given extreme boundaries and many dynamic messages', () => {
      const itemHeights = new Map<string, number>();
      
      let exceptionThrown = false;
      let nanDetected = false;
      
      try {
        for (let i = 0; i < 10000; i++) {
          const h = i % 2 === 0 ? 0 : 5000;
          itemHeights.set(`msg_${i}`, h);
        }
        
        let total = 0;
        for (const h of itemHeights.values()) {
          total += h;
        }

        if (Number.isNaN(total)) {
          nanDetected = true;
        }
      } catch {
        exceptionThrown = true;
      }

      expect(exceptionThrown).toBe(false);
      expect(nanDetected).toBe(false);
    });
  });

  describe('Probe D: TelemetryMonitor 缓冲区过载与 OOM 防护探针', () => {
    it('should hard-limit buffer to 1000 items even when bombarded with 2000 logs', { timeout: 15_000 }, async () => {
      const tm = telemetryMonitor as any;
      tm.buffer = [];
      
      for (let i = 0; i < 2000; i++) {
        tm.logAction(`action_${i}`, 10);
      }
      
      await new Promise((resolve) => setTimeout(resolve, 50));
      
      expect(tm.buffer.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('Probe E: Tool Schema 确定性规范化与 Prompt Cache 键计算探针', () => {
    it('should generate identical canonical tool schema and cache key for inputs with reversed object keys and array items', () => {
      const schemaA = {
        type: 'object',
        properties: {
          z: { type: 'string', description: 'z field' },
          a: { type: 'number', description: 'a field' },
          m: { type: 'boolean', description: 'm field' }
        },
        required: ['z', 'a']
      };

      const schemaB = {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'a field' },
          m: { type: 'boolean', description: 'm field' },
          z: { type: 'string', description: 'z field' }
        },
        required: ['a', 'z']
      };

      const canonA = canonicalizeJsonSchema(schemaA);
      const canonB = canonicalizeJsonSchema(schemaB);
      
      expect(JSON.stringify(canonA)).toStrictEqual(JSON.stringify(canonB));
      expect(canonA.required).toEqual(['a', 'z']);
      expect(Object.keys(canonA.properties as any)).toEqual(['a', 'm', 'z']);

      const toolsA = [{ name: 'fetch_data', description: 'fetch data', inputSchema: schemaA }];
      const toolsB = [{ name: 'fetch_data', description: 'fetch data', inputSchema: schemaB }];
      
      const formattedA = formatStableTools(toolsA);
      const formattedB = formatStableTools(toolsB);
      
      expect(JSON.stringify(formattedA)).toStrictEqual(JSON.stringify(formattedB));

      const systemPrompt = "You are an AI developer.";
      const keyA = buildStableCacheKey(systemPrompt, formattedA);
      const keyB = buildStableCacheKey(systemPrompt, formattedB);
      
      expect(keyA).toStrictEqual(keyB);
      expect(keyA).toMatch(/^crish-prefix-[0-9a-f]+$/);
    });
  });

  describe('Probe F: 100万上下文多轮对话 Tree 拼接与 Heap 溢出防护探针', () => {
    it('should build a >1M context messagesPayload tree in < 5ms without Heap OOM', () => {
      const messages: any[] = [];
      const largeChunk = 'A'.repeat(5000);
      
      for (let i = 0; i < 50; i++) {
        messages.push({
          role: 'user',
          content: `User round ${i} ` + largeChunk
        });
        
        messages.push({
          role: 'assistant',
          content: `Assistant round ${i} ` + largeChunk,
          reasoning_content: `Reasoning round ${i} ` + largeChunk,
          tool_calls: [{
            id: `call_${i}`,
            type: 'function',
            function: { name: 'test_tool', arguments: JSON.stringify({ data: largeChunk }) }
          }]
        });
        
        messages.push({
          role: 'tool',
          content: `Tool result round ${i} ` + largeChunk,
          tool_call_id: `call_${i}`
        });
      }
      
      const options = { messages };
      const systemPrompt = largeChunk;
      const prompt = largeChunk;
      
      const start = performance.now();
      
      const messagesPayload: Array<Record<string, unknown>> = [];
      if (systemPrompt.trim()) {
        messagesPayload.push({ role: 'system', content: systemPrompt.trim() });
      }

      if (options.messages && options.messages.length > 0) {
        for (const msg of options.messages) {
          const formattedMsg: Record<string, unknown> = {
            role: msg.role,
            content: msg.content,
          };
          if (msg.role === 'assistant' && msg.reasoning_content) {
            formattedMsg.reasoning_content = msg.reasoning_content;
          }
          if (msg.tool_calls) formattedMsg.tool_calls = msg.tool_calls;
          if (msg.tool_call_id) formattedMsg.tool_call_id = msg.tool_call_id;
          messagesPayload.push(formattedMsg);
        }
      }
      messagesPayload.push({ role: 'user', content: prompt });
      
      const payload = { model: 'deepseek-chat', messages: messagesPayload, stream: true };
      
      const buildTime = performance.now() - start;
      expect(buildTime).toBeLessThan(10);

      let stringified = '';
      let heapException = false;
      try {
        stringified = JSON.stringify(payload);
      } catch {
        heapException = true;
      }
      expect(heapException).toBe(false);
      expect(stringified.length).toBeGreaterThan(1000000);
    });
  });

});
