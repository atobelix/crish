// 端侧模型装配（O3）：O2 管理器的 kv 注入面 + 端侧客户端单例。
//
// 与 persistBootstrap / localChatWiring 同纪律：
// - 真实 kv（SqlSettingsDao，键 ondevice.resume.*）由启动装配
//   configureSqlitePersistence 经 configureOnDeviceModelKv 注入；
// - 未注入 / DB 降级（传 null）时退进程内内存 kv——断点续传记录不跨
//   进程存活，但下载/校验/推理面完整可用（与 scrollAnchorStore 等
//   既有「DB 降级 → 内存形态」口径一致，不假装已持久化）。
// 注意：O2 的管理器单例以首次注入的 kv 组装，configure 须在任何
// 端侧调用之前完成（启动装配天然满足）。
import type { LocalChatClient } from '../localChat/localChatClient';
import {
  createLlamaRnBridge,
  createOnDeviceChatClient,
} from './onDeviceChatClient';
import {
  onDeviceModelManager,
  type OnDeviceModelManager,
  type OnDeviceResumeKv,
} from './onDeviceModelManager';

/** 进程内内存 kv（DB 降级形态；语义与 SqlSettingsDao 子集同形） */
class MemoryResumeKv implements OnDeviceResumeKv {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

let configuredKv: OnDeviceResumeKv | null = null;
let memoryKv: MemoryResumeKv | null = null;

/** 启动装配注入真实 kv（persistBootstrap 调用；null = DB 降级） */
export function configureOnDeviceModelKv(kv: OnDeviceResumeKv | null): void {
  configuredKv = kv;
}

function kvOf(): OnDeviceResumeKv {
  if (configuredKv) return configuredKv;
  if (!memoryKv) memoryKv = new MemoryResumeKv();
  return memoryKv;
}

/** 端侧模型管理器单例（O2 工厂；kv 在首次组装时定格） */
export function getOnDeviceModelManager(): OnDeviceModelManager {
  return onDeviceModelManager(kvOf());
}

let clientSingleton: LocalChatClient | null = null;

/** 端侧对话客户端单例（惰性组装：真 llama.rn 桥 + 管理器单例） */
export function getOnDeviceChatClient(): LocalChatClient {
  if (clientSingleton === null) {
    clientSingleton = createOnDeviceChatClient({
      manager: getOnDeviceModelManager(),
      llama: createLlamaRnBridge(),
    });
  }
  return clientSingleton;
}

/** 测试隔离：清空客户端单例与 kv 注入（管理器单例在 O2 工厂内，不在此复位） */
export function resetOnDeviceWiringForTest(): void {
  clientSingleton = null;
  configuredKv = null;
}
