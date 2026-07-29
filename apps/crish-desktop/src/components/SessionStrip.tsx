import React from 'react';
import styles from './WorkspaceChromeBars.module.css';
import { Tooltip } from './Tooltip';
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
    <div
      className={`${styles.wsChromeRow} ${styles.wsChromeRowSessions} ws-chrome-row ws-chrome-row--sessions ${className || ''}`}
      role="tablist"
      aria-label="会话"
    >
      <div className={`${styles.wsChromeScroll} ws-chrome-scroll`}>
        {s.sessionTabs.map((tab) => {
          const active = tab.sessionId === s.activeSessionId;
          return (
            <div
              key={tab.sessionId}
              className={`${styles.wsChromeTab} ${styles.wsChromeTabSession} ${active ? styles.isActive + ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''} ws-chrome-tab ws-chrome-tab--session`}
              role="tab"
              aria-selected={active}
            >
              <Tooltip content={tab.title}>
                <button
                  type="button"
                  className={`${styles.wsChromeTabMain} ws-chrome-tab-main`}
                  onClick={() => s.selectSession(tab.sessionId)}
                >
                  {tab.pinned ? (
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
                    {tab.title}
                  </span>
                </button>
              </Tooltip>
              <Tooltip content="关闭标签">
                <button
                  type="button"
                  className={`${styles.wsChromeTabClose} ws-chrome-tab-close`}
                  aria-label={`关闭会话标签 ${tab.title}`}
                  onClick={(e) => s.onCloseSession(tab.sessionId, e)}
                >
                  <X size={12} strokeWidth={2} aria-hidden />
                </button>
              </Tooltip>
            </div>
          );
        })}
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
      </div>
    </div>
  );
};
