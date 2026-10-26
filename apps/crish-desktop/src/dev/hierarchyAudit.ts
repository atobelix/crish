/**
 * 运行时视觉层级与清晰度度量审计器
 * 提供真实宿主（WebView2 / Tauri MCP）及契约测试使用的视觉度量与违规检测。
 * Dev-only 模块：生产构建由 Vite import.meta.env.DEV 条件编译与 Rollup tree-shaking 彻底剔除。
 */

import {
  parseCssColor,
  wcagContrast,
  blendAlpha,
  type RGB,
} from './colorUtils';

if (!import.meta.env.DEV) {
  throw new Error(
    '[CRISH SECURITY] hierarchyAudit is disabled in production builds'
  );
}

export interface TextContrastViolation {
  selector: string;
  textSnippet: string;
  foreground: string;
  effectiveBackground: string;
  contrastRatio: number;
  requiredRatio: number;
  role: 'primary' | 'secondary' | 'tertiary' | 'decor' | 'unknown';
}

export interface UniqueLeftOffsets {
  uniqueCount: number;
  clusters: Array<{ leftOffset: number; sampleSelector: string }>;
}

export interface VerticalGapDistribution {
  groupGapAverage: number;
  blockGapAverage: number;
  gapRatio: number; // blockGap / groupGap, 目标 ≥ 2.5
}

export interface StutterViolation {
  selector: string;
  text: string;
  repeatedSubstring: string;
}

export interface HierarchyAuditReport {
  timestamp: string;
  theme: string;
  viewport: { width: number; height: number };
  violations: {
    textContrastBelowThreshold: TextContrastViolation[];
    stutterIssues: StutterViolation[];
  };
  metrics: {
    totalTextNodesAudited: number;
    visibleBorderElementsCount: number;
    leftEdges: UniqueLeftOffsets;
    verticalGaps: VerticalGapDistribution;
    persistentChevronsCount: number;
  };
}

/** 纯函数：将祖先背景链按 Source-Over 从内到外正向累积合成至底板 */
export function blendBackgroundChain(chain: RGB[], fallback: RGB): RGB {
  let acc = fallback;
  for (let i = chain.length - 1; i >= 0; i--) {
    const item = chain[i];
    if (item) {
      acc = blendAlpha(item, acc);
    }
  }
  return acc;
}

/** 计算 DOM 元素的真实物理有效背景色（考虑多层半透明及根底板兜底） */
export function resolveEffectiveBackground(
  element: Element,
  fallbackBg: RGB = { r: 20, g: 20, b: 20, a: 1 }
): RGB {
  const chain: RGB[] = [];
  let curr: Element | null = element;

  while (curr && curr.nodeType === 1) {
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(curr);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        const bg = parseCssColor(style.backgroundColor);
        if (bg.a !== undefined && bg.a > 0.001) {
          chain.push(bg);
          if (bg.a >= 0.999) break;
        }
      }
    }
    curr = curr.parentElement;
  }

  return blendBackgroundChain(chain, fallbackBg);
}

/** 纯函数：左缘聚类去重，容差范围内归为同一簇 */
export function clusterLeftOffsets(
  items: Array<{ left: number; selector: string }>,
  tolerance = 2.0
): UniqueLeftOffsets {
  if (items.length === 0) return { uniqueCount: 0, clusters: [] };

  const sorted = [...items].sort((a, b) => a.left - b.left);
  const clusters: Array<{ leftOffset: number; sampleSelector: string }> = [];

  for (const item of sorted) {
    const existing = clusters.find(
      (c) => Math.abs(c.leftOffset - item.left) <= tolerance
    );
    if (!existing) {
      clusters.push({
        leftOffset: Math.round(item.left * 10) / 10,
        sampleSelector: item.selector,
      });
    }
  }

  return { uniqueCount: clusters.length, clusters };
}

