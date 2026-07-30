import { describe, expect, it } from "vitest";
import { ToolStream } from "./tool-stream";

describe("ToolStream - OpenAI Chat style (appendOrStart)", () => {
  it("accumulates arguments across multiple deltas", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { id: "call_1", function: { name: "read_file", arguments: '{"path"' } });
    ts.appendOrStart(0, { function: { arguments: ':"/etc/hosts"}' } });
    const result = ts.finish("0");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("call_1");
    expect(result!.name).toBe("read_file");
    expect(result!.input).toEqual({ path: "/etc/hosts" });
  });

  it("auto-creates entry on first delta without id", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { function: { name: "search", arguments: '{"q":"hi"}' } });
    const result = ts.finish("0");
    expect(result!.id).toBe("call_0");
    expect(result!.name).toBe("search");
    expect(result!.input).toEqual({ q: "hi" });
  });

  it("ignores appendOrStart when maxToolCalls is reached", () => {
    const ts = new ToolStream();
    for (let i = 0; i < 128; i++) {
      ts.appendOrStart(i, { id: `call_${i}`, function: { name: "noop", arguments: "{}" } });
    }
    expect(ts.size).toBe(128);
    ts.appendOrStart(200, { id: "overflow", function: { name: "noop", arguments: "{}" } });
    expect(ts.size).toBe(128);
  });

  it("respects maxArgumentsLength limit", () => {
    const ts = new ToolStream();
    const bigArg = "x".repeat(256 * 1024 + 1);
    ts.appendOrStart(0, { id: "big", function: { name: "test", arguments: bigArg } });
    const result = ts.finish("0");
    expect(result).not.toBeNull();
    expect(result!.raw).toBe("");
  });
});

describe("ToolStream - Anthropic style (start/append/finish)", () => {
  it("accumulates text across multiple appends", () => {
    const ts = new ToolStream();
    ts.start("block_1", "toolu_abc", "read");
    ts.append("block_1", '{"file":');
    ts.append("block_1", '"/etc/hosts"');
    ts.append("block_1", "}");
    const result = ts.finish("block_1");
    expect(result!.id).toBe("toolu_abc");
    expect(result!.name).toBe("read");
    expect(result!.input).toEqual({ file: "/etc/hosts" });
  });

  it("returns null for unknown key", () => {
    const ts = new ToolStream();
    expect(ts.finish("nonexistent")).toBeNull();
  });

  it("does not start beyond maxToolCalls", () => {
    const ts = new ToolStream();
    for (let i = 0; i < 128; i++) {
      ts.start(`k_${i}`, `id_${i}`, "noop");
    }
    expect(ts.size).toBe(128);
    ts.start("overflow", "id_overflow", "noop");
    expect(ts.size).toBe(128);
  });

  it("does not crash when appending to unknown key", () => {
    const ts = new ToolStream();
    ts.append("ghost", "some data");
    expect(ts.size).toBe(0);
  });

  it("finishAll returns all pending tools", () => {
    const ts = new ToolStream();
    ts.start("a", "id_a", "toolA");
    ts.append("a", '{"x":1}');
    ts.start("b", "id_b", "toolB");
    ts.append("b", '{"y":2}');
    const results = ts.finishAll();
    expect(results).toHaveLength(2);
    expect(results[0]!.input).toEqual({ x: 1 });
    expect(results[1]!.input).toEqual({ y: 2 });
    expect(ts.size).toBe(0);
  });
});

describe("ToolStream - JSON repair", () => {
  it("repairs trailing comma before closing brace", () => {
    const ts = new ToolStream();
    ts.start("t1", "id1", "test");
    ts.append("t1", '{"a":1,"b":2,}');
    const result = ts.finish("t1");
    expect(result!.input).toEqual({ a: 1, b: 2 });
  });

  it("repairs trailing comma before closing bracket", () => {
    const ts = new ToolStream();
    ts.start("t1", "id1", "test");
    ts.append("t1", '{"a":[1,2,]}');
    const result = ts.finish("t1");
    expect(result!.input).toEqual({ a: [1, 2] });
  });

  it("closes unclosed brace", () => {
    const ts = new ToolStream();
    ts.start("t1", "id1", "test");
    ts.append("t1", '{"a":1');
    const result = ts.finish("t1");
    expect(result!.input).toEqual({ a: 1 });
  });

  it("closes unclosed top-level bracket", () => {
    const ts = new ToolStream();
    ts.start("t1", "id1", "test");
    ts.append("t1", '{"a":[1,2]');
    const result = ts.finish("t1");
    expect(result!.input).toEqual({ a: [1, 2] });
  });

  it("returns empty object for completely broken JSON", () => {
    const ts = new ToolStream();
    ts.start("t1", "id1", "test");
    ts.append("t1", "not-json-at-all");
    const result = ts.finish("t1");
    expect(result!.input).toEqual({});
    expect(result!.raw).toBe("not-json-at-all");
  });
});

describe("ToolStream - empty parameters", () => {
  it("handles empty string arguments", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { id: "c1", function: { name: "noop", arguments: "" } });
    const result = ts.finish("0");
    expect(result!.input).toEqual({});
    expect(result!.raw).toBe("");
  });

  it("handles no arguments delta at all", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { id: "c1", function: { name: "noop" } });
    const result = ts.finish("0");
    expect(result!.input).toEqual({});
  });

  it("handles empty object arguments", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { id: "c1", function: { name: "noop", arguments: "{}" } });
    const result = ts.finish("0");
    expect(result!.input).toEqual({});
  });
});

describe("ToolStream - reset", () => {
  it("clears all pending tools", () => {
    const ts = new ToolStream();
    ts.appendOrStart(0, { id: "c1", function: { name: "test", arguments: "{}" } });
    ts.appendOrStart(1, { id: "c2", function: { name: "test", arguments: "{}" } });
    expect(ts.size).toBe(2);
    ts.reset();
    expect(ts.size).toBe(0);
    expect(ts.finish("0")).toBeNull();
  });
});

describe("ToolStream - finishAll", () => {
  it("returns empty array when no tools pending", () => {
    const ts = new ToolStream();
    expect(ts.finishAll()).toEqual([]);
  });
});
