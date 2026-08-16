/**
 * CONN-04 · G2-e2e · 真 WebView 写后读回三态（e2e-webview project）
 *
 * 权威：docs/review-md-audit/2026-08-13-wave/plans/D-07-维度详案-连通余量.md §1.5。
 * 依赖 CONN-01 基建（cdp.ts / playwright.config.ts / webview-smoke.spec.ts）。
 *
 * 文件命名说明：同 conn-b3-e2e.spec.ts——以显式文件名落入 e2e-webview
 * config testMatch 的「需真 Tauri 的 WebView spec」发现面，
 * 使 `npm run test:e2e:webview -- --grep conn_b3|conn_g2` 可直接发现执行。
 *
 * 用例清单（写后读回三态）：
 * - conn_g2_e2e_write_readback_strict_advance：同 doc 产品写入（slash →
 *   note_apply_ops 真 IPC）→ notify → 同 doc Strict 投影前进（data-block-count
 *   / data-rev 前进 + 新 data-block-id 读回）。
 * - conn_g2_e2e_other_doc_no_refresh：异 doc 写入（真 send_to_note 桥 →
 *   note_document_apply_md 真 IPC → 真总线 notify 异 docId）→ 本 Strict
 *   data-block-count / data-rev / data-hydrate-status 不变（订阅按 docId 过滤，
 *   不误刷）。
 * - conn_g2_e2e_idempotent_no_double_notify：同 intentId 幂等重放 → 第二次
 *   applied=false → 不二次 notify（真总线订阅计数探针不增；面板不二次 reload）。
 *
 * 观测钩子说明（D-07 §1.5：「CDP Runtime.evaluate 注入 reload 计数器探针或
 * 总线订阅计数，断言计数不增」）：dev 形态（localhost:5174）下经 CDP evaluate
 * 动态 `import('/src/bridges/...')` 与应用模块图按 URL 去重共享同一模块实例，
 * 因此订阅 `note-doc-written` 总线计数是**对真实总线**的观测钩子，非 mock。
 * 若实例未共享（计数不随面板刷新而增），用例失败并写明——不掩盖。
 * 生产形态（tauri:// 打包产物）无 /src/ 路径服务，本观测钩子仅限 dev 形态。
 *
 * 诚实边界句（D-07 §1.5，禁止删除）：
 *   ≠ EL-08；≠ 打开完成；≠ inotify 满关；G2 总线既有完成（双源 + adapt
 *   notify + 订阅）不因本 e2e 新增而回退；真 WebView 读回 ≠ DocSession 全链
 *   apply（覆盖场景有限，不作全链验收）；幂等计数探针是 e2e 观测钩子，
 *   不构成产品新设施；禁止把 fixture 回落写成 source:'tauri-ipc'。
 *
 * 运行前置：npm run dev:workbench（WebView2 带 9222）。9222 不可达 →
 * cdp.ts fail-fast 可读错误（AGENTS.md §15）。真跑若环境不可用：fail-fast
 * 如实标注，不伪装绿。真 IPC 后端行为与预期不符（err_outcome）→ 用例失败
 * 写明，**禁止**用 fixture/mock 掩盖后端缺口。
 */
import { test, expect, type Page } from '@playwright/test';
import { connectWebView, listCdpTargets } from './cdp';

/**
 * 运行时在页面上下文经 Vite dev 服务动态 import 真实桥模块（dev 形态，
 * 与应用模块图按 URL 共享同一模块实例）；静态类型经相对路径引用真实源码。
 */
type NoteDocWrittenBus =
  typeof import('../../../apps/crish-desktop/src/bridges/note-doc-written');
type SendToNoteBridge =
  typeof import('../../../apps/crish-desktop/src/bridges/send-to-note');

const PANEL = '[data-testid="note-paper-strict-panel"]';
const OPEN_STRICT = '[data-testid="open-note-paper-strict"]';
const SLASH_OVERLAY = '[data-testid="note-paper-strict-slash-overlay"]';
const SLASH_TRIGGER = '[data-testid="note-paper-strict-open-slash"]';
const SLASH_CLOSE = '[data-testid="note-paper-strict-close"]';

