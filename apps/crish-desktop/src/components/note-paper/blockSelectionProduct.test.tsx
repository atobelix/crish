// @vitest-environment jsdom
/**
 * W3-E-desk · 产品挂 BlockSelectionBridge（DomMount / Strict 装配可观测）
 *
 * ## 可宣称 / 禁止
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | DomMount 默认 / 注入 bridge；data-sel-* | **EL-01** / Notion 框选 e2e |
 * | setMulti / clear / focus 策略投影 DOM | 回退 w3f_dom / code 叶 / CONN-C pin |
 *
 * **≠ EL-01**；**≠** Notion 框选 e2e。
 */
import React, { useState } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  BlockChromeModel,
  type BlockSelectionBridge,
} from '@crish/block-paper';
import {
  createProductBlockSelection,
  SEL_DATA_ANCHOR,
  SEL_DATA_BRIDGE,
  SEL_DATA_FOCUS,
  SEL_DATA_HEAD,
  SEL_DATA_MODE,
  SEL_DATA_MULTI,
  blockSelectionSnapshotToDataAttrs,
} from './blockSelectionProduct';
import { BlockChromeDomMount } from './BlockChromeDomMount';
import { NotePaperStrictPanel } from './NotePaperStrictPanel';
import {
  createFixtureHydrateTransport,
  makeHydratedBlock,
} from './hydrateProjection';

const ID_A = 'b-sel-a';
const ID_B = 'b-sel-b';
const ID_C = 'b-sel-c';

describe('W3-E-desk blockSelectionProduct · 工厂 / data 属性', () => {
  it('w3e_desk_factory_snapshot_data_attrs: createProductBlockSelection + 快照字典', () => {
    const chrome = new BlockChromeModel();
    const sel = createProductBlockSelection(chrome, {
      blockOrder: [ID_A, ID_B, ID_C],
    });
    const snap = sel.setMultiSelected([ID_A, ID_B]);
    const attrs = blockSelectionSnapshotToDataAttrs(snap);
    expect(attrs[SEL_DATA_BRIDGE]).toBe('1');
    expect(attrs[SEL_DATA_MODE]).toBe('blockMulti');
    expect(attrs[SEL_DATA_MULTI]).toBe(`${ID_A},${ID_B}`);
    expect(attrs[SEL_DATA_FOCUS]).toBe(ID_B);
    expect(attrs[SEL_DATA_ANCHOR]).toBe(ID_A);
    expect(attrs[SEL_DATA_HEAD]).toBe(ID_B);
  });
});

describe('W3-E-desk BlockChromeDomMount · 默认 bridge 可观测', () => {
  let chrome: BlockChromeModel;
  let selection: BlockSelectionBridge | null;

  beforeEach(() => {
    chrome = new BlockChromeModel();
    selection = null;
  });

  it('w3e_desk_dom_mount_default_set_multi_clear: 默认 bridge setMulti/clear → data-sel-*', () => {
    let setTick: ((n: number) => void) | null = null;
    function Controlled() {
      const [tick, setTickState] = useState(0);
      setTick = setTickState;
      return (
        <BlockChromeDomMount
          blocks={[
            { blockId: ID_A, flavour: 'paragraph' },
            { blockId: ID_B, flavour: 'paragraph' },
            { blockId: ID_C, flavour: 'heading' },
          ]}
          chrome={chrome}
          syncToken={tick}
          onSelectionReady={(s) => {
            selection = s;
          }}
        />
      );
    }

    render(<Controlled />);
    expect(selection).not.toBeNull();

    const mount = screen.getByTestId('note-paper-chrome-dom');
    expect(mount).toHaveAttribute(SEL_DATA_BRIDGE, '1');
    expect(mount).toHaveAttribute(SEL_DATA_MODE, 'none');

    // setMulti → multi + focus head 可观测
    act(() => {
      selection!.setMultiSelected([ID_A, ID_C]);
      setTick?.(1);
    });
    expect(mount).toHaveAttribute(SEL_DATA_MODE, 'blockMulti');
    expect(mount).toHaveAttribute(SEL_DATA_MULTI, `${ID_A},${ID_C}`);
    expect(mount).toHaveAttribute(SEL_DATA_FOCUS, ID_C);
    expect(mount).toHaveAttribute(SEL_DATA_HEAD, ID_C);
    expect(mount).toHaveAttribute(SEL_DATA_ANCHOR, ID_A);
    expect(chrome.getSnapshot().multiSelectedIds).toEqual([ID_A, ID_C]);
    expect(chrome.getSnapshot().focusedBlockId).toBe(ID_C);
    // chrome 把手 multi 优先（不回退 w3f 多选呈现）
    expect(chrome.getHandleVisibility(ID_A)).toBe('multi');
    expect(chrome.getHandleVisibility(ID_C)).toBe('multi');

    // clear 默认保留 focus
    act(() => {
      selection!.clearMultiSelected();
      setTick?.(2);
    });
    expect(mount).toHaveAttribute(SEL_DATA_MODE, 'focusOnly');
    expect(mount).toHaveAttribute(SEL_DATA_MULTI, '');
    expect(mount).toHaveAttribute(SEL_DATA_FOCUS, ID_C);
    expect(chrome.getSnapshot().multiSelectedIds).toEqual([]);
    expect(chrome.getHandleVisibility(ID_C)).toBe('focus');
  });

  it('w3e_desk_dom_mount_focus_outside_clears_multi: focus 策略可观测', () => {
    let setTick: ((n: number) => void) | null = null;
    function Controlled() {
      const [tick, setTickState] = useState(0);
      setTick = setTickState;
      return (
        <BlockChromeDomMount
          blocks={[{ blockId: ID_A }, { blockId: ID_B }, { blockId: ID_C }]}
          chrome={chrome}
          syncToken={tick}
          onSelectionReady={(s) => {
            selection = s;
          }}
        />
      );
    }

    render(<Controlled />);
    expect(selection).not.toBeNull();
    const mount = screen.getByTestId('note-paper-chrome-dom');

    act(() => {
      selection!.setMultiSelected([ID_A, ID_B]);
      setTick?.(1);
    });
    expect(mount).toHaveAttribute(SEL_DATA_MODE, 'blockMulti');

    // 焦点落 multi 外 → 清 multi，focusOnly
    act(() => {
      selection!.setFocused(ID_C);
      setTick?.(2);
    });
    expect(mount).toHaveAttribute(SEL_DATA_MODE, 'focusOnly');
    expect(mount).toHaveAttribute(SEL_DATA_MULTI, '');
    expect(mount).toHaveAttribute(SEL_DATA_FOCUS, ID_C);
    expect(mount).toHaveAttribute(SEL_DATA_ANCHOR, ID_C);
    expect(mount).toHaveAttribute(SEL_DATA_HEAD, ID_C);
    expect(chrome.getHandleVisibility(ID_A)).toBe('hidden');
    expect(chrome.getHandleVisibility(ID_C)).toBe('focus');
  });

  it('w3e_desk_dom_mount_inject_bridge: 注入 selection 与默认工厂互斥同源', () => {
    const injected = createProductBlockSelection(chrome, {
      blockOrder: [ID_A, ID_B],
    });
    let ready: BlockSelectionBridge | null = null;

    render(
      <BlockChromeDomMount
        blocks={[{ blockId: ID_A }, { blockId: ID_B }]}
        chrome={chrome}
        selection={injected}
        onSelectionReady={(s) => {
          ready = s;
        }}
      />
    );

    expect(ready).toBe(injected);
    act(() => {
      injected.selectBlockRange(ID_A, ID_B);
    });
    // 注入路径：渲染属性随 getSnapshot；rerender 靠 act 后查询 bridge 本身
    expect(injected.getSnapshot().multiSelectedIds).toEqual([ID_A, ID_B]);
    expect(chrome.getSnapshot().focusedBlockId).toBe(ID_B);
  });
});

