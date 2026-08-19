/**
 * 06 · 真壳到达 helper：扩展 note 叶的唯一打开实现。
 *
 * 5174 双身份（禁止混）：
 * - WebView **文档 URL** 含 localhost:5174（tauri.conf.json build.devUrl）= 合法
 * - 测试进程 `page.goto('http://localhost:5174')` / 独立 Chrome = 非法
 *
 * 打开只承认 P5：产品钮 → 真模块 openToolInSession → 树门面。
 * 禁止第 5 步：死 CTA / 空态 Host / 写 layoutStore 已删字段。
 *
 * ≠ EL · ≠ 打开完成（本 helper 只保证走到扩展叶上的 Strict 面板）
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const NOTE_LEAF =
  '[data-leaf-id][data-panel-id="note"], [data-leaf-id][data-panel-id^="note:"]';
export const PANEL = `${NOTE_LEAF} [data-testid="note-paper-strict-panel"]`;
export const OPEN_NOTE =
  '[data-testid="chat-open-note"], [data-leaf-tool-tab-strip] [data-panel="note"], [data-unit-chrome-actions] [data-panel="note"]';
export const SLASH_OVERLAY = '[data-testid="note-paper-strict-slash-overlay"]';
export const SLASH_TRIGGER = '[data-testid="note-paper-strict-open-slash"]';
export const SLASH_CLOSE = '[data-testid="note-paper-strict-close"]';
export const UNKNOWN_NOTE = 'text=未知面板类型：note';

const CDP_LIST = 'http://127.0.0.1:9222/json/list';
const PANEL_WAIT_MS = 20_000;
const FALLBACK_WAIT_MS = 8_000;

export type OpenNoteLeafResult = {
  via: 'already-open' | 'product-button' | 'dev-openTool' | 'tree-store';
  leafId: string;
};

type TreeLeafSnap = {
  id: string;
  panelId: string;
  tabs: string[];
  activeTab: string;
};

type TreeStoreFacade = {
  getState: () => {
    tree?: { root?: unknown };
    addTabToLeaf?: (leafId: string, tabId: string) => void;
    setActiveTab?: (leafId: string, tabId: string) => void;
    setToolColumnCollapsed?: (collapsed: boolean) => void;
    splitLeaf?: (
      leafId: string,
      direction: 'horizontal' | 'vertical',
      newPanelId: string,
      position?: 'before' | 'after',
      splitRatio?: number
    ) => void;
    removeTabFromLeaf?: (leafId: string, tabId: string) => void;
  };
};

type SessionStoreFacade = {
  getState: () => { activeSessionId?: string };
};

export function noteLeafLocator(page: Page): Locator {
  return page.locator(NOTE_LEAF);
}

export function notePanelLocator(page: Page): Locator {
  return page.locator(PANEL);
}

/** 9222 必须是 WebView2；404 / 非 2xx / 非数组 = 非 WebView2，失败可读。 */
async function assertCdpIsWebView2(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(CDP_LIST, {
      signal: AbortSignal.timeout(3_000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      '本切片未交付：9222 不可达（非 WebView2 载体）。请先 npm run dev:workbench，' +
        `WebView2 须带 --remote-debugging-port=9222。底层：${detail}`
    );
  }
  if (!res.ok) {
    throw new Error(
      `本切片未交付：9222 非 WebView2（/json/list ${res.status}）。` +
        '请确认 msedgewebview2 带 9222，不要开独立 Chrome 占端口。'
    );
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      '本切片未交付：9222 /json/list 非 JSON（非 WebView2）。' +
        '请确认 msedgewebview2 带 9222，不要开独立 Chrome 占端口。'
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(
      '本切片未交付：9222 /json/list 非数组（非 WebView2）。' +
        '请确认 msedgewebview2 带 9222，不要开独立 Chrome 占端口。'
    );
  }
}

function isWebViewDocumentUrl(url: string): boolean {
  if (!url) return false;
  if (url.includes('localhost:5174')) return true;
  if (url.startsWith('tauri://')) return true;
  if (url.includes('tauri.localhost')) return true;
  return false;
}

async function assertNotMockSandbox(page: Page): Promise<void> {
  const hasE2eHandle = await page.evaluate(() => '__CRISH_E2E__' in window);
  expect(hasE2eHandle, '本切片未交付：检测到 __CRISH_E2E__ mock 沙箱').toBe(
    false
  );
}

async function assertRootReady(page: Page): Promise<void> {
  await expect(page.locator('#root')).toBeVisible({ timeout: 20_000 });
  const childCount = await page.locator('#root > *').count();
  if (childCount === 0) {
    throw new Error(
      '本切片未交付：#root 无子节点（01 叶高未兑现或壳未挂真实 UI）'
    );
  }
}

async function assertWebViewDocumentUrl(page: Page): Promise<void> {
  const url = page.url();
  if (!isWebViewDocumentUrl(url)) {
    throw new Error(
      `本切片未交付：page.url 不是 WebView 文档（${url}）。` +
        '合法是 WebView 内 localhost:5174（devUrl）或 tauri://；' +
        '禁止独立 Chrome goto(5174)。'
    );
  }
}

/**
 * 真壳门闩。非 WebView2 / 404 / 无 Tauri / mock 一律失败可读。
 * 文档 URL 含 5174 ≠ 独立 5174。
 */
export async function assertRealWebView(page: Page): Promise<void> {
  await assertCdpIsWebView2();
  await assertRootReady(page);
  await assertWebViewDocumentUrl(page);
  await assertNotMockSandbox(page);

  const internals = await page.evaluate(
    () =>
      typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  );
  expect(
    internals,
    '本切片未交付：无 __TAURI_INTERNALS__（禁止 5174 独立浏览器当真产品）'
  ).toBe('object');
}

async function waitPanelVisible(page: Page, timeout: number): Promise<boolean> {
  try {
    await notePanelLocator(page)
      .first()
      .waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** I4：面板必须是 note / note: 叶的后代。 */
async function assertPanelInsideNoteLeaf(page: Page): Promise<string> {
  const panel = notePanelLocator(page).first();
  await expect(
    panel,
    '本切片未交付：note 叶内未见 note-paper-strict-panel'
  ).toBeVisible({ timeout: PANEL_WAIT_MS });

  const leaf = panel.locator('xpath=ancestor::*[@data-leaf-id][1]');
  await expect(
    leaf,
    '本切片未交付：面板未走 BinaryTree（无 data-leaf-id 祖先）'
  ).toHaveCount(1);

  const panelId = await leaf.getAttribute('data-panel-id');
  if (panelId !== 'note' && !panelId?.startsWith('note:')) {
    throw new Error(
      `本切片未交付：面板未走 BinaryTree note 叶（data-panel-id=${panelId ?? 'null'}）`
    );
  }
  const leafId = await leaf.getAttribute('data-leaf-id');
  if (!leafId) {
    throw new Error('本切片未交付：note 叶无 data-leaf-id');
  }
  return leafId;
}

function throwIfUnknownNotePanel(page: Page): Promise<void> {
  return (async () => {
    const unknown = page.locator(UNKNOWN_NOTE);
    const unknownUri = page.getByText(/未知面板类型：note/);
    const unknownCount = (await unknown.count()) + (await unknownUri.count());
    if (unknownCount === 0) return;
    if (await waitPanelVisible(page, 200)) return;
    throw new Error(
      '本切片未交付：扩展未注册 / factory 未挂 SlotOutlet（未知面板类型：note）'
    );
  })();
}

async function tryProductButton(page: Page): Promise<boolean> {
  const btn = page.locator(OPEN_NOTE).first();
  if (!(await btn.isVisible().catch(() => false))) {
    return false;
  }
  await btn.click();
  return waitPanelVisible(page, PANEL_WAIT_MS);
}

async function tryDevOpenTool(page: Page): Promise<boolean> {
  const href = page.url();
  if (!href.includes('localhost:5174')) {
    return false;
  }
  const opened = await page.evaluate(async () => {
    const w = window as unknown as {
      __CRISH_SESSION_STORE__?: SessionStoreFacade;
    };
    const fromStore = w.__CRISH_SESSION_STORE__?.getState?.()?.activeSessionId;
    let sid =
      typeof fromStore === 'string' && fromStore.trim() ? fromStore.trim() : '';
    if (!sid) {
      const active = document.querySelector(
        '[data-leaf-id][data-session-id][data-active="true"]'
      );
      sid = active?.getAttribute('data-session-id') ?? '';
    }
    if (!sid) {
      const any = document.querySelector('[data-leaf-id][data-session-id]');
      sid = any?.getAttribute('data-session-id') ?? '';
    }
    try {
      // 与 G2 总线探针同一纪律：devUrl 下动态 import 共享应用模块，不伪造 IPC
      // @ts-expect-error 运行时由 Vite dev 解析 /src/
      const mod = await import('/src/store/workspace-shell/openTool.ts');
      const open = (
        mod as {
          openToolInSession?: (sessionId: string, panelId: string) => void;
        }
      ).openToolInSession;
      if (typeof open !== 'function') return false;
      open(sid, 'note');
      return true;
    } catch {
      return false;
    }
  });
  if (!opened) return false;
  return waitPanelVisible(page, FALLBACK_WAIT_MS);
}

async function tryTreeStore(page: Page): Promise<boolean> {
  const opened = await page.evaluate(() => {
    const w = window as unknown as { __CRISH_TREE_STORE__?: TreeStoreFacade };
    const store = w.__CRISH_TREE_STORE__;
    if (!store || typeof store.getState !== 'function') return false;
    const state = store.getState();
    const root = state.tree?.root;
    if (!root) return false;

    const collect = (node: unknown): TreeLeafSnap[] => {
      if (!node || typeof node !== 'object') return [];
      const n = node as {
        type?: string;
        id?: string;
        panelId?: string;
        tabs?: unknown;
        activeTab?: string;
        children?: unknown[];
      };
      if (n.type === 'leaf') {
        const tabs = Array.isArray(n.tabs) ? n.tabs.map(String) : [];
        return [
          {
            id: String(n.id ?? ''),
            panelId: String(n.panelId ?? ''),
            tabs,
            activeTab: String(n.activeTab ?? ''),
          },
        ];
      }
      const kids = Array.isArray(n.children) ? n.children : [];
      return kids.flatMap((c) => collect(c));
    };

    const isPrimary = (panelId: string): boolean =>
      panelId === 'chat' ||
      panelId.startsWith('chat:') ||
      panelId.startsWith('__pending') ||
      panelId.startsWith('pending:');
    const isNote = (panelId: string): boolean =>
      panelId === 'note' || panelId.startsWith('note:');

    const leaves = collect(root).filter((l) => l.id);
    if (leaves.length === 0) return false;

    const hasNoteTab = (leaf: TreeLeafSnap): boolean =>
      isNote(leaf.panelId) ||
      leaf.tabs.some((t) => isNote(t)) ||
      isNote(leaf.activeTab);

    const noteLeaf = leaves.find(hasNoteTab);
    const toolLeaf = leaves.find(
      (l) => !isPrimary(l.panelId) && !hasNoteTab(l)
    );
    const chatLeaf = leaves.find((l) => isPrimary(l.panelId));

    const s = store.getState();
    if (typeof s.setToolColumnCollapsed === 'function') {
      s.setToolColumnCollapsed(false);
    }

    if (noteLeaf) {
      const tab =
        noteLeaf.tabs.find((t) => isNote(t)) ??
        (isNote(noteLeaf.activeTab) ? noteLeaf.activeTab : 'note');
      s.setActiveTab?.(noteLeaf.id, tab);
      return true;
    }
    if (toolLeaf) {
      s.addTabToLeaf?.(toolLeaf.id, 'note');
      s.setActiveTab?.(toolLeaf.id, 'note');
      return true;
    }
    if (chatLeaf && typeof s.splitLeaf === 'function') {
      s.splitLeaf(chatLeaf.id, 'horizontal', 'note', 'after', 0.5);
      return true;
    }
    return false;
  });
  if (!opened) return false;
  return waitPanelVisible(page, FALLBACK_WAIT_MS);
}

/**
 * 打开扩展 note 叶。算法 §5.1.3：已开 → 产品钮 → 真 openTool → 树门面。
 * 无第 5 步 CTA。B3 无宿主分支仍走本函数（不在此处强制 Tauri，由调用方先 assert）。
 */
export async function openNoteLeaf(page: Page): Promise<OpenNoteLeafResult> {
  await assertCdpIsWebView2();
  await assertRootReady(page);
  await assertWebViewDocumentUrl(page);
  await assertNotMockSandbox(page);

  if (await waitPanelVisible(page, 250)) {
    const leafId = await assertPanelInsideNoteLeaf(page);
    return { via: 'already-open', leafId };
  }

  if (await tryProductButton(page)) {
    const leafId = await assertPanelInsideNoteLeaf(page);
    return { via: 'product-button', leafId };
  }

  if (await tryDevOpenTool(page)) {
    const leafId = await assertPanelInsideNoteLeaf(page);
    return { via: 'dev-openTool', leafId };
  }

  if (await tryTreeStore(page)) {
    const leafId = await assertPanelInsideNoteLeaf(page);
    return { via: 'tree-store', leafId };
  }

  await throwIfUnknownNotePanel(page);

  if (await waitPanelVisible(page, PANEL_WAIT_MS)) {
    const leafId = await assertPanelInsideNoteLeaf(page);
    return { via: 'tree-store', leafId };
  }

  await throwIfUnknownNotePanel(page);
  throw new Error(
    '本切片未交付：无法经产品钮 / 真 openTool / 树门面打开 note 叶（01 叶高或 02 激活未兑现）'
  );
}

export async function closeNoteLeafIfOpen(page: Page): Promise<void> {
  if ((await noteLeafLocator(page).count()) === 0) {
    return;
  }

  const closeBtn = page.locator(`${NOTE_LEAF} ${SLASH_CLOSE}`).first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click().catch(() => undefined);
    try {
      await notePanelLocator(page).first().waitFor({
        state: 'hidden',
        timeout: 5_000,
      });
    } catch {
      /* 扩展叶未必接线 onClose；改走树 / openTool(chat) */
    }
  }

  if ((await noteLeafLocator(page).count()) === 0) {
    return;
  }

  await page
    .evaluate(() => {
      const w = window as unknown as { __CRISH_TREE_STORE__?: TreeStoreFacade };
      const store = w.__CRISH_TREE_STORE__;
      if (!store?.getState) return;
      const s = store.getState();
      const root = s.tree?.root;
      if (!root || typeof s.removeTabFromLeaf !== 'function') return;

      const collect = (node: unknown): TreeLeafSnap[] => {
        if (!node || typeof node !== 'object') return [];
        const n = node as {
          type?: string;
          id?: string;
          panelId?: string;
          tabs?: unknown;
          activeTab?: string;
          children?: unknown[];
        };
        if (n.type === 'leaf') {
          const tabs = Array.isArray(n.tabs) ? n.tabs.map(String) : [];
          return [
            {
              id: String(n.id ?? ''),
              panelId: String(n.panelId ?? ''),
              tabs,
              activeTab: String(n.activeTab ?? ''),
            },
          ];
        }
        const kids = Array.isArray(n.children) ? n.children : [];
        return kids.flatMap((c) => collect(c));
      };

      const isNote = (panelId: string): boolean =>
        panelId === 'note' || panelId.startsWith('note:');
      const noteLeaves = collect(root).filter(
        (l) =>
          isNote(l.panelId) ||
          l.tabs.some((t) => isNote(t)) ||
          isNote(l.activeTab)
      );
      for (const leaf of noteLeaves) {
        const tab =
          leaf.tabs.find((t) => isNote(t)) ??
          (isNote(leaf.activeTab) ? leaf.activeTab : leaf.panelId);
        s.removeTabFromLeaf?.(leaf.id, tab);
      }
    })
    .catch(() => undefined);

  if ((await noteLeafLocator(page).count()) === 0) {
    return;
  }

  if (page.url().includes('localhost:5174')) {
    await page
      .evaluate(async () => {
        const w = window as unknown as {
          __CRISH_SESSION_STORE__?: SessionStoreFacade;
        };
        const sid =
          w.__CRISH_SESSION_STORE__?.getState?.()?.activeSessionId?.trim() ??
          '';
        try {
          // @ts-expect-error 运行时由 Vite dev 解析 /src/
          const mod = await import('/src/store/workspace-shell/openTool.ts');
          (
            mod as {
              openToolInSession?: (sessionId: string, panelId: string) => void;
            }
          ).openToolInSession?.(sid, 'chat');
        } catch {
          /* 收坞失败不挡用例 */
        }
      })
      .catch(() => undefined);
  }
}
