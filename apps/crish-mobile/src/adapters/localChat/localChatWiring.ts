// 本地对话接线装配：分发客户端单例（对齐 modelsWiring 形态）。
// 与远程命令面接线（observationWiring / RelaySocket）完全独立——本地对话
// 不依赖配对/连接状态，接线恒可用（离线兜底定位的根基）。
//
// 分发（O3）：streamChatCompletion / completeChatCompletion 按 input
// 的 providerId 查 localChatStore 配置的供应商 protocol——
// 'ondevice/gguf' 走端侧本机推理客户端，其余（含 providerId 缺失、
// 配置中查不到）一律走既有 HTTP 客户端，存量行为不变。
// fetchProviderModels / checkConnectivity / pingProviderEndpoint /
// fetchProviderModelsRobust 的入参不带 providerId（接口形状所限），
// 恒走 HTTP 客户端；端侧对应实现经 onDeviceWiring.getOnDeviceChatClient()
// 直达（设置面在 O4 接线时使用）。
import { localChatStore } from '@/domain/store/localChatStore';
import { getOnDeviceChatClient } from '../onDevice/onDeviceWiring';
import {
  createLocalChatClient,
  type LocalChatClient,
  type LocalChatClientDeps,
} from './localChatClient';

/** 协议解析面（测试可注入；生产读 localChatStore 当前配置） */
export type LocalChatProtocolResolver = (
  providerId: string | undefined
) => string | undefined;

const resolveProtocolFromStore: LocalChatProtocolResolver = (providerId) => {
  if (providerId === undefined) return undefined;
  return localChatStore.getState().config.providers[providerId]?.protocol;
};

/** 测试覆盖：替换端侧客户端（null 复位为真实单例） */
let onDeviceOverride: LocalChatClient | null = null;

export function setOnDeviceClientForTest(
  client: LocalChatClient | null
): void {
  onDeviceOverride = client;
}

function defaultOnDeviceClient(): LocalChatClient {
  return onDeviceOverride ?? getOnDeviceChatClient();
}

/**
 * 分发客户端组装（可测面）：http 为既有 HTTP 客户端；onDevice 为惰性
 * 工厂——只有真有端侧流量时才组装端侧客户端（避免无谓触碰原生侧）。
 */
export function createDispatchingLocalChatClient(deps: {
  http: LocalChatClient;
  onDevice: () => LocalChatClient;
  resolveProtocol?: LocalChatProtocolResolver;
}): LocalChatClient {
  const resolve = deps.resolveProtocol ?? resolveProtocolFromStore;
  let onDeviceSingleton: LocalChatClient | null = null;
  const pick = (providerId: string | undefined): LocalChatClient => {
    if (resolve(providerId) !== 'ondevice/gguf') return deps.http;
    if (onDeviceSingleton === null) onDeviceSingleton = deps.onDevice();
    return onDeviceSingleton;
  };
  return {
    streamChatCompletion: (input, callbacks) =>
      pick(input.providerId).streamChatCompletion(input, callbacks),
    completeChatCompletion: (input) =>
      pick(input.providerId).completeChatCompletion(input),
    fetchProviderModels: (input) => deps.http.fetchProviderModels(input),
    checkConnectivity: (input) => deps.http.checkConnectivity(input),
    pingProviderEndpoint: (input) => deps.http.pingProviderEndpoint(input),
    fetchProviderModelsRobust: (input) =>
      deps.http.fetchProviderModelsRobust(input),
  };
}

let singleton: LocalChatClient | null = null;

/** 本地对话客户端单例（首次调用装配分发客户端） */
export function getLocalChatClient(): LocalChatClient {
  if (singleton === null) {
    singleton = createDispatchingLocalChatClient({
      http: createLocalChatClient(),
      onDevice: defaultOnDeviceClient,
    });
  }
  return singleton;
}

/** 测试注入：以假传输装配单例（HTTP 面走假传输，端侧面可另行覆盖） */
export function setLocalChatClientForTest(
  deps: LocalChatClientDeps
): LocalChatClient {
  singleton = createDispatchingLocalChatClient({
    http: createLocalChatClient(deps),
    onDevice: defaultOnDeviceClient,
  });
  return singleton;
}

/** 测试隔离：清空单例与端侧覆盖 */
export function resetLocalChatClientForTest(): void {
  singleton = null;
  onDeviceOverride = null;
}
