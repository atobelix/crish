/**
 * apps/crish-mobile/src/presentation/components/webview/nativeWebView.ts
 *
 * react-native-webview 运行时容错探测（全 App 唯一探测点，2026-11-05 收敛）：
 *
 * 事故口径（战役分析 §3.3）：`WebContentBlock` 曾静态 import WebView——
 * 一旦 JS bundle 与原生 APK 不同步（B2 已实锤存在该类漂移），
 * `requireNativeComponent('RNCWebView')` 失败 = 消息流渲染即崩。本模块把
 * 探测收敛为单点（一次性 try-require + 缓存），消费方：
 * - WebPreviewSheet（网页安全预览抽屉）；
 * - WebContentBlock（KaTeX/Mermaid 封口块宿主，探测失败回落原文等宽）。
 */
import type { ComponentType } from 'react';

let cachedWebView: ComponentType<Record<string, unknown>> | null | undefined;

/** 运行时探测原生 WebView（兼容原生 / Web / Jest Mock 环境，零异常） */
export function probeNativeWebView(): ComponentType<
  Record<string, unknown>
> | null {
  if (cachedWebView !== undefined) return cachedWebView ?? null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webviewModule = require('react-native-webview');
    cachedWebView =
      webviewModule.WebView || webviewModule.default || webviewModule;
  } catch {
    cachedWebView = null;
  }
  return cachedWebView ?? null;
}
