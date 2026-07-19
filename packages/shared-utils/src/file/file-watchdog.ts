/**
 * FileWatchdog
 *
 * 文件变更监视器，平台自适应实现。
 *
 * 设计意图：
 * - Windows/macOS/Linux 使用 fs.watch（原生事件）
 * - 其他平台（如容器/受限环境）用 setInterval polling 降级
 * - 去抖 100ms 防止批量写入触发多次回调
 *
 * 性能特征：
 * - 原生 watch 事件驱动，无轮询开销
 * - polling 降级每 2s 检查一次 stat.mtimeMs
 * - 适合监视日志文件、JSONL 等持续写入的场景
 */
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";

export type FileChangeEvent = "change" | "rename";

export interface FileWatchdogOptions {
  /** 去抖间隔（毫秒），默认 100。 */
  debounceMs?: number;
  /** polling 轮询间隔（毫秒），默认 2000。 */
  pollingIntervalMs?: number;
}

export class FileWatchdog {
  private watcher: FSWatcher | undefined;
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private _watching = false;
  private lastMtimeMs = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEvent: FileChangeEvent | undefined;
  private lastEventTime = 0;
  private readonly debounceMs: number;
  private readonly pollingIntervalMs: number;

  constructor(
    private readonly filePath: string,
    private readonly callback: (event: FileChangeEvent) => void,
    options?: FileWatchdogOptions,
  ) {
    this.debounceMs = options?.debounceMs ?? 100;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? 2000;
  }

  /** 启动监视。平台自适应：原生 watch 优先，fallback 到 polling。 */
  start(): void {
    if (this._watching) return;
    this._watching = true;

    try {
      this.watcher = watch(this.filePath, (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          this.emitDebounced(eventType);
        }
      });
    } catch {
      // 原生 watch 失败，降级到 polling
      this.startPolling();
    }
  }

  /** 停止监视。 */
  stop(): void {
    this._watching = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  /** 是否正在监视。 */
  get watching(): boolean {
    return this._watching;
  }

  private startPolling(): void {
    // 初始化 mtime
    this.pollingTimer = setInterval(async () => {
      try {
        const s = await stat(this.filePath);
        if (this.lastMtimeMs > 0 && s.mtimeMs > this.lastMtimeMs) {
          this.emitDebounced("change");
        }
        this.lastMtimeMs = s.mtimeMs;
      } catch {
        // 文件可能已被删除
      }
    }, this.pollingIntervalMs);
  }

  private emitDebounced(event: FileChangeEvent): void {
    const now = Date.now();

    // 同一事件在去抖窗口内重入时更新计时
    if (this.lastEvent === event && now - this.lastEventTime < this.debounceMs) {
      this.lastEventTime = now;
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        this.callback(event);
      }, this.debounceMs);
      return;
    }

    this.lastEvent = event;
    this.lastEventTime = now;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.callback(event);
    }, this.debounceMs);
  }
}
