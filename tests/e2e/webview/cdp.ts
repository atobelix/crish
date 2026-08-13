/**
 * CONN-01 · 真 WebView CDP 连接工具（9222）
 *
 * 用途：e2e-webview project（真 Tauri WebView2 载体）的统一连接面。
 * 与 L2 mock 引擎（mock-engine.ts）互斥：本工具**不注入任何脚本**、
 * **不做任何 localStorage 种子**，只负责「连上 9222 → 找到 Crish
 * WebView target → 交付 page 句柄」。产品断言一律留在 spec 内。
 *
 * 连接链路（AGENTS.md §15）：
 *   npm run dev:workbench 启动后，WebView2 自动带 --remote-debugging-port=9222
 *   → http://127.0.0.1:9222/json/list 列出 page target
 *   （url = devUrl http://localhost:5174，见 tauri.conf.json build.devUrl）
 *   → chromium.connectOverCDP 挂接 → context.pages() 取对应 page。
 *
 * 失败语义：9222 不可达 / 无匹配 target 时**抛可读错误**（fail-fast），
 * 不静默等待默认超时——冒烟失败要能一句话说明「先启动 dev:workbench」。
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

export const CDP_ENDPOINT = 'http://127.0.0.1:9222';

/** Tauri devUrl 匹配串（apps/agent-workbench/src-tauri/tauri.conf.json build.devUrl） */
export const WEBVIEW_DEV_URL_HINT = 'localhost:5174';

/** 生产形态（frontendDist 产物经 tauri:// 协议加载）的 url 前缀 */
const WEBVIEW_PROD_URL_PREFIXES = ['tauri://localhost', 'tauri.localhost'];

const CDP_PROBE_TIMEOUT_MS = 3_000;
const CDP_CONNECT_TIMEOUT_MS = 15_000;

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
}

export interface WebViewSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  target: CdpTarget;
}

function isWebViewUrl(url: string): boolean {
  if (!url || url.startsWith('devtools://')) {
    return false;
  }
  if (url.includes(WEBVIEW_DEV_URL_HINT)) {
    return true;
  }
  return WEBVIEW_PROD_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** 探测 9222 /json/list；不可达或非 2xx → fail-fast 可读错误 */
export async function listCdpTargets(): Promise<CdpTarget[]> {
  let res: Response;
  try {
    res = await fetch(`${CDP_ENDPOINT}/json/list`, {
      signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[e2e-webview] CDP ${CDP_ENDPOINT} 不可达：请先启动 Tauri 应用` +
        `（npm run dev:workbench），WebView2 需带 --remote-debugging-port=9222` +
        `（AGENTS.md §15.2）。底层错误：${detail}`
    );
  }
  if (!res.ok) {
    throw new Error(
      `[e2e-webview] CDP ${CDP_ENDPOINT}/json/list 返回 ${res.status}：` +
        '端口可能被非 WebView2 进程占用，请检查监听进程后重试。'
    );
  }
  return (await res.json()) as CdpTarget[];
}

/** 从 target 列表挑选 Crish WebView（dev 形态优先，其次生产 tauri:// 形态） */
export function pickWebViewTarget(targets: CdpTarget[]): CdpTarget {
  const candidates = targets.filter(
    (t) => t.type === 'page' && isWebViewUrl(t.url)
  );
  if (candidates.length === 0) {
    const sample = targets.map((t) => `${t.type}:${t.url}`).join(' | ');
    throw new Error(
      `[e2e-webview] 未找到 Crish WebView target（期望 url 含 ${WEBVIEW_DEV_URL_HINT}）。` +
        `当前 targets：${sample || '（空）'}。请确认 dev:workbench 窗口已打开。`
    );
  }
  return (
    candidates.find((t) => t.url.includes(WEBVIEW_DEV_URL_HINT)) ??
    candidates[0]
  );
}

/**
 * 连接 9222 并返回 WebView page 句柄（fail-fast：不静默等默认超时）。
 * 注意：返回的 browser 句柄为 CDP 连接，close() 仅断开连接，不影响
 * 远端 WebView2 窗口进程。
 */
export async function connectWebView(): Promise<WebViewSession> {
  const targets = await listCdpTargets();
  const target = pickWebViewTarget(targets);
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT, {
    timeout: CDP_CONNECT_TIMEOUT_MS,
  });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page =
    context.pages().find((p) => isWebViewUrl(p.url())) ?? context.pages()[0];
  if (!page) {
    await browser.close();
    throw new Error(
      '[e2e-webview] connectOverCDP 成功但未挂接任何 page，请重试。'
    );
  }
  return { browser, context, page, target };
}
