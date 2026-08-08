import { describe, it, expect } from "vitest";
import { BoundedMap, LruMap } from "./bounded-map";

describe("BoundedMap", () => {
  it("evicts oldest when capacity exceeded", () => {
    const m = new BoundedMap<string, number>(2, undefined);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    expect(m.size).toBe(2);
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("updating existing key does not change insertion order", () => {
    const m = new BoundedMap<string, number>(2, undefined);
    m.set("a", 1);
    m.set("b", 2);
    m.set("a", 100);
    m.set("c", 3);
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("delete removes from order tracking", () => {
    const m = new BoundedMap<string, number>(3, undefined);
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
    const m = new BoundedMap<string, number>(3, undefined);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    const seen: Array<[string, number]> = [];
    m.forEach((v, k) => { seen.push([k, v]); });
    expect(seen).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("clear empties the map", () => {
    const m = new BoundedMap<string, number>(2, undefined);
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
    m.get("a"); // a 鍙樻垚鏈€杩戜娇鐢?
    m.set("c", 3); // 搴旀窐姹?b锛堟渶涔呮湭浣跨敤锛?
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
    m.get("a"); // a 鏄渶杩?
    m.set("c", 3); // 娣樻卑 b
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(1);
  });

  it("setting existing key refreshes recency", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("a", 100); // a 变成最新
    m.set("c", 3); // 淘汰 b
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(100);
  });

  it("throws on fractional capacity in (0,1)（F8-20：BoundedMap 静默取整为 0 → 容量语义失效）", () => {
    // 修复前 0.5 通过校验并 Math.floor 为 0：容量 0 的 BoundedMap
    // 首条 set 无淘汰直接存入（map.size>=0 恒真但无 key 可淘汰），
    // 容量上限形同虚设——静默退化，此断言红
    expect(() => new BoundedMap<number, number>(0.5, undefined)).toThrow(RangeError);
  });

  it("throws on fractional capacity in (0,1)（F8-20：LruMap 静默取整为 0）", () => {
    expect(() => new LruMap<number, number>(0.5)).toThrow(RangeError);
  });
});


