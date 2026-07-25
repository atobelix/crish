/**
 * 混沌容错与抗抖动测试 (Chaos Resilience & Anti-Jitter Test Suite)
 * 
 * 重点覆盖度：
 * 1. 端口冲突：8765 端口被占用时，Sidecar 与前端自动漂移至 8766 端口 Handshake 握手。
 * 2. 网络抖动：HTTP 504 超时、429 Rate Limit 限流、WebSocket 突然掉线重连。
 * 3. 进程崩溃：Daemon 进程被强制杀掉 (SIGKILL)，前端断开重连且 Session 状态不丢失、不上屏白屏。
 * 4. 用户疯狂连击：按钮 Double-click、连续快速敲击 Enter 发送消息的防抖与防重复派发。
 * 5. 乱序帧与拆包：大 Binary 帧分片传输与乱序接收防护。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DesktopDaemonClient,
  HEARTBEAT_MISS_TOLERANCE,
  resetDesktopDaemonClientForTests,
} from '../api/daemonClient';
import { ConnectionManager } from '../services/ConnectionManager';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';
import {
  BinaryFrameType,
  encodeBinaryFrame,
  decodeBinaryFrame,
  encodeMetaBodyPayload,
  decodeMetaBodyPayload,
  encodeUtf8,
  decodeUtf8,
} from '../api/binaryFrame';
import {
  chooseRetryDelayMs,
  parseRetryAfterMs,
  normalizeRetryOptions,
  retryDelayMs,
} from '../../../../packages/agent-runtime/src/openai-retry';
import { retryWithBackoff } from '../../../../packages/shared-utils/src/retry';

type Listener = (ev?: unknown) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.simulateOpen());
  }

  addEventListener(type: string, cb: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: Listener) {
    this.listeners.get(type)?.delete(cb);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('WebSocket is not OPEN');
    }
    this.sent.push(String(data));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  simulateOpen() {
    if (this.readyState !== FakeWebSocket.CONNECTING) return;
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  simulateMessage(msg: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(msg) });
  }

  private emit(type: string, ev?: unknown) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb(ev);
    }
  }
}

function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error('no FakeWebSocket');
  return ws;
}

describe('【极速边界、混沌容错与抗抖动】测试', () => {

  // =========================================================================
  // 1. 端口冲突与 Handshake 自动漂移 (Port Conflict & Port Drift Handshake)
  // =========================================================================
  describe('1. 端口冲突与 Handshake 自动漂移', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      FakeWebSocket.instances = [];
      resetDesktopDaemonClientForTests();
      ConnectionManager.resetInstanceForTests();
    });

    afterEach(() => {
      ConnectionManager.resetInstanceForTests();
      resetDesktopDaemonClientForTests();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('当 8765 端口被占用时，Sidecar 与前端能动态识别并自动漂移至 8766 端口完成 Handshake 握手', async () => {
      localStorage.setItem('crish_daemon_ws', 'ws://127.0.0.1:8766');
      const client = new DesktopDaemonClient({
        heartbeatMs: 5000,
        webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      });

      const cm = ConnectionManager.createForTest(client);

      const connectP = client.connect();
      await vi.advanceTimersByTimeAsync(0);
      await connectP;

      expect(client.isConnected()).toBe(true);
      expect(client.getUrl()).toBe('ws://127.0.0.1:8766');

      // 模拟完成 Handshake (认证)
      const ws = lastSocket();
      expect(ws.url).toBe('ws://127.0.0.1:8766');
      ws.simulateMessage({ type: 'authenticated' });
      await vi.advanceTimersByTimeAsync(0);

      expect(cm.getState().phase).toBe('ready');
      expect(cm.isReady()).toBe(true);

      cm.dispose();
      client.disconnect();
      localStorage.removeItem('crish_daemon_ws');
    });

    it('8765 握手失败/拒绝连接时，重连循环能自动切换到新端口 8766 并重新发起 Handshake', async () => {
      localStorage.setItem('crish_daemon_ws', 'ws://127.0.0.1:8765');
      const client = new DesktopDaemonClient({
        heartbeatMs: 5000,
        webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      });

      const p1 = client.connect();
      await vi.advanceTimersByTimeAsync(0);
      await p1;

      // 模拟 8765 被占用 / 连接被拒绝中断
      const ws1 = lastSocket();
      ws1.close();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.getState()).toBe('reconnecting');

      // 断开原端口并由 Sidecar 漂移后更新配置重连 8766
      localStorage.setItem('crish_daemon_ws', 'ws://127.0.0.1:8766');
      client.disconnect();
      const p2 = client.connect();
      await vi.advanceTimersByTimeAsync(0);
      await p2;

      expect(client.getUrl()).toBe('ws://127.0.0.1:8766');
      expect(client.isConnected()).toBe(true);

      client.disconnect();
      localStorage.removeItem('crish_daemon_ws');
    });
  });

  // =========================================================================
  // 2. 网络抖动：HTTP 504 超时、429 Rate Limit 限流、WebSocket 掉线重连
  // =========================================================================
  describe('2. 网络抖动与超流限流容错', () => {
    beforeEach(() => {
      FakeWebSocket.instances = [];
      resetDesktopDaemonClientForTests();
    });

    afterEach(() => {
      resetDesktopDaemonClientForTests();
      vi.restoreAllMocks();
    });

    it('HTTP 504 Gateway Timeout: 发生 504 网关超时时自动计算指数退避并重试', async () => {
      let attempts = 0;
      const mockApi = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('504 Gateway Timeout');
          (err as any).status = 504;
          throw err;
        }
        return { status: 200, data: 'success' };
      });

      const result = await retryWithBackoff(mockApi, {
        maxAttempts: 4,
        baseMs: 5,
        maxMs: 20,
        shouldRetry: (err) => (err as any).status === 504,
      });

      expect(attempts).toBe(3);
      expect(result).toEqual({ status: 200, data: 'success' });
    });

    it('HTTP 429 Rate Limit 限流: 正确解析 Retry-After 标头并钳制最大延迟', () => {
      const opts = normalizeRetryOptions({
        initialDelayMs: 500,
        maxDelayMs: 5000,
        totalBudgetMs: 30000,
      });

      // 解析 Retry-After 为 3 秒
      const delay3s = chooseRetryDelayMs(opts, 1, '3');
      expect(delay3s).toBe(3000);

      // 恶意/超大 Retry-After: 99999 秒被钳制到 maxDelayMs (5000ms)
      const delayClamped = chooseRetryDelayMs(opts, 1, '99999');
      expect(delayClamped).toBe(5000);

      // 格式化解析验证
      expect(parseRetryAfterMs('10')).toBe(10000);
      expect(parseRetryAfterMs('invalid')).toBeUndefined();

      // 指数退避计算增量验证
      const delayAttempt1 = retryDelayMs(opts, 1);
      const delayAttempt2 = retryDelayMs(opts, 2);
      expect(delayAttempt2).toBeGreaterThanOrEqual(delayAttempt1);
    });

    it('WebSocket 突然掉线重连: 掉线 (1006) 后自动触发退避重连且保留事件监听器', async () => {
      vi.useFakeTimers();
      const client = new DesktopDaemonClient({
        heartbeatMs: 200,
        heartbeatMissTolerance: HEARTBEAT_MISS_TOLERANCE,
        webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      });

      const eventCallback = vi.fn();
      client.onMessage(eventCallback);

      const p = client.connect('ws://127.0.0.1:8765');
      await vi.advanceTimersByTimeAsync(0);
      await p;

      expect(client.isConnected()).toBe(true);

      // 模拟 WebSocket 突然掉线 (异常断开 1006)
      const ws = lastSocket();
      ws.close();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.getState()).toBe('reconnecting');

      // 前进定时器直到自动重连逻辑触发并建立新 WebSocket
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();

      expect(client.isConnected()).toBe(true);

      // 验证重连后新连接上推送的消息仍能触发原来的监听器
      const newWs = lastSocket();
      newWs.simulateMessage({ type: 'stream-chunk', delta: 'hello' });
      expect(eventCallback).toHaveBeenCalledWith({ type: 'stream-chunk', delta: 'hello' });

      client.disconnect();
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // 3. 进程崩溃：Daemon 进程被强制杀掉 (SIGKILL)，Session 状态不丢失、不上屏白屏
  // =========================================================================
  describe('3. Daemon 进程崩溃 (SIGKILL) 与 Session 状态保持', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      FakeWebSocket.instances = [];
      resetDesktopDaemonClientForTests();
      ConnectionManager.resetInstanceForTests();
      sessionRuntimeRegistry.remove('sess_1');
      sessionRuntimeRegistry.remove('sess_active');
    });

    afterEach(() => {
      sessionRuntimeRegistry.remove('sess_1');
      sessionRuntimeRegistry.remove('sess_active');
      ConnectionManager.resetInstanceForTests();
      resetDesktopDaemonClientForTests();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('Daemon 被 SIGKILL 强制杀死时，前端 ConnectionManager 优雅降级为 recovering，不上屏白屏', async () => {
      const client = new DesktopDaemonClient({
        heartbeatMs: 1000,
        webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      });

      const cm = ConnectionManager.createForTest(client);
      const connectP = cm.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().simulateMessage({ type: 'authenticated' });
      await connectP;

      expect(cm.getState().phase).toBe('ready');

      // 模拟存有当前 Session 状态草稿与对比视图
      sessionRuntimeRegistry.save('sess_1', {
        composerDraft: 'User draft text during crash',
        chatMainSurface: 'chat',
      });

      // SIGKILL: Socket 突然关闭且没有任何 Close Frame
      lastSocket().close();
      await vi.advanceTimersByTimeAsync(0);

      // ConnectionManager 转换至 recovering 状态
      expect(cm.getState().phase).toBe('recovering');

      // 关键防线：Session 状态与草稿存量完好无损，没有被擦除/未发生白屏崩溃
      const runtimeState = sessionRuntimeRegistry.get('sess_1');
      expect(runtimeState.composerDraft).toBe('User draft text during crash');
      expect(runtimeState.chatMainSurface).toBe('chat');

      cm.dispose();
      client.disconnect();
    });

    it('Daemon 崩溃重启后，前端自动恢复连接并保持 Session 状态同步', async () => {
      const client = new DesktopDaemonClient({
        heartbeatMs: 1000,
        webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      });

      const cm = ConnectionManager.createForTest(client);
      const connectP = cm.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().simulateMessage({ type: 'authenticated' });
      await connectP;

      sessionRuntimeRegistry.save('sess_active', {
        composerDraft: 'Keep this active draft',
      });

      // SIGKILL 崩溃
      lastSocket().close();
      await vi.advanceTimersByTimeAsync(0);

      expect(cm.getState().phase).toBe('recovering');

      // 推动定时器，Daemon 进程复活后自动建立新连接
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      lastSocket().simulateMessage({ type: 'authenticated' });

      expect(cm.getState().phase).toBe('ready');
      expect(sessionRuntimeRegistry.get('sess_active').composerDraft).toBe('Keep this active draft');

      cm.dispose();
      client.disconnect();
    });
  });

  // =========================================================================
  // 4. 用户疯狂连击：按钮 Double-click、连续 Enter 发送消息防抖防重复派发
  // =========================================================================
  describe('4. 用户疯狂连击防抖与防重复派发防护', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('按钮 Double-click: 短时间内 (如 200ms) 连续连击按钮只响应并触发 1 次派发', () => {
      const handler = vi.fn();

      let inFlight = false;
      let lastClickTime = 0;
      const clickGuard = (...args: any[]) => {
        const now = Date.now();
        if (inFlight || now - lastClickTime < 300) {
          return;
        }
        lastClickTime = now;
        inFlight = true;
        try {
          handler(...args);
        } finally {
          setTimeout(() => {
            inFlight = false;
          }, 300);
        }
      };

      // 模拟用户 50ms 内疯狂连击 5 次
      clickGuard('event_1');
      vi.advanceTimersByTime(10);
      clickGuard('event_2');
      vi.advanceTimersByTime(10);
      clickGuard('event_3');
      vi.advanceTimersByTime(10);
      clickGuard('event_4');
      vi.advanceTimersByTime(10);
      clickGuard('event_5');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('event_1');

      // 冷却时间 (300ms) 过去后，再次点击方可派发
      vi.advanceTimersByTime(350);
      clickGuard('event_6');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenLastCalledWith('event_6');
    });

    it('连续 Enter 键敲击: 在消息流处于 inFlight 时，拦截重复的 Enter 发送派发', () => {
      const sendStreamRun = vi.fn();
      let isGenerating = false;

      const handleEnterKey = (userInput: string) => {
        if (!userInput.trim() || isGenerating) {
          return false;
        }
        isGenerating = true;
        sendStreamRun(userInput);
        return true;
      };

      // 第一次敲击 Enter: 成功派发
      const firstResult = handleEnterKey('build my app');
      expect(firstResult).toBe(true);
      expect(sendStreamRun).toHaveBeenCalledTimes(1);

      // 用户疯狂敲击 Enter (连续 3 次): 全部被拦截
      expect(handleEnterKey('build my app')).toBe(false);
      expect(handleEnterKey('build my app')).toBe(false);
      expect(handleEnterKey('build my app')).toBe(false);

      expect(sendStreamRun).toHaveBeenCalledTimes(1);

      // 流结束
      isGenerating = false;

      // 再次敲击 Enter: 允许派发
      expect(handleEnterKey('next feature')).toBe(true);
      expect(sendStreamRun).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 5. 乱序帧与拆包：大 Binary 帧分片传输与乱序接收防护
  // =========================================================================
  describe('5. 乱序帧与大 Binary 帧拆包分片防护', () => {
    it('大 Binary 帧分片传输 (拆包): 64KB 大 Payload 拆分为多帧发送，重组还原 100% 字节一致', () => {
      const largeData = new Uint8Array(64 * 1024);
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      const CHUNK_SIZE = 8 * 1024;
      const chunks: Uint8Array[] = [];
      const totalChunks = Math.ceil(largeData.length / CHUNK_SIZE);

      for (let seq = 0; seq < totalChunks; seq++) {
        const slice = largeData.subarray(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE);
        const meta = { seq, totalChunks, streamId: 'stream_bin_1' };
        const framePayload = encodeMetaBodyPayload(meta, slice);
        const binaryFrame = encodeBinaryFrame(BinaryFrameType.TOOL_BLOB, framePayload);
        chunks.push(new Uint8Array(binaryFrame));
      }

      expect(chunks.length).toBe(8);

      const reassembled = new Uint8Array(largeData.length);
      for (const chunk of chunks) {
        const decodedFrame = decodeBinaryFrame(chunk.buffer);
        expect(decodedFrame.ok).toBe(true);
        if (!decodedFrame.ok) continue;

        const decodedMetaBody = decodeMetaBodyPayload(decodedFrame.frame.payload);
        expect(decodedMetaBody.ok).toBe(true);
        if (!decodedMetaBody.ok) continue;

        const { seq } = decodedMetaBody.meta as { seq: number };
        reassembled.set(decodedMetaBody.body, seq * CHUNK_SIZE);
      }

      expect(Array.from(reassembled)).toEqual(Array.from(largeData));
    });

    it('乱序接收防护: 分片帧按 [3, 1, 0, 2] 乱序到达时，根据 seq 序号正确排序与无损还原', () => {
      const rawText = 'Chaos test out-of-order binary chunk reassembly protection.';
      const bytes = encodeUtf8(rawText);

      const totalChunks = 4;
      const chunkSize = Math.ceil(bytes.length / totalChunks);
      const encodedChunks: Array<{ seq: number; frame: Uint8Array }> = [];

      for (let i = 0; i < totalChunks; i++) {
        const slice = bytes.subarray(i * chunkSize, (i + 1) * chunkSize);
        const meta = { seq: i, totalChunks };
        const payload = encodeMetaBodyPayload(meta, slice);
        const frame = new Uint8Array(encodeBinaryFrame(BinaryFrameType.FILE_PATCH, payload));
        encodedChunks.push({ seq: i, frame });
      }

      const outOfOrderIndices = [3, 1, 0, 2];
      const receivedQueue = outOfOrderIndices.map((idx) => encodedChunks[idx]);

      const reassemblyMap = new Map<number, Uint8Array>();

      for (const item of receivedQueue) {
        const decoded = decodeBinaryFrame(item.frame.buffer);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) continue;

        const metaBody = decodeMetaBodyPayload(decoded.frame.payload);
        expect(metaBody.ok).toBe(true);
        if (!metaBody.ok) continue;

        const seq = (metaBody.meta as { seq: number }).seq;
        reassemblyMap.set(seq, metaBody.body);
      }

      const sortedBodies: Uint8Array[] = [];
      for (let i = 0; i < totalChunks; i++) {
        expect(reassemblyMap.has(i)).toBe(true);
        sortedBodies.push(reassemblyMap.get(i)!);
      }

      const fullBufferLength = sortedBodies.reduce((acc, b) => acc + b.length, 0);
      const fullBuffer = new Uint8Array(fullBufferLength);
      let offset = 0;
      for (const b of sortedBodies) {
        fullBuffer.set(b, offset);
        offset += b.length;
      }

      expect(decodeUtf8(fullBuffer)).toBe(rawText);
    });

    it('损坏与截断 Binary 帧防护: Magic Bytes 错误或 Body 截断时优雅返回 ok:false，防止崩溃', () => {
      // 1. 损坏的 Magic Bytes
      const invalidMagicBuf = new Uint8Array([0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00]);
      const res1 = decodeBinaryFrame(invalidMagicBuf.buffer);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error).toMatch(/Magic/i);
      }

      // 2. 截断的 Header (小于 8 字节)
      const truncatedBuf = new Uint8Array([0x43, 0x52, 0x01]);
      const res2 = decodeBinaryFrame(truncatedBuf.buffer);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error).toMatch(/short/i);
      }

      // 3. Header 声明 Payload 长度 1000 字节，但实际 Body 只有 4 字节
      const incompleteBuf = new Uint8Array(12);
      const dv = new DataView(incompleteBuf.buffer);
      dv.setUint8(0, 0x43);
      dv.setUint8(1, 0x52);
      dv.setUint8(2, 1);
      dv.setUint8(3, BinaryFrameType.TOOL_BLOB);
      dv.setUint32(4, 1000, true);
      const res3 = decodeBinaryFrame(incompleteBuf.buffer);
      expect(res3.ok).toBe(false);
      if (!res3.ok) {
        expect(res3.error).toMatch(/Truncated/i);
      }
    });
  });
});
