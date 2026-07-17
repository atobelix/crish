import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer";

describe("RingBuffer", () => {
  it("pushes and shifts in FIFO order", () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.push(1)).toBe(true);
    expect(rb.push(2)).toBe(true);
    expect(rb.push(3)).toBe(true);
    expect(rb.push(4)).toBe(false); // 满
    expect(rb.size).toBe(3);
    expect(rb.shift()).toBe(1);
    expect(rb.shift()).toBe(2);
    expect(rb.shift()).toBe(3);
    expect(rb.shift()).toBe(undefined);
    expect(rb.isEmpty).toBe(true);
  });

  it("pushOverwritingOldest drops the oldest when full", () => {
    const rb = new RingBuffer<string>(2);
    rb.pushOverwritingOldest("a");
    rb.pushOverwritingOldest("b");
    rb.pushOverwritingOldest("c");
    expect(rb.toArray()).toEqual(["b", "c"]);
    expect(rb.peekFirst()).toBe("b");
    expect(rb.peekLast()).toBe("c");
  });

  it("forEach iterates in insertion order", () => {
    const rb = new RingBuffer<number>(5);
    for (let i = 1; i <= 5; i++) rb.push(i);
    const seen: number[] = [];
    rb.forEach((v) => {
      seen.push(v);
      if (v === 3) return false;
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("forEachReverse iterates from newest to oldest", () => {
    const rb = new RingBuffer<number>(5);
    for (let i = 1; i <= 5; i++) rb.push(i);
    const seen: number[] = [];
    rb.forEachReverse((v) => seen.push(v));
    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });

  it("findLast finds the newest matching element", () => {
    const rb = new RingBuffer<{ id: number; ok: boolean }>(5);
    rb.push({ id: 1, ok: false });
    rb.push({ id: 2, ok: true });
    rb.push({ id: 3, ok: true });
    const found = rb.findLast((v) => v.ok);
    expect(found?.id).toBe(3);
  });

  it("clear releases all entries", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.shift()).toBe(undefined);
  });

  it("fromArrayTail keeps only the last N elements", () => {
    const rb = new RingBuffer<number>(3);
    rb.fromArrayTail([1, 2, 3, 4, 5]);
    expect(rb.toArray()).toEqual([3, 4, 5]);
  });

  it("wraps around correctly across multiple cycles", () => {
    const rb = new RingBuffer<number>(2);
    rb.push(1);
    rb.push(2);
    rb.shift(); // remove 1
    rb.push(3); // wrap
    rb.shift(); // remove 2
    rb.push(4);
    expect(rb.toArray()).toEqual([3, 4]);
    expect(rb.size).toBe(2);
  });

  it("throws on non-positive capacity", () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
    expect(() => new RingBuffer(Infinity)).toThrow(RangeError);
  });
});
