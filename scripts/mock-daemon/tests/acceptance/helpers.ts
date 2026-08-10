// =======================================================================
// R0-07 验收三件套——验收级客户端与断言工具
//
// 与 tests/helpers.ts（单元测试简化客户端）的差异：验收客户端保留
// 完整 DeviceEnvelope（v/kind/msgId/ts/from/to/auth/body 全字段），
// 逐字段断言信封是本轮验收的一等断言对象（三件套 1）。
// =======================================================================

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { expect } from 'vitest';
import type { DeviceKind } from '../../../../packages/shared-types/src/generated/device/kinds';
import { nextMsgId } from '../../src/util.js';

/** 仓库根目录（tests/acceptance/ → 上四级） */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

/** 对拍样例集目录（R0-05 唯一共享输入） */
export const PROTOCOL_FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'device-protocol');

/**
 * 确定性序列化：递归按键码点升序排序后输出紧凑字符串（镜像 Rust
 * `canonical` 与 device/parity.test.ts 同一语义；对拍 README 明示
 * canonical JSON 是双端逐字节等价断言的基础）。
 */
export function canonicalJsonString(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonString(record[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** 读取对拍样例（valid 子目录；解析失败即测试基础设施错误） */
export function fixtureSample(name: string): Record<string, unknown> {
  const raw = readFileSync(join(PROTOCOL_FIXTURES, 'valid', name), 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`样例 ${name} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

/** 完整入站信封（验收客户端解析产物；auth 为会话期必需） */
export interface EnvelopeFrame {
  v: number;
  kind: string;
  msgId: string;
  ts: number;
  from: string;
  to: string;
  auth: { deviceId: string; ts: number; nonce: string; sig: string };
  body: Record<string, unknown>;
}

/** 验收级 WS 客户端：保留完整信封逐字段 + 按谓词等待（缓冲保序） */
export class AcceptanceClient {
  readonly ws: WebSocket;
  readonly deviceId: string;
  private buffer: EnvelopeFrame[] = [];
  private waiters: { predicate?: (f: EnvelopeFrame) => boolean; resolve: (f: EnvelopeFrame) => void; timer: NodeJS.Timeout }[] = [];
  private closed = false;

  constructor(url: string, deviceId: string) {
    this.deviceId = deviceId;
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const raw = data.toString('utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      const authObj = json['auth'] as Record<string, unknown> | undefined;
      const frame: EnvelopeFrame = {
        v: json['v'] as number,
        kind: String(json['kind'] ?? ''),
        msgId: String(json['msgId'] ?? ''),
        ts: json['ts'] as number,
        from: String(json['from'] ?? ''),
        to: String(json['to'] ?? ''),
        auth: {
          deviceId: String(authObj?.['deviceId'] ?? ''),
          ts: authObj?.['ts'] as number,
          nonce: String(authObj?.['nonce'] ?? ''),
          sig: String(authObj?.['sig'] ?? ''),
        },
        body: (json['body'] ?? {}) as Record<string, unknown>,
      };
      this.dispatch(frame);
    });
  }

  private dispatch(frame: EnvelopeFrame): void {
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
  waitFor(kindOrPredicate: string | ((f: EnvelopeFrame) => boolean), timeoutMs = 10_000): Promise<EnvelopeFrame> {
    const predicate = typeof kindOrPredicate === 'string' ? (f: EnvelopeFrame): boolean => f.kind === kindOrPredicate : kindOrPredicate;
    const idx = this.buffer.findIndex(predicate);
    if (idx >= 0) return Promise.resolve(this.buffer.splice(idx, 1)[0]!);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待帧超时：${typeof kindOrPredicate === 'string' ? kindOrPredicate : '(谓词)'}`)), timeoutMs);
      this.waiters.push({ predicate, resolve: resolvePromise, timer });
    });
  }

  /** 发送任意帧（完整入站信封：v/kind/msgId/ts/from/to/auth/body） */
  send(kind: DeviceKind, body: Record<string, unknown>): void {
    if (this.closed) throw new Error('连接已关闭，无法发送');
    this.ws.send(JSON.stringify({
      v: 1,
      kind,
      msgId: typeof body['msgId'] === 'string' ? body['msgId'] : nextMsgId('m'),
      ts: Date.now(),
      from: 'mobile',
      to: 'desktop',
      auth: { deviceId: this.deviceId, ts: Date.now(), nonce: 'acceptance-nonce', sig: 'acceptance-sig' },
      body,
    }));
  }

  /** 发送命令帧（remote.*，body = CommandRequest 形状） */
  sendCommand(kind: DeviceKind, command: string, params: Record<string, unknown>): string {
    const msgId = nextMsgId('m');
    this.send(kind, { command, params, msgId });
    return msgId;
  }

  /** 缓冲内未消费帧数（断言「无新帧到达」用） */
  bufferSize(): number {
    return this.buffer.length;
  }

  /** 缓冲内全部帧（断言辅助） */
  peekBuffer(): EnvelopeFrame[] {
    return [...this.buffer];
  }

  /** 等待连接断开（网关关闭感知；不抛错） */
  waitClose(timeoutMs = 5000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('等待连接断开超时')), timeoutMs);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
  }
}

