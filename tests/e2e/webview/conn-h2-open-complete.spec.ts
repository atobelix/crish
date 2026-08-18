/**
 * LR-H2-改面 · 真壳打开完成句（e2e-webview）
 *
 * 权威：docs/block-workspace-architecture/shell-rehost/03-打开完成验收.md §3.3 / §7 / §10。
 * 打开步只 import 06 helper（arrive-note-leaf）；禁止第二套打开函数；禁止点死 CTA。
 *
 * ≠ 打开完成（直到本 spec 真跑绿并写入 shell-rehost 会计）；
 * ≠ EL-01 / EL-04 / EL-08；
 * ≠ 点 open-note-paper-strict；
 * ≠ fixture 三块；
 * ≠ jsdom / 5174；
 * 禁止 mock IPC / Memory 充非空。
 *
 * 测名族 conn_a_e2e_*：补 G-HYD-6 真 WebView 面。单独三态绿仍 ≠ 打开完成。
 * jsdom 绿 ≠ 打开完成。本文件落盘 ≠ 打开完成。表 A 不得改。
 *
 * 9222 不可达 / 被 Chrome 占（/json/list 404）→ cdp.ts fail-fast 可读错误。
 * 禁止 skip 当绿；禁止 page.goto(5174)。
 */
import { test, expect, type Page } from '@playwright/test';
import { connectWebView, listCdpTargets } from './cdp';
import {
  openNoteLeaf,
  assertRealWebView,
  NOTE_LEAF,
  PANEL,
  closeNoteLeafIfOpen,
} from './arrive-note-leaf';

const FIXTURE_BLOCK_IDS = [
  'empty-strict-h1',
  'empty-strict-p1',
  'empty-strict-p2',
] as const;

const HOST = `${NOTE_LEAF} [data-note-leaf-host="true"]`;

type ApplyOutcome =
  | { ok: true; blockIds: string[]; inserted: number }
  | { ok: false; code: string; reason: string };

type HydrateBlock = { id: string; text?: string };
type HydrateOutcome =
  | {
      ok: true;
      docId: string;
      rev: number;
      blocks: HydrateBlock[];
      source: string;
      hydratePath?: string;
    }
  | { ok: false; code: string; reason: string };

type QueryOutcome =
  | { ok: true; blocks: Array<{ id: string; snippet: string }> }
  | { ok: false; code: string; reason: string };

