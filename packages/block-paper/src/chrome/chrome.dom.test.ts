/**
 * W3-F DOM 余量 · chrome 最小 DOM 宿主契约（jsdom）。
 *
 * ## 轨声明（诚实）
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | 把手可见性 DOM 属性同步 model | **EL-01** / A-BLK 全表 / Notion chrome 完成 |
 * | 多选框 DOM ↔ multiSelectedIds | A-BLK-05 框选 e2e 全关 |
 * | 落点线 DOM 显隐 / side / target | A-BLK-04 拖拽产品 e2e 全关 |
 * | slash 宿主容器显隐 + catalog 最小投影 | A-BLK-02 slash 浮层产品 e2e 全关 |
 *
 * **DOM 交付 ≠ EL-01**。A-BLK-02/04/05 **产品 e2e 仍开**。
 * **≠** 占 SD-48（不改 DomHost / chromeHostAssembly）。
 *
 * Strict 写路径仍见 `chrome.apply.test.ts`（`createCollabApplySink`）；
 * **不得**因本文件回退 mock 默认。本文件 **不**用 mock.calls 关 Strict。
 *
 * ## SD-57 域拆
 *
 * - 本文件：挂载 + 把手（`w3f_dom_host_*` / `w3f_dom_handle_visibility`）
 * - `chrome.dom.checkbox_drop.test.ts`：多选框 + 落点线
 * - `chrome.dom.slash.test.ts`：slash 宿主 / catalog / empty / 默认 react catalog
 * - `chrome.dom.collab.test.ts`：`w3f_dom_collab_path_intact`
 * - 夹具：`chrome.dom.harness.ts`（仅测用）
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { BlockChromeModel } from './BlockChrome';
import {
  BlockChromeDomHost,
  BP_DROP_LINE,
  BP_HANDLE_VISIBILITY,
  BP_MULTI_CHECK,
  isBlockChromeDomHost,
} from './BlockChromeDomHost';
import { resetIntentIdSeqForTests } from '../intentId';
import { ID_A, ID_B, ID_C, requireDocument } from './chrome.dom.harness';

describe('W3-F DOM · BlockChromeDomHost 挂载', () => {
  let mount: HTMLElement;
  let chrome: BlockChromeModel;
  let host: BlockChromeDomHost;

  beforeEach(() => {
    resetIntentIdSeqForTests();
    const doc = requireDocument();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
    chrome = new BlockChromeModel();
    host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }, { blockId: ID_B }, { blockId: ID_C }],
      chrome,
    });
  });

  afterEach(() => {
    host.destroy();
    mount.remove();
  });

  it('w3f_dom_host_mount: root/行/把手/多选框/落点线节点存在', () => {
    expect(isBlockChromeDomHost(host)).toBe(true);
    expect(host.getRootElement().getAttribute('data-bp-chrome-root')).toBe('1');
    expect(host.getRowElement(ID_A)).toBeTruthy();
    expect(host.getHandleElement(ID_A)).toBeTruthy();
    expect(
      host.getRootElement().querySelector(`[${BP_MULTI_CHECK}]`)
    ).toBeTruthy();
    expect(
      host.getRootElement().querySelector(`[${BP_DROP_LINE}]`)
    ).toBeTruthy();
  });

  it('w3f_dom_host_flavour_attr: 可选 flavour → data-flavour（呈现皮锚定）', () => {
    host.destroy();
    mount.remove();
    const doc = requireDocument();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
    chrome = new BlockChromeModel();
    host = new BlockChromeDomHost(mount, {
      blocks: [
        { blockId: ID_A, flavour: 'code' },
        { blockId: ID_B, flavour: 'quote' },
      ],
      chrome,
    });
    expect(host.getRowElement(ID_A)?.getAttribute('data-flavour')).toBe('code');
    expect(host.getRowElement(ID_B)?.getAttribute('data-flavour')).toBe(
      'quote'
    );
    // 未传 flavour 的行不强制属性（另挂一宿主验证）
    host.destroy();
    mount.remove();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
    host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_C }],
      chrome: new BlockChromeModel(),
    });
    expect(host.getRowElement(ID_C)?.hasAttribute('data-flavour')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 把手可见性 DOM
// ---------------------------------------------------------------------------

describe('W3-F DOM · 把手可见性', () => {
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

  it('w3f_dom_handle_visibility: L0 默认 hidden；hover/focus/multi 同步 data-handle-visibility', () => {
    // L0 默认无交互 → hidden
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('hidden');
    expect(host.getHandleElement(ID_A)?.hidden).toBe(true);

    chrome.setHovered(ID_A);
    host.sync();
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('hover');
    expect(
      host.getHandleElement(ID_A)?.getAttribute(BP_HANDLE_VISIBILITY)
    ).toBe('hover');
    expect(host.getHandleElement(ID_A)?.hidden).toBe(false);
    expect(host.getHandleVisibilityAttr(ID_B)).toBe('hidden');

    chrome.setFocused(ID_B);
    host.sync();
    expect(host.getHandleVisibilityAttr(ID_B)).toBe('focus');

    chrome.setMultiSelected([ID_A]);
    host.sync();
    // multi 优先于 hover
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('multi');

    chrome.resetToSilent();
    host.sync();
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('hidden');
    expect(host.getHandleVisibilityAttr(ID_B)).toBe('hidden');
  });
});
