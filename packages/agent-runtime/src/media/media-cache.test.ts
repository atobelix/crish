import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { MediaCache } from "./media-cache";
import type { NormalizedMedia } from "./media-types";

function imageContent(data: string = "base64data"): NormalizedMedia {
  return {
    type: "image",
    source: "base64",
    data,
    mimeType: "image/png",
    sizeBytes: 100,
  } as NormalizedMedia;
}

describe("MediaCache", () => {
  let cache: MediaCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new MediaCache(5);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves media by key", () => {
    const m = imageContent();
    cache.set("key1", m);
    expect(cache.get("key1")).toBe(m);
  });

  it("returns undefined for missing key", () => {
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("has returns true for existing keys", () => {
    cache.set("key1", imageContent());
    expect(cache.has("key1")).toBe(true);
  });

  it("has returns false for missing keys", () => {
    expect(cache.has("nonexistent")).toBe(false);
  });

  it("clear removes all entries", () => {
    cache.set("key1", imageContent());
    cache.set("key2", imageContent());
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("reports correct size", () => {
    expect(cache.size).toBe(0);
    cache.set("k1", imageContent());
    expect(cache.size).toBe(1);
    cache.set("k2", imageContent());
    expect(cache.size).toBe(2);
  });

  it("evicts the least recently used entry when at capacity", () => {
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1);
      cache.set(`key${i}`, imageContent(`data${i}`));
    }
    expect(cache.size).toBe(5);
    cache.set("key5", imageContent("data5"));
    expect(cache.size).toBe(5);
    expect(cache.get("key0")).toBeUndefined();
  });

  it("updates lastAccess on get, preventing eviction of recently used", () => {
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1);
      cache.set(`key${i}`, imageContent(`data${i}`));
    }
    vi.advanceTimersByTime(1);
    cache.get("key0");
    vi.advanceTimersByTime(1);
    cache.set("key5", imageContent("data5"));
    expect(cache.get("key0")).toBeDefined();
    expect(cache.get("key1")).toBeUndefined();
  });

  it("updates lastAccess on set for existing key", () => {
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1);
      cache.set(`key${i}`, imageContent(`data${i}`));
    }
    vi.advanceTimersByTime(1);
    cache.set("key0", imageContent("new0"));
    vi.advanceTimersByTime(1);
    cache.set("key5", imageContent("data5"));
    expect(cache.get("key0")).toBeDefined();
    expect(cache.get("key1")).toBeUndefined();
  });

  it("does not evict when under capacity", () => {
    for (let i = 0; i < 3; i++) {
      cache.set(`key${i}`, imageContent());
    }
    expect(cache.size).toBe(3);
    expect(cache.get("key0")).toBeDefined();
    expect(cache.get("key1")).toBeDefined();
    expect(cache.get("key2")).toBeDefined();
  });

  it("contentHash produces a deterministic sha256 hex string", async () => {
    const h1 = await cache.contentHash("hello");
    const h2 = await cache.contentHash("hello");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });

  it("contentHash handles Uint8Array input", async () => {
    const h = await cache.contentHash(new Uint8Array([104, 101, 108, 108, 111]));
    expect(h).toBe(await cache.contentHash("hello"));
  });

  it("cacheKey produces predictable keys", async () => {
    const k1 = await cache.cacheKey({ type: "image", source: "base64", data: "abc" });
    const k2 = await cache.cacheKey({ type: "image", source: "base64", data: "abc" });
    expect(k1).toBe(k2);
    expect(k1).toContain("image:base64:");
  });

  it("cacheKey uses url when data is absent", async () => {
    const k = await cache.cacheKey({ type: "image", source: "url", url: "https://example.com/img.png" });
    expect(k).toContain("image:url:");
  });

  it("cacheKey uses fileId when data and url are absent", async () => {
    const k = await cache.cacheKey({ type: "image", source: "file_id", fileId: "file123" });
    expect(k).toContain("image:file_id:");
  });

  it("cacheKey uses empty string when no content source is provided", async () => {
    const k = await cache.cacheKey({ type: "image", source: "base64" });
    expect(k).toContain("image:base64:");
  });

  it("uses default maxEntries of 100", () => {
    const c = new MediaCache();
    expect(c.size).toBe(0);
    for (let i = 0; i < 100; i++) {
      c.set(`k${i}`, imageContent());
    }
    expect(c.size).toBe(100);
    c.set("k101", imageContent());
    expect(c.size).toBe(100);
  });
});
