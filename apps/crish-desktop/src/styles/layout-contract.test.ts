// @vitest-environment jsdom
/**
 * 布局 Token 契约测试（BATCH-06 · docs/layout-token-system/00-总方案 §8.5）
 *
 * 与门禁脚本 check-layout-tokens.mjs 互补：
 * - 本文件钉死密度矩阵关键 token 的存在性与偶数性（default/small/large 三档）；
 * - 钉死 ChatMessageList .listInner 纵向 padding 归零（几何 SSOT 归 chatScrollGeometry）；
 * - 钉死 Button 圆角 7px 用户锁（U1）。
 *
 * 采用与 style-contract.test.ts 相同的 fs 契约断言方式
 * （new URL(rel, import.meta.url)，不依赖 process.cwd）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function readFile(relPath: string): string {
  // 模板字面量先赋给中间变量再进 new URL——
  // 内联在 new URL 参数中的模板会被 vitest transform 破坏（资产 URL 重写）。
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

const TOKENS_CSS = 'src/styles/tokens.css';
const CHAT_LIST_CSS = 'src/components/chat-message-list/ChatMessageList.module.css';
const BUTTON_CSS = 'src/components/ui/Button/Button.module.css';

/** 从 CSS 文本中提取指定选择器块的 body（简单块匹配，用于 tokens.css 结构断言） */
function extractBlock(css: string, selectorRe: RegExp): string | null {
  const m = css.match(selectorRe);
  if (!m) return null;
  // 从匹配位置找第一个 {，再配平到对应 }
  const startIdx = css.indexOf(m[0]);
  const openBrace = css.indexOf('{', startIdx);
  if (openBrace === -1) return null;
  let depth = 1;
  let i = openBrace + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(openBrace + 1, i - 1);
}

/** 从块 body 中读取 --space-* 定义表 */
function parseSpaceMap(body: string): Map<string, number> {
  const map = new Map<string, number>();
  const re = /(--space-[\w-]+)\s*:\s*(-?[\d.]+)px\s*;/g;
  let m;
  while ((m = re.exec(body))) {
    map.set(m[1], parseFloat(m[2]));
  }
  return map;
}

/** 密度档 token 顺序（与 §4 表一致） */
const SPACE_ORDER = [
  '--space-0_5',
  '--space-1',
  '--space-1_5',
  '--space-2',
  '--space-2_5',
  '--space-3',
  '--space-3_5',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--space-8',
  '--space-10',
];

describe('密度矩阵 space token 契约（BATCH-01 §4.5）', () => {
  const tokensCss = readFile(TOKENS_CSS);

  // space token 定义在多选择器 :root, html[data-theme='default'], html[data-theme='light'] 块中
  //（首个裸 :root { 块只含 radius/alias 兜底，不含 --space-*）。
  // 对齐 style-contract.test.ts 的 LIGHT_BLOCK_RE 口径：匹配 :root,（带逗号）引导的 light 主题块。
  const rootBody = extractBlock(
    tokensCss,
    /:root,\s*\n\s*html\[data-theme=['"]default['"]\],\s*\n\s*html\[data-theme=['"]light['"]\]/
  );
  const smallBody = extractBlock(tokensCss, /\[data-ui-size=['"]small['"]\]/);
  const largeBody = extractBlock(tokensCss, /\[data-ui-size=['"]large['"]\]/);

  it(':root 块存在且包含全部关键 --space-* token', () => {
    expect(rootBody).not.toBeNull();
    const map = parseSpaceMap(rootBody!);
    for (const name of SPACE_ORDER) {
      expect(map.has(name), `:root 缺少 ${name}`).toBe(true);
    }
  });

  it('default 档所有关键 --space-* 均为偶数 px', () => {
    const map = parseSpaceMap(rootBody!);
    for (const name of SPACE_ORDER) {
      const px = map.get(name);
      expect(px, `:root ${name} 缺失`).toBeDefined();
      expect(Number.isInteger(px!), `${name}=${px} 非整数`).toBe(true);
      expect((px! % 2) as number, `${name}=${px} 为奇数`).toBe(0);
    }
  });

  it('small 档存在、全偶数、严格单调', () => {
    expect(smallBody).not.toBeNull();
    const map = parseSpaceMap(smallBody!);
    for (const name of SPACE_ORDER) {
      expect(map.has(name), `small 缺少 ${name}`).toBe(true);
    }
    let prev = -Infinity;
    for (const name of SPACE_ORDER) {
      const px = map.get(name)!;
      expect(Number.isInteger(px), `small ${name}=${px} 非整数`).toBe(true);
      expect(px % 2, `small ${name}=${px} 为奇数`).toBe(0);
      expect(px, `small ${name}=${px} 非单调（prev=${prev}）`).toBeGreaterThan(prev);
      prev = px;
    }
  });

  it('large 档存在、全偶数、严格单调', () => {
    expect(largeBody).not.toBeNull();
    const map = parseSpaceMap(largeBody!);
    for (const name of SPACE_ORDER) {
      expect(map.has(name), `large 缺少 ${name}`).toBe(true);
    }
    let prev = -Infinity;
    for (const name of SPACE_ORDER) {
      const px = map.get(name)!;
      expect(Number.isInteger(px), `large ${name}=${px} 非整数`).toBe(true);
      expect(px % 2, `large ${name}=${px} 为奇数`).toBe(0);
      expect(px, `large ${name}=${px} 非单调（prev=${prev}）`).toBeGreaterThan(prev);
      prev = px;
    }
  });
});

describe('ChatMessageList .listInner 几何 SSOT 契约', () => {
  const listCss = readFile(CHAT_LIST_CSS);

  it('.listInner 不含 padding: 48px（纵向 padding 归 chatScrollGeometry 单轨）', () => {
    expect(listCss).not.toMatch(/\.listInner\s*\{[^}]*padding:\s*48px/);
  });

  it('.listInner 不含 padding-top: 48px', () => {
    expect(listCss).not.toMatch(/\.listInner\s*\{[^}]*padding-top:\s*48px/);
  });
});

describe('Button 圆角 7px 用户锁契约（U1）', () => {
  const buttonCss = readFile(BUTTON_CSS);

  it('Button.module.css 含 var(--button-radius, 7px)', () => {
    expect(buttonCss).toContain('var(--button-radius, 7px)');
  });

  it('Button.module.css 不含 var(--button-radius, 8px)', () => {
    expect(buttonCss).not.toContain('var(--button-radius, 8px)');
  });
});
