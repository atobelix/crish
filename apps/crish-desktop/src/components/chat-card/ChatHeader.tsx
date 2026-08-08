import React, { useCallback, useMemo } from 'react';
import { Search } from 'lucide-react';
import { ChatMsgFilterBar } from './ChatMsgFilterBar';
import { Tooltip } from '../Tooltip';
import {
  EMPTY_SESSION_TITLE,
  sessionListDisplayTitle,
} from '../../api/sessionTitle';
import { getCompositionRoot } from '../../app/compositionRoot';
import { resolveUnitChromeLabel } from './unitChromeLabel';
import { UnitChromeActions } from './UnitChromeActions';
import styles from './ChatHeader.module.css';



export interface ChatHeaderProps {
  mainSurface: string;
  showMsgFilter: boolean;
  localMsgFilter: string;
  setLocalMsgFilter: (v: string) => void;
  setShowMsgFilter: React.Dispatch<React.SetStateAction<boolean>>;
  displayCount: number;
  totalCount: number;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** 当前会话 id：置顶/导出 + 本 unit 右坞 / 工具打开作用域 */
  activeSessionId?: string | null;
  onExportMarkdown?: () => void;
  onClearHistory?: () => void;
}

/**
 * ConversationUnit 对话条（第 2 行 chrome，单/多 unit 均渲染）。
 *
 * 第 1 行：AppTopBar 全局会话标签。
 * 本行：项目名 + 消息搜索 + 本 session 右坞工具 + 坞折叠。
 * 功能区只作用于 activeSessionId 对应 unit，不跨对话共享。
 */
export const ChatHeader: React.FC<ChatHeaderProps> = React.memo(({
  mainSurface,
  showMsgFilter,
  localMsgFilter,
  setLocalMsgFilter,
  setShowMsgFilter,
  displayCount,
  totalCount,
  inputRef,
  activeSessionId,
  onExportMarkdown,
  onClearHistory,
}) => {
  const session = activeSessionId
    ? getCompositionRoot().session.getState().sessionsById[activeSessionId]
    : undefined;

  const unitChromeLabel = useMemo(
    () => resolveUnitChromeLabel(session),
    [session],
  );

  const sessionTitleHint = useMemo(() => {
    if (!session) return null;
    const t = sessionListDisplayTitle(session).trim();
    if (!t || t === EMPTY_SESSION_TITLE) return null;
    return t;
  }, [session]);

  const toggleSearch = useCallback(() => {
    setShowMsgFilter((v) => {
      const next = !v;
      if (!next) setLocalMsgFilter('');
      return next;
    });
  }, [setShowMsgFilter, setLocalMsgFilter]);

  if (mainSurface !== 'chat' || !session || !session.messages || session.messages.length === 0) {
    return null;
  }

  return (
    <div
      className={styles.toolbar}
      data-testid="chat-toolbar"
      data-unit-chrome="true"
      data-session-id={activeSessionId || undefined}
      role="toolbar"
      aria-label="对话工具栏"
    >
      <div className={styles.toolbarLeft}>
        {showMsgFilter ? (
          <ChatMsgFilterBar
            localMsgFilter={localMsgFilter}
            setLocalMsgFilter={setLocalMsgFilter}
            setShowMsgFilter={setShowMsgFilter}
            displayCount={displayCount}
            totalCount={totalCount}
            inputRef={inputRef}
          />
        ) : (
          <div
            className={styles.unitLabel}
            data-testid="chat-unit-label"
            title={sessionTitleHint || unitChromeLabel}
            aria-label={
              sessionTitleHint
                ? `${unitChromeLabel} · ${sessionTitleHint}`
                : unitChromeLabel
            }
          >
            <span className={styles.unitType}>{unitChromeLabel}</span>
          </div>
        )}
      </div>

      <UnitChromeActions
        activeSessionId={activeSessionId}
        onExportMarkdown={onExportMarkdown}
        onClearHistory={onClearHistory}
        leading={
          <Tooltip content={showMsgFilter ? '关闭消息搜索' : '搜索消息'}>
            <button
              type="button"
              className={styles.toolBtn}
              data-testid="chat-toggle-search"
              data-active={showMsgFilter ? 'true' : 'false'}
              aria-label={showMsgFilter ? '关闭消息搜索' : '搜索消息'}
              onClick={toggleSearch}
            >
              <Search size={15} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        }
      />
    </div>
  );
});

ChatHeader.displayName = 'ChatHeader';
