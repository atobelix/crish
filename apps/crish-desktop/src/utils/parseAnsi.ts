import React from 'react';

/**
 * 例外声明（T05.5.1 tokens 唯一源）：
 * ANSI 色码 → 十六进制映射表是终端渲染的数据常量（与 --xterm-* token 值并不完全一致，
 * 如 green 的取值不同），改映射会造成既有渲染漂移。
 * 保留为数据表，统一到 --xterm-* 的收敛留待后续专项（标注待确认）。
 */

const ANSI_FG: Record<string, string> = {
  '30': '#000000', '31': '#f87171', '32': '#6ee7b7', '33': '#fde68a',
  '34': '#60a5fa', '35': '#c084fc', '36': '#22d3ee', '37': '#e5e7eb',
  '90': '#9ca3af', '91': '#fca5a5', '92': '#86efac', '93': '#fcd34d',
  '94': '#93c5fd', '95': '#d8b4fe', '96': '#67e8f9', '97': '#f9fafb',
};

const ANSI_BG: Record<string, string> = {
  '40': '#000000', '41': '#f87171', '42': '#6ee7b7', '43': '#fde68a',
  '44': '#60a5fa', '45': '#c084fc', '46': '#22d3ee', '47': '#e5e7eb',
  '100': '#9ca3af', '101': '#fca5a5', '102': '#86efac', '103': '#fcd34d',
  '104': '#93c5fd', '105': '#d8b4fe', '106': '#67e8f9', '107': '#f9fafb',
};

const ANSI_BASIC: string[] = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
];

const ANSI_CUBE = [0, 95, 135, 175, 215, 255];

function get256Color(code: string): string {
  const n = parseInt(code, 10);
  if (Number.isNaN(n) || n < 0 || n > 255) return 'inherit';
  if (n < 16) return ANSI_BASIC[n]!;
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const toHex = (v: number) => ANSI_CUBE[v]!.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  const gray = (n - 232) * 10 + 8;
  const h = gray.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/**
 * 将含 ANSI 转义序列的文本解析为 React 节点数组，
 * 每个带样式的片段包裹在 <span> 中，无样式片段为纯文本字符串。
 */
export function parseAnsi(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /\x1b\[([\d;]*)m/g;

  let last = 0;
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let italic = false;
  let underline = false;
  let keyCounter = 0;

  const pushText = (end: number) => {
    if (end <= last) return;
    const raw = text.slice(last, end);
    if (fg || bg || bold || italic || underline) {
      nodes.push(
        React.createElement('span', {
          key: keyCounter++,
          style: {
            color: fg,
            backgroundColor: bg,
            fontWeight: bold ? 'bold' : undefined,
            fontStyle: italic ? 'italic' : undefined,
            textDecoration: underline ? 'underline' : undefined,
          } as React.CSSProperties,
        }, raw),
      );
    } else {
      nodes.push(raw);
    }
  };

  const applyCodes = (codes: string) => {
    const parts = codes.split(';');
    let i = 0;
    while (i < parts.length) {
      const c = parts[i]!;
      if (c === '' || c === '0') {
        fg = undefined; bg = undefined; bold = false; italic = false; underline = false;
      } else if (c === '1') bold = true;
      else if (c === '3') italic = true;
      else if (c === '4') underline = true;
      else if (c === '22') bold = false;
      else if (c === '23') italic = false;
      else if (c === '24') underline = false;
      else if (c === '39') fg = undefined;
      else if (c === '49') bg = undefined;
      else if (ANSI_FG[c]) fg = ANSI_FG[c];
      else if (ANSI_BG[c]) bg = ANSI_BG[c];
      else if (c === '38' && parts[i + 1] === '5' && parts[i + 2]) {
        i += 2; fg = get256Color(parts[i]!);
      } else if (c === '48' && parts[i + 1] === '5' && parts[i + 2]) {
        i += 2; bg = get256Color(parts[i]!);
      }
      i++;
    }
  };

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    pushText(match.index);
    applyCodes(match[1]!);
    last = re.lastIndex;
  }
  pushText(text.length);

  return nodes;
}
