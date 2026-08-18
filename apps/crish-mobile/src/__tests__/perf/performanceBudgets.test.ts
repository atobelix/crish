// 性能预算断言测试（R2-15 部分 2 / AU5 Top7：性能预算断言机制落地）
// 预算真源：R2-ux-best-practice.md §5（性能预算表）/ F3-event-stream-terminal.md §3.4、§4.0
// 断言面：纯函数/数据面（jest 可断言）——feed 批量 ingest（100 条/秒语义）、
//         终端 5000 行环形、事件映射 49 类全量、LRU 128 层缓存。
// 渲染帧率类（100 条/秒不掉帧、60fps 滚动）需真机测量工具，不在本文件断言（文档注记）。
//
// 断言风格：宽松上限（防 CI 抖动误报）+「性能回归粗筛」——阈值 = 实测基线 × 3~5 倍，
//           只拦截数量级回归（如误引入 O(n²) 路径），不追求精确预算数值。
// 测量口径：多次测量取最小值（JIT 预热后 min 对单次调度停顿免疫）。
import {
  appendFeed,
  createWindow,
  hydrateFeed,
  type EventEnvelopeFrame,
  type EventWindow,
} from '@/domain/store/eventReducers';
import {
  appendTerminalChunk,
  createTerminalLineBuffer,
  replaceAllTerminalText,
} from '@/presentation/components/terminal/terminalLineBuffer';
import { mapDeviceFrame, mapIngestFrame } from '@/domain/store/eventMappers';
import { createLruCache } from '@/domain/store/filesCache';
import { ENGINE_EVENT_TYPES } from '@crish/shared-types';

