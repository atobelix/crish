import { useCallback, useMemo } from 'react';
import type { FileDiff } from '../../store/types';
import { selectSessionDiffFiles } from '../../api/sessionDiffDerivation';
import { setActiveDiffSource as setActiveDiffSourceAccess } from '../../api/storeAccess';
import type { SessionMessage } from '../../store/types';

export interface UseChatDiffPanelOptions {
  messages: SessionMessage[];
  handleGlobalTabClick: (cardId: string) => void;
}

export interface UseChatDiffPanelResult {
  diffFiles: FileDiff[];
  openDiffInRightPanel: (diff: FileDiff) => void;
}

export function useChatDiffPanel({
  messages,
  handleGlobalTabClick,
}: UseChatDiffPanelOptions): UseChatDiffPanelResult {
  const diffFiles = useMemo(() => selectSessionDiffFiles(messages), [messages]);

  const openDiffInRightPanel = useCallback(
    (diff: FileDiff) => {
      setActiveDiffSourceAccess(diff);
      handleGlobalTabClick('diff');
    },
    [handleGlobalTabClick]
  );

  return {
    diffFiles,
    openDiffInRightPanel,
  };
}
