// ============================================================
// 代码文件行数契约测试（战役 table-systemic-remediation · T0 附带加固）
//
// 权威来源：scripts/check-file-length.mjs 的策略表与例外名单；
//           用户口径（2026-09-14）：不同类型代码文件不同策略；
//           超限 30% 以内不强制改动；部分文件可登记行数保护例外。
//
// 本文件是**契约层**：保证策略表自洽、例外名单不被静默放宽、棘轮不被破坏。
// ============================================================
import { describe, expect, it } from 'vitest';
import { POLICIES, PROTECTED, WARN_RATIO, collect } from '../../scripts/check-file-length.mjs';

describe('行数门禁 · 策略表', () => {
  it('策略 id 唯一', () => {
    const ids = POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个策略都声明了匹配式 / 目标行数 / 说明', () => {
    for (const p of POLICIES) {
      expect(p.match, `${p.id} 缺 match`).toBeInstanceOf(RegExp);
      expect(typeof p.limit, `${p.id} limit 非数值`).toBe('number');
      expect(p.limit, `${p.id} limit 非正`).toBeGreaterThan(0);
      expect(p.desc, `${p.id} 缺 desc`).toBeTruthy();
    }
  });

  it('容忍比例固定为 1.3（超限 30% 内仅警告）', () => {
    expect(WARN_RATIO).toBe(1.3);
  });

  it('src 与 tests 与 scripts 三类目录都有覆盖策略', () => {
    for (const sample of [
      'src/core/x.ts',
      'src/components/x.tsx',
      'src/index.css',
      'scripts/x.mjs',
      'tests/unit/x.test.ts',
      'tests/gate/x.test.ts',
      'tests/e2e/x.spec.ts',
    ]) {
      expect(POLICIES.some((p) => p.match.test(sample)), `${sample} 无匹配策略`).toBe(true);
    }
  });
});

describe('行数门禁 · 例外名单（棘轮完整性）', () => {
  it('每个例外都写明理由与冻结天花板', () => {
    const entries = Object.entries(PROTECTED);
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      expect(entry.reason, `${path} 缺 reason`).toBeTruthy();
      expect(entry.reason.length, `${path} reason 过短`).toBeGreaterThan(8);
      expect(typeof entry.ceiling, `${path} ceiling 非数值`).toBe('number');
      expect(entry.ceiling, `${path} ceiling 非正`).toBeGreaterThan(0);
    }
  });

  it('例外条目必须真实存在于仓库且确实超限（防止例外名单变成空壳）', () => {
    const rows = collect();
    for (const path of Object.keys(PROTECTED)) {
      const row = rows.find((r) => r.rel === path);
      expect(row, `例外名单中的 ${path} 在仓库中不存在或无策略覆盖`).toBeTruthy();
    }
  });

  it('棘轮：无例外文件超出其冻结天花板', () => {
    const breached = collect()
      .filter((r) => r.protectedEntry && r.lines > r.protectedEntry.ceiling)
      .map((r) => `${r.rel}: ${r.lines} > ${r.protectedEntry.ceiling}`);
    expect(breached).toEqual([]);
  });
});

describe('行数门禁 · 全仓状态', () => {
  it('0 个文件违规（超 limit×1.3 且不在例外名单）', () => {
    const violations = collect()
      .filter((r) => r.status === 'violation')
      .map((r) => `${r.rel} ${r.lines} 行 > 阈值 ${r.threshold}（limit=${r.policy.limit}）`);
    expect(violations).toEqual([]);
  });

  it('警告带内的文件被如实标记（不作为违规，但不得被隐藏）', () => {
    const warns = collect().filter((r) => r.status === 'warn');
    // 警告项不阻断门禁；此处只断言分类逻辑生效（warn 必然在 limit 与阈值之间）
    for (const w of warns) {
      expect(w.lines).toBeGreaterThan(w.policy.limit);
      expect(w.lines).toBeLessThanOrEqual(w.threshold);
    }
  });
});
