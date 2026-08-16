/**
 * apps/crish-desktop/src/plugins/plugin-browser/index.ts
 * 受管 AI 浏览器自动化与轻量悬浮 HUD 插件 (DIM-06, RUL-06)。
 * - 书签、历史记录与登录态导入 100% 回迁系统设置中心
 * - 专注 AI 自动化控制、页面文本/视口提取与画中画 (PiP) HUD
 * - 提供 800ms 平滑接管与单键急停
 *
 * CI Guardrail: Business Logic (Max 400 lines of effective code, UTF-8 无 BOM)
 */

import type { CrishPlugin, PluginContext, PluginManifest } from '../types';

export const BrowserPluginManifest: PluginManifest = {
  id: '@crish/plugin-browser',
  name: 'Managed AI Browser',
  version: '1.0.0',
  description:
    '受管 AI 浏览器自动化与轻量悬浮 HUD 插件（数据导入回迁设置中心）',
  category: 'browser',
  isOfficial: true,
  enabledByDefault: true,
  permissions: ['browser:control', 'network:access'],
};

export interface BrowserPluginConfig {
  headless?: boolean;
  viewport?: { width: number; height: number };
  takeoverDelayMs?: number;
}

export class BrowserPluginImpl implements CrishPlugin<BrowserPluginConfig> {
  public readonly manifest = BrowserPluginManifest;
  private isHudActive = false;

  public activate(ctx: PluginContext<BrowserPluginConfig>): void {
    const handleBrowserNavigate = async (event: Event) => {
      const customEvent = event as CustomEvent<{ url: string }>;
      if (customEvent.detail?.url) {
        await ctx.invokeIpc('browser:navigate', {
          url: customEvent.detail.url,
        });
      }
    };

    const handleBrowserEmergencyStop = async () => {
      this.isHudActive = false;
      await ctx.invokeIpc('browser:stop');
    };

    if (typeof window !== 'undefined') {
      ctx.subscriptions.addEventListener(
        window,
        'crish:browser:navigate',
        handleBrowserNavigate
      );
      ctx.subscriptions.addEventListener(
        window,
        'crish:browser:emergency-stop',
        handleBrowserEmergencyStop
      );
    }
  }

  public deactivate(ctx: PluginContext<BrowserPluginConfig>): void {
    this.isHudActive = false;
    void ctx.subscriptions.dispose();
  }

  public get isRunning(): boolean {
    return this.isHudActive;
  }
}

export const BrowserPlugin = new BrowserPluginImpl();
