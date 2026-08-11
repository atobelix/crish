// 设计 token 极简骨架（M4 §3.2：语义名逐项对齐桌面 tokens.css；骨架期仅核心几项，
// 完整双主题 token 随 R2-06 设置域落地；RN 无 CSS 变量，载体为 TS 对象）
export const lightTokens = {
  bgPrimary: 'hsl(35,12%,94%)',
  textPrimary: '#111111',
  textSecondary: '#555555',
  colorSuccess: 'hsl(142,35%,42%)',
  colorError: 'hsl(0,55%,55%)',
  colorWarning: 'hsl(38,92%,50%)',
  colorInfo: 'hsl(217,91%,60%)',
} as const;

export const darkTokens = {
  bgPrimary: 'hsl(0,0%,5%)',
  textPrimary: '#f0f0f0',
  textSecondary: '#a3a3a3',
  colorSuccess: 'hsl(142,35%,42%)',
  colorError: 'hsl(0,55%,55%)',
  colorWarning: 'hsl(38,92%,50%)',
  colorInfo: 'hsl(217,91%,60%)',
} as const;
