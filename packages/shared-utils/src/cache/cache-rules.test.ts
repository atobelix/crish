import { describe, it, expect } from 'vitest';
import {
  compareToolNames,
  sortToolsByName,
  formatStableTools,
  canonicalizeJsonSchema,
  derivePromptCacheKey,
  PROMPT_CACHE_KEY_MAX_LENGTH,
} from './cache-rules';

// ─────────────────────────────────────────────────────────────
// R1 工具排序（UTF-8 码点序，C10：禁止 localeCompare）
// ─────────────────────────────────────────────────────────────

describe('R1 sortToolsByName（UTF-8 码点序）', () => {
  const tools = [
    { name: '测试', description: 'd3' },
    { name: 'abc', description: 'd1' },
    { name: '中文', description: 'd4' },
    { name: 'α', description: 'd5' },
    { name: 'z', description: 'd2' },
  ];

  it('中文等非 ASCII 名称按码点升序（abc < z < α < 中文 < 测试）', () => {
    const sorted = sortToolsByName(tools);
    expect(sorted.map((t) => t.name)).toEqual([
      'abc',
      'z',
      'α',
      '中文',
      '测试',
    ]);
  });

  it('不改变输入数组（返回新数组）', () => {
    const input = [...tools];
    sortToolsByName(input);
    expect(input.map((t) => t.name)).toEqual(['测试', 'abc', '中文', 'α', 'z']);
  });

  it('同名工具保持稳定相对顺序', () => {
    const dup = [
      { name: 'b', id: 1 },
      { name: 'a', id: 2 },
      { name: 'b', id: 3 },
    ];
    expect(sortToolsByName(dup).map((t) => t.id)).toEqual([2, 1, 3]);
  });

  it('与逐码点参考排序一致（BMP 域含中文；钉死码点语义）', () => {
    const names = ['中文', 'z', 'α', '测试', 'a', '中', 'Z', '测'];
    const sorted = sortToolsByName(names.map((name) => ({ name }))).map(
      (t) => t.name
    );
    expect(sorted).toEqual([...names].sort(codepointCompareReference));
  });

  it('compareToolNames 与 Rust String::cmp 语义一致（非零即有序）', () => {
    expect(compareToolNames('a', 'b')).toBeLessThan(0);
    expect(compareToolNames('b', 'a')).toBeGreaterThan(0);
    expect(compareToolNames('中文', '测试')).toBeLessThan(0);
    expect(compareToolNames('同', '同')).toBe(0);
  });
});

