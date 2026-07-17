import { describe, it, expect } from "vitest";
import { deepEqual, shallowEqual } from "./deep-equal";

describe("deepEqual", () => {
  it("handles primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("handles NaN via === fallback", () => {
    expect(deepEqual(NaN, NaN)).toBe(false); // NaN !== NaN
  });

  it("compares arrays deeply", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("compares objects deeply regardless of key order", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  it("detects missing keys", () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("handles nested arrays in objects", () => {
    expect(deepEqual({ list: [1, 2, { x: "y" }] }, { list: [1, 2, { x: "y" }] })).toBe(true);
  });
});

describe("shallowEqual", () => {
  it("compares one level deep", () => {
    const a = { x: 1, y: 2 };
    const b = { x: 1, y: 2 };
    expect(shallowEqual(a, b)).toBe(true);
    expect(shallowEqual(a, { x: 1, y: 3 })).toBe(false);
  });

  it("does NOT deeply compare nested objects", () => {
    const nested1 = { z: 1 };
    const nested2 = { z: 1 };
    expect(shallowEqual({ a: nested1 }, { a: nested2 })).toBe(false); // 引用不同
    expect(shallowEqual({ a: nested1 }, { a: nested1 })).toBe(true); // 同引用
  });

  it("compares arrays shallowly", () => {
    expect(shallowEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(shallowEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});
