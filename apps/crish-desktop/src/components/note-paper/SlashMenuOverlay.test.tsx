// @vitest-environment jsdom
/**
 * SlashMenuOverlay · 真 React slash 浮层可点测
 *
 * ## 轨
 * - catalog 最小集可见；点击 → slash_insert → sink
 * - collab sink 路径不回退 mock 默认
 * - **≠ EL-01**；**≠ A-BLK-02 产品 e2e 满关**；`/` 键触发全路径仍开
 */
import React, { useMemo, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  BP_SLASH_GROUP,
  BP_SLASH_ITEM,
  createCollabApplySink,
  createMockIntentSink,
  DEFAULT_SLASH_CATALOG,
  SlashMenuModel,
  type ApplyOpsAdapter,
  type SlashInsertIntent,
} from '@crish/block-paper';
import { SlashMenuOverlay } from './SlashMenuOverlay';

/** 可控：打开后 bump syncToken 强制重绘 */
function OpenableSlash(props: {
  sink?: ReturnType<typeof createMockIntentSink>['sink'];
  onSelectIntent?: (i: SlashInsertIntent) => void;
  catalogItemToClick?: string;
  autoOpen?: boolean;
}) {
  const menu = useMemo(
    () =>
      new SlashMenuModel({
        createIntentId: () => 'react-slash-1',
      }),
    []
  );
  const [tick, setTick] = useState(0);
  const open = () => {
    expect(menu.open('blk-anchor', 3).ok).toBe(true);
    setTick((n) => n + 1);
  };
  return (
    <div>
      <button type="button" data-testid="open-slash" onClick={open}>
        open
      </button>
      <SlashMenuOverlay
        menu={menu}
        sink={props.sink}
        syncToken={tick}
        onSelectIntent={props.onSelectIntent}
        onClose={() => setTick((n) => n + 1)}
      />
    </div>
  );
}

