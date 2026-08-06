/**
 * marks — 面向 Token-in-Document 的行内标记定义
 *
 * 为什么不直接用 StarterKit 自带的 Bold / Italic / Code：
 *
 * 1. **输入规则冲突。** StarterKit 的 Bold 带 `**text**` 输入规则，
 *    当用户敲完收尾的 `**` 时，它会把四个星号**删掉**再套上 bold。
 *    而本架构的前提恰恰是「星号必须留在文档里」，两者直接对冲。
 *    这里定义的 mark 一律不带任何 input / paste rule，
 *    格式的产生完全交给 reconcile 重解析。
 *
 * 2. **`code` 的 excludes。** Tiptap 的 Code 标记声明了 `excludes: '_'`
 *    （排斥所有其他 mark），会导致 `mdSyntax` 无法与它共存，
 *    反引号就没法被标成语法字符。这里改成 `excludes: ''`。
 *    安全性由解析器保证——代码段内部的字符已被 mask，
 *    不可能再解析出 bold / italic。
 *
 * 3. **link 不劫持点击。** 链接的语法 `[text](url)` 要能用键盘编辑，
 *    因此不挂 autolink / linkOnPaste 这类会改写文本的行为。
 */

import { Mark, mergeAttributes } from '@tiptap/core';

/**
 * 供 Editor 统一关闭 StarterKit 中对应扩展的开关。
 *
 * StarterKit 3.29 自带 bold / italic / strike / code / link / heading，
 * 它们都带有会吞掉语法字符的 input rule，必须整体让位给本模块的实现。
 */
export const STARTER_KIT_DISABLED = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  link: false,
  heading: false,
} as const;

export const PlainBold = Mark.create({
  name: 'bold',
  parseHTML() {
    return [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=bold' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['strong', mergeAttributes(HTMLAttributes), 0];
  },
});

export const PlainItalic = Mark.create({
  name: 'italic',
  parseHTML() {
    return [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['em', mergeAttributes(HTMLAttributes), 0];
  },
});

export const PlainStrike = Mark.create({
  name: 'strike',
  parseHTML() {
    return [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['s', mergeAttributes(HTMLAttributes), 0];
  },
});

export const PlainCode = Mark.create({
  name: 'code',
  /** 关键：允许与 mdSyntax 共存，否则反引号无法被标为语法字符 */
  excludes: '',
  code: true,
  parseHTML() {
    return [{ tag: 'code' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['code', mergeAttributes(HTMLAttributes), 0];
  },
});

export const PlainHighlight = Mark.create({
  name: 'highlight',
  parseHTML() {
    return [{ tag: 'mark' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes), 0];
  },
});

export const PlainLink = Mark.create({
  name: 'link',
  /** 链接文字内部可以继续有 bold / italic */
  excludes: '',
  inclusive: false,

  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (el) => el.getAttribute('href'),
        renderHTML: (attrs) => (attrs.href ? { href: attrs.href } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[href]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        rel: 'noopener noreferrer nofollow',
        class: 'md-link',
      }),
      0,
    ];
  },
});

/** 本引擎接管的全部行内 mark，按注册顺序导出 */
export const LIVE_PREVIEW_MARKS = [
  PlainBold,
  PlainItalic,
  PlainStrike,
  PlainCode,
  PlainHighlight,
  PlainLink,
];
