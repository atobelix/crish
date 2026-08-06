/**
 * colorPalette — Notion 十色体系
 *
 * 文字色与背景色一一对应，色相相同、明度不同：
 * 文字色取中等明度保证在白底上的对比度，
 * 背景色取极高明度保证正文压在上面仍然可读。
 *
 * 所有取值都来自 tokens.css，这里只做「可枚举的列表」这一层，
 * 供颜色选择器渲染。不要在这里硬编码新的色值。
 */

export interface PaletteColor {
  id: string;
  label: string;
  /** CSS 变量引用，最终值由主题决定 */
  value: string;
}

/** 文字颜色（10 色） */
export const TEXT_COLORS: PaletteColor[] = [
  { id: 'default', label: '默认', value: 'var(--color-default)' },
  { id: 'gray',    label: '灰色', value: 'var(--color-gray)' },
  { id: 'brown',   label: '棕色', value: 'var(--color-brown)' },
  { id: 'orange',  label: '橙色', value: 'var(--color-orange)' },
  { id: 'yellow',  label: '黄色', value: 'var(--color-yellow)' },
  { id: 'green',   label: '绿色', value: 'var(--color-green)' },
  { id: 'blue',    label: '蓝色', value: 'var(--color-blue)' },
  { id: 'purple',  label: '紫色', value: 'var(--color-purple)' },
  { id: 'pink',    label: '粉色', value: 'var(--color-pink)' },
  { id: 'red',     label: '红色', value: 'var(--color-red)' },
];

/** 背景颜色（10 色，与文字色同色相） */
export const BACKGROUND_COLORS: PaletteColor[] = [
  { id: 'default', label: '无背景', value: 'var(--bg-color-default)' },
  { id: 'gray',    label: '灰色底', value: 'var(--bg-color-gray)' },
  { id: 'brown',   label: '棕色底', value: 'var(--bg-color-brown)' },
  { id: 'orange',  label: '橙色底', value: 'var(--bg-color-orange)' },
  { id: 'yellow',  label: '黄色底', value: 'var(--bg-color-yellow)' },
  { id: 'green',   label: '绿色底', value: 'var(--bg-color-green)' },
  { id: 'blue',    label: '蓝色底', value: 'var(--bg-color-blue)' },
  { id: 'purple',  label: '紫色底', value: 'var(--bg-color-purple)' },
  { id: 'pink',    label: '粉色底', value: 'var(--bg-color-pink)' },
  { id: 'red',     label: '红色底', value: 'var(--bg-color-red)' },
];
