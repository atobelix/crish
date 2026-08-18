/**
 * CONN-E2′-tauri · 真 WebView detect 一次（扩展 note 叶）
 *
 * 交付主面在 jsdom：`Workspace.conn-e2-prime-tauri.test.tsx`
 * （`createTauriNoteMirrorIpc` + 可信 `mockTauriCommand` invoke 一次填 report）。
 *
 * 本 spec：
 * - 9222 不可达 / 非 WebView2 → **失败可读**（禁止 skip 当绿）
 * - 到达 = 扩展 note 叶（openNoteLeaf）
 * - 探针在 note 叶 / 纸面 / StatusBar；叶已开但政策位与 StatusBar 皆无 → **失败**
 *
 * ≠ EL-03 · ≠ inotify 满关 · ≠ 默认双开 poll+OS · ≠ 重做 E2′ 策略
 * ≠ 打开完成
 */
import { test, expect } from '@playwright/test';
import { connectWebView, listCdpTargets } from './cdp';
import {
  NOTE_LEAF,
  PANEL,
  assertRealWebView,
  closeNoteLeafIfOpen,
  openNoteLeaf,
} from './arrive-note-leaf';

test.describe('CONN-E2′-tauri 真 WebView detect（扩展 note 叶）', () => {
  test('conn_e2p_tauri_webview_host_detect_once_or_skip_undelivered', async () => {
    const targets = await listCdpTargets();
    expect(targets.length).toBeGreaterThan(0);

    const session = await connectWebView();
    try {
      await assertRealWebView(session.page);
      await openNoteLeaf(session.page);

      const policy = session.page.locator(
        [
          `${NOTE_LEAF}[data-mirror-detect-policy]`,
          `${NOTE_LEAF} [data-mirror-detect-policy]`,
          `${PANEL}[data-mirror-detect-policy]`,
        ].join(', ')
      );
      const bar = session.page.getByTestId('mirror-drift-status-bar');
      const policyCount = await policy.count();
      const barCount = await bar.count();
      if (policyCount === 0 && barCount === 0) {
        throw new Error(
          '本切片未交付：note 叶无 mirror-detect 探针（探测面未随扩展迁出死 Host）'
        );
      }

      if (policyCount > 0) {
        const host = policy.first();
        await expect(host).toHaveAttribute('data-el03', 'not-claimed');
        await expect(host).toHaveAttribute('data-inotify-full', 'not-claimed');
      }

      if (barCount > 0) {
        const watch = await bar.first().getAttribute('data-watch-source');
        expect(watch).not.toBe('os_event');
      }
    } finally {
      await closeNoteLeafIfOpen(session.page).catch(() => undefined);
      await session.browser.close();
    }
  });
});
