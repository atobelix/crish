/**
 * apps/crish-desktop/src/utils/tokenEstimator.ts
 * 加权特征文本 Token 估算器（详案 04 §2.3）：零依赖纯函数，< 0.1ms 量级，
 * 严禁引入 WASM Tiktoken 词表（反过度设计红线）。
 *
 * 模型：ASCII（字母/数字/空格）× 0.28 + CJK × 0.70 + 其余符号 × 0.45
 *       + 换行 × 0.1，向上取整，下限 1。
 * 用途：注入卡片 Token 胶囊与展示估算；wire 真值以 Rust 侧为准。
 */

/** 单字符分类计数 → 估算 Token（向上取整，非空输入下限 1） */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let asciiCount = 0;
  let cjkCount = 0;
  let symbolCount = 0;
  let lineCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      lineCount++;
    } else if (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 32
    ) {
      asciiCount++;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      cjkCount++;
    } else {
      symbolCount++;
    }
  }

  const tokens = Math.ceil(
    asciiCount * 0.28 + cjkCount * 0.7 + symbolCount * 0.45 + lineCount * 0.1
  );
  return Math.max(1, tokens);
}
