/**
 * 代理项感知（Surrogate-Aware）最长公共前后缀比对算子与双坐标系单射转换。
 *
 * 单源收敛重构：彻底删除重复实现与歧义字段，统一从 `@crish/block-paper-contract` 导入。
 */

export {
  isHighSurrogate,
  isLowSurrogate,
  isInsideSurrogatePair,
  utf16OffsetToUnicodeScalar,
  unicodeScalarToUtf16Offset,
  diffToReplace,
  type DiffReplaceResult,
} from '@crish/block-paper-contract';