/** 纯函数：计算垂直间距分布与块间/簇内比值 */
export function computeVerticalGapDistribution(
  groupGaps: number[],
  blockGaps: number[]
): VerticalGapDistribution {
  const avg = (arr: number[]) =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  const groupGapAverage = Math.round(avg(groupGaps) * 10) / 10;
  const blockGapAverage = Math.round(avg(blockGaps) * 10) / 10;
  const gapRatio =
    groupGapAverage > 0
      ? Math.round((blockGapAverage / groupGapAverage) * 100) / 100
      : 0;

  return { groupGapAverage, blockGapAverage, gapRatio };
}

/** 纯函数：检测文本中的字符级口吃与重复短语 */
export function detectStutter(rawText: string): string | null {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.trim().replace(/\s+/g, ' ');
  if (text.length < 6) return null;

  const len = text.length;

  // 1. 检查整段文本是否由两半相同的短语并列构成（中间可选单个空格）
  for (let half = Math.floor(len / 2); half >= 3; half--) {
    const s1 = text.slice(0, half).trim();
    const s2 = text.slice(half).trim();
    if (s1 === s2 && s1.length >= 3) {
      return s1;
    }
  }

  // 2. 词序列滑动窗口检测 (例如 "word1 word2 word1 word2")
  const words = text.split(' ').filter(Boolean);
  if (words.length >= 2) {
    for (let wLen = Math.floor(words.length / 2); wLen >= 1; wLen--) {
      for (let i = 0; i + 2 * wLen <= words.length; i++) {
        const seq1 = words.slice(i, i + wLen).join(' ');
        const seq2 = words.slice(i + wLen, i + 2 * wLen).join(' ');
        if (seq1 === seq2 && seq1.length >= 3) {
          return seq1;
        }
      }
    }
  }

  // 3. 紧邻字符子串滑动窗口检测 (例如 "正在执行命令执行命令中")
  for (let l = Math.floor((len - 1) / 2); l >= 3; l--) {
    for (let i = 0; i + 2 * l <= len; i++) {
      const phrase = text.slice(i, i + l);
      if (phrase.trim().length < 3) continue;

      const rest = text.slice(i + l);
      if (rest.startsWith(phrase)) {
        return phrase.trim();
      }
      if (rest.startsWith(' ' + phrase)) {
        return phrase.trim();
      }
    }
  }

  return null;
}

/** 扫描 DOM 中的常驻折叠箭头数量 */
export function countPersistentChevrons(root: Element): number {
  const candidates = root.querySelectorAll(
    '[class*="chevron"], [class*="caret"], [data-icon*="chevron"], [data-role="chevron"], [aria-label*="collapse" i], [aria-label*="expand" i], [aria-expanded]'
  );
  let count = 0;
  candidates.forEach((el) => {
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(el);
      if (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      ) {
        count++;
      }
    } else {
      count++;
    }
  });
  return count;
}

/** 扫描可见描边元素总数（表单焦点环除外） */
export function countVisibleBorderElements(root: Element): number {
  const elements = root.querySelectorAll('*');
  let count = 0;

  elements.forEach((el) => {
    const tagName = el.tagName.toLowerCase();
    if (
      tagName === 'input' ||
      tagName === 'textarea' ||
      el.getAttribute('contenteditable') === 'true'
    ) {
      return;
    }
    if (
      el.classList.contains('input-container') ||
      el.classList.contains('composer-input')
    ) {
      return;
    }

    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      ) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const hasSideBorder = (w: string, s: string, c: string) => {
        if (!w || w === '0px' || s === 'none' || s === 'hidden') return false;
        const col = parseCssColor(c);
        return (col.a ?? 1) > 0.05;
      };

      if (
        hasSideBorder(
          style.borderTopWidth,
          style.borderTopStyle,
          style.borderTopColor
        ) ||
        hasSideBorder(
          style.borderBottomWidth,
          style.borderBottomStyle,
          style.borderBottomColor
        ) ||
        hasSideBorder(
          style.borderLeftWidth,
          style.borderLeftStyle,
          style.borderLeftColor
        ) ||
        hasSideBorder(
          style.borderRightWidth,
          style.borderRightStyle,
          style.borderRightColor
        )
      ) {
        count++;
      }
    }
  });

  return count;
}

