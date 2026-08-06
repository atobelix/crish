/**
 * nodes — 面向 Token-in-Document 的块级节点定义
 *
 * 与 marks.ts 同理：StarterKit 自带的 Heading 有一条 `^(#{1,6})\s$` 输入规则，
 * 敲完 `## ` 之后它会把井号和空格**删掉**再把段落转成标题。
 * 那正是本架构要避免的单向转换——井号一旦被吃掉，
 * 用户就再也无法通过编辑文本把标题改回段落或改变级别。
 *
 * 这里的 Heading 不带任何输入规则，级别完全由 blockSyntax 从文本推导。
 */

import { Node, mergeAttributes } from '@tiptap/core';

const LEVELS = [1, 2, 3, 4, 5, 6] as const;

export const PlainHeading = Node.create({
  name: 'heading',
  content: 'inline*',
  group: 'block',
  defining: true,

  addAttributes() {
    return {
      level: {
        default: 1,
        // 级别由行首井号数量决定，不写进 HTML 属性（标签名已经表达了级别）
        rendered: false,
      },
    };
  },

  parseHTML() {
    return LEVELS.map((level) => ({ tag: `h${level}`, attrs: { level } }));
  },

  renderHTML({ node, HTMLAttributes }) {
    const level = LEVELS.includes(node.attrs.level) ? node.attrs.level : 1;
    return [`h${level}`, mergeAttributes(HTMLAttributes), 0];
  },
});

/** 本引擎接管的块级节点 */
export const LIVE_PREVIEW_NODES = [PlainHeading];