describe('R1 formatStableTools（排序 + 固定输出形状）', () => {
  it('空/缺省 → undefined', () => {
    expect(formatStableTools(undefined)).toBeUndefined();
    expect(formatStableTools([])).toBeUndefined();
  });

  it('输出固定 wire 形状且按名排序、参数走 R2 规范化', () => {
    const out = formatStableTools([
      {
        name: 'beta',
        description: 'b',
        inputSchema: { required: ['x'], type: 'object' },
      },
      { name: 'alpha', description: 'a', inputSchema: { const: 1 } },
    ]);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'alpha',
          description: 'a',
          parameters: { enum: [1] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'beta',
          description: 'b',
          parameters: { type: 'object', required: ['x'] },
        },
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────
// R2 schema 规范化（rust-parity 样例表：与 Rust canonicalize_schema
// 逐条对齐，A1-23/C10；Rust 侧同名样例表见 schema.rs parity_samples）
// ─────────────────────────────────────────────────────────────

/** 确定性序列化：递归按键码点升序排序后输出紧凑字符串（镜像 Rust
 * `canonical_json_string`；测试断言字节等价的基础） */
function canonicalJsonString(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonString(record[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

interface ParitySample {
  name: string;
  input: unknown;
  expected: unknown;
}

/** 规则级样例表（P6 §3.5.2：TS 侧先钉死，Rust 侧在 P1 落地时复制为 cargo 测试） */
const R2_PARITY_SAMPLES: ParitySample[] = [
  // R2.1 非对象/空 → 归一为 {"type":"object","properties":{}}
  {
    name: 'r2.1 非对象-字符串',
    input: 'hello',
    expected: { type: 'object', properties: {} },
  },
  {
    name: 'r2.1 非对象-数字',
    input: 42,
    expected: { type: 'object', properties: {} },
  },
  {
    name: 'r2.1 非对象-数组',
    input: [1, 2],
    expected: { type: 'object', properties: {} },
  },
  {
    name: 'r2.1 空对象',
    input: {},
    expected: { type: 'object', properties: {} },
  },
  // R2.2 布尔 schema → {"type":"string"}
  { name: 'r2.2 布尔-true', input: true, expected: { type: 'string' } },
  { name: 'r2.2 布尔-false', input: false, expected: { type: 'string' } },
  // R2.3 type 数组：过滤 → 去重 → 白名单固定序 → 收敛/删除
  {
    name: 'r2.3 type 数组过滤收敛',
    input: { type: ['string', 'number', 'string'] },
    expected: { type: ['string', 'number'] },
  },
  {
    name: 'r2.3 type 数组语义等价收敛',
    input: { type: ['number', 'string'] },
    expected: { type: ['string', 'number'] },
  },
  {
    name: 'r2.3 type 数组单元素',
    input: { type: ['integer'] },
    expected: { type: 'integer' },
  },
  {
    name: 'r2.3 type 数组过滤后空',
    input: { type: ['bogus', 'wat'] },
    expected: { type: 'object', properties: {} },
  },
  {
    name: 'r2.3 type 数组去重保序',
    input: { type: ['number', 'string', 'number', 'boolean'] },
    expected: { type: ['string', 'number', 'boolean'] },
  },
  {
    name: 'r2.3 type 数组过滤非法项',
    input: { type: ['object', 'nope', 'array'] },
    expected: { type: ['object', 'array'] },
  },
  {
    name: 'r2.3 type 非数组保留',
    input: { type: 'array' },
    expected: { type: 'array' },
  },
  // R2.4 properties：键码点升序 + 递归；非对象 → 丢弃
  {
    name: 'r2.4 properties 键码点排序并递归',
    input: {
      type: 'object',
      properties: {
        zebra: { required: ['q', 'a'], type: 'object' },
        alpha: { type: 'string' },
      },
    },
    expected: {
      type: 'object',
      properties: {
        alpha: { type: 'string' },
        zebra: { type: 'object', required: ['a', 'q'] },
      },
    },
  },
  {
    name: 'r2.4 properties 非对象丢弃',
    input: { properties: 'nope' },
    expected: { type: 'object', properties: {} },
  },
  // R2.5 required：去重 + 码点升序；非数组 → 丢弃
  {
    name: 'r2.5 required 去重排序',
    input: { type: 'object', required: ['b', 'a', 'b', 'c'] },
    expected: { type: 'object', required: ['a', 'b', 'c'] },
  },
  {
    name: 'r2.5 required 非数组丢弃',
    input: { type: 'object', required: 'nope' },
    expected: { type: 'object' },
  },
  {
    name: 'r2.5 required 过滤非字符串项',
    input: { required: [2, 'b', 'a'] },
    expected: { required: ['a', 'b'] },
  },
  // R2.6 const → enum
  {
    name: 'r2.6 const 数字转 enum',
    input: { const: 5 },
    expected: { enum: [5] },
  },
  {
    name: 'r2.6 const 字符串转 enum',
    input: { const: 'hello' },
    expected: { enum: ['hello'] },
  },
  {
    name: 'r2.6 const 覆盖既有 enum',
    input: { const: 5, enum: ['a'] },
    expected: { enum: [5] },
  },
  // R2.7 $defs / definitions：键码点升序 + 递归
  {
    name: 'r2.7 外defs 键排序递归',
    input: { $defs: { b: { type: 'integer' }, a: { type: 'string' } } },
    expected: { $defs: { a: { type: 'string' }, b: { type: 'integer' } } },
  },
  {
    name: 'r2.7 definitions 键排序递归',
    input: { definitions: { z: { type: 'integer' }, y: { type: 'string' } } },
    expected: {
      definitions: { y: { type: 'string' }, z: { type: 'integer' } },
    },
  },
  {
    name: 'r2.7 外defs 非对象保留',
    input: { $defs: 'nope' },
    expected: { $defs: 'nope' },
  },
  // R2.8 items / oneOf / anyOf / allOf 递归（数组保序）
  {
    name: 'r2.8 items 对象递归',
    input: {
      type: 'array',
      items: {
        type: 'object',
        properties: { q: { type: 'string' }, a: { type: 'string' } },
      },
    },
    expected: {
      type: 'array',
      items: {
        type: 'object',
        properties: { a: { type: 'string' }, q: { type: 'string' } },
      },
    },
  },
  {
    name: 'r2.8 items 元组保序递归',
    input: {
      type: 'array',
      items: [{ type: 'string', required: ['x', 'y'] }, { type: 'integer' }],
    },
    expected: {
      type: 'array',
      items: [{ type: 'string', required: ['x', 'y'] }, { type: 'integer' }],
    },
  },
  {
    name: 'r2.8 oneOf 数组递归保序',
    input: {
      oneOf: [{ type: 'string' }, { required: ['b', 'a'], type: 'object' }],
    },
    expected: {
      oneOf: [{ type: 'string' }, { type: 'object', required: ['a', 'b'] }],
    },
  },
  {
    name: 'r2.8 anyOf 与 allOf 递归',
    input: { anyOf: [{ type: 'number' }], allOf: [{ type: 'string' }] },
    expected: { allOf: [{ type: 'string' }], anyOf: [{ type: 'number' }] },
  },
  // R2.8 之外的一致性扩展（Rust 侧）：not/if/then/else/additionalProperties 递归
  {
    name: 'r2.8 扩展 not/if/then/else 递归',
    input: {
      not: { required: ['b'], type: 'object' },
      if: { const: 1 },
      then: { type: 'string' },
      else: { type: 'integer' },
    },
    expected: {
      not: { type: 'object', required: ['b'] },
      if: { enum: [1] },
      then: { type: 'string' },
      else: { type: 'integer' },
    },
  },
  {
    name: 'r2.8 additionalProperties 对象递归',
    input: {
      type: 'object',
      additionalProperties: { required: ['q'], type: 'string' },
    },
    expected: {
      type: 'object',
      additionalProperties: { type: 'string', required: ['q'] },
    },
  },
  {
    name: 'r2.8 additionalProperties 布尔保留',
    input: { additionalProperties: true },
    expected: { additionalProperties: true },
  },
  // R2.9 固定键序：type → properties → required → items → enum → $defs → 其余码点升序
  {
    name: 'r2.9 固定键序综合',
    input: {
      description: 'd',
      enum: ['x'],
      required: ['r'],
      items: { type: 'string' },
      $defs: { s: { type: 'string' } },
      type: 'object',
      properties: {},
      zebra: 1,
      alpha: 2,
    },
    expected: {
      type: 'object',
      properties: {},
      required: ['r'],
      items: { type: 'string' },
      enum: ['x'],
      $defs: { s: { type: 'string' } },
      alpha: 2,
      description: 'd',
      zebra: 1,
    },
  },
  {
    name: 'r2.9 其余键码点升序（大小写）',
    input: { Z: 1, a: 2, B: 3 },
    expected: { B: 3, Z: 1, a: 2 },
  },
  // $ref：视为叶子，原样保留、不深入
  {
    name: 'r2.ref 外ref 叶子保留',
    input: { $ref: '#/$defs/foo' },
    expected: { $ref: '#/$defs/foo' },
  },
  // 综合：典型工具 schema 形态
  {
    name: 'r2 综合-典型工具 schema',
    input: {
      title: '搜索参数',
      type: 'object',
      required: ['query'],
      properties: {
        limit: { type: ['integer', 'null'] },
        mode: { const: 'fast' },
        query: { type: 'string', description: '搜索词' },
      },
      additionalProperties: false,
    },
    expected: {
      type: 'object',
      properties: {
        limit: { type: ['integer', 'null'] },
        mode: { enum: ['fast'] },
        query: { type: 'string', description: '搜索词' },
      },
      required: ['query'],
      additionalProperties: false,
      title: '搜索参数',
    },
  },
];

describe('R2 rust-parity 样例表（与 Rust canonicalize_schema 逐条对齐）', () => {
  for (const sample of R2_PARITY_SAMPLES) {
    it(`样例 [${sample.name}] 字节一致且幂等`, () => {
      const once = canonicalizeJsonSchema(sample.input);
      expect(canonicalJsonString(once)).toBe(
        canonicalJsonString(sample.expected)
      );
      expect(canonicalJsonString(canonicalizeJsonSchema(once))).toBe(
        canonicalJsonString(once)
      );
    });
  }

  it('R2.9 固定键序：JSON.stringify 输出顺序精确为 type→properties→required→items→enum→$defs→其余码点升序', () => {
    const input = {
      description: 'd',
      enum: ['x'],
      required: ['r'],
      items: { type: 'string' },
      $defs: { s: { type: 'string' } },
      type: 'object',
      properties: {},
      zebra: 1,
      alpha: 2,
    };
    const out = canonicalizeJsonSchema(input);
    expect(JSON.stringify(out)).toBe(
      '{"type":"object","properties":{},"required":["r"],"items":{"type":"string"},"enum":["x"],"$defs":{"s":{"type":"string"}},"alpha":2,"description":"d","zebra":1}'
    );
  });

  it('深层嵌套递归：乱序输入 → 字节等价', () => {
    const input = {
      properties: {
        z: {
          properties: { q: { const: 3 }, a: { type: ['integer', 'integer'] } },
          type: 'object',
        },
        a: {
          $defs: { b: { type: 'string' }, a: { const: 2 } },
          type: 'object',
        },
      },
      required: ['a', 'z', 'a'],
      type: 'object',
    };
    const out = canonicalizeJsonSchema(input);
    const expected = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          $defs: { a: { enum: [2] }, b: { type: 'string' } },
        },
        z: {
          type: 'object',
          properties: {
            a: { type: 'integer' },
            q: { enum: [3] },
          },
        },
      },
      required: ['a', 'z'],
    };
    expect(canonicalJsonString(out)).toBe(canonicalJsonString(expected));
  });
});

// ─────────────────────────────────────────────────────────────
// R3 缓存键推导（码点钳 64；对齐 Rust CacheKey::from_session_id）
// ─────────────────────────────────────────────────────────────

describe('R3 derivePromptCacheKey（码点钳 64）', () => {
  it('常量 = 64', () => {
    expect(PROMPT_CACHE_KEY_MAX_LENGTH).toBe(64);
  });

  it('超长 ASCII 钳到 64 码点', () => {
    const long = 's'.repeat(80);
    expect(derivePromptCacheKey(long)).toBe('s'.repeat(64));
  });

  it('第 65 个字符是多字节中文码点 → 不产生半字符', () => {
    const chinese = 'a'.repeat(63) + '汉';
    expect(derivePromptCacheKey(chinese)).toBe('a'.repeat(63) + '汉');
  });

  it('尾部 emoji（代理对）不被拆散', () => {
    const emoji = 'a'.repeat(63) + '😀';
    expect(derivePromptCacheKey(emoji)).toBe('a'.repeat(63) + '😀');
  });

  it('全是 emoji 的超长串 → 64 个码点且代理对完整', () => {
    const key = derivePromptCacheKey('😀'.repeat(100)) ?? '';
    expect(Array.from(key)).toHaveLength(64);
    expect(key.charCodeAt(key.length - 1)).toBe(0xde00);
  });

  it('首尾空白先 trim 再派生', () => {
    expect(derivePromptCacheKey('  ses-abc  ')).toBe('ses-abc');
  });

  it('空串/全空白 → undefined', () => {
    expect(derivePromptCacheKey('')).toBeUndefined();
    expect(derivePromptCacheKey('   ')).toBeUndefined();
    expect(derivePromptCacheKey('\t\n ')).toBeUndefined();
  });

  it('非字符串输入 → undefined', () => {
    expect(derivePromptCacheKey(null)).toBeUndefined();
    expect(derivePromptCacheKey(undefined)).toBeUndefined();
    expect(derivePromptCacheKey(42)).toBeUndefined();
  });

  it('短于 64 的中文会话 ID 原样返回', () => {
    expect(derivePromptCacheKey('会话-ses-1')).toBe('会话-ses-1');
  });

  it('派生结果幂等（二次派生不变）', () => {
    const once = derivePromptCacheKey('  ' + 'a'.repeat(100));
    expect(derivePromptCacheKey(once)).toBe(once);
  });
});

// ─────────────────────────────────────────────────────────────
// 参考实现：逐码点数值比较（独立于 `<`/`>` 的码点序判据，
// 仅用于测试钉死 R1 的码点语义；BMP 域与实现一致）
// ─────────────────────────────────────────────────────────────

function codepointCompareReference(a: string, b: string): number {
  const pa = Array.from(a);
  const pb = Array.from(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const ca = pa[i];
    const cb = pb[i];
    if (ca === undefined || cb === undefined) {
      break;
    }
    const na = ca.codePointAt(0) ?? 0;
    const nb = cb.codePointAt(0) ?? 0;
    if (na !== nb) {
      return na < nb ? -1 : 1;
    }
  }
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
}
