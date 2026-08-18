/**
 * CONN-03 · B3-e2e · 真 WebView slash 一点通（e2e-webview project）
 *
 * 权威：docs/review-md-audit/2026-08-13-wave/plans/D-07-维度详案-连通余量.md §1.4。
 * 依赖 CONN-01 基建（cdp.ts / playwright.config.ts / webview-smoke.spec.ts）。
 * 到达 = 扩展 note 叶（openNoteLeaf：产品钮 / 真 openTool / 树门面）。
 *
 * 文件命名说明：e2e-webview config 的 testMatch 为
 * `/(webview-smoke|mirror-detect|a-blk-02-slash|conn-b3-e2e|conn-g2-e2e)\.spec\.ts$/`；
 * 本 spec 与 a-blk-02-slash / conn-g2-e2e 同批落入「需真 Tauri 的 WebView spec」
 * 发现面，
 * 使 `npm run test:e2e:webview -- --grep conn_b3|conn_g2` 可直接发现并执行。
 *
 * 用例清单：
 * - conn_b3_e2e_product_slash_writes：扩展 note 叶打开 Strict → 裸 `/`（或产品
 *   按钮）打开 slash → 选 heading-1 → 产品写锥（createCollabApplySink →
 *   note_apply_ops 真 IPC）落地 → 投影读回（data-block-count / data-rev 前进，
 *   新 data-block-id 出现）。全链一条用例。
 * - conn_b3_e2e_no_tauri_readonly：CDP Runtime.evaluate 移除
 *   __TAURI_INTERNALS__/__TAURI__/isTauri → reload → 断言
 *   data-slash-write-mode=readonly（禁提交灰态）。若 WebView2 宿主 preload
 *   恒定重注入宿主全局（真壳不可造无宿主场景），按惯例
 *   skip=真壳不可造无宿主并写明原因；readonly 灰态主交付面在 jsdom
 *   `WorkspaceEmptyState.conn-b3.test.tsx`（既有断言不回退）。**不 mock**。
 *   strip 成功后同样走 openNoteLeaf（无宿主仍须见到叶+面板，写锥才是 readonly）。
 *
 * 诚实边界句（D-07 §1.4，禁止删除）：
 *   ≠ EL-01；≠ 打开完成；≠ A-BLK-08/09 e2e；
 *   真 WebView 用例的 apply 前提是后端 doc-session 可写可读——若真 IPC apply
 *   后端行为与预期不符（err_outcome），用例失败并写明，**禁止**用 fixture/mock
 *   掩盖后端缺口；真 WebView 读回 ≠ DocSession 全链 apply。
 *
 * 运行前置：npm run dev:workbench（WebView2 带 9222）。9222 不可达 →
 * cdp.ts fail-fast 可读错误（AGENTS.md §15：禁止 5174 独立浏览器当真产品）。
 * 真跑若环境不可用（Tauri 未启动）：用例在 listCdpTargets 处 fail-fast，
 * 如实标注，不伪装绿。
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { connectWebView, listCdpTargets } from './cdp';
import {
  PANEL,
  SLASH_OVERLAY,
  SLASH_TRIGGER,
  assertRealWebView,
  closeNoteLeafIfOpen,
  openNoteLeaf,
} from './arrive-note-leaf';

type StrictWriteCone = {
  mode: string | null;
  source: string | null;
  sink: string | null;
  hydrateSource: string | null;
  hydrateStatus: string | null;
};

test.describe('CONN-03 B3-e2e slash 一点通真 WebView（e2e-webview）', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('conn_b3_e2e_product_slash_writes', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    const session = await connectWebView();
    try {
      await assertRealWebView(session.page);
      await openNoteLeaf(session.page);

      // ① 写锥连通性探测（冒烟级）：产品默认可写必须是 product-ipc（真 IPC），
      //    禁止 injected-sink / mock 当生产默认可写叙事
      const cone = await readWriteCone(session.page);
      if (
        cone.mode !== 'writable' ||
        cone.source !== 'product-ipc' ||
        cone.sink !== '1'
      ) {
        throw new Error(
          `本切片未交付：slash 写锥非产品 product-ipc（mode=${cone.mode} ` +
            `source=${cone.source} sink=${cone.sink}）。禁止用 mock IPC / ` +
            `injected-sink 当生产默认可写。`
        );
      }

      // ② 裸 `/` 打开（键盘路径；CONN-B2 双闸）——产品按钮为回落
      const before = await collectTree(session.page);
      await openSlash(session.page, 'writable');

      // ③ 选择 heading-1 → sink 落地 → apply（真 IPC）
      await selectSlashCatalogItem(session.page, 'heading-1');

      // ④ 投影读回：同 doc hydrate 前进（新块 + count 增长）
      await waitTreeGrew(session.page, before, 'heading-1');

      const after = await collectTree(session.page);
      expect(
        after.count,
        '本切片未交付：slash 写入后 data-block-count 未前进'
      ).toBeGreaterThan(before.count);
      const revAfter = await readRev(session.page);
      const revBefore = before.rev;
      expect(
        revAfter,
        '本切片未交付：写入后 data-rev 未前进（写未落 DocSession）'
      ).not.toBe(revBefore);
    } finally {
      await closeNoteLeafIfOpen(session.page).catch(() => undefined);
      await session.browser.close();
    }
  });
  test('conn_b3_e2e_no_tauri_readonly', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    const session = await connectWebView();
    let maskInstalled = false;
    try {
      await assertRealWebView(session.page);

      // ① CDP Runtime.evaluate 移除宿主全局（D-07 §1.4 计划口径）
      await stripTauriGlobals(session.page);
      await session.page.reload();
      await waitAppBoot(session.page);

      let internals = await readTauriInternals(session.page);
      if (internals === 'object') {
        // ② 宿主 preload 恒定重注入：等价模拟——注册 init 掩码脚本
        //    （sessionStorage 开关启停；含 setTimeout 延时重删，覆盖
        //    「init 早于宿主注入」的次序竞态）。掩码是 e2e 观测/控制钩子，
        //    非 mock 沙箱（不伪造任何产品数据）。
        await installNoTauriMask(session.context);
        maskInstalled = true;
        await setNoTauriMaskEnabled(session.page, true);
        await session.page.reload();
        await waitAppBoot(session.page);
        internals = await readTauriInternals(session.page);
      }

      if (internals === 'object') {
        test.skip(
          true,
          'CONN-03 真 WebView 无 Tauri 场景未交付：WebView2 宿主 preload 恒定重注入 ' +
            '__TAURI_INTERNALS__（删除+reload 与 init 掩码均被覆盖），真壳内无法造 ' +
            '无宿主场景。readonly 灰态主交付面在 jsdom ' +
            '`WorkspaceEmptyState.conn-b3.test.tsx`（data-slash-write-mode=readonly ' +
            '断言仍在，不回退）。本切片不 mock、不伪装绿。'
        );
        return;
      }

      // ③ 无宿主下同样走 openNoteLeaf（叶+面板仍须可见，写锥才是 readonly）
      await openNoteLeaf(session.page);

      const cone = await readWriteCone(session.page);
      expect(
        cone.mode,
        '本切片未交付：无 Tauri 下 slash 写锥非 readonly（禁假写）'
      ).toBe('readonly');
      expect(
        cone.source,
        '无 Tauri 下 source 应为 none（禁静默 mock 可写）'
      ).toBe('none');
      expect(cone.sink, '无 Tauri 下不应有 sink').toBe('0');
      expect(
        cone.hydrateSource,
        '无 Tauri 下 hydrate 不得伪装 tauri-ipc（fixture 诚实回落）'
      ).not.toBe('tauri-ipc');

      // ④ 浮层 readonly：aria-disabled + 只读 banner + 项禁点 + 点击不写
      await openSlash(session.page, 'readonly');
      const overlay = session.page.locator(SLASH_OVERLAY);
      await expect(overlay).toHaveAttribute('aria-disabled', 'true');
      await expect(
        session.page.locator(`${SLASH_OVERLAY}-readonly-banner`)
      ).toBeVisible();

      const item = overlay.locator(
        '[data-bp-slash-item][data-item-id="heading-1"]'
      );
      await expect(
        item,
        '本切片未交付：readonly 下 catalog 项应禁点'
      ).toHaveAttribute('aria-disabled', 'true');

      const before = await collectTree(session.page);
      await item.click({ force: true });
      await session.page.waitForTimeout(1_000);
      const after = await collectTree(session.page);
      expect(
        after.count,
        '本切片未交付：readonly 下点击 catalog 项不应产生写入（禁假写）'
      ).toBe(before.count);
    } finally {
      if (maskInstalled) {
        // 掩码自禁用（sessionStorage 开关摘除）→ reload 后宿主 preload 重注入
        await setNoTauriMaskEnabled(session.page, false).catch(() => undefined);
      }
      await closeNoteLeafIfOpen(session.page).catch(() => undefined);
      await session.page.reload().catch(() => undefined);
      await session.browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 载体 / 到达
// ---------------------------------------------------------------------------

/** 等待应用根渲染（reload 后冷启动同样适用） */
async function waitAppBoot(page: Page): Promise<void> {
  await expect(page.locator('#root')).toBeVisible({ timeout: 30_000 });
  const children = await page.locator('#root > *').count();
  expect(children, '本切片未交付：应用根未挂真实 UI 子树').toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// 无宿主掩码
// ---------------------------------------------------------------------------

async function stripTauriGlobals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    for (const key of ['__TAURI_INTERNALS__', '__TAURI__', 'isTauri']) {
      try {
        delete w[key];
      } catch {
        /* 不可删则尝试 defineProperty 置空 */
      }
      if (key in w) {
        try {
          Object.defineProperty(w, key, {
            value: undefined,
            configurable: true,
            writable: true,
          });
        } catch {
          /* 真壳不可删：由 reload 后探测判 skip（不 mock） */
        }
      }
    }
  });
}

