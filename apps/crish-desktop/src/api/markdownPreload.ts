/**
 * 会话首屏加载时批量预渲染可见消息的 precomputedHtml。
 *
 * 渲染策略（系统化避免重复 IPC）：
 *   1. 已有 precomputedHtml → 跳过（已预热）
 *   2. LRU 命中 → 写入 precomputedHtml，跳过 Rust（零 IPC）
 *   3. 其余 → 批量 md_render_batch（一次 IPC 多条），失败回退逐条 md_render
 *
 * 不直接操作 store（避免循环依赖）：仅 mutate 入参 msg 对象的 precomputedHtml 字段，
 * 由调用方决定何时提交到 store。
 */

import type { SessionMessage } from '../store/types';
import { renderMarkdownBatch, renderMarkdown } from './rustCore';
import { getMarkdownHtmlCache, setMarkdownHtmlCache } from './markdownCache';
import { stripThoughtPlaceholders } from './markdownRenderLite';

/**
 * @param messages 会话消息列表（in-place mutate precomputedHtml）
 * @param options.concurrency 逐条渲染回退路径的并发数，默认 4
 */
export async function preloadSessionHtml(
  messages: SessionMessage[],
  options?: { concurrency?: number }
): Promise<void> {
  const needRender: Array<{ msg: SessionMessage; text: string }> = [];

  for (const msg of messages) {
    if (msg.sender !== 'assistant') continue;
    if (!msg.text) continue;
    if (msg.precomputedHtml) continue;

    const cleaned = stripThoughtPlaceholders(msg.text);
    if (!cleaned) continue;

    // LRU 命中：直接复用缓存值写入 precomputedHtml，跳过 Rust IPC
    const cached = getMarkdownHtmlCache(cleaned);
    if (cached !== undefined) {
      msg.precomputedHtml = cached;
      continue;
    }

    needRender.push({ msg, text: cleaned });
  }

  if (needRender.length === 0) return;

  // 优先批量渲染：一次 IPC 多条文本，减少往返开销
  const texts = needRender.map((item) => item.text);
  const htmls = await renderMarkdownBatch(texts);
  if (htmls) {
    needRender.forEach((item, i) => {
      const html = htmls[i];
      if (!html) return;
      setMarkdownHtmlCache(item.text, html);
      item.msg.precomputedHtml = html;
    });
    return;
  }

  // Fallback：批量命令缺失/失败 → 逐条渲染，并发控制避免阻塞 Rust 渲染队列
  const concurrency = options?.concurrency ?? 4;
  for (let i = 0; i < needRender.length; i += concurrency) {
    const batch = needRender.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (item) => {
        const html = await renderMarkdown(item.text);
        if (!html) return;
        setMarkdownHtmlCache(item.text, html);
        item.msg.precomputedHtml = html;
      })
    );
  }
}
