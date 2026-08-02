/**
 * 会话标签条内重排能力：drop 到另一会话标签时，把源 session 移到目标前。
 * 顶栏真相源：shell.openTabs；legacy map 在 reorderSessionTab 内同步。
 * 从 useTopBarDrag.ts 抽出（T05.4.10 useSessionTabReorder）。
 */
import { useCallback } from 'react';
import { getCompositionRoot } from '../../app/compositionRoot';

export type UseSessionTabReorderOptions = {
  /** 重排后刷新顶栏标签（父级注入） */
  refreshTabs: () => void;
};

export type UseSessionTabReorderResult = {
  /** 条内重排：targetSessionId 缺省 = 移到末尾 */
  commitSessionReorder: (
    sourceSessionId: string,
    targetSessionId?: string
  ) => void;
};

export function useSessionTabReorder(
  opts: UseSessionTabReorderOptions
): UseSessionTabReorderResult {
  const { refreshTabs } = opts;
  const commitSessionReorder = useCallback(
    (sourceSessionId: string, targetSessionId?: string) => {
      getCompositionRoot()
        .shell.getState()
        .reorderSessionTab(sourceSessionId, targetSessionId ?? null);
      refreshTabs();
    },
    [refreshTabs]
  );

  return { commitSessionReorder };
}
