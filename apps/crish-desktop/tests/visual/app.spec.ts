import { test, expect } from '@playwright/test';

test.describe('Visual Regression', () => {
  test('app loads with correct layout', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#root')).toBeVisible();
    await expect(page).toHaveScreenshot('app-initial.png');
  });

  test('sidebar is visible and contains session list', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await expect(page).toHaveScreenshot('sidebar.png');
  });

  test('settings panel renders correctly', async ({ page }) => {
    await page.goto('/');
    await page.click('[data-testid="settings-button"]');
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
    await expect(page).toHaveScreenshot('settings-panel.png');
  });
});
