/**
 * W3-F DOM 余量 · slash 宿主 / catalog / 默认 react catalog（jsdom）。
 *
 * **DOM 交付 ≠ EL-01**。A-BLK-02 slash 浮层产品 e2e 仍开。**≠** 占 SD-48。
 * catalog 默认 false 钉：`w3f_dom_slash_default_react_catalog`。
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { BlockChromeModel } from './BlockChrome';
import { SlashMenuModel } from './SlashMenuModel';
import {
  BlockChromeDomHost,
  BP_SLASH_EMPTY,
  BP_SLASH_GROUP,
  BP_SLASH_HOST,
  BP_SLASH_ITEM,
  BP_SLASH_OPEN,
} from './BlockChromeDomHost';
import { ID_A, requireDocument } from './chrome.dom.harness';

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
    // SD-03：catalog 投影须显式 true（默认 false 防产品双浮层）
    host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }],
      chrome,
      slash,
      projectSlashCatalog: true,
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

  it('w3f_dom_slash_catalog: open → group/item 投影；active 对齐；close 清空', () => {
    const el = host.getSlashHostElement();
    expect(slash.open(ID_A, 0).ok).toBe(true);
    host.sync();

    // 默认 catalog 有分组（基础 / 列表 / 高级）
    const groups = el.querySelectorAll(`[${BP_SLASH_GROUP}]`);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups[0]?.getAttribute(BP_SLASH_GROUP)).toBeTruthy();

    const items = el.querySelectorAll(`[${BP_SLASH_ITEM}]`);
    expect(items.length).toBeGreaterThanOrEqual(3);
    // activeIndex 0 → 首项 data-active=1
    expect(items[0]?.getAttribute('data-active')).toBe('1');
    expect(items[0]?.getAttribute('aria-selected')).toBe('true');
    expect(items[1]?.getAttribute('data-active')).toBe('0');

    // 标题 / 描述结构
    expect(
      items[0]?.querySelector('.bp-slash-item-title')?.textContent
    ).toBeTruthy();
    expect(items[0]?.querySelector('.bp-slash-item-icon')).toBeTruthy();

    // 键盘高亮移动
    slash.moveActive(1);
    host.sync();
    const items2 = el.querySelectorAll(`[${BP_SLASH_ITEM}]`);
    expect(items2[0]?.getAttribute('data-active')).toBe('0');
    expect(items2[1]?.getAttribute('data-active')).toBe('1');
    expect(el.getAttribute('aria-activedescendant')).toBe(
      items2[1]?.id ?? null
    );

    // close → 子节点清空 + hidden
    slash.close();
    host.sync();
    expect(host.isSlashHostVisible()).toBe(false);
    expect(el.children.length).toBe(0);
  });

  it('w3f_dom_slash_empty: 过滤无结果 → 空态节点', () => {
    const el = host.getSlashHostElement();
    expect(slash.open(ID_A, 0).ok).toBe(true);
    slash.setQuery('___no_match_zzz___');
    host.sync();

    expect(host.isSlashHostVisible()).toBe(true);
    const empty = el.querySelector(`[${BP_SLASH_EMPTY}]`);
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain('无匹配');
    expect(el.querySelectorAll(`[${BP_SLASH_ITEM}]`).length).toBe(0);
  });

  it('w3f_dom_slash_default_react_catalog: 默认不投影 item（data-slash-catalog=react）', () => {
    host.destroy();
    mount.remove();
    const doc = requireDocument();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
    chrome = new BlockChromeModel();
    slash = new SlashMenuModel();
    // 默认 projectSlashCatalog=false
    host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }],
      chrome,
      slash,
    });

    expect(slash.open(ID_A, 0).ok).toBe(true);
    host.sync();

    const el = host.getSlashHostElement();
    expect(host.isSlashHostVisible()).toBe(false);
    expect(el.getAttribute('data-slash-catalog')).toBe('react');
    expect(el.querySelectorAll(`[${BP_SLASH_ITEM}]`).length).toBe(0);
    expect(el.querySelectorAll(`[${BP_SLASH_GROUP}]`).length).toBe(0);
    expect(el.children.length).toBe(0);
  });
});
