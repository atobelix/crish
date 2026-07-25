import { prepare, layout } from '@chenglou/pretext';
import { SIDEBAR_SESSION_ROW_HEIGHT } from '../../../api/sessionListWindow';
import { buildPretextFontForUiSize } from '../../../utils/pretextFontBridge';

/** 构建 Pretext font 字符串，用于侧栏会话列表标题测量 */
export function buildSidebarPretextFont(): string {
  try {
    return buildPretextFontForUiSize('medium', 'sans', 'medium');
  } catch {
    return '';
  }
}

/**
 * 读取 CSS 变量 --sidebar-width，返回侧栏内容可用宽度（px）。
 * 失败时回退 228（默认 260 - 32 padding）。
 */
export function readSidebarContentWidth(): number {
  if (typeof document === 'undefined') return 228;
  try {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue('--sidebar-width')
      .trim();
    return Math.max(180, (parseInt(val, 10) || 260) - 32);
  } catch {
    return 228;
  }
}

/**
 * 用 Pretext 测量一条会话标题的行数，返回行高。
 * 单行 → 28px，多行 → 44px。
 */
export function measureSessionRowHeight(
  displayText: string,
  font: string,
  width: number
): number {
  if (!font || width <= 0 || !displayText) return SIDEBAR_SESSION_ROW_HEIGHT;
  try {
    const p = prepare(displayText, font);
    const { lineCount } = layout(p, width, 20);
    return lineCount > 1 ? 44 : 28;
  } catch {
    return SIDEBAR_SESSION_ROW_HEIGHT;
  }
}
