/**
 * diffToReplace — 代理项感知（Surrogate-Aware）的最长公共前后缀比对算子与标量坐标转换。
 *
 * 单源收敛重构：彻底删除私有重复实现，统一从 `@crish/block-paper-contract` 导入。
 */

export {
  isHighSurrogate,
  isLowSurrogate,
  isSurrogateCodePoint,
  utf16OffsetToUnicodeScalar,
  unicodeScalarToUtf16Offset,
  countUnicodeScalars,
  diffToReplace,
  type DiffReplaceResult,
} from '@crish/block-paper-contract';
