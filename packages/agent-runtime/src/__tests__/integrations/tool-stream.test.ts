import { describe, expect, it } from "vitest";
import { ToolStream } from "../../tool-stream/tool-stream";

describe("ToolStream - large JSON accumulation", () => {
  it("accumulates a large valid JSON payload across many deltas", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, {
      id: "call_big",
      function: { name: "process", arguments: '{"data":[' },
    });

    const items: string[] = [];
    for (let i = 0; i < 100; i++) {
      items.push(JSON.stringify({ id: i, value: `item-${i}` }));
    }
    ts.appendOrStart(0, { function: { arguments: items.join(",") } });
    ts.appendOrStart(0, { function: { arguments: "]}" } });

    const result = ts.finish("0");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("process");
    expect(Array.isArray(result!.input.data)).toBe(true);
    expect(result!.input.data).toHaveLength(100);
    expect((result!.input as any).data[0]).toEqual({ id: 0, value: "item-0" });
    expect((result!.input as any).data[99]).toEqual({ id: 99, value: "item-99" });
  });

  it("handles deeply nested JSON with arrays and objects", () => {
    const ts = new ToolStream();
    ts.start("deep", "call_deep", "nested");
    ts.append("deep", '{"level1":{"level2":{"level3":{"level4":{"value":42');
    ts.append("deep", ',"arr":[1,2,{"nested":true}]}}}}}');
    const result = ts.finish("deep");
    expect(result!.input).toEqual({
      level1: { level2: { level3: { level4: { value: 42, arr: [1, 2, { nested: true }] } } } },
    });
  });

  it("handles large string values in JSON", () => {
    const ts = new ToolStream();
    const largeStr = "x".repeat(5000);
    ts.appendOrStart(0, {
      id: "call_str",
      function: { name: "echo", arguments: `{"text":"${largeStr}"}` },
    });
    const result = ts.finish("0");
    expect(result!.input.text).toBe(largeStr);
  });

  it("accumulates arguments up to maxArgumentsLength then stops", () => {
    const ts = new ToolStream();
    const bigChunk = "a".repeat(200 * 1024);
    ts.appendOrStart(0, { id: "c1", function: { name: "big", arguments: `{"x":"${bigChunk}"` } });
    const overflow = "a".repeat(100 * 1024);
    ts.appendOrStart(0, { function: { arguments: `,"y":"${overflow}"}` } });
    const result = ts.finish("0");
    expect(result!.raw.length).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("ToolStream - complex nested JSON repair", () => {
  it("repairs single missing closing brace at top level", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, {
      id: "c1",
      function: { name: "test", arguments: '{"a":1' },
    });
    const result = ts.finish("0");
    expect(result!.input).toEqual({ a: 1 });
  });

  it("repairs top-level array with missing closing bracket", () => {
    const ts = new ToolStream();
    ts.start("t1", "id1", "test");
    ts.append("t1", '[{"a":1},{"b":2}');
    const result = ts.finish("t1");
    expect(result!.input).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("repairs multiple trailing commas at various levels", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, {
      id: "c1",
      function: { name: "test", arguments: '{"a":1,"b":[1,2,],"c":{"x":1,},}' },
    });
    const result = ts.finish("0");
    expect(result!.input).toEqual({ a: 1, b: [1, 2], c: { x: 1 } });
  });

  it("repairs mixed trailing commas with single close", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, {
      id: "c1",
      function: { name: "test", arguments: '{"a":1,"b":[1,2,]}' },
    });
    const result = ts.finish("0");
    expect(result!.input).toEqual({ a: 1, b: [1, 2] });
  });

  it("returns empty object for severely truncated JSON", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { id: "c1", function: { name: "broken", arguments: '{"key":' } });
    const result = ts.finish("0");
    expect(result!.input).toEqual({});
  });

  it("handles empty string after trimming", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { id: "c1", function: { name: "empty", arguments: "   " } });
    const result = ts.finish("0");
    expect(result!.input).toEqual({});
  });
});

describe("ToolStream - cross-vendor format compatibility", () => {
  it("handles OpenAI-style function call deltas", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { function: { name: "read_file", arguments: '{"path":"/etc/hosts"}' } });
    const r = ts.finish("0");
    expect(r!.name).toBe("read_file");
    expect(r!.input).toEqual({ path: "/etc/hosts" });
  });

  it("handles OpenAI-style with id override in later delta", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { function: { name: "search" } });
    ts.appendOrStart(0, { id: "call_abc123", function: { arguments: '{"q":"hello"}' } });
    const r = ts.finish("0");
    expect(r!.id).toBe("call_abc123");
    expect(r!.name).toBe("search");
  });

  it("handles Anthropic-style start/append/finish with content blocks", () => {
    const ts = new ToolStream();
    ts.start("toolu_abc", "toolu_abc", "bash");
    ts.append("toolu_abc", '{"command"');
    ts.append("toolu_abc", ':"ls -la"}');
    const r = ts.finish("toolu_abc");
    expect(r!.name).toBe("bash");
    expect(r!.input).toEqual({ command: "ls -la" });
  });

  it("handles Anthropic-style with multiple content blocks", () => {
    const ts = new ToolStream();
    ts.start("block_0", "toolu_aaa", "read");
    ts.append("block_0", '{"file_path":"/a.txt"}');
    ts.start("block_1", "toolu_bbb", "write");
    ts.append("block_1", '{"file_path":"/b.txt","content":"hello"}');
    ts.start("block_2", "toolu_ccc", "search");
    ts.append("block_2", '{"pattern":"foo"}');

    const results = ts.finishAll();
    expect(results).toHaveLength(3);
    expect(results[0]!.name).toBe("read");
    expect(results[1]!.name).toBe("write");
    expect(results[2]!.name).toBe("search");
  });

  it("handles Gemini-style (index-based, no id)", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { function: { name: "get_weather" } });
    ts.appendOrStart(0, { function: { arguments: '{"city":"Tokyo"}' } });
    ts.appendOrStart(1, { function: { name: "get_time" } });
    ts.appendOrStart(1, { function: { arguments: '{"timezone":"UTC"}' } });

    const results = ts.finishAll();
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("call_0");
    expect(results[0]!.name).toBe("get_weather");
    expect(results[0]!.input).toEqual({ city: "Tokyo" });
    expect(results[1]!.name).toBe("get_time");
    expect(results[1]!.input).toEqual({ timezone: "UTC" });
  });

  it("handles mixed vendor patterns in the same stream", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { id: "openai_call", function: { name: "search", arguments: '{"q":"hello"}' } });
    ts.start("ant_block", "anthropic_tool", "bash");
    ts.append("ant_block", '{"cmd":"ls"}');
    ts.appendOrStart(1, { function: { name: "calculate", arguments: '{"expr":"2+2"}' } });

    const r1 = ts.finish("0");
    expect(r1!.id).toBe("openai_call");
    expect(r1!.input).toEqual({ q: "hello" });

    const r2 = ts.finish("ant_block");
    expect(r2!.id).toBe("anthropic_tool");
    expect(r2!.input).toEqual({ cmd: "ls" });

    const r3 = ts.finish("1");
    expect(r3!.id).toBe("call_1");
    expect(r3!.input).toEqual({ expr: "2+2" });
  });
});