/** 便捷：等待连接建立（onopen） */
export function waitOpen(client: AcceptanceClient, timeoutMs = 5000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('连接建立超时')), timeoutMs);
    client.ws.once('open', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    client.ws.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`连接失败：${String(e)}`));
    });
  });
}

/** 从 events.push 帧取事件对象（断言友好） */
export function eventOf(frame: EnvelopeFrame): Record<string, unknown> {
  return (frame.body['event'] ?? {}) as Record<string, unknown>;
}

/** 从 result.* 帧取 result 对象 */
export function resultOf(frame: EnvelopeFrame): Record<string, unknown> {
  return (frame.body['result'] ?? {}) as Record<string, unknown>;
}

/**
 * 信封逐字段断言（三件套 1 核心工具）：
 * 对照样例 08-events-push.json 的形状契约逐字段校验实际推送帧——
 * 外层 8 字段（v/kind/msgId/ts/from/to/auth/body）+ auth 4 字段
 * （deviceId/ts/nonce/sig）。字段集合必须与样例完全一致。
 */
export function assertEnvelopeFields(
  frame: EnvelopeFrame,
  expectKind: string,
  expected: { from: string; to: string; authDeviceId: string },
): void {
  // 外层字段集合与样例一致（样例 = wire 形态基准，见对拍 README 消费规则）
  expect(Object.keys(frame).sort()).toEqual(['auth', 'body', 'from', 'kind', 'msgId', 'to', 'ts', 'v']);

  expect(frame.v).toBe(1);
  expect(frame.kind).toBe(expectKind);
  expect(typeof frame.msgId).toBe('string');
  expect(frame.msgId.length).toBeGreaterThan(0);
  expect(Number.isInteger(frame.ts)).toBe(true);
  expect(frame.ts).toBeGreaterThan(0);
  // 时间窗校验：ts 与发送时刻偏差 <5s（对齐 D3 重放窗口 ±5min 的验收级收紧口径）
  expect(Math.abs(frame.ts - Date.now())).toBeLessThan(5000);
  expect(frame.from).toBe(expected.from);
  expect(frame.to).toBe(expected.to);

  // auth 四字段（样例 08 同集合）
  expect(Object.keys(frame.auth).sort()).toEqual(['deviceId', 'nonce', 'sig', 'ts']);
  expect(frame.auth.deviceId).toBe(expected.authDeviceId);
  expect(Number.isInteger(frame.auth.ts)).toBe(true);
  expect(frame.auth.ts).toBeGreaterThan(0);
  expect(frame.auth.nonce.length).toBeGreaterThan(0);
  expect(frame.auth.sig.length).toBeGreaterThan(0);
  expect(frame.body).toBeDefined();
}
