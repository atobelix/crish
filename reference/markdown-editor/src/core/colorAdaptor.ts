/**
 * 颜色适配与备用色彩转换核心库 (Color Adaptor & Backup Generator)
 * 
 * 遵循项目色彩治理规范：
 * 1. UI 组件与 Design Token 首选无逗号现代 HSL 语法与斜杠透明度 (hsl(h s% l% / a))。
 * 2. 禁止手写或直接硬编码非 HSL 颜色；任何 RGB/RGBA/HEX 备用色彩必须经过精确数学算法从 HSL 转换生成。
 * 3. 供 Canvas 2D / WebGL / 系统级渲染管线进行精确像素数组转换与色彩备份。
 */

export interface RgbaColor {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
  a: number; // 0-1
}

export interface HslColor {
  h: number; // 0-360 deg
  s: number; // 0-100 %
  l: number; // 0-100 %
  a: number; // 0-1
}

/**
 * 解析现代 HSL 字符串 (支持 `hsl(80 27.3% 97.8%)` 以及斜杠透明度 `hsl(80 30% 86% / 0.65)`)
 */
export function parseHslString(hslStr: string): HslColor {
  const clean = hslStr.trim();
  
  // 匹配现代空格+斜杠语法: hsl(80 27.3% 97.8% / 0.65) 或逗号传统语法: hsl(80, 27.3%, 97.8%, 0.65)
  const modernRegex = /^hsla?\(\s*([0-9.]+)(?:deg)?\s+([0-9.]+)%\s+([0-9.]+)%(?:\s*\/\s*([0-9.]+))?\s*\)$/i;
  const legacyRegex = /^hsla?\(\s*([0-9.]+)(?:deg)?\s*,\s*([0-9.]+)%\s*,\s*([0-9.]+)%(?:\s*,\s*([0-9.]+))?\s*\)$/i;

  let match = clean.match(modernRegex);
  if (!match) {
    match = clean.match(legacyRegex);
  }

  if (!match) {
    throw new Error(`[ColorAdaptor] Invalid HSL string: "${hslStr}"`);
  }

  const h = (parseFloat(match[1]) % 360 + 360) % 360;
  const s = Math.min(100, Math.max(0, parseFloat(match[2])));
  const l = Math.min(100, Math.max(0, parseFloat(match[3])));
  const a = match[4] !== undefined ? Math.min(1, Math.max(0, parseFloat(match[4]))) : 1;

  return { h, s, l, a };
}

/**
 * 精确数学算法：将 HSL 转换为 RGBA 颜色对象
 */
export function hslToRgb(h: number, s: number, l: number, a = 1): RgbaColor {
  const normS = s / 100;
  const normL = l / 100;

  const c = (1 - Math.abs(2 * normL - 1)) * normS;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = normL - c / 2;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (h >= 0 && h < 60) {
    rPrime = c; gPrime = x; bPrime = 0;
  } else if (h >= 60 && h < 120) {
    rPrime = x; gPrime = c; bPrime = 0;
  } else if (h >= 120 && h < 180) {
    rPrime = 0; gPrime = c; bPrime = x;
  } else if (h >= 180 && h < 240) {
    rPrime = 0; gPrime = x; bPrime = c;
  } else if (h >= 240 && h < 300) {
    rPrime = x; gPrime = 0; bPrime = c;
  } else if (h >= 300 && h < 360) {
    rPrime = c; gPrime = 0; bPrime = x;
  }

  const r = Math.round((rPrime + m) * 255);
  const g = Math.round((gPrime + m) * 255);
  const b = Math.round((bPrime + m) * 255);
  const clampedA = Math.min(1, Math.max(0, a));

  return { r, g, b, a: clampedA };
}

/**
 * 将 HSL 字符串精确计算并转换为对应备用 RGB / RGBA 格式
 */
