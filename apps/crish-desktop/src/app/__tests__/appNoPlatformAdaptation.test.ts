/**
 * 启动期硬件探测拆除的回归锁。
 *
 * App 不再接入 PlatformAdaptationCtx / usePlatformAdaptation，也不再写 data-perf-level；
 * 同时锁住 App 自身的关键接线（useAppBootstrap、AppMotionProvider），防止把 App 掏空。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const APP_TSX = readFileSync(resolve(__dirname_, '../../App.tsx'), 'utf-8');

const REMOVED_SYMBOLS = [
  'usePlatformAdaptation',
  'PlatformAdaptationCtx',
  'data-perf-level',
  'detectHardware',
  'applyRenderAdaptation',
  '@crish/shared-utils/browser',
];

const KEPT_SYMBOLS = ['useAppBootstrap', 'AppMotionProvider'];

describe('App 不再接入平台适配引擎', () => {
  it.each(REMOVED_SYMBOLS)('App.tsx 不含 %s', (symbol) => {
    expect(APP_TSX, `App.tsx 仍引用 ${symbol}`).not.toContain(symbol);
  });

  it.each(KEPT_SYMBOLS)('App.tsx 仍包含 %s', (symbol) => {
    expect(APP_TSX, `App.tsx 丢失关键接线 ${symbol}`).toContain(symbol);
  });
});
