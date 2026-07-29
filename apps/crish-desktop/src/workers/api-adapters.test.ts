// @vitest-environment jsdom
/**
 * Stream E: api-adapters 测试
 *
 * 覆盖三条关键路径（对齐 Stream E 设计）：
 *   1. Rust 命令命中：adapter 返回 Rust 数据，不触发主线程 fallback
 *   2. Rust missing：adapter 回退到主线程 JS 实现，结果与 Rust 等价
 *   3. messagesToJsonlHybrid 批量阈值：按消息数量选择 inline / single invoke / batched
 *
 * 测试设计原则：
 *   - 不依赖真实 worker pool（vi.mock '../workers'，避免 jsdom 下 new Worker 失败）
 *   - 通过 mockTauriCommand / mockTauriMissing 控制 Rust 命令可用性
 *   - 主线程 fallback 路径用真实浏览器 API（crypto.subtle / btoa / atob / TextDecoder）
 *   - 验证调用次数（确保 Rust 命中时不触发 fallback，反之亦然）
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  mockTauriCommand,
  mockTauriMissing,
} from '../test-setup';

// ── mock worker pool（避免 jsdom 下 new Worker 失败） ───────────────────
// api-adapters 的 compute/io 适配器已不再使用 worker pool fallback，
// 但 render 适配器和 budgetTextWorker 等仍引用 getWorkerPool。
// mock 为抛错的 spy，确保测试不会意外触发 worker 路径。
const scheduleSpy = vi.fn().mockRejectedValue(new Error('worker pool should not be called'));
vi.mock('../workers', () => ({
  getWorkerPool: () => ({
    schedule: scheduleSpy,
  }),
  Priority: {
    Critical: 0,
    High: 1,
    Normal: 2,
    Low: 3,
  } as const,
}));

import {
  sha256Worker,
  detectEncodingWorker,
  parseDiffWorker,
  base64EncodeWorker,
  base64DecodeWorker,
  messagesToJsonlWorker,
  jsonlToMessagesWorker,
  decodeTextBufferWorker,
  messagesToJsonlHybrid,
  __HYBRID_THRESHOLDS,
} from './api-adapters';

// ── 工具函数 ─────────────────────────────────────────────────────────

/** 把 string 编码为 Uint8Array（供 detectEncoding / decodeText 测试用） */
function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** 生成 N 条 mock 消息（用于 messagesToJsonlHybrid 批量测试） */
function makeMessages(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, role: 'user', content: `msg-${i}` }));
}

// ── sha256Worker ──────────────────────────────────────────────────────