/** 提取目标行或卡片的左缘偏移行 */
export function measureLeftEdges(
  root: Element,
  tolerance = 2.0
): UniqueLeftOffsets {
  const items: Array<{ left: number; selector: string }> = [];
  const rows = root.querySelectorAll(
    '[data-role="message-row"], [data-role="tool-call"], .chat-message-row, .chat-tool-call, .message-bubble'
  );

  const targets = rows.length > 0 ? rows : root.children;
  Array.from(targets).forEach((el, index) => {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      items.push({
        left: rect.left,
        selector: `${el.tagName.toLowerCase()}.${Array.from(el.classList).slice(0, 2).join('.') || index}`,
      });
    }
  });

  return clusterLeftOffsets(items, tolerance);
}

/** 测量组间间距与块间间距分布 */
export function measureVerticalGaps(root: Element): VerticalGapDistribution {
  const groupGaps: number[] = [];
  const blockGaps: number[] = [];

  const rows = Array.from(
    root.querySelectorAll('[data-role="message-row"], .chat-message-row')
  ).filter((el) => el.getBoundingClientRect().height > 0);

  for (let i = 0; i < rows.length - 1; i++) {
    const rowA = rows[i];
    const rowB = rows[i + 1];
    if (rowA && rowB) {
      const r1 = rowA.getBoundingClientRect();
      const r2 = rowB.getBoundingClientRect();
      const gap = r2.top - r1.bottom;
      if (gap >= 0) groupGaps.push(gap);
    }
  }

  const blocks = Array.from(
    root.querySelectorAll(
      '.message-bubble p, .message-bubble pre, .chat-message p'
    )
  ).filter((el) => el.getBoundingClientRect().height > 0);

  for (let i = 0; i < blocks.length - 1; i++) {
    const blockA = blocks[i];
    const blockB = blocks[i + 1];
    if (blockA && blockB) {
      const b1 = blockA.getBoundingClientRect();
      const b2 = blockB.getBoundingClientRect();
      const gap = b2.top - b1.bottom;
      if (gap >= 0 && gap < 50) blockGaps.push(gap);
    }
  }

  return computeVerticalGapDistribution(groupGaps, blockGaps);
}

/** 扫描容器内的文本对比度违规项 */
export function auditTextContrast(
  root: Element,
  fallbackBg?: RGB
): { violations: TextContrastViolation[]; totalAudited: number } {
  const violations: TextContrastViolation[] = [];
  let totalAudited = 0;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();

  while (textNode) {
    const content = textNode.textContent?.trim() || '';
    const parent = textNode.parentElement;

    if (content.length > 0 && parent && parent.nodeType === 1) {
      const style = window.getComputedStyle(parent);
      if (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      ) {
        const fg = style.color;
        const effectiveBgRgb = resolveEffectiveBackground(parent, fallbackBg);
        const ratio = wcagContrast(fg, effectiveBgRgb);
        totalAudited++;

        const fontSize = parseFloat(style.fontSize) || 14;
        const fontWeight = parseInt(style.fontWeight, 10) || 400;
        const isLargeText =
          fontSize >= 24 || (fontSize >= 18.5 && fontWeight >= 700);
        const requiredRatio = isLargeText ? 3.0 : 4.5;

        let role: TextContrastViolation['role'] = 'primary';
        const classNames = parent.className.toLowerCase();
        if (classNames.includes('decor')) {
          role = 'decor';
        } else if (
          classNames.includes('tertiary') ||
          classNames.includes('meta') ||
          classNames.includes('hint')
        ) {
          role = 'tertiary';
        } else if (
          classNames.includes('secondary') ||
          classNames.includes('sub')
        ) {
          role = 'secondary';
        }

        if (role !== 'decor' && ratio < requiredRatio) {
          violations.push({
            selector: `${parent.tagName.toLowerCase()}.${Array.from(parent.classList).join('.')}`,
            textSnippet: content.slice(0, 40),
            foreground: fg,
            effectiveBackground: `rgb(${effectiveBgRgb.r}, ${effectiveBgRgb.g}, ${effectiveBgRgb.b})`,
            contrastRatio: ratio,
            requiredRatio,
            role,
          });
        }
      }
    }
    textNode = walker.nextNode();
  }

  return { violations, totalAudited };
}

