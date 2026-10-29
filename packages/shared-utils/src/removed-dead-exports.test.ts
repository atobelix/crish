/**
 * 已删死导出与已删文件的回归锁。
 *
 * 桶不得把平台适配引擎、对象池、指标导出器等死符号导回来，
 * 被删的 Node 遗留文件也不得复活；同时锁住仍在使用的工具与文件。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(resolve(SRC_DIR, 'index.ts'), 'utf-8');
const BROWSER_INDEX_SRC = readFileSync(
  resolve(SRC_DIR, 'browser-index.ts'),
  'utf-8'
);

const REMOVED_SYMBOLS = [
  'usePlatformAdaptation',
  'detectHardware',
  'ObjectPool',
  'PrometheusMetricsExporter',
  'MetricsExporter',
  'PlatformAdaptationCtx',
];

const REMOVED_FILES = [
  'wal.ts',
  'fsync.ts',
  'jsonl-append-batcher.ts',
  'file/file-watchdog.ts',
  'file/streaming-file-reader.ts',
  'file/streaming-jsonl-reader.ts',
  'node-index.ts',
  'seek-sequence.ts',
  'metrics-exporter.ts',
  'prometheus-exporter.ts',
  'object-pool.ts',
  'test/mockFactories.ts',
  'hardware-profile.ts',
  'performance-tier.ts',
  'dynamic-adaptation.ts',
  'platform-adaptation.ts',
  'use-platform-adaptation.ts',
];

const KEPT_FILES = [
  'ring-buffer.ts',
  'async-mutex.ts',
  'retry.ts',
  'file/seek-sequence.ts',
  'file/streaming-diff-parser.ts',
  'event-envelope.ts',
  'bench/ab-stats.ts',
  'bench/run-benchmarks.ts',
];

const KEPT_INDEX_EXPORTS = [
  'replaceViaSeekSequence',
  'RingBuffer',
  'retryWithBackoff',
  'appendFeed',
];

describe('桶不再导出已删死符号', () => {
  it.each(REMOVED_SYMBOLS)('index.ts 不含 %s', (symbol) => {
    expect(INDEX_SRC, `index.ts 仍在导出 ${symbol}`).not.toContain(symbol);
  });

  it.each(REMOVED_SYMBOLS)('browser-index.ts 不含 %s', (symbol) => {
    expect(
      BROWSER_INDEX_SRC,
      `browser-index.ts 仍在导出 ${symbol}`
    ).not.toContain(symbol);
  });
});

describe('被删文件不复活、保留文件仍在', () => {
  it.each(REMOVED_FILES)('%s 不存在', (relPath) => {
    expect(existsSync(resolve(SRC_DIR, relPath)), `${relPath} 已复活`).toBe(
      false
    );
  });

  it.each(KEPT_FILES)('%s 存在', (relPath) => {
    expect(existsSync(resolve(SRC_DIR, relPath)), `${relPath} 被误删`).toBe(
      true
    );
  });
});

describe('index.ts 仍导出保留符号', () => {
  it.each(KEPT_INDEX_EXPORTS)('%s 仍在', (symbol) => {
    expect(INDEX_SRC, `index.ts 丢失保留导出 ${symbol}`).toContain(symbol);
  });
});
