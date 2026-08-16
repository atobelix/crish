/**
 * W3-G · PaperList 仅窗口 DOM 结构门（jsdom）。
 *
 * ## 轨声明（诚实）
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | 仅窗口∪pin 进 DOM；窗外真 remove | **EL-01** / A-BLK 全表 e2e |
 * | mountedCount ≤ MAX_MOUNTED_DOM_BLOCKS | A-PERF **数值**门（TTI/p95） |
 * | 假数据 silentFixture 可驱动列表 | 假数据列表 = 权威树 / 写盘完成 |
 * | MountSpec 形状可消费 | W3-P WindowManager / A-IME-07 输入会话关闭 |
 *
 * **≠** EL-01；**≠** A-PERF 数值；**≠** 权威树。
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ESTIMATE_PX,
  DEFAULT_OVERSCAN_BLOCKS,
  HeightMap,
  MAX_MOUNTED_DOM_BLOCKS,
} from '@crish/editor-kit';
import { createSilentFixture, listSilentBlocks } from '../chrome/silentFixture';
import {
  buildMountPlanByScroll,
  buildMountPlanByWindow,
} from './buildMountPlan';
import { resolvePaperHeadingLevel } from './paperListReconcile';
import {
  PaperList,
  isPaperList,
  BP_PAPER_BLOCK,
  BP_PAPER_LIST,
  BP_PAPER_MOUNTED_COUNT,
  BP_PAPER_TOTAL_COUNT,
  BP_PAPER_SPACER_BEFORE,
  BP_PAPER_SPACER_AFTER,
} from './PaperList';

const LIST_DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : import.meta.url.startsWith('file:')
      ? dirname(fileURLToPath(import.meta.url))
      : resolve(process.cwd(), 'packages/block-paper/src/list');

function requireDocument(): Document {
  if (typeof document === 'undefined' || !document.createElement) {
    throw new Error('jsdom document 不可用');
  }
  return document;
}

// ---------------------------------------------------------------------------
// buildMountPlan 纯函数
// ---------------------------------------------------------------------------

describe('W3-G · buildMountPlan 纯函数', () => {
  it('w3g_plan_window_subset: 大文档仅窗口∪overscan 进 mountIds', () => {
    const n = 10_000;
    const order = Array.from({ length: n }, (_, i) => `b-${i}`);
    const plan = buildMountPlanByWindow({
      order,
      window: { startIndex: 100, endIndex: 120 },
      overscan: 8,
    });

    // 100-8 … 120+8 → [92, 128)
    expect(plan.viewport.startIndex).toBe(92);
    expect(plan.viewport.endIndex).toBe(128);
    expect(plan.mountedCount).toBe(128 - 92);
    expect(plan.totalCount).toBe(n);
    expect(plan.mountedCount).toBeLessThan(n);
    expect(plan.withinDomBound).toBe(true);
    expect(plan.maxMountedDomBlocks).toBe(MAX_MOUNTED_DOM_BLOCKS);
    expect(plan.mountIds[0]).toBe('b-92');
    expect(plan.mountIds[plan.mountIds.length - 1]).toBe('b-127');
    // 窗外 id 不得出现
    expect(plan.mountIds).not.toContain('b-0');
    expect(plan.mountIds).not.toContain('b-9999');
  });

  it('w3g_plan_pin_outside_window: 窗外 pin 并入 mountIds', () => {
    const order = Array.from({ length: 200 }, (_, i) => `b-${i}`);
    const plan = buildMountPlanByWindow({
      order,
      window: { startIndex: 50, endIndex: 60 },
      overscan: 0,
      focusId: 'b-10',
      composingIds: ['b-190'],
    });

    expect(plan.mountIds).toContain('b-50');
    expect(plan.mountIds).toContain('b-10');
    expect(plan.mountIds).toContain('b-190');
    expect(plan.mountSpec.pinned).toEqual(
      expect.arrayContaining(['b-10', 'b-190'])
    );
    expect(plan.mountedCount).toBe(10 + 2); // 窗口 10 + 两 pin
  });

  it('w3g_plan_structure_bound: mount 上界常量可证伪', () => {
    const order = Array.from({ length: 5000 }, (_, i) => `x-${i}`);
    const plan = buildMountPlanByWindow({
      order,
      window: { startIndex: 0, endIndex: 40 },
      overscan: DEFAULT_OVERSCAN_BLOCKS,
    });
    expect(plan.mountedCount).toBeLessThanOrEqual(MAX_MOUNTED_DOM_BLOCKS);
    expect(plan.withinDomBound).toBe(true);
  });

  it('w3g_plan_scroll_heightmap: scroll 路径走 indexAt 非像素测距', () => {
    const n = 1000;
    const order = Array.from({ length: n }, (_, i) => `s-${i}`);
    const hm = new HeightMap(n, 20);
    for (let i = 0; i < n; i++) hm.bindId(i, order[i]!);

    const plan = buildMountPlanByScroll({
      order,
      scrollTop: 400, // → index 20
      viewportHeight: 200, // → +10 块 → end 附近
      overscan: 2,
      heightMap: hm,
    });

    expect(plan.totalCount).toBe(n);
    expect(plan.mountedCount).toBeLessThan(n);
    expect(plan.mountedCount).toBeGreaterThan(0);
    expect(plan.spacerBeforePx).toBeGreaterThanOrEqual(0);
    expect(plan.totalHeightPx).toBe(n * 20);
  });

  it('w3g_plan_fake_fixture_not_authority: silentFixture 可作投影输入', () => {
    const fixture = createSilentFixture(500);
    const plan = buildMountPlanByWindow({
      order: fixture.order,
      window: { startIndex: 10, endIndex: 30 },
      overscan: 4,
    });
    expect(plan.totalCount).toBe(500);
    expect(plan.mountedCount).toBe(28); // [6, 34)
    // 假数据块存在于投影，但本模块不宣称权威
    const blocks = listSilentBlocks(fixture);
    expect(blocks.length).toBe(500);
    expect(plan.mountIds.every((id) => fixture.blocks.has(id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PaperList DOM
// ---------------------------------------------------------------------------

describe('W3-G · PaperList DOM 仅窗口', () => {
  let mount: HTMLElement;
  let list: PaperList;

  beforeEach(() => {
    const doc = requireDocument();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
  });

  afterEach(() => {
    list?.destroy();
    mount.remove();
  });

  it('w3g_dom_host_mount: 根/spacer/块节点契约', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    list = new PaperList(mount, {
      order,
      window: { startIndex: 1, endIndex: 3 },
      overscan: 0,
      projections: [
        { id: 'b', flavour: 'paragraph', text: '第二块' },
        { id: 'c', flavour: 'heading', text: '第三块' },
      ],
    });

    expect(isPaperList(list)).toBe(true);
    const root = list.getRootElement();
    expect(root.getAttribute(BP_PAPER_LIST)).toBe('1');
    expect(root.querySelector(`[${BP_PAPER_SPACER_BEFORE}]`)).toBeTruthy();
    expect(root.querySelector(`[${BP_PAPER_SPACER_AFTER}]`)).toBeTruthy();
    expect(list.countDomBlocks()).toBe(2);
    expect(list.getMountedCount()).toBe(2);
    expect(list.getTotalCount()).toBe(5);
    expect(list.getBlockElement('b')?.textContent).toBe('第二块');
    expect(list.getBlockElement('a')).toBeNull();
    expect(list.getBlockElement('e')).toBeNull();
  });

  it('w3g_dom_large_list_upper_bound: 1万块投影仅窗口 DOM', () => {
    const fixture = createSilentFixture(10_000);
    const projections = listSilentBlocks(fixture).map((b) => {
      const props = b.props as { flavour?: string; text?: string };
      const proj: { id: string; flavour?: string; text?: string } = {
        id: b.id,
      };
      if (props.flavour !== undefined) proj.flavour = props.flavour;
      if (props.text !== undefined) proj.text = props.text;
      return proj;
    });

    list = new PaperList(mount, {
      order: fixture.order,
      window: { startIndex: 500, endIndex: 540 },
      overscan: 12,
      projections,
    });

    const mounted = list.getMountedCount();
    const domCount = list.countDomBlocks();
    expect(domCount).toBe(mounted);
    // 窗口 40 + 双侧 overscan 12 → 64
    expect(mounted).toBe(40 + 24);
    expect(mounted).toBeLessThanOrEqual(MAX_MOUNTED_DOM_BLOCKS);
    expect(list.isWithinDomBound()).toBe(true);
    expect(list.getTotalCount()).toBe(10_000);

    const root = list.getRootElement();
    expect(root.getAttribute(BP_PAPER_MOUNTED_COUNT)).toBe(String(mounted));
    expect(root.getAttribute(BP_PAPER_TOTAL_COUNT)).toBe('10000');

    // 窗外块不在 DOM
    const firstId = fixture.order[0]!;
    const lastId = fixture.order[9999]!;
    expect(list.getBlockElement(firstId)).toBeNull();
    expect(list.getBlockElement(lastId)).toBeNull();
    // 窗口中心在 DOM
    expect(list.getBlockElement(fixture.order[520]!)).toBeTruthy();
  });

  it('w3g_dom_scroll_reconcile: 滚动卸载窗外（真 remove 非 hidden）', () => {
    const n = 200;
    const order = Array.from({ length: n }, (_, i) => `r-${i}`);
    const hm = new HeightMap(n, DEFAULT_ESTIMATE_PX);
    for (let i = 0; i < n; i++) hm.bindId(i, order[i]!);

    list = new PaperList(mount, {
      order,
      scroll: { scrollTop: 0, viewportHeight: DEFAULT_ESTIMATE_PX * 10 },
      overscan: 2,
      heightMap: hm,
    });

    const firstBatch = list.getMountedBlockIds();
    expect(firstBatch).toContain('r-0');
    expect(list.getBlockElement('r-0')).toBeTruthy();

    // 滚到后半
    list.setScroll({
      scrollTop: DEFAULT_ESTIMATE_PX * 100,
      viewportHeight: DEFAULT_ESTIMATE_PX * 10,
    });

    expect(list.getBlockElement('r-0')).toBeNull();
    // 确认是 remove 而非 hidden
    const ghost = list
      .getRootElement()
      .querySelector(`[${BP_PAPER_BLOCK}][data-block-id="r-0"]`);
    expect(ghost).toBeNull();
    expect(list.getMountedBlockIds()).not.toContain('r-0');
    expect(list.getMountedCount()).toBeLessThan(n);
    expect(list.isWithinDomBound()).toBe(true);
  });

  it('w3g_dom_pin_retained: 窗外 composing pin 保留 DOM', () => {
    const order = Array.from({ length: 100 }, (_, i) => `p-${i}`);
    list = new PaperList(mount, {
      order,
      window: { startIndex: 40, endIndex: 50 },
      overscan: 0,
      focusId: 'p-5',
      composingIds: ['p-90'],
    });

    expect(list.getBlockElement('p-5')).toBeTruthy();
    expect(list.getBlockElement('p-90')).toBeTruthy();
    expect(list.getBlockElement('p-0')).toBeNull();
    expect(list.getMountSpec()?.pinned).toEqual(
      expect.arrayContaining(['p-5', 'p-90'])
    );
  });

  it('w3g_dom_no_css_hidden_full_mount: 禁止全量 hidden 冒充', () => {
    const order = Array.from({ length: 300 }, (_, i) => `h-${i}`);
    list = new PaperList(mount, {
      order,
      window: { startIndex: 0, endIndex: 15 },
      overscan: 5,
    });

    // DOM 节点数 = 挂载数 ≪ 总数
    expect(list.countDomBlocks()).toBe(list.getMountedCount());
    expect(list.countDomBlocks()).toBeLessThan(order.length);
    // 不存在 display:none / hidden 的「幽灵全量块」
    const allRows = list
      .getRootElement()
      .querySelectorAll(`[${BP_PAPER_BLOCK}]`);
    expect(allRows.length).toBe(list.getMountedCount());
    for (const el of allRows) {
      expect((el as HTMLElement).hidden).toBe(false);
    }
  });

  it('w3g_dom_mount_spec_shape: 导出 MountSpec 可消费', () => {
    const order = ['m-0', 'm-1', 'm-2', 'm-3', 'm-4'];
    list = new PaperList(mount, {
      order,
      window: { startIndex: 1, endIndex: 3 },
      overscan: 1,
      focusId: 'm-0',
    });
    const spec = list.getMountSpec();
    expect(spec).toBeTruthy();
    expect(spec!.window.startIndex).toBe(0); // 1-1 overscan
    expect(spec!.window.endIndex).toBe(4); // 3+1
    expect(spec!.pinned).toContain('m-0');
    expect(spec!.heights.length).toBeGreaterThan(0);
    expect(spec!.heights.every((h) => typeof h.px === 'number')).toBe(true);
  });

  /**
   * LR-V4 / 02·LR-04：挂载行写 data-heading-level + 焦点 data-bp-focus。
   * **≠ EL-01**；**≠ W3-P**；不改窗口算法 / 假虚拟化。
   */
  it('lr_v4_heading_level_and_focus_attr: 已挂行有 H1/H2 级 + 焦点皮', () => {
    const order = ['h1', 'h2', 'p', 'h3f'];
    list = new PaperList(mount, {
      order,
      window: { startIndex: 0, endIndex: 4 },
      overscan: 0,
      focusId: 'h2',
      projections: [
        { id: 'h1', flavour: 'heading', text: '一级', level: 1 },
        { id: 'h2', flavour: 'heading', text: '二级', level: 2 },
        { id: 'p', flavour: 'paragraph', text: '正文' },
        { id: 'h3f', flavour: 'h3', text: '三级 flavour' },
      ],
    });

    const elH1 = list.getBlockElement('h1');
    const elH2 = list.getBlockElement('h2');
    const elP = list.getBlockElement('p');
    const elH3 = list.getBlockElement('h3f');
    expect(elH1).toBeTruthy();
    expect(elH2).toBeTruthy();
    expect(elH1!.getAttribute('data-heading-level')).toBe('1');
    expect(elH2!.getAttribute('data-heading-level')).toBe('2');
    expect(elH3!.getAttribute('data-heading-level')).toBe('3');
    expect(elP!.hasAttribute('data-heading-level')).toBe(false);

    expect(elH1!.getAttribute('data-bp-focus')).toBeNull();
    expect(elH2!.getAttribute('data-bp-focus')).toBe('1');
    expect(elP!.getAttribute('data-bp-focus')).toBeNull();

    // pin 换焦：旧行卸皮、新行上皮；窗口 DOM 数不变
    const mountedBefore = list.getMountedCount();
    list.setPin({ focusId: 'h1' });
    expect(list.getMountedCount()).toBe(mountedBefore);
    expect(list.getBlockElement('h1')!.getAttribute('data-bp-focus')).toBe('1');
    expect(list.getBlockElement('h2')!.hasAttribute('data-bp-focus')).toBe(
      false
    );

    // heading 无 level → 与 Skeleton 同族默认 2
    list.setProjections([
      { id: 'h1', flavour: 'heading', text: '无级' },
      { id: 'h2', flavour: 'heading', text: '二级', level: 2 },
      { id: 'p', flavour: 'paragraph', text: '正文' },
      { id: 'h3f', flavour: 'h3', text: '三级 flavour' },
    ]);
    expect(list.getBlockElement('h1')!.getAttribute('data-heading-level')).toBe(
      '2'
    );
  });

  it('lr_v4_heading_does_not_change_window_algorithm: 级差皮不扩 mountIds', () => {
    const order = Array.from({ length: 40 }, (_, i) => `w-${i}`);
    list = new PaperList(mount, {
      order,
      window: { startIndex: 10, endIndex: 15 },
      overscan: 0,
      focusId: 'w-12',
      projections: order.map((id, i) => ({
        id,
        flavour: i % 5 === 0 ? 'heading' : 'paragraph',
        text: id,
        ...(i % 5 === 0 ? { level: 1 as const } : {}),
      })),
    });
    expect(list.getMountedCount()).toBe(5);
    expect(list.countDomBlocks()).toBe(5);
    expect(list.getBlockElement('w-0')).toBeNull();
    // 窗口 [10,15)：w-10 为 heading level 1；焦点仍可钉在非标题行
    expect(
      list.getBlockElement('w-10')?.getAttribute('data-heading-level')
    ).toBe('1');
    expect(list.getBlockElement('w-12')?.getAttribute('data-bp-focus')).toBe(
      '1'
    );
  });
});