/** 扫描容器内的文案口吃问题 */
export function findStutterIssues(root: Element): StutterViolation[] {
  const issues: StutterViolation[] = [];
  const textElements = root.querySelectorAll(
    '[data-role="tool-call"], .chat-tool-call, [class*="tool-call"], p, span, h1, h2, h3'
  );

  textElements.forEach((el) => {
    const text = el.textContent?.trim() || '';
    const repeated = detectStutter(text);
    if (repeated) {
      issues.push({
        selector: `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}`,
        text: text.slice(0, 80),
        repeatedSubstring: repeated,
      });
    }
  });

  return issues;
}

/**
 * 执行运行时视觉层级与清晰度审计
 * @param target 可选根 DOM 节点或范围配置
 */
export function runHierarchyAudit(
  target?: Element | { scope?: string } | null
): HierarchyAuditReport {
  let root: Element | null = null;
  if (target && target instanceof Element) {
    root = target;
  } else if (typeof document !== 'undefined') {
    if (target && 'scope' in target && target.scope === 'chat-flow') {
      root =
        document.querySelector('[data-role="chat-message-list"]') ||
        document.querySelector('.chat-message-list') ||
        document.querySelector('main') ||
        document.body;
    } else {
      root = document.body;
    }
  }

  const currentTheme =
    (typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme')) ||
    'dark-cozy';

  const defaultBg: RGB =
    currentTheme === 'default'
      ? { r: 255, g: 255, b: 255, a: 1 }
      : { r: 20, g: 20, b: 20, a: 1 };

  if (!root) {
    return {
      timestamp: new Date().toISOString(),
      theme: currentTheme,
      viewport: { width: 1280, height: 800 },
      violations: { textContrastBelowThreshold: [], stutterIssues: [] },
      metrics: {
        totalTextNodesAudited: 0,
        visibleBorderElementsCount: 0,
        leftEdges: { uniqueCount: 0, clusters: [] },
        verticalGaps: { groupGapAverage: 0, blockGapAverage: 0, gapRatio: 0 },
        persistentChevronsCount: 0,
      },
    };
  }

  const contrastResult = auditTextContrast(root, defaultBg);
  const stutterIssues = findStutterIssues(root);
  const visibleBorders = countVisibleBorderElements(root);
  const leftEdges = measureLeftEdges(root);
  const verticalGaps = measureVerticalGaps(root);
  const chevrons = countPersistentChevrons(root);

  return {
    timestamp: new Date().toISOString(),
    theme: currentTheme,
    viewport: {
      width: typeof window !== 'undefined' ? window.innerWidth : 1280,
      height: typeof window !== 'undefined' ? window.innerHeight : 800,
    },
    violations: {
      textContrastBelowThreshold: contrastResult.violations,
      stutterIssues,
    },
    metrics: {
      totalTextNodesAudited: contrastResult.totalAudited,
      visibleBorderElementsCount: visibleBorders,
      leftEdges,
      verticalGaps,
      persistentChevronsCount: chevrons,
    },
  };
}

/** 注册全局调试审计钩子 window.__CRISH_HIERARCHY_AUDIT__ */
export function registerHierarchyAuditGlobal(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as {
    __CRISH_HIERARCHY_AUDIT__?: typeof runHierarchyAudit;
  };
  w.__CRISH_HIERARCHY_AUDIT__ = runHierarchyAudit;
}
