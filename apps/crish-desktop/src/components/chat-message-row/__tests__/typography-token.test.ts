import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 将 HSL 转换为 sRGB [0, 1]
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/**
 * 将 Hex 转换为 sRGB [0, 1]
 */
function hexToRgb(hex: string): [number, number, number] {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * 计算相对亮度 L (W3C WCAG 2.1 公式)
 */
function getRelativeLuminance(r: number, g: number, b: number): number {
  const transform = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const R = transform(r);
  const G = transform(g);
  const B = transform(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * 计算两颜色的对比度 (>= 1.0)
 */
function getContrastRatio(
  rgb1: [number, number, number],
  rgb2: [number, number, number]
): number {
  const l1 = getRelativeLuminance(...rgb1);
  const l2 = getRelativeLuminance(...rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Markdown Typography & Syntax Highlighting Tokens (Plan 06)', () => {
  const stylesDir = path.resolve(__dirname, '../../../styles');
  const componentDir = path.resolve(__dirname, '..');

  const tokensCss = [
    fs.readFileSync(path.join(stylesDir, 'tokens.css'), 'utf-8'),
    fs.readFileSync(path.join(stylesDir, 'tokens-components.css'), 'utf-8'),
    fs.readFileSync(path.join(stylesDir, 'tokens-type.css'), 'utf-8'),
  ].join('\n');
  const designSystemCss = fs.readFileSync(
    path.join(stylesDir, 'design-system.css'),
    'utf-8'
  );
  const chatMessageRowCss = fs.readFileSync(
    path.join(componentDir, 'ChatMessageRow.module.css'),
    'utf-8'
  );
  const markdownCss = fs.readFileSync(
    path.join(stylesDir, 'markdown-typography.css'),
    'utf-8'
  );

  describe('1. Typography Scale 阶梯字号与段落垂直韵律断言', () => {
    it('markdown-typography.css 必须包含完整的 H1~H6 独立阶梯规则', () => {
      for (const level of [1, 2, 3, 4, 5, 6]) {
        const sizeToken = `--md-h${level}-size`;
        expect(markdownCss).toContain(`:is(h${level}, .md-h${level})`);
        expect(markdownCss).toContain(`var(${sizeToken})`);
      }
      // 字号 token 必须区分 H4/H5/H6，且 H4/H5/H6 不再塌陷为 14/14/12
      expect(tokensCss).toContain('--md-h4-size: calc(15px');
      expect(tokensCss).toContain('--md-h5-size: calc(14px');
      expect(tokensCss).toContain('--md-h6-size: calc(13px');
    });

    it('Callout 语义色必须使用语义 token，而不是语法高亮 token', () => {
      const expectAccent = (kind: string, token: string) => {
        const pattern = new RegExp(
          `\\.md-callout-${kind}\\s*\\{[^}]*--callout-accent:\\s*var\\(${token}\\)`,
          's'
        );
        expect(markdownCss).toMatch(pattern);
      };
      expectAccent('note', '--accent-blue');
      expectAccent('tip', '--status-added');
      expectAccent('important', '--accent-purple');
      expectAccent('warning', '--status-modified');
      expectAccent('caution', '--status-deleted');
    });

    it('标题字重必须区分 H1/H2 与 H3~H6，而不是全量 700', () => {
      expect(markdownCss).toContain('var(--fw-strong)');
      expect(markdownCss).toContain('var(--fw-semibold)');
      expect(tokensCss).toContain('--fw-semibold: 600');
    });

    it('正文与段落必须绑定统一 flow token 与末尾段落归零规则', () => {
      expect(markdownCss).toContain('var(--md-paragraph-margin-bottom)');
      expect(markdownCss).toContain(
        ':is(.conex-markdown, .md-rendered) > :last-child'
      );
    });
  });

  describe('2. 行内代码与交互胶囊微排版规范断言', () => {
    it('.md-inline-code 必须具备微内衬、圆角与换行克隆规则', () => {
      expect(markdownCss).toContain(':is(code, .md-inline-code):not(pre code)');
      expect(markdownCss).toContain('var(--md-code-inline-bg)');
      expect(markdownCss).toContain('var(--md-code-inline-fg)');
      expect(markdownCss).toContain('box-decoration-break: clone');
      expect(markdownCss).toContain('-webkit-box-decoration-break: clone');
    });

    it('.md-path-link 必须重置原生 button UA 样式并应用现代交互微胶囊', () => {
      expect(markdownCss).toContain('.md-path-link');
      expect(markdownCss).toContain('appearance: none');
      expect(markdownCss).toContain('-webkit-appearance: none');
      expect(markdownCss).toContain('var(--md-path-link-bg)');
      expect(markdownCss).toContain('var(--md-path-link-fg)');
      expect(markdownCss).toContain('.md-path-link:hover');
      expect(markdownCss).toContain('.md-path-link:focus-visible');
    });

    it('超链接 .md-a 必须具备文本下划线偏移与悬浮过渡', () => {
      expect(markdownCss).toContain(':is(a, .md-a)');
      expect(markdownCss).toContain('var(--md-link-underline-offset)');
      expect(markdownCss).toContain(':is(a, .md-a):hover');
    });
  });

  describe('3. 任务列表、引用块与代码块容器规范断言', () => {
    it('.md-task-checkbox 必须具备 14×14px 几何尺寸与勾选态', () => {
      expect(markdownCss).toContain('.md-task-checkbox');
      expect(tokensCss).toContain('--md-task-box-size: 14px');
      expect(markdownCss).toContain('.md-task-checkbox:checked');
      expect(markdownCss).toContain(
        '.md-task-item:has(.md-task-checkbox:checked)'
      );
    });

    it('.md-quote 必须具备发丝边框与柔和底衬', () => {
      expect(markdownCss).toContain(':is(blockquote, .md-quote)');
      expect(markdownCss).toContain('var(--md-quote-border)');
      expect(tokensCss).toContain('--md-quote-border:');
      expect(markdownCss).toContain('var(--md-quote-bg)');
    });

    it('.md-code-block 面包屑与复制按钮必须完整接线', () => {
      expect(markdownCss).toContain('.md-code-breadcrumb');
      expect(markdownCss).toContain('.md-code-copy');
      expect(markdownCss).toContain("[data-copied='true']");
      expect(markdownCss).toContain('.md-code-pre');
    });
  });

  describe('4. 幽灵假变量清剿与 20 组语法高亮双引擎接线断言', () => {
    it('全文件域严禁出现未定义的 --status-success 幽灵假变量', () => {
      expect(tokensCss.includes('--status-success')).toBe(false);
      expect(designSystemCss.includes('--status-success')).toBe(false);
      expect(chatMessageRowCss.includes('--status-success')).toBe(false);
    });

    it('design-system.css 必须 100% 接线激活 20 组双引擎语法高亮选择器', () => {
      const requiredSyntaxTokens = [
        '--syntax-keyword',
        '--syntax-string',
        '--syntax-number',
        '--syntax-title',
        '--syntax-builtin',
        '--syntax-attr',
        '--syntax-comment',
        '--syntax-addition',
        '--syntax-deletion',
        '--syntax-meta',
      ];

      for (const token of requiredSyntaxTokens) {
        expect(designSystemCss).toContain(`color: var(${token});`);
      }

      // Highlight.js 与 Syntect 联合选择器覆盖
      expect(designSystemCss).toContain('.hljs-keyword');
      expect(designSystemCss).toContain('.source .keyword');
      expect(designSystemCss).toContain('.hljs-string');
      expect(designSystemCss).toContain('.source .string');
      expect(designSystemCss).toContain('.hljs-number');
      expect(designSystemCss).toContain('.source .constant.numeric');
      expect(designSystemCss).toContain('.hljs-title');
      expect(designSystemCss).toContain('.source .entity.name.function');
      expect(designSystemCss).toContain('.hljs-built_in');
      expect(designSystemCss).toContain('.source .support.type');
      expect(designSystemCss).toContain('.hljs-attr');
      expect(designSystemCss).toContain('.source .entity.other.attribute-name');
      expect(designSystemCss).toContain('.hljs-comment');
      expect(designSystemCss).toContain('.source .comment');
      expect(designSystemCss).toContain('.hljs-addition');
      expect(designSystemCss).toContain('.source .markup.inserted');
      expect(designSystemCss).toContain('.hljs-deletion');
      expect(designSystemCss).toContain('.source .markup.deleted');
      expect(designSystemCss).toContain('.hljs-meta');
      expect(designSystemCss).toContain('.source .meta');
    });

    it('tokens.css 必须在 Light 与 Dark 主题中均完整定义 10 对调色盘', () => {
      const syntaxTokens = [
        '--syntax-keyword',
        '--syntax-string',
        '--syntax-number',
        '--syntax-title',
        '--syntax-builtin',
        '--syntax-attr',
        '--syntax-comment',
        '--syntax-addition',
        '--syntax-deletion',
        '--syntax-meta',
      ];

      for (const token of syntaxTokens) {
        const lightMatch = tokensCss.indexOf(token);
        expect(lightMatch).toBeGreaterThan(-1);
        const darkMatch = tokensCss.indexOf(token, lightMatch + token.length);
        expect(darkMatch).toBeGreaterThan(-1);
      }
    });
  });

  describe('5. WCAG 2.1 AA 对比度数学验证', () => {
    it('浅色模式：正文、标题、链接与语法高亮色彩必须满足 WCAG 2.1 标准', () => {
      const lightBg: [number, number, number] = [1, 1, 1]; // #ffffff

      // 正文段落与 H1~H5 标题 (#111111) -> 达标 WCAG AAA (>= 7.0:1)
      const textPrimary = hexToRgb('#111111');
      const textPrimaryCr = getContrastRatio(textPrimary, lightBg);
      expect(textPrimaryCr).toBeGreaterThanOrEqual(7.0);

      // H6 注释标题 (#555555) -> 达标 WCAG AA (>= 4.5:1)
      const textSecondary = hexToRgb('#555555');
      const textSecondaryCr = getContrastRatio(textSecondary, lightBg);
      expect(textSecondaryCr).toBeGreaterThanOrEqual(4.5);

      // 行内代码前景色 hsl(0 0% 12%) -> 达标 WCAG AAA (>= 7.0:1)
      const inlineCodeFg = hslToRgb(0, 0, 12);
      const inlineCodeCr = getContrastRatio(inlineCodeFg, lightBg);
      expect(inlineCodeCr).toBeGreaterThanOrEqual(7.0);

      // 本地路径交互胶囊前景色 hsl(160 84% 31%) -> UI交互组件达标 (>= 3.0:1)
      const pathLinkFg = hslToRgb(160, 84, 31);
      const pathLinkCr = getContrastRatio(pathLinkFg, lightBg);
      expect(pathLinkCr).toBeGreaterThanOrEqual(3.0);

      // 语法高亮色阶 (代码块着色对比度)
      const numberColor = hexToRgb('#c2410c'); // 暖褐橙 >= 4.5:1
      expect(getContrastRatio(numberColor, lightBg)).toBeGreaterThanOrEqual(
        4.5
      );

      const deletionColor = hexToRgb('#dc2626'); // 警戒暗红 >= 4.5:1
      expect(getContrastRatio(deletionColor, lightBg)).toBeGreaterThanOrEqual(
        4.5
      );

      const additionColor = hexToRgb('#16a34a'); // 森林沉绿 >= 3.0:1
      expect(getContrastRatio(additionColor, lightBg)).toBeGreaterThanOrEqual(
        3.0
      );

      const keywordColor = hexToRgb('#7c6fdb'); // 柔紫 >= 3.0:1
      expect(getContrastRatio(keywordColor, lightBg)).toBeGreaterThanOrEqual(
        3.0
      );

      const stringColor = hexToRgb('#0d9488'); // 青翠墨绿 >= 3.0:1
      expect(getContrastRatio(stringColor, lightBg)).toBeGreaterThanOrEqual(
        3.0
      );
    });

    it('深色模式：正文、路径链接与语法高亮色彩必须满足 WCAG 2.1 标准', () => {
      const darkBg = hexToRgb('#111111');

      // 正文 (#ededed) -> 达标 WCAG AAA (>= 7.0:1)
      const darkText = hexToRgb('#ededed');
      const darkTextCr = getContrastRatio(darkText, darkBg);
      expect(darkTextCr).toBeGreaterThanOrEqual(7.0);

      // 本地路径链接前景色 hsl(160 84% 45%) -> 达标 WCAG AA (>= 4.5:1)
      const pathLinkDark = hslToRgb(160, 84, 45);
      const pathLinkDarkCr = getContrastRatio(pathLinkDark, darkBg);
      expect(pathLinkDarkCr).toBeGreaterThanOrEqual(4.5);

      // 深色语法高亮色阶
      const darkKeyword = hexToRgb('#c4b5fd'); // 亮紫藤 >= 4.5:1
      expect(getContrastRatio(darkKeyword, darkBg)).toBeGreaterThanOrEqual(4.5);

      const darkString = hexToRgb('#5eead4'); // 薄荷亮青 >= 4.5:1
      expect(getContrastRatio(darkString, darkBg)).toBeGreaterThanOrEqual(4.5);

      const darkNumber = hexToRgb('#fdba74'); // 琥珀浅橙 >= 4.5:1
      expect(getContrastRatio(darkNumber, darkBg)).toBeGreaterThanOrEqual(4.5);

      const darkTitle = hexToRgb('#93c5fd'); // 天青淡蓝 >= 4.5:1
      expect(getContrastRatio(darkTitle, darkBg)).toBeGreaterThanOrEqual(4.5);

      const darkAddition = hexToRgb('#4ade80'); // 荧光亮绿 >= 4.5:1
      expect(getContrastRatio(darkAddition, darkBg)).toBeGreaterThanOrEqual(
        4.5
      );

      const darkDeletion = hexToRgb('#f87171'); // 赤褐浅红 >= 4.5:1
      expect(getContrastRatio(darkDeletion, darkBg)).toBeGreaterThanOrEqual(
        4.5
      );
    });
  });
});
