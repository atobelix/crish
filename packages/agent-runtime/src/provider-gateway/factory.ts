import type { AgentProvider } from "../types";
import { GatewayV2Bridge } from "../provider/provider-gateway-v2";
import type { SecretStore } from "../provider/auth/secret-store";
import type { ProviderFactoryPlan } from "./types";

export function initProviderEngine(directory?: string, secretStore?: SecretStore): GatewayV2Bridge {
  const bridge = new GatewayV2Bridge(undefined, secretStore);
  if (directory) {
    bridge.loadProvidersFromDirectory(directory);
  } else {
    bridge.registerBuiltinProviders();
  }
  return bridge;
}

export function resolveProviderViaBridge(bridge: GatewayV2Bridge, plan: ProviderFactoryPlan): AgentProvider | null {
  try {
    const factory = bridge.getProviderFactory();
    const result = factory(plan);
    if (result instanceof Promise) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * 测试重置函数——用于在 vitest 各测试套件之间清理单例/全局状态。
 * C2-9 已完成 GatewayV2Bridge 去单例化，此函数保留为测试基础设施的
 * 安全后手，可在将来有新的全局状态时直接接管。
 */
export function resetProviderEngine(): void {
  // 当前无全局单例需要重置（C2-9 已完成去单例化）
  // 如将来引入模块级缓存或单例，在此处清理
}