describe('sha256Worker', () => {
  beforeEach(() => { scheduleSpy.mockClear(); });

  it('Rust 命中：返回 Rust hex 字符串，不触发主线程 fallback', async () => {
    const rustHash = 'a'.repeat(64);
    mockTauriCommand('core_hash_compute', async () => rustHash);

    const result = await sha256Worker('hello');
    expect(result).toBe(rustHash);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：回退到主线程 crypto.subtle.digest，返回有效 SHA-256', async () => {
    mockTauriMissing('core_hash_compute');

    const result = await sha256Worker('hello');
    // 验证返回的是 64 字符的 hex 字符串
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    // 验证与已知 SHA-256("hello") 一致
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：ArrayBuffer 输入也能正确哈希', async () => {
    mockTauriMissing('core_hash_compute');

    const buf = new TextEncoder().encode('hello').buffer;
    const result = await sha256Worker(buf);
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

// ── detectEncodingWorker ─────────────────────────────────────────────

describe('detectEncodingWorker', () => {
  beforeEach(() => { scheduleSpy.mockClear(); });

  it('Rust 命中：返回 Rust 结果，不触发主线程 fallback', async () => {
    const rustResult = { encoding: 'utf-8', confidence: 0.99, hasBom: false };
    mockTauriCommand('core_detect_encoding', async () => rustResult);

    const result = await detectEncodingWorker(toBytes('hello'));
    expect(result).toEqual(rustResult);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：UTF-8 BOM bytes 回退到主线程检测，识别为 utf-8-bom', async () => {
    mockTauriMissing('core_detect_encoding');

    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    const result = await detectEncodingWorker(bom);
    expect(result.encoding).toBe('utf-8-bom');
    expect(result.hasBom).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it('Rust missing：纯 ASCII bytes 识别为 utf-8', async () => {
    mockTauriMissing('core_detect_encoding');

    const result = await detectEncodingWorker(toBytes('hello world'));
    expect(result.encoding).toBe('utf-8');
    expect(result.hasBom).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('Rust missing：UTF-16LE BOM bytes 识别为 utf-16le', async () => {
    mockTauriMissing('core_detect_encoding');

    const bom = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x65, 0x00]);
    const result = await detectEncodingWorker(bom);
    expect(result.encoding).toBe('utf-16le');
    expect(result.hasBom).toBe(true);
  });
});

// ── parseDiffWorker ───────────────────────────────────────────────────

describe('parseDiffWorker', () => {
  beforeEach(() => { scheduleSpy.mockClear(); });

  it('Rust 命中：返回 Rust DiffResult 结构', async () => {
    const rustResult = {
      files: [{
        oldPath: 'a.txt',
        newPath: 'a.txt',
        status: 'Modified',
        hunks: [],
        stats: { additions: 1, deletions: 1, hunks: 0 },
      }],
      truncated: false,
    };
    mockTauriCommand('core_parse_diff', async () => rustResult);

    const result = await parseDiffWorker('diff --git ...');
    expect(result).toEqual(rustResult);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：返回空结果 { files: [], truncated: false }', async () => {
    mockTauriMissing('core_parse_diff');

    const result = await parseDiffWorker('some diff text');
    expect(result).toEqual({ files: [], truncated: false });
    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});

// ── base64EncodeWorker / base64DecodeWorker ──────────────────────────

describe('base64EncodeWorker', () => {
  beforeEach(() => { scheduleSpy.mockClear(); });

  it('Rust 命中：返回 Rust 编码字符串', async () => {
    mockTauriCommand('core_base64_encode', async () => 'cnVzdA==');

    const result = await base64EncodeWorker('rust');
    expect(result).toBe('cnVzdA==');
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：回退到主线程 btoa，与 Rust 等价', async () => {
    mockTauriMissing('core_base64_encode');

    const result = await base64EncodeWorker('hello');
    expect(result).toBe(btoa('hello'));
  });
});

describe('base64DecodeWorker', () => {
  beforeEach(() => { scheduleSpy.mockClear(); });

  it('Rust 命中：返回 Rust 解码 bytes', async () => {
    mockTauriCommand('core_base64_decode', async () => Array.from(toBytes('rust')));

    const result = await base64DecodeWorker('cnVzdA==');
    // 使用 Array.from 比较，避免 vitest toEqual 对 Uint8Array buffer 引用的严格检查
    expect(Array.from(result)).toEqual(Array.from(toBytes('rust')));
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：回退到主线程 atob，与 Rust 等价', async () => {
    mockTauriMissing('core_base64_decode');

    const result = await base64DecodeWorker(btoa('hello'));
    expect(Array.from(result)).toEqual(Array.from(toBytes('hello')));
  });
});

// ── messagesToJsonlWorker / jsonlToMessagesWorker ───────────────────

describe('messagesToJsonlWorker', () => {
  beforeEach(() => { scheduleSpy.mockClear(); });

  it('Rust 命中：返回 Rust JSONL 字符串', async () => {
    mockTauriCommand('core_messages_to_jsonl', async () => '{"a":1}\n{"b":2}');

    const result = await messagesToJsonlWorker([{ a: 1 }, { b: 2 }]);
    expect(result).toBe('{"a":1}\n{"b":2}');
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：回退到主线程 JSON.stringify join', async () => {
    mockTauriMissing('core_messages_to_jsonl');

    const result = await messagesToJsonlWorker([{ a: 1 }, { b: 2 }]);
    expect(result).toBe('{"a":1}\n{"b":2}');
  });

  it('空数组：返回空字符串', async () => {
    mockTauriMissing('core_messages_to_jsonl');
    const result = await messagesToJsonlWorker([]);
    expect(result).toBe('');
  });
});

describe('jsonlToMessagesWorker', () => {
  beforeEach(() => { scheduleSpy.mockClear(); });

  it('Rust 命中：返回 Rust 解码的消息数组', async () => {
    mockTauriCommand('core_jsonl_to_messages', async () => [{ a: 1 }, { b: 2 }]);

    const result = await jsonlToMessagesWorker('{"a":1}\n{"b":2}');
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：回退到主线程 JSON.parse per line', async () => {
    mockTauriMissing('core_jsonl_to_messages');

    const result = await jsonlToMessagesWorker('{"a":1}\n{"b":2}');
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('Rust missing：JSON 数组格式也能解析', async () => {
    mockTauriMissing('core_jsonl_to_messages');

    const result = await jsonlToMessagesWorker('[{"a":1},{"b":2}]');
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('Rust missing：空字符串返回空数组', async () => {
    mockTauriMissing('core_jsonl_to_messages');
    const result = await jsonlToMessagesWorker('');
    expect(result).toEqual([]);
  });
});

// ── decodeTextBufferWorker ───────────────────────────────────────────

describe('decodeTextBufferWorker', () => {
  beforeEach(() => { scheduleSpy.mockClear(); });

  it('Rust 命中：返回 Rust 解码字符串', async () => {
    mockTauriCommand('core_decode_text', async () => 'rust decoded');

    const result = await decodeTextBufferWorker(toBytes('hello').buffer);
    expect(result).toBe('rust decoded');
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Rust missing：回退到主线程 TextDecoder', async () => {
    mockTauriMissing('core_decode_text');

    const result = await decodeTextBufferWorker(toBytes('hello').buffer);
    expect(result).toBe('hello');
  });

  it('Rust missing：指定 encoding 也能解码', async () => {
    mockTauriMissing('core_decode_text');

    const result = await decodeTextBufferWorker(toBytes('hello').buffer, 'utf-8');
    expect(result).toBe('hello');
  });
});

// ── messagesToJsonlHybrid 批量阈值 ───────────────────────────────────
//
// 三档路径：
//   - ≤ INLINE_THRESHOLD (50)：主线程同步，不触发任何 invoke
//   - ≤ INVOKE_THRESHOLD (500)：单次 invoke
//   - > INVOKE_THRESHOLD (500)：分片 + Promise.allSettled，多次 invoke

describe('messagesToJsonlHybrid batch thresholds', () => {
  let invokeCount: number;

  beforeEach(() => {
    scheduleSpy.mockClear();
    invokeCount = 0;
  });

  it('空数组：返回空字符串，不触发 invoke', async () => {
    mockTauriCommand('core_messages_to_jsonl', async () => {
      invokeCount++;
      return '';
    });

    const result = await messagesToJsonlHybrid([]);
    expect(result).toBe('');
    expect(invokeCount).toBe(0);
  });

  it('小批量 (≤ INLINE_THRESHOLD)：主线程同步，不触发 invoke', async () => {
    mockTauriCommand('core_messages_to_jsonl', async () => {
      invokeCount++;
      return 'rust-result';
    });

    const messages = makeMessages(__HYBRID_THRESHOLDS.INLINE);
    const result = await messagesToJsonlHybrid(messages);

    // 主线程同步结果：每条消息 JSON.stringify 后用 \n 拼接
    const expected = messages.map((m) => JSON.stringify(m)).join('\n');
    expect(result).toBe(expected);
    expect(invokeCount).toBe(0); // 不应触发 invoke
  });

  it('中批量 (INLINE < n ≤ INVOKE)：单次 invoke', async () => {
    mockTauriCommand('core_messages_to_jsonl', async (args) => {
      invokeCount++;
      const msgs = (args as { messages?: unknown[] })?.messages ?? [];
      // 模拟 Rust 行为：每条消息 JSON.stringify 后用 \n 拼接
      return msgs.map((m) => JSON.stringify(m)).join('\n');
    });

    const messages = makeMessages(__HYBRID_THRESHOLDS.INVOKE);
    const result = await messagesToJsonlHybrid(messages);

    const expected = messages.map((m) => JSON.stringify(m)).join('\n');
    expect(result).toBe(expected);
    expect(invokeCount).toBe(1); // 单次 invoke
  });

  it('大批量 (> INVOKE)：分片 + 多次 invoke（每片 CHUNK 条）', async () => {
    mockTauriCommand('core_messages_to_jsonl', async (args) => {
      invokeCount++;
      const msgs = (args as { messages?: unknown[] })?.messages ?? [];
      return msgs.map((m) => JSON.stringify(m)).join('\n');
    });

    // 用 INVOKE + CHUNK + 1 条消息，确保触发 3 次分片（INVOKE + CHUNK + 1 不足 INVOKE+CHUNK*2）
    const total = __HYBRID_THRESHOLDS.INVOKE + __HYBRID_THRESHOLDS.CHUNK + 1;
    const messages = makeMessages(total);
    const result = await messagesToJsonlHybrid(messages);

    // 预期 invoke 次数：1 次 probe + ceil((total) / CHUNK) 次分片
    const expectedChunks = Math.ceil(total / __HYBRID_THRESHOLDS.CHUNK);
    const expectedInvokes = 1 + expectedChunks;

    expect(invokeCount).toBe(expectedInvokes);

    // 验证结果正确性：所有消息的 JSON 都应在结果中
    for (const m of messages) {
      expect(result).toContain(JSON.stringify(m));
    }
  });

  it('中批量 Rust missing：回退到主线程同步', async () => {
    mockTauriMissing('core_messages_to_jsonl');

    const messages = makeMessages(__HYBRID_THRESHOLDS.INVOKE);
    const result = await messagesToJsonlHybrid(messages);

    const expected = messages.map((m) => JSON.stringify(m)).join('\n');
    expect(result).toBe(expected);
  });

  it('大批量 Rust missing：回退到主线程同步（probe 失败后整体回退）', async () => {
    mockTauriMissing('core_messages_to_jsonl');

    const messages = makeMessages(__HYBRID_THRESHOLDS.INVOKE + 100);
    const result = await messagesToJsonlHybrid(messages);

    const expected = messages.map((m) => JSON.stringify(m)).join('\n');
    expect(result).toBe(expected);
  });

  it('大批量部分分片失败：失败的分片返回空，其余正常拼接', async () => {
    let callIdx = 0;
    mockTauriCommand('core_messages_to_jsonl', async (args) => {
      callIdx++;
      const msgs = (args as { messages?: unknown[] })?.messages ?? [];
      // probe (callIdx=1) 成功；后续分片偶数失败、奇数成功
      if (callIdx > 1 && callIdx % 2 === 0) {
        throw new Error('partial failure');
      }
      return msgs.map((m) => JSON.stringify(m)).join('\n');
    });

    const messages = makeMessages(__HYBRID_THRESHOLDS.INVOKE + __HYBRID_THRESHOLDS.CHUNK + 1);
    const result = await messagesToJsonlHybrid(messages);

    // 部分分片失败 → 失败的分片返回空字符串，被 .filter(s => s.length > 0) 过滤
    // 验证结果至少包含成功分片的内容
    expect(result.length).toBeGreaterThan(0);
    // 验证结果以 \n 拼接（allSettled 模式）
    expect(result.includes('\n')).toBe(true);
  });
});

// ── 验证阈值常量 ─────────────────────────────────────────────────────

describe('__HYBRID_THRESHOLDS', () => {
  it('暴露正确的阈值常量', () => {
    expect(__HYBRID_THRESHOLDS.INLINE).toBe(50);
    expect(__HYBRID_THRESHOLDS.INVOKE).toBe(500);
    expect(__HYBRID_THRESHOLDS.CHUNK).toBe(500);
  });
});
