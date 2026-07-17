import { describe, it, expect } from "vitest";
import { BoundedMap, LruMap } from "./bounded-map";

describe("BoundedMap", () => {
  it("evicts oldest when capacity exceeded", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3); // 应淘汰 a
    expect(m.size).toBe(2);
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("updating existing key does not change insertion order", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("a", 100); // 更新，不新增
    m.set("c", 3); // 淘汰最旧，应该是 a 被淘汰？不，a 在前面更新过
    // 更新值不改变插入顺序，所以最旧仍然是 a
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("delete removes from order tracking", () => {
    const m = new BoundedMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.delete("b");
    expect(m.size).toBe(2);
    m.set("d", 4);
    expect(m.size).toBe(3);
    expect(m.has("b")).toBe(false);
  });

  it("forEach iterates in insertion order", () => {
    const m = new BoundedMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    const seen: Array<[string, number]> = [];
    m.forEach((v, k) => seen.push([k, v]));
    expect(seen).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("clear empties the map", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.has("a")).toBe(false);
  });
});

describe("LruMap", () => {
  it("evicts least recently used when capacity exceeded", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.get("a"); // a 变成最近使用
    m.set("c", 3); // 应淘汰 b（最久未使用）
    expect(m.size).toBe(2);
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(1);
    expect(m.get("c")).toBe(3);
  });

  it("get refreshes recency", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.get("a");
    m.get("b");
    m.get("a"); // a 是最近
    m.set("c", 3); // 淘汰 b
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(1);
  });

  it("setting existing key refreshes recency", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("a", 100); // a 变成最近
    m.set("c", 3); // 淘汰 b
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(100);
  });
});
