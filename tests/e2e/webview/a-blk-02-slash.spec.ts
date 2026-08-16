/**
 * W6-A-02 · A-BLK-02 真 WebView2 :9222 slash 插入 + composing 不误开
 *
 * 权威：launch-gap/00 §4 行 7；04 原 LR-01（A-BLK-02）。
 *
 * 测头自钉（禁止抬账）：
 *   ≠ EL-01（不得改表 A / 不得写关闭）
 *   ≠ W6-A 全表 e2e（本片只钉 A-BLK-02 slash / IME 不误触）
 *   ≠ 用 jsdom DOM/形状测关本片
 *   ≠ CONN-01 冒烟（不碰 data-hydrate-* 当打开完成）
 *
 * 写锥：产品 `createCollabApplySink` + `note_apply_ops`
 *   （面板 `data-slash-sink-source=product-ipc`）。禁止 mock.calls。
 *
 * 9222 不可达 / 非 WebView2 CDP：`cdp.ts` fail-fast 可读错误
 * （请先 `npm run dev:workbench`；AGENTS §15 禁止 5174 独立浏览器当真产品）。
 * 纸面打不开 / 写锥非产品 / 树未增块：本用例 **失败** 并写明「本切片未交付」——不 skip 伪装绿。
 *
 * 未交付（本机）：9222 被非 WebView2 进程占用（/json/list 404），
 * 未在真壳跑通 slash 增块 / composing 闸。fail-fast 见 cdp.ts，不伪装绿。
 */
import { test, expect, type Page } from '@playwright/test';
import { connectWebView, listCdpTargets } from './cdp';

const PANEL = '[data-testid="note-paper-strict-panel"]';
const OPEN_STRICT = '[data-testid="open-note-paper-strict"]';
const SLASH_OVERLAY = '[data-testid="note-paper-strict-slash-overlay"]';
const SLASH_TRIGGER = '[data-testid="note-paper-strict-open-slash"]';
const TEMP_WS_ID = 'ws-w6a-a-blk-02-probe';

type ProductTree = {
  count: number;
  countAttr: string | null;
  ids: string[];
  flavours: Array<{
    id: string;
    flavour: string | null;
    headingLevel: string | null;
  }>;
};

test.describe('W6-A-02 A-BLK-02 slash 真 WebView（e2e-webview）', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test('w6a_a_blk_02_slash_insert_heading_and_list_grows_tree_stable_block_id', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    const session = await connectWebView();
    let addedTempWs = false;
    try {
      await assertRealWebView(session.page);
      addedTempWs = await ensureStrictPaperOpen(session.page);
      await assertProductWriteCone(session.page);

      const before = await collectTree(session.page);
      await openSlashWithSlashKey(session.page);
      await selectSlashCatalogItem(session.page, 'heading-1');
      const afterHeading = await waitTreeGrew(
        session.page,
        before,
        'heading-1'
      );
      expectHeadingLike(afterHeading.added, afterHeading.tree);

      await openSlashWithSlashKey(session.page);
      await selectSlashCatalogItem(session.page, 'bullet');
      const afterList = await waitTreeGrew(
        session.page,
        afterHeading.tree,
        'bullet'
      );
      expectListLike(afterList.added, afterList.tree);

      for (const id of before.ids) {
        expect(
          afterList.tree.ids,
          `block_id 不稳：二次插入后丢失 ${id}`
        ).toContain(id);
      }
      for (const id of afterHeading.tree.ids) {
        expect(
          afterList.tree.ids,
          `block_id 不稳：list 插入后丢失 heading 块 ${id}`
        ).toContain(id);
      }
    } finally {
      if (addedTempWs) {
        await restoreTempWorkspace(session.page);
      }
      await session.browser.close();
    }
  });

  test('w6a_a_blk_02_ime_no_false_slash', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    const session = await connectWebView();
    let addedTempWs = false;
    try {
      await assertRealWebView(session.page);
      addedTempWs = await ensureStrictPaperOpen(session.page);
      await closeSlashIfOpen(session.page);

      const panel = session.page.locator(PANEL);
      await panel.focus();
      await dispatchComposingSlashKey(session.page);

      await expect(
        session.page.locator(SLASH_OVERLAY),
        '本切片未交付：composing 中 `/` 打开了 slash 菜单（A-IME-02 / A-SIL）'
      ).toHaveCount(0);
      await expect(panel).toHaveAttribute('data-slash-open', 'false');
    } finally {
      if (addedTempWs) {
        await restoreTempWorkspace(session.page);
      }
      await session.browser.close();
    }
  });
});

