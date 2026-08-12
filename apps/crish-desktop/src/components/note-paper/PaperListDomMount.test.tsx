// @vitest-environment jsdom
/**
 * PaperListDomMount + Strict 产品挂载契约（W3-G 窗口 DOM · 桌面）
 *
 * ## 可宣称 / 禁止
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | React 包装挂载 PaperList；hydrate 投影驱动 | **EL-01** e2e 满关 |
 * | 窗口/scroll 参数可测；DOM 块数 ≤ 结构上界 | A-PERF **数值**门 |
 * | 与 chrome DomMount 分槽共存不互删 | W3-P WindowManager 全闭环 |
 * | 窗外真 remove（非 CSS hidden） | 假数据列表 = 权威树 |
 *
 * **≠ EL-01**；**≠ W3-P**；**≠** 权威树。
 */
import React, { useState } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  BP_CHROME_ROOT,
  BP_PAPER_BLOCK,
  BP_PAPER_LIST,
  BP_PAPER_MOUNTED_COUNT,
  BP_PAPER_TOTAL_COUNT,
  BlockChromeModel,
  type BlockChromeDomHost,
  type PaperList,
} from '@crish/block-paper';
import { MAX_MOUNTED_DOM_BLOCKS } from '@crish/editor-kit';
import { PaperListDomMount } from './PaperListDomMount';
import { NotePaperStrictPanel } from './NotePaperStrictPanel';
import {
  createFixtureHydrateTransport,
  makeHydratedBlock,
} from './hydrateProjection';

function makeBlocks(n: number, prefix = 'b') {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    flavour: i % 10 === 0 ? 'heading' : 'paragraph',
    text: `块 ${i}`,
  }));
}

// ---------------------------------------------------------------------------
// 独立挂载
// ---------------------------------------------------------------------------

describe('PaperListDomMount · 独立挂载契约', () => {
  let list: PaperList | null;

  beforeEach(() => {
    list = null;
  });

  it('w3g_desktop_mount_window_upper_bound: 大投影仅窗口 DOM ≤ 结构上界', () => {
    const blocks = makeBlocks(5_000);
    render(
      <PaperListDomMount
        blocks={blocks}
        window={{ startIndex: 100, endIndex: 140 }}
        overscan={8}
        onListReady={(l) => {
          list = l;
        }}
      />
    );

    const mount = screen.getByTestId('note-paper-paper-list');
    expect(mount).toHaveAttribute('data-bp-paper-list-mount', '1');
    expect(mount).toHaveAttribute('data-paper-list-block-count', '5000');
    expect(mount).toHaveAttribute('data-paper-list-track', 'w3-g');
    expect(mount).toHaveAttribute('data-paper-list-el', 'open');
    expect(mount).toHaveAttribute('data-paper-list-window', '100:140');

    expect(list).not.toBeNull();
    const mounted = list!.getMountedCount();
    const domCount = list!.countDomBlocks();
    // 窗口 40 + 双侧 overscan 8 → 56
    expect(mounted).toBe(40 + 16);
    expect(domCount).toBe(mounted);
    expect(mounted).toBeLessThanOrEqual(MAX_MOUNTED_DOM_BLOCKS);
    expect(list!.isWithinDomBound()).toBe(true);
    expect(list!.getTotalCount()).toBe(5_000);

    const root = list!.getRootElement();
    expect(root.getAttribute(BP_PAPER_LIST)).toBe('1');
    expect(root.getAttribute(BP_PAPER_MOUNTED_COUNT)).toBe(String(mounted));
    expect(root.getAttribute(BP_PAPER_TOTAL_COUNT)).toBe('5000');

    // 窗外不在 DOM
    expect(list!.getBlockElement('b-0')).toBeNull();
    expect(list!.getBlockElement('b-4999')).toBeNull();
    expect(list!.getBlockElement('b-120')).toBeTruthy();
  });

  it('w3g_desktop_scroll_params_measurable: scroll 变更卸载窗外（真 remove）', () => {
    const blocks = makeBlocks(300, 's');
    let setScrollExternal:
      ((s: { scrollTop: number; viewportHeight: number }) => void) | null =
      null;

    function Controlled() {
      const [scroll, setScroll] = useState({
        scrollTop: 0,
        viewportHeight: 200,
      });
      setScrollExternal = setScroll;
      return (
        <PaperListDomMount
          blocks={blocks}
          scroll={scroll}
          overscan={2}
          defaultEstimatePx={20}
          onListReady={(l) => {
            list = l;
          }}
        />
      );
    }

    render(<Controlled />);
    expect(list).not.toBeNull();
    expect(list!.getBlockElement('s-0')).toBeTruthy();
    const firstMounted = list!.getMountedCount();
    expect(firstMounted).toBeGreaterThan(0);
    expect(firstMounted).toBeLessThan(300);
    expect(firstMounted).toBeLessThanOrEqual(MAX_MOUNTED_DOM_BLOCKS);

    act(() => {
      setScrollExternal?.({ scrollTop: 20 * 100, viewportHeight: 200 });
    });

    // 顶块已卸载（真 remove，非 hidden）
    expect(list!.getBlockElement('s-0')).toBeNull();
    const ghost = list!
      .getRootElement()
      .querySelector(`[${BP_PAPER_BLOCK}][data-block-id="s-0"]`);
    expect(ghost).toBeNull();
    expect(list!.getMountedCount()).toBeLessThan(300);
    expect(list!.isWithinDomBound()).toBe(true);

    const mount = screen.getByTestId('note-paper-paper-list');
    expect(mount).toHaveAttribute('data-paper-list-scroll', '2000:200');
  });
});

