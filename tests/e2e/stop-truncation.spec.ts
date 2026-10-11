/**
 * E2E-L2 场景：P2-1 stop 终稿截断修复（R2-4 批次，V6 判据，B-3 补写）。
 *
 * 背景（docs/frontend-audit/60-repair2/20-proposals/02-performance-fixes.md ①P2-1）：
 * 旧实现 finalizeStopGeneration 在 flushFinal 后调用 stopBuf.stop()（取消 rAF 预算
 * 循环，大残余 >16KB 时 isFinal 帧永不到达），且 partialText 取 getStreamText 陈旧
 * 截断值 → stop 点击瞬间 buffer 积压 >16KB 时终稿截断。
 * R2-4 四步修复（useStreamCallbacks.ts）：
 *   F1a 删除 stopBuf.stop()（预算循环自然收口于 isFinal 帧）
 *   F1b partialText 换序 stopBuf.currentText() 优先（恒为完整全文）
 *   F1c stop 路径 isFinal 帧不写 streamingStore（防 commit 后残留键）
 *   F1d 截断防御断言（committed < buffered → console.warn + diag 'stop-truncation'）
 *
 * 判据（00-master-plan.md R2-4 验证列）：V6 e2e + Stop 控件 data-testid 确认：
 *   - 完成态文本含 marker-0 至 marker-119 全量（无截断）；
 *   - 无「## 本轮总结」残留（完成态占位标题剥离，stripThoughtPlaceholders）；
 *   - Stop 控件 data-testid="composer-stop" 可定位（ComposerField.tsx:346 /
 *     TiptapComposerField.tsx:401，已存在，无需补充）。
 *
 * 场景设计：
 * ① 确定性 >16KB 积压回归：mock 引擎不自动推流，测试经 window.__CRISH_E2E__.emit
 *    在同一 JS 轮内同步 emit 全部 message-delta（rAF 无法插队 flush → pending 恒为
 *    全量 >16KB），随后立即点 Stop → 断言 store 落盘文本 === 全部已接收 delta 拼接
 *    （精确无截断判据）+ DOM 完成态 marker 全量且占位标题剥离；
 * ② 计划原样路径：bigRunEvents()（100KB）自动流中途真实点击 composer-stop →
 *    完成态 marker 全量 + 总结标题剥离 + 无流式残留。
 */
import { test, expect, type Page } from '@playwright/test';
import { openApp, startNewSession, typeIntoComposer } from './helpers/boot';
import {
  bigRunEvents,
  engineState,
  MOCK_HANDLE,
  type MockEvent,
} from './mock-engine';

/** 从事件序列中提取 message-delta 的文本拼接（与 onChunk 累积顺序一致） */
function deltaTextOf(events: MockEvent[]): string {
  return events
    .filter((ev) => ev.type === 'message-delta')
    .map((ev) => {
      const block = ev.block as { text?: unknown } | undefined;
      return typeof block?.text === 'string' ? block.text : '';
    })
    .join('');
}

/** 发送提示词并等待引擎收到 run（订阅就绪标志） */
async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.locator('[data-testid="chat-input"]');
  // 新会话创建后，composer 会等会话 store 切换才挂载；等可见再输入，
  // 避免在切换窗口中把键盘事件发给尚未就绪的旧视图。
  await expect(input).toBeVisible({ timeout: 8000 });
  await typeIntoComposer(page, prompt);
  await input.press('Enter');
  await expect
    .poll(async () => (await engineState(page)).runCount, { timeout: 8000 })
    .toBe(1);
  await expect(page.locator('[data-testid="composer-stop"]')).toBeVisible({
    timeout: 8000,
  });
}

/** 读取当前会话 store 中 assistant 消息（text/status） */
async function readAssistantMessage(page: Page): Promise<{
  text: string;
  status: string;
}> {
  return page.evaluate(() => {
    const store = (window as any).__CRISH_STORE__;
    const byId = store?.getState?.().sessionsById || {};
    const key = Object.keys(byId)[0];
    const msgs: Array<{ sender?: string; text?: string; status?: string }> =
      byId[key]?.messages || [];
    const asst = msgs.find((m) => m.sender === 'assistant');
    return { text: asst?.text ?? '', status: asst?.status ?? '' };
  });
}