async function assertRealWebView(page: Page): Promise<void> {
  const internals = await page.evaluate(
    () => typeof (window as Record<string, unknown>).__TAURI_INTERNALS__
  );
  expect(
    internals,
    '本切片未交付：无 __TAURI_INTERNALS__（禁止 5174 独立浏览器当真产品）'
  ).toBe('object');

  const hasE2eHandle = await page.evaluate(() => '__CRISH_E2E__' in window);
  expect(hasE2eHandle, '本切片未交付：检测到 __CRISH_E2E__ mock 沙箱').toBe(
    false
  );

  await expect(page.locator('#root')).toBeVisible({ timeout: 20_000 });
}

/**
 * 打开产品 Strict 纸面。空态 CTA 不可见时，经真实 `__CRISH_LAYOUT_STORE__`
 * 临时挂一个空 columns 工作区（不关用户已有标签）。finally 必须摘掉。
 */
async function ensureStrictPaperOpen(page: Page): Promise<boolean> {
  if ((await page.locator(PANEL).count()) > 0) {
    return false;
  }
  if ((await page.locator(OPEN_STRICT).count()) > 0) {
    await page.locator(OPEN_STRICT).first().click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 20_000 });
    return false;
  }

  const added = await revealEmptyWorkspaceViaStore(page);
  if (!added) {
    throw new Error(
      '本切片未交付：产品空态「打开笔记纸面（Strict）」不可见，且无法经真实 layout store 露出空工作区。请先 npm run dev:workbench 并保证工作区可到空态。'
    );
  }
  await expect(page.locator(OPEN_STRICT).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.locator(OPEN_STRICT).first().click();
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 20_000 });
  return true;
}

async function revealEmptyWorkspaceViaStore(page: Page): Promise<boolean> {
  return page.evaluate((tempId) => {
    const w = window as unknown as {
      __CRISH_LAYOUT_STORE__?: {
        getState: () => {
          workspaces?: Array<{ id: string; columns: unknown[] }>;
          activeWorkspaceIndex: number;
          setActiveWorkspaceIndex?: (index: number) => void;
        };
        setState: (partial: {
          workspaces: Array<{ id: string; columns: unknown[] }>;
          activeWorkspaceIndex: number;
        }) => void;
      };
    };
    const store = w.__CRISH_LAYOUT_STORE__;
    if (!store || typeof store.getState !== 'function') {
      return false;
    }
    const state = store.getState();
    const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
    const existingIdx = workspaces.findIndex((ws) => ws.id === tempId);
    if (existingIdx >= 0) {
      if (typeof state.setActiveWorkspaceIndex === 'function') {
        state.setActiveWorkspaceIndex(existingIdx);
        return true;
      }
      store.setState({
        workspaces,
        activeWorkspaceIndex: existingIdx,
      });
      return true;
    }
    if (typeof store.setState !== 'function') {
      return false;
    }
    const next = workspaces.concat([{ id: tempId, columns: [] }]);
    store.setState({
      workspaces: next,
      activeWorkspaceIndex: next.length - 1,
    });
    return true;
  }, TEMP_WS_ID);
}

