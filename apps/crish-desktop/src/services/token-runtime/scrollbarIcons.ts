/**
 * 滚动条主题色与微调按钮 SVG Token (scrollbarIcons)
 * 拆分来源：services/TokenRuntimeController.ts（行数门禁收口，行为不变）。
 * 承接原 applyTokens 内滚动条 Token 派生：滑块融合色 + 三角微调按钮动态 SVG。
 */

const SCROLLBAR_UP_PATH =
  'M 2.0 6.2 C 0.6 6.2 0.0 5.3 0.6 4.3 L 3.8 1.4 C 4.4 0.5 5.6 0.5 6.2 1.4 L 9.4 4.3 C 10.0 5.3 9.4 6.2 8.0 6.2 Z';
const SCROLLBAR_DOWN_PATH =
  'M 2.0 0.8 C 0.6 0.8 0.0 1.7 0.6 2.7 L 3.8 5.6 C 4.4 6.5 5.6 6.5 6.2 5.6 L 9.4 2.7 C 10.0 1.7 9.4 0.8 8.0 0.8 Z';
const SCROLLBAR_LEFT_PATH =
  'M 6.2 2.0 C 6.2 0.6 5.3 0.0 4.3 0.6 L 1.4 3.8 C 0.5 4.4 0.5 5.6 1.4 6.2 L 4.3 9.4 C 5.3 10.0 6.2 9.4 6.2 8.0 Z';
const SCROLLBAR_RIGHT_PATH =
  'M 0.8 2.0 C 0.8 0.6 1.7 0.0 2.7 0.6 L 5.6 3.8 C 6.5 4.4 6.5 5.6 5.6 6.2 L 2.7 9.4 C 1.7 10.0 0.8 9.4 0.8 8.0 Z';

function makeScrollbarArrowSvg(
  pathD: string,
  viewBox: string,
  color: string,
  opacity: string
): string {
  const safeColor = color.startsWith('#') ? `%23${color.slice(1)}` : color;
  const svg = `%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='${viewBox}' preserveAspectRatio='none'%3E%3Cpath d='${pathD}' fill='${safeColor}' fill-opacity='${opacity}'/%3E%3C/svg%3E`;
  return `url("data:image/svg+xml,${svg}")`;
}

/**
 * 派生滚动条 Token（滑块融合色 + 微调三角按钮动态 SVG）。
 * warm-gray 皮肤走 tokens.css 静态权威 SSOT，不注入任何滚动条 Token。
 */
export function buildScrollbarTokens(params: {
  skinKey: string;
  isDark: boolean;
  finalFg: string;
}): Record<string, string> {
  const { skinKey, isDark, finalFg } = params;
  const tokens: Record<string, string> = {};

  // 滚动条主题色融合：在各类皮肤下自然融入当前主题色相，杜绝孤立突兀的灰白硬块
  if (skinKey === 'warm-gray') {
    // 暖灰皮肤（默认浅色纸温）走 tokens.css 静态权威 SSOT（降低灰度的 #dedddc 与深沉激活态 #6b6a69）
    // 按钮 SVG 同步继承 tokens.css 权威满宽平滑大圆角矢量，不向 root.style 写入内联覆盖
  } else if (isDark) {
    tokens['--scrollbar-thumb-bg'] =
      `color-mix(in srgb, ${finalFg} 16%, transparent)`;
    tokens['--scrollbar-thumb-active'] =
      `color-mix(in srgb, ${finalFg} 48%, transparent)`;
  } else {
    tokens['--scrollbar-thumb-bg'] =
      `color-mix(in srgb, ${finalFg} 13%, transparent)`;
    tokens['--scrollbar-thumb-active'] =
      `color-mix(in srgb, ${finalFg} 58%, transparent)`;
  }

  // 滚动条微调三角按钮动态 SVG Token 化：在非 warm-gray 自定义皮肤下与当前滑块颜色深度契合
  if (skinKey !== 'warm-gray') {
    const btnNormalOp = isDark ? '0.16' : '0.13';
    const btnActiveOp = isDark ? '0.48' : '0.58';

    tokens['--scrollbar-button-up'] = makeScrollbarArrowSvg(
      SCROLLBAR_UP_PATH,
      '0 0 10 7',
      finalFg,
      btnNormalOp
    );
    tokens['--scrollbar-button-down'] = makeScrollbarArrowSvg(
      SCROLLBAR_DOWN_PATH,
      '0 0 10 7',
      finalFg,
      btnNormalOp
    );
    tokens['--scrollbar-button-left'] = makeScrollbarArrowSvg(
      SCROLLBAR_LEFT_PATH,
      '0 0 7 10',
      finalFg,
      btnNormalOp
    );
    tokens['--scrollbar-button-right'] = makeScrollbarArrowSvg(
      SCROLLBAR_RIGHT_PATH,
      '0 0 7 10',
      finalFg,
      btnNormalOp
    );
    tokens['--scrollbar-button-up-active'] = makeScrollbarArrowSvg(
      SCROLLBAR_UP_PATH,
      '0 0 10 7',
      finalFg,
      btnActiveOp
    );
    tokens['--scrollbar-button-down-active'] = makeScrollbarArrowSvg(
      SCROLLBAR_DOWN_PATH,
      '0 0 10 7',
      finalFg,
      btnActiveOp
    );
    tokens['--scrollbar-button-left-active'] = makeScrollbarArrowSvg(
      SCROLLBAR_LEFT_PATH,
      '0 0 7 10',
      finalFg,
      btnActiveOp
    );
    tokens['--scrollbar-button-right-active'] = makeScrollbarArrowSvg(
      SCROLLBAR_RIGHT_PATH,
      '0 0 7 10',
      finalFg,
      btnActiveOp
    );
  }

  return tokens;
}
