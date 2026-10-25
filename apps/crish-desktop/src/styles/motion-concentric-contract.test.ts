// @vitest-environment jsdom
/**
 * 契约测试：同心几何圆角与 Apple 物理动效防回潮 (DIM-02 / DIM-06)
 *
 * 规范依据：
 * - Jakub Krehel 7 大工程级设计标准 + Apple 物理流体交互体系
 * - 00-总方案.md (零果冻、零 Reflow、Token SSOT)
 * - 06-动效性能与设计系统Token规范审计.md §8
 * - 06-动效语法清洗与防回潮自动化门禁审查.md §4
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：模板字面量先赋给中间变量再进 new URL，避免 vitest transform 静态重写
const anchorRel = 'src/tokens.css';
const target = `../../${anchorRel}`;
const SRC_DIR = fileURLToPath(new URL(target, import.meta.url)).replace(
  /[\\/]tokens\.css$/,
  ''
);

/** 递归扫描全部 CSS 样式文件（排除外部资产与构建产物） */
function collectCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'reference'].includes(entry)) continue;
      collectCssFiles(fullPath, out);
    } else if (entry.endsWith('.css')) {
      out.push(fullPath);
    }
  }
  return out;
}

/** 剥离注释并保留物理行号（将注释内部非换行符替换为空格） */
function stripCommentsPreservingLines(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\r\n]/g, ' ');
  });
}

/** 规范化相对路径，消除 Windows 路径反斜杠与双斜杠 */
function formatRelPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(SRC_DIR.replace(/\\/g, '/'), 'src');
}