/**
 * 注册无宿主掩码 init 脚本（仅当 sessionStorage 开关 = '1' 时删除宿主全局）。
 * 掩码是 e2e 观测/控制钩子（D-07 §1.5 同类探针），不伪造任何产品数据；
 * 开关摘除后掩码惰性失效，不影响后续用例的 Tauri 环境。
 */
async function installNoTauriMask(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const clearTauri = () => {
      if (sessionStorage.getItem('conn-no-tauri-mask') !== '1') {
        return;
      }
      const w = window as unknown as Record<string, unknown>;
      for (const key of ['__TAURI_INTERNALS__', '__TAURI__', 'isTauri']) {
        try {
          delete w[key];
        } catch {
          /* 真壳不可删则跳过（不 mock） */
        }
      }
    };
    clearTauri();
    window.setTimeout(clearTauri, 0);
    window.setTimeout(clearTauri, 10);
  });
}

async function setNoTauriMaskEnabled(
  page: Page,
  enabled: boolean
): Promise<void> {
  await page.evaluate((on) => {
    if (on) {
      sessionStorage.setItem('conn-no-tauri-mask', '1');
    } else {
      sessionStorage.removeItem('conn-no-tauri-mask');
    }
  }, enabled);
}

async function readTauriInternals(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  );
}

