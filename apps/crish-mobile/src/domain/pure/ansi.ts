// ANSI 转义处理（M4 §2.2.3 pure/ansi.ts / R2UX-05-07 白名单）：
// - 白名单（F3 §4.0 / R2UX-05-07）：SGR（m）/ 光标移动（A B C D E F G H f）/ 清屏（J K）三类；
//   白名单内序列剥离为纯文本（手机端不做真终端，色彩由 UI 主题统一表达，F3 §4.2）；
// - 非白名单/非法序列（私有模式 ?xx、滚动 r、未知 final、OSC、独立 ESC）一律忽略（剥离），
//   不渲染、不报错、不残留半个序列（防注入：转义不得透传到渲染面）；
// - 手写扫描器而非正则：避免贪婪匹配误吞文本、避免灾难性回溯（长行 JSON 日志安全，F3 §4.0
//   「手写 30 行内」量级）；stripAnsi 保持旧签名（骨架期全剥除语义）不破坏调用方。

const ESC_CODE = 0x1b; // ESC
const BEL_CODE = 0x07; // BEL（OSC 终结符之一）

// CSI 字节区间（ECMA-48）：参数 0x30-0x3F / 中间字节 0x20-0x2F / final 0x40-0x7E
const CSI_PARAM_MIN = 0x30;
const CSI_PARAM_MAX = 0x3f;
const CSI_INTER_MIN = 0x20;
const CSI_INTER_MAX = 0x2f;
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

/** ANSI 白名单分类（R2UX-05-07：SGR / 光标 / 清屏；非白名单返回 null 表示「忽略」） */
export type AnsiCategory = 'sgr' | 'cursor' | 'clear';

/** CSI final byte → 白名单分类（null = 非白名单，序列被忽略剥离） */
export function classifyCsiFinal(finalByte: string): AnsiCategory | null {
  switch (finalByte) {
    case 'm':
      return 'sgr';
    case 'A':
    case 'B':
    case 'C':
    case 'D':
    case 'E':
    case 'F':
    case 'G':
    case 'H':
    case 'f':
      return 'cursor';
    case 'J':
    case 'K':
      return 'clear';
    default:
      return null;
  }
}

export interface AnsiStripStats {
  /** 被剥离的转义序列总数（白名单内 + 非法忽略统一计数） */
  stripped: number;
  /** 白名单分类命中计数（sgr / cursor / clear） */
  categories: Record<AnsiCategory, number>;
}

export interface AnsiStripResult {
  /** 收敛后的纯文本 */
  text: string;
  /** 剥离统计（测试断言数据面） */
  stats: AnsiStripStats;
}

/** 剥离统计详情版（测试/诊断用；生产路径取 .text 即可） */
export function stripAnsiDetailed(input: string): AnsiStripResult {
  let text = '';
  let stripped = 0;
  const categories: AnsiStripStats['categories'] = {
    sgr: 0,
    cursor: 0,
    clear: 0,
  };
  let i = 0;
  while (i < input.length) {
    if (input.charCodeAt(i) !== ESC_CODE) {
      text += input[i];
      i += 1;
      continue;
    }
    const next = input.charCodeAt(i + 1);
    if (next === 0x5b /* '[' → CSI */) {
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c >= CSI_PARAM_MIN && c <= CSI_PARAM_MAX) {
          j += 1;
        } else if (c >= CSI_INTER_MIN && c <= CSI_INTER_MAX) {
          j += 1;
        } else {
          break;
        }
      }
      const finalByte = input[j];
      const finalCode = finalByte === undefined ? 0 : finalByte.charCodeAt(0);
      if (finalCode >= CSI_FINAL_MIN && finalCode <= CSI_FINAL_MAX) {
        // 合法 CSI 结构：白名单分类计数，非法 final 仅计数（忽略剥离）
        const category = classifyCsiFinal(finalByte!);
        if (category !== null) categories[category] += 1;
        stripped += 1;
        i = j + 1;
      } else {
        // 截断序列（无 final）：剥除到已解析处，防半个序列残留
        stripped += 1;
        i = j;
      }
      continue;
    }
    if (next === 0x5d /* ']' → OSC（如标题/超链接），非白名单一律忽略 */) {
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c === BEL_CODE) break;
        if (c === ESC_CODE && input.charCodeAt(j + 1) === 0x5c /* '\' */) break;
        j += 1;
      }
      const termCode = input.charCodeAt(j);
      if (termCode === BEL_CODE) {
        stripped += 1;
        i = j + 1;
      } else if (termCode === ESC_CODE) {
        stripped += 1;
        i = j + 2;
      } else {
        // 未终结 OSC：剥除防残留
        stripped += 1;
        i = j;
      }
      continue;
    }
    // 独立 ESC（非 CSI/OSC）：剥除
    stripped += 1;
    i += 1;
  }
  return { text, stats: { stripped, categories } };
}

/** ANSI 转义收敛为纯文本（白名单 SGR/光标/清屏 + 非法序列忽略；保持旧签名） */
export function stripAnsi(input: string): string {
  return stripAnsiDetailed(input).text;
}
