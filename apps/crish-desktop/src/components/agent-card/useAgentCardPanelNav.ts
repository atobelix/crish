/**
 * AgentCard 面板导航回调：打开 diff / 文件 / 终端面板。
 * 从 AgentCard.tsx 拆出以收敛单文件行数。
 */
import { useCallback } from 'react';
import type { FileDiff } from '../../store/types';
import {
  focusOrOpenPanel,
  setActiveDiffSource as setActiveDiffSourceAccess,
} from '../../api/storeAccess';
import { openFileInPanel } from '../../api/workspaceFsApi';
import { useActiveWorkspace } from '../../store/workspaceStore';

export interface AgentCardPanelNav {
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
}

/** 读取当前活动 workspace 并组装 3 个面板导航回调 */
export function useAgentCardPanelNav(): AgentCardPanelNav {
  const activeWorkspace = useActiveWorkspace();

  const onOpenDiff = useCallback(
    (diff: FileDiff) => {
      setActiveDiffSourceAccess(diff);
      if (activeWorkspace) {
        focusOrOpenPanel(activeWorkspace.id, 'diff');
      }
    },
    [activeWorkspace]
  );
  const onOpenPath = useCallback((filePath: string) => {
    // S6：只走叶打开器，不再叠开 files 坞（否则与 file-viewer 双开）
    openFileInPanel(filePath);
  }, []);
  const onOpenTerminal = useCallback(() => {
    if (activeWorkspace) {
      focusOrOpenPanel(activeWorkspace.id, 'terminal');
    }
  }, [activeWorkspace]);

  return { onOpenDiff, onOpenPath, onOpenTerminal };
}