async function restoreTempWorkspace(page: Page): Promise<void> {
  await page.evaluate((tempId) => {
    const w = window as unknown as {
      __CRISH_LAYOUT_STORE__?: {
        getState: () => {
          workspaces?: Array<{ id: string; columns: unknown[] }>;
          activeWorkspaceIndex: number;
        };
        setState: (partial: {
          workspaces: Array<{ id: string; columns: unknown[] }>;
          activeWorkspaceIndex: number;
        }) => void;
      };
    };
    const store = w.__CRISH_LAYOUT_STORE__;
    if (!store || typeof store.getState !== 'function') {
      return;
    }
    const state = store.getState();
    const prev = state.workspaces ?? [];
    const workspaces = prev.filter((ws) => ws.id !== tempId);
    if (workspaces.length === prev.length) {
      return;
    }
    const nextIdx = Math.min(
      Math.max(0, state.activeWorkspaceIndex),
      Math.max(0, workspaces.length - 1)
    );
    store.setState({
      workspaces,
      activeWorkspaceIndex: nextIdx,
    });
  }, TEMP_WS_ID);
}

async function assertProductWriteCone(page: Page): Promise<void> {
  const panel = page.locator(PANEL);
  const cone = await panel.evaluate((el) => ({
    mode: el.getAttribute('data-slash-write-mode'),
    source: el.getAttribute('data-slash-sink-source'),
    sink: el.getAttribute('data-slash-sink'),
  }));
  if (
    cone.source !== 'product-ipc' ||
    cone.mode !== 'writable' ||
    cone.sink !== '1'
  ) {
    throw new Error(
      `本切片未交付：slash 写锥不是产品 createCollabApplySink / note_apply_ops` +
        `（data-slash-sink-source=${cone.source} mode=${cone.mode} sink=${cone.sink}）。` +
        `禁止用 mock.calls / injected-sink 关本片。`
    );
  }
}

async function collectTree(page: Page): Promise<ProductTree> {
  return page.locator(PANEL).evaluate((panel) => {
    const countAttr = panel.getAttribute('data-block-count');
    const ids: string[] = [];
    const flavours: Array<{
      id: string;
      flavour: string | null;
      headingLevel: string | null;
    }> = [];
    for (const node of panel.querySelectorAll('[data-block-id]')) {
      if (node.closest('[data-testid="note-paper-strict-slash-overlay"]')) {
        continue;
      }
      const id = node.getAttribute('data-block-id');
      if (!id || ids.includes(id)) {
        continue;
      }
      ids.push(id);
      flavours.push({
        id,
        flavour: node.getAttribute('data-flavour'),
        headingLevel: node.getAttribute('data-heading-level'),
      });
    }
    const parsed = Number(countAttr);
    return {
      count: Number.isFinite(parsed) ? parsed : ids.length,
      countAttr,
      ids,
      flavours,
    };
  });
}

async function openSlashWithSlashKey(page: Page): Promise<void> {
  await closeSlashIfOpen(page);
  const panel = page.locator(PANEL);
  await panel.click({ position: { x: 16, y: 16 } });
  await panel.focus();
  await page.keyboard.press('/');

  const overlay = page.locator(SLASH_OVERLAY);
  if ((await overlay.count()) === 0) {
    // 产品 `/` 按钮与 CONN-B2 键路径同 openProductSlash
    const trigger = page.locator(SLASH_TRIGGER);
    if ((await trigger.count()) > 0) {
      await trigger.first().click();
    }
  }
  if ((await overlay.count()) === 0) {
    throw new Error(
      '本切片未交付：纸面 `/`（键盘或产品 trigger）未打开 slash 浮层。'
    );
  }
  await expect(overlay).toBeVisible({ timeout: 8_000 });
  await expect(overlay).toHaveAttribute('data-slash-write-mode', 'writable');
}