// ---------------------------------------------------------------------------
// LR-V4 · CSS token 同族（源文件可 rg）
// ---------------------------------------------------------------------------

describe('LR-V4 · resolvePaperHeadingLevel', () => {
  it('lr_v4_resolve_level_prefers_explicit_then_flavour', () => {
    expect(
      resolvePaperHeadingLevel({ id: 'a', flavour: 'heading', level: 1 })
    ).toBe(1);
    expect(
      resolvePaperHeadingLevel({ id: 'a', flavour: 'heading', level: 2 })
    ).toBe(2);
    expect(resolvePaperHeadingLevel({ id: 'a', flavour: 'heading' })).toBe(2);
    expect(resolvePaperHeadingLevel({ id: 'a', flavour: 'h3' })).toBe(3);
    expect(
      resolvePaperHeadingLevel({ id: 'a', flavour: 'paragraph' })
    ).toBeUndefined();
    expect(
      resolvePaperHeadingLevel({ id: 'a', flavour: 'paragraph', level: 9 })
    ).toBeUndefined();
  });
});

describe('LR-V4 · paperList.css 标题/焦点 token', () => {
  it('lr_v4_css_heading_tokens_match_react_family: 2xl/xl + heavy/content；焦点 inset 不吃 focus-ring', () => {
    const css = readFileSync(join(LIST_DIR, 'paperList.css'), 'utf8');

    expect(css).toMatch(
      /\.bp-paper-block\[data-heading-level='1'\][\s\S]*--font-size-2xl/
    );
    expect(css).toMatch(
      /\.bp-paper-block\[data-heading-level='1'\][\s\S]*--font-weight-heavy/
    );
    expect(css).toMatch(
      /\.bp-paper-block\[data-heading-level='2'\][\s\S]*--font-size-xl/
    );
    expect(css).toMatch(
      /\.bp-paper-block\[data-heading-level='2'\][\s\S]*--font-weight-content/
    );
    expect(css).not.toMatch(/font-size:\s*22px\s*;/);
    expect(css).toMatch(/\[data-bp-focus='1'\]/);
    expect(css).toMatch(/inset 0 0 0 1px/);
    expect(css).not.toMatch(/var\(\s*--focus-ring/);
  });
});

describe('LR-V4 · 桌面透传源可 rg', () => {
  it('lr_v4_desktop_sources_pass_level: ChromeSlot / DomMount 写 level', () => {
    const repoRoot = resolve(LIST_DIR, '../../../..');
    const slot = readFileSync(
      join(
        repoRoot,
        'apps/crish-desktop/src/components/note-paper/NotePaperStrictChromeSlot.tsx'
      ),
      'utf8'
    );
    const mountSrc = readFileSync(
      join(
        repoRoot,
        'apps/crish-desktop/src/components/note-paper/PaperListDomMount.tsx'
      ),
      'utf8'
    );
    expect(slot).toMatch(/props\?\.level/);
    expect(slot).toMatch(/row\.level\s*=/);
    expect(mountSrc).toMatch(/level\?: number/);
    expect(mountSrc).toMatch(/proj\.level = block\.level/);
    expect(mountSrc).toMatch(/b\.level \?\? ''/);
  });
});
