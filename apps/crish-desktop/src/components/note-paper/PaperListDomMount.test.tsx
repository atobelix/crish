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
          // 产品默认 paper-list：省略 presentationMode 即互斥 content-row
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
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    expect(panel).toHaveAttribute('data-block-count', String(n));

    const plMount = screen.getByTestId('note-paper-strict-paper-list');
    expect(plMount).toHaveAttribute('data-bp-paper-list-mount', '1');
    expect(plMount).toHaveAttribute('data-paper-list-block-count', String(n));

    // StrictMode 下 effect 先 null 再 ready；等最终 list 实例
    await waitFor(() => {
      expect(paperList).not.toBeNull();
    });
    // 窗口 20 + overscan 4*2 = 28
    expect(paperList!.getMountedCount()).toBe(20 + 8);
    expect(paperList!.countDomBlocks()).toBe(paperList!.getMountedCount());
    expect(paperList!.getMountedCount()).toBeLessThanOrEqual(
      MAX_MOUNTED_DOM_BLOCKS
    );
    expect(paperList!.getTotalCount()).toBe(n);
    expect(paperList!.getBlockElement('h-0')).toBeNull();
    expect(paperList!.getBlockElement('h-60')).toBeTruthy();

    // SD-04 产品默认：paper-list 模式无全量 content-row
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(0);
  });

  it('sd04_product_default_paper_list_mutex_content_row: 默认互斥双内容', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-mutex': {
        rev: 1,
        blocks: Array.from({ length: 5 }, (_, i) =>
          makeHydratedBlock({
            id: `m-${i}`,
            flavour: 'paragraph',
            text: `t${i}`,
            index: i,
          })
        ),
      },
    });

    // paperList=true（无 config）→ 产品默认 paper-list，不得双内容
    render(
      <NotePaperStrictPanel
        docId="doc-mutex"
        hydrateTransport={transport}
        paperList
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    expect(panel).toHaveAttribute('data-paper-list', '1');
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(0);
    expect(screen.getByTestId('note-paper-strict-paper-list')).toHaveAttribute(
      'data-bp-paper-list-mount',
      '1'
    );
    // chrome 槽仍在（分槽，不计入内容互斥）
    expect(screen.getByTestId('note-paper-strict-chrome-dom')).toHaveAttribute(
      'data-bp-chrome-mount',
      '1'
    );
  });

  it('sd04_default_react_rows_no_paper_list_mount', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-rr': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'r1',
            flavour: 'paragraph',
            text: 'only rows',
            index: 0,
          }),
        ],
      },
    });

    render(
      <NotePaperStrictPanel docId="doc-rr" hydrateTransport={transport} />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-presentation-mode', 'react-rows');
    expect(panel).toHaveAttribute('data-paper-list', '0');
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(1);
    expect(screen.queryByTestId('note-paper-strict-paper-list')).toBeNull();
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
        // 产品路径：paper-list 与 chrome 分槽共存（无 content-row）
        paperList={{
          window: { startIndex: 0, endIndex: 3 },
          overscan: 0,
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
    const panel = screen.getByTestId('note-paper-strict-panel');

    // 分槽锚同时存在
    expect(paperMount).toHaveAttribute('data-bp-paper-list-mount', '1');
    expect(chromeMount).toHaveAttribute('data-bp-chrome-mount', '1');
    expect(paperMount).not.toBe(chromeMount);
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    // 产品 paper-list：无全量 content-row
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(0);

    expect(paperList).not.toBeNull();
    expect(chromeHost).not.toBeNull();
    expect(paperList!.getRootElement().getAttribute(BP_PAPER_LIST)).toBe('1');
    expect(chromeHost!.getRootElement().getAttribute(BP_CHROME_ROOT)).toBe('1');

    // 各自独立：chrome 有把手；paper list 有块
    expect(chromeHost!.getHandleElement('c1')).toBeTruthy();
    expect(paperList!.getBlockElement('c1')).toBeTruthy();
    expect(paperList!.countDomBlocks()).toBe(3);

    // 销毁一方不删另一方：destroy paper list 后 chrome 仍在
    act(() => {
      paperList!.destroy();
    });
    expect(chromeMount.querySelector(`[${BP_CHROME_ROOT}]`)).toBeTruthy();
    expect(chromeHost!.getHandleElement('c2')).toBeTruthy();
    // chrome 槽仍在 DOM
    expect(screen.getByTestId('note-paper-strict-chrome-dom')).toBeTruthy();
  });

  it('sd04_debug_dual_allows_content_row_and_paper_list', async () => {
    let paperList: PaperList | null = null;
    const transport = createFixtureHydrateTransport({
      'doc-dual': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'd1',
            flavour: 'paragraph',
            text: 'dual-a',
            index: 0,
          }),
          makeHydratedBlock({
            id: 'd2',
            flavour: 'paragraph',
            text: 'dual-b',
            index: 1,
          }),
        ],
      },
    });

    render(
      <NotePaperStrictPanel
        docId="doc-dual"
        hydrateTransport={transport}
        paperList={{
          window: { startIndex: 0, endIndex: 2 },
          overscan: 0,
          presentationMode: 'debug-dual',
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
    expect(panel).toHaveAttribute('data-presentation-mode', 'debug-dual');
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(2);
    expect(screen.getByTestId('note-strict-block-d1')).toBeTruthy();
    expect(screen.getByTestId('note-paper-strict-paper-list')).toHaveAttribute(
      'data-bp-paper-list-mount',
      '1'
    );
    expect(paperList).not.toBeNull();
    expect(paperList!.countDomBlocks()).toBe(2);
  });

  /**
   * CONN-C · C-X1：chrome.setFocused → PaperList pin（至少一方向）。
   * 窗外 focus 块须 pin 保留 DOM；≠ W3-P；≠ EL-01。
   */
  it('conn_c_chrome_focus_drives_paper_list_pin: setFocused 窗外 pin 保留 DOM', async () => {
    let paperList: PaperList | null = null;
    const chrome = new BlockChromeModel();
    const n = 80;
    const transport = createFixtureHydrateTransport({
      'doc-pin': {
        rev: 1,
        blocks: Array.from({ length: n }, (_, i) =>
          makeHydratedBlock({
            id: `pin-${i}`,
            flavour: 'paragraph',
            text: `pin row ${i}`,
            index: i,
          })
        ),
      },
    });

    const panelProps = {
      docId: 'doc-pin',
      hydrateTransport: transport,
      chrome,
      paperList: {
        window: { startIndex: 40, endIndex: 50 },
        overscan: 0,
      },
      onPaperListReady: (l: PaperList | null) => {
        paperList = l;
      },
    };

    const { rerender } = render(<NotePaperStrictPanel {...panelProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    // PaperList 在 status=ready 后 effect 挂载；等 onPaperListReady
    await waitFor(() => {
      expect(paperList).not.toBeNull();
    });
    // 窗外块初始不在 DOM
    expect(paperList!.getBlockElement('pin-5')).toBeNull();
    expect(paperList!.getBlockElement('pin-45')).toBeTruthy();

    // chrome focus 驱动 pin（CONN-C 至少一方向）
    act(() => {
      chrome.setFocused('pin-5');
    });
    rerender(<NotePaperStrictPanel {...panelProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-paper-list-focus-id',
        'pin-5'
      );
    });

    expect(paperList!.getBlockElement('pin-5')).toBeTruthy();
    expect(paperList!.getMountSpec()?.pinned).toEqual(
      expect.arrayContaining(['pin-5'])
    );
    // 窗口内块仍在；窗外非 pin 仍不挂
    expect(paperList!.getBlockElement('pin-45')).toBeTruthy();
    expect(paperList!.getBlockElement('pin-0')).toBeNull();
  });

  /**
   * CONN-C · C-X2 子集：Strict 省略 paperList → data-paper-list=0 钉死。
   * 防默默改默认 true 却无结构门测。
   */
  it('conn_c_strict_default_paper_list_off: 省略 paperList → data-paper-list=0', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-default-pl': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'def-1',
            flavour: 'paragraph',
            text: 'default off',
            index: 0,
          }),
        ],
      },
    });

    render(
      <NotePaperStrictPanel
        docId="doc-default-pl"
        hydrateTransport={transport}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    // 诚实快照：产品空态/默认路径 paperList 关
    expect(panel).toHaveAttribute('data-paper-list', '0');
    expect(panel).toHaveAttribute('data-presentation-mode', 'react-rows');
    expect(screen.queryByTestId('note-paper-strict-paper-list')).toBeNull();
    expect(panel.querySelector('[data-bp-paper-list-mount]')).toBeNull();
  });
});
