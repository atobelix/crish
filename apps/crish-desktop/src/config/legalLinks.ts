/**
 * 用户协议 / 隐私政策地址。
 * TODO: 待用户提供正式地址后填入；为 null 时界面只显示纯文本，不渲染可点击链接。
 */
export const LEGAL_LINKS = {
  terms: null,
  privacy: null,
} as const satisfies Record<'terms' | 'privacy', string | null>;