export function hslToRgbString(hslStr: string): string {
  const { h, s, l, a } = parseHslString(hslStr);
  const { r, g, b, a: alpha } = hslToRgb(h, s, l, a);

  if (alpha < 1) {
    // 格式化透明度保留最多 3 位有效数字
    const formattedAlpha = Number(alpha.toFixed(3));
    return `rgba(${r}, ${g}, ${b}, ${formattedAlpha})`;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 将 HSL 字符串精确计算并转换为对应备用十六进制 HEX 格式
 */
export function hslToHexString(hslStr: string): string {
  const { h, s, l, a } = parseHslString(hslStr);
  const { r, g, b, a: alpha } = hslToRgb(h, s, l, a);

  const hexR = r.toString(16).padStart(2, '0');
  const hexG = g.toString(16).padStart(2, '0');
  const hexB = b.toString(16).padStart(2, '0');

  if (alpha < 1) {
    const hexA = Math.round(alpha * 255).toString(16).padStart(2, '0');
    return `#${hexR}${hexG}${hexB}${hexA}`.toUpperCase();
  }
  return `#${hexR}${hexG}${hexB}`.toUpperCase();
}

/**
 * 生成全套色彩备份包 (HSL 源码 + 转换后的 RGB 备用色 + HEX 备用色)
 */
export function generateColorFallback(hslStr: string) {
  const parsed = parseHslString(hslStr);
  const rgb = hslToRgb(parsed.h, parsed.s, parsed.l, parsed.a);
  return {
    hsl: hslStr,
    parsedHsl: parsed,
    rgbaObject: rgb,
    rgbString: hslToRgbString(hslStr),
    hexString: hslToHexString(hslStr),
  };
}

export interface ColorGateViolation {
  file?: string;
  line: number;
  snippet: string;
  reason: string;
}

/**
 * 颜色门禁静态扫描器：全面拦截未经授权的非 HSL 颜色使用
 */
export function scanContentForColorViolations(content: string, filename = ''): ColorGateViolation[] {
  const violations: ColorGateViolation[] = [];
  const lines = content.split('\n');

  // 匹配非 HSL 的硬编码颜色声明
  const hexRegex = /#([0-9a-fA-F]{3,8})\b/g;
  const legacyRgbRegex = /\b(rgb|rgba|hsla)\s*\(/g;
  const namedColors = ['red', 'blue', 'green', 'yellow', 'purple', 'cyan', 'magenta'];
  const namedColorRegex = new RegExp(`(?::|\\s)\\s*\\b(${namedColors.join('|')})\\b(?=[;\\s,!]|$)`, 'i');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 忽略注释行与 @import
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('@import')) {
      continue;
    }

    // 检查 HEX
    let hexMatch;
    while ((hexMatch = hexRegex.exec(line)) !== null) {
      violations.push({
        file: filename,
        line: i + 1,
        snippet: line.trim(),
        reason: `[Color Gate] 发现未授权的 HEX 颜色 "${hexMatch[0]}"。严格禁止直接使用 HEX，必须统一采用 hsl(...) 格式并通过 ColorAdaptor 计算转换。`,
      });
    }

    // 检查旧版 rgb/rgba/hsla
    let rgbMatch;
    while ((rgbMatch = legacyRgbRegex.exec(line)) !== null) {
      violations.push({
        file: filename,
        line: i + 1,
        snippet: line.trim(),
        reason: `[Color Gate] 发现未授权的函数 "${rgbMatch[0]}"。CSS 代码必须统一使用现代 hsl(h s l / a) 语法。`,
      });
    }

    // 检查硬编码命名颜色
    const namedMatch = line.match(namedColorRegex);
    if (namedMatch && !line.includes('var(')) {
      violations.push({
        file: filename,
        line: i + 1,
        snippet: line.trim(),
        reason: `[Color Gate] 发现未授权的命名颜色 "${namedMatch[1]}"。必须使用 HSL Design Token。`,
      });
    }
  }

  return violations;
}
