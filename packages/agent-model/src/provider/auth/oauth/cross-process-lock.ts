import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface LockContent {
  generation: number;
  timestamp: number;
  pid: number;
  hostname: string;
}

const STALE_THRESHOLD_MS = 60_000;
const ACQUIRE_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 200;

export class CrossProcessLock {
  private lockFilePath: string;
  private fd: number | null = null;

  constructor(lockDir: string, name: string) {
    const dir = path.resolve(lockDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.lockFilePath = path.join(dir, `${name}.lock`);
  }

  async acquire(
    expectedGeneration?: number,
    timeoutMs = ACQUIRE_TIMEOUT_MS
  ): Promise<boolean> {
    if (this.fd !== null) {
      return true;
    }

    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const existing = this.tryReadLock();
        if (
          existing &&
          expectedGeneration !== undefined &&
          existing.generation !== expectedGeneration
        ) {
          return false;
        }

        const fd = fs.openSync(this.lockFilePath, 'wx');
        const content: LockContent = {
          generation: expectedGeneration ?? 0,
          timestamp: Date.now(),
          pid: process.pid,
          hostname: os.hostname(),
        };
        const data = Buffer.from(JSON.stringify(content), 'utf-8');
        fs.writeSync(fd, data);

        this.fd = fd;
        return true;
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'EEXIST') {
          throw err;
        }

        if (this.tryHandleStale()) {
          continue;
        }

        await this.sleep(RETRY_INTERVAL_MS);
      }
    }

    return false;
  }

  release(newGeneration?: number): void {
    if (newGeneration !== undefined && this.fd !== null) {
      try {
        const content: LockContent = {
          generation: newGeneration,
          timestamp: Date.now(),
          pid: process.pid,
          hostname: os.hostname(),
        };
        const data = Buffer.from(JSON.stringify(content), 'utf-8');
        fs.ftruncateSync(this.fd, 0);
        fs.writeSync(this.fd, data);
      } catch {
        // best-effort
      }
    }

    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // best-effort
      }
      this.fd = null;
    }

    try {
      fs.unlinkSync(this.lockFilePath);
    } catch {
      // best-effort
    }
  }

  readGeneration(): number | null {
    const content = this.tryReadLock();
    return content?.generation ?? null;
  }

  isHeld(): boolean {
    return this.fd !== null;
  }

  getFilePath(): string {
    return this.lockFilePath;
  }

  private tryReadLock(): LockContent | null {
    try {
      const data = fs.readFileSync(this.lockFilePath, 'utf-8');
      return JSON.parse(data) as LockContent;
    } catch {
      return null;
    }
  }

  private tryHandleStale(): boolean {
    try {
      const existing = this.tryReadLock();
      if (existing && Date.now() - existing.timestamp > STALE_THRESHOLD_MS) {
        fs.unlinkSync(this.lockFilePath);
        return true;
      }
    } catch {
      // best-effort
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