describe('W3-E-desk NotePaperStrictPanel · 产品装配选区', () => {
  it('w3e_desk_strict_set_multi_clear_focus_data: Strict 默认 bridge 面板 data-sel-*', async () => {
    let sel: BlockSelectionBridge | null = null;
    const chrome = new BlockChromeModel();
    const transport = createFixtureHydrateTransport({
      'doc-sel': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: ID_A,
            flavour: 'paragraph',
            text: 'a',
            index: 0,
          }),
          makeHydratedBlock({
            id: ID_B,
            flavour: 'paragraph',
            text: 'b',
            index: 1,
          }),
          makeHydratedBlock({
            id: ID_C,
            flavour: 'code',
            text: 'c()',
            index: 2,
          }),
        ],
      },
    });

    const { rerender } = render(
      <NotePaperStrictPanel
        docId="doc-sel"
        hydrateTransport={transport}
        chrome={chrome}
        onBlockSelectionReady={(s) => {
          sel = s;
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
    expect(panel).toHaveAttribute(SEL_DATA_BRIDGE, '1');
    expect(sel).not.toBeNull();

    // setMulti
    act(() => {
      sel!.setMultiSelected([ID_A, ID_B]);
    });
    rerender(
      <NotePaperStrictPanel
        docId="doc-sel"
        hydrateTransport={transport}
        chrome={chrome}
        onBlockSelectionReady={(s) => {
          sel = s;
        }}
      />
    );
    expect(panel).toHaveAttribute(SEL_DATA_MODE, 'blockMulti');
    expect(panel).toHaveAttribute(SEL_DATA_MULTI, `${ID_A},${ID_B}`);
    expect(panel).toHaveAttribute(SEL_DATA_FOCUS, ID_B);

    const chromeMount = screen.getByTestId('note-paper-strict-chrome-dom');
    expect(chromeMount).toHaveAttribute(SEL_DATA_MODE, 'blockMulti');
    expect(chromeMount).toHaveAttribute(SEL_DATA_MULTI, `${ID_A},${ID_B}`);

    // clear 保留 focus
    act(() => {
      sel!.clearMultiSelected();
    });
    rerender(
      <NotePaperStrictPanel
        docId="doc-sel"
        hydrateTransport={transport}
        chrome={chrome}
        onBlockSelectionReady={(s) => {
          sel = s;
        }}
      />
    );
    expect(panel).toHaveAttribute(SEL_DATA_MODE, 'focusOnly');
    expect(panel).toHaveAttribute(SEL_DATA_MULTI, '');
    expect(panel).toHaveAttribute(SEL_DATA_FOCUS, ID_B);

    // focus outside 策略（先再 multi 再 focus C）
    act(() => {
      sel!.setMultiSelected([ID_A, ID_B]);
      sel!.setFocused(ID_C);
    });
    rerender(
      <NotePaperStrictPanel
        docId="doc-sel"
        hydrateTransport={transport}
        chrome={chrome}
        onBlockSelectionReady={(s) => {
          sel = s;
        }}
      />
    );
    expect(panel).toHaveAttribute(SEL_DATA_MODE, 'focusOnly');
    expect(panel).toHaveAttribute(SEL_DATA_MULTI, '');
    expect(panel).toHaveAttribute(SEL_DATA_FOCUS, ID_C);
    // CONN-C 消费的 chrome focus 仍在
    expect(chrome.getSnapshot().focusedBlockId).toBe(ID_C);
  });
});
