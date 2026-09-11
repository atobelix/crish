/**
 * local/no-silent-catch 规则单测（05 代码质量方案步骤① · 批次 7.3）。
 *
 * 以 ESLint 程序化 API 驱动真实仓库配置（overrideConfig 仅覆盖本规则的选项，
 * 与 scripts/check-swallowed-errors-frontend.mjs 同构），覆盖：
 * - 形态匹配：无绑定/有绑定空 catch、.catch(() => {}) / .catch((e) => {}) 链；
 * - 注释豁免：阶段 A（任意注释）与阶段 B（markerRequired 仅 swallow-ok）；
 * - 基线 ratchet：有条目文件 ≤ 基线放行 /> 基线拦截；无条目文件零容忍。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const RULE = 'local/no-silent-catch';
// 基线条目与 lintText 的 filePath 必须同为「相对仓库根」口径：
// 规则（eslint.config.js toRepoRelative）按 REPO_ROOT（eslint.config.js 所在目录）
// 剥离绝对路径前缀，基线 map 键为相对 posix 路径小写——FIXTURE_ABS 必须是
// REPO_ROOT 下的绝对路径（不能拼 process.cwd()，vitest cwd 是子 workspace）。
const FIXTURE_REL = 'apps/crish-desktop/src/api/zzzNoSilentCatchFixture.ts';

function locateRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, 'eslint.config.js'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`无法定位仓库根：上溯未找到 eslint.config.js（起始于 ${dir}）`);
    }
    dir = parent;
  }
}

const FIXTURE_ABS = join(locateRepoRoot(), FIXTURE_REL);

let tempDir: string;
let tempBaseline: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'no-silent-catch-test-'));
  tempBaseline = join(tempDir, 'baseline.md');
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 构造带指定规则的 ESLint 实例（仓库配置 + 本规则选项覆盖） */
function makeEslint(options: Record<string, unknown> = {}): ESLint {
  return new ESLint({
    cwd: process.cwd(),
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx,cts,mts}'],
        rules: { [RULE]: ['error', { baselineFile: tempBaseline, ...options }] },
      },
    ],
  });
}

async function lintCode(code: string, filePath = FIXTURE_ABS): Promise<number> {
  const eslint = makeEslint();
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === RULE).length;
}

function writeBaseline(entries: Array<[string, number]>): void {
  const body = entries
    .map(([p, n]) => `${p} ${n}`)
    .join('\n');
  writeFileSync(tempBaseline, `# t\n<!-- BASELINE_START -->\n${body}\n<!-- BASELINE_END -->\n`);
}

describe('local/no-silent-catch · 形态匹配', () => {
  it('无绑定空 catch 报错', async () => {
    expect(await lintCode('export function f() {\n  try { g(); } catch { }\n}\n')).toBe(1);
  });

  it('有绑定空 catch 报错', async () => {
    expect(await lintCode('export function f() {\n  try { g(); } catch (e) { }\n}\n')).toBe(1);
  });

  it('同行空 catch 报错', async () => {
    expect(await lintCode('export function f() {\n  try { g(); } catch { /* nothing */ }\n}\n')).toBe(0);
    expect(await lintCode('export function f() {\n  try { g(); } catch {}\n}\n')).toBe(1);
  });

  it('.catch(() => {}) 链报错', async () => {
    expect(await lintCode('export const p = Promise.resolve().catch(() => {});\n')).toBe(1);
  });

  it('.catch((e) => {}) 链报错', async () => {
    expect(await lintCode('export const p = Promise.resolve().catch((e) => {});\n')).toBe(1);
  });

  it('非空体（return / 日志）不报错', async () => {
    expect(
      await lintCode(
        'export function f() {\n  try { g(); } catch { return null; }\n  try { h(); } catch (e) { log(e); }\n}\n'
      )
    ).toBe(0);
  });

  it('.catch 且回调体非空不报错', async () => {
    expect(
      await lintCode('export const p = Promise.resolve().catch((e) => console.warn(e));\n')
    ).toBe(0);
  });
});

describe('local/no-silent-catch · 注释豁免（阶段 A）', () => {
  it('body 内任意注释即豁免', async () => {
    expect(await lintCode('export function f() {\n  try { g(); } catch { /* ignore */ }\n}\n')).toBe(0);
  });

  it('.catch 体内注释豁免', async () => {
    expect(
      await lintCode('export const p = Promise.resolve().catch(() => { /* swallow-ok: 测试 */ });\n')
    ).toBe(0);
  });
});

describe('local/no-silent-catch · markerRequired（阶段 B）', () => {
  it('仅 swallow-ok marker 豁免，普通注释仍报错', async () => {
    const eslint = makeEslint({ markerRequired: true });
    const cases: Array<[string, number]> = [
      ['export function f() {\n  try { g(); } catch { }\n}\n', 1],
      ['export function f() {\n  try { g(); } catch { /* ignore */ }\n}\n', 1],
      ['export function f() {\n  try { g(); } catch { /* swallow-ok: 测试原因 */ }\n}\n', 0],
    ];
    for (const [code, expected] of cases) {
      const [result] = await eslint.lintText(code, { filePath: FIXTURE_ABS });
      const n = result.messages.filter((m) => m.ruleId === RULE).length;
      expect(n).toBe(expected);
    }
  });
});

describe('local/no-silent-catch · 文件级基线 ratchet', () => {
  it('无基线条目文件零容忍', async () => {
    writeBaseline([]);
    expect(await lintCode('export function f() {\n  try { g(); } catch { }\n}\n')).toBe(1);
  });

  it('有条目文件 ≤ 基线放行', async () => {
    writeBaseline([[FIXTURE_REL, 2]]);
    expect(
      await lintCode(
        'export function f() {\n  try { a(); } catch { }\n  try { b(); } catch { }\n}\n'
      )
    ).toBe(0);
  });

  it('有条目文件 > 基线拦截（ratchet 生效）', async () => {
    writeBaseline([[FIXTURE_REL, 2]]);
    const eslint = makeEslint();
    const [result] = await eslint.lintText(
      'export function f() {\n  try { a(); } catch { }\n  try { b(); } catch { }\n  try { c(); } catch { }\n}\n',
      { filePath: FIXTURE_ABS }
    );
    const msgs = result.messages.filter((m) => m.ruleId === RULE);
    expect(msgs.length).toBe(3);
    expect(msgs[0]?.message).toContain('基线 2 处，当前 3 处');
  });

  it('基线缺失时按零容忍处理（门禁不静默放行）', async () => {
    writeBaseline([]);
    expect(await lintCode('export function f() {\n  try { g(); } catch { }\n}\n')).toBe(1);
  });
});