/** 本 spec 各用例独立的临时空工作区 id 前缀（finally 必摘） */
const TEMP_WS_PREFIX = 'ws-w6c-conn-g2-';

type PanelSnapshot = {
  docId: string | null;
  rev: string | null;
  blockCount: string | null;
  hydrateStatus: string | null;
  hydrateSource: string | null;
};

test.describe('CONN-04 G2-e2e 写后读回三态真 WebView（e2e-webview）', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('conn_g2_e2e_write_readback_strict_advance', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    const session = await connectWebView();
    const tempWsId = `${TEMP_WS_PREFIX}adv-${Date.now()}`;
    let addedTempWs = false;
    try {
      await assertRealWebView(session.page);
      await ensureWorkspaceEmptyState(session.page, tempWsId);
      addedTempWs = await openStrictPanel(session.page, tempWsId);

      // ① 写锥探测：产品默认可写必须是 product-ipc（真 IPC 后端）
      await expect(session.page.locator(PANEL)).toHaveAttribute(
        'data-slash-write-mode',
        'writable'
      );
      await expect(session.page.locator(PANEL)).toHaveAttribute(
        'data-slash-sink-source',
        'product-ipc'
      );

      // ② 同 doc 产品写入（slash → note_apply_ops）→ notify → hydrate 读回
      const before = await readPanelSnapshot(session.page);
      await openSlash(session.page);
      await selectSlashCatalogItem(session.page, 'heading-1');

      // ③ 投影前进：block-count 增长 + rev 前进 + 状态 ready（读回新块）
      await expect
        .poll(
          async () =>
            Number(
              await readPanelSnapshot(session.page).then((s) => s.blockCount)
            ),
          {
            timeout: 15_000,
            message:
              '本切片未交付：同 doc 写入后 data-block-count 未前进（notify → ' +
              'hydrate 读回未兑现）。真 IPC apply 若 err_outcome 应如实暴露。',
          }
        )
        .toBeGreaterThan(Number(before.blockCount ?? '0'));

      const after = await readPanelSnapshot(session.page);
      expect(
        after.rev,
        '本切片未交付：写入后 data-rev 未前进（写未落 DocSession）'
      ).not.toBe(before.rev);
      expect(after.hydrateStatus, '写后应回到 ready（投影读回完成）').toBe(
        'ready'
      );
      expect(after.docId, '面板 docId 应变（同 doc 读回）').toBe(before.docId);
    } finally {
      if (addedTempWs) {
        await removeTempWorkspace(session.page, tempWsId);
      }
      await session.browser.close();
    }
  });

  test('conn_g2_e2e_other_doc_no_refresh', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    const session = await connectWebView();
    const tempWsId = `${TEMP_WS_PREFIX}other-${Date.now()}`;
    const otherDocId = `conn-g2-other-${Date.now()}`;
    const otherIntentId = `conn-g2-other-intent-${Date.now()}`;
    let addedTempWs = false;
    try {
      await assertRealWebView(session.page);
      await ensureWorkspaceEmptyState(session.page, tempWsId);
      addedTempWs = await openStrictPanel(session.page, tempWsId);
      await expect(session.page.locator(PANEL)).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );

      // ① 真实总线订阅计数探针（异 docId 专用；dev 形态与应用共享模块实例）
      await installBusCounter(session.page, otherDocId, '__connG2OtherBus');
      try {
        // ② 异 doc 写入：真实 send_to_note 桥 → 默认 NoteTransport（Tauri 真
        //    IPC note_document_apply_md）→ 真总线 notify（docId=other）
        const first = await dispatchSendToNote(session.page, {
          intentId: otherIntentId,
          markdown: '# 异 doc 写入\n\n本段落只属于 other doc',
          docId: otherDocId,
          messageId: `msg-other-${Date.now()}`,
        });
        if (!first.ok) {
          throw new Error(
            '本切片未交付：异 doc 真 IPC 写入被后端拒绝（ok=false）——真后端行为' +
              `如实暴露（${JSON.stringify(first)}），禁止 mock 掩盖`
          );
        }
        expect(
          first.applied,
          '异 doc 首次写入应 applied=true（真 IPC 落库）'
        ).toBe(true);

        // ③ 总线确实为异 doc 发过 notify（证明写+通知发生，非 no-op）
        await session.page.waitForTimeout(1_200);
        const counter = await readBusCounter(session.page, '__connG2OtherBus');
        expect(
          counter,
          '观测钩子失效或 notify 未发：异 doc 写入后总线计数应为 1。' +
            '若面板刷新而计数为 0，则是 dev 动态 import 未命中同一模块实例' +
            '（观测钩子问题，非产品行为），如实标注。'
        ).toBe(1);

        // ④ 本 Strict 不刷：面板快照逐项不变（订阅按 docId 过滤）
        const before = await readPanelSnapshot(session.page);
        await session.page.waitForTimeout(1_500);
        const after = await readPanelSnapshot(session.page);
        expect(
          after,
          '本切片未交付：异 doc 写入误刷了本 Strict（docId 过滤失效）'
        ).toEqual(before);
      } finally {
        await uninstallBusCounter(session.page, '__connG2OtherBus');
      }
    } finally {
      if (addedTempWs) {
        await removeTempWorkspace(session.page, tempWsId);
      }
      await session.browser.close();
    }
  });

  test('conn_g2_e2e_idempotent_no_double_notify', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    const session = await connectWebView();
    const tempWsId = `${TEMP_WS_PREFIX}idem-${Date.now()}`;
    const idemIntentId = `conn-g2-idem-${Date.now()}`;
    let addedTempWs = false;
    try {
      await assertRealWebView(session.page);
      await ensureWorkspaceEmptyState(session.page, tempWsId);
      addedTempWs = await openStrictPanel(session.page, tempWsId);
      await expect(session.page.locator(PANEL)).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );

      const docId = await session.page
        .locator(PANEL)
        .getAttribute('data-doc-id');
      expect(docId, '本切片未交付：面板无 data-doc-id').toBeTruthy();

      // ① 真实总线订阅计数探针（同 docId 专用）
      await installBusCounter(session.page, docId as string, '__connG2SameBus');
      try {
        const before = await readPanelSnapshot(session.page);

        // ② 首次写入（同 doc）：applied=true + 计数 1 + 面板投影前进
        const first = await dispatchSendToNote(session.page, {
          intentId: idemIntentId,
          markdown: '# 幂等写入\n\n同 intentId 只应落一次',
          docId: docId as string,
          messageId: `msg-idem-${Date.now()}`,
        });
        if (!first.ok) {
          throw new Error(
            '本切片未交付：同 doc 真 IPC 写入被后端拒绝（ok=false）——真后端行为' +
              `如实暴露（${JSON.stringify(first)}），禁止 mock 掩盖`
          );
        }
        expect(first.applied, '首次写入应 applied=true').toBe(true);
        await expect
          .poll(
            async () =>
              Number(
                (await readPanelSnapshot(session.page)).blockCount ??
                  before.blockCount ??
                  '0'
              ),
            {
              timeout: 15_000,
              message:
                '本切片未交付：首次写后同 doc 投影未前进（notify → hydrate 读回未兑现）',
            }
          )
          .toBeGreaterThan(Number(before.blockCount ?? '0'));

        const countAfterFirst = await readBusCounter(
          session.page,
          '__connG2SameBus'
        );
        expect(
          countAfterFirst,
          '观测钩子失效或 notify 未发：首次写入后总线计数应为 1。' +
            '若面板刷新而计数为 0，则是 dev 动态 import 未命中同一模块实例' +
            '（观测钩子问题，非产品行为），如实标注。'
        ).toBe(1);

        const settledAfterFirst = await readPanelSnapshot(session.page);

        // ③ 幂等重放（同 intentId 二次）：applied=false + 计数不增 + 面板不二刷
        const second = await dispatchSendToNote(session.page, {
          intentId: idemIntentId,
          markdown: '# 幂等写入\n\n同 intentId 只应落一次',
          docId: docId as string,
          messageId: `msg-idem-${Date.now()}`,
        });
        if (!second.ok) {
          throw new Error(
            '本切片未交付：幂等重放 ok=false（桥层幂等语义异常）：' +
              JSON.stringify(second)
          );
        }
        expect(
          second.applied,
          '本切片未交付：同 intentId 重放 applied 应为 false（幂等键纪律：' +
            'send-to-note intentId 缓存不双插）'
        ).toBe(false);

        await session.page.waitForTimeout(1_500);
        const countAfterSecond = await readBusCounter(
          session.page,
          '__connG2SameBus'
        );
        expect(
          countAfterSecond,
          '本切片未交付：幂等重放二次 notify（总线计数不应增）——' +
            '桥层 applied=false 不得通知'
        ).toBe(1);

        const settledAfterSecond = await readPanelSnapshot(session.page);
        expect(
          settledAfterSecond,
          '本切片未交付：幂等重放导致面板二次 reload（数据不应变化）'
        ).toEqual(settledAfterFirst);
      } finally {
        await uninstallBusCounter(session.page, '__connG2SameBus');
      }
    } finally {
      if (addedTempWs) {
        await removeTempWorkspace(session.page, tempWsId);
      }
      await session.browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 载体 / 到达
// ---------------------------------------------------------------------------

async function assertRealWebView(page: Page): Promise<void> {
  const internals = await page.evaluate(
    () =>
      typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
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

async function ensureWorkspaceEmptyState(
  page: Page,
  tempWsId: string
): Promise<void> {
  await expect(page.locator('#root')).toBeVisible({ timeout: 30_000 });

  if ((await page.locator(PANEL).count()) > 0) {
    const close = page.locator(SLASH_CLOSE).first();
    if ((await close.count()) > 0) {
      await close.click();
    }
  }

  if ((await page.locator('[data-empty="true"]').count()) > 0) {
    return;
  }

  const added = await revealEmptyWorkspaceViaStore(page, tempWsId);
  if (!added) {
    throw new Error(
      '本切片未交付：产品空态不可见，且无法经真实 layout store 露出空工作区。' +
        '请先 npm run dev:workbench 并保证工作区可到空态。'
    );
  }
  await expect(page.locator('[data-empty="true"]').first()).toBeVisible({
    timeout: 15_000,
  });
}

async function openStrictPanel(page: Page, tempWsId: string): Promise<boolean> {
  if ((await page.locator(PANEL).count()) > 0) {
    return false;
  }
  if ((await page.locator(OPEN_STRICT).count()) === 0) {
    await ensureWorkspaceEmptyState(page, tempWsId);
  }
  await expect(page.locator(OPEN_STRICT).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.locator(OPEN_STRICT).first().click();
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 20_000 });
  return true;
}

async function revealEmptyWorkspaceViaStore(
  page: Page,
  tempWsId: string
): Promise<boolean> {
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
      store.setState({ workspaces, activeWorkspaceIndex: existingIdx });
      return true;
    }
    if (typeof store.setState !== 'function') {
      return false;
    }
    const next = workspaces.concat([{ id: tempId, columns: [] }]);
    store.setState({ workspaces: next, activeWorkspaceIndex: next.length - 1 });
    return true;
  }, tempWsId);
}

