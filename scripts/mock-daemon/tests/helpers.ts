// =======================================================================
// mock daemon v0（R0-06）——测试辅助（服务器 + 客户端夹具）
// =======================================================================

import WebSocket from 'ws';
import { MockDaemonServer } from '../src/server.js';
import type { ServerOptions } from '../src/server.js';
import type { DeviceKind } from '../../../packages/shared-types/src/generated/device/kinds';
import { parseInbound } from '../src/envelope.js';
import { nextMsgId } from '../src/util.js';

export interface TestServer {
  server: MockDaemonServer;
  url: string;
  port: number;
}

/** 启动测试服务器（port 0 = 系统分配；默认场景 idle，避免自动事件干扰断言） */
export async function startTestServer(overrides: Partial<ServerOptions> = {}): Promise<TestServer> {
  const server = new MockDaemonServer({
    pairMode: false,
    scenario: 'idle',
    scenarioSpeed: 0,
    ...overrides,
  });
  const info = await server.listen();
  return { server, url: `ws://127.0.0.1:${info.port}`, port: info.port };
}

/** 入站帧形状（测试断言用） */
export interface TestFrame {
  kind: string;
  msgId: string;
  body: Record<string, unknown>;
}

/** 测试客户端：发送 + 按谓词等待（带缓冲，乱序不丢帧） */
export class TestClient {
  readonly ws: WebSocket;
  readonly deviceId: string;
  private buffer: TestFrame[] = [];
  private waiters: { predicate?: (f: TestFrame) => boolean; resolve: (f: TestFrame) => void; timer: NodeJS.Timeout }[] = [];
  private closed = false;

  constructor(url: string, deviceId = 'dev-test-0001') {
    this.deviceId = deviceId;
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const raw = data.toString('utf8');
      const parsed = parseInbound(raw);
      if (!parsed.ok) {
        throw new Error(`测试客户端收到坏帧：${parsed.error.message}（raw=${raw}）`);
      }
      this.dispatch({ kind: parsed.frame.kind, msgId: parsed.frame.msgId, body: parsed.frame.body as Record<string, unknown> });
    });
  }

  private dispatch(frame: TestFrame): void {
    const idx = this.waiters.findIndex((w) => !w.predicate || w.predicate(frame));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(frame);
      return;
    }
    this.buffer.push(frame);
  }

  /** 等待匹配帧（超时默认 10s；谓词可只给 kind） */
  waitFor(kindOrPredicate: string | ((f: TestFrame) => boolean), timeoutMs = 10_000): Promise<TestFrame> {
    const predicate = typeof kindOrPredicate === 'string' ? (f: TestFrame): boolean => f.kind === kindOrPredicate : kindOrPredicate;
    const idx = this.buffer.findIndex(predicate);
    if (idx >= 0) return Promise.resolve(this.buffer.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待帧超时：${typeof kindOrPredicate === 'string' ? kindOrPredicate : '(谓词)'}`)), timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  /** 发送命令帧（remote.*，body = CommandRequest 形状） */
  sendCommand(kind: DeviceKind, command: string, params: Record<string, unknown>): string {
    const msgId = nextMsgId('m');
    this.send(kind, { command, params, msgId });
    return msgId;
  }

  /** 发送任意帧（信封自动补全） */
  send(kind: DeviceKind, body: Record<string, unknown>): void {
    if (this.closed) throw new Error('连接已关闭，无法发送');
    this.ws.send(JSON.stringify({
      v: 1,
      kind,
      msgId: typeof body['msgId'] === 'string' ? body['msgId'] : nextMsgId('m'),
      ts: Date.now(),
      from: 'mobile',
      to: 'desktop',
      auth: { deviceId: this.deviceId, ts: Date.now(), nonce: 'test-nonce', sig: 'test-sig' },
      body,
    }));
  }

  /** 缓冲内未消费帧数（断言「无新帧到达」用） */
  bufferSize(): number {
    return this.buffer.length;
  }

  /** 缓冲内全部帧（断言辅助） */
  peekBuffer(): TestFrame[] {
    return [...this.buffer];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
  }
}

/** 便捷：等待连接建立（onopen） */
export function waitOpen(client: TestClient, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接建立超时')), timeoutMs);
    client.ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    client.ws.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`连接失败：${String(e)}`));
    });
  });
}

/** 从 events.push 帧取事件对象（断言友好） */
export function eventOf(frame: TestFrame): Record<string, unknown> {
  return (frame.body['event'] ?? {}) as Record<string, unknown>;
}

/** 从 result.* 帧取 result 对象 */
export function resultOf(frame: TestFrame): Record<string, unknown> {
  return (frame.body['result'] ?? {}) as Record<string, unknown>;
}

/** 从 error 帧取错误码 */
export function errorOf(frame: TestFrame): { code: string; message: string } {
  return { code: String(frame.body['code'] ?? ''), message: String(frame.body['message'] ?? '') };
}
