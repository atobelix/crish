/**
 * e2e 公共 boot 就绪 helper（G15c 冷启动基建）。
 *
 * 统一「应用首屏就绪」等待语义（原 full-journey.spec.ts openApp 模式）：
 *   transport waitUntilConnected（core_get_status 轮询）完成后 UI 门闩放行
 *   （应用容器 data-engine-ready 属性由 useEngineBootstrap 驱动）。
 *
 * 超时分层：webServer 启动 180s > 用例超时 30s > 本 helper 就绪断言 8s。
 * 各 spec 首屏等待一律走 openApp，禁止散落硬编码 sleep。
 */
import { expect, type Page } from '@playwright/test';
import { installMockEngine } from '../mock-engine';

export type MockEngineConfig = Parameters<typeof installMockEngine>[1];

/** 安装 mock 引擎并等待应用首屏 + 引擎门闩就绪 */
export async function openApp(page: Page, config: MockEngineConfig = {}) {
  await installMockEngine(page, config);
  await page.goto('/');
  // 首屏与侧栏等待放宽至 20s：冷启动时 vite 首屏编译可能远超默认 5s
  // （系统性收口 2026-08-04：cache-metrics/cache-telemetry 冷启动 boot 超时修复；
  //  2026-08-07：tiptap 依赖 9 包冷编译首屏更慢，15s→20s）
  await expect(page.locator('#root')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
    timeout: 20000,
  });
  // 引擎门闩：应用容器 data-engine-ready 属性由 useEngineBootstrap 驱动
  await expect(page.locator('[data-engine-ready="true"]')).toBeVisible({
    timeout: 8000,
  });
  const modelSelector = page.locator('[data-testid="model-selector-button"]');
  await expect(modelSelector).toBeVisible({ timeout: 20000 });
  await expect(modelSelector).toHaveAttribute('data-needs-model-setup', 'false', {
    timeout: 20000,
  });
}

/** Click 「新对话」并等草稿状态与 composer 水合完成后再开始输入。 */
export async function startNewSession(page: Page): Promise<void> {
  await page.locator('[data-testid="new-session-button"]').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__CRISH_STORE__?.getState?.().activeSessionId
      )
    )
    .toMatch(/^__pending_draft__(?::|$)/);
  const activeSessionId = await page.evaluate(
    () => (window as any).__CRISH_STORE__?.getState?.().activeSessionId
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector('[data-panel-id="chat"][data-active="true"]')
            ?.getAttribute('data-session-id') ?? null
      )
    )
    .toBe(activeSessionId);
  const tiptapInput = page.locator(
    '[data-testid="chat-input"][contenteditable="true"]'
  );
  await expect(tiptapInput).toBeVisible();
  await expect(tiptapInput).toHaveText('');
}

/**
 * 向 composer（contenteditable ProseMirror）逐字符键入测试文本，并核对
 * 编辑器文本、发送按钮状态和宿主草稿都已收到完整输入。
 */
export async function typeIntoComposer(page: Page, text: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await input.click();
  await page.keyboard.type(text, { delay: 8 });
  await expect(input).toHaveText(text, { timeout: 5000 });
  await expect(
    page.locator('[data-composer-send] [data-send-active="1"]')
  ).toBeVisible({ timeout: 5000 });
  await expect
    .poll(() =>
      page.evaluate((expected) => {
        const store = (window as any).__CRISH_STORE__?.getState?.();
        const activeSessionId = store?.activeSessionId;
        return activeSessionId
          ? store?.composerDrafts?.[activeSessionId] ?? ''
          : '';
      }, text)
    )
    .toBe(text);
}

/**
 * contenteditable 文本断言（替代 toHaveValue —— 该断言仅适用于
 * input/textarea，对 div 抛 Not an input element）。
 */
export async function expectComposerText(page: Page, expected: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await expect(input).toHaveText(expected);
}
