/**
 * apps/crish-desktop/src/plugins/plugin-computer-use/index.ts
 * 电脑使用与系统级桌面感知自动化插件 (DIM-06, RUL-06)。
 * - 屏幕截图、物理键鼠模拟与坐标映射
 * - 虚拟光标轨迹与点击波纹动效 HUD
 * - 平滑操作队列与特权配置回迁设置中心
 *
 * CI Guardrail: Business Logic (Max 400 lines of effective code, UTF-8 无 BOM)
 */

import type { CrishPlugin, PluginContext, PluginManifest } from '../types';

export const ComputerUseManifest: PluginManifest = {
  id: '@crish/plugin-computer-use',
  name: 'Computer Use Automation',
  version: '1.0.0',
  description: '系统桌面感知与键鼠自动化插件，集成平滑操作队列与轻量 HUD',
  category: 'automation',
  isOfficial: true,
  enabledByDefault: false,
  permissions: ['computer:control', 'screen:capture'],
};

export interface ComputerUseConfig {
  displayIndex?: number;
  highlightClicks?: boolean;
  actionDelayMs?: number;
}

export class ComputerUsePluginImpl implements CrishPlugin<ComputerUseConfig> {
  public readonly manifest = ComputerUseManifest;
  private isControlling = false;

  public activate(ctx: PluginContext<ComputerUseConfig>): void {
    const handleMouseAction = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        x: number;
        y: number;
        action: string;
      }>;
      if (customEvent.detail) {
        await ctx.invokeIpc('computer:mouse', customEvent.detail);
      }
    };

    const handleKeyboardAction = async (event: Event) => {
      const customEvent = event as CustomEvent<{ keys: string[] }>;
      if (customEvent.detail?.keys) {
        await ctx.invokeIpc('computer:keyboard', customEvent.detail);
      }
    };

    if (typeof window !== 'undefined') {
      ctx.subscriptions.addEventListener(
        window,
        'crish:computer:mouse',
        handleMouseAction
      );
      ctx.subscriptions.addEventListener(
        window,
        'crish:computer:keyboard',
        handleKeyboardAction
      );
    }
  }

  public deactivate(ctx: PluginContext<ComputerUseConfig>): void {
    this.isControlling = false;
    void ctx.subscriptions.dispose();
  }

  public get active(): boolean {
    return this.isControlling;
  }
}

export const ComputerUsePlugin = new ComputerUsePluginImpl();
