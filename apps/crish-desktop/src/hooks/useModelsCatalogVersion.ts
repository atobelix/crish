/**
 * useModelsCatalogVersion —— 订阅模型字典镜像版本号
 *
 * 字典镜像（真源 = ~/.conex/models.yaml）重载后自增；组件把它放进
 * useMemo/useEffect 依赖即可在字典变化时重渲染，无需各自维护拉取逻辑。
 */

import { useEffect, useState } from 'react';
import { onUiEvent } from '../api/uiEvents';
import { getModelsCatalogVersion } from '../api/modelsCatalogStore';

export function useModelsCatalogVersion(): number {
  const [version, setVersion] = useState(getModelsCatalogVersion);

  useEffect(
    () =>
      onUiEvent('models-catalog-changed', () => {
        setVersion(getModelsCatalogVersion());
      }),
    []
  );

  return version;
}