// ---------------------------------------------------------------------------
// Strict 产品路径 + chrome 共存
// ---------------------------------------------------------------------------

describe('NotePaperStrictPanel · PaperList 产品挂载', () => {
  it('w3g_desktop_strict_hydrate_drives_paper_list: hydrate 投影驱动 + 窗口上界', async () => {
    let paperList: PaperList | null = null;
    const n = 400;
    const transport = createFixtureHydrateTransport({
      'doc-pl': {
        rev: 2,
        blocks: Array.from({ length: n }, (_, i) =>
          makeHydratedBlock({
            id: `h-${i}`,
            flavour: 'paragraph',
            text: `hydrate ${i}`,
            index: i,
          })
        ),
      },
    });

    render(
      <NotePaperStrictPanel
        docId="doc-pl"
        hydrateTransport={transport}
        paperList={{
          window: { startIndex: 50, endIndex: 70 },
          overscan: 4,
          keepReactRows: false,
        }}
        onPaperListReady={(l) => {
          paperList = l;
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-paper-list', '1');
    expect(panel).toHaveAttribute('data-block-count', String(n));

    const plMount = screen.getByTestId('note-paper-strict-paper-list');
    expect(plMount).toHaveAttribute('data-bp-paper-list-mount', '1');
    expect(plMount).toHaveAttribute('data-paper-list-block-count', String(n));

    expect(paperList).not.toBeNull();
    // 窗口 20 + overscan 4*2 = 28
    expect(paperList!.getMountedCount()).toBe(20 + 8);
    expect(paperList!.countDomBlocks()).toBe(paperList!.getMountedCount());
    expect(paperList!.getMountedCount()).toBeLessThanOrEqual(
      MAX_MOUNTED_DOM_BLOCKS
    );
    expect(paperList!.getTotalCount()).toBe(n);
    expect(paperList!.getBlockElement('h-0')).toBeNull();
    expect(paperList!.getBlockElement('h-60')).toBeTruthy();

    // keepReactRows=false → 无全量 content-row
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(0);
  });

  it('w3g_desktop_coexist_chrome_and_paper_list: 分槽同屏不互删', async () => {
    let paperList: PaperList | null = null;
    let chromeHost: BlockChromeDomHost | null = null;
    const chrome = new BlockChromeModel();
    const transport = createFixtureHydrateTransport({
      'doc-co': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'c1',
            flavour: 'paragraph',
            text: 'alpha',
            index: 0,
          }),
          makeHydratedBlock({
            id: 'c2',
            flavour: 'heading',
            text: 'beta',
            index: 1,
          }),
          makeHydratedBlock({
            id: 'c3',
            flavour: 'paragraph',
            text: 'gamma',
            index: 2,
          }),
        ],
      },
    });

    render(
      <NotePaperStrictPanel
        docId="doc-co"
        hydrateTransport={transport}
        chrome={chrome}
        paperList={{
          window: { startIndex: 0, endIndex: 3 },
          overscan: 0,
          keepReactRows: true,
        }}
        onPaperListReady={(l) => {
          paperList = l;
        }}
        onChromeDomHost={(h) => {
          chromeHost = h;
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const paperMount = screen.getByTestId('note-paper-strict-paper-list');
    const chromeMount = screen.getByTestId('note-paper-strict-chrome-dom');

    // 分槽锚同时存在
    expect(paperMount).toHaveAttribute('data-bp-paper-list-mount', '1');
    expect(chromeMount).toHaveAttribute('data-bp-chrome-mount', '1');
    expect(paperMount).not.toBe(chromeMount);

    expect(paperList).not.toBeNull();
    expect(chromeHost).not.toBeNull();
    expect(paperList!.getRootElement().getAttribute(BP_PAPER_LIST)).toBe('1');
    expect(chromeHost!.getRootElement().getAttribute(BP_CHROME_ROOT)).toBe('1');

    // 各自独立：chrome 有把手；paper list 有块
    expect(chromeHost!.getHandleElement('c1')).toBeTruthy();
    expect(paperList!.getBlockElement('c1')).toBeTruthy();
    expect(paperList!.countDomBlocks()).toBe(3);

    // 同屏 content-row 仍在（keepReactRows）
    expect(screen.getByTestId('note-strict-block-c1')).toBeTruthy();

    // 销毁一方不删另一方：destroy paper list 后 chrome 仍在
    act(() => {
      paperList!.destroy();
    });
    expect(chromeMount.querySelector(`[${BP_CHROME_ROOT}]`)).toBeTruthy();
    expect(chromeHost!.getHandleElement('c2')).toBeTruthy();
    // chrome 槽仍在 DOM
    expect(screen.getByTestId('note-paper-strict-chrome-dom')).toBeTruthy();
  });
});
