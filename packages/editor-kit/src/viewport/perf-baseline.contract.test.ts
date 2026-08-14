/**
 * A-PERF baseline 文档断言（**W6-C-S** · Skeleton）
 *
 * 读 `docs/block-workspace-architecture/plans/acceptance/perf-baseline.md`，
 * 可证伪地钉死：
 * - 轨 ID 必须是 **W6-C-S**（Skeleton），不得裸写「入库 Wave | W6-C」冒充数值门
 * - 结构常量 512 / 12 / 256 与 `bounds.ts` 一致
 * - 机器指纹仍为「待本机标定」占位
 * - 数值表含 **TBD（未标定）**；禁止「数值门通过 / EL-03 关闭」假完成句
 *
 * **≠ W6-C** Strict（标定初值入库）  
 * **≠ EL-03** 关闭  
 * **TBD 数值 ≠ 通过**
 *
 * 权威：`plans/09` W6-C-S；`plans/08` 性能两阶段；H3 / perf-governance
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_HOT_YTEXT,
  DEFAULT_OVERSCAN_BLOCKS,
  MAX_MOUNTED_DOM_BLOCKS,
  OVERSCAN_BLOCKS_MAX,
  OVERSCAN_BLOCKS_MIN,
} from './bounds';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/editor-kit/src/viewport → 仓库根 */
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const BASELINE_PATH = join(
  REPO_ROOT,
  'docs',
  'block-workspace-architecture',
  'plans',
  'acceptance',
  'perf-baseline.md'
);

function loadBaseline(): string {
  expect(existsSync(BASELINE_PATH), `缺少 baseline：${BASELINE_PATH}`).toBe(
    true
  );
  return readFileSync(BASELINE_PATH, 'utf8');
}

/** 抽取「| **字段** | 值 |」表单元格中的值列（首个非空数据格） */
function metaValue(md: string, fieldLabel: string): string | null {
  const re = new RegExp(
    `\\|\\s*\\*\\*${fieldLabel}\\*\\*\\s*\\|\\s*([^|]+)\\|`,
    'i'
  );
  const m = md.match(re);
  const val = m?.[1];
  return val ? val.trim() : null;
}

