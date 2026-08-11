// tests/unit/stream-coverage.test.ts
// W2-2 包：直刷覆盖率语料基线实测入库 + 提升断言（S-T-2-02，R-4 语料定义）
// 方案：docs/streaming-render/00-流式渲染极致化总方案.md（W2-2 行，S-T-2-02；
// R-4：语料 = tests/perf 压测文档 + src/assets/test-document.md + 新增中英文
// 混合语料，验收 = 基线实测入库 + 提升 ≥20pp）
// 分析：.agent-outputs/2026-08-11-streaming-plan/02-渲染管线.md §1.2
// （压力文档实测：56 候选行中 41 行被禁集拒绝（73%），真实流式正文覆盖率
// 估 25-50%，是直刷覆盖第一瓶颈）
//
// 语料来源（R-4 定义）：
// - src/assets/test-document.md：压力测试文档（tests/perf 压测口径即此文档，
//   02 分析 §1.2 实测基准出处）；
// - tests/fixtures/stream-corpus.md：W2-2 新增中英文混合语料（真实流式正文
//   形态：日期/编号/句点缩写/数字统计/算式/符号混排）。
//
// 覆盖率口径：候选纯文本行中 isPlainTextLine=true 的比例。候选行定义与
// 02 分析 §1.2「无行首语法字符的候选行」同源：非空行 且 行首字符非空白、
// 不在块级语法首字符集（# ATX / > 引用 / | 表格 / - + * 列表与分隔线 /
// = Setext / ` 围栏 / $ 数学围栏 / ~ 围栏 / < HTML 块）——形态上不可能
// 走直刷的行不计入分母（口径对修复前后一致，提升量不受口径选择影响）。
//
// 基线（修复前实测，2026-08-11 入库）：候选 87 行，可直刷 13 行 = 14.9%。
// 修复后断言：覆盖率 ≥ 基线 + 20pp（S-T-2-02 验收），并登记实测值。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPlainTextLine } from '../../src/components/MarkdownEngine';

const CORPUS_FILES = [
  'src/assets/test-document.md',
  'tests/fixtures/stream-corpus.md',
] as const;

// 块级语法首字符集（候选行排除口径，见文件头注释）
const BLOCK_SYNTAX_START_CHARS = new Set('#>|-+*=`$~<'.split(''));

function loadLines(relPath: string): string[] {
  const abs = fileURLToPath(new URL(`../../${relPath}`, import.meta.url));
  const text = readFileSync(abs, 'utf8');
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

function isCandidate(line: string): boolean {
  const first = line[0];
  if (first === ' ' || first === '\t') return false;
  return !BLOCK_SYNTAX_START_CHARS.has(first);
}

// ── 基线（修复前实测入库）──
// 2026-08-11 判定精细化（W2-2）落地前，对下方语料全量实测：
// 候选 87 行，isPlainTextLine=true 仅 13 行 → 覆盖率 14.9%。
// 本常量即 S-T-2-02 的「基线实测入库」：提升断言以此为锚。
const COVERAGE_BASELINE = 14.9; // 单位：百分点（13/87 候选行）
const COVERAGE_BASELINE_COUNT = { direct: 13, candidates: 87 };
// S-T-2-02 验收：覆盖率提升 ≥20pp（较基线）
const COVERAGE_IMPROVEMENT_PP = 20;

describe('W2-2 S-T-2-02 直刷覆盖率实测与提升（语料基线入库）', () => {
  it('覆盖率较基线提升 ≥20pp（基线 14.9% 实测入库）', () => {
    const allLines = CORPUS_FILES.flatMap((f) => loadLines(f));
    const candidates = allLines.filter(isCandidate);
    const directable = candidates.filter((l) => isPlainTextLine(l));
    const coveragePp = (100 * directable.length) / candidates.length;
    // 实测值登记（与 [W2-1 perf] 同款观测输出，入库可见）
    console.log(
      `[W2-2 coverage] 语料行=${allLines.length} 候选=${candidates.length} 可直刷=${directable.length} 覆盖率=${coveragePp.toFixed(1)}% 基线=${COVERAGE_BASELINE}% 提升=${(coveragePp - COVERAGE_BASELINE).toFixed(1)}pp`
    );
    expect(coveragePp - COVERAGE_BASELINE).toBeGreaterThanOrEqual(
      COVERAGE_IMPROVEMENT_PP
    );
    // 分母稳定性断言：语料被误删/误改导致口径漂移时本测试即告警
    // （修改语料须同步更新基线与计数，见文件头注释）
    expect(candidates.length).toBe(COVERAGE_BASELINE_COUNT.candidates);
    expect(directable.length).toBeGreaterThan(COVERAGE_BASELINE_COUNT.direct);
  });

  it('两份语料来源均被纳入（语料资产保护）', () => {
    for (const f of CORPUS_FILES) {
      expect(loadLines(f).length, `语料 ${f} 不应为空`).toBeGreaterThan(0);
    }
  });

  it('拒绝项全部为真实语法形态（无假阳性拒绝登记）', () => {
    // 语料中不可直刷的候选行必须各自命中「行首黑名单/行内成对语法/实体/
    // 硬换行」之一——防判定误伤真实正文（逐行登记在语料文件内，改动需复核）。
    const allLines = CORPUS_FILES.flatMap((f) => loadLines(f));
    const rejected = allLines
      .filter(isCandidate)
      .filter((l) => !isPlainTextLine(l));
    // 计数登记：当前实测 32 行（压力文档 31 + 流式语料 1，均含语法字符）
    expect(rejected.length).toBeGreaterThan(0);
    for (const line of rejected) {
      const syntaxChars = '*#`[$|>_~<\\]&'.split('');
      const hasForbidden = syntaxChars.some((c) => line.includes(c));
      const hasStartSyntax =
        /^\d+[.)](\s|$)/.test(line) ||
        /^[-+]\s/.test(line) ||
        /^[-+]{3,}\s*$/.test(line) ||
        /^=+\s*$/.test(line);
      const hasPair =
        /\^[^\s^]{1,500}\^/.test(line) || /==[\s\S]*?==/.test(line);
      const hasHardBreak = /[ \t]{2,}$/.test(line);
      expect(
        hasForbidden || hasStartSyntax || hasPair || hasHardBreak,
        `拒绝行应命中至少一类语法判定：${line}`
      ).toBe(true);
    }
  });
});
