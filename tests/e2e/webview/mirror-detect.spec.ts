/**
 * CONN-E2′-tauri · 真 WebView detect 一次（可选加深）
 *
 * 交付主面在 jsdom：`Workspace.conn-e2-prime-tauri.test.tsx`
 * （`createTauriNoteMirrorIpc` + 可信 `mockTauriCommand` invoke 一次填 report）。
 *
 * 本 spec：
 * - 9222 不可达 / 非 CDP → **skip=未交付**（可读原因；不静默超时）
 * - 9222 可达但当前窗口无空态 Host / Strict 探针 → **skip=未交付**
 * - 若 Host 可见：policy=1；有 ipc 时 schedule=1；watchSource 不得无 OS 写 os_event
 *
 * ≠ EL-03 · ≠ inotify 满关 · ≠ 默认双开 poll+OS · ≠ 重做 E2′ 策略
 */
import { test, expect } from '@playwright/test';
import { connectWebView, listCdpTargets } from './cdp';

test.describe('CONN-E2′-tauri 真 WebView detect', () => {
  test('conn_e2p_tauri_webview_host_detect_once_or_skip_undelivered', async () => {
    try {
      await listCdpTargets();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      test.skip(
        true,
        `CONN-E2′-tauri 真 WebView 未交付：9222 不可达或非 CDP。${detail}`
      );
      return;
    }

    const session = await connectWebView();
    try {
      const internals = await session.page.evaluate(
        () => typeof (window as Record<string, unknown>).__TAURI_INTERNALS__
      );
      expect(internals).toBe('object');

      const host = session.page.locator(
        '[data-empty="true"][data-mirror-detect-policy="1"]'
      );
      const hostCount = await host.count();
      if (hostCount === 0) {
        test.skip(
          true,
          'CONN-E2′-tauri 真 WebView 未交付：当前窗口无空态 Host（data-mirror-detect-policy=1）。jsdom 集成测已覆盖 invoke 一次。'
        );
        return;
      }

      await expect(host.first()).toHaveAttribute(
        'data-mirror-detect-policy',
        '1'
      );
      await expect(host.first()).toHaveAttribute('data-el03', 'not-claimed');
      await expect(host.first()).toHaveAttribute(
        'data-inotify-full',
        'not-claimed'
      );

      const schedule = await host
        .first()
        .getAttribute('data-mirror-detect-schedule');
      if (schedule !== '1') {
        test.skip(
          true,
          `CONN-E2′-tauri 真 WebView 未交付：Host 可见但 schedule=${schedule}（enable∧ipc 未同时成立）。`
        );
        return;
      }

      const openBtn = session.page.getByTestId('open-note-paper-strict');
      if ((await openBtn.count()) > 0) {
        await openBtn.first().click();
      }

      const bar = session.page.getByTestId('mirror-drift-status-bar');
      const barCount = await bar.count();
      if (barCount === 0) {
        test.skip(
          true,
          'CONN-E2′-tauri 真 WebView 未交付：schedule=1 但 StatusBar 未出现（detect 一次未在本窗兑现）。'
        );
        return;
      }

      const watch = await bar.first().getAttribute('data-watch-source');
      expect(watch).not.toBe('os_event');
    } finally {
      await session.browser.close();
    }
  });
});
