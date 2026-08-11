/**
 * 叶子裸 ProseMirror schema（W3-D-PM）。
 *
 * - **仅 inline**：单 paragraph 叶，无嵌套块结构
 * - 活动叶 `EditorState` 的 doc 根
 * - **禁止** `serialize(pmDoc)` 写入持久化 / 权威（写路径只走 TextEditIntent）
 *
 * ## 轨声明
 * - 本模块 = **W3-D-PM** 真 PM 适配器的 schema 面
 * - **≠ W3-D**（真 `DocSession::apply` 终局）
 * - **≠ EL-01**
 */

import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model';

/** 叶子节点规格：doc → 单 paragraph → inline* */
const nodes: { [name: string]: NodeSpec } = {
  doc: {
    content: 'paragraph',
  },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM() {
      return ['p', 0];
    },
  },
  text: {
    group: 'inline',
  },
};

/**
 * 基础 marks（可选；持久化仍只走 text_edit 的 plain insert，
 * mark 进 Intent 载荷留给后续波，本包不 serialize 整 doc）。
 */
const marks: { [name: string]: MarkSpec } = {
  strong: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b' },
      {
        style: 'font-weight',
        getAttrs: (value) =>
          /^(bold(er)?|[5-9]\d{2,})$/.test(String(value)) ? null : false,
      },
    ],
    toDOM() {
      return ['strong', 0];
    },
  },
  em: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM() {
      return ['em', 0];
    },
  },
  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM() {
      return ['code', 0];
    },
  },
};

/**
 * 叶子 inline schema 单例。
 * 全库文本叶共用；禁止另起块级嵌套 schema 冒充叶子核。
 */
export const leafInlineSchema = new Schema({ nodes, marks });

/** schema 别名（可读性） */
export const pmLeafSchema = leafInlineSchema;

/**
 * 将 plain text 装入叶子 doc（单 paragraph）。
 * 空串 → 空 paragraph（合法 PM 空叶）。
 */
export function textToLeafDoc(text: string, schema = leafInlineSchema) {
  const safe = text ?? '';
  const paragraph = schema.node(
    'paragraph',
    null,
    safe.length > 0 ? [schema.text(safe)] : []
  );
  return schema.node('doc', null, [paragraph]);
}

/**
 * 叶子 doc → plain text（`textContent`）。
 * 写路径权威坐标用此串的 UTF-16 索引，与 TextLeafModel / TextEditIntent 对齐。
 */
export function leafDocToText(doc: { textContent: string }): string {
  return doc.textContent;
}

/**
 * plain 文本 offset → PM 文档位置。
 *
 * 单 paragraph 叶（本 schema 铁律）：
 * - pos 0 = doc 前；pos 1 = paragraph 内容起点；pos 1+textLen = 文本末
 * - 纯 text/marks 不额外占位，故 `1 + offset` 恒成立
 * - offset 夹在 [0, textLen]
 */
export function textOffsetToPmPos(
  doc: {
    textContent: string;
    content: { size: number };
  },
  offset: number
): number {
  const textLen = doc.textContent.length;
  const o = Math.max(0, Math.min(Math.floor(offset), textLen));
  // 单 paragraph：内容起点恒为 1；末尾 = 1 + textLen（仍在 paragraph 内）
  return 1 + o;
}

/**
 * PM 文档位置 → plain 文本 offset。
 */
export function pmPosToTextOffset(
  doc: {
    textContent: string;
    content: { size: number };
    textBetween: (
      from: number,
      to: number,
      blockSep?: string,
      leafText?: string
    ) => string;
  },
  pos: number
): number {
  const textLen = doc.textContent.length;
  // 夹到 paragraph 内容区间 [1, 1+textLen]
  const p = Math.max(1, Math.min(pos, 1 + textLen));
  return doc.textBetween(0, p, '', '').length;
}