// ---------------------------------------------------------------------------
// 面板观测
// ---------------------------------------------------------------------------

async function readWriteCone(page: Page): Promise<StrictWriteCone> {
  return page.locator(PANEL).evaluate((el) => ({
    mode: el.getAttribute('data-slash-write-mode'),
    source: el.getAttribute('data-slash-sink-source'),
    sink: el.getAttribute('data-slash-sink'),
    hydrateSource: el.getAttribute('data-hydrate-source'),
    hydrateStatus: el.getAttribute('data-hydrate-status'),
  }));
}

type PanelTree = {
  count: number;
  countAttr: string | null;
  rev: string | null;
  ids: string[];
};

async function collectTree(page: Page): Promise<PanelTree> {
  return page.locator(PANEL).evaluate((panel) => {
    const countAttr = panel.getAttribute('data-block-count');
    const rev = panel.getAttribute('data-rev');
    const ids: string[] = [];
    for (const node of panel.querySelectorAll('[data-block-id]')) {
      if (node.closest('[data-testid="note-paper-strict-slash-overlay"]')) {
        continue;
      }
      const id = node.getAttribute('data-block-id');
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
    }
    const parsed = Number(countAttr);
    return {
      count: Number.isFinite(parsed) ? parsed : ids.length,
      countAttr,
      rev,
      ids,
    };
  });
}

async function readRev(page: Page): Promise<string | null> {
  return page.locator(PANEL).getAttribute('data-rev');
}

// ---------------------------------------------------------------------------
// slash 打开 / 选择
// ---------------------------------------------------------------------------

async function openSlash(page: Page, expectWriteMode: string): Promise<void> {
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
  await expect(overlay).toHaveAttribute(
    'data-slash-write-mode',
    expectWriteMode
  );
}

async function closeSlashIfOpen(page: Page): Promise<void> {
  if ((await page.locator(SLASH_OVERLAY).count()) === 0) {
    return;
  }
  await page.keyboard.press('Escape');
  await expect(page.locator(SLASH_OVERLAY)).toHaveCount(0, { timeout: 5_000 });
}

async function selectSlashCatalogItem(
  page: Page,
  itemId: string
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

/** 等待面板树增块（写后 hydrate 读回的投影前进观测） */
async function waitTreeGrew(
  page: Page,
  before: PanelTree,
  catalogItemId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const tree = await collectTree(page);
        return tree.count > before.count ? tree.count : 0;
      },
      {
        timeout: 15_000,
        message:
          `本切片未交付：选 ${catalogItemId} 后树未增块` +
          `（插入前 count=${before.count} ids=${before.ids.join(',') || '∅'}）。` +
          `可能：产品 createCollabApplySink 未 allocateId / 真 IPC apply 失败 ` +
          `（err_outcome 如实暴露，禁止 mock 掩盖）/ hydrate 未读回。`,
      }
    )
    .toBeGreaterThan(before.count);
  const tree = await collectTree(page);
  const added = tree.ids.filter((id) => !before.ids.includes(id));
  if (added.length === 0) {
    throw new Error(
      `本切片未交付：选 ${catalogItemId} 后面板 count 变化但未出现新 data-block-id。` +
        `前=${before.ids.join(',') || '∅'} 后=${tree.ids.join(',') || '∅'}`
    );
  }
}
