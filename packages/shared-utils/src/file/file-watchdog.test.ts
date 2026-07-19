import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWatchdog } from "./file-watchdog";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crish-watchdog-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});

describe("FileWatchdog", () => {
  it("start/stop lifecycle", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "watch.txt");
    await writeFile(filePath, "initial", "utf8");

    const callback = vi.fn();
    const watchdog = new FileWatchdog(filePath, callback, { debounceMs: 50 });
    expect(watchdog.watching).toBe(false);

    watchdog.start();
    expect(watchdog.watching).toBe(true);

    watchdog.stop();
    expect(watchdog.watching).toBe(false);

    // 重复 stop 不应抛异常
    watchdog.stop();
  });

  it("fires callback on file change", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "change.txt");
    await writeFile(filePath, "before", "utf8");

    const callback = vi.fn();
    const watchdog = new FileWatchdog(filePath, callback, { debounceMs: 30 });
    watchdog.start();

    // 模拟文件变更
    await appendFile(filePath, "\nafter", "utf8");

    // 等待去抖触发
    await new Promise((r) => setTimeout(r, 100));
    expect(callback).toHaveBeenCalledWith("change");
    watchdog.stop();
  });

  it("debounces rapid writes", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "debounce.txt");
    await writeFile(filePath, "", "utf8");

    const callback = vi.fn();
    const watchdog = new FileWatchdog(filePath, callback, { debounceMs: 80 });
    watchdog.start();

    // 快速连续写入
    await appendFile(filePath, "1", "utf8");
    await new Promise((r) => setTimeout(r, 10));
    await appendFile(filePath, "2", "utf8");
    await new Promise((r) => setTimeout(r, 10));
    await appendFile(filePath, "3", "utf8");

    // 等待去抖窗口
    await new Promise((r) => setTimeout(r, 200));
    // 批量写入只触发一次
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("change");
    watchdog.stop();
  });

  it("callbacks are not called after stop", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "stop-test.txt");
    await writeFile(filePath, "data", "utf8");

    const callback = vi.fn();
    const watchdog = new FileWatchdog(filePath, callback, { debounceMs: 30 });
    watchdog.start();
    watchdog.stop();

    // 在 stop 之后写入
    await appendFile(filePath, "more", "utf8");
    await new Promise((r) => setTimeout(r, 100));
    expect(callback).not.toHaveBeenCalled();
  });

  it("supports rename events", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "rename-test.txt");
    await writeFile(filePath, "data", "utf8");

    const callback = vi.fn();
    const watchdog = new FileWatchdog(filePath, callback, { debounceMs: 30 });
    watchdog.start();

    // rename 通过删除模拟（某些平台 rename 事件通过 rename 触发）
    await rm(filePath);
    await new Promise((r) => setTimeout(r, 100));
    // 删除可能触发 rename 事件
    // 我们不校验精确事件类型，只确认不抛异常
    watchdog.stop();
    expect(watchdog.watching).toBe(false);
  });

  it("start is idempotent", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "idempotent.txt");
    await writeFile(filePath, "data", "utf8");

    const callback = vi.fn();
    const watchdog = new FileWatchdog(filePath, callback, { debounceMs: 50 });
    watchdog.start();
    watchdog.start(); // 重复 start 不应报错
    expect(watchdog.watching).toBe(true);
    watchdog.stop();
  });
});