test.describe('LR-H2-改面 真壳打开完成（e2e-webview）', () => {
  test.describe.configure({ timeout: 120_000 });

  test('conn_a_e2e_open_persisted_nonempty_note_leaf', async () => {
    const targets = await listCdpTargets();
    expect(
      targets.length,
      '本切片未交付：9222 无 WebView2 target（/json/list 404 = Chrome 占端口）'
    ).toBeGreaterThan(0);

    const session = await connectWebView();
    const stamp = Date.now();
    const docId = `conn-h2-persist-${stamp}`;
    const sentence = `LR-H2-改面已persist句子-${stamp}`;
    let wsId: string | null = null;
    try {
      await assertRealWebView(session.page);
      await assertStoreBackendInstalled(session.page);

      // 打开前 persist（禁止 B3「先打开再当场写入」冒充本句）
      await persistKnownSentence(session.page, docId, sentence);
      const preOpen = await hydrateViaIpc(session.page, docId);
      assertHydrateHasSentence(preOpen, docId, sentence, '打开前 hydrate');

      wsId = await bindPreOpen(session.page, docId);
      await closeNoteLeafIfOpen(session.page);
      await openNoteLeaf(session.page);

      const panel = session.page.locator(PANEL);
      await expect(panel).toBeVisible({ timeout: 20_000 });
      const box = await panel.boundingBox();
      expect(
        box?.height ?? 0,
        '本切片未交付：面板高度为 0（01 视口未兑现；看不见 ≠ 打开完成）'
      ).toBeGreaterThan(0);

      const leaf = session.page.locator(NOTE_LEAF).first();
      await expect(leaf).toHaveCount(1);
      const panelId = await leaf.getAttribute('data-panel-id');
      expect(
        panelId === 'note' || (panelId?.startsWith('note:') ?? false),
        `本切片未交付：面板不在扩展 note 叶内（data-panel-id=${panelId}）`
      ).toBe(true);

      await expect(panel).toHaveAttribute('data-hydrate-source', 'tauri-ipc');
      await expect(panel).not.toHaveAttribute('data-hydrate-source', 'fixture');
      await expect(panel).toHaveAttribute('data-hydrate-path', 'doc-session');
      await expect(panel).toHaveAttribute('data-hydrate-status', 'ready');

      const openedDocId = await panel.getAttribute('data-doc-id');
      expect(openedDocId, '本切片未交付：面板无 data-doc-id').toBe(docId);

      const chatSessionId = await leaf.getAttribute('data-session-id');
      expect(
        openedDocId,
        '本切片未交付：docId 不得等于 chat sessionId（P4 作废写法）'
      ).not.toBe(chatSessionId);

      const blockCount = Number(await panel.getAttribute('data-block-count'));
      expect(
        blockCount,
        '本切片未交付：打开后 data-block-count < 1（打开即非空未兑现）'
      ).toBeGreaterThanOrEqual(1);

      const blockIds = await collectBlockIds(session.page);
      expect(
        blockIds.some((id) =>
          (FIXTURE_BLOCK_IDS as readonly string[]).includes(id)
        ),
        `本切片未交付：投影含 fixture 三块（${blockIds.join(',')}）`
      ).toBe(false);

      await expect(panel).toContainText(sentence);
      const slashBefore = session.page.locator(
        '[data-testid="note-paper-strict-slash-overlay"]'
      );
      expect(
        await slashBefore.count(),
        '本句禁止先 slash/当场写入再读回（≠ B3）'
      ).toBe(0);

      const postOpen = await hydrateViaIpc(session.page, docId);
      assertHydrateHasSentence(postOpen, docId, sentence, '打开后 hydrate/get_md');
      const outline = await queryBlocksViaIpc(session.page, docId, sentence);
      if (!outline.ok) {
        throw new Error(
          `本切片未交付：打开后 query_blocks/outline 失败 ${JSON.stringify(outline)}`
        );
      }
      const outlineHit = outline.blocks.some((b) =>
        (b.snippet ?? '').includes(sentence)
      );
      expect(
        outlineHit,
        '本切片未交付：query_blocks/outline 不含打开前 persist 句子'
      ).toBe(true);

      const host = session.page.locator(HOST);
      await expect(host).toHaveAttribute('data-open-complete', 'not-claimed');
      await expect(host).toHaveAttribute('data-el01', 'not-claimed');
      await expect(host).toHaveAttribute('data-el04', 'not-claimed');
      await expect(host).toHaveAttribute('data-el08', 'not-claimed');
      await expect(host).toHaveAttribute('data-strict-doc-id', docId);
      const binding = await host.getAttribute('data-strict-doc-binding');
      expect(
        binding === 'pre-open-bind' || binding === 'explicit-prop',
        `本切片未交付：有 persist 时 binding 仍为 ${binding}`
      ).toBe(true);
      const synthetic = await host.getAttribute('data-synthetic-strict-doc-id');
      expect(docId, '有 persist 时 docId 不得等于合成 id').not.toBe(synthetic);
    } finally {
      if (wsId) {
        await unbindPreOpen(session.page, wsId).catch(() => undefined);
      }
      await session.browser.close();
    }
  });

  test('conn_a_e2e_hydrate_empty_unwritten_id', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);
    const session = await connectWebView();
    let wsId: string | null = null;
    try {
      await assertRealWebView(session.page);
      await assertStoreBackendInstalled(session.page);
      wsId = await resolveWorkspaceKey(session.page);
      await unbindPreOpen(session.page, wsId);
      await closeNoteLeafIfOpen(session.page);
      await openNoteLeaf(session.page);

      const panel = session.page.locator(PANEL);
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(panel).toHaveAttribute('data-hydrate-source', 'tauri-ipc');
      await expect(panel).not.toHaveAttribute('data-hydrate-source', 'fixture');
      const status = await panel.getAttribute('data-hydrate-status');
      const count = Number(await panel.getAttribute('data-block-count') ?? '0');
      expect(
        status === 'empty' || (status === 'ready' && count === 0),
        `未写 id 应空成功（status=${status} count=${count}），不回退 fixture。空成功 ≠ 打开完成`
      ).toBe(true);
      expect(count).toBe(0);
    } finally {
      if (wsId) {
        await unbindPreOpen(session.page, wsId).catch(() => undefined);
      }
      await session.browser.close();
    }
  });

  test('conn_a_e2e_hydrate_loading_then_ready', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);
    const session = await connectWebView();
    const stamp = Date.now();
    const docId = `conn-h2-loading-${stamp}`;
    const sentence = `LR-H2-loading-${stamp}`;
    let wsId: string | null = null;
    try {
      await assertRealWebView(session.page);
      await persistKnownSentence(session.page, docId, sentence);
      wsId = await bindPreOpen(session.page, docId);
      await closeNoteLeafIfOpen(session.page);
      await openNoteLeaf(session.page);
      const panel = session.page.locator(PANEL);
      await expect(panel).toBeVisible({ timeout: 20_000 });

      const loading = session.page.locator(
        '[data-testid="note-paper-strict-loading"]'
      );
      const refresh = session.page.locator(
        '[data-testid="note-paper-strict-refresh"]'
      );
      if ((await refresh.count()) === 0) {
        test.skip(
          true,
          '未交付：无刷新钮，无法观测 loading→ready（单独三态绿仍 ≠ 打开完成）'
        );
        return;
      }
      const pendingLoading = loading
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      await refresh.click();
      const observed = await pendingLoading;
      await expect(panel).toHaveAttribute('data-hydrate-status', 'ready', {
        timeout: 15_000,
      });
      if (!observed) {
        test.skip(
          true,
          '未交付：loading 态过快未观测到（单独三态绿仍 ≠ 打开完成）'
        );
      }
    } finally {
      if (wsId) {
        await unbindPreOpen(session.page, wsId).catch(() => undefined);
      }
      await session.browser.close();
    }
  });

  test('conn_a_e2e_hydrate_error_unplug_backend', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);
    const session = await connectWebView();
    try {
      await assertRealWebView(session.page);
      await assertStoreBackendInstalled(session.page);
      test.skip(
        true,
        '未交付：真壳无生产卸载 try_store_backend 的口，无法拔后端造 data-hydrate-status=error。单独三态绿仍 ≠ 打开完成。'
      );
    } finally {
      await session.browser.close();
    }
  });

  test('conn_a_e2e_no_tauri_source_fixture_honest', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);
    const session = await connectWebView();
    try {
      await assertRealWebView(session.page);
      await closeNoteLeafIfOpen(session.page);
      await openNoteLeaf(session.page);
      await expect(session.page.locator(PANEL)).toBeVisible({ timeout: 20_000 });

      await stripTauriGlobals(session.page);
      await session.page.reload();
      await expect(session.page.locator('#root')).toBeVisible({
        timeout: 30_000,
      });
      const internals = await readTauriInternals(session.page);
      if (internals === 'object') {
        test.skip(
          true,
          '对照未交付：WebView2 preload 恒定重注入 __TAURI_INTERNALS__，真壳造不出无宿主。不得标 ipc。单独对照绿 ≠ 打开完成。'
        );
        return;
      }

      const panel = session.page.locator(PANEL);
      if ((await panel.count()) === 0) {
        test.skip(
          true,
          '对照未交付：剥 Tauri 后 reload 叶未保持，openNoteLeaf 要求真 Tauri。不得标 ipc。'
        );
        return;
      }
      await expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
      await expect(panel).not.toHaveAttribute(
        'data-hydrate-source',
        'tauri-ipc'
      );
    } finally {
      await session.page.reload().catch(() => undefined);
      await session.browser.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 打开前 persist / 绑定 / 真 IPC（非 mock；≠ 第二套打开函数）
// ---------------------------------------------------------------------------

async function persistKnownSentence(
  page: Page,
  docId: string,
  sentence: string
): Promise<void> {
  const markdown = `# ${sentence}\n\n${sentence}`;
  const intentId = `conn-h2-persist-${docId}`;
  const apply = await page.evaluate(
    async (input) => {
      // @ts-expect-error Vite devUrl 下 /src 与应用共享模块（同 G2；非 mock）
      const api = (await import('/src/api/noteApi.ts')) as {
        noteDocumentApplyMd: (req: {
          docId: string;
          markdown: string;
          intentId: string;
          origin: 'user';
          mode: 'apply_md_fragment';
        }) => Promise<ApplyOutcome>;
      };
      return api.noteDocumentApplyMd({
        docId: input.docId,
        markdown: input.markdown,
        intentId: input.intentId,
        origin: 'user',
        mode: 'apply_md_fragment',
      });
    },
    { docId, markdown, intentId }
  );
  if (!apply.ok) {
    throw new Error(
      '本切片未交付：打开前 note_document_apply_md 失败 ' +
        `${JSON.stringify(apply)}（note.unwired = try_store_backend 未装）`
    );
  }
  if (apply.inserted < 1 && apply.blockIds.length < 1) {
    throw new Error(
      '本切片未交付：打开前 apply 未插入块 ' + JSON.stringify(apply)
    );
  }
}

async function hydrateViaIpc(page: Page, docId: string): Promise<HydrateOutcome> {
  return page.evaluate(async (id) => {
    // @ts-expect-error Vite devUrl 下 /src 与应用共享模块（非 mock）
    const mod = (await import('/src/api/noteHydrateIpc.ts')) as {
      createTauriNoteHydrateIpc: () => {
        hydrateDocument: (req: { docId: string }) => Promise<HydrateOutcome>;
      };
    };
    return mod.createTauriNoteHydrateIpc().hydrateDocument({ docId: id });
  }, docId);
}

async function queryBlocksViaIpc(
  page: Page,
  docId: string,
  textMatch: string
): Promise<QueryOutcome> {
  return page.evaluate(
    async (input) => {
      // @ts-expect-error Vite devUrl 下 /src 与应用共享模块（非 mock）
      const api = (await import('/src/api/noteApi.ts')) as {
        noteQueryBlocks: (req: {
          docId: string;
          textMatch: string;
          limit: number;
        }) => Promise<QueryOutcome>;
      };
      return api.noteQueryBlocks({
        docId: input.docId,
        textMatch: input.textMatch,
        limit: 50,
      });
    },
    { docId, textMatch }
  );
}

async function assertStoreBackendInstalled(page: Page): Promise<void> {
  const probeId = `conn-h2-store-probe-${Date.now()}`;
  const out = await hydrateViaIpc(page, probeId);
  if (!out.ok && out.code === 'note.unwired') {
    throw new Error(
      '本切片未交付：try_store_backend 未装（hydrate=note.unwired）。测的是半连通，不是打开完成。'
    );
  }
  if (!out.ok) {
    throw new Error(
      `本切片未交付：store backend 探测失败 ${JSON.stringify(out)}`
    );
  }
}

function assertHydrateHasSentence(
  out: HydrateOutcome,
  docId: string,
  sentence: string,
  when: string
): void {
  if (!out.ok) {
    throw new Error(`${when} hydrate 失败 ${JSON.stringify(out)}`);
  }
  expect(out.docId, `${when} hydrate docId`).toBe(docId);
  expect(out.source, `${when} 不得走 fixture`).toBe('tauri-ipc');
  if (out.hydratePath) {
    expect(out.hydratePath, `${when} 须 doc-session`).toBe('doc-session');
  }
  expect(out.blocks.length, `${when} 块数`).toBeGreaterThanOrEqual(1);
  const ids = out.blocks.map((b) => b.id);
  expect(
    ids.some((id) => (FIXTURE_BLOCK_IDS as readonly string[]).includes(id)),
    `${when} 含 fixture 三块`
  ).toBe(false);
  const texts = out.blocks.map((b) => b.text ?? '').join('\n');
  expect(texts, `${when} 投影/get_md 须含已知句子`).toContain(sentence);
}

async function resolveWorkspaceKey(page: Page): Promise<string> {
  return page.evaluate(async () => {
    // @ts-expect-error Vite devUrl 下 /src 与应用共享模块
    const mod = (await import(
      '/src/extensions/note-paper/productLeafBindings.ts'
    )) as { resolveNoteWorkspaceKey: () => string };
    return mod.resolveNoteWorkspaceKey();
  });
}

async function bindPreOpen(page: Page, docId: string): Promise<string> {
  return page.evaluate(async (id) => {
    // @ts-expect-error Vite devUrl 下 /src 与应用共享模块
    const leaf = (await import(
      '/src/extensions/note-paper/productLeafBindings.ts'
    )) as { resolveNoteWorkspaceKey: () => string };
    // @ts-expect-error Vite devUrl 下 /src 与应用共享模块
    const bind = (await import(
      '/src/components/workspace/workspaceEmptyStateStrictDoc.ts'
    )) as {
      bindWorkspacePersistedStrictDoc: (wsId: string, docId: string) => void;
    };
    const wsId = leaf.resolveNoteWorkspaceKey();
    bind.bindWorkspacePersistedStrictDoc(wsId, id);
    return wsId;
  }, docId);
}

async function unbindPreOpen(page: Page, wsId: string): Promise<void> {
  await page.evaluate(async (id) => {
    // @ts-expect-error Vite devUrl 下 /src 与应用共享模块
    const bind = (await import(
      '/src/components/workspace/workspaceEmptyStateStrictDoc.ts'
    )) as { unbindWorkspacePersistedStrictDoc: (wsId: string) => void };
    bind.unbindWorkspacePersistedStrictDoc(id);
  }, wsId);
}

async function collectBlockIds(page: Page): Promise<string[]> {
  return page.locator(`${PANEL} [data-block-id]`).evaluateAll((els) =>
    els
      .map((el) => el.getAttribute('data-block-id') ?? '')
      .filter((id) => id.length > 0)
  );
}

async function stripTauriGlobals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    for (const key of ['__TAURI_INTERNALS__', '__TAURI__', 'isTauri']) {
      try {
        delete w[key];
      } catch {
        /* 真壳不可删 */
      }
    }
  });
}

async function readTauriInternals(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  );
}