describe('SlashMenuOverlay · catalog 与可点', () => {
  it('默认关闭：不渲染浮层（L0 零噪声）', () => {
    const menu = new SlashMenuModel();
    render(<SlashMenuOverlay menu={menu} />);
    expect(screen.queryByTestId('note-paper-slash-overlay')).toBeNull();
  });

  it('open 后可见 group/item；catalog 含 heading/list/code/paragraph', () => {
    const menu = new SlashMenuModel();
    expect(menu.open('b1', 0).ok).toBe(true);
    render(<SlashMenuOverlay menu={menu} syncToken={1} />);

    const host = screen.getByTestId('note-paper-slash-overlay');
    expect(host).toHaveAttribute('data-slash-open', '1');
    expect(host).toHaveAttribute('data-slash-ui', 'react');
    expect(host).toHaveAttribute('data-block-id', 'b1');

    const items = host.querySelectorAll(`[${BP_SLASH_ITEM}]`);
    expect(items.length).toBe(DEFAULT_SLASH_CATALOG.length);
    const ids = [...items].map((el) => el.getAttribute('data-item-id'));
    expect(ids).toContain('paragraph');
    expect(ids).toContain('heading-1');
    expect(ids).toContain('bullet');
    expect(ids).toContain('code');

    expect(host.querySelectorAll(`[${BP_SLASH_GROUP}]`).length).toBeGreaterThan(
      0
    );
    // 首项 active
    expect(items[0]).toHaveAttribute('data-active', '1');
  });

  it('点击 heading-1 → slash_insert → mock sink', async () => {
    const mock = createMockIntentSink();
    const seen: SlashInsertIntent[] = [];
    render(
      <OpenableSlash
        sink={mock.sink}
        onSelectIntent={(i) => {
          seen.push(i);
        }}
      />
    );

    fireEvent.click(screen.getByTestId('open-slash'));
    const host = await screen.findByTestId('note-paper-slash-overlay');
    const btn = host.querySelector(
      `[${BP_SLASH_ITEM}][data-item-id="heading-1"]`
    );
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);

    await waitFor(() => {
      expect(mock.calls).toHaveLength(1);
    });
    expect(mock.calls[0]).toMatchObject({
      type: 'slash_insert',
      blockId: 'blk-anchor',
      offset: 3,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
      origin: 'slash',
      intentId: 'react-slash-1',
    });
    expect(seen[0]).toEqual(mock.calls[0]);
    // 选中后关闭
    expect(screen.queryByTestId('note-paper-slash-overlay')).toBeNull();
  });

  it('无 sink 时仍产出 Intent 回调（调用方自行提交）', async () => {
    const seen: SlashInsertIntent[] = [];
    const menu = new SlashMenuModel({
      createIntentId: () => 'no-sink-1',
    });
    expect(menu.open('x', 0).ok).toBe(true);
    render(
      <SlashMenuOverlay
        menu={menu}
        syncToken={1}
        onSelectIntent={(i) => seen.push(i)}
      />
    );
    fireEvent.click(
      screen
        .getByTestId('note-paper-slash-overlay')
        .querySelector(`[${BP_SLASH_ITEM}][data-item-id="code"]`)!
    );
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({
      type: 'slash_insert',
      catalogItemId: 'code',
      flavour: 'code',
    });
  });

  it('点击 → createCollabApplySink（非 mock.calls）', async () => {
    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };
    const collab = createCollabApplySink({
      applyOps,
      allocateId: () => 'react-new-blk',
      resolveOrder: () => 'a0',
    });

    const menu = new SlashMenuModel({
      createIntentId: () => 'react-collab-slash',
    });
    expect(menu.open('anchor', 1).ok).toBe(true);
    render(<SlashMenuOverlay menu={menu} sink={collab.sink} syncToken={1} />);

    fireEvent.click(
      screen
        .getByTestId('note-paper-slash-overlay')
        .querySelector(`[${BP_SLASH_ITEM}][data-item-id="paragraph"]`)!
    );

    await waitFor(() => {
      expect(collab.wireCalls).toHaveLength(1);
    });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('"op":"insert"');
    expect(applied[0]).toContain('react-new-blk');
    expect('calls' in collab).toBe(false);
  });

  it('键盘 ArrowDown + Enter 确认高亮项', async () => {
    const mock = createMockIntentSink();
    const menu = new SlashMenuModel({
      createIntentId: () => 'kbd-slash',
    });
    expect(menu.open('k1', 0).ok).toBe(true);
    render(<SlashMenuOverlay menu={menu} sink={mock.sink} syncToken={1} />);

    // 默认 active=0 paragraph；下移到 heading-1
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() => {
      const host = screen.getByTestId('note-paper-slash-overlay');
      const active = host.querySelector(`[${BP_SLASH_ITEM}][data-active='1']`);
      expect(active?.getAttribute('data-item-id')).toBe('heading-1');
    });

    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(mock.calls).toHaveLength(1));
    expect(mock.calls[0]).toMatchObject({
      type: 'slash_insert',
      catalogItemId: 'heading-1',
    });
  });

  it('Escape 关闭浮层', async () => {
    const menu = new SlashMenuModel();
    expect(menu.open('e1', 0).ok).toBe(true);
    const onClose = vi.fn();
    render(<SlashMenuOverlay menu={menu} syncToken={1} onClose={onClose} />);
    expect(screen.getByTestId('note-paper-slash-overlay')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('note-paper-slash-overlay')).toBeNull();
    });
    expect(menu.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it('过滤无结果 → 空态', () => {
    const menu = new SlashMenuModel();
    expect(menu.open('f1', 0).ok).toBe(true);
    menu.setQuery('___no_match_zzz___');
    render(<SlashMenuOverlay menu={menu} syncToken={1} />);
    const host = screen.getByTestId('note-paper-slash-overlay');
    expect(host.querySelector('[data-bp-slash-empty]')).toBeTruthy();
    expect(host.textContent).toContain('无匹配');
    expect(host.querySelectorAll(`[${BP_SLASH_ITEM}]`).length).toBe(0);
  });

  it('conn_b_readonly_disables_submit_no_silent_apply', async () => {
    const mock = createMockIntentSink();
    const seen: SlashInsertIntent[] = [];
    const menu = new SlashMenuModel({
      createIntentId: () => 'ro-slash',
    });
    expect(menu.open('ro-anchor', 0).ok).toBe(true);
    render(
      <SlashMenuOverlay
        menu={menu}
        sink={mock.sink}
        writeMode="readonly"
        syncToken={1}
        onSelectIntent={(i) => seen.push(i)}
      />
    );

    const host = screen.getByTestId('note-paper-slash-overlay');
    expect(host).toHaveAttribute('data-slash-write-mode', 'readonly');
    expect(
      screen.getByTestId('note-paper-slash-overlay-readonly-banner')
    ).toBeInTheDocument();
    expect(host.getAttribute('aria-disabled')).toBe('true');

    const btn = host.querySelector(
      `[${BP_SLASH_ITEM}][data-item-id="paragraph"]`
    );
    expect(btn).toBeTruthy();
    expect(btn).toBeDisabled();
    fireEvent.click(btn!);

    // 只读：不得 submit / 不得假 apply
    await waitFor(() => {
      expect(mock.calls).toHaveLength(0);
    });
    expect(seen).toHaveLength(0);
    // 菜单仍开（未 select 关闭）
    expect(screen.getByTestId('note-paper-slash-overlay')).toBeInTheDocument();
  });

  it('conn_b_writable_with_sink_submits_on_click', async () => {
    const applied: string[] = [];
    const collab = createCollabApplySink({
      applyOps: async (opsJson) => {
        applied.push(opsJson);
        return { ok: true };
      },
      allocateId: () => 'writable-new',
      resolveOrder: () => 'a0',
    });
    const menu = new SlashMenuModel({
      createIntentId: () => 'wr-slash',
    });
    expect(menu.open('wr-anchor', 1).ok).toBe(true);
    render(
      <SlashMenuOverlay
        menu={menu}
        sink={collab.sink}
        writeMode="writable"
        syncToken={1}
      />
    );
    const host = screen.getByTestId('note-paper-slash-overlay');
    expect(host).toHaveAttribute('data-slash-write-mode', 'writable');
    fireEvent.click(
      host.querySelector(`[${BP_SLASH_ITEM}][data-item-id="paragraph"]`)!
    );
    await waitFor(() => expect(collab.wireCalls).toHaveLength(1));
    expect(applied[0]).toContain('"op":"insert"');
  });
});
