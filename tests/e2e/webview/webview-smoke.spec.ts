/**
 * CONN-01 · 真 WebView 载体冒烟（e2e-webview project）
 *
 * 钉死的链路：CDP 9222 → connectOverCDP → 找到 Crish WebView target
 * → 断言真实窗口 store 门面（main.tsx:33-35 暴露的 __CRISH_SESSION_STORE__
 * 等）与真 Tauri 宿主（__TAURI_INTERNALS__），并确认**非** mock 沙箱
 * （window.__CRISH_E2E__ 不存在；本 spec 不注入任何 addInitScript /
 * localStorage 种子 —— AGENTS.md §15.4 禁 mock 验收）。
 *
 * 诚实边界句（D-07 §1.2，禁止删除）：
 *   ≠ EL-01/08；≠ 打开完成；≠ A-BLK e2e；≠ inotify 满关。
 *   冒烟只钉「载体可测」：禁止以冒烟断言 data-hydrate-source 充当产品
 *   连通证据（那是 CONN-06 的账）；本 spec 不触碰 Strict 视图探针
 *   （data-ws-id / data-empty 等存在性属 CONN-03/04/06 用例域）。
 *
 * 运行前置：npm run dev:workbench（WebView2 带 9222）。9222 不可达时
 * fail-fast 抛可读错误（见 cdp.ts），不静默超时；本 spec 在独立
 * tests/e2e/webview/playwright.config.ts 下运行（不挂 webServer）。
 */
import { test, expect } from '@playwright/test';
import { connectWebView, listCdpTargets } from './cdp';

test.describe('CONN-01 真 WebView 载体冒烟（e2e-webview）', () => {
  test('conn_c01_smoke_webview_cdp_reachable_and_real_store_facade', async () => {
    // ① 9222 fail-fast 探测（不可达 → 可读错误，非静默超时）
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    // ② connectOverCDP 挂接 WebView page
    const session = await connectWebView();
    try {
      // ③ 真 Tauri 宿主：独立浏览器窗口无 __TAURI_INTERNALS__（无 IPC 宿主，
      //    IPC 静默失败；AGENTS.md §15.3 禁止把 5174 独立浏览器当验收环境）
      const internals = await session.page.evaluate(
        () => typeof (window as Record<string, unknown>).__TAURI_INTERNALS__
      );
      expect(internals).toBe('object');

      // ④ 真实 store 门面（main.tsx:33-35 暴露，非 mock 会话 / 内存 seed）
      const facades = await session.page.evaluate(() => {
        const w = window as Record<string, unknown>;
        return {
          sessionStore: typeof w.__CRISH_SESSION_STORE__,
          legacyStore: typeof w.__CRISH_STORE__,
          layoutStore: typeof w.__CRISH_LAYOUT_STORE__,
          treeStore: typeof w.__CRISH_TREE_STORE__,
        };
      });
      expect(facades.sessionStore).toBe('function');
      expect(facades.legacyStore).toBe('function');
      expect(facades.layoutStore).toBe('function');
      expect(facades.treeStore).toBe('function');
    } finally {
      await session.browser.close();
    }
  });

  test('conn_c01_smoke_webview_not_mock_sandbox_and_root_rendered', async () => {
    const session = await connectWebView();
    try {
      // ① 非 mock 沙箱：mock-engine 注入句柄 __CRISH_E2E__ 必须不存在
      const hasE2eHandle = await session.page.evaluate(
        () => '__CRISH_E2E__' in window
      );
      expect(hasE2eHandle).toBe(false);

      // ② 应用根渲染（#root 挂真实 UI 子树；首次冷启动放宽至 20s）
      await expect(session.page.locator('#root')).toBeVisible({
        timeout: 20_000,
      });
      const rootChildren = await session.page.locator('#root > *').count();
      expect(rootChildren).toBeGreaterThan(0);
    } finally {
      await session.browser.close();
    }
  });
});