async function selectSlashCatalogItem(
  page: Page,
  itemId: 'heading-1' | 'bullet'
): Promise<void> {
  const item = page.locator(
    `${SLASH_OVERLAY} [data-bp-slash-item][data-item-id="${itemId}"]`
  );
  await expect(item, `本切片未交付：slash catalog 无 ${itemId}`).toBeVisible({
    timeout: 8_000,
  });
  await expect(item).toBeEnabled();
  await item.click();
  await expect(page.locator(SLASH_OVERLAY)).toHaveCount(0, { timeout: 8_000 });
}

async function waitTreeGrew(
  page: Page,
  before: ProductTree,
  catalogItemId: string
): Promise<{ tree: ProductTree; added: string[] }> {
  try {
    await expect
      .poll(
        async () => {
          const tree = await collectTree(page);
          return tree.ids.length > before.ids.length ||
            tree.count > before.count
            ? tree.ids.length
            : 0;
        },
        {
          timeout: 15_000,
          message:
            `本切片未交付：选 ${catalogItemId} 后树未增块` +
            `（插入前 count=${before.count} ids=${before.ids.join(',') || '∅'}）。` +
            `可能：产品 createCollabApplySink 未 allocateId / apply 失败 / hydrate 未读回。`,
        }
      )
      .toBeGreaterThan(before.ids.length);
  } catch (err) {
    const after = await collectTree(page);
    throw new Error(
      `本切片未交付：选 ${catalogItemId} 后树未增块且 block_id 未增加。` +
        `前=${JSON.stringify(before)} 后=${JSON.stringify(after)}。` +
        `sink 须为产品写锥而非 mock.calls。${
          err instanceof Error ? err.message : String(err)
        }`
    );
  }
  const tree = await collectTree(page);
  const added = tree.ids.filter((id) => !before.ids.includes(id));
  if (added.length === 0) {
    throw new Error(
      `本切片未交付：选 ${catalogItemId} 后面板 count 变化但未出现新 data-block-id。` +
        `前=${before.ids.join(',') || '∅'} 后=${tree.ids.join(',') || '∅'}`
    );
  }
  for (const id of before.ids) {
    expect(
      tree.ids,
      `block_id 不稳：插入 ${catalogItemId} 后丢失 ${id}`
    ).toContain(id);
  }
  return { tree, added };
}

function expectHeadingLike(added: string[], tree: ProductTree): void {
  const rows = tree.flavours.filter((row) => added.includes(row.id));
  const ok = rows.some(
    (row) => /heading|^h1$/i.test(row.flavour ?? '') || row.headingLevel === '1'
  );
  if (!ok && rows.length > 0 && rows.every((row) => row.flavour)) {
    throw new Error(
      `本切片未交付：选 heading-1 后新增块 flavour 非标题（${JSON.stringify(rows)}）`
    );
  }
}

function expectListLike(added: string[], tree: ProductTree): void {
  const rows = tree.flavours.filter((row) => added.includes(row.id));
  const ok = rows.some((row) =>
    /bullet|list|ul|ordered/i.test(row.flavour ?? '')
  );
  if (!ok && rows.length > 0 && rows.every((row) => row.flavour)) {
    throw new Error(
      `本切片未交付：选 bullet 后新增块 flavour 非列表（${JSON.stringify(rows)}）`
    );
  }
}

async function closeSlashIfOpen(page: Page): Promise<void> {
  if ((await page.locator(SLASH_OVERLAY).count()) === 0) {
    return;
  }
  await page.keyboard.press('Escape');
  await expect(page.locator(SLASH_OVERLAY)).toHaveCount(0, { timeout: 5_000 });
}

/** 产品双闸第一闸：keydown isComposing=true 不得开菜单 */
async function dispatchComposingSlashKey(page: Page): Promise<void> {
  await page.locator(PANEL).evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '/',
        code: 'Slash',
        bubbles: true,
        cancelable: true,
        composed: true,
        isComposing: true,
      })
    );
  });
}