describe('W6-C-S · perf-baseline 文档断言', () => {
  it('文件存在且钉轨 W6-C-S（Skeleton）', () => {
    const md = loadBaseline();

    // 标题 / 轨声明必须显式 W6-C-S
    expect(md).toMatch(/W6-C-S/);
    expect(md).toMatch(/\*\*W6-C-S\*\*/);
    expect(md).toMatch(/Skeleton/);

    // 入库 Wave 必须显式 W6-C-S（可附注数值归 W6-C Strict）
    const wave = metaValue(md, '入库 Wave');
    expect(wave, '元数据须含 入库 Wave').toBeTruthy();
    expect(wave!).toMatch(/W6-C-S/);
    // 当前交付轨必须是 Skeleton 包号
    expect(md).toMatch(/\*\*当前交付轨\*\*[\s\S]{0,80}\*\*W6-C-S\*\*/);

    // 诚实边界句必须在文档中（可证伪）
    expect(md).toMatch(/明确 ≠[\s\S]{0,40}EL-03|≠ EL-03/);
    expect(md).toMatch(/明确 ≠[\s\S]{0,40}\*\*W6-C\*\*|≠ W6-C/);
    expect(md).toMatch(/TBD.*≠.*通过|TBD（未标定）/);
  });

  it('结构常量与 bounds.ts 一致（512 / 12 / 256）', () => {
    const md = loadBaseline();

    // 代码侧硬值
    expect(DEFAULT_MAX_HOT_YTEXT).toBe(512);
    expect(DEFAULT_OVERSCAN_BLOCKS).toBe(12);
    expect(MAX_MOUNTED_DOM_BLOCKS).toBe(256);
    expect(OVERSCAN_BLOCKS_MIN).toBe(8);
    expect(OVERSCAN_BLOCKS_MAX).toBe(20);
    expect(MAX_MOUNTED_DOM_BLOCKS).toBeLessThanOrEqual(DEFAULT_MAX_HOT_YTEXT);

    // 文档 §5 对照表必须写出同值（防文档与代码漂移）
    expect(md).toMatch(/DEFAULT_MAX_HOT[\s\S]{0,40}`512`/);
    expect(md).toMatch(/DEFAULT_OVERSCAN_BLOCKS[\s\S]{0,40}`12`/);
    expect(md).toMatch(/MAX_MOUNTED_DOM_BLOCKS[\s\S]{0,40}`256`/);
    expect(md).toMatch(/OVERSCAN_BLOCKS_MIN[\s\S]{0,20}`8`/);
    expect(md).toMatch(/默认 overscan \*\*12\*\*/);
    expect(md).toMatch(/MAX_MOUNTED_DOM_BLOCKS = 256/);
  });

  it('机器指纹仍为占位；数值表含 TBD（未标定）且无假通过句', () => {
    const md = loadBaseline();

    // §1 指纹占位
    const fingerprintHits = md.match(/待本机标定/g) ?? [];
    expect(
      fingerprintHits.length,
      '§1 机器指纹须保留「待本机标定」占位（W6-C-S 不要求填齐）'
    ).toBeGreaterThanOrEqual(4);

    // 数值门 TBD
    const tbdHits = md.match(/TBD（未标定）/g) ?? [];
    expect(
      tbdHits.length,
      '§3 数值表须保留多处 TBD（未标定）；W6-C-S 完成时不得清空'
    ).toBeGreaterThanOrEqual(6);

    // 标定状态列
    expect(md).toMatch(/\| 未标定\s*\|/);

    // 状态元数据须声明数值未标定
    const status = metaValue(md, '状态');
    expect(status, '元数据须含 状态').toBeTruthy();
    expect(status!).toMatch(/未标定|TBD/);
    expect(status!).toMatch(/W6-C-S/);

    // 禁止肯定式假完成句（允许「禁止…数值门通过」等否定语境）
    const lines = md.split(/\r?\n/);
    const claimRe =
      /(?:状态|结论|验收).{0,24}(?:数值门|PERF|EL-03).{0,16}(?:已)?(?:通过|关闭|绿灯)/;
    const positiveClaims = lines.filter((line) => {
      if (/(禁止|不得|≠|非|未|勿|禁)/.test(line)) return false;
      return claimRe.test(line);
    });
    expect(
      positiveClaims,
      `禁止肯定式假完成句，命中：${positiveClaims.join(' | ')}`
    ).toEqual([]);

    // rev 仍可为 0（未做数值标定 bump）
    const rev = metaValue(md, 'perf_baseline_rev');
    expect(rev).toBeTruthy();
    expect(rev!).toMatch(/^`?0`?$/);
  });

  it('结构 checklist §2.2 存在且契约门项保持未勾', () => {
    const md = loadBaseline();

    expect(md).toMatch(/## 2\.2 结构门验收清单/);
    // 有证据项应已勾（至少一项 [x]）
    expect(md).toMatch(/- \[x\].*DEFAULT_MAX_HOT/);
    expect(md).toMatch(/- \[x\].*MAX_MOUNTED_DOM_BLOCKS|queryViewport/);
    expect(md).toMatch(/- \[x\].*fullRemountCount/);
    // 契约门未接线测必须保持 [ ]
    expect(md).toMatch(/- \[ \].*A-PERF-09|每键全量 snapshot/);
    expect(md).toMatch(/- \[ \].*A-PERF-06|不阻塞 UI 主线程/);
  });

  it('§2.3 指向本契约测路径（自指可复核）', () => {
    const md = loadBaseline();
    expect(md).toMatch(/perf-baseline\.contract\.test\.ts/);
  });
});
