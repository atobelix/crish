/**
 * CommonMark 符合度快照门槛（R1-E：R1 正确性轮·测试矩阵固化）
 *
 * 背景：R1 轮 parser 大改后，`npm run test:commonmark` 跑分通过率
 * 从 27.3% 提升至 53.2%（652 例通过 347）。本测试把该跑分结果固化
 * 为回归门槛——防止未来改动导致通过率回退而不自知。
 *
 * 快照口径（写入时的实测跑分，2026-08 基线）：
 * - 总通过数 ≥ 347（R1 轮 53.2%）；
 * - 章节级 PASS 只允许增长、不允许回退（每章一个下限）；
 * - total 恒为 652 例。
 *
 * 【提升通过率时更新快照】：
 * 当引擎功能增强使跑分结果提升时，用新的跑分更新
 * `tests/commonmark/compliance-report.json`（`npm run test:commonmark`），
 * 并把本文件底部 `SNAPSHOT_PASS_TOTAL` 与 `SECTION_SNAPSHOT` 中
 * 相关章节的 pass 值同步提升。降低任意快照值即违背门槛本意。
 *
 * 数据源：`tests/commonmark/compliance-report.json`（run-compliance.mjs
 * 的产物，入库管理）。run-compliance.mjs 的 main() 未导出且顶层执行，
 * 无法 import 复用；报告缺失时本测试回退为运行该脚本生成报告再断言。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(__dirname, '..', 'commonmark', 'compliance-report.json');
const RUN_SCRIPT = path.join(__dirname, '..', 'commonmark', 'run-compliance.mjs');

/** 总通过数快照门槛（R1 轮实测 347，见文件头说明） */
const SNAPSHOT_PASS_TOTAL = 347;

/** 章节 PASS 快照表（R1 轮实测，见文件头说明——只允许增不允许减） */
const SECTION_SNAPSHOT: Record<string, number> = {
  'Tabs': 6,
  'Precedence': 1,
  'Thematic breaks': 14,
  'ATX headings': 12,
  'Setext headings': 16,
  'Indented code': 8,
  'Fenced code': 13,
  'HTML blocks': 41,
  'Link reference definitions': 15,
  'Paragraphs': 3,
  'Blank lines': 0,
  'Block quotes': 6,
  'List items': 9,
  'Lists': 5,
  'Backslash escapes': 8,
  'Entity and numeric character references': 9,
  'Code spans': 10,
  'Emphasis and strong emphasis': 83,
  'Links': 50,
  'Images': 7,
  'Autolinks': 18,
  'Raw HTML': 6,
  'Hard line breaks': 4,
  'Soft line breaks': 0,
  'Textual content': 3,
};

/** 加载跑分报告：产物存在则直接读，缺失则运行跑分脚本生成（约数秒） */
function loadReport(): Record<string, any> {
  if (!existsSync(REPORT_PATH)) {
    execFileSync(process.execPath, [RUN_SCRIPT, '--summary'], { stdio: 'inherit' });
  }
  return JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
}

describe('CommonMark 符合度快照门槛（R1 基线）', () => {
  let report: Record<string, any>;

  beforeAll(() => {
    report = loadReport();
  });

  it('跑分报告结构完整（total/bySection/pass/fail/baseline）', () => {
    expect(report.total).toBeDefined();
    expect(report.pass).toBeDefined();
    expect(report.fail).toBeDefined();
    expect(report.bySection).toBeDefined();
    expect(report.baseline).toBeDefined();
    expect(Array.isArray(report.failIndices)).toBe(true);
  });

  it('用例总数恒为 652（CommonMark 0.31.2 全量）', () => {
    expect(report.total).toBe(652);
  });

  it(`总通过数 ≥ ${SNAPSHOT_PASS_TOTAL}（当前 ${SNAPSHOT_PASS_TOTAL}/652）——提升通过率时更新快照`, () => {
    expect(report.pass).toBeGreaterThanOrEqual(SNAPSHOT_PASS_TOTAL);
  });

  it('pass + fail == total（跑分口径自洽）', () => {
    expect(report.fail).toBe(report.total - report.pass);
  });

  it('章节快照全覆盖：快照表中每一章都存在于报告内', () => {
    for (const sec of Object.keys(SECTION_SNAPSHOT)) {
      expect(report.bySection[sec], `章节缺失：${sec}`).toBeDefined();
    }
  });

  it('章节 PASS 只允许增不允许减（逐章对比快照表）', () => {
    for (const [sec, snapshotPass] of Object.entries(SECTION_SNAPSHOT)) {
      const actual = report.bySection[sec].pass;
      expect(
        actual,
        `章节 ${sec} 通过数 ${actual} 回退至快照值 ${snapshotPass} 以下——` +
          '禁止回归；提升通过率时更新快照'
      ).toBeGreaterThanOrEqual(snapshotPass);
    }
  });

  it('章节 PASS 与总通过数口径一致（分章节求和 == 总通过数）', () => {
    const sum = Object.values(report.bySection).reduce(
      (acc: number, s: any) => acc + s.pass,
      0
    );
    expect(sum).toBe(report.pass);
  });
});
