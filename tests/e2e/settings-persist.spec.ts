/**
 * E2E-L2 场景 ③：设置保存 → 重启 → 状态一致
 * （PE-11 T11.1 必覆盖场景 2；localStorage 持久化路径 + mock config 引擎）
 *
 * 真实链路：设置面板（外观 tab）→ clientApi.saveSettingsEx → localStorage
 *   `crish_settings` → page.reload() → 设置面板回显；mock 引擎的 config_*
 *   状态亦持久化（__crish_mock_store_v1），reload 后引擎状态保留。
 *
 * 断言（行为级）：
 *   1. 修改设置（主题模式 → 深色）后 localStorage 生效
 *   2. reload 后设置面板回显新值（非默认）
 *   3. 无「待同步」提示（PE-01 T02.2 验收语义：引擎就绪且无同步横幅）
 *   4. LS 无明文 apiKey 残留（PE-07 T07.4 语义）
 */

import { test, expect, type Page } from '@playwright/test';
import { installMockEngine } from './mock-engine';

async function openApp(page: Page) {
  await installMockEngine(page, {});
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
}

/** 打开设置弹窗并切到「外观」tab */
async function openAppearanceTab(page: Page) {
  await page.locator('[data-testid="settings-button"]').click();
  // ui/Menu 基座弹层在 low-height 视口下溢出（position:fixed 与 Radix transform
  // 定位冲突，既有产品缺陷）→ Playwright 命中测试失败，改用 dispatchEvent 派发
  // 点击语义（验证「全部设置 → SettingsPanel 打开」链路本体）。
  const qsAll = page.locator('[data-testid="quick-settings-all"]');
  await expect(qsAll).toBeVisible();
  await qsAll.dispatchEvent('click');
  const panel = page.locator('[data-testid="settings-panel"]');
  await expect(panel).toBeVisible();
  await page.locator('[data-testid="settings-tab-appearance"]').click();
  return panel;
}

test.describe('E2E-L2 设置保存与重启（settings-persist）', () => {
  test('修改设置 → reload → 面板回显一致', async ({ page }) => {
    await openApp(page);
    const panel = await openAppearanceTab(page);

    // 主题模式 toggle：默认浅色 → 点击「深色」
    const darkBtn = panel.getByRole('button', { name: '深色' });
    await expect(darkBtn).toBeVisible();
    await darkBtn.click();

    // 等待写入 localStorage（saveSettingsEx 异步）
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem('crish_settings');
          if (!raw) return null;
          try {
            return (JSON.parse(raw) as { theme?: string }).theme || null;
          } catch {
            return null;
          }
        })
      )
      .toBe('dark');

    // ── 重启（reload）──
    await page.reload();
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // ── 回显：设置面板主题仍为「深色」──
    const panel2 = await openAppearanceTab(page);
    // 深色为选中态（aria-pressed / data-state 由 toggle-group 提供）
    const darkBtn2 = panel2.getByRole('button', { name: '深色' });
    await expect(darkBtn2).toBeVisible();
    await expect(darkBtn2).toHaveAttribute('aria-pressed', 'true');

    // 无「待同步」提示（PE-01 T02.2：引擎就绪无同步横幅）
    await expect(page.getByText('待同步')).toBeHidden();

    // ── LS 无明文 apiKey（PE-07 T07.4 语义）──
    const lsKeys = await page.evaluate(() => {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) out.push(k);
      }
      return out;
    });
    expect(lsKeys.some((k) => /api[_-]?key/i.test(k))).toBe(false);
    // 明文密钥值也不应出现在任意 LS 值中
    const lsValues = await page.evaluate(() => {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) {
          const v = localStorage.getItem(k);
          if (v) out.push(v);
        }
      }
      return out.join('\n');
    });
    expect(lsValues).not.toContain('sk-');
  });

  test('reload 前后引擎 config_* 状态保留（mock 引擎持久化）', async ({
    page,
  }) => {
    await openApp(page);

    // 经引擎写入 config_update（等价设置页真源路径的 mock 侧）
    await page.evaluate(() => {
      (window as any).__TAURI_INTERNALS__.invoke('config_update', {
        defaultModel: 'gpt-4o-mini',
      });
    });

    await page.reload();
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // reload 后引擎状态仍在（localStorage __crish_mock_store_v1 持久化）
    const cfgVal = await page.evaluate(() =>
      (window as any).__TAURI_INTERNALS__.invoke('config_get', {
        key: 'defaultModel',
      })
    );
    expect(cfgVal).toBe('gpt-4o-mini');
  });
});
