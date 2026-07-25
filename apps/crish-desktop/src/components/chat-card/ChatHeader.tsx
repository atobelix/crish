import React from 'react';
import { ChatMsgFilterBar } from '../ChatMsgFilterBar';

export interface ChatHeaderProps {
  mainSurface: string;
  showMsgFilter: boolean;
  localMsgFilter: string;
  setLocalMsgFilter: (v: string) => void;
  setShowMsgFilter: React.Dispatch<React.SetStateAction<boolean>>;
  displayCount: number;
  totalCount: number;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export const ChatHeader: React.FC<ChatHeaderProps> = React.memo(({
  mainSurface,
  showMsgFilter,
  localMsgFilter,
  setLocalMsgFilter,
  setShowMsgFilter,
  displayCount,
  totalCount,
  inputRef,
}) => {
  if (mainSurface !== 'chat' || !showMsgFilter) {
    return null;
  }

  return (
    <ChatMsgFilterBar
      localMsgFilter={localMsgFilter}
      setLocalMsgFilter={setLocalMsgFilter}
      setShowMsgFilter={setShowMsgFilter}
      displayCount={displayCount}
      totalCount={totalCount}
      inputRef={inputRef}
    />
  );
});

ChatHeader.displayName = 'ChatHeader';
