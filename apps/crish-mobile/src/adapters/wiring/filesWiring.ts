// 文件域接线装配（R2-06b）：仓库 + 两级缓存（目录/文件预览）的上下文单例
//
// - FilesContext = repository（命令发送）+ dirCache（目录 LRU 128 层/TTL 30s，
//   R2UX-06-01）+ previewCache（文件预览 1MB 单条/64MB 总预算/TTL，R2UX-06-02）——
//   缓存挂在接线层而非 store（纯逻辑在 filesCache.ts，R2-06a 已交付）；
// - 网关来源：observationWiring 单例的 ReconnectingWsClient.gateway（M5 §4.3.1
//   装配点）；未启动接线（getObservationWiring() null）→ getFilesContext() 返回
//   null，VM 侧投影为「未连接」错误态（任务书四态：未接连接时显示未连接错误态）；
// - 断开语义：连接断开时 WsGateway.abortAllPending 已 reject 挂起请求
//   （transport.closed），仓库错误码透传，UI 映射「未连接」文案；
// - 测试注入：VM 钩子接受 context 参数（缺省走单例）；resetFilesContextForTest
//   清空单例（仅测试调用）。

import { WsGateway } from '@/network/WsGateway';
import { getObservationWiring } from './observationWiring';
import { createContextSingleton } from './contextSingleton';
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

/** 装配文件域上下文（时钟可注入便于测试；缓存容量走 filesCache 默认规格） */
export function createFilesContext(
  gateway: WsGateway,
  now?: () => number
): FilesContext {
  return {
    repository: new GatewayFilesRepository(gateway),
    dirCache: createDirListCache(now ? { now } : {}),
    previewCache: createFilePreviewCache(now ? { now } : {}),
  };
}

/** 文件域上下文单例：首次调用时从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」，retry 经 observationWiring 拉起连接）。 */
const filesSingleton = createContextSingleton<FilesContext>(() => {
  const wiring = getObservationWiring();
  if (!wiring) return null;
  return createFilesContext(wiring.client.gateway);
});

/**
 * 文件域上下文单例读取：首次调用时从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」，retry 经 observationWiring 拉起连接）。
 */
export function getFilesContext(): FilesContext | null {
  return filesSingleton.get();
}

/** 测试隔离：清空文件域上下文单例（仅测试调用） */
export function resetFilesContextForTest(): void {
  filesSingleton.reset();
}

/** 相对路径拼接（父目录 relPath + 条目名；'' 根级 = 直接条目名，F4 §1.2 relPath 语义） */
export function joinRelPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** 工作区根 → 展示名（路径叶名；空串/根符号兜底「工作区」） */
export function workspaceNameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  const leaf = trimmed.split(/[\\/]/).pop();
  return leaf ? leaf : '工作区';
}
