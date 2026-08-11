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
 * | slash 宿主容器显隐 | A-BLK-02 slash 浮层产品 e2e 全关 |
 *
 * **DOM 交付 ≠ EL-01**。A-BLK-02/04/05 **产品 e2e 仍开**。
 *
 * Strict 写路径仍见 `chrome.w3f_apply.test.ts`（`createCollabApplySink`）；
 * **不得**因本文件回退 mock 默认。本文件 **不**用 mock.calls 关 Strict。
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { BlockChromeModel } from './BlockChrome';
import { SlashMenuModel } from './SlashMenuModel';
import {
  BlockChromeDomHost,
  BP_DROP_LINE,
  BP_DROP_SIDE,
  BP_DROP_TARGET,
  BP_HANDLE_VISIBILITY,
  BP_MULTI_CHECK,
  BP_SLASH_HOST,
  BP_SLASH_OPEN,
  isBlockChromeDomHost,
} from './BlockChromeDomHost';
import {
  createCollabApplySink,
  submitIntent,
  type ApplyOpsAdapter,
} from '../leaves/intentBridge';
import { resetIntentIdSeqForTests } from '../leaves/TextLeafModel';

const ID_A = 'block-dom-a';
const ID_B = 'block-dom-b';
const ID_C = 'block-dom-c';

function requireDocument(): Document {
  if (typeof document === 'undefined' || !document.createElement) {
    throw new Error('jsdom document 不可用');
  }
  return document;
}

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

// ---------------------------------------------------------------------------
// slash 宿主 DOM
// ---------------------------------------------------------------------------

describe('W3-F DOM · slash 宿主', () => {
  let mount: HTMLElement;
  let chrome: BlockChromeModel;
  let slash: SlashMenuModel;
  let host: BlockChromeDomHost;

  beforeEach(() => {
    const doc = requireDocument();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
    chrome = new BlockChromeModel();
    slash = new SlashMenuModel();
    host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }],
      chrome,
      slash,
    });
  });

  afterEach(() => {
    host.destroy();
    mount.remove();
  });

  it('w3f_dom_slash_host: open → 宿主可见；close → hidden', () => {
    const el = host.getSlashHostElement();
    expect(host.isSlashHostVisible()).toBe(false);
    expect(el.getAttribute(BP_SLASH_OPEN)).toBe('0');
    expect(el.getAttribute(BP_SLASH_HOST)).toBe('1');

    expect(slash.open(ID_A, 2).ok).toBe(true);
    host.sync();
    expect(host.isSlashHostVisible()).toBe(true);
    expect(el.getAttribute(BP_SLASH_OPEN)).toBe('1');
    expect(el.getAttribute('data-block-id')).toBe(ID_A);

    slash.close();
    host.sync();
    expect(host.isSlashHostVisible()).toBe(false);
    expect(el.getAttribute(BP_SLASH_OPEN)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// DOM 与 Strict collab 写路径不互斥（DOM 不回退 mock）
// ---------------------------------------------------------------------------

describe('W3-F DOM · 与 collab Strict 共存', () => {
  it('w3f_dom_collab_path_intact: 多选删除仍走 createCollabApplySink（非 mock.calls）', async () => {
    resetIntentIdSeqForTests();
    const doc = requireDocument();
    const mount = doc.createElement('div');
    doc.body.appendChild(mount);

    const chrome = new BlockChromeModel({
      createIntentId: () => 'w3f-dom-del-collab',
    });
    const host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }, { blockId: ID_B }],
      chrome,
    });

    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };
    const collab = createCollabApplySink({ applyOps });

    chrome.setMultiSelected([ID_A, ID_B]);
    host.sync();
    expect(host.isMultiCheckboxChecked(ID_A)).toBe(true);
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('multi');

    const del = chrome.requestDeleteSelected();
    expect(del.ok).toBe(true);
    if (!del.ok) return;

    const submitted = await submitIntent(del.intent, collab.sink);
    expect(submitted.ok).toBe(true);
    expect(collab.wireCalls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('"op":"delete"');
    expect(applied[0]).toContain(ID_A);
    // 叙事：本路径无 mock.calls
    expect('calls' in collab).toBe(false);
    expect('wireCalls' in collab).toBe(true);

    host.sync();
    // 删除 Intent 成功后 model 清多选 → DOM 收敛
    expect(host.isMultiCheckboxChecked(ID_A)).toBe(false);
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('hidden');

    host.destroy();
    mount.remove();
  });
});
