/**
 * markdownService — Markdown 导入导出服务
 *
 * 薄封装层，实际实现在 `core/serializer/markdown.ts`。
 * 保留这一层是为了给上层（导入导出面板、文件读写、历史快照）
 * 一个稳定的接口，而不必关心底层用的是哪套序列化器。
 *
 * 历史说明：旧实现基于 tiptap-markdown，会在解析时吃掉 `**`、
 * 在序列化时靠 mark 反推分隔符，导致表格被压平、图片丢失、
 * LaTeX 反斜杠翻倍。现已整体替换为 Token-in-Document 序列化器。
 */

import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { docToMarkdown, markdownToDoc } from '../../core/serializer/markdown';

export interface MarkdownService {
  parseMarkdownToAST(markdown: string, schema: Schema): JSONContent;
  serializeASTToMarkdown(doc: JSONContent, schema: Schema): string;
}

export class DefaultMarkdownService implements MarkdownService {
  /**
   * Markdown → 文档 JSON。
   *
   * 行内语法原样保留在文本里，由 LivePreviewInline 的 reconcile
   * 负责在挂载后铺上对应的 mark。
   */
  parseMarkdownToAST(markdown: string, schema: Schema): JSONContent {
    if (!markdown || !markdown.trim()) {
      return { type: 'doc', content: [{ type: 'paragraph' }] };
    }
    return markdownToDoc(markdown, schema).toJSON() as JSONContent;
  }

  /** 文档 JSON → Markdown */
  serializeASTToMarkdown(doc: JSONContent, schema: Schema): string {
    if (!doc || !doc.content) return '';
    return docToMarkdown(schema.nodeFromJSON(doc));
  }
}

export const markdownService = new DefaultMarkdownService();
