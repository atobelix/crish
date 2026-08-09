import React from 'react';
import styles from './WorkspaceChromeBars.module.css';
import { TabStrip, Tooltip } from '../ui';
import { MessageSquarePlus, Pin, Plus, X } from 'lucide-react';
import {
  useChromeAddMenu,
  useWorkspaceChromeState,
  type WorkspaceChromeProps,
} from './workspaceChromeHooks';

/** 仅会话行（聊天列顶；右侧工具标签由工具列 card-header 同排承担） */
export const SessionStrip: React.FC<WorkspaceChromeProps> = ({ className }) => {
  const s = useWorkspaceChromeState();
  const add = useChromeAddMenu();

  return (
    <TabStrip
      className={`${styles.wsChromeRow} ${styles.wsChromeRowSessions} ws-chrome-row ws-chrome-row--sessions ${className || ''}`}
      scrollClassName={`${styles.wsChromeScroll} ws-chrome-scroll`}
      tabClassName={`${styles.wsChromeTab} ${styles.wsChromeTabSession} ws-chrome-tab ws-chrome-tab--session`}
      tabActiveClassName={`${styles.isActive} is-active`}
      ariaLabel="会话"
      activeId={s.activeSessionId ?? null}
      tabs={s.sessionTabs.map((tab) => ({
        id: tab.sessionId,
        label: tab.title,
        className: tab.pinned ? 'is-pinned' : undefined,
      }))}
      onActiveChange={(sessionId) => s.selectSession(sessionId)}
      onClose={(sessionId, e) => s.onCloseSession(sessionId, e)}
      renderTab={(tab) => {
        const meta = s.sessionTabs.find((t) => t.sessionId === tab.id);
        return (
          <>
            <Tooltip content={tab.label}>
              <button
                type="button"
                className={`${styles.wsChromeTabMain} ws-chrome-tab-main`}
                tabIndex={-1}
                onClick={() => s.selectSession(tab.id)}
              >
                {meta?.pinned ? (
                  <Pin
                    size={12}
                    strokeWidth={2}
                    aria-hidden
                    className={`${styles.wsChromePin} ws-chrome-pin`}
                  />
                ) : null}
                <span
                  className={`${styles.wsChromeTabLabel} ws-chrome-tab-label`}
                >
                  {tab.label}
                </span>
              </button>
            </Tooltip>
            <Tooltip content="关闭标签">
              <button
                type="button"
                className={`${styles.wsChromeTabClose} ws-chrome-tab-close`}
                tabIndex={-1}
                aria-label={`关闭会话标签 ${tab.label}`}
                onClick={(e) => s.onCloseSession(tab.id, e)}
              >
                <X size={12} strokeWidth={2} aria-hidden />
              </button>
            </Tooltip>
          </>
        );
      }}
      trailing={
        <div
          className={`${styles.wsChromeAddWrap} ws-chrome-add-wrap`}
          ref={add.wrapRef}
        >
          <Tooltip content="新建">
            <button
              type="button"
              className={`${styles.wsChromeTab} ${styles.wsChromeTabAdd} ws-chrome-tab ws-chrome-tab--add`}
              aria-label="新建对话"
              aria-haspopup="menu"
              aria-expanded={add.open}
              aria-controls={add.menuId}
              onClick={() => add.setOpen((v) => !v)}
            >
              <Plus size={15} strokeWidth={2} aria-hidden />
            </button>
          </Tooltip>
          {add.open ? (
            <div
              id={add.menuId}
              className={`${styles.wsChromeAddMenu} ws-chrome-add-menu`}
              role="menu"
              aria-label="新建对话"
            >
              <button
                type="button"
                role="menuitem"
                className={`${styles.wsChromeAddItem} ws-chrome-add-item`}
                onClick={() => {
                  add.setOpen(false);
                  s.onNewSession();
                }}
              >
                <MessageSquarePlus size={16} strokeWidth={1.75} aria-hidden />
                <span
                  className={`${styles.wsChromeAddItemText} ws-chrome-add-item-text`}
                >
                  <span>新建对话</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      }
    />
  );
};
