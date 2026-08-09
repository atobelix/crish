/**
 * 首屏 markdown 批量预热（T-F 06 T2.4：core_md_render_batch 接线消费点）。
 *
 * 目标：会话消息列表首屏加载完成时，对**可见消息文本**（去重、非空）批量调
 * `renderMarkdownBatch`（core_md_render_batch，Rust 侧含 moka 缓存），命中结果
 * 写入 markdownCache（复用 markdownRenderAsync.ts 既有缓存面），后续逐条渲染
 * 直接缓存命中，避免 N 次 IPC 往返与首屏卡顿（markdown_commands.rs:4 设计意图）。
 *
 * 纪律：
 * - 只覆盖**完成态消息**文本（与 07 流式增量渲染不冲突）；
 * - 失败静默回退（后续逐条走既有异步路径 parseMarkdownToHtmlAsync，不抛错）；
 * - 默认不调用（挂接点由 07 批次/主控协调接线；本文件为能力 + 纯函数测试面）。
 */
import { renderMarkdownBatch } from '../rustCore';
import { setMarkdownHtmlCache } from '../markdownCache';

/** 可见消息文本提取（去重、非空、去空白）——纯函数，供测试直测 */
export function collectPrewarmTexts(messages: Array<{ content?: unknown }>): string[] {
  if (!Array.isArray(messages)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const raw = m.content;
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 批量预热：输入消息列表 → 去重非空文本 → 批量 Rust 渲染 → 写入缓存。
 * 失败静默回退（返回写入条数，调用方不依赖结果）。
 */
export async function prewarmMarkdownBatch(
  messages: Array<{ content?: unknown }>,
): Promise<number> {
  const texts = collectPrewarmTexts(messages);
  if (texts.length === 0) return 0;
  const htmls = await renderMarkdownBatch(texts);
  let written = 0;
  texts.forEach((text, i) => {
    const html = htmls[i];
    if (typeof html === 'string') {
      setMarkdownHtmlCache(text, html);
      written += 1;
    }
  });
  return written;
}
