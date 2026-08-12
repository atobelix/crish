// @vitest-environment jsdom
/**
 * CONN-B2 · 产品 slash 打开路径
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | openProductSlash / `/` 键可测打开 | EL-01 / A-BLK-02 e2e / IME WebView 满关 |
 * | composing 拒开（事件 + model） | 完整叶子 caret offset 产品追踪 |
 * | 打开后仍服从 B1 writeMode binding | 打开即 mock 默认可写 |
 * | DomHost catalog 关由挂载面保证 | 本文件关双浮层全矩阵 |
 */
import { describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React, { useMemo, useState } from 'react';
import {
  createMockIntentSink,
  SlashMenuModel,
  type ApplyOpsAdapter,
} from '@crish/block-paper';
import {
  handleProductSlashKeydown,
  isNativeFormFieldTarget,
  isProductSlashOpenKey,
  isWithinProductSlashFocusContext,
  openProductSlash,
  resolveProductSlashAnchor,
  tryOpenProductSlashFromKey,
} from './productSlashOpen';
import { createProductStrictSlashBinding } from './productSlashSink';
import { SlashMenuOverlay } from './SlashMenuOverlay';
import { BP_SLASH_ITEM } from '@crish/block-paper';

// ---------------------------------------------------------------------------
// resolveProductSlashAnchor
// ---------------------------------------------------------------------------

describe('resolveProductSlashAnchor · CONN-B2', () => {
  it('conn_b2_anchor_prefers_focused_then_first_block', () => {
    expect(
      resolveProductSlashAnchor({
        focusedBlockId: 'focus-1',
        blocks: [{ id: 'b0' }, { id: 'b1' }],
        docId: 'd1',
      })
    ).toBe('focus-1');

    expect(
      resolveProductSlashAnchor({
        focusedBlockId: null,
        blocks: [{ id: 'b0' }, { id: 'b1' }],
        docId: 'd1',
      })
    ).toBe('b0');

    expect(
      resolveProductSlashAnchor({
        blocks: [],
        docId: 'doc-x',
      })
    ).toBe('slash-anchor-doc-x');

    expect(resolveProductSlashAnchor({})).toBe('slash-anchor');
  });
});

// ---------------------------------------------------------------------------
// openProductSlash
// ---------------------------------------------------------------------------

describe('openProductSlash · CONN-B2', () => {
  it('conn_b2_openSlash_blockId_offset_opens_menu', () => {
    const menu = new SlashMenuModel();
    const r = openProductSlash({
      menu,
      blockId: 'blk-a',
      offset: 4,
    });
    expect(r.ok).toBe(true);
    expect(menu.isOpen()).toBe(true);
    const snap = menu.getSnapshot();
    expect(snap.blockId).toBe('blk-a');
    expect(snap.offset).toBe(4);
    expect(snap.open).toBe(true);
  });

  it('conn_b2_openSlash_composing_rejects', () => {
    let composing = true;
    const menu = new SlashMenuModel({
      isComposing: () => composing,
    });
    const r = openProductSlash({ menu, blockId: 'blk-c' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('composing');
      expect(r.reason).toMatch(/composing|IME/i);
    }
    expect(menu.isOpen()).toBe(false);

    composing = false;
    const r2 = openProductSlash({ menu, blockId: 'blk-c', offset: 1 });
    expect(r2.ok).toBe(true);
    expect(menu.getSnapshot().offset).toBe(1);
  });

  it('conn_b2_openSlash_invalid_anchor_rejects', () => {
    const menu = new SlashMenuModel();
    const r = openProductSlash({ menu, blockId: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_anchor');
  });

  it('conn_b2_openSlash_already_open_rejects', () => {
    const menu = new SlashMenuModel();
    expect(openProductSlash({ menu, blockId: 'a' }).ok).toBe(true);
    const r = openProductSlash({ menu, blockId: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('already_open');
  });
});

// ---------------------------------------------------------------------------
// isProductSlashOpenKey / form / focus
// ---------------------------------------------------------------------------

describe('isProductSlashOpenKey · CONN-B2', () => {
  it('conn_b2_slash_key_bare_accepted', () => {
    expect(isProductSlashOpenKey({ key: '/' })).toBe(true);
    expect(isProductSlashOpenKey({ key: '/', shiftKey: true })).toBe(true);
  });

  it('conn_b2_slash_key_mods_and_composing_rejected', () => {
    expect(isProductSlashOpenKey({ key: '/', ctrlKey: true })).toBe(false);
    expect(isProductSlashOpenKey({ key: '/', metaKey: true })).toBe(false);
    expect(isProductSlashOpenKey({ key: '/', altKey: true })).toBe(false);
    expect(isProductSlashOpenKey({ key: '/', isComposing: true })).toBe(false);
    expect(isProductSlashOpenKey({ key: 'Process' })).toBe(false);
    expect(isProductSlashOpenKey({ key: '/', keyCode: 229 })).toBe(false);
    expect(isProductSlashOpenKey({ key: 'a' })).toBe(false);
  });

  it('conn_b2_native_form_field_detect', () => {
    const input = document.createElement('input');
    const div = document.createElement('div');
    div.contentEditable = 'true';
    expect(isNativeFormFieldTarget(input)).toBe(true);
    expect(isNativeFormFieldTarget(div)).toBe(false);
    expect(isNativeFormFieldTarget(null)).toBe(false);
  });

  it('conn_b2_focus_context_within_surface', () => {
    const root = document.createElement('div');
    const child = document.createElement('span');
    root.appendChild(child);
    document.body.appendChild(root);
    expect(isWithinProductSlashFocusContext(root, child)).toBe(true);
    expect(isWithinProductSlashFocusContext(root, document.body)).toBe(false);
    expect(isWithinProductSlashFocusContext(null, document.body)).toBe(true);
    root.remove();
  });
});

// ---------------------------------------------------------------------------
// handleProductSlashKeydown
// ---------------------------------------------------------------------------

describe('handleProductSlashKeydown · CONN-B2', () => {
  it('conn_b2_keydown_slash_opens_menu', () => {
    const menu = new SlashMenuModel();
    const preventDefault = vi.fn();
    const r = handleProductSlashKeydown(
      { key: '/', preventDefault },
      { menu, blockId: 'k-blk', offset: 2 }
    );
    expect(r.ok).toBe(true);
    expect(menu.isOpen()).toBe(true);
    expect(menu.getSnapshot().blockId).toBe('k-blk');
    expect(menu.getSnapshot().offset).toBe(2);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('conn_b2_keydown_composing_rejects_no_open', () => {
    const menu = new SlashMenuModel();
    const r = handleProductSlashKeydown(
      { key: '/', isComposing: true },
      { menu, blockId: 'c-blk' }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ignored');
    expect(menu.isOpen()).toBe(false);
  });

  it('conn_b2_keydown_model_composing_rejects', () => {
    const menu = new SlashMenuModel({ isComposing: () => true });
    const r = handleProductSlashKeydown(
      { key: '/' },
      { menu, blockId: 'mc-blk' }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('composing');
    expect(menu.isOpen()).toBe(false);
  });

  it('conn_b2_keydown_form_field_ignored', () => {
    const menu = new SlashMenuModel();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const r = handleProductSlashKeydown(
      { key: '/', target: input },
      { menu, blockId: 'f-blk' }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ignored');
    expect(menu.isOpen()).toBe(false);
    input.remove();
  });

  it('conn_b2_keydown_outside_surface_ignored', () => {
    const menu = new SlashMenuModel();
    const root = document.createElement('div');
    const outside = document.createElement('div');
    document.body.append(root, outside);
    const r = handleProductSlashKeydown(
      { key: '/', target: outside },
      { menu, blockId: 's-blk', surfaceRoot: root }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ignored');
    expect(menu.isOpen()).toBe(false);
    root.remove();
    outside.remove();
  });

  it('conn_b2_tryOpen_resolves_anchor_from_blocks', () => {
    const menu = new SlashMenuModel();
    const r = tryOpenProductSlashFromKey(
      { key: '/' },
      {
        menu,
        anchor: {
          blocks: [{ id: 'first-blk' }],
          docId: 'd',
        },
      }
    );
    expect(r.ok).toBe(true);
    expect(menu.getSnapshot().blockId).toBe('first-blk');
  });
});

// ---------------------------------------------------------------------------
// 与 B1 串联：打开后 writeMode 服从 binding
// ---------------------------------------------------------------------------

describe('productSlashOpen × B1 binding · CONN-B2', () => {
  function OpenHarness(props: {
    writeMode: 'readonly' | 'writable';
    sink?: ReturnType<typeof createMockIntentSink>['sink'];
    menu: SlashMenuModel;
  }) {
    const [tick, setTick] = useState(0);
    return (
      <div data-testid="harness-root" tabIndex={-1}>
        <button
          type="button"
          data-testid="harness-open-explicit"
          data-slash-open-trigger="1"
          onClick={() => {
            const r = openProductSlash({
              menu: props.menu,
              blockId: 'b1-anchor',
              offset: 0,
            });
            if (r.ok) setTick((n) => n + 1);
          }}
        >
          open
        </button>
        <SlashMenuOverlay
          menu={props.menu}
          sink={props.sink}
          writeMode={props.writeMode}
          syncToken={tick}
          testId="b2-slash-overlay"
        />
      </div>
    );
  }

  it('conn_b2_open_then_readonly_binding_no_submit', async () => {
    const binding = createProductStrictSlashBinding();
    expect(binding.mode).toBe('readonly');
    expect(binding.sink).toBeUndefined();

    const menu = new SlashMenuModel({
      createIntentId: () => 'b2-ro-1',
    });
    render(
      <OpenHarness menu={menu} writeMode={binding.mode} sink={binding.sink} />
    );

    fireEvent.click(screen.getByTestId('harness-open-explicit'));
    const overlay = await screen.findByTestId('b2-slash-overlay');
    expect(overlay).toHaveAttribute('data-slash-write-mode', 'readonly');
    expect(
      screen.getByTestId('b2-slash-overlay-readonly-banner')
    ).toBeInTheDocument();

    const item = overlay.querySelector(
      `[${BP_SLASH_ITEM}][data-item-id="paragraph"]`
    );
    expect(item).toBeTruthy();
    fireEvent.click(item!);
    // 只读：仍开着，未假提交关闭
    expect(screen.getByTestId('b2-slash-overlay')).toBeInTheDocument();
    expect(menu.isOpen()).toBe(true);
  });

  it('conn_b2_open_then_writable_binding_submits', async () => {
    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };
    const binding = createProductStrictSlashBinding({
      applyOps,
      allocateId: () => 'b2-new-id',
      resolveOrder: () => 'a0',
    });
    expect(binding.mode).toBe('writable');
    expect(binding.collab).not.toBeNull();

    const menu = new SlashMenuModel({
      createIntentId: () => 'b2-wr-1',
    });
    render(
      <OpenHarness menu={menu} writeMode={binding.mode} sink={binding.sink} />
    );

    // 键盘 `/` 路径打开（act 包住 model→Overlay 订阅更新）
    const root = screen.getByTestId('harness-root');
    root.focus();
    act(() => {
      const keyResult = handleProductSlashKeydown(
        { key: '/', target: root, preventDefault: () => undefined },
        { menu, blockId: 'b1-anchor', offset: 0, surfaceRoot: root }
      );
      expect(keyResult.ok).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('b2-slash-overlay')).toBeInTheDocument();
    });

    const overlay = screen.getByTestId('b2-slash-overlay');
    expect(overlay).toHaveAttribute('data-slash-write-mode', 'writable');

    fireEvent.click(
      overlay.querySelector(`[${BP_SLASH_ITEM}][data-item-id="paragraph"]`)!
    );

    await waitFor(() => {
      expect(binding.collab!.wireCalls.length).toBeGreaterThanOrEqual(1);
    });
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect(applied[0]).toContain('b2-new-id');
  });

  it('conn_b2_keydown_on_surface_opens_overlay_visible', async () => {
    const menu = new SlashMenuModel();

    function Surf() {
      const m = useMemo(() => menu, []);
      const [tick, setTick] = useState(0);
      return (
        <div
          data-testid="surf"
          tabIndex={0}
          onKeyDown={(e) => {
            const r = tryOpenProductSlashFromKey(e.nativeEvent, {
              menu: m,
              anchor: { blocks: [{ id: 'surf-blk' }] },
              surfaceRoot: e.currentTarget,
            });
            if (r.ok) setTick((n) => n + 1);
          }}
        >
          <SlashMenuOverlay
            menu={m}
            writeMode="readonly"
            syncToken={tick}
            testId="surf-ov"
          />
        </div>
      );
    }

    render(<Surf />);
    const surf = screen.getByTestId('surf');
    surf.focus();
    fireEvent.keyDown(surf, { key: '/', code: 'Slash' });
    expect(await screen.findByTestId('surf-ov')).toHaveAttribute(
      'data-slash-write-mode',
      'readonly'
    );
    expect(menu.isOpen()).toBe(true);
    expect(menu.getSnapshot().blockId).toBe('surf-blk');
  });
});
