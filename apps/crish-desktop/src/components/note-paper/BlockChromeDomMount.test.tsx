// @vitest-environment jsdom
/**
 * BlockChromeDomMount + note-paper 桌面 React chrome 挂载契约（W3-F DOM 子集）
 *
 * ## 可宣称 / 禁止
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | DomHost 挂到 Skeleton/Strict React 树 | **EL-01** / A-BLK e2e 全关 |
 * | data-bp-* / 落点线 / 把手可见性 DOM 同步 | 真 Pointer 拖拽产品全链 |
 * | slash 宿主显隐 + catalog 最小投影 | A-BLK-02 slash 产品 e2e / EL-01 |
 *
 * **≠ EL-01 e2e**；真拖拽 Pointer 全链后置。
 */
import React, { useState } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from '@testing-library/react';
import {
  BlockChromeModel,
  SlashMenuModel,
  BP_CHROME_ROOT,
  BP_DROP_LINE,
  BP_DROP_SIDE,
  BP_DROP_TARGET,
  BP_HANDLE_VISIBILITY,
  BP_SLASH_GROUP,
  BP_SLASH_HOST,
  BP_SLASH_ITEM,
  BP_SLASH_OPEN,
  type BlockChromeDomHost,
} from '@crish/block-paper';
import { BlockChromeDomMount } from './BlockChromeDomMount';
import { NotePaperPanel } from './NotePaperPanel';
import { NotePaperStrictPanel } from './NotePaperStrictPanel';
import {
  createFixtureHydrateTransport,
  makeHydratedBlock,
} from './hydrateProjection';

const ID_A = 'b-0001';
const ID_B = 'b-0002';

describe('BlockChromeDomMount · 独立挂载契约', () => {
  let chrome: BlockChromeModel;
  let slash: SlashMenuModel;
  let host: BlockChromeDomHost | null;

  beforeEach(() => {
    chrome = new BlockChromeModel();
    slash = new SlashMenuModel();
    host = null;
  });

  it('w3f_desktop_mount_data_bp_contracts: root/把手/落点线/slash 宿主节点存在', () => {
    render(
      <BlockChromeDomMount
        blocks={[
          { blockId: ID_A, flavour: 'paragraph' },
          { blockId: ID_B, flavour: 'heading' },
        ]}
        chrome={chrome}
        slash={slash}
        onHostReady={(h) => {
          host = h;
        }}
      />
    );

    const mount = screen.getByTestId('note-paper-chrome-dom');
    expect(mount).toHaveAttribute('data-bp-chrome-mount', '1');
    expect(mount).toHaveAttribute('data-chrome-block-count', '2');
    expect(mount).toHaveAttribute('data-chrome-pointer-chain', 'deferred');

    expect(host).not.toBeNull();
    const root = host!.getRootElement();
    expect(root.getAttribute(BP_CHROME_ROOT)).toBe('1');
    expect(host!.getHandleElement(ID_A)).toBeTruthy();
    expect(root.querySelector(`[${BP_DROP_LINE}]`)).toBeTruthy();
    expect(root.querySelector(`[${BP_SLASH_HOST}]`)).toBeTruthy();
    // L0 默认把手 hidden
    expect(host!.getHandleVisibilityAttr(ID_A)).toBe('hidden');
    expect(host!.isDropLineVisible()).toBe(false);
    expect(host!.isSlashHostVisible()).toBe(false);
  });

  it('w3f_desktop_handle_and_drop_and_slash: 把手可见性 / 落点线 / slash 宿主同步', () => {
    // 受控 wrapper：act 内 bump syncToken → host.sync()
    let setTickExternal: ((n: number) => void) | null = null;
    function Controlled() {
      const [tick, setTick] = useState(0);
      setTickExternal = setTick;
      return (
        <BlockChromeDomMount
          blocks={[{ blockId: ID_A }, { blockId: ID_B }]}
          chrome={chrome}
          slash={slash}
          syncToken={tick}
          onHostReady={(h) => {
            host = h;
          }}
        />
      );
    }

    render(<Controlled />);
    expect(host).not.toBeNull();

    // 1) 把手：hover → data-handle-visibility=hover
    act(() => {
      chrome.setHovered(ID_A);
      setTickExternal?.(1);
    });
    expect(host!.getHandleVisibilityAttr(ID_A)).toBe('hover');
    expect(
      host!.getHandleElement(ID_A)?.getAttribute(BP_HANDLE_VISIBILITY)
    ).toBe('hover');
    expect(host!.getHandleElement(ID_A)?.hidden).toBe(false);
    expect(host!.getHandleVisibilityAttr(ID_B)).toBe('hidden');

    // 2) 落点线：setDropTarget → 可见 + side/target
    act(() => {
      host!.setDropTarget(ID_B, 'before');
    });
    expect(host!.isDropLineVisible()).toBe(true);
    const drop = host!.getDropLineElement();
    expect(drop.getAttribute(BP_DROP_SIDE)).toBe('before');
    expect(drop.getAttribute(BP_DROP_TARGET)).toBe(ID_B);
    expect(drop.hidden).toBe(false);

    act(() => {
      host!.clearDropTarget();
    });
    expect(host!.isDropLineVisible()).toBe(false);

    // 3) slash 宿主：open → data-slash-open=1 + catalog group/item 可见皮
    act(() => {
      const r = slash.open(ID_A, 0);
      expect(r.ok).toBe(true);
      setTickExternal?.(2);
    });
    expect(host!.isSlashHostVisible()).toBe(true);
    const slashEl = host!.getSlashHostElement();
    expect(slashEl.getAttribute(BP_SLASH_OPEN)).toBe('1');
    expect(slashEl.getAttribute('data-block-id')).toBe(ID_A);
    // catalog 最小投影（chrome.css group/item 皮挂点）
    expect(
      slashEl.querySelectorAll(`[${BP_SLASH_ITEM}]`).length
    ).toBeGreaterThan(0);
    expect(slashEl.querySelector(`[${BP_SLASH_GROUP}]`)).toBeTruthy();
    expect(
      slashEl.querySelector(`[${BP_SLASH_ITEM}][data-active='1']`)
    ).toBeTruthy();

    act(() => {
      slash.close();
      setTickExternal?.(3);
    });
    expect(host!.isSlashHostVisible()).toBe(false);
    expect(host!.getSlashHostElement().getAttribute(BP_SLASH_OPEN)).toBe('0');
    expect(host!.getSlashHostElement().children.length).toBe(0);
  });
});

