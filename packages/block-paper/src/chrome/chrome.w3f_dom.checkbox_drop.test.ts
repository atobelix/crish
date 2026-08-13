/**
 * W3-F DOM 余量 · 多选框 + 落点线（jsdom）。
 *
 * **DOM 交付 ≠ EL-01**。A-BLK-04/05 产品 e2e 仍开。**≠** 占 SD-48。
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { BlockChromeModel } from './BlockChrome';
import {
  BlockChromeDomHost,
  BP_DROP_SIDE,
  BP_DROP_TARGET,
  BP_MULTI_CHECK,
} from './BlockChromeDomHost';
import { ID_A, ID_B, ID_C, requireDocument } from './chrome.w3f_dom.harness';

// ---------------------------------------------------------------------------
// 多选框 DOM
// ---------------------------------------------------------------------------

describe('W3-F DOM · 多选框', () => {
  let mount: HTMLElement;
  let chrome: BlockChromeModel;
  let host: BlockChromeDomHost;
  let multiLog: string[][];

  beforeEach(() => {
    multiLog = [];
    const doc = requireDocument();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
    chrome = new BlockChromeModel();
    host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }, { blockId: ID_B }, { blockId: ID_C }],
      chrome,
      onMultiSelectionChange: (ids) => {
        multiLog.push([...ids]);
      },
    });
  });

  afterEach(() => {
    host.destroy();
    mount.remove();
  });

  it('w3f_dom_multi_checkbox: setMultiSelected → checkbox checked + handle multi', () => {
    expect(host.isMultiCheckboxChecked(ID_A)).toBe(false);
    expect(host.isMultiCheckboxChecked(ID_B)).toBe(false);

    chrome.setMultiSelected([ID_B, ID_A]);
    host.sync();

    expect(host.isMultiCheckboxChecked(ID_A)).toBe(true);
    expect(host.isMultiCheckboxChecked(ID_B)).toBe(true);
    expect(host.isMultiCheckboxChecked(ID_C)).toBe(false);
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('multi');
    expect(host.getHandleVisibilityAttr(ID_B)).toBe('multi');
  });

  it('w3f_dom_multi_checkbox_toggle: DOM 勾选回写 model 保序', () => {
    const checkA = host
      .getRowElement(ID_A)!
      .querySelector<HTMLInputElement>(`input[${BP_MULTI_CHECK}]`)!;
    const checkC = host
      .getRowElement(ID_C)!
      .querySelector<HTMLInputElement>(`input[${BP_MULTI_CHECK}]`)!;

    checkA.checked = true;
    checkA.dispatchEvent(new Event('change', { bubbles: true }));
    expect(chrome.getSnapshot().multiSelectedIds).toEqual([ID_A]);
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('multi');

    checkC.checked = true;
    checkC.dispatchEvent(new Event('change', { bubbles: true }));
    // 保序 = blockOrder：A 然后 C
    expect(chrome.getSnapshot().multiSelectedIds).toEqual([ID_A, ID_C]);
    expect(multiLog.at(-1)).toEqual([ID_A, ID_C]);

    checkA.checked = false;
    checkA.dispatchEvent(new Event('change', { bubbles: true }));
    expect(chrome.getSnapshot().multiSelectedIds).toEqual([ID_C]);
  });
});

// ---------------------------------------------------------------------------
// 落点线 DOM
// ---------------------------------------------------------------------------

describe('W3-F DOM · 落点线', () => {
  let mount: HTMLElement;
  let chrome: BlockChromeModel;
  let host: BlockChromeDomHost;

  beforeEach(() => {
    const doc = requireDocument();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
    chrome = new BlockChromeModel();
    host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }, { blockId: ID_B }],
      chrome,
    });
  });

  afterEach(() => {
    host.destroy();
    mount.remove();
  });

  it('w3f_dom_drop_line: setDropTarget → 落点线可见且 data-drop-side/target 正确', () => {
    expect(host.isDropLineVisible()).toBe(false);
    expect(host.getDropTarget()).toBeNull();

    host.setDropTarget(ID_B, 'before');
    expect(host.isDropLineVisible()).toBe(true);
    expect(host.getDropTarget()).toEqual({ blockId: ID_B, side: 'before' });

    const line = host.getDropLineElement();
    expect(line.getAttribute(BP_DROP_SIDE)).toBe('before');
    expect(line.getAttribute(BP_DROP_TARGET)).toBe(ID_B);
    expect(line.hidden).toBe(false);

    // DOM 序：落点线紧邻目标行之前
    const rowB = host.getRowElement(ID_B)!;
    expect(line.nextSibling).toBe(rowB);

    host.setDropTarget(ID_A, 'after');
    expect(line.getAttribute(BP_DROP_SIDE)).toBe('after');
    expect(line.getAttribute(BP_DROP_TARGET)).toBe(ID_A);
    const rowA = host.getRowElement(ID_A)!;
    expect(rowA.nextSibling).toBe(line);

    host.clearDropTarget();
    expect(host.isDropLineVisible()).toBe(false);
    expect(host.getDropTarget()).toBeNull();
    expect(line.getAttribute(BP_DROP_SIDE)).toBe('');
    expect(line.getAttribute(BP_DROP_TARGET)).toBe('');
  });

  it('w3f_dom_drop_line_unknown_block: 未知 blockId → 落点隐藏', () => {
    host.setDropTarget('not-in-list', 'before');
    expect(host.isDropLineVisible()).toBe(false);
    expect(host.getDropTarget()).toBeNull();
  });
});
