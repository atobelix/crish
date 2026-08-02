/**
 * 混沌容错与抗抖动测试 (Chaos Resilience & Anti-Jitter Test Suite)
 *
 * C3.1 迁移后保留的覆盖：
 * 2. 网络抖动：HTTP 504 超时、429 Rate Limit 限流（纯函数退避）。
 * 4. 用户疯狂连击：按钮 Double-click、连续快速敲击 Enter 发送消息的防抖与防重复派发。
 * 5. 乱序帧与拆包：大 Binary 帧分片传输与乱序接收防护。
 *
 * 已删除（WS daemon 语义，C3.1）：
 * - 1. 端口冲突 / WS 端口漂移 Handshake（Tauri IPC 无 WS URL）
 * - 2 内 WebSocket 掉线重连用例
 * - 3. Daemon SIGKILL 崩溃重连（进程内核心，无独立 daemon 进程）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
} from '../../../../packages/shared-utils/src/retry-openai';
import { retryWithBackoff } from '../../../../packages/shared-utils/src/retry';

describe('【极速边界、混沌容错与抗抖动】测试', () => {

  // =========================================================================
  // 2. 网络抖动：HTTP 504 超时、429 Rate Limit 限流
  // =========================================================================
  describe('2. 网络抖动与超流限流容错', () => {
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
