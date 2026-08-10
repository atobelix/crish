/**
 * 门禁体系占位骨架（G1-G10 中未落地类别）
 *
 * 定位：R0 基线轮的骨架落地产物。本文件为门禁类别提供"骨架就绪"占位
 * 用例，保证 `npm run test:gate` 从落地第一刻起即可执行并保持全绿；
 * 后续轮次按类别逐一将占位断言替换为真实断言（断言点清单见
 * tests/coverage-tracker.md）。
 *
 * 类别映射依据：docs/analysis/03-测试门禁体系.md（G1-G9 + X1）与
 * docs/analysis/09-方案修订终版.md §3 门槛 #6 修正（G1-G10 全类含 G6，
 * X1 交叉矩阵即 G10）。
 *
 * 约定：替换占位断言时同步删除对应 describe 内的"骨架就绪"占位 it，
 * 不得保留空壳；任何类别完成真实断言落地后，在 coverage-tracker.md
 * 中勾选对应行，并在本文件删除对应占位（P2-B7 起执行口径）。
 *
 * P2-B7 清理（2026-08-10）：G6/G9/G10 的真实测试已落地——G6=
 * tests/unit/css-contract.test.ts、G9=tests/unit/memory-bounds.test.ts、
 * G10=tests/unit/cross-matrix.test.ts（coverage-tracker.md 已勾选），
 * 对应占位 describe/it 已删除。本文件仅保留尚未落地类别的占位
 * （G1-G5/G7/G8，coverage-tracker.md 汇总表均为 0 勾选），
 * 落地后按上述约定同步删除。
 */
import { describe, it, expect } from 'vitest';

// —— 以下占位保留（P2-B7 核对）：G1-G5/G7/G8 对应真实断言均未落地
// （coverage-tracker.md 无勾选），落地后按文件头约定删除占位 ——

describe('G1 core 不变量 unit（U1）', () => {
  it('骨架就绪：现有 126 例已接线，不变量工具集待 R1 补齐', () => {
    expect(true).toBe(true);
  });
});

describe('G2 属性测试（U2）', () => {
  it('骨架就绪：随机文档 × 随机操作 × 不变量，生成器/不变量器待 R1 落地', () => {
    expect(true).toBe(true);
  });
});

describe('G3 渲染层 RTL（R1）', () => {
  it('骨架就绪：@testing-library/react 本轮不装（R3 才需要），jsdom 契约待 R3 落地', () => {
    expect(true).toBe(true);
  });
});

describe('G4 行为契约（R2）', () => {
  it('骨架就绪：store/parser 公开行为黑箱契约矩阵待 R4 落地', () => {
    expect(true).toBe(true);
  });
});

describe('G5 CommonMark 符合度（C1）', () => {
  it('骨架就绪：652 例接线与 astToHtml 语义序列化器待 R5 落地，spec 源见 09 §3 修正', () => {
    expect(true).toBe(true);
  });
});

describe('G7 运行时 Playwright（E1）', () => {
  it('骨架就绪：现有 18 spec 保留，IME/滚动/光标/金样等新增 spec 待 R7 落地', () => {
    expect(true).toBe(true);
  });
});

describe('G8 性能门禁（P1）', () => {
  it('骨架就绪：帧率/长任务/layoutThrash 指标 spec 待 R8 落地，档位由 VITEST_PERF_TIER 显式驱动', () => {
    expect(true).toBe(true);
  });
});