// ── 计时与测量助手 ─────────────────────────────────────────────────────────

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** 多次测量取最小值（JIT 预热 + min 口径，CI 抖动免疫） */
function measureMinMs(fn: () => void, rounds = 3): number {
  fn(); // JIT 预热：首轮不计费
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rounds; i += 1) {
    const t0 = now();
    fn();
    const elapsed = now() - t0;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/** 构造事件帧（49 类全量映射夹具同构：扁平信封 + sequence） */
function frameOf(seq: number, type = 'tool-start'): EventEnvelopeFrame {
  return {
    type,
    sessionId: 'perf-session',
    runId: 'perf-run',
    sequence: seq,
  };
}

/** 构造窗口 + 预填 N 条（hydrate 口径） */
function windowWith(frames: readonly EventEnvelopeFrame[]): EventWindow {
  const w = createWindow();
  hydrateFeed(w, frames, frames.length, 0);
  return w;
}

// ── 预算常量（阈值 = 2026-08-13 本机实测基线 × 3~5 倍，见 R2-15 报告 §8.2） ──
// 基线（isolated 运行 min-of-3）：hydrate 1000 条 ≈84ms / append 1000 条 ≈75ms /
// dedup 1000 条 ≈79ms / 终端 5000 行 ≈5ms / 满环再灌 1000 行 ≈16ms /
// replaceAll 5000 行 ≈9ms / 映射 49×2000 轮 ≈3ms / push 20000 次 ≈11ms / LRU 200k 次 ≈15ms
// 全量套件并行负载下 feed 面实测上浮至 ≈180-200ms——阈值按 ×3~5 吸收（350-500ms）。
// 微秒级路径（映射/终端/LRU）基线位于计时分辨率下限（<16ms），阈值按 ×10 级放宽，
// 仅作「数量级回归哨兵」；如 CI 首次运行误报，先复核基线再微调（诚实纪律注记）。

/** feed 批量追平 1000 条（10 秒 @100 条/秒 的快照重建；对齐 R2UX §5.3 首帧 ≤500ms） */
const BUDGET_FEED_HYDRATE_1000_MS = 500;
/** feed 逐条追加 1000 条（100 条/秒实时流 10 秒） */
const BUDGET_FEED_APPEND_1000_MS = 450;
/** feed 去重重放 1000 条（seq ≤ 游标 → duplicate 路径） */
const BUDGET_FEED_DEDUP_1000_MS = 350;
/** 终端 5000 行写入（满环形） */
const BUDGET_TERMINAL_5000_LINES_MS = 50;
/** 终端满环形后再灌 1000 行（环形裁剪 splice 压力） */
const BUDGET_TERMINAL_RING_TRIM_1000_MS = 100;
/** 终端 replaceAll 终值重建 5000 行 */
const BUDGET_TERMINAL_REPLACE_ALL_5000_MS = 50;
/** 事件映射 49 类 × 2000 轮全量（9.8 万次映射，基线 ~5ms） */
const BUDGET_MAP_ALL_49_2000R_MS = 50;
/** 设备帧 events.push 映射 20000 次（基线 ~10ms） */
const BUDGET_MAP_DEVICE_PUSH_20000_MS = 50;
/** LRU 128 层：预填 128 + 混合 get/set 200000 次（基线 ~12ms） */
const BUDGET_LRU_128_200K_OPS_MS = 50;

describe('性能预算：feed 批量 ingest（R2UX-05-01 100 条/秒数据面）', () => {
  it('hydrateFeed 批量追平 1000 条 < 预算（性能回归粗筛）', () => {
    const frames = Array.from({ length: 1000 }, (_, i) => frameOf(i + 1));
    const elapsed = measureMinMs(() => {
      const w = createWindow();
      hydrateFeed(w, frames, frames.length, 0);
    });
    expect(elapsed).toBeLessThan(BUDGET_FEED_HYDRATE_1000_MS);
  });

  it('appendFeed 逐条追加 1000 条（含环形 500 裁剪）< 预算（性能回归粗筛）', () => {
    const elapsed = measureMinMs(() => {
      const w = createWindow();
      for (let i = 1; i <= 1000; i += 1) {
        appendFeed(w, frameOf(i), false, i);
      }
    });
    expect(elapsed).toBeLessThan(BUDGET_FEED_APPEND_1000_MS);
  });

  it('去重重放 1000 条（seq ≤ 游标 → duplicate 路径）< 预算（性能回归粗筛）', () => {
    const w = windowWith(Array.from({ length: 500 }, (_, i) => frameOf(i + 1)));
    const elapsed = measureMinMs(() => {
      for (let i = 1; i <= 1000; i += 1) {
        appendFeed(w, frameOf(i), false, i);
      }
    });
    expect(elapsed).toBeLessThan(BUDGET_FEED_DEDUP_1000_MS);
  });
});

describe('性能预算：终端 5000 行环形（R2UX-05-07 / F3 §4.0）', () => {
  const LINE_80 = 'x'.repeat(80);

  it('写入 5000 行（每行 80 字符，满环形）< 预算（性能回归粗筛）', () => {
    const chunk = Array.from({ length: 5000 }, () => `${LINE_80}\n`).join('');
    const elapsed = measureMinMs(() => {
      const state = createTerminalLineBuffer();
      appendTerminalChunk(state, chunk);
    });
    expect(elapsed).toBeLessThan(BUDGET_TERMINAL_5000_LINES_MS);
  });

  it('满环形后继续灌 1000 行（环形裁剪 splice 压力）< 预算（性能回归粗筛）', () => {
    const chunk = Array.from({ length: 6000 }, () => `${LINE_80}\n`).join('');
    const elapsed = measureMinMs(() => {
      const state = createTerminalLineBuffer();
      appendTerminalChunk(state, chunk);
    });
    expect(elapsed).toBeLessThan(BUDGET_TERMINAL_RING_TRIM_1000_MS);
  });

  it('replaceAll 终值重建 5000 行 < 预算（性能回归粗筛）', () => {
    const fullText = Array.from(
      { length: 5000 },
      (_, i) => `line-${i} ${LINE_80}\n`
    ).join('');
    const elapsed = measureMinMs(() => {
      const state = createTerminalLineBuffer();
      replaceAllTerminalText(state, fullText);
    });
    expect(elapsed).toBeLessThan(BUDGET_TERMINAL_REPLACE_ALL_5000_MS);
  });
});

describe('性能预算：事件映射 49 类全量（R2-05a 49/49 覆盖）', () => {
  it('mapIngestFrame 49 类 × 2000 轮全量 < 预算（性能回归粗筛）', () => {
    const elapsed = measureMinMs(() => {
      for (let round = 0; round < 2000; round += 1) {
        for (const type of ENGINE_EVENT_TYPES) {
          mapIngestFrame(
            { type, sessionId: 'perf-session', runId: 'perf-run', sequence: 1 },
            false
          );
        }
      }
    });
    expect(elapsed).toBeLessThan(BUDGET_MAP_ALL_49_2000R_MS);
  });

  it('mapDeviceFrame events.push 全路径 20000 次 < 预算（性能回归粗筛）', () => {
    const elapsed = measureMinMs(() => {
      for (let i = 0; i < 20_000; i += 1) {
        mapDeviceFrame({
          kind: 'events.push',
          body: {
            sessionId: 'perf-session',
            preview: false,
            event: {
              type: 'tool-update',
              sessionId: 'perf-session',
              sequence: i,
            },
          },
        });
      }
    });
    expect(elapsed).toBeLessThan(BUDGET_MAP_DEVICE_PUSH_20000_MS);
  });
});

describe('性能预算：LRU 128 层缓存（R2UX-06-01 目录缓存数据面）', () => {
  it('预填 128 层 + 混合 get/set 200000 次 < 预算（性能回归粗筛）', () => {
    const elapsed = measureMinMs(() => {
      const cache = createLruCache<string, string>(128);
      for (let i = 0; i < 128; i += 1) {
        cache.set(`k${i}`, `v${i}`);
      }
      for (let i = 0; i < 200_000; i += 1) {
        const key = `k${i % 128}`;
        if (cache.get(key) === undefined) {
          cache.set(key, `v${i}`);
        }
      }
    });
    expect(elapsed).toBeLessThan(BUDGET_LRU_128_200K_OPS_MS);
  });
});
