// CXN 配对码规范（D3 §4.1 唯一真源 / crates/conex-types/src/device/pair.rs 对齐）
// 格式：CXN-XXXX-XXXX-XXXX（12 有效字符，3 组 × 4，60bit 熵）
// 字符集：ABCDEFGHJKLMNPQRSTUVWXYZ23456789（32 字符，去 0/O/1/I/L 易混淆集；
// pair.rs PAIR_CODE_ALPHABET 以 D3 显式字符集为准，R0-05 对拍已统一）
// 标准化（normalize_pair_code，pair.rs:52-74）：去空白与分隔符 → 大写 →
// 长度 > 12 且以 CXN 起头才剥前缀（裸 12 位码以 CXN 起头属正常码，不得误剥）
// → 校验长度 12 → 校验字符集。
//
// 说明：移动端是配对码的消费方（扫码/手动输入），生成函数供对称测试与
// 未来反向场景使用；字符集采样与校验均以 pair.rs 为语义真源。

import {
  parseErr,
  parseOk,
} from '../../../../packages/shared-types/src/generated/device/parser';
import type { ParseResult } from '../../../../packages/shared-types/src/generated/device/parser';

/** 配对码有效字符集（D3 §4.1：去 0/O/1/I/L 的 base32 子集，32 字符） */
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 配对码有效字符数（12 × 2^5 = 60bit 熵） */
export const PAIR_CODE_LENGTH = 12;
/** 人读前缀（仅展示用；输入时忽略） */
export const PAIR_CODE_PREFIX = 'CXN-';
/** 分组分隔符（仅展示用；输入时忽略） */
export const PAIR_CODE_SEPARATOR = '-';
/** 分组宽度（CXN-XXXX-XXXX-XXXX 每组 4 字符） */
export const PAIR_CODE_GROUP_SIZE = 4;

/** 标准化的配对码（12 位大写字母 + 数字，无前缀无分隔符） */
export type NormalizedPairCode = string;

/**
 * 标准化配对码：去 `CXN-` 前缀 → 去分组分隔符与空白 → 大写 → 校验。
 * 与 pair.rs PairCode::normalize 语义一致（扫码与手动输入走同一入口）。
 * 失败返回错误描述（对应跨端错误码 `pair.invalid_code`）。
 */
export function normalizePairCode(
  input: string
): ParseResult<NormalizedPairCode> {
  const cleaned = input
    .split('')
    .filter((c) => c !== PAIR_CODE_SEPARATOR && c.trim().length > 0)
    .join('')
    .toUpperCase();
  // 前缀剥离：去分隔符后若长度 > 12 且以 CXN 起头才剥（裸 12 位码以 CXN
  // 起头属正常码，不得误剥——pair.rs:60-64 同规则）
  const body =
    cleaned.length > PAIR_CODE_LENGTH && cleaned.startsWith('CXN')
      ? cleaned.slice('CXN'.length)
      : cleaned;
  if (body.length !== PAIR_CODE_LENGTH) {
    return parseErr(
      `配对码必须为 ${PAIR_CODE_LENGTH} 位有效字符（可带 CXN- 前缀与分组分隔符）`
    );
  }
  for (const c of body) {
    if (!PAIR_CODE_ALPHABET.includes(c)) {
      return parseErr(`配对码含非法字符：${c}`);
    }
  }
  return parseOk(body);
}

/** 原始输入直接判定（未标准化也按容错规则校验；pair.rs is_valid 同语义） */
export function isValidPairCode(input: string): boolean {
  return normalizePairCode(input).ok;
}

/**
 * 从输入框显示值反向提取原始配对码草稿（formatPairCodeDraft 的输入侧逆函数）：
 * 受控组件闭环（DEF-1/2 修复）：value=formatPairCodeDraft(codeRaw) 时，原生输入
 * 每帧回调的文本是「展示值 + 新字符」（如 'CXN-KC5Q-B'），直接回存 setCodeRaw
 * 会把 CXN- 前缀与分隔符混入原始码（'CXN-C7' → 'CXNC7' → 分组错乱）。本函数
 * 将显示值还原为纯码：大写 → 剥展示前缀 `CXN-`（展示形态非空时恒带此前缀，
 * 剥除安全；裸码以 CXN 起头属正常码不剥——展示前缀恒带分隔符，二者可区分）
 * → 去分隔符与空白 → 长度 > 12 且以 CXN 起头才剥裸前缀（与 normalizePairCode
 * 同规则，容粘贴'无分隔符前缀'变体）→ 截断 12 位。宽松不校验（草稿态；
 * 提交时 normalizePairCode 权威校验）。
 */
export function extractCodeFromDraft(text: string): string {
  const upper = text.toUpperCase();
  const withoutDisplayPrefix = upper.startsWith(PAIR_CODE_PREFIX)
    ? upper.slice(PAIR_CODE_PREFIX.length)
    : upper;
  // 与 formatPairCodeDraft 同清洗：仅保留 A-Z0-9（分隔符/空白/其它符号一律剔除）
  const cleaned = withoutDisplayPrefix.replace(/[^A-Z0-9]/g, '');
  const body =
    cleaned.length > PAIR_CODE_LENGTH && cleaned.startsWith('CXN')
      ? cleaned.slice('CXN'.length)
      : cleaned;
  return body.slice(0, PAIR_CODE_LENGTH);
}

/**
 * 人读回显形态（带前缀与分组分隔符）：12 位码 → CXN-XXXX-XXXX-XXXX。
 * 入参为标准化后的 12 位码（未标准化输入先经 normalizePairCode）。
 */
export function formatPairCode(code: string): ParseResult<string> {
  const normalized = normalizePairCode(code);
  if (!normalized.ok) {
    return normalized;
  }
  const c = normalized.data;
  const groups: string[] = [];
  for (let i = 0; i < PAIR_CODE_LENGTH; i += PAIR_CODE_GROUP_SIZE) {
    groups.push(c.slice(i, i + PAIR_CODE_GROUP_SIZE));
  }
  return parseOk(`${PAIR_CODE_PREFIX}${groups.join(PAIR_CODE_SEPARATOR)}`);
}

/**
 * 生成 12 位配对码（字符集均匀采样；熵 = 12 × 2^5 = 60bit）。
 * 随机源可注入（默认 Math.random，返回 [0,1)）——纯计算无副作用，测试注入
 * 确定性随机源验证字符集与格式。
 */
export function generatePairCode(rand: () => number = Math.random): string {
  const maxIndex = PAIR_CODE_ALPHABET.length - 1;
  let out = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) {
    const index = Math.min(
      maxIndex,
      Math.floor(rand() * PAIR_CODE_ALPHABET.length)
    );
    out += PAIR_CODE_ALPHABET[index];
  }
  return out;
}
