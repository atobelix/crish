/**
 * E2E-L2 场景 ③：设置保存 → 重启 → 状态一致
 * （PE-11 T11.1 必覆盖场景 2；localStorage 持久化路径 + mock config 引擎）
 *
 * 设置入口：SettingsAppearanceTab → SettingsSchemaRenderer 的主题分段控件
 *   → saveSettingsEx 写入 `crish_settings` → settingsStore/themeProjection
 *   → prefs_set（成功后写入 `crish_theme` 引导镜像）。
 * L2 的共享 mock 引擎不实现 prefs_* 状态；本 spec 局部模拟该持久化边界，
 * 使 reload 能验证产品现有偏好 API 的读写与设置面板回显。
 *
 * 断言（行为级）：
 *   1. 修改设置（主题模式 → 深色）后 localStorage 生效
 *   2. reload 后设置面板回显新值（非默认）
 *   3. 无「待同步」提示（PE-01 T02.2 验收语义：引擎就绪且无同步横幅）
 *   4. LS 无明文 apiKey 残留（PE-07 T07.4 语义）
 */

import { test, expect, type Page } from '@playwright/test';
import { openApp as bootOpenApp } from './helpers/boot';

async function openApp(page: Page) {
  await bootOpenApp(page);
  await page.evaluate(installPersistentPreferences);
  // init script 在下一次 reload 时重新包装 mock IPC，保留 prefs_* 状态。
  await page.addInitScript(installPersistentPreferences);
}

/** L2 局部 prefs_* 持久化层；产品调用仍经过 preferencesClient / Tauri IPC。 */
function installPersistentPreferences() {
  const storageKey = '__crish_e2e_preferences_v1';
  const patch = (internals: any) => {
    if (!internals || internals.__crishE2ePreferencesPatched) return;
    const originalInvoke = internals.invoke.bind(internals);

    internals.invoke = (
      command: string,
      args?: Record<string, unknown>,
      options?: unknown
    ) => {
      if (command === 'prefs_get') {
        let preferences: Record<string, unknown> = {};
        try {
          preferences = JSON.parse(
            localStorage.getItem(storageKey) || '{}'
          );
        } catch {
          preferences = {};
        }
        if (typeof args?.key === 'string') {
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(preferences, args.key)
              ? { value: preferences[args.key] }
              : null
          );
        }
        return Promise.resolve(preferences);
      }

      if (command === 'prefs_set' || command === 'prefs_delete') {
        let preferences: Record<string, unknown> = {};
        try {
          preferences = JSON.parse(
            localStorage.getItem(storageKey) || '{}'
          );
        } catch {
          preferences = {};
        }
        const key = args?.key;
        if (typeof key === 'string') {
          if (command === 'prefs_set') {
            preferences[key] = args?.value;
          } else {
            delete preferences[key];
          }
          localStorage.setItem(
            storageKey,
            JSON.stringify(preferences)
          );
        }
        return Promise.resolve(null);
      }

      return originalInvoke(command, args, options);
    };
    internals.__crishE2ePreferencesPatched = true;
  };

  const current = (window as any).__TAURI_INTERNALS__;
  patch(current);
  let internals = current;
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    enumerable: true,
    get: () => internals,
    set: (next) => {
      internals = next;
      patch(next);
    },
  });
}

/** 打开设置弹窗并切到「外观」tab */
async function openAppearanceTab(page: Page) {
  await page.locator('[data-testid="sidebar-settings-gear-btn"]').click();
  const panel = page.locator('[data-testid="settings-panel"]');
  await expect(panel).toBeVisible();
  await page.locator('[data-testid="settings-tab-appearance"]').click();
  return panel;
}

test.describe('E2E-L2 设置保存与重启（settings-persist）', () => {
  test('修改设置 → reload → 面板回显一致', async ({ page }) => {
    await openApp(page);
    const panel = await openAppearanceTab(page);

    // 当前主题控件是 SegmentedControl：radiogroup 中以 aria-checked 表示选中。
    const themeGroup = panel.getByRole('radiogroup', { name: '主题模式' });
    const darkOption = themeGroup.getByRole('radio', { name: '深色' });
    await expect(darkOption).toBeVisible();
    await darkOption.click();

    // 设置 API 写入全局 settings，并等待主题 Commit Ack 镜像落盘。
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
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('crish_theme')))
      .toBe('dark');

    // ── 重启（reload）──
    await page.reload();
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await expect(page.locator('[data-engine-ready="true"]')).toBeVisible();

    // ── 回显：设置面板主题仍为「深色」──
    const panel2 = await openAppearanceTab(page);
    const darkOption2 = panel2
      .getByRole('radiogroup', { name: '主题模式' })
      .getByRole('radio', { name: '深色' });
    await expect(darkOption2).toBeVisible();
    await expect(darkOption2).toHaveAttribute('aria-checked', 'true');

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
    await expect(page.locator('[data-engine-ready="true"]')).toBeVisible();

    // reload 后引擎状态仍在（localStorage __crish_mock_store_v1 持久化）
    const cfgVal = await page.evaluate(() =>
      (window as any).__TAURI_INTERNALS__.invoke('config_get', {
        key: 'defaultModel',
      })
    );
    expect(cfgVal).toBe('gpt-4o-mini');
  });
});