async function removeTempWorkspace(
  page: Page,
  tempWsId: string
): Promise<void> {
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
    store.setState({ workspaces, activeWorkspaceIndex: nextIdx });
  }, tempWsId);
}

// ---------------------------------------------------------------------------
// 面板观测
// ---------------------------------------------------------------------------

async function readPanelSnapshot(page: Page): Promise<PanelSnapshot> {
  return page.locator(PANEL).evaluate((el) => ({
    docId: el.getAttribute('data-doc-id'),
    rev: el.getAttribute('data-rev'),
    blockCount: el.getAttribute('data-block-count'),
    hydrateStatus: el.getAttribute('data-hydrate-status'),
    hydrateSource: el.getAttribute('data-hydrate-source'),
  }));
}

// ---------------------------------------------------------------------------
// 真实总线观测钩子（dev 形态动态 import；与应用共享模块实例）
// ---------------------------------------------------------------------------

async function installBusCounter(
  page: Page,
  watchDocId: string,
  globalKey: string
): Promise<void> {
  const ok = await page.evaluate(
    ({ docId, key }) =>
      // @ts-expect-error 运行时由 Vite dev 服务解析 /src/ 路径（dev 形态；类型见 NoteDocWrittenBus）
      import('/src/bridges/note-doc-written.ts').then((raw) => {
        const bus = raw as unknown as NoteDocWrittenBus;
        const w = window as unknown as Record<string, unknown>;
        const state = { count: 0 };
        w[key] = state;
        const unsub = bus.subscribeNoteDocWritten((ev) => {
          if (ev.docId === docId) {
            state.count += 1;
          }
        });
        w[`${key}Unsub`] = unsub;
        return true;
      }),
    { docId: watchDocId, key: globalKey }
  );
  expect(
    ok,
    '本切片未交付：无法经 dev 动态 import 挂真实总线计数探针（/src/ 路径在 ' +
      'dev 形态应可加载；生产 tauri:// 形态不支持，本观测钩子仅限 dev）。'
  ).toBe(true);
}