describe('契约测试：同心几何圆角与物理动效防回潮门禁 (DIM-02 / DIM-06)', () => {
  const cssFiles = collectCssFiles(SRC_DIR);

  // 全仓清除历史奇数/亚像素硬编码圆角，基线硬性锁死为 0
  const ODD_RADIUS_BASELINE = 0;

  it('1. 静态扫描：全站清除 5px/7px 等奇数与亚像素圆角（Ratchet 模式防劣化）', () => {
    const FORBIDDEN_ODD_VALUES = [
      /\b3px\b/,
      /\b5px\b/,
      /\b7px\b/,
      /\b9px\b/,
      /\b11px\b/,
      /\b13px\b/,
      /\b15px\b/,
      /\b3\.5px\b/,
      /\b6\.5px\b/,
    ];

    const violations: { file: string; line: number; raw: string }[] = [];

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const cleanContent = stripCommentsPreservingLines(content);
      const lines = cleanContent.split('\n');

      lines.forEach((line, idx) => {
        const match = line.match(
          /border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;]+);/
        );
        if (!match) return;

        const rawValue = match[1].trim();
        const strippedValue = rawValue.replace(/var\([^)]+\)/g, '').trim();
        if (!strippedValue) return;

        for (const forbidden of FORBIDDEN_ODD_VALUES) {
          if (forbidden.test(strippedValue)) {
            violations.push({
              file: formatRelPath(file),
              line: idx + 1,
              raw: line.trim(),
            });
            break;
          }
        }
      });
    }

    expect(
      violations.length,
      `奇数/亚像素圆角违规数量 (${violations.length}) 超过基线 (${ODD_RADIUS_BASELINE})！\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBeLessThanOrEqual(ODD_RADIUS_BASELINE);
  });

  it('2. 静态扫描：全仓严禁过冲抖动果冻曲线 (双向严格阻尼: -0.02 <= y1,y2 <= 1.02)', () => {
    const CUBIC_BEZIER_RE =
      /cubic-bezier\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g;
    const violations: {
      file: string;
      line: number;
      y1: number;
      y2: number;
      raw: string;
    }[] = [];

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const cleanContent = stripCommentsPreservingLines(content);
      const lines = cleanContent.split('\n');

      lines.forEach((line, idx) => {
        const matches = Array.from(line.matchAll(CUBIC_BEZIER_RE));

        for (const match of matches) {
          const y1 = parseFloat(match[2]);
          const y2 = parseFloat(match[4]);

          // 双向阻尼防线：严格禁止 y > 1.02 (允许 0.02 浮点容差) 或 y < -0.02
          if (y1 > 1.02 || y2 > 1.02 || y1 < -0.02 || y2 < -0.02) {
            violations.push({
              file: formatRelPath(file),
              line: idx + 1,
              y1,
              y2,
              raw: match[0],
            });
          }
        }
      });
    }

    expect(
      violations.length,
      `发现 ${violations.length} 处违背物理阻尼的过冲果冻贝塞尔曲线 (y1 或 y2 超出 [-0.02, 1.02])：\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBe(0);
  });

  it('3. tokens.css 物理动效、设计 Token 正典与超链接蓝色规范健全性', () => {
    const tokensPath = join(SRC_DIR, 'styles', 'tokens.css');
    expect(existsSync(tokensPath), 'tokens.css 必须物理存在').toBe(true);

    const tokensContent = readFileSync(tokensPath, 'utf8');

    // 按钮圆角基础档校验
    const buttonRadiusLiteral = tokensContent.match(
      /--button-radius:\s*(\d+px);/
    );
    const buttonRadiusAlias = tokensContent.match(
      /--button-radius:\s*var\(\s*(--[a-z0-9-]+)\s*\)/
    );
    expect(
      buttonRadiusLiteral || buttonRadiusAlias,
      '--button-radius 须为字面值或 var() 单一真源引用'
    ).toBeTruthy();
    if (buttonRadiusAlias) {
      const refName = buttonRadiusAlias[1];
      const refDef = tokensContent.match(
        new RegExp(`${refName.replace(/[-]/g, '\\-')}:\\s*(\\d+px);`)
      );
      expect(refDef, `${refName} 须有字面定义（引用链不得悬空）`).toBeTruthy();
      expect(['7px', '8px']).toContain(refDef?.[1]);
    } else {
      expect(['7px', '8px']).toContain(buttonRadiusLiteral?.[1]);
    }

    // 必备动效时长与曲线 Token 校验
    expect(
      tokensContent,
      'tokens.css 必须包含 --duration-snappy: 120ms'
    ).toMatch(/--duration-snappy:\s*120ms;/);

    expect(
      tokensContent,
      'tokens.css 必须包含 --ease-decelerate: cubic-bezier(0.2, 0, 0, 1)'
    ).toMatch(
      /--ease-decelerate:\s*cubic-bezier\(\s*0\.2\s*,\s*0\s*,\s*0\s*,\s*1\s*\);/
    );

    expect(
      tokensContent,
      'tokens.css 必须包含 --ease-accelerate: cubic-bezier(0.4, 0, 1, 1)'
    ).toMatch(
      /--ease-accelerate:\s*cubic-bezier\(\s*0\.4\s*,\s*0\s*,\s*1\s*,\s*1\s*\);/
    );

    expect(
      tokensContent,
      'tokens.css 必须包含 --transition-normal: var(--duration-normal) var(--ease-standard)'
    ).toMatch(
      /--transition-normal:\s*var\(--duration-normal\)\s+var\(--ease-standard\);/
    );

    if (tokensContent.includes('--transition-snappy:')) {
      expect(
        tokensContent,
        'tokens.css 若声明 --transition-snappy 必须绑定 var(--duration-snappy) var(--ease-standard)'
      ).toMatch(
        /--transition-snappy:\s*var\(--duration-snappy\)\s+var\(--ease-standard\);/
      );
    }

    // 权威双模超链接蓝色 Token 契约
    expect(
      tokensContent,
      'tokens.css Light 模式必须定义科技蓝超链接 Token (--color-link: #2563eb 或 hsl(217 91% 54%))'
    ).toMatch(/--color-link:\s*(?:#2563eb|hsl\(\s*217\s+91%\s+54%\s*\))/i);

    expect(
      tokensContent,
      'tokens.css Dark 模式必须定义天幕蓝超链接 Token (--color-link: #60a5fa 或 hsl(212 96% 68%))'
    ).toMatch(/--color-link:\s*(?:#60a5fa|hsl\(\s*212\s+96%\s+68%\s*\))/i);

    expect(
      tokensContent,
      '--md-link-color 必须绑定到单一真源 var(--color-link)'
    ).toMatch(/--md-link-color:\s*var\(--color-link\);/);

    expect(
      tokensContent,
      '严禁 --md-link-color 残留历史品牌绿引用 (var(--brand-deep) 或 hsl(160 ...))'
    ).not.toMatch(/--md-link-color:\s*var\(--brand/i);
    expect(
      tokensContent,
      '严禁 --md-link-color 残留历史绿色字面值 hsl(160 ...)'
    ).not.toMatch(/--md-link-color:[^;]*hsl\(\s*160/i);

    // 保留既有阻尼验证
    if (tokensContent.includes('--ease-critical-damping:')) {
      expect(tokensContent).toContain(
        '--ease-critical-damping: cubic-bezier(0.2, 0, 0, 1)'
      );
      expect(tokensContent).toContain(
        '--ease-tactile-release: cubic-bezier(0.16, 1, 0.3, 1)'
      );
    }

    if (tokensContent.includes('--transition-landing-fade:')) {
      expect(tokensContent).toContain('--transition-landing-fade');
    }
  });

  it('4. Button 原子基座触感安全网检验（结构完整与无障碍降级）', () => {
    const btnCssPath = join(
      SRC_DIR,
      'components',
      'ui',
      'Button',
      'Button.module.css'
    );
    expect(existsSync(btnCssPath), 'Button.module.css 必须物理存在').toBe(true);

    const btnCss = readFileSync(btnCssPath, 'utf8');
    expect(btnCss.length).toBeGreaterThan(0);

    if (btnCss.includes('scale(0.96)')) {
      expect(btnCss).toContain('transform: none !important');
      expect(btnCss).toContain('@media (prefers-reduced-motion: reduce)');
    }
  });

  it('5. 静态扫描：全仓严禁双重缓动函数语法灾难 (Double Timing Function)', () => {
    const DOUBLE_TIMING_FORWARD_RE =
      /var\(--transition-[a-zA-Z0-9_-]+(?:,\s*[^)]+)?\)\s*(?:[^\s;,()]+\s+)*(ease(?:-in|-out|-in-out)?|cubic-bezier\([^)]+\)|linear|step-start|step-end|steps\([^)]+\))/i;
    const DOUBLE_TIMING_BACKWARD_RE =
      /(ease(?:-in|-out|-in-out)?|cubic-bezier\([^)]+\)|linear|step-start|step-end|steps\([^)]+\))\s*(?:[^\s;,()]+\s+)*var\(--transition-[a-zA-Z0-9_-]+/i;

    const violations: { file: string; line: number; raw: string }[] = [];

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const cleanContent = stripCommentsPreservingLines(content);
      const lines = cleanContent.split('\n');

      lines.forEach((line, idx) => {
        if (!line.trim()) return;

        if (
          DOUBLE_TIMING_FORWARD_RE.test(line) ||
          DOUBLE_TIMING_BACKWARD_RE.test(line)
        ) {
          violations.push({
            file: formatRelPath(file),
            line: idx + 1,
            raw: line.trim(),
          });
        }
      });
    }

    expect(
      violations.length,
      `发现 ${violations.length} 处双重缓动语法错误！此错误会导致 Chromium 直接丢弃整条过渡/动画声明：\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBe(0);
  });

  it('6. 静态扫描：全仓严禁非法 3 参数残缺 cubic-bezier 破损语法', () => {
    const THREE_PARAM_BEZIER_RE =
      /cubic-bezier\s*\(\s*[-0-9.]+\s*,\s*[-0-9.]+\s*,\s*[-0-9.]+\s*\)/g;

    const violations: {
      file: string;
      line: number;
      match: string;
      raw: string;
    }[] = [];

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const cleanContent = stripCommentsPreservingLines(content);
      const lines = cleanContent.split('\n');

      lines.forEach((line, idx) => {
        const matches = line.match(THREE_PARAM_BEZIER_RE);
        if (matches) {
          matches.forEach((m) => {
            violations.push({
              file: formatRelPath(file),
              line: idx + 1,
              match: m,
              raw: line.trim(),
            });
          });
        }
      });
    }

    expect(
      violations.length,
      `发现 ${violations.length} 处 3 参数非法 cubic-bezier 声明 (DiffCard / ChatToolCallBlock 等)：\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBe(0);
  });

  it('7. 显存泄漏拦截：严禁在会话列表项 .sessionItemWrap 中声明常驻 will-change', () => {
    const listFiles = cssFiles.filter(
      (f) => f.includes('SidebarSessionList') || f.includes('SessionList')
    );
    expect(
      listFiles.length,
      '必须能够索引到 SidebarSessionList.module.css'
    ).toBeGreaterThan(0);

    const violations: { file: string; ruleSnippet: string }[] = [];

    for (const file of listFiles) {
      const content = readFileSync(file, 'utf8');
      const cleanContent = stripCommentsPreservingLines(content);
      const staticWrapBlockMatch = cleanContent.match(
        /(?:^|\n)\.sessionItemWrap\s*\{[^}]*\}/
      );
      if (staticWrapBlockMatch) {
        const block = staticWrapBlockMatch[0];
        if (/will-change\s*:/i.test(block)) {
          violations.push({
            file: formatRelPath(file),
            ruleSnippet: block.trim(),
          });
        }
      }
    }

    expect(
      violations.length,
      `发现 ${violations.length} 处列表项常驻 will-change 声明！请剥离常驻属性，仅在拖拽发生时由宿主状态激活：\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBe(0);
  });
});
