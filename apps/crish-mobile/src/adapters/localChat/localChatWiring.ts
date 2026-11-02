// 本地对话接线装配：客户端单例（对齐 modelsWiring 形态）。
// 与远程命令面接线（observationWiring / RelaySocket）完全独立——本地对话
// 不依赖配对/连接状态，接线恒可用（离线兜底定位的根基）。
import {
  createLocalChatClient,
  type LocalChatClient,
  type LocalChatClientDeps,
} from './localChatClient';

let singleton: LocalChatClient | null = null;

/** 本地对话客户端单例（首次调用装配真实传输） */
export function getLocalChatClient(): LocalChatClient {
  if (singleton === null) singleton = createLocalChatClient();
  return singleton;
}

/** 测试注入：以假传输装配单例 */
export function setLocalChatClientForTest(
  deps: LocalChatClientDeps
): LocalChatClient {
  singleton = createLocalChatClient(deps);
  return singleton;
}

/** 测试隔离：清空单例 */
export function resetLocalChatClientForTest(): void {
  singleton = null;
}