async function readBusCounter(page: Page, globalKey: string): Promise<number> {
  const value = await page.evaluate((key) => {
    const w = window as unknown as Record<string, unknown>;
    const state = w[key] as { count: number } | undefined;
    return state?.count ?? -1;
  }, globalKey);
  expect(
    value >= 0,
    `本切片未交付：总线计数探针 ${globalKey} 未安装（观测钩子缺失）`
  ).toBe(true);
  return value;
}

async function uninstallBusCounter(
  page: Page,
  globalKey: string
): Promise<void> {
  await page.evaluate((key) => {
    const w = window as unknown as Record<string, unknown>;
    const unsub = w[`${key}Unsub`] as (() => void) | undefined;
    if (typeof unsub === 'function') {
      try {
        unsub();
      } catch {
        /* 卸载失败不影响断言；页面后续 reload 也会复位 */
      }
    }
    delete w[key];
    delete w[`${key}Unsub`];
  }, globalKey);
}

/** 经真实 send_to_note 桥 + 默认 NoteTransport（Tauri 真 IPC）写一次 */
async function dispatchSendToNote(
  page: Page,
  input: {
    intentId: string;
    markdown: string;
    docId: string;
    messageId: string;
  }
): Promise<Awaited<ReturnType<SendToNoteBridge['dispatchSendToNote']>>> {
  return page.evaluate(
    ({ intentId, markdown, docId, messageId }) =>
      // @ts-expect-error 运行时由 Vite dev 服务解析 /src/ 路径（dev 形态；类型见 SendToNoteBridge）
      import('/src/bridges/send-to-note.ts').then((raw) =>
        (raw as unknown as SendToNoteBridge).dispatchSendToNote({
          type: 'send_to_note',
          intentId,
          source: { surface: 'chat', messageId, markdown },
          target: { surface: 'note-paper', docId, mode: 'insert_blocks' },
          origin: 'user',
        })
      ),
    input
  );
}

// ---------------------------------------------------------------------------
// slash 打开 / 选择
// ---------------------------------------------------------------------------

async function openSlash(page: Page): Promise<void> {
  await closeSlashIfOpen(page);
  const panel = page.locator(PANEL);
  await panel.click({ position: { x: 16, y: 16 } });
  await panel.focus();
  await page.keyboard.press('/');

  const overlay = page.locator(SLASH_OVERLAY);
  if ((await overlay.count()) === 0) {
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
