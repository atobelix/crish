/**
 * useModelMetaTick —— 订阅模型元数据变更信号
 *
 * modelCatalogMeta 的写路径（启用/禁用、展示名、上下文、能力、思考档位、协议）
 * 每次落盘都会广播 'model-meta-changed'；本钩子把它折叠为递增 tick，
 * 供各级 Picker / CascadeSelect / 设置页把 tick 计入重算依赖，实现元数据
 * 变更后的即时重渲染（元数据读取是同步直读内存镜像，tick 只负责触发）。
 */

import { useEffect, useState } from 'react';
import { onUiEvent } from '../api/uiEvents';

export function useModelMetaTick(): number {
  const [tick, setTick] = useState(0);

  useEffect(
    () =>
      onUiEvent('model-meta-changed', () => {
        setTick((t) => t + 1);
      }),
    []
  );

  return tick;
}
