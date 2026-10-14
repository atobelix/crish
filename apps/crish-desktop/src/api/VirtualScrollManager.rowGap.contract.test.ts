/**
 * 估高常量与行距 CSS 默认值的契约。
 * 现在接受 `.row { padding-bottom: 16px }` / `.rowCarrier { padding: 0 0 4px }`。
 * token 批次改成 `var(--chat-row-gap…)` 后，改读 tokens.css 里的默认声明（或 var 回退）。
 * 估高仍是 JS 常量，运行时不读 CSS 变量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_ROW_GAP_COMPACT_PX,
  CHAT_ROW_GAP_PX,
} from './VirtualScrollManager';

const desktopSrc = path.resolve(__dirname, '..');
const rowCss = fs.readFileSync(
  path.join(
    desktopSrc,
    'components/chat-message-row/ChatMessageRow.module.css'
  ),
  'utf8'
);
const tokensCss = fs.readFileSync(
  path.join(desktopSrc, 'styles/tokens.css'),
  'utf8'
);
const estimateSrc = fs.readFileSync(
  path.join(__dirname, 'virtualScrollEstimate.ts'),
  'utf8'
);

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match?.[1]) throw new Error(`missing ${selector}`);
  return match[1];
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

function firstDecl(css: string, name: string): string | null {
  const match = css.match(new RegExp(`(?:^|[^\\w-])${name}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim() ?? null;
}

function resolveLength(expr: string, tokens: string, depth = 0): number | null {
  if (depth > 8) return null;
  const trimmed = expr
    .trim()
    .replace(/!important/g, '')
    .trim();
  const literal = trimmed.match(/^(\d+(?:\.\d+)?)px$/);
  if (literal?.[1]) return Number(literal[1]);
  const variable = trimmed.match(
    /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)\s*$/
  );
  if (!variable?.[1]) return null;
  const declared = firstDecl(tokens, variable[1]);
  if (declared) {
    const fromToken = resolveLength(declared, tokens, depth + 1);
    if (fromToken != null) return fromToken;
  }
  if (variable[2]) return resolveLength(variable[2], tokens, depth + 1);
  return null;
}

function paddingBottomExpr(body: string): string {
  const direct = body.match(/padding-bottom:\s*([^;]+);/);
  if (direct?.[1]) return direct[1].trim();
  const shorthand = body.match(/(?:^|[;\n])\s*padding:\s*([^;]+);/);
  if (!shorthand?.[1]) throw new Error('padding missing');
  const parts = splitTopLevel(shorthand[1]);
  if (parts.length === 1) return parts[0] ?? '';
  if (parts.length === 2) return parts[0] ?? '';
  return parts[2] ?? '';
}

describe('estimate constants lock to chat row gap defaults', () => {
  it('reads tokens.css and the row stylesheet, and matches the JS constants', () => {
    expect(tokensCss.length).toBeGreaterThan(0);
    expect(rowCss.length).toBeGreaterThan(0);

    const rowGap = resolveLength(
      paddingBottomExpr(cssBlock(rowCss, '.row')),
      tokensCss
    );
    const compactGap = resolveLength(
      paddingBottomExpr(cssBlock(rowCss, '.rowCarrier')),
      tokensCss
    );
    expect(rowGap).toBe(16);
    expect(compactGap).toBe(4);
    expect(CHAT_ROW_GAP_PX).toBe(rowGap);
    expect(CHAT_ROW_GAP_COMPACT_PX).toBe(compactGap);
  });

  it('keeps estimates as JS constants and does not read CSS variables at runtime', () => {
    const code = estimateSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).toMatch(
      /(?:ESTIMATE_CARRIER_CONTENT_PX|20)\s*\+\s*CHAT_ROW_GAP_COMPACT_PX/
    );
    expect(code).toMatch(/CHAT_ROW_GAP_PX/);
    expect(code).not.toMatch(/getComputedStyle\s*\(/);
    expect(code).not.toMatch(/getPropertyValue\s*\(/);
    expect(code).not.toMatch(/var\(\s*--chat-row-gap/);
  });
});