describe('NotePaperPanel · Skeleton chrome DomHost 挂载', () => {
  it('w3f_desktop_skeleton_mounts_dom_host_and_syncs_handle_on_hover', () => {
    let host: BlockChromeDomHost | null = null;
    const chrome = new BlockChromeModel();
    render(
      <NotePaperPanel
        blockCount={2}
        chrome={chrome}
        onChromeDomHost={(h) => {
          host = h;
        }}
      />
    );

    const chromeMount = screen.getByTestId('note-paper-chrome-dom');
    expect(chromeMount).toHaveAttribute('data-bp-chrome-mount', '1');
    expect(chromeMount).toHaveAttribute('data-chrome-block-count', '2');
    expect(chromeMount.querySelector(`[${BP_CHROME_ROOT}]`)).toBeTruthy();
    expect(host).not.toBeNull();
    expect(host!.getHandleVisibilityAttr(ID_A)).toBe('hidden');

    // 内容行 hover → chrome model → DomHost sync（chromeTick）
    const row = screen.getByTestId(`note-block-${ID_A}`);
    fireEvent.mouseEnter(row);
    expect(row).toHaveAttribute('data-handle', 'hover');
    expect(host!.getHandleVisibilityAttr(ID_A)).toBe('hover');

    fireEvent.mouseLeave(row);
    expect(row).toHaveAttribute('data-handle', 'hidden');
    expect(host!.getHandleVisibilityAttr(ID_A)).toBe('hidden');
  });

  it('w3f_desktop_skeleton_drop_line_via_host_api', () => {
    let host: BlockChromeDomHost | null = null;
    render(
      <NotePaperPanel
        blockCount={3}
        onChromeDomHost={(h) => {
          host = h;
        }}
      />
    );
    expect(host).not.toBeNull();

    act(() => {
      host!.setDropTarget(ID_B, 'after');
    });
    expect(host!.isDropLineVisible()).toBe(true);
    expect(host!.getDropLineElement().getAttribute(BP_DROP_SIDE)).toBe('after');
    expect(host!.getDropLineElement().getAttribute(BP_DROP_TARGET)).toBe(ID_B);

    // 诚实：真 Pointer 全链未接
    expect(screen.getByTestId('note-paper-chrome-dom')).toHaveAttribute(
      'data-chrome-pointer-chain',
      'deferred'
    );
  });
});

describe('NotePaperStrictPanel · Strict chrome DomHost 挂载', () => {
  it('w3f_desktop_strict_mounts_after_hydrate_ready', async () => {
    let host: BlockChromeDomHost | null = null;
    const slash = new SlashMenuModel();
    const transport = createFixtureHydrateTransport({
      'doc-chrome': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 's1',
            flavour: 'paragraph',
            text: 'strict chrome',
            index: 0,
          }),
          makeHydratedBlock({
            id: 's2',
            flavour: 'code',
            text: 'fn()',
            index: 1,
          }),
        ],
      },
    });

    render(
      <NotePaperStrictPanel
        docId="doc-chrome"
        hydrateTransport={transport}
        slashMenu={slash}
        onChromeDomHost={(h) => {
          host = h;
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const chromeMount = screen.getByTestId('note-paper-strict-chrome-dom');
    expect(chromeMount).toHaveAttribute('data-bp-chrome-mount', '1');
    expect(chromeMount).toHaveAttribute('data-chrome-block-count', '2');
    expect(host).not.toBeNull();
    expect(host!.getRowElement('s1')?.getAttribute('data-flavour')).toBe(
      'paragraph'
    );
    expect(host!.getRowElement('s2')?.getAttribute('data-flavour')).toBe(
      'code'
    );

    // React slash 浮层：open 后可见 catalog；DomHost 宿主让位（projectSlashCatalog=false）
    act(() => {
      expect(slash.open('s1', 0).ok).toBe(true);
      host!.sync();
    });
    // DomHost 不再投影 catalog（防双浮层）；契约标记 react
    expect(host!.isSlashHostVisible()).toBe(false);
    expect(host!.getSlashHostElement().getAttribute('data-slash-catalog')).toBe(
      'react'
    );
    // 产品可见层 = React SlashMenuOverlay
    const reactSlash = await screen.findByTestId(
      'note-paper-strict-slash-overlay'
    );
    expect(reactSlash).toHaveAttribute('data-slash-ui', 'react');
    expect(reactSlash.getAttribute('data-block-id')).toBe('s1');
    expect(
      reactSlash.querySelectorAll('[data-bp-slash-item]').length
    ).toBeGreaterThan(0);
  });
});
