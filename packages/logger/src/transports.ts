import type { LogEntry, LogTransport } from './logger';

export function createConsoleTransport(): LogTransport {
  return (entry: LogEntry) => {
    const line = JSON.stringify(entry);
    switch (entry.level) {
      case 'debug':
        console.debug(line);
        break;
      case 'info':
        console.log(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'error':
      case 'fatal':
        console.error(line);
        break;
    }
  };
}

export function createJSONStreamTransport(stream: {
  write: (s: string) => boolean;
}): LogTransport {
  return (entry: LogEntry) => {
    stream.write(JSON.stringify(entry) + '\n');
  };
}
