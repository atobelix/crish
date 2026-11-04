// 文件域接线装配（R2-06b）：仓库 + 两级缓存（目录/文件预览）的上下文单例
//
// - FilesContext = repository（命令发送）+ dirCache（目录 LRU 128 层/TTL 30s，
//   R2UX-06-01）+ previewCache（文件预览 1MB 单条/64MB 总预算/TTL，R2UX-06-02）——
//   缓存挂在接线层而非 store（纯逻辑在 filesCache.ts，R2-06a 已交付）；
// - 网关来源：仓储只持 observationWiring 的当代解析函数
//   （resolveCommandGateway），每次 invoke 现取当前代 gateway（M5 §4.3.1
//   连接）——context 单例跨接线换代存活，捕获网关实例会在换代后把帧发进
//   已 disconnect 的旧 client（H1 陈旧捕获根治，见 gatewayCommand 文件头
//   口径）；未启动接线（getObservationWiring() null）→ getFilesContext()
//   返回 null，VM 侧投影为「未连接」错误态（任务书四态：未接连接时显示
//   未连接错误态）；连接未 open 时 invoke 立即以 transport.closed 快速失败；
// - 断开语义：连接断开时 WsGateway.abortAllPending 已 reject 挂起请求
//   （transport.closed），仓库错误码透传，UI 映射「未连接」文案；
// - 测试注入：VM 钩子接受 context 参数（缺省走单例）；resetFilesContextForTest
//   清空单例（仅测试调用）。

import {
  getObservationWiring,
  resolveCommandGateway,
} from './observationWiring';
import { createContextSingleton } from './contextSingleton';
import type { GatewaySource } from './gatewayCommand';
import {
  GatewayFilesRepository,
  type FilesRepository,
} from './filesRepository';
import {
  createDirListCache,
  type DirListCache,
} from '@/domain/store/filesCache';
import {
  createFilePreviewCache,
  type FilePreviewCache,
} from '@/domain/store/filesCache';

export interface FilesContext {
  /** 命令发送仓库（listDir/readFile/listWorkspaces/switchWorkspace） */
  repository: FilesRepository;
  /** 目录缓存（LRU 128 层 + TTL 30s，F4 §5.2 / R2UX-06-01） */
  dirCache: DirListCache;
  /** 文件预览缓存（1MB 单条 + 64MB 总预算 + 敏感不缓存，R2UX-06-02） */
  previewCache: FilePreviewCache;
}

/** 装配文件域上下文（网关来源：实例直注或当代解析函数；时钟可注入便于测试；缓存容量走 filesCache 默认规格） */
export function createFilesContext(
  gateway: GatewaySource,
  now?: () => number
): FilesContext {
  return {
    repository: new GatewayFilesRepository(gateway),
    dirCache: createDirListCache(now ? { now } : {}),
    previewCache: createFilePreviewCache(now ? { now } : {}),
  };
}

/** 文件域上下文单例：接线未启动 → null；装配后仓储持解析函数、invoke 现取当代网关
 * （VM 投影「未连接」，retry 经 observationWiring 拉起连接）。 */
const filesSingleton = createContextSingleton<FilesContext>(() => {
  if (!getObservationWiring()) return null;
  return createFilesContext(resolveCommandGateway);
});

/**
 * 文件域上下文单例读取：首次调用时装配；
 * 接线未启动 → null（VM 投影「未连接」，retry 经 observationWiring 拉起连接）。
 */
export function getFilesContext(): FilesContext | null {
  return filesSingleton.get();
}

/** 测试隔离：清空文件域上下文单例（仅测试调用） */
export function resetFilesContextForTest(): void {
  filesSingleton.reset();
}
