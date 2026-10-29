/**
 * Markdown 文档分块：按块边界聚合为约 8KB 的渲染 chunk。
 *
 * 与 `MarkdownBlockScanner` 分工：scanner 负责词法块边界；本模块只做
 * 「块 → chunk」的聚合与稳定 key 生成。
 */
import { MarkdownBlockScanner } from './markdownBlockScanner';

export interface MarkdownChunk {
  id: string;
  text: string;
}

export function chunkMarkdown(
  text: string,
  targetChars = 8_000
): MarkdownChunk[] {
  const blocks = MarkdownBlockScanner.split(text);
  if (blocks.length === 0) return [];
  const chunks: MarkdownChunk[] = [];
  let current: string[] = [];
  let size = 0;

  const flush = () => {
    if (current.length === 0) return;
    const chunkText = current.join('\n\n');
    chunks.push({
      id: `md-chunk-${chunks.length}-${hash16(chunkText)}`,
      text: chunkText,
    });
    current = [];
    size = 0;
  };

  for (const block of blocks) {
    if (current.length > 0 && size + block.length > targetChars) flush();
    current.push(block);
    size += block.length;
  }
  flush();
  return chunks;
}

/** 快速 16 位十六进制语义哈希（稳定 key，不需要加密强度）。 */
export function hash16(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ (ch << 5), 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}
