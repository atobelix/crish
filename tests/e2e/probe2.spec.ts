import { test, expect } from '@playwright/test';
import { installMockEngine, fenceRunEvents } from './mock-engine';
import { typeIntoComposer } from './helpers/boot';

test('probe fence final state', async ({ page }) => {
  await installMockEngine(page, {
    runStream: { events: fenceRunEvents(), delayMs: 150 },
  });
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  await expect(page.locator('[data-engine-ready="true"]')).toBeVisible({
    timeout: 8000,
  });

  const input = page.locator('[data-testid="chat-input"]');
  await typeIntoComposer(page, '给我一段代码');
  await input.press('Enter');

  const assistantRow = page.locator('.msg-row-assistant').first();
  await expect(assistantRow).toBeVisible();

  // 复刻失败断言路径：finalBlock 可见后立即读 innerText
  const finalBlock = assistantRow.locator('.md-rendered:not(.is-streaming)');
  await expect(finalBlock.first()).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(1500);
  const dump = await page.evaluate(() => {
    const store = (window as any).__CRISH_STORE__;
    const byId = store?.getState?.().sessionsById || {};
    const k = Object.keys(byId)[0];
    const msg = k
      ? byId[k].messages.find((m: any) => m.sender === 'assistant')
      : null;
    const el = document.querySelector('.md-rendered:not(.is-streaming)');
    return {
      msgText: msg ? msg.text : null,
      msgStatus: msg ? msg.status : null,
      innerHTML: el ? el.innerHTML.slice(0, 300) : null,
      innerText: el ? el.innerText : null,
      className: el ? el.className : null,
    };
  });
  console.log('FENCE DUMP:', JSON.stringify(dump, null, 1));
});
