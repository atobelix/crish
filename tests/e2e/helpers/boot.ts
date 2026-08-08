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
}

/**
 * 向 composer（contenteditable ProseMirror）键入文本。
 *
 * 背景：chat-input 已从 textarea 迁移为 tiptap contenteditable div
 * （tiptap 接线收尾），Playwright fill() 仅适用于 input/textarea，
 * 对 contenteditable 会抛 Not an input element —— 统一走
 * click + keyboard.type（触发真实键入事件链，含 tiptap onUpdate 防抖回流）。
 */
export async function typeIntoComposer(page: Page, text: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await input.click();
  await page.keyboard.type(text, { delay: 8 });
}

/**
 * contenteditable 文本断言（替代 toHaveValue —— 该断言仅适用于
 * input/textarea，对 div 抛 Not an input element）。
 */
export async function expectComposerText(page: Page, expected: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await expect(input).toHaveText(expected);
}
