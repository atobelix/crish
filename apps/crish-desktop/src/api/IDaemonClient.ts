export type IDaemonClientState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface IDaemonClient {
  getState(): IDaemonClientState;
  getUrl(): string | null;
  getLastError(): Error | null;
  hasEverConnected(): boolean;
  isKeepAliveStarted(): boolean;
  isConnected(): boolean;
  /** Latest ping→pong RTT in ms (0 if none). */
  getLastLatencyMs(): number;
  /** Consecutive heartbeat misses awaiting pong. */
  getHeartbeatMisses(): number;
  getReconnectAttempt(): number;
  onState(cb: (s: IDaemonClientState, err?: Error) => void): () => void;
  onMessage(cb: (msg: Record<string, unknown>) => void): () => void;
  startKeepAlive(): void;
  connect(): Promise<void>;
  waitUntilConnected(timeoutMs?: number): Promise<boolean>;
  disconnect(): void;
  request<T = unknown>(command: Record<string, unknown>, expectedType: string | string[], timeoutMs?: number): Promise<T>;
  send(command: Record<string, unknown>): Promise<void>;
}
