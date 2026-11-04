import {
  StreamingToolCallAccumulator,
  repairTruncatedJson,
  parseToolArguments,
  appendOrUpdateStreamString,
} from './streamingToolCallAccumulator';

describe('StreamingToolCallAccumulator', () => {
  let accumulator: StreamingToolCallAccumulator;

  beforeEach(() => {
    accumulator = new StreamingToolCallAccumulator();
  });

  describe('1. 单字符 arguments 拼接', () => {
    it('正确将细碎至单字符的 arguments 逐步聚合并解析为完整 JSON 对象', () => {
      // 模拟标准 SSE 流中首包携带 id 和 name，随后逐字符推送 arguments
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_search_001',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '',
          },
        },
      ]);

      const jsonString = '{"query":"React Native 0.86"}';
      for (const char of jsonString) {
        accumulator.feedChunk([
          {
            index: 0,
            function: {
              arguments: char,
            },
          },
        ]);
      }

      expect(accumulator.hasCalls()).toBe(true);
      expect(accumulator.size()).toBe(1);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const firstCall = calls[0]!;
      expect(firstCall).toEqual({
        index: 0,
        id: 'call_search_001',
        name: 'web_search',
        argumentsString: '{"query":"React Native 0.86"}',
        arguments: '{"query":"React Native 0.86"}',
        isValidJson: true,
        parsedArguments: { query: 'React Native 0.86' },
        parsedArgs: { query: 'React Native 0.86' },
      });
    });

    it('支持 argumentsDelta 扁平字段单字符拼接', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_flat_1',
          name: 'get_time',
          argumentsDelta: '{',
        },
      ]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: '"' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: 'z' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: 'o' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: 'n' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: 'e' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: '"' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: ':' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: '"' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: 'U' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: 'T' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: 'C' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: '"' }]);
      accumulator.feedChunk([{ index: 0, argumentsDelta: '}' }]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const firstCall = calls[0]!;
      expect(firstCall.argumentsString).toBe('{"zone":"UTC"}');
      expect(firstCall.isValidJson).toBe(true);
      expect(firstCall.parsedArguments).toEqual({ zone: 'UTC' });
    });
  });

  describe('2. 并行多个 tool_calls（index 0 和 index 1 交替到达）', () => {
    it('正确聚合交错到达的多工具调用分片，并按 index 升序排列', () => {
      // Chunk 1: index 0 初始化
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_search',
          function: { name: 'web_search', arguments: '{"q":' },
        },
      ]);

      // Chunk 2: index 1 初始化（并行并发到达）
      accumulator.feedChunk([
        {
          index: 1,
          id: 'call_calc',
          function: { name: 'run_js_sandbox', arguments: '{"code":' },
        },
      ]);

      // Chunk 3: index 0 继续输出参数
      accumulator.feedChunk([
        {
          index: 0,
          function: { arguments: '"DeepSeek-V3' },
        },
      ]);

      // Chunk 4: index 1 继续输出参数
      accumulator.feedChunk([
        {
          index: 1,
          function: { arguments: '"Math.sqrt(' },
        },
      ]);

      // Chunk 5: index 0 闭合参数
      accumulator.feedChunk([
        {
          index: 0,
          function: { arguments: ' release"}' },
        },
      ]);

      // Chunk 6: index 1 闭合参数
      accumulator.feedChunk([
        {
          index: 1,
          function: { arguments: '144)"}' },
        },
      ]);

      expect(accumulator.size()).toBe(2);
      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(2);

      // index 0
      const call0 = calls[0]!;
      expect(call0.index).toBe(0);
      expect(call0.id).toBe('call_search');
      expect(call0.name).toBe('web_search');
      expect(call0.argumentsString).toBe('{"q":"DeepSeek-V3 release"}');
      expect(call0.isValidJson).toBe(true);
      expect(call0.parsedArguments).toEqual({ q: 'DeepSeek-V3 release' });

      // index 1
      const call1 = calls[1]!;
      expect(call1.index).toBe(1);
      expect(call1.id).toBe('call_calc');
      expect(call1.name).toBe('run_js_sandbox');
      expect(call1.argumentsString).toBe('{"code":"Math.sqrt(144)"}');
      expect(call1.isValidJson).toBe(true);
      expect(call1.parsedArguments).toEqual({ code: 'Math.sqrt(144)' });
    });

    it('即使 index 乱序到达，最终也稳定按 index 从小到大排序', () => {
      accumulator.feedChunk([
        {
          index: 2,
          id: 'call_third',
          function: { name: 'tool_c', arguments: '{"order": 3}' },
        },
      ]);
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_first',
          function: { name: 'tool_a', arguments: '{"order": 1}' },
        },
      ]);
      accumulator.feedChunk([
        {
          index: 1,
          id: 'call_second',
          function: { name: 'tool_b', arguments: '{"order": 2}' },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls.map((c) => c.index)).toEqual([0, 1, 2]);
      expect(calls.map((c) => c.name)).toEqual(['tool_a', 'tool_b', 'tool_c']);
    });
  });

  describe('3. 缺少 id 自动补齐', () => {
    it('当模型未返回 id 时，自动生成以 call_ 为前缀的非空唯一 ID', () => {
      accumulator.feedChunk([
        {
          index: 0,
          function: {
            name: 'web_search',
            arguments: '{"query":"Crish"}',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.id).toMatch(/^call_\d+_0_[a-z0-9]+$/);
      expect(call0.name).toBe('web_search');
      expect(call0.isValidJson).toBe(true);
    });

    it('多个缺少 id 的工具调用分别补齐不同且独立的唯一 ID', () => {
      accumulator.feedChunk([
        {
          index: 0,
          function: { name: 'tool_zero', arguments: '{}' },
        },
        {
          index: 1,
          function: { name: 'tool_one', arguments: '{}' },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(2);
      const call0 = calls[0]!;
      const call1 = calls[1]!;
      expect(call0.id).toBeTruthy();
      expect(call1.id).toBeTruthy();
      expect(call0.id).not.toBe(call1.id);
      expect(call0.id).toContain('_0_');
      expect(call1.id).toContain('_1_');
    });

    it('多次调用 getCompletedCalls 时生成的自动 ID 保持稳定幂等', () => {
      accumulator.feedChunk([
        {
          index: 0,
          function: { name: 'tool_stable', arguments: '{}' },
        },
      ]);

      const firstCall = accumulator.getCompletedCalls()[0]!;
      const secondCall = accumulator.getCompletedCalls()[0]!;
      expect(firstCall.id).toBe(secondCall.id);
    });
  });

  describe('4. JSON 截断容错修复', () => {
    it('修复在字符串值内部截断的情况（未闭合双引号和大括号）', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_trunc_1',
          function: {
            name: 'web_search',
            arguments: '{"query": "React Native expo rou',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.isValidJson).toBe(true);
      expect(call0.parsedArguments).toEqual({
        query: 'React Native expo rou',
      });
    });

    it('修复嵌套对象与多层大括号未闭合截断', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_trunc_nested',
          function: {
            name: 'fetch_api',
            arguments: '{"options": {"headers": {"Authorization": "Bearer tok',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.isValidJson).toBe(true);
      expect(call0.parsedArguments).toEqual({
        options: {
          headers: {
            Authorization: 'Bearer tok',
          },
        },
      });
    });

    it('修复数组内部截断（未闭合双引号、中括号和大括号）', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_trunc_arr',
          function: {
            name: 'batch_op',
            arguments: '{"ids": ["id-1", "id-2", "id-3',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.isValidJson).toBe(true);
      expect(call0.parsedArguments).toEqual({
        ids: ['id-1', 'id-2', 'id-3'],
      });
    });

    it('修复悬挂逗号结尾的截断情况', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_trunc_comma',
          function: {
            name: 'filter_data',
            arguments: '{"category": "tech", "limit": 10, ',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.isValidJson).toBe(true);
      expect(call0.parsedArguments).toEqual({
        category: 'tech',
        limit: 10,
      });
    });

    it('修复悬挂冒号结尾的截断情况（补齐 null）', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_trunc_colon',
          function: {
            name: 'search',
            arguments: '{"query": ',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.isValidJson).toBe(true);
      expect(call0.parsedArguments).toEqual({
        query: null,
      });
    });

    it('修复包含转义引号的截断情况', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_trunc_escape',
          function: {
            name: 'print_text',
            arguments: '{"text": "He said \\"Hello world',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.isValidJson).toBe(true);
      expect(call0.parsedArguments).toEqual({
        text: 'He said "Hello world',
      });
    });

    it('修复截断在转义斜杠上的极端情况', () => {
      const repaired = repairTruncatedJson('{"path": "C:\\\\foo\\\\');
      expect(JSON.parse(repaired)).toEqual({ path: 'C:\\foo\\' });
    });

    it('处理无参数空字符串函数调用', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_empty',
          function: {
            name: 'get_device_context',
            arguments: '   ',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.isValidJson).toBe(true);
      expect(call0.parsedArguments).toEqual({});
    });

    it('彻底无法修复的乱序垃圾文本标记 isValidJson = false 且 parsedArguments = undefined', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_bad',
          function: {
            name: 'bad_tool',
            arguments: '>>> totally not json <<<',
          },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.isValidJson).toBe(false);
      expect(call0.parsedArguments).toBeUndefined();
    });

    it('修复末尾未配对键的截断情况', () => {
      const repaired = repairTruncatedJson('{"a": 1, "unpaired"');
      expect(JSON.parse(repaired)).toEqual({ a: 1, unpaired: null });
    });
  });

  describe('5. 分片到达的 id 与 name 聚合及冗余防重', () => {
    it('分片到达的 id 与 name 正确拼接', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_',
          function: { name: 'web_' },
        },
      ]);
      accumulator.feedChunk([
        {
          index: 0,
          id: '9988_abc',
          function: { name: 'search' },
        },
      ]);
      accumulator.feedChunk([
        {
          index: 0,
          function: { arguments: '{"q":"hello"}' },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.id).toBe('call_9988_abc');
      expect(call0.name).toBe('web_search');
      expect(call0.parsedArguments).toEqual({ q: 'hello' });
    });

    it('部分网关冗余全量推送重复的 id 与 name 时不发生重复追加', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_unique_123',
          function: { name: 'run_js_sandbox', arguments: '{"a":' },
        },
      ]);
      // 第二包中网关重复发送了完整的 id 与 name
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_unique_123',
          function: { name: 'run_js_sandbox', arguments: '1}' },
        },
      ]);

      const calls = accumulator.getCompletedCalls();
      expect(calls).toHaveLength(1);
      const call0 = calls[0]!;
      expect(call0.id).toBe('call_unique_123');
      expect(call0.name).toBe('run_js_sandbox');
      expect(call0.argumentsString).toBe('{"a":1}');
      expect(call0.parsedArguments).toEqual({ a: 1 });
    });

    it('支持已预解析为对象形式的 arguments 摄入', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_preparsed',
          name: 'preset_tool',
          arguments: { preParsedKey: 'preParsedValue' },
        },
      ]);
      const calls = accumulator.getCompletedCalls();
      expect(calls[0]!.parsedArguments).toEqual({
        preParsedKey: 'preParsedValue',
      });
    });
  });

  describe('6. 状态重置与生命周期控制', () => {
    it('reset() 清空累积器状态，以便下一轮对话复用', () => {
      accumulator.feedChunk([
        {
          index: 0,
          id: 'call_1',
          function: { name: 'tool_1', arguments: '{}' },
        },
      ]);
      expect(accumulator.hasCalls()).toBe(true);
      expect(accumulator.size()).toBe(1);

      accumulator.reset();
      expect(accumulator.hasCalls()).toBe(false);
      expect(accumulator.size()).toBe(0);
      expect(accumulator.getCompletedCalls()).toEqual([]);
    });

    it('支持 pushDeltas 与 finalize 方案别名方法', () => {
      accumulator.pushDeltas([
        {
          index: 0,
          id: 'call_alias',
          name: 'tool_alias',
          argumentsDelta: '{"ok": true}',
        },
      ]);
      expect(accumulator.hasToolCalls()).toBe(true);

      const finalized = accumulator.finalize();
      expect(finalized).toHaveLength(1);
      const call0 = finalized[0]!;
      expect(call0.id).toBe('call_alias');
      expect(call0.name).toBe('tool_alias');
      expect(call0.parsedArgs).toEqual({ ok: true });
    });

    it('feedChunk 容错处理空数组、null、undefined 或非对象', () => {
      expect(() => {
        accumulator.feedChunk(null as any);
        accumulator.feedChunk(undefined as any);
        accumulator.feedChunk([]);
        accumulator.feedChunk([null, undefined, 'invalid'] as any);
      }).not.toThrow();
      expect(accumulator.size()).toBe(0);
    });
  });

  describe('7. 底层纯函数单测 (repairTruncatedJson, parseToolArguments & appendOrUpdateStreamString)', () => {
    it('parseToolArguments 解析标准 JSON、数组与原始标量', () => {
      const res1 = parseToolArguments('{"count": 42}');
      expect(res1.isValidJson).toBe(true);
      expect(res1.parsedArguments).toEqual({ count: 42 });

      const resEmpty = parseToolArguments('');
      expect(resEmpty.isValidJson).toBe(true);
      expect(resEmpty.parsedArguments).toEqual({});

      const resArray = parseToolArguments('["apple", "banana"]');
      expect(resArray.isValidJson).toBe(true);
      expect(resArray.parsedArguments).toEqual({
        items: ['apple', 'banana'],
      });

      const resPrimitive = parseToolArguments('12345');
      expect(resPrimitive.isValidJson).toBe(true);
      expect(resPrimitive.parsedArguments).toEqual({ value: 12345 });
    });

    it('repairTruncatedJson 剥离 Markdown code fence', () => {
      const input = '```json\n{"key": "value"}\n```';
      expect(repairTruncatedJson(input)).toBe('{"key": "value"}');
    });

    it('repairTruncatedJson 修复未完成的布尔值、数值与 null', () => {
      expect(repairTruncatedJson('{"flag": tr')).toBe('{"flag": true}');
      expect(repairTruncatedJson('{"flag": fa')).toBe('{"flag": false}');
      expect(repairTruncatedJson('{"count": 12.')).toBe('{"count": 12}');
      expect(repairTruncatedJson('{"item": nu')).toBe('{"item": null}');
    });

    it('appendOrUpdateStreamString 各种流式边界表现符合预期', () => {
      expect(appendOrUpdateStreamString('', 'test')).toBe('test');
      expect(appendOrUpdateStreamString('test', '')).toBe('test');
      expect(appendOrUpdateStreamString('abc', 'abc')).toBe('abc');
      expect(appendOrUpdateStreamString('ab', 'abc')).toBe('abc');
      expect(appendOrUpdateStreamString('abc', 'ab')).toBe('abc');
      expect(appendOrUpdateStreamString('call_', '123')).toBe('call_123');
    });
  });
});
