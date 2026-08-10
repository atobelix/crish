// packages/shared-types/src/generated/device/parity.test.ts
// R0-05 TS↔Rust 设备协议对拍闭环（D8 §5.3.3 protocol-parity）
//
// 与 `tests/fixtures/device-protocol/` 样例集（唯一共享输入）双端消费：Rust
// 侧 `crates/conex-types/tests/device_parity.rs` 消费同一目录。本文件断言：
//
// - valid/*.json：parseDeviceFrame 解析成功 → 重序列化与样例**规范化 JSON**
//   一致（键码点升序递归排序，canonicalJsonString 与 Rust 侧 canonical
//   同一语义）；
// - invalid/*.json：parseDeviceFrame 拒绝（与 Rust 侧 parse_frame 拒绝语义
//   对齐——无效样例只收录双端一致拒绝的载荷，见 README.md 消费规则）。
//
// 对拍注记裁决（配对码字符集 / canon / tauri_command 占位 / ResumeState
// 死条目）见 `tests/fixtures/device-protocol/README.md`。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDeviceFrame } from './parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'device-protocol');

/** 确定性序列化：递归按键码点升序排序后输出紧凑字符串（镜像 Rust
 * `canonical`；测试断言字节等价的基础） */
function canonicalJsonString(value: unknown): string {
  if (value === null) return 'null';
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

function fixtureFiles(subdir: 'valid' | 'invalid'): string[] {
  return readdirSync(join(FIXTURES, subdir))
    .filter((f) => f.endsWith('.json'))
    .sort();
}

describe('R0-05 valid 样例：解析成功且重序列化与样例一致', () => {
  const files = fixtureFiles('valid');
  expect(files.length).toBeGreaterThanOrEqual(10);

  it.each(files)('%s', (file) => {
    const raw = readFileSync(join(FIXTURES, 'valid', file), 'utf8');
    const sample = JSON.parse(raw) as unknown;
    const result = parseDeviceFrame(sample);
    expect(result.ok, `样例 ${file} 必须解析成功：${result.ok ? '' : result.error}`).toBe(true);
    if (result.ok) {
      expect(canonicalJsonString(result.data)).toBe(canonicalJsonString(sample));
    }
  });
});

describe('R0-05 invalid 样例：双端一致拒绝', () => {
  const files = fixtureFiles('invalid');
  expect(files.length).toBeGreaterThanOrEqual(5);

  it.each(files)('%s', (file) => {
    const raw = readFileSync(join(FIXTURES, 'invalid', file), 'utf8');
    const sample = JSON.parse(raw) as unknown;
    const result = parseDeviceFrame(sample);
    expect(result.ok, `样例 ${file} 必须被拒绝（Rust 侧 device_parity.rs 同步断言）`).toBe(false);
  });
});
