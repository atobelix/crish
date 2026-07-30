import { Logger, type LogLevel, type LogEntry } from './logger';
import { createWriteStream, type WriteStream } from 'node:fs';

let _instance: DaemonFileLogger | undefined;

export function toLogErr(
  error: unknown
):
  | {
      message: string;
      stack: string | undefined;
      code: string | undefined;
      name: string | undefined;
    }
  | undefined {
  if (error == null) return undefined;
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      code: (error as { code?: string }).code,
      name: error.name,
    };
  }
  return {
    message: String(error),
    stack: undefined,
    code: undefined,
    name: undefined,
  };
}

export class DaemonFileLogger extends Logger {
  private stream: WriteStream | undefined;
  private filePath: string | undefined;

  constructor() {
    super({ level: 'info', transports: [] });
  }

  init(filePath: string, level: LogLevel = 'info'): void {
    this.filePath = filePath;
    this.setLevel(level);
    this.stream = createWriteStream(filePath, {
      flags: 'a',
      encoding: 'utf-8',
    });
    this.addTransport((entry: LogEntry) => {
      const line = JSON.stringify(entry) + '\n';
      if (this.stream) {
        this.stream.write(line);
      }
    });
  }

  getLogFilePath(): string | undefined {
    return this.filePath;
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      this.stream.end(resolve);
      this.stream = undefined;
    });
  }
}

export function getDaemonLogger(): DaemonFileLogger {
  if (!_instance) {
    _instance = new DaemonFileLogger();
  }
  return _instance;
}
