/**
 * useModelsCatalogVersion —— 订阅模型字典镜像版本号
 *
 * 字典镜像（真源 = ~/.conex/models.yaml）重载后自增；外部 Store 订阅确保首帧
 * 渲染与建立订阅之间发生的更新也会被观察到，避免 Picker 永久停留在旧目录。
 */

import { useSyncExternalStore } from 'react';
import {
  getModelsCatalogVersion,
  modelsCatalogStore,
} from '../api/modelsCatalogStore';

function subscribeToModelsCatalog(onStoreChange: () => void): () => void {
  return modelsCatalogStore.subscribe(onStoreChange);
}

export function useModelsCatalogVersion(): number {
  return useSyncExternalStore(
    subscribeToModelsCatalog,
    getModelsCatalogVersion,
    getModelsCatalogVersion
  );
}
