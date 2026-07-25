export type Unsubscribe = () => void;
export type EventHandler<T = unknown> = (payload: T, source?: string) => void | Promise<void>;

export interface IEventBus<E extends Record<string, unknown>> {
  on<K extends keyof E & string>(event: K, handler: (payload: E[K], source?: string) => void): Unsubscribe;
  once<K extends keyof E & string>(event: K, handler: (payload: E[K], source?: string) => void): Unsubscribe;
  onAny(handler: (payload: { type: string; payload?: unknown; source?: string }) => void): Unsubscribe;
  emit<K extends keyof E & string>(event: K, payload?: E[K], source?: string): void;
  emitAsync<K extends keyof E & string>(event: K, payload?: E[K], source?: string): Promise<void>;
  off<K extends keyof E & string>(event: K, handler: Function): void;
  removeAllListeners(type?: string): void;
  listenerCount(type?: string): number;
}

export interface CrishEventMap {
  'daemon:connection:change': Record<string, unknown>;
  'toast:show': { id: string; message: string; severity: string; timestamp: number };
  'cross-tab:leader-elected': { tabId: string };
  'cross-tab:leader-lost': { tabId: string; newLeader: string };
  'stream:registered': { sessionId: string; runId: string };
  'stream:resumed': { sessionId: string };
  'stream:completed': { sessionId: string; runId?: string };
  'stream:failed': { sessionId: string; runId?: string; error?: string };
  'stream:paused': { sessionId: string; runId?: string; lastSequenceNumber?: number; error?: string; reason?: string };
  'stream:cleared': { sessionId: string };
  'stream:all-cleared': null;
  'stream:stalled': Record<string, unknown>;
  /** 断线续流：read-run-events 后按 sequence 重放 */
  'stream:replay-events': {
    sessionId: string;
    runId: string;
    events: Array<Record<string, unknown>>;
    afterSequence: number;
    nextAfterSequence: number;
  };
  'stream:backpressure': {
    sessionId: string;
    runId: string;
    action: 'pause' | 'resume';
    buffered: number;
  };
  'undo:performed': Record<string, unknown>;
  'redo:performed': Record<string, unknown>;
  'mcp:tools:changed': { serverId: string };
  'sync:error': Record<string, unknown>;
  'sync:conflict': Record<string, unknown>;
  'sync:status': Record<string, unknown>;
}
