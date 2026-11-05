/**
 * apps/crish-mobile/src/presentation/components/webview/types.ts
 *
 * 应用内轻量网页安全预览抽屉类型契约
 */

export interface WebPreviewSheetProps {
  /** 抽屉是否可见 */
  visible: boolean;
  /** 待加载的目标网页 URL */
  url: string;
  /** 网页标题（可选，缺省展示域名或加载后标题） */
  title?: string;
  /** 关闭抽屉回调 */
  onClose: () => void;
  /** 测试唯一标识（默认 'web-preview-sheet'） */
  testID?: string;
  /** 外部打开链接处理器覆盖（默认调用 openLink） */
  onOpenExternal?: (url: string) => Promise<boolean> | boolean;
  /** 复制链接处理器覆盖（默认调用 copyTextToClipboard） */
  onCopyLink?: (url: string) => Promise<boolean> | boolean;
  /** 是否允许回环地址（开发/测试用途，默认 false） */
  allowLoopback?: boolean;
}

export type WebPreviewStatus =
  'idle' | 'blocked' | 'loading' | 'loaded' | 'error';

export interface WebPreviewSecurityInfo {
  isSafe: boolean;
  normalizedDomain: string;
  blockedReason?: string;
}