test.describe('E2E-L2 stop 截断回归（stop-truncation，R2-4 P2-1）', () => {
  test('① 大残余（>16KB 积压）Stop → 终稿全量无截断（确定性判据）', async ({
    page,
  }) => {
    await openApp(page, { runStream: { events: [], delayMs: 5 } });
    await startNewSession(page);

    await sendPrompt(page, '模拟 100KB 积压流，流式中途停止');

    // 事件面：只取 message-start + message-delta（不含 message-end/run-terminal，
    // 否则收口事件会在 Stop 前触发 complete 路径，stop 路径将不被覆盖）
    const events = bigRunEvents().filter(
      (ev) => ev.type === 'message-start' || ev.type === 'message-delta'
    );
    const streamedText = deltaTextOf(events);
    // 前置断言：单次同步投递的文本远超 16KB 帧阈值（2 × maxBytesPerFrame）
    expect(streamedText.length).toBeGreaterThan(16 * 1024);
    expect(streamedText).toContain('marker-119');

    // 同一 JS 轮内同步 emit 全部 delta（无 rAF 插队 flush → pending 恒为全量
    // 积压 >16KB），随后立即点击 composer-stop（确定性还原 P2-1 触发条件）
    const stopClicked = await page.evaluate(
      ([handle, evs]) => {
        const h = (window as any)[handle];
        for (const ev of evs) h.emit(ev);
        const btn = document.querySelector(
          '[data-testid="composer-stop"]'
        ) as HTMLElement | null;
        if (!btn) return false;
        btn.click();
        return true;
      },
      [MOCK_HANDLE, events]
    );
    expect(stopClicked).toBe(true);

    // ① Stop 控件隐藏（流已停止，无 pending 态）
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
      timeout: 8000,
    });

    // ② 完成态收敛：流式节点卸载、最终块出现
    const finalBlock = page
      .locator('.msg-row-assistant .md-rendered[data-streaming="false"]')
      .first();
    await expect(finalBlock).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('.msg-row-assistant .md-rendered[data-streaming="true"]')
    ).toHaveCount(0, { timeout: 15000 });

    // ③ 完成态文本：marker-0 至 marker-119 全量；无「## 本轮总结」残留。
    // 注：消息按 block 分片渲染（工具交错时每个文本块独立 .md-rendered 节点），
    // 内容断言取整行文本；「## 本轮总结」占位标题在完成态渲染路径
    // （scheduleFinalMarkdownHtml → stripThoughtPlaceholders）剥离
    const assistantRow = page.locator('.msg-row-assistant').first();
    const finalText = await assistantRow.innerText();
    expect(finalText).toContain('marker-0');
    expect(finalText).toContain('marker-59');
    expect(finalText).toContain('marker-119');
    expect(finalText).not.toContain('## 本轮总结');

    // ④ 无截断精确判据（F1b）：store 落盘终稿 === 全部已接收 delta 拼接
    //（stop 收口为同步 commit 原始文本：onComplete 在 stop 后因 streamManager
    // entry 已删除而 early-return，finishComplete 不再改写；占位剥离仅发生在
    // DOM 渲染路径）——旧实现（commit 陈旧 getStreamText 截断值）在此恒不相等
    const expectedStored = streamedText.trim();
    await expect
      .poll(async () => (await readAssistantMessage(page)).text, {
        timeout: 10000,
      })
      .toEqual(expectedStored);
    const stored = await readAssistantMessage(page);
    expect(stored.status).toBe('completed');
  });

  test('② bigRunEvents 自动流中途真实点击 Stop（data-testid 定位）→ 完成态 marker 全量', async ({
    page,
  }) => {
    // delayMs=30：~126 事件 ≈ 3.8s 流，marker 于 ~0.6s 到达——留给真实点击
    // 足够宽的「已收到 marker 但 message-end 未达」窗口
    await openApp(page, {
      runStream: { events: bigRunEvents(), delayMs: 30 },
    });
    await startNewSession(page);
    await sendPrompt(page, '跑 100KB 压测流，中途停止');

    // Stop 控件 data-testid 可定位（R2-4 V6 判据；L2 级联）
    const stopButton = page.locator('[data-testid="composer-stop"]');
    await expect(stopButton).toBeVisible({ timeout: 8000 });
    await expect(stopButton).toHaveAttribute('data-stop-level', 'l2');

    // 流式期：marker-119 已渲染（已收到全部 marker 段落）
    const assistantRow = page.locator('.msg-row-assistant').first();
    const streamingText = assistantRow.locator(
      '.md-rendered[data-streaming="true"]'
    );
    await expect(streamingText.first()).toBeVisible({ timeout: 10000 });
    const visibleMarkerBlocks = streamingText
      .filter({ hasText: 'marker-119' });
    await expect(visibleMarkerBlocks).toHaveCount(1, { timeout: 15000 });
    await expect(visibleMarkerBlocks).toBeVisible();

    // 流式中途真实点击 Stop（此时 message-end 尚未到达）
    await stopButton.click();

    // 完成态断言（V6 判据）：marker 全量、总结标题剥离、无流式残留
    await expect(stopButton).toBeHidden({ timeout: 8000 });
    const finalBlock = page
      .locator('.msg-row-assistant .md-rendered[data-streaming="false"]')
      .first();
    await expect(finalBlock).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('.msg-row-assistant .md-rendered[data-streaming="true"]')
    ).toHaveCount(0, { timeout: 15000 });

    // 消息按 block 分片渲染（每个工具间隔一个文本块）；内容断言取整行文本
    const finalText = await assistantRow.innerText();
    expect(finalText).toContain('marker-0');
    expect(finalText).toContain('marker-119');
    expect(finalText).not.toContain('## 本轮总结');
    // 收到但未收口的正文不丢（含工具间穿插段落），文本体量仍具规模
    expect(finalText.length).toBeGreaterThan(1024);
  });
});
