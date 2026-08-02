import { describe, it, expect } from "vitest";
import { clone, stripNonSerializable } from "./object";

describe("clone", () => {
  it("deep copies plain objects via structuredClone", () => {
    const obj = { a: 1, b: { c: [2, 3] } };
    const copy = clone(obj);
    expect(copy).toEqual(obj);
    expect(copy).not.toBe(obj);
    expect(copy.b).not.toBe(obj.b);
  });

  it("falls back to JSON roundtrip when value contains functions", () => {
    const obj = { name: "test", fn: () => true, data: { x: 1 } };
    const copy = clone(obj);
    // Functions are stripped by JSON roundtrip
    expect(copy).toEqual({ name: "test", data: { x: 1 } });
  });

  it("falls back to JSON roundtrip for nested function properties", () => {
    const tool = {
      name: "bash",
      label: "bash",
      isReadOnly: () => true,
      summarize: (_input: unknown) => "run",
      execute: async () => ({ text: "ok" }),
      input: { command: "ls" },
    };
    const copy = clone(tool);
    expect(copy.name).toBe("bash");
    expect(copy.input).toEqual({ command: "ls" });
    // Functions should be stripped
    expect((copy as Record<string, unknown>).isReadOnly).toBeUndefined();
    expect((copy as Record<string, unknown>).summarize).toBeUndefined();
    expect((copy as Record<string, unknown>).execute).toBeUndefined();
  });
});

describe("stripNonSerializable", () => {
  it("passes through primitives", () => {
    expect(stripNonSerializable(42)).toBe(42);
    expect(stripNonSerializable("hello")).toBe("hello");
    expect(stripNonSerializable(true)).toBe(true);
    expect(stripNonSerializable(null)).toBe(null);
  });

  it("strips function properties from objects", () => {
    const obj = {
      name: "tool",
      isReadOnly: () => true,
      value: 42,
    };
    const result = stripNonSerializable(obj);
    expect(result).toEqual({ name: "tool", value: 42 });
  });

  it("strips functions from nested objects", () => {
    const obj = {
      request: {
        tool: {
          name: "bash",
          isReadOnly: () => false,
          summarize: () => "run",
          execute: async () => ({ text: "ok" }),
        },
        input: { cmd: "ls" },
      },
    };
    const result = stripNonSerializable(obj);
    expect(result).toEqual({
      request: {
        tool: { name: "bash" },
        input: { cmd: "ls" },
      },
    });
  });

  it("strips functions from arrays", () => {
    const arr = [1, () => "fn", 2, "hello"];
    const result = stripNonSerializable(arr);
    expect(result).toEqual([1, 2, "hello"]);
  });

  it("strips undefined values", () => {
    const obj = { a: 1, b: undefined, c: "hello" };
    const result = stripNonSerializable(obj);
    expect(result).toEqual({ a: 1, c: "hello" });
  });

  it("strips Symbol and BigInt values", () => {
    const obj = { a: 1, sym: Symbol("test"), big: BigInt(123), c: "hello" };
    const result = stripNonSerializable(obj as Record<string, unknown>);
    expect(result).toEqual({ a: 1, c: "hello" });
  });

  it("produces structuredClone-safe output", () => {
    const obj = {
      tool: { name: "test", fn: () => true },
      data: [1, () => 2, 3],
    };
    const stripped = stripNonSerializable(obj);
    // Should not throw
    expect(() => structuredClone(stripped)).not.toThrow();
    const cloned = structuredClone(stripped);
    expect(cloned).toEqual({ tool: { name: "test" }, data: [1, 3] });
  });
});
