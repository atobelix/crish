/**
 * syntaxMark — `mdSyntax` 标记
 *
 * 给文档中「属于 Markdown 语法而非正文」的真实字符打的标记。
 * 例如 `**粗体**` 这 8 个字符全部真实存在于文档里，其中首尾各两个星号带 mdSyntax。
 *
 * 它只负责渲染出一个可被 CSS 命中的 `<span class="md-syntax">`，
 * 显示/隐藏由 revealPlugin 通过追加 `is-revealed` class 控制：
 *
 * ```css
 * .ProseMirror .md-syntax             { display: none; }
 * .ProseMirror .md-syntax.is-revealed { display: inline; }
 * ```
 *
 * 这样「远处的块全部隐藏」是一条 CSS 规则的事，Decoration 只需要覆盖
 * 光标所在块里要显形的那几个分隔符，数量恒定在个位数。
 */

import { Mark, mergeAttributes } from '@tiptap/core';

/** 由 inlineParser 托管、每次重解析都会被重算的 mark 名单 */
export const OWNED_MARKS = [
  'bold',
  'italic',
  'strike',
  'code',
  'highlight',
  'link',
  'mdSyntax',
] as const;

export const SYNTAX_MARK_NAME = 'mdSyntax';

export const SyntaxMark = Mark.create({
  name: SYNTAX_MARK_NAME,

  /** 允许与 bold / italic / link 等同时存在于同一段文本上 */
  excludes: '',

  /** 光标停在分隔符右侧继续输入时，不应继承这个标记 */
  inclusive: false,

  /** 由 reconcile 统一维护，用户不能手动加减，也不参与复制粘贴的语义 */
  spanning: true,

  parseHTML() {
    return [{ tag: 'span[data-md-syntax]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-md-syntax': '',
        class: 'md-syntax',
      }),
      0,
    ];
  },
});
