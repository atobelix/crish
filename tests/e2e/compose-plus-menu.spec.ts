/**
 * P1-F4 ComposePlusMenu 锚点定位回归（PS-05 T5.4 / F7 F1）。
 *
 * 背景：ComposePlusMenu 曾用 display:none 空 div 作 Radix Popover 锚点，
 * @floating-ui/dom 对不可见 reference 的 getBoundingClientRect 返回全 0
 * （floating-ui.dom.mjs:36）→ 菜单实际定位到视口 (0,0) 左上角，而非「+」按钮上方。
 *
 * 断言口径（真实定位回归锚）：
 *  1. 菜单不钉在视口顶部（menuBox.y 远离 0）——修复前菜单在视口原点，必红；
 *  2. side="top"：菜单整体位于触发按钮上方（菜单底边 ≤ 按钮顶边 + 偏移容差）；
 *  3. align="start"：菜单与按钮水平距离有限（< 300px），非漂移到原点。
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockEngine } from './mock-engine';

/** 等待引擎就绪：transport waitUntilConnected 完成后 UI 门闩放行 */
async function openApp(page: Page) {
  await installMockEngine(page);
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator('[data-engine-ready="true"]')).toBeVisible({
    timeout: 8000,
  });
}

test.describe('P1-F4 ComposePlusMenu 锚点定位', () => {
  test('「+」菜单弹出在按钮上方，不落在视口 (0,0)', async ({ page }) => {
    await openApp(page);

    const plusBtn = page.locator('[aria-label="打开添加菜单"]');
    await expect(plusBtn).toBeVisible();
    await plusBtn.click();

    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();

    const btnBox = await plusBtn.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(btnBox, '触发按钮 boundingBox').not.toBeNull();
    expect(menuBox, '菜单 boundingBox').not.toBeNull();
    if (!btnBox || !menuBox) return;

    // 修复前：浮动锚点 display:none（rect 全 0）→ 菜单钉在视口左上角 (0,0)
    expect(menuBox.y, '菜单不应钉在视口顶部').toBeGreaterThan(150);
    // side="top"：菜单整体位于触发按钮上方（sideOffset 6 + 断言容差）
    expect(
      menuBox.y + menuBox.height,
      '菜单底边应在按钮顶边之上'
    ).toBeLessThanOrEqual(btnBox.y + 12);
    // align="start"：菜单与按钮水平对齐（距离有限，非漂移到视口原点）
    expect(Math.abs(menuBox.x - btnBox.x), '菜单与按钮水平距离').toBeLessThan(
      300
    );
  });
});
